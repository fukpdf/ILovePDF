// runtime-panic-manager.js — Runtime Panic Recovery (Phase 2D)
// ADDITIVE ONLY. Detects catastrophic runtime states (heap explosion, worker storm,
// scheduler deadlock, repeated crashes, GPU meltdown, tab-freeze risk) and
// triggers PANIC MODE: pause new tasks → drain queues → cleanup zombies →
// restart workers → resume safely. NO page reload ever.
//
// window.RuntimePanicManager — public API
(function () {
  'use strict';

  if (window.RuntimePanicManager) return;

  var LOG     = '[RPM]';
  var VERSION = '1.0.0';

  // ── Panic state ──────────────────────────────────────────────────────────────
  var _inPanic      = false;
  var _panicCount   = 0;
  var _lastPanic    = 0;
  var _panicHistory = []; // last 10 panic events
  var MAX_HISTORY   = 10;

  // ── Panic thresholds ─────────────────────────────────────────────────────────
  var HEAP_EXPLOSION_MB       = 800;   // > 800 MB heap usage
  var WORKER_STORM_COUNT      = 8;     // > 8 simultaneously busy workers
  var SCHEDULER_DEADLOCK_MS   = 90000; // wait queue stuck for > 90s
  var REPEATED_CRASH_COUNT    = 5;     // > 5 timeouts fired in 2 min window
  var CANVAS_MEMORY_MB        = 200;   // > 200 MB in canvas pixels (estimated)
  var PANIC_COOLDOWN_MS       = 30000; // don't re-panic more than once per 30s

  // ── Crash/timeout counter (sliding window) ────────────────────────────────────
  var _recentTimeouts  = []; // timestamps of recent timeout fires
  var _TIMEOUT_WINDOW  = 2 * 60 * 1000; // 2 min

  // Subscribe to timeout events from RuntimeTimeoutReaper
  function _trackTimeout() {
    try {
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.on('timeout:fired', function () {
          _recentTimeouts.push(Date.now());
        });
      }
    } catch (_) {}
  }

  function _recentTimeoutCount() {
    var cutoff = Date.now() - _TIMEOUT_WINDOW;
    _recentTimeouts = _recentTimeouts.filter(function (ts) { return ts > cutoff; });
    return _recentTimeouts.length;
  }

  // ── Panic detection checks ───────────────────────────────────────────────────

  function _checkHeap() {
    try {
      var mem = performance.memory;
      if (mem && mem.usedJSHeapSize > HEAP_EXPLOSION_MB * 1024 * 1024) {
        return { triggered: true, reason: 'heap-explosion:' + Math.round(mem.usedJSHeapSize / 1024 / 1024) + 'MB' };
      }
    } catch (_) {}
    return { triggered: false };
  }

  function _checkWorkerStorm() {
    try {
      var WP = window.WorkerPool;
      if (!WP) return { triggered: false };
      var stats = WP.getStats();
      var totalBusy = 0;
      Object.keys(stats).forEach(function (url) { totalBusy += (stats[url].busy || 0); });
      if (totalBusy > WORKER_STORM_COUNT) {
        return { triggered: true, reason: 'worker-storm:' + totalBusy + '-busy' };
      }
    } catch (_) {}
    return { triggered: false };
  }

  function _checkSchedulerDeadlock() {
    try {
      var RS = window.RuntimeScheduler;
      if (!RS) return { triggered: false };
      var s = RS.getStats();
      if (s.waitQueueSize > 0) {
        var key = 'sched-stuck';
        if (!_stuckSince[key]) {
          _stuckSince[key] = Date.now();
        } else if ((Date.now() - _stuckSince[key]) > SCHEDULER_DEADLOCK_MS) {
          return { triggered: true, reason: 'scheduler-deadlock:queue=' + s.waitQueueSize };
        }
      } else {
        delete _stuckSince['sched-stuck'];
      }
    } catch (_) {}
    return { triggered: false };
  }

  function _checkRepeatedCrashes() {
    var count = _recentTimeoutCount();
    if (count > REPEATED_CRASH_COUNT) {
      return { triggered: true, reason: 'repeated-crashes:' + count + '-in-2min' };
    }
    return { triggered: false };
  }

  function _checkCanvasMemory() {
    try {
      var canvases = document.querySelectorAll('canvas');
      var totalPx  = 0;
      canvases.forEach(function (c) { totalPx += (c.width || 0) * (c.height || 0); });
      // Estimate: 4 bytes per pixel (RGBA)
      var estimatedMB = (totalPx * 4) / (1024 * 1024);
      if (estimatedMB > CANVAS_MEMORY_MB) {
        return { triggered: true, reason: 'canvas-memory:' + Math.round(estimatedMB) + 'MB' };
      }
    } catch (_) {}
    return { triggered: false };
  }

  var _stuckSince = {};

  // ── Main detect loop ─────────────────────────────────────────────────────────
  function detect() {
    if (_inPanic) return; // already in panic, don't re-detect
    if (Date.now() - _lastPanic < PANIC_COOLDOWN_MS) return;

    var checks = [
      _checkHeap,
      _checkWorkerStorm,
      _checkSchedulerDeadlock,
      _checkRepeatedCrashes,
      _checkCanvasMemory,
    ];

    for (var i = 0; i < checks.length; i++) {
      var result;
      try { result = checks[i](); } catch (_) { continue; }
      if (result && result.triggered) {
        _triggerPanic(result.reason);
        return;
      }
    }
  }

  // ── PANIC MODE ───────────────────────────────────────────────────────────────
  function _triggerPanic(reason) {
    if (_inPanic) return;
    _inPanic   = true;
    _panicCount++;
    _lastPanic = Date.now();

    var entry = { ts: _lastPanic, reason: reason, count: _panicCount };
    _panicHistory.push(entry);
    if (_panicHistory.length > MAX_HISTORY) _panicHistory.shift();

    console.error(LOG, '🚨 PANIC MODE triggered! Reason:', reason, '| Count:', _panicCount);

    try {
      if (window.RuntimeEventBus) window.RuntimeEventBus.emit('panic:triggered', entry);
    } catch (_) {}

    _executePanicRecovery(reason, function () {
      _inPanic = false;
      console.info(LOG, '✅ PANIC recovery complete — runtime resumed');
      try {
        if (window.RuntimeEventBus) window.RuntimeEventBus.emit('panic:recovered', { reason: reason });
      } catch (_) {}
    });
  }

  // ── Panic recovery sequence ───────────────────────────────────────────────────
  // Phase 1 (immediate):   Pause new tasks
  // Phase 2 (async 100ms): Drain + clean zombies + cleanup PDF/canvas
  // Phase 3 (async 500ms): Terminate stuck workers
  // Phase 4 (async 1000ms): Resume safely

  function _executePanicRecovery(reason, onDone) {
    // Phase 1: Pause schedulers
    _pauseAll();

    setTimeout(function () {
      // Phase 2: Clean known leak sources
      _cleanLeaks();

      setTimeout(function () {
        // Phase 3: Restart workers
        _restartWorkers();

        setTimeout(function () {
          // Phase 4: Resume
          _resumeAll();
          if (typeof onDone === 'function') onDone();
        }, 1000);
      }, 500);
    }, 100);
  }

  function _pauseAll() {
    try { if (window.TaskScheduler) window.TaskScheduler.pause(); } catch (_) {}
    try { if (window.RuntimeScheduler) window.RuntimeScheduler.cancelAll('panic:' + _panicCount); } catch (_) {}
    console.info(LOG, '[panic] schedulers paused, queues cancelled');
  }

  function _cleanLeaks() {
    // Zombie cleaner
    try { if (window.RuntimeZombieCleaner) window.RuntimeZombieCleaner.sweep(); } catch (_) {}
    // PDF cleaner
    try { if (window.RuntimePdfCleaner) window.RuntimePdfCleaner.sweep(); } catch (_) {}
    // Tesseract cleaner
    try { if (window.RuntimeTesseractCleaner) window.RuntimeTesseractCleaner.sweep(); } catch (_) {}
    // Canvas GC
    try { if (window.RuntimeCanvasGC) window.RuntimeCanvasGC.sweep(); } catch (_) {}
    // CanvasPool flush
    try { if (window.CanvasPool) window.CanvasPool.flushPool(); } catch (_) {}
    // Cancel all registered timeouts
    try { if (window.RuntimeTimeoutReaper) window.RuntimeTimeoutReaper.cancelAll('panic'); } catch (_) {}
    // CleanupContracts if available
    try {
      if (window.CleanupContracts && window.CleanupContracts.cleanup) {
        window.CleanupContracts.cleanup('panic');
      }
    } catch (_) {}
    console.info(LOG, '[panic] leak cleanup complete');
  }

  function _restartWorkers() {
    try {
      var WP = window.WorkerPool;
      if (!WP) return;
      var stats = WP.getStats();
      // Terminate pools with stuck/crashed workers
      Object.keys(stats).forEach(function (url) {
        var s = stats[url];
        if (s.crashed > 0 || (s.busy > 0 && s.total > 0 && s.busy === s.total)) {
          try { WP.terminatePool(url); } catch (_) {}
          console.info(LOG, '[panic] terminated pool:', url);
        }
      });
    } catch (_) {}
    console.info(LOG, '[panic] worker restart complete');
  }

  function _resumeAll() {
    try { if (window.TaskScheduler) window.TaskScheduler.resume(); } catch (_) {}
    console.info(LOG, '[panic] schedulers resumed');
  }

  // ── Manual panic trigger ─────────────────────────────────────────────────────
  function triggerPanic(reason) {
    _triggerPanic(reason || 'manual');
  }

  function getStats() {
    return {
      inPanic:      _inPanic,
      panicCount:   _panicCount,
      lastPanic:    _lastPanic,
      history:      _panicHistory.slice(),
      stuckKeys:    Object.keys(_stuckSince),
      version:      VERSION,
    };
  }

  // ── Detection loop (every 20s) ───────────────────────────────────────────────
  var _detectTimer = setInterval(function () {
    try { detect(); } catch (_) {}
  }, 20000);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimePanicManager', _detectTimer);

  // Subscribe to timeout events after a short delay (allow EventBus to load)
  setTimeout(_trackTimeout, 2000);

  window.RuntimePanicManager = {
    detect:       detect,
    triggerPanic: triggerPanic,
    getStats:     getStats,
    isPanic:      function () { return _inPanic; },
    VERSION:      VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
