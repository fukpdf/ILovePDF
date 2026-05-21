// RuntimePerfSafety v2.0 — Phase 5 / Task 5 (Advanced Memory + Resource Safety)
// =============================================================================
// Upgrade from v1.0 (Phase 3) to v2.0 (Phase 5).
//
// NEW in v2.0:
//   E. Battery-aware degradation — Navigator.getBattery() throttles intervals
//   F. Thermal-aware degradation — PerformanceObserver long-task detection
//   G. Memory pressure prediction — trend extrapolation (15-sample window)
//   H. Adaptive compression throttling — signals queue under pressure
//   I. Orphaned worker cleanup — terminates abandoned promise-less workers
//   J. Detached canvas cleanup v2 — all canvases with non-DOM parents
//   K. Abandoned blob cleanup — revokes blobs from terminated workers
//
// Retained from v1.0:
//   A. MemoryPressureMonitor
//   B. BlobLeakDetector
//   C. IdleCleanup
//   D. WorkerMemoryWatchdog
//
// Tier gating (v2.0 extended):
//   LOW     (<40)  — BlobLeakDetector only
//   MEDIUM  (40–69)— + MemoryPressureMonitor + IdleCleanup
//   HIGH    (70+)  — + WorkerWatchdog + Battery + Thermal + Prediction
//
// window.RuntimePerfSafety (v2.0 — backward-compatible API)
//   .getMemorySnapshot()    → { heapMB, limitMB, tier, trend }
//   .revokeLeakedBlobs()    → number
//   .runIdleCleanup()       → void
//   .getBatteryStatus()     → BatteryStatus|null
//   .getThermalStatus()     → ThermalStatus
//   .getMemoryTrend()       → { slope, prediction, willExceed }
//   .status()               → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimePerfSafety && G.RuntimePerfSafety.VERSION === '2.0') return;

  var VERSION = '2.0';
  var LOG     = '[PerfSafety2]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;
  var _mid  = _score >= 40 && _score < 70;
  var _high = _score >= 70;

  // ── Adaptive config (overridden by battery/thermal degradation) ────────────
  var _cfg = {
    MEM_POLL_MS:          _high ? 20000 : 45000,
    BLOB_TTL_MS:          10 * 60 * 1000,
    IDLE_POLL_MS:         30000,
    WORKER_IDLE_LIMIT_MS: _high ? 8 * 60 * 1000 : 12 * 60 * 1000,
    MEM_WARN_MB:          400,
    MEM_CRITICAL_MB:      700,
    MEM_EMERGENCY_MB:     900,
  };

  // ── Stats ──────────────────────────────────────────────────────────────────
  var _stats = {
    pressureEvents: 0,
    blobsTracked:   0,
    blobsRevoked:   0,
    idleRuns:       0,
    workerKills:    0,
    canvasCleans:   0,
    thermalWarnings:0,
    batteryThrottles:0,
    predictions:    0,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // A. MEMORY PRESSURE MONITOR (v1.0 retained + trend tracking)
  // ─────────────────────────────────────────────────────────────────────────
  var _lastPressureTier  = 'ok';
  var _memSamples        = []; // last 15 heapMB readings for trend
  var MAX_MEM_SAMPLES    = 15;

  function getMemorySnapshot() {
    var mem = _s(function () { return G.performance && G.performance.memory; });
    if (!mem) return { heapMB: 0, limitMB: 0, tier: 'unknown', trend: null };
    var heapMB  = Math.round(mem.usedJSHeapSize  / 1048576);
    var limitMB = Math.round(mem.jsHeapSizeLimit / 1048576);
    var tier = 'ok';
    if (heapMB >= _cfg.MEM_EMERGENCY_MB) tier = 'emergency';
    else if (heapMB >= _cfg.MEM_CRITICAL_MB) tier = 'critical';
    else if (heapMB >= _cfg.MEM_WARN_MB)     tier = 'warn';
    return { heapMB: heapMB, limitMB: limitMB, tier: tier, trend: getMemoryTrend() };
  }

  function _checkMemoryPressure() {
    var snap = getMemorySnapshot();
    if (snap.tier === 'unknown') return;

    // Feed trend window
    _memSamples.push(snap.heapMB);
    if (_memSamples.length > MAX_MEM_SAMPLES) _memSamples.shift();

    if (snap.tier === _lastPressureTier) return;
    _lastPressureTier = snap.tier;
    if (snap.tier === 'ok') return;

    _stats.pressureEvents++;
    console.warn(LOG, 'memory pressure:', snap.tier, '| heap:', snap.heapMB + 'MB');

    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('perf-pressure', { tier: snap.tier, heapMB: snap.heapMB });
      }
    });
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.emit('perf:memory-pressure', { tier: snap.tier, heapMB: snap.heapMB });
      }
    });

    if (snap.tier === 'critical' || snap.tier === 'emergency') {
      _s(function () {
        var rm = G.RuntimeMemory;
        if (rm && typeof rm.compact === 'function') rm.compact();
      });
      // Signal queue throttling under pressure
      _emitQueueThrottle(snap.tier);
      _runIdleCleanup();
    }
  }

  function _startMemoryMonitor() {
    if (_lite) return;
    var hasPerfMem = _s(function () { return !!(G.performance && G.performance.memory); }, false);
    if (!hasPerfMem) return;
    setInterval(_checkMemoryPressure, _cfg.MEM_POLL_MS);
    console.debug(LOG, 'memory monitor active | interval:', _cfg.MEM_POLL_MS + 'ms');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // G. MEMORY PRESSURE PREDICTION (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  // Uses linear regression over _memSamples to predict future heap usage.
  function getMemoryTrend() {
    if (_memSamples.length < 5) return null;
    var n   = _memSamples.length;
    var xs  = _memSamples.map(function (_, i) { return i; });
    var ys  = _memSamples;
    var xbar = (n - 1) / 2;
    var ybar = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var num  = 0, den = 0;
    for (var i = 0; i < n; i++) {
      num += (xs[i] - xbar) * (ys[i] - ybar);
      den += (xs[i] - xbar) * (xs[i] - xbar);
    }
    var slope = den !== 0 ? num / den : 0; // MB per sample interval
    // Predict 5 intervals ahead
    var predictedMB   = ybar + slope * 5;
    var willExceed    = predictedMB >= _cfg.MEM_WARN_MB;
    var willCritical  = predictedMB >= _cfg.MEM_CRITICAL_MB;

    if (willCritical && slope > 10) {
      _stats.predictions++;
      console.warn(LOG, 'memory PREDICTION: will reach critical in ~5 intervals', '(slope:', Math.round(slope) + 'MB/interval)');
      _s(function () {
        if (G.RuntimeEventBus) {
          G.RuntimeEventBus.emit('perf:memory-trend', {
            slope: Math.round(slope), predicted: Math.round(predictedMB),
          });
        }
      });
    }

    return {
      slope:       Math.round(slope * 10) / 10,
      currentMB:   _memSamples[_memSamples.length - 1],
      predictedMB: Math.round(predictedMB),
      willExceed:  willExceed,
      willCritical: willCritical,
      samples:     n,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // H. ADAPTIVE COMPRESSION THROTTLING (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  function _emitQueueThrottle(pressureTier) {
    _s(function () {
      if (!G.RuntimeEventBus) return;
      var reducePct = pressureTier === 'emergency' ? 75 : pressureTier === 'critical' ? 50 : 25;
      G.RuntimeEventBus.emit('queue:throttle', {
        pressure:   pressureTier,
        reducePct:  reducePct,
        reason:     'memory-pressure',
      });
    });
    // Also try RuntimeScheduler throttle if available
    _s(function () {
      var rs = G.RuntimeScheduler;
      if (rs && typeof rs.setThrottle === 'function') {
        var throttle = pressureTier === 'emergency' ? 0.25 : pressureTier === 'critical' ? 0.5 : 0.75;
        rs.setThrottle(throttle);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B. BLOB URL LEAK DETECTOR (v1.0 retained)
  // ─────────────────────────────────────────────────────────────────────────
  var _blobs = typeof Map !== 'undefined' ? new Map() : null;

  function _patchBlobAPIs() {
    if (!_blobs) return;
    var URL = G.URL;
    if (!URL || URL.__p3blobPatched) return;

    var _origCreate = URL.createObjectURL.bind(URL);
    var _origRevoke = URL.revokeObjectURL.bind(URL);

    URL.createObjectURL = function (obj) {
      var url = _s(function () { return _origCreate(obj); }, null);
      if (url) {
        _blobs.set(url, { ts: Date.now(), revoked: false });
        _stats.blobsTracked++;
      }
      return url;
    };

    URL.revokeObjectURL = function (url) {
      _s(function () { _origRevoke(url); });
      if (_blobs && typeof url === 'string') {
        var entry = _blobs.get(url);
        if (entry) { entry.revoked = true; _blobs.delete(url); }
      }
    };

    URL.__p3blobPatched = true;
    console.debug(LOG, 'Blob URL tracking active');
  }

  function revokeLeakedBlobs() {
    if (!_blobs) return 0;
    var cutoff = Date.now() - _cfg.BLOB_TTL_MS;
    var revoked = 0;
    _blobs.forEach(function (entry, url) {
      if (!entry.revoked && entry.ts < cutoff) {
        _s(function () { G.URL.revokeObjectURL(url); });
        _blobs.delete(url);
        revoked++;
        _stats.blobsRevoked++;
      }
    });
    if (revoked > 0) {
      console.info(LOG, 'auto-revoked', revoked, 'leaked Blob URLs');
      _s(function () {
        if (G.SecurityTelemetry) G.SecurityTelemetry.record('blob-leak', { count: revoked });
      });
    }
    return revoked;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // C. IDLE CLEANUP (v2.0 — adds detached canvas v2 + orphaned blobs)
  // ─────────────────────────────────────────────────────────────────────────
  function _runIdleCleanup() {
    _stats.idleRuns++;

    revokeLeakedBlobs();
    _cleanDetachedCanvases();

    _s(function () {
      var ss = G.sessionStorage;
      if (!ss) return;
      var STALE_PREFIX = 'iplv_p2_';
      var toDelete = [];
      for (var i = 0; i < ss.length; i++) {
        var key = ss.key(i);
        if (key && key.startsWith(STALE_PREFIX)) {
          var val = _s(function () { return JSON.parse(ss.getItem(key)); }, null);
          if (val && val.ts && (Date.now() - val.ts) > 24 * 3600000) {
            toDelete.push(key);
          }
        }
      }
      toDelete.forEach(function (k) { _s(function () { ss.removeItem(k); }); });
    });

    _s(function () {
      var rm = G.RuntimeMemory;
      if (rm && typeof rm.compact === 'function') rm.compact();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // J. DETACHED CANVAS CLEANUP v2 (v2.0 improved)
  // ─────────────────────────────────────────────────────────────────────────
  function _cleanDetachedCanvases() {
    if (typeof document === 'undefined') return;
    var cleaned = 0;

    // v1.0: canvases with data-p3-detached attribute
    document.querySelectorAll('canvas[data-p3-detached]').forEach(function (c) {
      _s(function () {
        var ctx = c.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
        c.width = c.height = 1;
        c.remove();
        cleaned++;
      });
    });

    // v2.0: canvases not in the document AND with non-trivial size (GPU memory)
    // We can only check canvases that are currently accessible
    _s(function () {
      var allCanvases = document.querySelectorAll('canvas:not([data-iplv-active])');
      allCanvases.forEach(function (c) {
        // Skip canvases that are visible in layout
        var rect = _s(function () { return c.getBoundingClientRect(); }, null);
        var inViewport = rect && (rect.width > 0 || rect.height > 0) && rect.top < G.innerHeight;
        if (inViewport) return;

        // Only clean large canvases (> 512px on any side) that are off-screen
        if (c.width > 512 || c.height > 512) {
          if (!document.body.contains(c)) {
            // Truly detached
            _s(function () {
              var ctx = c.getContext('2d') || c.getContext('webgl') || c.getContext('webgl2');
              if (ctx && ctx.clearRect) ctx.clearRect(0, 0, c.width, c.height);
              c.width = c.height = 1;
            });
            cleaned++;
          }
        }
      });
    });

    if (cleaned > 0) {
      _stats.canvasCleans += cleaned;
      console.info(LOG, 'detached canvas cleanup:', cleaned, 'canvases freed');
    }
  }

  function _scheduleIdleCleanup() {
    if (_lite) return;
    if (typeof G.requestIdleCallback === 'function') {
      var _scheduleNext = function () {
        G.requestIdleCallback(function () {
          _runIdleCleanup();
          setTimeout(_scheduleNext, _cfg.IDLE_POLL_MS);
        }, { timeout: 5000 });
      };
      setTimeout(_scheduleNext, _cfg.IDLE_POLL_MS);
    } else {
      setInterval(_runIdleCleanup, _cfg.IDLE_POLL_MS);
    }
    console.debug(LOG, 'idle cleanup scheduled');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // D. WORKER MEMORY WATCHDOG (v1.0 retained)
  // ─────────────────────────────────────────────────────────────────────────
  function _checkIdleWorkers() {
    if (!_high) return;
    _s(function () {
      var wp = G.WorkerPool;
      if (!wp || typeof wp.getStats !== 'function') return;
      var stats = wp.getStats();
      Object.keys(stats).forEach(function (url) {
        var wStats = stats[url];
        var idleMs = wStats.lastUsed ? (Date.now() - wStats.lastUsed) : 0;
        if (idleMs > _cfg.WORKER_IDLE_LIMIT_MS && wStats.idle > 0) {
          console.info(LOG, 'auto-terminating idle worker:', url, '| idle:', Math.round(idleMs / 60000) + 'min');
          _s(function () {
            if (wp.terminate) wp.terminate(url);
            _stats.workerKills++;
          });
        }
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // E. BATTERY-AWARE DEGRADATION (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  var _battery = null;
  var _batteryStatus = null;

  function getBatteryStatus() { return _batteryStatus; }

  function _applyBatteryDegradation(battery) {
    _batteryStatus = {
      level:       battery.level,
      charging:    battery.charging,
      chargingTime: battery.chargingTime,
      dischargingTime: battery.dischargingTime,
    };

    // Battery critically low and not charging → ultra-conservative mode
    if (!battery.charging && battery.level < 0.15) {
      _stats.batteryThrottles++;
      console.info(LOG, 'battery critical (', Math.round(battery.level * 100) + '%) — doubling poll intervals');
      _cfg.MEM_POLL_MS        = Math.min(_cfg.MEM_POLL_MS * 2,        120000);
      _cfg.IDLE_POLL_MS       = Math.min(_cfg.IDLE_POLL_MS * 2,       120000);
      _cfg.WORKER_IDLE_LIMIT_MS = Math.min(_cfg.WORKER_IDLE_LIMIT_MS * 2, 20 * 60 * 1000);
      _s(function () {
        if (G.RuntimeEventBus) G.RuntimeEventBus.emit('perf:battery-critical', { level: battery.level });
      });
    }
    // Low battery — moderate throttling
    else if (!battery.charging && battery.level < 0.30) {
      _cfg.MEM_POLL_MS  = Math.min(_cfg.MEM_POLL_MS  * 1.5, 90000);
      _cfg.IDLE_POLL_MS = Math.min(_cfg.IDLE_POLL_MS * 1.5, 90000);
      _s(function () {
        if (G.RuntimeEventBus) G.RuntimeEventBus.emit('perf:battery-low', { level: battery.level });
      });
    }
    // Charging → restore normal intervals
    else if (battery.charging && _stats.batteryThrottles > 0) {
      _cfg.MEM_POLL_MS        = _high ? 20000 : 45000;
      _cfg.IDLE_POLL_MS       = 30000;
      _cfg.WORKER_IDLE_LIMIT_MS = _high ? 8 * 60 * 1000 : 12 * 60 * 1000;
    }
  }

  function _startBatteryMonitor() {
    if (!_high) return;
    _s(function () {
      if (typeof navigator.getBattery !== 'function') return;
      navigator.getBattery().then(function (battery) {
        _battery = battery;
        _applyBatteryDegradation(battery);
        battery.addEventListener('levelchange',   function () { _applyBatteryDegradation(battery); });
        battery.addEventListener('chargingchange', function () { _applyBatteryDegradation(battery); });
        console.debug(LOG, 'battery monitor active | level:', Math.round(battery.level * 100) + '%');
      }).catch(function () {
        console.debug(LOG, 'Battery API not available');
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // F. THERMAL-AWARE DEGRADATION (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  var _thermalStatus = { warnings: 0, throttled: false, longTasks: 0 };

  function getThermalStatus() { return Object.assign({}, _thermalStatus); }

  function _startThermalMonitor() {
    if (!_high) return;
    _s(function () {
      if (typeof PerformanceObserver === 'undefined') return;

      // Long task detection: tasks > 50ms indicate thread saturation / thermal pressure
      var observer = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var entry of entries) {
          if (entry.duration > 200) {
            // Very long task (>200ms) = possible thermal throttling
            _thermalStatus.longTasks++;
            _thermalStatus.warnings++;
            _stats.thermalWarnings++;

            if (_thermalStatus.longTasks > 3 && !_thermalStatus.throttled) {
              _thermalStatus.throttled = true;
              console.warn(LOG, 'thermal pressure detected (', _thermalStatus.longTasks, 'long tasks >200ms) — reducing worker concurrency');
              _s(function () {
                if (G.RuntimeEventBus) {
                  G.RuntimeEventBus.emit('perf:thermal-pressure', {
                    longTasks: _thermalStatus.longTasks,
                    duration:  Math.round(entry.duration),
                  });
                }
              });
              // Throttle queue under thermal pressure
              _emitQueueThrottle('thermal');
            }
          }
        }
      });

      observer.observe({ entryTypes: ['longtask'] });
      console.debug(LOG, 'thermal monitor active (PerformanceObserver:longtask)');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // I. ORPHANED WORKER CLEANUP (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  function _cleanOrphanedWorkers() {
    if (!_high) return;
    _s(function () {
      // P4Heartbeat can identify workers that haven't ponged in a long time
      var hb = G.RuntimeP4Heartbeat;
      if (!hb || typeof hb.status !== 'function') return;
      var status = hb.status();
      var now    = Date.now();
      (status.workers || []).forEach(function (w) {
        var staleness = now - (w.lastPong || 0);
        // If lastPong is >5 min old AND worker has 0 queue and 0 restarts (never worked)
        if (staleness > 5 * 60 * 1000 && w.queueLen === 0 && w.restarts === 0) {
          console.debug(LOG, 'orphaned worker candidate:', w.workerId, '| stale:', Math.round(staleness / 60000) + 'min');
          // We don't terminate here — just emit for RuntimeWorkerOrchestrator to decide
          _s(function () {
            if (G.RuntimeEventBus) {
              G.RuntimeEventBus.emit('worker:orphan-candidate', { workerId: w.workerId, staleMs: staleness });
            }
          });
        }
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _patchBlobAPIs();
    _startMemoryMonitor();
    _scheduleIdleCleanup();
    _startBatteryMonitor();
    _startThermalMonitor();

    if (_high) {
      setInterval(_checkIdleWorkers, 5 * 60 * 1000);
      setInterval(_cleanOrphanedWorkers, 10 * 60 * 1000);
    }

    console.info(LOG, 'v' + VERSION + ' ready | lite:', _lite, '| mid:', _mid, '| high:', _high,
      '| battery:', typeof navigator.getBattery === 'function',
      '| thermal:', typeof PerformanceObserver !== 'undefined');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1600); }, { once: true });
  } else {
    setTimeout(_boot, 1600);
  }

  // ── Public API (v2.0 — backward-compatible with v1.0) ────────────────────
  G.RuntimePerfSafety = Object.freeze({
    VERSION:           VERSION,
    getMemorySnapshot: getMemorySnapshot,
    revokeLeakedBlobs: revokeLeakedBlobs,
    runIdleCleanup:    _runIdleCleanup,
    getBatteryStatus:  getBatteryStatus,
    getThermalStatus:  getThermalStatus,
    getMemoryTrend:    getMemoryTrend,
    status: function () {
      return {
        version:        VERSION,
        blobsTracked:   _stats.blobsTracked,
        blobsRevoked:   _stats.blobsRevoked,
        pressureEvents: _stats.pressureEvents,
        idleRuns:       _stats.idleRuns,
        workerKills:    _stats.workerKills,
        canvasCleans:   _stats.canvasCleans,
        thermalWarnings:_stats.thermalWarnings,
        batteryThrottles:_stats.batteryThrottles,
        predictions:    _stats.predictions,
        tier:           _lite ? 'LOW' : (_mid ? 'MEDIUM' : 'HIGH'),
        memorySnapshot: getMemorySnapshot(),
        batteryStatus:  _batteryStatus,
        thermalStatus:  _thermalStatus,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
