// RuntimePerfSafety v1.0 — Phase 3 / Task 7 (Enterprise Performance Safety)
// ============================================================================
// Adaptive memory pressure monitor, Blob URL leak detector, and idle cleanup
// scheduler. All systems are device-tier-aware and degrade gracefully.
//
// Systems:
//   A. MemoryPressureMonitor — polls performance.memory (Chrome), emits events
//      at WARN (400MB), CRITICAL (700MB), EMERGENCY (900MB) thresholds.
//   B. BlobLeakDetector — intercepts URL.createObjectURL/revokeObjectURL,
//      tracks live blobs, auto-revokes any blob not revoked within 10 minutes.
//   C. IdleCleanup — runs cleanup passes during browser idle time using
//      requestIdleCallback (falls back to setTimeout at 30s intervals).
//   D. WorkerMemoryWatchdog — monitors worker idle time, auto-terminates
//      workers idle for > 10min (MEDIUM) / > 5min (EXTREME).
//
// Tier gating:
//   LOW     — BlobLeakDetector only (lightweight, all devices)
//   MEDIUM+ — MemoryPressureMonitor + IdleCleanup
//   HIGH+   — WorkerMemoryWatchdog
//
// window.RuntimePerfSafety
//   .getMemorySnapshot()  → { heapMB, limitMB, tier }
//   .revokeLeakedBlobs()  → number (revoked count)
//   .runIdleCleanup()     → void (manual trigger)
//   .status()             → { blobsTracked, blobsRevoked, pressureEvents, tier }
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimePerfSafety) return;

  var VERSION = '1.0';
  var LOG     = '[PerfSafety]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ───────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;
  var _mid  = _score >= 40 && _score < 70;
  var _high = _score >= 70;

  // ── Adaptive config ───────────────────────────────────────────────────────
  var MEM_POLL_MS   = _high ? 20000 : 45000;  // memory check interval
  var BLOB_TTL_MS   = 10 * 60 * 1000;         // 10 min blob lifetime
  var IDLE_POLL_MS  = 30000;                  // idle cleanup fallback interval
  var WORKER_IDLE_LIMIT_MS = _high ? 8 * 60 * 1000 : 12 * 60 * 1000; // 8-12 min

  // ── Memory thresholds (MB) ────────────────────────────────────────────────
  var MEM_WARN_MB      = 400;
  var MEM_CRITICAL_MB  = 700;
  var MEM_EMERGENCY_MB = 900;

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    pressureEvents: 0,
    blobsTracked:   0,
    blobsRevoked:   0,
    idleRuns:       0,
    workerKills:    0,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // A. MEMORY PRESSURE MONITOR
  // ─────────────────────────────────────────────────────────────────────────
  var _lastPressureTier = 'ok';

  function getMemorySnapshot() {
    var mem = _s(function () { return performance.memory; });
    if (!mem) return { heapMB: 0, limitMB: 0, tier: 'unknown' };
    var heapMB  = Math.round(mem.usedJSHeapSize  / 1048576);
    var limitMB = Math.round(mem.jsHeapSizeLimit / 1048576);
    var tier = 'ok';
    if (heapMB >= MEM_EMERGENCY_MB) tier = 'emergency';
    else if (heapMB >= MEM_CRITICAL_MB) tier = 'critical';
    else if (heapMB >= MEM_WARN_MB)     tier = 'warn';
    return { heapMB: heapMB, limitMB: limitMB, tier: tier };
  }

  function _checkMemoryPressure() {
    var snap = getMemorySnapshot();
    if (snap.tier === 'unknown') return;
    if (snap.tier === _lastPressureTier) return; // no change
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

    // On critical: request compact from RuntimeMemory
    if (snap.tier === 'critical' || snap.tier === 'emergency') {
      _s(function () {
        var rm = G.RuntimeMemory;
        if (rm && typeof rm.compact === 'function') rm.compact();
      });
      // Also trigger idle cleanup
      _runIdleCleanup();
    }
  }

  function _startMemoryMonitor() {
    if (_lite) return;
    // performance.memory only in Chromium; check first
    var hasPerfMem = _s(function () { return !!performance.memory; }, false);
    if (!hasPerfMem) {
      console.debug(LOG, 'performance.memory not available (non-Chromium) — memory monitor skipped');
      return;
    }
    setInterval(_checkMemoryPressure, MEM_POLL_MS);
    console.debug(LOG, 'memory monitor active | interval:', MEM_POLL_MS + 'ms');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B. BLOB URL LEAK DETECTOR
  // ─────────────────────────────────────────────────────────────────────────
  // Map<url, { ts, revoked }>
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
    var cutoff = Date.now() - BLOB_TTL_MS;
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
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('blob-leak', { count: revoked });
        }
      });
    }
    return revoked;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // C. IDLE CLEANUP SCHEDULER
  // ─────────────────────────────────────────────────────────────────────────
  function _runIdleCleanup() {
    _stats.idleRuns++;

    // 1. Revoke leaked blobs
    revokeLeakedBlobs();

    // 2. Sweep detached canvases (zero out pixel data to free GPU memory)
    _s(function () {
      if (typeof document === 'undefined') return;
      // Only cleanup canvases that are not in the DOM
      var allCanvases = document.querySelectorAll('canvas[data-p3-detached]');
      allCanvases.forEach(function (c) {
        _s(function () {
          var ctx = c.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, c.width, c.height);
          c.width = c.height = 1; // free GPU texture
          c.remove();
        });
      });
    });

    // 3. Prune stale sessionStorage entries (P3 seal + legacy keys only)
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

    // 4. Notify existing RuntimeMemory compact
    _s(function () {
      var rm = G.RuntimeMemory;
      if (rm && typeof rm.compact === 'function') rm.compact();
    });
  }

  function _scheduleIdleCleanup() {
    if (_lite) return;
    if (typeof G.requestIdleCallback === 'function') {
      var _scheduleNext;
      _scheduleNext = function () {
        G.requestIdleCallback(function () {
          _runIdleCleanup();
          setTimeout(_scheduleNext, IDLE_POLL_MS);
        }, { timeout: 5000 });
      };
      setTimeout(_scheduleNext, IDLE_POLL_MS);
      console.debug(LOG, 'idle cleanup scheduled via requestIdleCallback');
    } else {
      // Fallback: setTimeout-based idle cleanup
      setInterval(_runIdleCleanup, IDLE_POLL_MS);
      console.debug(LOG, 'idle cleanup scheduled via setInterval fallback');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // D. WORKER MEMORY WATCHDOG
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
        if (idleMs > WORKER_IDLE_LIMIT_MS && wStats.idle > 0) {
          console.info(LOG, 'auto-terminating idle worker:', url, '| idle:', Math.round(idleMs / 60000) + 'min');
          _s(function () {
            if (wp.terminate) wp.terminate(url);
            _stats.workerKills++;
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
    if (_high) {
      setInterval(_checkIdleWorkers, 5 * 60 * 1000); // check every 5 min
    }
    console.info(LOG, 'v' + VERSION + ' ready | lite:', _lite, '| mid:', _mid, '| high:', _high);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1600); }, { once: true });
  } else {
    setTimeout(_boot, 1600);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimePerfSafety = Object.freeze({
    VERSION:           VERSION,
    getMemorySnapshot: getMemorySnapshot,
    revokeLeakedBlobs: revokeLeakedBlobs,
    runIdleCleanup:    _runIdleCleanup,
    status: function () {
      return {
        blobsTracked:   _stats.blobsTracked,
        blobsRevoked:   _stats.blobsRevoked,
        pressureEvents: _stats.pressureEvents,
        idleRuns:       _stats.idleRuns,
        workerKills:    _stats.workerKills,
        tier:           _lite ? 'LOW' : (_mid ? 'MEDIUM' : 'HIGH'),
        memorySnapshot: getMemorySnapshot(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
