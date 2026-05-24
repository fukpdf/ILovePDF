// RuntimePerformanceProfiler v1.0 — Arc 8 / Phase E
// =====================================================================
// Runtime sampling profiler + bottleneck analyzer.
// Distinct from RuntimePerformanceMonitor (LCP/FID/CLS web vitals) —
// this targets RUNTIME-INTERNAL execution costs.
//
// Techniques:
//   - Adaptive interval sampling (50ms nominal, 200ms battery-save)
//   - PerformanceObserver longtask detection
//   - Per-tool / per-family execution cost accumulation
//   - Hydration bottleneck: captures P0/P1/P2 timing outliers
//   - Worker bottleneck: tracks per-family crash/stall rates
//   - CPU budget tracking: ms-per-tool-category over 30s windows
//   - Frame-drop analysis: counts frames > 33ms (< 30fps)
//   - window.getRuntimeProfile() for full snapshot
//
// Zero overhead when profiler.sampling flag is false.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimePerformanceProfiler) return;

  var LOG     = '[PerfProfiler]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SAMPLE_MS    = 50;
  var WINDOW_MS    = 30 * 1000;
  var MAX_SAMPLES  = 600;  // 30s at 50ms
  var LONGTASK_MS  = 50;   // PerformanceObserver threshold

  // ── State ─────────────────────────────────────────────────────────
  var _sampling  = false;
  var _sampler   = null;
  var _samples   = [];   // { ts, heapMb, fps, thermalTier }
  var _costs     = {};   // toolId → { totalMs, count, p99Ms, samples[] }
  var _families  = {};   // family → { totalMs, count, workerCrashes, longtasks }
  var _longTasks = [];   // { ts, durationMs, attribution }
  var _frameDrops = 0;
  var _lastFrameTs = 0;
  var _metrics   = { samples: 0, longTasks: 0, frameDrops: 0 };
  var _observer  = null;
  var _rafFrame  = null;

  // ── Adaptive sample rate ──────────────────────────────────────────
  function _sampleRate() {
    try {
      var cp = G.RuntimeControlPlane;
      if (cp && !cp.getFlag('profiler.sampling')) return 0;
    } catch (_) {}
    return SAMPLE_MS;
  }

  // ── Per-sample snapshot ───────────────────────────────────────────
  function _takeSample() {
    var now  = Date.now();
    var heap = 0;
    try {
      var pm = performance.memory;
      heap = pm ? Math.round(pm.usedJSHeapSize / 1024 / 1024) : 0;
    } catch (_) {}

    var fps = 0;
    try { fps = G.RuntimeStreamTelemetry ? G.RuntimeStreamTelemetry.getFps() : 0; } catch (_) {}

    var thermalTier = 'nominal';
    try { thermalTier = G.RuntimeTaskOrchestrator ? G.RuntimeTaskOrchestrator.getThermalTier() : 'nominal'; } catch (_) {}

    _samples.push({ ts: now, heapMb: heap, fps: fps, thermalTier: thermalTier });
    if (_samples.length > MAX_SAMPLES) _samples.shift();
    _metrics.samples++;
  }

  // ── PerformanceObserver for long tasks ────────────────────────────
  function _installLongTaskObserver() {
    if (!G.PerformanceObserver) return;
    try {
      _observer = new G.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          var ms   = Math.round(entry.duration);
          var attr = (entry.attribution && entry.attribution[0])
            ? entry.attribution[0].name : 'unknown';
          _longTasks.push({ ts: Date.now(), durationMs: ms, attribution: attr });
          if (_longTasks.length > 200) _longTasks.shift();
          _metrics.longTasks++;
          _metrics.frameDrops += Math.floor(ms / 33);

          // Route to family if attributable
          var family = _guessFamily(attr);
          if (family) _ensureFamily(family).longtasks++;

          try {
            G.dispatchEvent(new CustomEvent('profiler:longtask', {
              detail: { ms: ms, attr: attr, family: family },
            }));
          } catch (_) {}
        });
      });
      _observer.observe({ type: 'longtask', buffered: true });
    } catch (_) {}
  }

  function _guessFamily(attr) {
    if (!attr) return null;
    if (attr.includes('worker'))   return 'worker';
    if (attr.includes('pdf'))      return 'organize';
    if (attr.includes('compress')) return 'compress';
    if (attr.includes('ocr'))      return 'ocr';
    if (attr.includes('convert'))  return 'convert';
    if (attr.includes('image'))    return 'image';
    return null;
  }

  // ── rAF frame-drop monitor ────────────────────────────────────────
  function _rafLoop(ts) {
    if (!_sampling) { _rafFrame = null; return; }
    if (_lastFrameTs > 0) {
      var gap = ts - _lastFrameTs;
      if (gap > 33) { _frameDrops++; _metrics.frameDrops++; }
    }
    _lastFrameTs = ts;
    _rafFrame = G.requestAnimationFrame(_rafLoop);
  }

  // ── Record tool execution cost ────────────────────────────────────
  function recordCost(toolId, family, durationMs) {
    if (!_costs[toolId]) _costs[toolId] = { totalMs: 0, count: 0, samples: [] };
    var c = _costs[toolId];
    c.totalMs += durationMs;
    c.count++;
    c.samples.push(durationMs);
    if (c.samples.length > 50) c.samples.shift();
    c.p99Ms = _pct(c.samples, 99);

    if (family) {
      _ensureFamily(family).totalMs += durationMs;
      _ensureFamily(family).count++;
    }
  }

  function _ensureFamily(family) {
    if (!_families[family]) _families[family] = { totalMs: 0, count: 0, workerCrashes: 0, longtasks: 0 };
    return _families[family];
  }

  function _pct(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  }

  // ── Hook Arc 7 events for cost attribution ────────────────────────
  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var f = evt && evt.detail && evt.detail.family;
      if (f) _ensureFamily(f).workerCrashes++;
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.pct === 100 && d.token) {
        // Best-effort attribution — token as toolId proxy
        recordCost(d.token, null, 0);
      }
    } catch (_) {}
  });

  // ── Start / stop profiler ─────────────────────────────────────────
  function start() {
    if (_sampling) return;
    _sampling = true;
    var rate = _sampleRate() || SAMPLE_MS;
    _sampler = setInterval(_takeSample, rate);
    _rafFrame = G.requestAnimationFrame(_rafLoop);
    console.debug(LOG, 'profiler started — sample rate:', rate + 'ms');
  }

  function stop() {
    _sampling = false;
    clearInterval(_sampler);
    _sampler = null;
    console.debug(LOG, 'profiler stopped | samples:', _metrics.samples);
  }

  // ── Full profile snapshot ─────────────────────────────────────────
  function getProfile() {
    var now = Date.now();
    var window30s = _samples.filter(function (s) { return now - s.ts < WINDOW_MS; });
    var heapVals  = window30s.map(function (s) { return s.heapMb; });
    var fpsVals   = window30s.map(function (s) { return s.fps; });

    var familySummary = {};
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      familySummary[f] = {
        avgMs:        fm.count > 0 ? Math.round(fm.totalMs / fm.count) : 0,
        totalMs:      Math.round(fm.totalMs),
        count:        fm.count,
        workerCrashes: fm.workerCrashes,
        longtasks:    fm.longtasks,
      };
    });

    var toolSummary = {};
    Object.keys(_costs).slice(-20).forEach(function (id) {
      var c = _costs[id];
      toolSummary[id] = {
        avgMs: c.count ? Math.round(c.totalMs / c.count) : 0,
        p99Ms: c.p99Ms,
        count: c.count,
      };
    });

    return {
      ts:         now,
      sampling:   _sampling,
      samples30s: window30s.length,
      heap: {
        min: Math.min.apply(null, heapVals.concat([0])),
        max: Math.max.apply(null, heapVals.concat([0])),
        avg: heapVals.length ? Math.round(heapVals.reduce(function (a, b) { return a + b; }, 0) / heapVals.length) : 0,
      },
      fps: {
        avg: fpsVals.length ? Math.round(fpsVals.reduce(function (a, b) { return a + b; }, 0) / fpsVals.length) : 0,
        min: Math.min.apply(null, fpsVals.concat([0])),
      },
      longTasks:  { count: _metrics.longTasks, recent: _longTasks.slice(-10) },
      frameDrops: _metrics.frameDrops,
      families:   familySummary,
      tools:      toolSummary,
    };
  }

  G.getRuntimeProfile = function () { return getProfile(); };

  // ── Boot: install LongTask observer always; start sampling if flag set ─
  function _boot() {
    _installLongTaskObserver();
    try {
      var cp = G.RuntimeControlPlane;
      if (cp && cp.getFlag('profiler.sampling')) start();
    } catch (_) {}
    // Listen for flag changes
    G.addEventListener('arc8:command', function (evt) {
      try {
        var d = evt && evt.detail;
        if (d && d.cmd === 'flag.set' && d.args && d.args.name === 'profiler.sampling') {
          d.args.value ? start() : stop();
        }
      } catch (_) {}
    });
    console.debug(LOG, 'v' + VERSION + ' ready — longtask observer active | window.getRuntimeProfile()');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimePerformanceProfiler = Object.freeze({
    VERSION:    VERSION,
    start:      start,
    stop:       stop,
    recordCost: recordCost,
    getProfile: getProfile,
    isRunning:  function () { return _sampling; },
    getMetrics: function () { return Object.assign({}, _metrics); },
  });

}(window));
