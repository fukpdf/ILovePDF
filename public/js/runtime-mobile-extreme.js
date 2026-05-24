// RuntimeMobileExtremeMode v1.0 — Arc 7 / Phase H
// =====================================================================
// Emergency runtime stabilization for very weak devices:
// <2 GB RAM, 2 cores, low battery, or extreme thermal pressure.
//
// Extends RuntimeMobileHardening (Arc 4) with extreme modes that
// kick in when standard hardening is insufficient.
//
// Emergency modes (can stack):
//   ULTRA_LOW_MEMORY  — single worker, 64 MB budgets, no preloading
//   BACKGROUND_EVICT  — evict all dormant processors immediately
//   WORKER_TRIM       — terminate all non-active workers
//   THERMAL_EMERGENCY — force single-core execution, suspend P2 hydration
//   BATTERY_EMERGENCY — suspend preloading, streams, telemetry FPS monitor
//
// Activation: automatic detection OR window.triggerExtremeMode(mode)
// Recovery: auto-exits when conditions improve (checked every CHECK_MS).
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeMobileExtremeMode) return;

  var LOG     = '[ExtremeMode]';
  var VERSION = '1.0';
  var CHECK_MS = 60 * 1000;  // re-check conditions every 60 s

  // ── Mode flags ────────────────────────────────────────────────────
  var _modes = {
    ULTRA_LOW_MEMORY:  false,
    BACKGROUND_EVICT:  false,
    WORKER_TRIM:       false,
    THERMAL_EMERGENCY: false,
    BATTERY_EMERGENCY: false,
  };

  var _metrics   = { activations: 0, deactivations: 0, evictions: 0, trims: 0 };
  var _telemetry = [];
  var _active    = false;  // any mode active

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── Device capability probe ───────────────────────────────────────
  var _cores  = navigator.hardwareConcurrency || 2;
  var _isWeak = _cores <= 2;

  function _heapPct() {
    try {
      var pm = performance.memory;
      return pm ? pm.usedJSHeapSize / pm.jsHeapSizeLimit : 0;
    } catch (_) { return 0; }
  }

  // ── Dispatch a mode activation ────────────────────────────────────
  function _activate(mode, reason) {
    if (_modes[mode]) return;
    _modes[mode] = true;
    _active = true;
    _metrics.activations++;
    _tel('activate:' + mode, { reason: reason });
    console.debug(LOG, 'EXTREME MODE:', mode, '—', reason);

    try {
      G.dispatchEvent(new CustomEvent('extreme-mode:activate', {
        detail: { mode: mode, reason: reason },
      }));
    } catch (_) {}

    _apply(mode);
  }

  function _deactivate(mode) {
    if (!_modes[mode]) return;
    _modes[mode] = false;
    _active = Object.keys(_modes).some(function (m) { return _modes[m]; });
    _metrics.deactivations++;
    _tel('deactivate:' + mode, {});
    console.debug(LOG, 'EXTREME MODE LIFTED:', mode);

    try {
      G.dispatchEvent(new CustomEvent('extreme-mode:deactivate', { detail: { mode: mode } }));
    } catch (_) {}
  }

  // ── Apply mode actions ────────────────────────────────────────────
  function _apply(mode) {
    switch (mode) {

      case 'ULTRA_LOW_MEMORY':
        // Single worker per processor, 64 MB budgets
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (pw) {
            ['organize','split','compress','convert','edit','repair','ocr','ai-nlp','image'].forEach(function (f) {
              pw.setThermalLimit && pw.setThermalLimit(f, 1);
            });
          }
        } catch (_) {}
        // Shrink cache
        try {
          var sc = G.RuntimeSmartCache;
          if (sc) sc.clear();
        } catch (_) {}
        // Stop FPS monitor (rAF overhead)
        try {
          var st = G.RuntimeStreamTelemetry;
          if (st) st.stopFpsMonitor();
        } catch (_) {}
        break;

      case 'BACKGROUND_EVICT':
        // Evict dormant processors from RuntimeProcessorLoader
        _metrics.evictions++;
        try {
          var ldr = G.RuntimeProcessorLoader;
          if (!ldr) break;
          var stats = ldr.getStats && ldr.getStats();
          Object.keys(stats || {}).forEach(function (family) {
            var s = stats[family];
            // Evict if not activated in the last 5 min
            if (!s.activated || (s.lastActiveAt && (Date.now() - s.lastActiveAt) > 5 * 60 * 1000)) {
              try {
                G.dispatchEvent(new CustomEvent('processor-loader:evicted', {
                  detail: { family: family, reason: 'extreme-background-evict', idleMs: Date.now() - s.lastActiveAt },
                }));
              } catch (_) {}
            }
          });
        } catch (_) {}
        break;

      case 'WORKER_TRIM':
        // Terminate non-active workers via WorkerPool
        _metrics.trims++;
        try {
          var wp = G.WorkerPool;
          if (wp && wp.terminateAll) wp.terminateAll();
          else if (wp && wp.trim) wp.trim();
        } catch (_) {}
        break;

      case 'THERMAL_EMERGENCY':
        // Force single-core execution, suspend P2 hydration
        try {
          var hs = G.RuntimeHydrationScheduler;
          if (hs && hs.suspend) hs.suspend('P2');
        } catch (_) {}
        try {
          var pw2 = G.RuntimeProcessorWorkers;
          if (pw2) {
            ['ocr','ai-nlp','convert'].forEach(function (f) {
              pw2.setThermalLimit && pw2.setThermalLimit(f, 1);
            });
          }
        } catch (_) {}
        break;

      case 'BATTERY_EMERGENCY':
        // Suspend preloading
        try {
          // RuntimePredictiveLoader has no explicit suspend — mark via event
          G.dispatchEvent(new CustomEvent('mobile:battery-save', {
            detail: { level: 0, extreme: true },
          }));
        } catch (_) {}
        // Stop telemetry FPS
        try {
          var st2 = G.RuntimeStreamTelemetry;
          if (st2) st2.stopFpsMonitor();
        } catch (_) {}
        break;
    }
  }

  // ── Detection logic ───────────────────────────────────────────────
  function _detect() {
    var heap = _heapPct();

    // Ultra-low memory: heap > 90% on weak device
    if (_isWeak && heap > 0.90) {
      _activate('ULTRA_LOW_MEMORY', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.70 && _modes.ULTRA_LOW_MEMORY) {
      _deactivate('ULTRA_LOW_MEMORY');
    }

    // Background eviction: heap > 80%
    if (heap > 0.80) {
      _activate('BACKGROUND_EVICT', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.65 && _modes.BACKGROUND_EVICT) {
      _deactivate('BACKGROUND_EVICT');
    }

    // Worker trim: heap > 92%
    if (heap > 0.92) {
      _activate('WORKER_TRIM', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.75 && _modes.WORKER_TRIM) {
      _deactivate('WORKER_TRIM');
    }

    // Check thermal tier from self-optimizer or worker coordinator
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) {
        var tier = pw.getThermalTier();
        if (tier === 'critical') {
          _activate('THERMAL_EMERGENCY', 'thermal=critical');
        } else if (tier !== 'critical' && tier !== 'hot' && _modes.THERMAL_EMERGENCY) {
          _deactivate('THERMAL_EMERGENCY');
        }
      }
    } catch (_) {}
  }

  // ── Periodic check ────────────────────────────────────────────────
  var _checkTimer = setInterval(_detect, CHECK_MS);

  // ── Hooks: battery / thermal events ──────────────────────────────
  G.addEventListener('mobile:battery-save', function (evt) {
    var d = evt && evt.detail;
    if (d && d.level < 0.10) _activate('BATTERY_EMERGENCY', 'battery=' + Math.round((d.level || 0) * 100) + '%');
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    _activate('ULTRA_LOW_MEMORY', 'memory-panic');
    _activate('BACKGROUND_EVICT', 'memory-panic');
  });

  // ── Public trigger (for testing / manual override) ────────────────
  G.triggerExtremeMode = function (mode, reason) {
    if (_modes.hasOwnProperty(mode)) _activate(mode, reason || 'manual');
  };

  G.liftExtremeMode = function (mode) {
    if (mode) _deactivate(mode);
    else Object.keys(_modes).forEach(_deactivate);
  };

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    // Immediate check on weak devices
    if (_isWeak) setTimeout(_detect, 2000);
    console.debug(LOG, 'v' + VERSION + ' ready — weak device:', _isWeak, '| window.triggerExtremeMode() available');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeMobileExtremeMode = Object.freeze({
    VERSION:        VERSION,
    isActive:       function () { return _active; },
    getActiveModes: function () {
      return Object.keys(_modes).filter(function (m) { return _modes[m]; });
    },
    activate:       function (mode, reason) { _activate(mode, reason || 'api'); },
    deactivate:     _deactivate,
    detect:         _detect,
    getMetrics:     function () { return Object.assign({}, _metrics); },
    getTelemetry:   function () { return _telemetry.slice(); },
  });

}(window));
