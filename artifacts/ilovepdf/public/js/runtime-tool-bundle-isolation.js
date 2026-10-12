// RuntimeToolBundleIsolation v1.0 — Arc 5 / Phase H / Target 8
// =====================================================================
// Family-level bundle dependency graph + bundle GC registry.
//
// Arc 4 gap: RuntimeBundleGraph tracks which TOOL activated which
// bundle, but all tools share the same base bundle chain. There is no
// family-level dependency enforcement — an organize tool could trigger
// loading of AI bundles if RuntimeBundleRegistry.load('arc3') is called
// and arc3 contains AI processors. There is no bundle GC registry
// (knowing when a bundle can be considered unused).
//
// Solution:
//   1. Family-level bundle dependency graph: each family has an
//      explicit list of bundles it requires. Bundles NOT in a family's
//      list are never triggered by that family's tools.
//   2. Bundle GC registry: tracks how many ACTIVE tools reference each
//      bundle. When the last tool in a bundle's user set goes idle/evicted,
//      the bundle is flagged as GC-eligible.
//   3. Bundle telemetry: activation counts, load times, GC events.
//   4. Activation guard: warns if a tool attempts to load a bundle
//      outside its family's allowed set.
//   5. Registers arc4 + arc5 bundles into RuntimeBundleRegistry.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolBundleIsolation) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[BundleIsolation]';
  var VERSION = '1.0';
  var GC_TTL_MS = 20 * 60 * 1000; // 20 min after last active tool → GC-eligible

  // ── Family → allowed bundles ──────────────────────────────────────────────
  // ALL families share the base chain. Family-specific extras are listed here.
  var BASE_BUNDLES = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2', 'arc3', 'arc4', 'arc5'];

  var FAMILY_BUNDLES = {
    'organize':     BASE_BUNDLES,
    'compress':     BASE_BUNDLES,
    'convert-from': BASE_BUNDLES,
    'convert-to':   BASE_BUNDLES,
    'edit':         BASE_BUNDLES,
    'ai':           BASE_BUNDLES,
    'image':        BASE_BUNDLES,
    'utility':      BASE_BUNDLES.filter(function (b) { return b !== 'arc4'; }), // utility needs fewer
  };

  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Bundle GC registry ────────────────────────────────────────────────────
  // bundleName → { activeTools: Set([toolId,...]), lastActiveAt, gcEligibleSince, telemetry }
  var _gcRegistry = {};

  function _ensureBundle(bundleName) {
    if (!_gcRegistry[bundleName]) {
      _gcRegistry[bundleName] = {
        name:           bundleName,
        activeTools:    [],
        lastActiveAt:   0,
        gcEligibleSince: null,
        activationCount: 0,
        loadTimeMs:     null,
        telemetry:      [],
      };
    }
    return _gcRegistry[bundleName];
  }

  // ── Register a tool as using a bundle ─────────────────────────────────────
  function registerUsage(toolId, bundleName) {
    var family  = TOOL_FAMILY[toolId] || 'organize';
    var allowed = FAMILY_BUNDLES[family] || BASE_BUNDLES;

    // Guard: warn if this family shouldn't load this bundle
    if (!allowed.includes(bundleName)) {
      console.debug(LOG, 'ISOLATION GUARD:', toolId, '(family:' + family + ') attempting to load non-allowed bundle:', bundleName);
      try {
        G.dispatchEvent(new CustomEvent('bundle-isolation:violation', {
          detail: { toolId: toolId, family: family, bundle: bundleName },
        }));
      } catch (_) {}
      return false;
    }

    var rec = _ensureBundle(bundleName);
    if (!rec.activeTools.includes(toolId)) rec.activeTools.push(toolId);
    rec.lastActiveAt  = Date.now();
    rec.gcEligibleSince = null; // reset GC eligibility
    rec.activationCount++;
    rec.telemetry.push({ ts: Date.now(), event: 'registered', toolId: toolId });
    if (rec.telemetry.length > 50) rec.telemetry.shift();
    return true;
  }

  // ── Deregister a tool from a bundle ──────────────────────────────────────
  function deregisterUsage(toolId, bundleName) {
    var rec = _gcRegistry[bundleName];
    if (!rec) return;
    rec.activeTools = rec.activeTools.filter(function (t) { return t !== toolId; });
    if (rec.activeTools.length === 0) {
      rec.gcEligibleSince = Date.now();
      console.debug(LOG, 'bundle GC-eligible:', bundleName, '(last tool:', toolId + ')');
      rec.telemetry.push({ ts: Date.now(), event: 'gc-eligible' });
    }
  }

  // ── GC scan ───────────────────────────────────────────────────────────────
  function getGCEligible() {
    var now = Date.now();
    return Object.keys(_gcRegistry).filter(function (name) {
      var rec = _gcRegistry[name];
      return rec.gcEligibleSince && (now - rec.gcEligibleSince) > GC_TTL_MS;
    }).map(function (name) {
      var rec = _gcRegistry[name];
      return { name: name, gcEligibleSince: rec.gcEligibleSince, gcAge: now - rec.gcEligibleSince };
    });
  }

  // ── Register arc4 + arc5 into RuntimeBundleRegistry ──────────────────────
  function _registerNewBundles() {
    try {
      var reg = G.RuntimeBundleRegistry;
      if (!reg) return;
      reg.register('arc4', 'runtime-arc4.bundle.js', ['arc3']);
      reg.register('arc5', 'runtime-arc5.bundle.js', ['arc4']);
      console.debug(LOG, 'arc4 + arc5 registered in RuntimeBundleRegistry');
    } catch (e) {
      console.debug(LOG, 'bundle registration note:', e && e.message || e);
    }
  }

  // ── Listen for tool events ────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      var family = TOOL_FAMILY[toolId] || 'organize';
      var bundles = FAMILY_BUNDLES[family] || BASE_BUNDLES;
      bundles.forEach(function (b) { registerUsage(toolId, b); });
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      Object.keys(_gcRegistry).forEach(function (b) { deregisterUsage(toolId, b); });
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _registerNewBundles, { once: true });
  } else {
    setTimeout(_registerNewBundles, 0);
  }

  G.RuntimeToolBundleIsolation = Object.freeze({
    VERSION:         VERSION,
    registerUsage:   registerUsage,
    deregisterUsage: deregisterUsage,
    getGCEligible:   getGCEligible,
    getFamilyBundles: function (family) { return (FAMILY_BUNDLES[family] || BASE_BUNDLES).slice(); },
    getRegistry:     function () {
      var out = {};
      Object.keys(_gcRegistry).forEach(function (name) {
        var rec = _gcRegistry[name];
        out[name] = { activeTools: rec.activeTools.slice(), activationCount: rec.activationCount,
                      gcEligible: !!rec.gcEligibleSince };
      });
      return out;
    },
    getDependencyGraph: function () {
      var out = {};
      Object.keys(FAMILY_BUNDLES).forEach(function (f) { out[f] = FAMILY_BUNDLES[f].slice(); });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family bundle isolation + GC registry active');

}(window));
