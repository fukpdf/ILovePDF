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
  // Keep a small, text-free attribution ring buffer so CLS can be traced to
  // actual moving DOM nodes without collecting user content.
  var _layoutShiftEntries = [];
  var _MAX_LAYOUT_SHIFT_ENTRIES = 25;

  function _describeNode(node) {
    if (!node) return null;
    var className = '';
    try {
      className = typeof node.className === 'string'
        ? node.className
        : (node.className && node.className.baseVal) || '';
    } catch (_) {}
    return {
      tag: String(node.tagName || '').toLowerCase() || null,
      id: String(node.id || '').slice(0, 120) || null,
      className: String(className).trim().slice(0, 240) || null,
      role: (node.getAttribute && node.getAttribute('role')) || null,
    };
  }

  function _describeRect(rect) {
    if (!rect) return null;
    var result = {};
    ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].forEach(function (key) {
      var value = Number(rect[key]);
      if (isFinite(value)) result[key] = Math.round(value * 100) / 100;
    });
    return result;
  }

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
    var sources = [];
    try {
      (e.sources || []).slice(0, 5).forEach(function (source) {
        sources.push({
          node: _describeNode(source && source.node),
          previousRect: _describeRect(source && source.previousRect),
          currentRect: _describeRect(source && source.currentRect),
        });
      });
    } catch (_) {}
    _layoutShiftEntries.push({
      value: +Number(e.value || 0).toFixed(4),
      startTime: Math.round(Number(e.startTime || 0)),
      hadRecentInput: !!e.hadRecentInput,
      sources: sources,
    });
    if (_layoutShiftEntries.length > _MAX_LAYOUT_SHIFT_ENTRIES) _layoutShiftEntries.shift();
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

  // ── Startup duration tracking ────────────────────────────────────────────
  // Captures navigation→DOMContentLoaded and navigation→load durations.
  // Uses PerformanceNavigationTiming when available, falls back to Date.now().
  var _startupMs = null;   // DOMContentLoaded duration from nav start
  var _loadMs    = null;   // window load event duration from nav start

  (function () {
    try {
      var nav = G.performance && G.performance.getEntriesByType &&
                G.performance.getEntriesByType('navigation')[0];
      if (nav) {
        _startupMs = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
        _loadMs    = Math.round(nav.loadEventEnd - nav.startTime);
      }
    } catch (_) {}

    // Fallback: hook events if nav timing not yet populated
    if (!_startupMs) {
      var _navStart = (G.performance && G.performance.timing &&
                       G.performance.timing.navigationStart) || Date.now();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          _startupMs = Date.now() - _navStart;
        }, { once: true });
      } else {
        _startupMs = Date.now() - _navStart;
      }
    }
    if (!_loadMs) {
      var _navStart2 = (G.performance && G.performance.timing &&
                        G.performance.timing.navigationStart) || Date.now();
      G.addEventListener('load', function () {
        _loadMs = Date.now() - _navStart2;
      }, { once: true });
    }
  }());

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
      startup:      { domContentLoadedMs: _startupMs, loadMs: _loadMs },
      longTasks:    { count: _metrics.longTasks, totalMs: _metrics.longTaskMs },
      memory:       mem,
      memorySamples:_memorySamples.slice(),
      toolRuns:     _metrics.toolRuns.slice(),
      // Recent entries include shifts caused by user-visible reflow and
      // input-triggered movement; only hadRecentInput=false contributes to CLS.
      layoutShifts: _layoutShiftEntries.slice(),
      route:        (G.location && G.location.pathname) || null,
      ts:           Date.now(),
    };
  }

  G.RuntimePerformanceMonitor = Object.freeze({
    recordToolRun:    recordToolRun,
    getReport:        getReport,
    getStartupMs:     function () { return { domContentLoadedMs: _startupMs, loadMs: _loadMs }; },
    getVitals: function () { return Object.assign({}, _metrics.lcp !== null ? {
      lcp: _metrics.lcp, fid: _metrics.fid, cls: _metrics.cls,
      fcp: _metrics.fcp, ttfb: _metrics.ttfb,
    } : {}); },
    getLayoutShiftDiagnostics: function () { return _layoutShiftEntries.slice(); },
  });
}());
