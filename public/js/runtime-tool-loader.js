// RuntimeToolLoader v1.1 — Arc 3 / Phase A / Target 2
// =====================================================================
// Tool-aware boot sequencer with an authoritative registry readiness gate.
// The runtime never publishes tool:runtime-ready until the canonical
// Tool Registry has been resolved and the manifest/config contract is ready.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolLoader) return;

  var LOG     = '[ToolLoader]';
  var VERSION = '1.1';

  var _toolId    = null;
  var _manifest  = null;
  var _booted    = false;
  var _bootPromise = null;

  function _safeCall(label, fn) {
    try { return fn(); }
    catch (e) {
      console.debug(LOG, label, 'error:', e && e.message || e);
      return null;
    }
  }

  function _resolveToolId() {
    try {
      if (typeof G.resolveToolIdFromUrl === 'function') {
        return G.resolveToolIdFromUrl() || null;
      }
    } catch (_) {}
    try { if (G.__TOOL_ID) return G.__TOOL_ID; } catch (_) {}
    return null;
  }

  async function _awaitRegistry() {
    try {
      if (G.ToolRegistryReady && typeof G.ToolRegistryReady.then === 'function') {
        await G.ToolRegistryReady;
      }
    } catch (e) {
      console.debug(LOG, 'registry readiness error:', e && e.message || e);
    }
    return G.ToolRegistry || null;
  }

  function _activateHydration(toolId, manifest) {
    _safeCall('hydration-domain', function () {
      var hd = G.RuntimeHydrationDomains;
      if (!hd) return;
      hd.createDomain(toolId, manifest ? manifest.hydrationTier : 'P2');
    });
  }

  function _activateWorkerDomain(toolId, manifest) {
    _safeCall('worker-domain', function () {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (!wd) return;
      var family = manifest ? manifest.family : null;
      if (family) wd.ensureDomain(family);
      wd.setActiveTool(toolId);
    });
  }

  function _lockConfig(toolId, manifest) {
    if (!toolId || !manifest) return false;
    var cl = G.RuntimeToolConfigLock;
    if (!cl || typeof cl.lock !== 'function') return false;
    try {
      var locked = cl.lock(toolId, {
        family:         manifest.family,
        hydrationTier:  manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy:  manifest.thermalPolicy,
        offlineCapable: manifest.offlineCapable,
      });
      return locked !== null && locked !== undefined;
    } catch (e) {
      console.debug(LOG, 'config-lock error:', e && e.message || e);
      return false;
    }
  }

  function _sealConfig(toolId, manifest) {
    if (!toolId || !manifest) return false;
    var cs = G.RuntimeToolConfigSeal;
    if (!cs || typeof cs.seal !== 'function') return false;
    try {
      var sealed = cs.seal(toolId, {
        family:         manifest.family,
        hydrationTier:  manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy:  manifest.thermalPolicy,
        offlineCapable: manifest.offlineCapable,
      });
      return sealed !== null && sealed !== undefined;
    } catch (e) {
      console.debug(LOG, 'config-seal error:', e && e.message || e);
      return false;
    }
  }

  function _activateMemoryIsland(toolId, manifest) {
    _safeCall('memory-island', function () {
      var mi = G.RuntimeMemoryIslands;
      if (!mi || !manifest) return;
      mi.allocate(toolId, manifest.memoryBudgetMb || 128);
    });
  }

  function _openAnalyticsDomain(toolId, manifest) {
    _safeCall('analytics-domain', function () {
      var ad = G.RuntimeAnalyticsDomains;
      if (!ad || !manifest) return;
      ad.open(toolId, manifest.analyticsScope || 'unknown');
    });
  }

  function _activateBundleSegments(toolId, manifest) {
    _safeCall('bundle-segments', function () {
      var bs = G.RuntimeToolBundleSegments;
      if (!bs || !manifest) return;
      bs.activateForTool(toolId, manifest.family);
    });
  }

  function _openRecoveryDomain(toolId, manifest) {
    _safeCall('recovery-domain', function () {
      var rd = G.RuntimeRecoveryDomains;
      if (!rd || !manifest) return;
      rd.ensureDomain(toolId, manifest.recoveryPolicy || 'isolate');
    });
  }

  async function _boot() {
    if (_bootPromise) return _bootPromise;
    _bootPromise = (async function () {
      var registry = await _awaitRegistry();
      _toolId = _resolveToolId();
      _manifest = null;

      if (_toolId) {
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          _manifest = mr.get(_toolId);
          if (_manifest) mr.activate(_toolId);
        }
      }

      console.debug(LOG, 'boot — toolId:', _toolId || '(none)', '— family:', _manifest ? _manifest.family : 'n/a');

      if (_toolId && registry && !_manifest) {
        console.debug(LOG, 'manifest missing for registry-authorized tool:', _toolId);
        return false;
      }

      _activateHydration(_toolId, _manifest);
      _activateWorkerDomain(_toolId, _manifest);

      if (_toolId && _manifest) {
        if (!_lockConfig(_toolId, _manifest)) {
          console.debug(LOG, 'runtime config lock rejected:', _toolId);
          return false;
        }
        if (!_sealConfig(_toolId, _manifest)) {
          console.debug(LOG, 'runtime config seal rejected:', _toolId);
          return false;
        }
      }

      _activateMemoryIsland(_toolId, _manifest);
      _openAnalyticsDomain(_toolId, _manifest);
      _activateBundleSegments(_toolId, _manifest);
      _openRecoveryDomain(_toolId, _manifest);

      _booted = true;
      _safeCall('dispatch-ready', function () {
        G.dispatchEvent(new CustomEvent('tool:runtime-ready', {
          detail: {
            toolId: _toolId,
            family: _manifest ? _manifest.family : null,
            manifest: _manifest,
            registryReady: !!registry,
            configSealed: !_toolId || !_manifest ? false : true,
          },
          bubbles: false,
        }));
      });

      console.debug(LOG, 'tool runtime ready — toolId:', _toolId);
      return true;
    })();
    return _bootPromise;
  }

  function _deferredBoot() { setTimeout(_boot, 0); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  } else {
    _deferredBoot();
  }

  G.RuntimeToolLoader = Object.freeze({
    VERSION: VERSION,
    getToolId: function () { return _toolId; },
    getManifest: function () { return _manifest; },
    isBooted: function () { return _booted; },
    boot: _boot,
  });

}(window));
