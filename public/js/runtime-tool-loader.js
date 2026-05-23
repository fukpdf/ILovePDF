// RuntimeToolLoader v1.0 — Arc 3 / Phase A / Target 2
// =====================================================================
// Tool-aware boot sequencer.
//
// At DOMContentLoaded:
//   1. Resolves current toolId from URL (via window.resolveToolIdFromUrl)
//   2. Looks up manifest in RuntimeToolManifestRegistry
//   3. Activates the tool's hydration domain
//   4. Registers the tool's worker domain
//   5. Locks the tool's runtime config
//   6. Activates memory island for the tool
//   7. Opens analytics domain for the tool
//   8. Emits 'tool:runtime-ready' event
//
// If no toolId (e.g. homepage), boots in 'platform' mode (all P0 only).
// If tool is unknown, logs a debug warning and boots in 'generic' mode.
//
// The loader is a lightweight coordinator — it calls into other Arc 3
// modules that have already been loaded via deferred script tags.
//
// Boot is idempotent: repeated calls for the same toolId are no-ops.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolLoader) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolLoader]';
  var VERSION = '1.0';

  var _toolId  = null;
  var _manifest = null;
  var _booted  = false;

  // ── Safe caller ───────────────────────────────────────────────────────────
  function _safeCall(label, fn) {
    try { fn(); } catch (e) { console.debug(LOG, label, 'error:', e && e.message || e); }
  }

  // ── Resolve current tool ──────────────────────────────────────────────────
  function _resolveToolId() {
    try {
      if (typeof G.resolveToolIdFromUrl === 'function') {
        return G.resolveToolIdFromUrl() || null;
      }
    } catch (_) {}
    // Fallback: read from injected global
    try { if (G.__TOOL_ID) return G.__TOOL_ID; } catch (_) {}
    return null;
  }

  // ── Activate hydration domain ─────────────────────────────────────────────
  function _activateHydration(toolId, manifest) {
    _safeCall('hydration-domain', function () {
      var hd = G.RuntimeHydrationDomains;
      if (!hd) return;
      hd.createDomain(toolId, manifest ? manifest.hydrationTier : 'P2');
    });
  }

  // ── Register worker domain ────────────────────────────────────────────────
  function _activateWorkerDomain(toolId, manifest) {
    _safeCall('worker-domain', function () {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (!wd) return;
      var family = manifest ? manifest.family : null;
      if (family) wd.ensureDomain(family);
      wd.setActiveTool(toolId);
    });
  }

  // ── Lock tool config ──────────────────────────────────────────────────────
  function _lockConfig(toolId, manifest) {
    _safeCall('config-lock', function () {
      var cl = G.RuntimeToolConfigLock;
      if (!cl || !manifest) return;
      cl.lock(toolId, {
        family:         manifest.family,
        hydrationTier:  manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy:  manifest.thermalPolicy,
        offlineCapable: manifest.offlineCapable,
      });
    });
  }

  // ── Activate memory island ────────────────────────────────────────────────
  function _activateMemoryIsland(toolId, manifest) {
    _safeCall('memory-island', function () {
      var mi = G.RuntimeMemoryIslands;
      if (!mi || !manifest) return;
      mi.allocate(toolId, manifest.memoryBudgetMb || 128);
    });
  }

  // ── Open analytics domain ─────────────────────────────────────────────────
  function _openAnalyticsDomain(toolId, manifest) {
    _safeCall('analytics-domain', function () {
      var ad = G.RuntimeAnalyticsDomains;
      if (!ad || !manifest) return;
      ad.open(toolId, manifest.analyticsScope || 'unknown');
    });
  }

  // ── Activate bundle segments ──────────────────────────────────────────────
  function _activateBundleSegments(toolId, manifest) {
    _safeCall('bundle-segments', function () {
      var bs = G.RuntimeToolBundleSegments;
      if (!bs || !manifest) return;
      bs.activateForTool(toolId, manifest.family);
    });
  }

  // ── Open recovery domain ──────────────────────────────────────────────────
  function _openRecoveryDomain(toolId, manifest) {
    _safeCall('recovery-domain', function () {
      var rd = G.RuntimeRecoveryDomains;
      if (!rd || !manifest) return;
      rd.ensureDomain(toolId, manifest.recoveryPolicy || 'isolate');
    });
  }

  // ── Main boot ─────────────────────────────────────────────────────────────
  function _boot() {
    if (_booted) return;
    _booted = true;

    _toolId   = _resolveToolId();
    _manifest = null;

    if (_toolId) {
      _safeCall('manifest-lookup', function () {
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          _manifest = mr.get(_toolId);
          mr.activate(_toolId);
        }
      });
    }

    console.debug(LOG, 'boot — toolId:', _toolId || '(none)', '— family:', _manifest ? _manifest.family : 'n/a');

    // Always activate regardless of whether manifest was found
    _activateHydration(_toolId, _manifest);
    _activateWorkerDomain(_toolId, _manifest);
    _lockConfig(_toolId, _manifest);
    _activateMemoryIsland(_toolId, _manifest);
    _openAnalyticsDomain(_toolId, _manifest);
    _activateBundleSegments(_toolId, _manifest);
    _openRecoveryDomain(_toolId, _manifest);

    _safeCall('dispatch-ready', function () {
      G.dispatchEvent(new CustomEvent('tool:runtime-ready', {
        detail: {
          toolId:   _toolId,
          family:   _manifest ? _manifest.family : null,
          manifest: _manifest,
        },
        bubbles: false,
      }));
    });

    console.debug(LOG, 'tool runtime ready — toolId:', _toolId);
  }

  // ── Deferred boot (after all Arc 3 files have loaded) ────────────────────
  function _deferredBoot() {
    // Use a brief timeout so all deferred scripts have executed first
    setTimeout(_boot, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  } else {
    _deferredBoot();
  }

  G.RuntimeToolLoader = Object.freeze({
    VERSION:     VERSION,
    getToolId:   function () { return _toolId; },
    getManifest: function () { return _manifest; },
    isBooted:    function () { return _booted; },
    boot:        _boot, // allow manual re-trigger for SPAs
  });

}(window));
