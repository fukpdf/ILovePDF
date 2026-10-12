// RuntimeToolProfiler v1.0 — Arc 12 / Phase F / Enterprise Tool Intelligence Layer
// Per-tool execution profiling: startupMs, executionMs, memoryMb, workerUsage, thermalImpact.
// Computes p50/p90/p99 statistics per tool.
// Integrates: RuntimePerformanceProfiler, RuntimeToolRegistry, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolProfiler) return;

  var LOG = '[ToolProfiler]';

  // ── Per-tool sample storage ───────────────────────────────────────────────────
  // _data[toolId] = {
  //   startupMs:   [sample, ...]  (cap 100)
  //   executionMs: [sample, ...]  (cap 100)
  //   memoryMb:    [sample, ...]  (cap 100)
  //   workerCount: [sample, ...]  (cap 50)
  //   thermalImpact: [0-3, ...]   (cap 50)
  //   sessions:    N              (total profile sessions)
  // }
  var _data    = {};
  var _active  = {};   // toolId → { startTs, startHeap, startThermal }
  var _metrics = { begun: 0, completed: 0, lookups: 0 };
  var MAX_SAMP = 100;

  function _ensure(toolId) {
    if (!_data[toolId]) {
      _data[toolId] = {
        startupMs:     [],
        executionMs:   [],
        memoryMb:      [],
        workerCount:   [],
        thermalImpact: [],
        sessions:      0,
      };
    }
  }

  function _push(arr, val, cap) {
    arr.push(val);
    if (arr.length > cap) arr.shift();
  }

  // ── Percentile ────────────────────────────────────────────────────────────────
  function _pct(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  function _stats(arr) {
    if (!arr.length) return { p50: 0, p90: 0, p99: 0, avg: 0, min: 0, max: 0, n: 0 };
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var sum    = sorted.reduce(function (acc, v) { return acc + v; }, 0);
    return {
      p50: _pct(sorted, 50),
      p90: _pct(sorted, 90),
      p99: _pct(sorted, 99),
      avg: Math.round(sum / sorted.length),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      n:   sorted.length,
    };
  }

  // ── Begin profiling a tool ────────────────────────────────────────────────────
  function beginProfile(toolId) {
    if (!toolId) return;
    _ensure(toolId);
    var heap    = 0;
    var thermal = 0;
    try {
      if (performance && performance.memory) heap = performance.memory.usedJSHeapSize / (1024 * 1024);
    } catch (_) {}
    _active[toolId] = { startTs: performance.now(), startHeap: heap, startThermal: thermal };
    _metrics.begun++;
  }

  // ── End profiling ─────────────────────────────────────────────────────────────
  // opts: { startupMs?, workerCount?, thermalImpact? }
  function endProfile(toolId, opts) {
    if (!toolId) return;
    _ensure(toolId);
    var sess = _active[toolId];
    opts = opts || {};

    var execMs  = 0;
    var memMb   = 0;
    var heap2   = 0;

    if (sess) {
      execMs = Math.round(performance.now() - sess.startTs);
      try {
        if (performance && performance.memory) heap2 = performance.memory.usedJSHeapSize / (1024 * 1024);
        memMb = Math.max(0, heap2 - sess.startHeap);
      } catch (_) {}
      delete _active[toolId];
    }

    var d = _data[toolId];
    d.sessions++;
    _push(d.executionMs,   execMs,               MAX_SAMP);
    _push(d.memoryMb,      parseFloat(memMb.toFixed(2)), MAX_SAMP);
    if (opts.startupMs !== undefined)    _push(d.startupMs,     opts.startupMs,     MAX_SAMP);
    if (opts.workerCount !== undefined)  _push(d.workerCount,   opts.workerCount,   50);
    if (opts.thermalImpact !== undefined) _push(d.thermalImpact, opts.thermalImpact, 50);

    _metrics.completed++;

    // Forward to RuntimePerformanceProfiler
    try {
      var pp = G.RuntimePerformanceProfiler;
      if (pp && pp.recordCost) pp.recordCost(toolId, 'arc12', execMs);
    } catch (_) {}

    // Update registry
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.updateMetrics) {
        reg.updateMetrics(toolId, {
          executionMs: execMs,
          memoryMb:    parseFloat(memMb.toFixed(2)),
          startupMs:   opts.startupMs,
        });
      }
    } catch (_) {}

    _tel('profile', { toolId: toolId, execMs: execMs });
  }

  // ── Get stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    _metrics.lookups++;
    var d = _data[toolId];
    if (!d) return null;
    return {
      toolId:        toolId,
      sessions:      d.sessions,
      startupMs:     _stats(d.startupMs),
      executionMs:   _stats(d.executionMs),
      memoryMb:      _stats(d.memoryMb),
      workerCount:   _stats(d.workerCount),
      thermalImpact: _stats(d.thermalImpact),
    };
  }

  function getAllStats() {
    return Object.keys(_data).map(function (id) { return getStats(id); }).filter(Boolean);
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:profiler:' + event, data, ['arc12', 'profiler']);
    } catch (_) {}
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolProfiler = Object.freeze({
    beginProfile: beginProfile,
    endProfile:   endProfile,
    getStats:     getStats,
    getAllStats:   getAllStats,
    getMetrics:   function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
