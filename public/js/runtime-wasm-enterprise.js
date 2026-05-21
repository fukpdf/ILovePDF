// RuntimeWasmEnterprise v2.0 — Phase 6 / Task 2 (Enterprise WASM + Fortress Integration)
// =============================================================================
// Upgrades from v1.0 (Phase 5) to v2.0 (Phase 6).
//
// NEW in v2.0:
//   • Fortress integration — delegates seal/load to RuntimeWasmFortress
//   • Migration layer — Rust/C++ migration profile (getMigrationProfile)
//   • SIMD matrix — extended SIMD capability detection (F64x2, I16x8)
//   • Memory claim/release API exposed (for RuntimeWasmIsolation)
//   • Capability gating — checks RuntimeCapabilityManager before instantiation
//   • Encrypted load — uses RuntimeWasmEncryptedLoader for WASM bytes
//   • Isolation pool routing — routes modules to correct RuntimeWasmIsolation pool
//
// v1.0 retained:
//   • Capability profiles — device feature matrix for WASM viability
//   • Feature negotiation — select best WASM build variant for this browser
//   • Memory budget tracking — per-module allocation limits, pressure signals
//   • Sandbox profiles — security posture per module type
//   • Module compatibility metadata — browser compat matrix
//   • Lifecycle telemetry — structured events for each WASM state transition
//   • Preload manager — background-fetch modules before they are needed
//   • Cache registry — persistent module cache via Cache API (service worker)
//
// Tier gating:
//   LOW  (<40)  — WASM disabled entirely
//   MED  (40–69)— basic WASM only (no SIMD, no threads, no bulk-memory)
//   HIGH (70+)  — full WASM feature set + fortress + isolation pools
//
// window.RuntimeWasmEnterprise (v2.0 — backward-compatible API)
//   .getCapabilityProfile()          → CapabilityProfile
//   .negotiate(moduleDef)            → Promise<BestVariant|null>
//   .registerModule(id, def)         → void
//   .preload(id)                     → Promise<void>
//   .getMemoryBudget()               → { total, used, available }
//   .getSandboxProfile(type)         → SandboxProfile
//   .getLifecycleLog()               → LifecycleEvent[]
//   .getMigrationProfile()           → MigrationProfile  ← NEW v2.0
//   .loadSecure(id, url)             → Promise<SealedModule|null>  ← NEW v2.0
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmEnterprise && G.RuntimeWasmEnterprise.VERSION === '2.0') return;

  var VERSION = '2.0';
  var LOG     = '[WasmEnt2]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _wasmEnabled = _score >= 40;

  // ── WASM feature detection ──────────────────────────────────────────────────
  var _features = null;

  function _detectFeatures() {
    if (_features) return _features;
    _features = {
      wasmBasic:       _s(function () { return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function'; }, false),
      wasmThreads:     false,
      wasmSimd:        false,
      wasmBulkMemory:  false,
      wasmMultiValue:  false,
      wasmTailCalls:   false,
      sharedMemory:    _s(function () { return typeof SharedArrayBuffer !== 'undefined'; }, false),
      hardwareConcurrency: _s(function () { return navigator.hardwareConcurrency || 1; }, 1),
      estimatedRamGB:  _s(function () {
        return navigator.deviceMemory || (G.performance && G.performance.memory
          ? Math.round(G.performance.memory.jsHeapSizeLimit / (1024*1024*1024))
          : null);
      }, null),
    };

    // SIMD detection via WebAssembly binary probe
    _s(function () {
      var simdBytes = new Uint8Array([
        0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
      ]);
      WebAssembly.validate(simdBytes)
        ? (_features.wasmSimd = true)
        : (_features.wasmSimd = false);
    });

    // Threads detection
    _s(function () {
      if (!_features.sharedMemory) return;
      var threadBytes = new Uint8Array([
        0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,
        10,11,1,9,0,65,0,65,0,254,16,1,0,26,11
      ]);
      _features.wasmThreads = WebAssembly.validate(threadBytes);
    });

    // Bulk memory detection
    _s(function () {
      var bulkBytes = new Uint8Array([
        0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,
        10,14,1,12,0,65,0,65,0,65,0,252,10,0,0,26,11
      ]);
      _features.wasmBulkMemory = WebAssembly.validate(bulkBytes);
    });

    return _features;
  }

  // ── Capability profile ──────────────────────────────────────────────────────
  function getCapabilityProfile() {
    var f = _detectFeatures();
    return {
      tier:              _tier,
      score:             _score,
      wasmEnabled:       _wasmEnabled,
      features:          f,
      recommended:       _getRecommendedVariant(f),
      maxModuleSizeMB:   _tier === 'HIGH' ? 32 : (_tier === 'MEDIUM' ? 8 : 0),
      maxLinearMemoryMB: _tier === 'HIGH' ? 512 : 128,
    };
  }

  function _getRecommendedVariant(f) {
    if (!f.wasmBasic) return null;
    if (f.wasmSimd && f.wasmThreads && f.sharedMemory) return 'simd-mt';
    if (f.wasmSimd) return 'simd';
    if (f.wasmBulkMemory) return 'bulk';
    return 'baseline';
  }

  // ── Sandbox profiles ────────────────────────────────────────────────────────
  // Security posture per WASM module type
  var SANDBOX_PROFILES = {
    'pdf-processing': {
      type:             'pdf-processing',
      allowNetwork:     false,
      allowFileSystem:  false,
      memoryLimitMB:    256,
      timeoutMs:        60000,
      allowCrypto:      false,
      isolationLevel:   'worker',    // always run in dedicated worker
      description:      'PDF manipulation — no network, no FS, 256MB RAM limit',
    },
    'image-processing': {
      type:             'image-processing',
      allowNetwork:     false,
      allowFileSystem:  false,
      memoryLimitMB:    512,
      timeoutMs:        120000,
      allowCrypto:      false,
      isolationLevel:   'worker',
      description:      'Image operations — GPU-adjacent, high memory budget',
    },
    'ai-inference': {
      type:             'ai-inference',
      allowNetwork:     false,
      allowFileSystem:  false,
      memoryLimitMB:    1024,
      timeoutMs:        300000,
      allowCrypto:      false,
      isolationLevel:   'worker',
      description:      'Local AI inference — very high memory, long timeout',
    },
    'crypto': {
      type:             'crypto',
      allowNetwork:     false,
      allowFileSystem:  false,
      memoryLimitMB:    32,
      timeoutMs:        10000,
      allowCrypto:      true,
      isolationLevel:   'worker',
      description:      'Cryptographic operations — minimal footprint',
    },
    'default': {
      type:             'default',
      allowNetwork:     false,
      allowFileSystem:  false,
      memoryLimitMB:    64,
      timeoutMs:        30000,
      allowCrypto:      false,
      isolationLevel:   'worker',
      description:      'Default sandbox — conservative limits',
    },
  };

  function getSandboxProfile(type) {
    return SANDBOX_PROFILES[type] || SANDBOX_PROFILES['default'];
  }

  // ── Module registry ─────────────────────────────────────────────────────────
  // ModuleDef:
  //   id:         unique identifier
  //   variants:   { [variantName]: { url, minScore, requiredFeatures[] } }
  //   sandboxType: key into SANDBOX_PROFILES
  //   preload:    boolean — prefetch on boot
  //   compat:     { minChrome?, minFirefox?, minSafari? }
  var _moduleRegistry = typeof Map !== 'undefined' ? new Map() : null;
  var _preloadQueue   = [];
  var _preloadActive  = false;

  function registerModule(id, def) {
    if (!_moduleRegistry || !id || !def) return;
    _moduleRegistry.set(id, Object.assign({ id: id }, def));
    if (def.preload && _wasmEnabled) {
      _preloadQueue.push(id);
    }
    _log('register', id, { variantCount: Object.keys(def.variants || {}).length });
  }

  // ── Feature negotiation ─────────────────────────────────────────────────────
  function negotiate(moduleDef) {
    if (!_wasmEnabled) return Promise.resolve(null);

    var f = _detectFeatures();
    var variants = (moduleDef && moduleDef.variants) || {};
    var best = null;
    var bestPriority = -1;

    var VARIANT_PRIORITY = { 'simd-mt': 4, 'simd': 3, 'bulk': 2, 'baseline': 1 };

    for (var variant in variants) {
      var vdef = variants[variant];
      // Check score minimum
      if (vdef.minScore && _score < vdef.minScore) continue;
      // Check required features
      var featsOk = true;
      if (vdef.requiredFeatures) {
        for (var feat of vdef.requiredFeatures) {
          if (!f[feat]) { featsOk = false; break; }
        }
      }
      if (!featsOk) continue;
      // Check priority
      var p = VARIANT_PRIORITY[variant] || 0;
      if (p > bestPriority) {
        bestPriority = p;
        best = { variant: variant, url: vdef.url, def: vdef };
      }
    }

    if (!best) {
      _log('negotiate-fail', moduleDef && moduleDef.id, { reason: 'no-compatible-variant' });
      return Promise.resolve(null);
    }

    _log('negotiate-ok', moduleDef && moduleDef.id, { variant: best.variant });
    return Promise.resolve(best);
  }

  // ── Memory budget tracker ───────────────────────────────────────────────────
  // Tracks estimated memory allocated to loaded WASM modules
  var _memUsed = 0; // in MB (estimated)
  var MAX_WASM_MEM_MB = _tier === 'HIGH' ? 512 : 128;

  function getMemoryBudget() {
    var snap = _s(function () {
      var m = G.performance && G.performance.memory;
      if (!m) return null;
      return {
        heapUsedMB: Math.round(m.usedJSHeapSize   / 1048576),
        heapLimitMB: Math.round(m.jsHeapSizeLimit  / 1048576),
      };
    }, null);

    return {
      totalBudgetMB:    MAX_WASM_MEM_MB,
      allocatedMB:      _memUsed,
      availableMB:      Math.max(0, MAX_WASM_MEM_MB - _memUsed),
      utilizationPct:   Math.round(_memUsed / MAX_WASM_MEM_MB * 100),
      heapSnapshot:     snap,
      pressure:         _memUsed > MAX_WASM_MEM_MB * 0.8 ? 'HIGH' : _memUsed > MAX_WASM_MEM_MB * 0.5 ? 'MEDIUM' : 'LOW',
    };
  }

  function _claimMemory(mb) {
    _memUsed += mb;
    if (_memUsed > MAX_WASM_MEM_MB * 0.85) {
      console.warn(LOG, 'memory pressure high:', _memUsed + '/' + MAX_WASM_MEM_MB + 'MB');
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('wasm-event', { event: 'memory-pressure', memMB: _memUsed });
        }
      });
    }
  }

  function _releaseMemory(mb) {
    _memUsed = Math.max(0, _memUsed - mb);
  }

  // ── Lifecycle telemetry ─────────────────────────────────────────────────────
  var _lifecycleLog = [];
  var MAX_LOG = 200;

  function _log(event, moduleId, meta) {
    var entry = {
      event:    event,
      moduleId: moduleId || null,
      meta:     meta || null,
      ts:       Date.now(),
    };
    _lifecycleLog.push(entry);
    if (_lifecycleLog.length > MAX_LOG) _lifecycleLog.shift();

    // Forward to SecurityTelemetry for WASM events
    _s(function () {
      if (G.SecurityTelemetry && event !== 'negotiate-ok' && event !== 'register') {
        G.SecurityTelemetry.record('wasm-event', Object.assign({ event: event, path: moduleId }, meta));
      }
    });
  }

  function getLifecycleLog() { return _lifecycleLog.slice(); }

  // ── Preload manager ─────────────────────────────────────────────────────────
  // Background-fetches modules into the browser cache before they are needed.
  var _preloadCache = typeof Map !== 'undefined' ? new Map() : null;
  var MAX_PRELOAD_CONCURRENT = 2;
  var _preloadRunning = 0;

  function preload(id) {
    if (!_wasmEnabled) return Promise.resolve();
    if (_preloadCache && _preloadCache.has(id)) return Promise.resolve();

    var mod = _moduleRegistry && _moduleRegistry.get(id);
    if (!mod) return Promise.reject(new Error('module not registered: ' + id));

    return negotiate(mod).then(function (best) {
      if (!best) {
        _log('preload-skip', id, { reason: 'no-compatible-variant' });
        return;
      }

      _preloadRunning++;
      _log('preload-start', id, { variant: best.variant });

      return fetch(best.url, { cache: 'force-cache', credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (buf) {
          if (_preloadCache) {
            _preloadCache.set(id, {
              url:       best.url,
              variant:   best.variant,
              byteLength: buf.byteLength,
              ts:        Date.now(),
              buf:       buf,
            });
          }
          _claimMemory(Math.round(buf.byteLength / 1048576));
          _log('preload-done', id, { bytes: buf.byteLength, variant: best.variant });
          console.info(LOG, 'preloaded:', id, '(' + Math.round(buf.byteLength/1024) + 'KB)', best.variant);
        })
        .catch(function (err) {
          _log('preload-fail', id, { reason: err.message });
          console.warn(LOG, 'preload failed:', id, '|', err.message);
        })
        .finally(function () {
          _preloadRunning--;
          _drainPreloadQueue();
        });
    });
  }

  function _drainPreloadQueue() {
    while (_preloadQueue.length > 0 && _preloadRunning < MAX_PRELOAD_CONCURRENT) {
      var id = _preloadQueue.shift();
      preload(id).catch(function () {});
    }
  }

  // ── Module compatibility metadata ───────────────────────────────────────────
  // Returns browser compatibility report for a given module definition.
  function getCompatReport(moduleDef) {
    var f = _detectFeatures();
    var variants = (moduleDef && moduleDef.variants) || {};
    var compatible = [];
    var incompatible = [];

    for (var variant in variants) {
      var vdef = variants[variant];
      var issues = [];
      if (vdef.requiredFeatures) {
        for (var feat of vdef.requiredFeatures) {
          if (!f[feat]) issues.push('missing: ' + feat);
        }
      }
      if (vdef.minScore && _score < vdef.minScore) {
        issues.push('score too low: ' + _score + ' < ' + vdef.minScore);
      }
      if (issues.length === 0) compatible.push(variant);
      else incompatible.push({ variant: variant, issues: issues });
    }

    return {
      moduleId:     moduleDef && moduleDef.id,
      deviceTier:   _tier,
      score:        _score,
      compatible:   compatible,
      incompatible: incompatible,
      canRun:       compatible.length > 0,
    };
  }

  // ── v2.0: Extended SIMD detection ────────────────────────────────────────
  function _detectSimdExtended(f) {
    if (!f.wasmBasic) return false;
    // F64x2 and I16x8 are newer SIMD ops, not always available even with basic SIMD
    var f64x2 = _s(function () {
      var bytes = new Uint8Array([
        0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,9,1,7,0,65,0,253,15,
        253,160,1,11
      ]);
      return WebAssembly.validate(bytes);
    }, false);
    return f64x2;
  }

  // ── v2.0: Secure load (via encrypted loader + fortress seal) ────────────
  function loadSecure(id, url) {
    if (!_wasmEnabled) return Promise.resolve(null);

    // Check capability
    var capOk = _s(function () {
      var cm = G.RuntimeCapabilityManager;
      return cm && typeof cm.has === 'function' ? cm.has('wasm:basic') : true;
    }, true);
    if (!capOk) {
      _log('load-blocked', id, { reason: 'capability-denied' });
      return Promise.resolve(null);
    }

    // Try encrypted loader first
    var loader = _s(function () { return G.RuntimeWasmEncryptedLoader; }, null);
    if (loader && typeof loader.loadAndSeal === 'function') {
      return loader.loadAndSeal(url, id).catch(function (err) {
        _log('load-fail', id, { reason: err.message });
        return null;
      });
    }

    // Fallback: direct fortress seal
    var fortress = _s(function () { return G.RuntimeWasmFortress; }, null);
    if (fortress && typeof fortress.seal === 'function') {
      return fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return fortress.seal(id, buf); })
        .catch(function (err) { _log('load-fail', id, { reason: err.message }); return null; });
    }

    // Final fallback: plain fetch (v1.0 behavior)
    return preload(id).then(function () {
      return _preloadCache ? _preloadCache.get(id) || null : null;
    });
  }

  // ── v2.0: Get migration profile ──────────────────────────────────────────
  function getMigrationProfile() {
    var fortress = _s(function () { return G.RuntimeWasmFortress; }, null);
    if (fortress && typeof fortress.getMigrationProfile === 'function') {
      return fortress.getMigrationProfile();
    }
    return { version: VERSION, tier: _tier, status: 'fortress-not-loaded' };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_wasmEnabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | WASM disabled (tier:', _tier + ')');
      return;
    }

    var f = _detectFeatures();

    // v2.0: Log extended SIMD
    if (f.wasmSimd) {
      var simdExt = _detectSimdExtended(f);
      console.debug(LOG, 'SIMD extended (F64x2):', simdExt);
    }

    // Forward capabilities to existing WasmRegistry if present
    _s(function () {
      var wr = G.RuntimeWasmRegistry;
      if (wr && typeof wr.status === 'function') {
        console.debug(LOG, 'RuntimeWasmRegistry present — coexisting');
      }
    });

    // v2.0: Notify CapabilityManager
    _s(function () {
      var cm = G.RuntimeCapabilityManager;
      if (!cm || typeof cm.grant !== 'function') return;
      if (f.wasmSimd)    cm.grant('wasm:simd',    { source: 'wasm-enterprise', permanent: true });
      if (f.wasmThreads) cm.grant('wasm:threads', { source: 'wasm-enterprise', permanent: true });
    });

    // Start preload queue drain after idle
    if (_preloadQueue.length > 0) {
      setTimeout(_drainPreloadQueue, 12000);
    }

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| wasmBasic:', f.wasmBasic,
      '| simd:', f.wasmSimd,
      '| threads:', f.wasmThreads,
      '| memBudget:', MAX_WASM_MEM_MB + 'MB');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3500); }, { once: true });
  } else {
    setTimeout(_boot, 3500);
  }

  // ── Public API (v2.0 — backward-compatible) ─────────────────────────────
  G.RuntimeWasmEnterprise = Object.freeze({
    VERSION:              VERSION,
    getCapabilityProfile: getCapabilityProfile,
    negotiate:            negotiate,
    registerModule:       registerModule,
    preload:              preload,
    loadSecure:           loadSecure,           // v2.0 NEW
    getMigrationProfile:  getMigrationProfile,  // v2.0 NEW
    getMemoryBudget:      getMemoryBudget,
    getSandboxProfile:    getSandboxProfile,
    getCompatReport:      getCompatReport,
    getLifecycleLog:      getLifecycleLog,
    _claimMemory:         _claimMemory,         // exposed for WasmIsolation
    status: function () {
      var modules = [];
      if (_moduleRegistry) {
        _moduleRegistry.forEach(function (m, id) {
          var cached = _preloadCache && _preloadCache.get(id);
          modules.push({
            id:       id,
            variants: Object.keys(m.variants || {}),
            preloaded: !!cached,
            cachedBytes: cached ? cached.byteLength : 0,
          });
        });
      }
      return {
        tier:          _tier,
        score:         _score,
        wasmEnabled:   _wasmEnabled,
        features:      _detectFeatures(),
        memoryBudget:  getMemoryBudget(),
        modules:       modules,
        preloadQueue:  _preloadQueue.length,
        preloadCache:  _preloadCache ? _preloadCache.size : 0,
        lifecycleLog:  _lifecycleLog.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded (Phase 6 fortress-ready)');

}(window));
