// Memory Telemetry v1.0 — Final Stabilization
// Aggregates memory observability across all runtime components:
//   JS heap, canvas count, blob/object URLs, worker count, OPFS usage.
// Exposes window.MemoryTelemetry.getSnapshot() for dashboards and audits.
//
// API: window.MemoryTelemetry
//   .getSnapshot()   → detailed memory stats
//   .startSampling(intervalMs)
//   .stopSampling()
//   .getHistory()    → last N snapshots
//   .reset()
(function () {
  'use strict';

  if (window.MemoryTelemetry) return;

  var MB             = 1048576;
  var MAX_HISTORY    = 30;    // keep last 30 samples

  var _history    = [];
  var _sampleTimer = null;

  function _heapStats() {
    try {
      var m = performance && performance.memory;
      if (m) {
        return {
          usedMB:  +(m.usedJSHeapSize  / MB).toFixed(1),
          limitMB: +(m.jsHeapSizeLimit  / MB).toFixed(1),
          totalMB: +(m.totalJSHeapSize  / MB).toFixed(1),
          pct:     m.jsHeapSizeLimit > 0 ? +(m.usedJSHeapSize / m.jsHeapSizeLimit * 100).toFixed(1) : 0,
        };
      }
    } catch (_) {}
    return { usedMB: 0, limitMB: 0, totalMB: 0, pct: 0 };
  }

  function _canvasStats() {
    try {
      var canvases = document.querySelectorAll('canvas');
      var count = canvases.length;
      var pixels = 0;
      canvases.forEach(function (c) { pixels += c.width * c.height; });
      var estimatedMB = +(pixels * 4 / MB).toFixed(1);   // RGBA = 4 bytes/px
      return { count: count, pixels: pixels, estimatedMB: estimatedMB };
    } catch (_) { return { count: 0, pixels: 0, estimatedMB: 0 }; }
  }

  function _workerStats() {
    try {
      if (window.WorkerLeakDetector) {
        var r = window.WorkerLeakDetector.getReport();
        return { alive: r.alive, suspects: r.suspects.length, total: r.total };
      }
    } catch (_) {}
    return { alive: 0, suspects: 0, total: 0 };
  }

  function _urlStats() {
    try {
      if (window.ObjectURLRegistry) {
        var s = window.ObjectURLRegistry.stats();
        return { total: s.total };
      }
    } catch (_) {}
    return { total: 0 };
  }

  function _pressureTier() {
    try {
      if (window.MemPressure) return window.MemPressure.tier();
    } catch (_) {}
    try {
      if (window.MemoryMonitor) return window.MemoryMonitor.isUnderPressure() ? 'low' : 'ok';
    } catch (_) {}
    return 'unknown';
  }

  function _stabilityStats() {
    try {
      if (window.StabilityMetrics) {
        var r = window.StabilityMetrics.getReport();
        return {
          renders:     r.renders.total,
          successRate: r.renders.successRate,
          retries:     r.retries.total,
          failures:    r.renders.failure,
        };
      }
    } catch (_) {}
    return { renders: 0, successRate: 'N/A', retries: 0, failures: 0 };
  }

  function getSnapshot() {
    return {
      ts:         Date.now(),
      heap:       _heapStats(),
      canvases:   _canvasStats(),
      workers:    _workerStats(),
      objectUrls: _urlStats(),
      tier:       _pressureTier(),
      stability:  _stabilityStats(),
    };
  }

  function startSampling(intervalMs) {
    if (_sampleTimer) return;
    _sampleTimer = setInterval(function () {
      var snap = getSnapshot();
      _history.push(snap);
      if (_history.length > MAX_HISTORY) _history.shift();
    }, intervalMs || 15000);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerInterval('MemoryTelemetry', _sampleTimer);
    }
  }

  function stopSampling() {
    if (_sampleTimer) { clearInterval(_sampleTimer); _sampleTimer = null; }
  }

  function getHistory() {
    return _history.slice();
  }

  function reset() {
    _history = [];
  }

  // Auto-start sampling at 20 s intervals
  startSampling(20000);

  window.addEventListener('pagehide', function () {
    stopSampling();
  }, { passive: true });

  window.MemoryTelemetry = { getSnapshot, startSampling, stopSampling, getHistory, reset };
  console.debug('[MemoryTelemetry] ready — window.MemoryTelemetry.getSnapshot()');
}());
