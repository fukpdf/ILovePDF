// runtime-performance-monitor.js — Phase 9 client-side performance metrics
// Collects LCP, FID, CLS, tool processing times, memory samples, and
// long-task counts. Exposes window.RuntimePerformanceMonitor with a
// getReport() method for the admin dashboard and telemetry pipeline.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimePerformanceMonitor) return;

  var _metrics = {
    lcp:        null,   // Largest Contentful Paint (ms)
    fid:        null,   // First Input Delay (ms)
    cls:        0,      // Cumulative Layout Shift score
    ttfb:       null,   // Time to First Byte (ms)
    fcp:        null,   // First Contentful Paint (ms)
    longTasks:  0,      // count of tasks > 50 ms
    longTaskMs: 0,      // total ms blocked in long tasks
    toolRuns:   [],     // ring buffer: last 30 tool timings { tool, ms, ok }
  };

  var _MAX_TOOL_RUNS = 30;

  // ── Web Vitals via PerformanceObserver ────────────────────────────────────
  function _observe(type, callback) {
    try {
      if (!G.PerformanceObserver) return;
      var po = new G.PerformanceObserver(function (list) {
        list.getEntries().forEach(callback);
      });
      po.observe({ type: type, buffered: true });
    } catch (_) {}
  }

  _observe('largest-contentful-paint', function (e) {
    _metrics.lcp = Math.round(e.startTime);
  });

  _observe('first-input', function (e) {
    _metrics.fid = Math.round(e.processingStart - e.startTime);
  });

  _observe('layout-shift', function (e) {
    if (!e.hadRecentInput) _metrics.cls = +(_metrics.cls + (e.value || 0)).toFixed(4);
  });

  _observe('longtask', function (e) {
    _metrics.longTasks++;
    _metrics.longTaskMs += Math.round(e.duration || 0);
  });

  // TTFB + FCP from navigation / paint entries
  try {
    var nav = G.performance && G.performance.getEntriesByType &&
              G.performance.getEntriesByType('navigation')[0];
    if (nav) _metrics.ttfb = Math.round(nav.responseStart - nav.requestStart);

    var paints = G.performance && G.performance.getEntriesByName &&
                 G.performance.getEntriesByName('first-contentful-paint');
    if (paints && paints[0]) _metrics.fcp = Math.round(paints[0].startTime);
  } catch (_) {}

  // ── Memory sampler ────────────────────────────────────────────────────────
  var _memorySamples = [];
  var _MAX_MEM_SAMPLES = 20;
  function _sampleMemory() {
    try {
      var m = G.performance && G.performance.memory;
      if (!m) return;
      _memorySamples.push({
        ts:        Date.now(),
        usedMb:    +(m.usedJSHeapSize  / 1048576).toFixed(1),
        totalMb:   +(m.totalJSHeapSize / 1048576).toFixed(1),
        limitMb:   +(m.jsHeapSizeLimit / 1048576).toFixed(1),
      });
      if (_memorySamples.length > _MAX_MEM_SAMPLES) _memorySamples.shift();
    } catch (_) {}
  }
  setInterval(_sampleMemory, 15000);
  _sampleMemory();

  // ── Tool timing API ───────────────────────────────────────────────────────
  function recordToolRun(toolId, durationMs, succeeded) {
    _metrics.toolRuns.push({ tool: toolId, ms: durationMs, ok: !!succeeded, ts: Date.now() });
    if (_metrics.toolRuns.length > _MAX_TOOL_RUNS) _metrics.toolRuns.shift();
    try {
      var st = G.SecurityTelemetry;
      if (st && typeof st.record === 'function') {
        st.record('tool-perf', { tool: toolId, ms: durationMs, ok: !!succeeded });
      }
    } catch (_) {}
  }

  function getReport() {
    var mem = _memorySamples.length ? _memorySamples[_memorySamples.length - 1] : null;
    return {
      vitals: {
        lcp:   _metrics.lcp,
        fid:   _metrics.fid,
        cls:   _metrics.cls,
        fcp:   _metrics.fcp,
        ttfb:  _metrics.ttfb,
      },
      longTasks:    { count: _metrics.longTasks, totalMs: _metrics.longTaskMs },
      memory:       mem,
      memorySamples:_memorySamples.slice(),
      toolRuns:     _metrics.toolRuns.slice(),
      ts:           Date.now(),
    };
  }

  G.RuntimePerformanceMonitor = Object.freeze({
    recordToolRun: recordToolRun,
    getReport:     getReport,
    getVitals: function () { return Object.assign({}, _metrics.lcp !== null ? {
      lcp: _metrics.lcp, fid: _metrics.fid, cls: _metrics.cls,
      fcp: _metrics.fcp, ttfb: _metrics.ttfb,
    } : {}); },
  });
}());
