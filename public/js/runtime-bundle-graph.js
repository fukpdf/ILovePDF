// RuntimeBundleGraph v1.0 — Arc 4 / Phase D / Target 4
// =====================================================================
// Active bundle graph + per-tool activation tracking.
//
// Problem: RuntimeBundleRegistry loads bundles but has no concept of
// which tool activated which bundle. There is no way to know if a bundle
// is dormant (loaded but no longer in use). arc3 bundle was not
// registered in RuntimeBundleRegistry.
//
// Solution:
//   1. Registers the arc3 bundle into RuntimeBundleRegistry at boot
//   2. Tracks per-tool bundle activation history
//   3. Exports active bundle graph: { bundle → [toolIds that activated it] }
//   4. Dormant detection: bundle loaded but no tool activity > DORMANT_MS
//   5. On-demand injection: injectForTool(toolId) loads only needed bundles
//
// Unloading: browsers do not support true script unloading. Dormant
// bundles are flagged in the graph for diagnostics but not removed from
// memory (that would break the singleton guard pattern).
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBundleGraph) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[BundleGraph]';
  var VERSION    = '1.0';
  var DORMANT_MS = 10 * 60 * 1000; // 10 min without tool activity = dormant

  // ── Tool → minimum bundles required ──────────────────────────────────────
  // All tools need: core, security, zero-trust, hardening, infra, arc2, arc3
  var BASE_CHAIN = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2', 'arc3'];

  // ── Activation graph ──────────────────────────────────────────────────────
  // bundle → { toolIds: Set, activatedAt, lastUsedAt }
  var _graph = {};

  // ── Tool activity timestamps ──────────────────────────────────────────────
  var _toolActivity = {}; // toolId → lastActiveAt

  function _touchBundle(bundleName, toolId) {
    if (!_graph[bundleName]) {
      _graph[bundleName] = { toolIds: [], activatedAt: Date.now(), lastUsedAt: Date.now() };
    }
    var node = _graph[bundleName];
    if (toolId && !node.toolIds.includes(toolId)) node.toolIds.push(toolId);
    node.lastUsedAt = Date.now();
  }

  function _touchTool(toolId) {
    _toolActivity[toolId] = Date.now();
  }

  // ── Register arc3 into RuntimeBundleRegistry ──────────────────────────────
  function _registerArc3() {
    try {
      var reg = G.RuntimeBundleRegistry;
      if (!reg) return;
      // arc3 depends on arc2
      reg.register('arc3', 'runtime-arc3.bundle.js', ['arc2']);
      console.debug(LOG, 'arc3 registered in RuntimeBundleRegistry');
    } catch (e) {
      console.debug(LOG, 'arc3 registration error:', e && e.message || e);
    }
  }

  // ── Inject all base bundles for a tool ───────────────────────────────────
  function injectForTool(toolId) {
    _touchTool(toolId);
    var reg = G.RuntimeBundleRegistry;
    if (!reg) return Promise.resolve();

    var chain = Promise.resolve();
    BASE_CHAIN.forEach(function (bundleName) {
      chain = chain.then(function () {
        _touchBundle(bundleName, toolId);
        return reg.load(bundleName).catch(function (e) {
          // Non-fatal: bundle may be pre-loaded via script tags
          console.debug(LOG, 'bundle load note:', bundleName, e && e.message || e);
        });
      });
    });
    return chain;
  }

  // ── Dormant detection ─────────────────────────────────────────────────────
  function getDormantBundles() {
    var now     = Date.now();
    var dormant = [];
    Object.keys(_graph).forEach(function (name) {
      var node = _graph[name];
      if ((now - node.lastUsedAt) > DORMANT_MS) {
        dormant.push({ name: name, dormantSinceMs: now - node.lastUsedAt, toolIds: node.toolIds.slice() });
      }
    });
    return dormant;
  }

  // ── Active graph export ───────────────────────────────────────────────────
  function getActiveGraph() {
    var now = Date.now();
    var out = {};
    Object.keys(_graph).forEach(function (name) {
      var node = _graph[name];
      out[name] = {
        toolIds:       node.toolIds.slice(),
        activatedAt:   node.activatedAt,
        lastUsedAt:    node.lastUsedAt,
        ageMs:         now - node.activatedAt,
        idleMs:        now - node.lastUsedAt,
        dormant:       (now - node.lastUsedAt) > DORMANT_MS,
      };
    });
    // Include RuntimeBundleRegistry status
    try {
      var reg = G.RuntimeBundleRegistry;
      if (reg) {
        var status = reg.status();
        Object.keys(status).forEach(function (name) {
          if (!out[name]) out[name] = { toolIds: [], activatedAt: null, lastUsedAt: null, ageMs: null, idleMs: null, dormant: false };
          out[name].loaded  = status[name].loaded;
          out[name].loading = status[name].loading;
        });
      }
    } catch (_) {}
    return out;
  }

  // ── Listen for tool runtime ready events ─────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) {
        _touchTool(toolId);
        BASE_CHAIN.forEach(function (b) { _touchBundle(b, toolId); });
      }
    } catch (_) {}
  });

  // ── Listen for bundle segment activation ─────────────────────────────────
  G.addEventListener('tool:manifest-activated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _touchTool(toolId);
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _registerArc3();
    // Seed existing bundles as pre-loaded (they're in script tags already)
    BASE_CHAIN.forEach(function (name) { _touchBundle(name, null); });
    console.debug(LOG, 'bundle graph initialized —', BASE_CHAIN.length, 'base bundles tracked');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeBundleGraph = Object.freeze({
    VERSION:         VERSION,
    injectForTool:   injectForTool,
    getActiveGraph:  getActiveGraph,
    getDormantBundles: getDormantBundles,
    touchBundle:     _touchBundle,
    touchTool:       _touchTool,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — active bundle graph tracking enabled');

}(window));
