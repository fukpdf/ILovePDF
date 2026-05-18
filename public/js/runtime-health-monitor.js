// runtime-health-monitor.js — Phase 2D Health Monitor Augmentation
// ADDITIVE ONLY. Augments the existing window.RuntimeHealth (Phase 2 T031)
// with additional Phase 2D telemetry: worker counts, busy slots, OCR workers,
// heap usage, active canvases, PDF docs alive, queue depth, task latency,
// timeouts/minute. Also exposes window.RuntimeHealth.getSnapshot() used by
// RuntimeWatchdog. Guards against RuntimeHealth not yet being loaded.
(function () {
  'use strict';

  var LOG     = '[RHM2D]';
  var VERSION = '1.0.0';

  // ── Timeout-per-minute tracker ────────────────────────────────────────────────
  var _timeoutTimestamps = [];
  var _TIMEOUT_WINDOW_MS = 60000;

  function _trackTimeouts() {
    try {
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.on('timeout:fired', function () {
          _timeoutTimestamps.push(Date.now());
        });
      }
    } catch (_) {}
  }

  function _timeoutsPerMinute() {
    var cutoff = Date.now() - _TIMEOUT_WINDOW_MS;
    _timeoutTimestamps = _timeoutTimestamps.filter(function (ts) { return ts > cutoff; });
    return _timeoutTimestamps.length;
  }

  // ── Latency tracker ───────────────────────────────────────────────────────────
  var _taskLatencies = []; // last 50 task durations (ms)

  function recordLatency(ms) {
    _taskLatencies.push(ms);
    if (_taskLatencies.length > 50) _taskLatencies.shift();
  }

  function _avgLatency() {
    if (!_taskLatencies.length) return 0;
    var sum = _taskLatencies.reduce(function (a, b) { return a + b; }, 0);
    return Math.round(sum / _taskLatencies.length);
  }

  // ── Collect Phase 2D snapshot ─────────────────────────────────────────────────
  function collectSnapshot() {
    var snap = {
      ts:              Date.now(),
      score:           100,
      issues:          [],
      workersBusy:     0,
      workersTotal:    0,
      ocrWorkers:      0,
      heapMB:          null,
      canvasCount:     0,
      canvasLarge:     0,
      pdfDocsLive:     0,
      queueDepth:      0,
      avgLatencyMs:    _avgLatency(),
      timeoutsPerMin:  _timeoutsPerMinute(),
      panicActive:     false,
      circuitOpen:     [],
    };

    // Worker counts
    try {
      var WP = window.WorkerPool;
      if (WP) {
        var stats = WP.getStats();
        Object.keys(stats).forEach(function (url) {
          var s = stats[url];
          snap.workersBusy  += (s.busy  || 0);
          snap.workersTotal += (s.total || 0);
          snap.queueDepth   += (s.queued || 0);
          if (s.crashed > 0) {
            snap.issues.push('crashed-workers:' + url.split('/').pop());
            snap.score -= 10;
          }
          if (s.busy === s.total && s.total > 0 && s.queued > 0) {
            snap.issues.push('pool-stuck:' + url.split('/').pop());
            snap.score -= 15;
          }
        });
      }
    } catch (_) {}

    // OCR workers
    try {
      var TC = window.RuntimeTesseractCleaner;
      if (TC) {
        var ts = TC.getStats();
        snap.ocrWorkers = ts.live || 0;
        if (snap.ocrWorkers > 3) {
          snap.issues.push('ocr-leak:' + snap.ocrWorkers + '-workers');
          snap.score -= 10;
        }
      }
    } catch (_) {}

    // Heap
    try {
      if (performance.memory) {
        snap.heapMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        if (snap.heapMB > 600) { snap.issues.push('heap-high:' + snap.heapMB + 'MB'); snap.score -= 20; }
        else if (snap.heapMB > 400) { snap.issues.push('heap-elevated:' + snap.heapMB + 'MB'); snap.score -= 10; }
      }
    } catch (_) {}

    // Canvas
    try {
      var census = window.RuntimeCanvasGC ? window.RuntimeCanvasGC.census() : null;
      if (census) {
        snap.canvasCount = census.total;
        snap.canvasLarge = census.large;
        if (census.huge > 0) { snap.issues.push('canvas-huge:' + census.huge); snap.score -= 15; }
        if (census.large > 5) { snap.issues.push('canvas-many:' + census.large); snap.score -= 8; }
      }
    } catch (_) {}

    // PDF docs
    try {
      var PC = window.RuntimePdfCleaner;
      if (PC) {
        snap.pdfDocsLive = (PC.getStats() || {}).live || 0;
        if (snap.pdfDocsLive > 5) { snap.issues.push('pdf-leak:' + snap.pdfDocsLive + '-docs'); snap.score -= 10; }
      }
    } catch (_) {}

    // Queue depth
    try {
      var RS = window.RuntimeScheduler;
      if (RS) {
        var rsStats = RS.getStats();
        snap.queueDepth += (rsStats.waitQueueSize || 0);
        if (rsStats.waitQueueSize > 8) { snap.issues.push('queue-bloat:' + rsStats.waitQueueSize); snap.score -= 12; }
      }
    } catch (_) {}

    // Timeouts/min
    if (snap.timeoutsPerMin > 5) {
      snap.issues.push('timeout-storm:' + snap.timeoutsPerMin + '/min');
      snap.score -= Math.min(snap.timeoutsPerMin * 3, 25);
    }

    // Avg latency
    if (snap.avgLatencyMs > 30000) {
      snap.issues.push('high-latency:' + Math.round(snap.avgLatencyMs / 1000) + 's');
      snap.score -= 10;
    }

    // Panic
    try {
      if (window.RuntimePanicManager) {
        snap.panicActive = window.RuntimePanicManager.isPanic();
        if (snap.panicActive) { snap.issues.push('panic-active'); snap.score -= 30; }
      }
    } catch (_) {}

    // Circuit breakers
    try {
      if (window.RuntimeCircuitBreakers) {
        var cbStats = window.RuntimeCircuitBreakers.getStats();
        Object.keys(cbStats.circuits || {}).forEach(function (name) {
          if (cbStats.circuits[name].state === 'OPEN') {
            snap.circuitOpen.push(name);
            snap.issues.push('circuit-open:' + name);
            snap.score -= 10;
          }
        });
      }
    } catch (_) {}

    snap.score = Math.max(0, Math.min(100, snap.score));
    return snap;
  }

  // ── Wire getSnapshot() onto existing RuntimeHealth ────────────────────────────
  // We wait for RuntimeHealth to be available, then augment it.
  function _augmentRuntimeHealth() {
    var RH = window.RuntimeHealth;
    if (!RH) return false;

    // Only augment once
    if (RH.__2d_augmented) return true;
    RH.__2d_augmented = true;

    // Add getSnapshot if not already present (T031 doesn't have this exact method)
    if (typeof RH.getSnapshot !== 'function') {
      RH.getSnapshot = collectSnapshot;
    } else {
      // Wrap existing getSnapshot to merge Phase 2D data
      var _orig = RH.getSnapshot.bind(RH);
      RH.getSnapshot = function () {
        var existing = {};
        try { existing = _orig(); } catch (_) {}
        var d2d = collectSnapshot();
        // Merge: our issues supplement existing ones
        return Object.assign({}, existing, d2d, {
          issues: (existing.issues || []).concat(d2d.issues),
          score:  Math.min(existing.score !== undefined ? existing.score : 100, d2d.score),
        });
      };
    }

    // Expose recordLatency on RuntimeHealth
    if (typeof RH.recordLatency !== 'function') {
      RH.recordLatency = recordLatency;
    }

    console.info(LOG, 'RuntimeHealth augmented with Phase 2D telemetry');
    return true;
  }

  // ── Retry augmentation until RuntimeHealth is available ───────────────────────
  var _augTries = 0;
  var _augTimer = setInterval(function () {
    if (_augmentRuntimeHealth() || ++_augTries > 40) clearInterval(_augTimer);
  }, 250);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeHealthMonitor', _augTimer);

  // ── Subscribe to task completion for latency tracking ─────────────────────────
  setTimeout(function () {
    try {
      _trackTimeouts();
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.on('task:completed', function (e) {
          if (e && e.durationMs) recordLatency(e.durationMs);
        });
      }
    } catch (_) {}
  }, 2000);

  // ── Expose standalone snapshot even if RuntimeHealth hasn't loaded ────────────
  window.RuntimeHealthSnapshot = {
    collect:         collectSnapshot,
    recordLatency:   recordLatency,
    timeoutsPerMin:  _timeoutsPerMinute,
    VERSION:         VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
