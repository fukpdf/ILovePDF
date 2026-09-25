// RuntimeToolLoader v1.2 — Arc 3 / Phase A / Target 2
// =====================================================================
// Tool-aware boot sequencer with authoritative registry/config gates.
// Hydration activation is now explicit and manifest-tier driven.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolLoader) return;

  var LOG = '[ToolLoader]';
  var VERSION = '1.5';
  var _toolId = null;
  var _manifest = null;
  var _booted = false;
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
      if (typeof G.resolveToolIdFromUrl === 'function') return G.resolveToolIdFromUrl() || null;
    } catch (_) {}
    try { if (G.__TOOL_ID) return G.__TOOL_ID; } catch (_) {}
    return null;
  }

  async function _awaitRegistry() {
    try {
      if (!G.ToolRegistryReady || typeof G.ToolRegistryReady.then !== 'function') {
        console.debug(LOG, 'authoritative registry readiness barrier unavailable');
        return null;
      }
      var ready = await G.ToolRegistryReady;
      if (!ready || !G.ToolRegistry || typeof G.ToolRegistry.isReady !== 'function' || !G.ToolRegistry.isReady()) {
        console.debug(LOG, 'authoritative registry did not become ready');
        return null;
      }
      return G.ToolRegistry;
    } catch (e) {
      console.debug(LOG, 'registry readiness error:', e && e.message || e);
      return null;
    }
  }

  function _activateHydration(toolId, manifest) {
    if (!toolId || !manifest) return false;
    var hd = G.RuntimeHydrationDomains;
    if (!hd || typeof hd.createDomain !== 'function' || typeof hd.activate !== 'function') {
      console.debug(LOG, 'hydration domain unavailable:', toolId);
      return false;
    }
    try {
      hd.createDomain(toolId, manifest.hydrationTier || 'P2');
      var tier = manifest.hydrationTier || 'P2';
      var result = hd.activate(toolId, tier);
      if (!result || result.ok !== true) {
        console.debug(LOG, 'hydration tier activation failed:', toolId, tier, result || 'no-result');
        return false;
      }
      return true;
    } catch (e) {
      console.debug(LOG, 'hydration activation error:', e && e.message || e);
      return false;
    }
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
        family: manifest.family,
        hydrationTier: manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy: manifest.thermalPolicy,
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
        family: manifest.family,
        hydrationTier: manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy: manifest.thermalPolicy,
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

  async function _activateBundleSegments(toolId, manifest) {
    if (!toolId || !manifest) return true;
    var bs = G.RuntimeToolBundleSegments;
    if (!bs || typeof bs.activateForTool !== 'function') {
      console.debug(LOG, 'bundle segment activation unavailable:', toolId);
      return false;
    }
    try {
      var result = await bs.activateForTool(toolId, manifest.family);
      if (!result || result.ok !== true) {
        console.debug(LOG, 'bundle segment activation rejected:', toolId, manifest.family, result || 'no-result');
        return false;
      }
      return true;
    } catch (e) {
      console.debug(LOG, 'bundle segment activation error:', e && e.message || e);
      return false;
    }
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

      if (_toolId && !registry) {
        console.debug(LOG, 'authoritative registry unavailable for tool:', _toolId);
        return false;
      }

      if (_toolId) {
        var registryTool = typeof registry.get === 'function' ? registry.get(_toolId) : null;
        if (!registryTool) {
          console.debug(LOG, 'tool is not present in authoritative registry:', _toolId);
          return false;
        }
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          _manifest = mr.get(_toolId);
          if (_manifest) mr.activate(_toolId);
        }
      }

      if (_toolId && !_manifest) {
        console.debug(LOG, 'manifest missing for registry-authorized tool:', _toolId);
        return false;
      }

      if (_toolId && _manifest && !_activateHydration(_toolId, _manifest)) {
        console.debug(LOG, 'hydration activation rejected:', _toolId);
        return false;
      }

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
      if (_toolId && _manifest && !(await _activateBundleSegments(_toolId, _manifest))) {
        console.debug(LOG, 'bundle segment activation rejected:', _toolId);
        return false;
      }
      _openRecoveryDomain(_toolId, _manifest);

      _booted = true;
      _safeCall('dispatch-ready', function () {
        G.dispatchEvent(new CustomEvent('tool:runtime-ready', {
          detail: {
            toolId: _toolId,
            family: _manifest ? _manifest.family : null,
            hydrationTier: _manifest ? _manifest.hydrationTier : null,
            manifest: _manifest,
            registryReady: !!registry,
            configSealed: !_toolId || !_manifest ? false : true,
            hydrationActivated: !!(_toolId && _manifest),
            hydrationActivationVerified: !!(_toolId && _manifest),
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  else _deferredBoot();

  G.RuntimeToolLoader = Object.freeze({
    VERSION: VERSION,
    getToolId: function () { return _toolId; },
    getManifest: function () { return _manifest; },
    isBooted: function () { return _booted; },
    boot: _boot,
  });

}(window));
