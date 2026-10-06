(function (G) {
  'use strict';
  if (G.RuntimeToolAnomaly) return;

  var LOG = '[Arc13:Anomaly]';

  // Multiplier thresholds
  var ANOMALY_MULT       = 2.0;   // 2× baseline = anomaly
  var CRITICAL_MULT      = 3.0;   // 3× baseline = critical anomaly
  var FAILURE_SPIKE_MULT = 3.0;   // failure rate 3× normal = spike
  var CHECK_MS           = 60 * 1000;   // check every 60s

  // Per-tool baselines built from first N samples
  var _baselines = {};   // toolId → { startupMs, memoryMb, thermal, failureRate }
  var _anomalies = [];   // active/recent anomalies (capped at 100)
  var _metrics   = { detected: 0, critical: 0, cleared: 0 };
  var MAX_ANOMS  = 100;

  function _baseline(toolId) {
    if (!_baselines[toolId]) _baselines[toolId] = { startupMs: 0, memoryMb: 0, thermal: 0, failureRate: 0, samples: 0 };
    return _baselines[toolId];
  }

  function _dispatch(event, detail) {
    try { G.dispatchEvent(new CustomEvent(event, { detail: detail })); } catch (_) {}
  }

  function _raiseIncident(severity, toolId, message) {
    try {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.raise) ic.raise({ severity: severity, source: 'arc13:anomaly', message: message });
    } catch (_) {}
  }

  function _record(toolId, type, metric, actual, baseline, severity) {
    var anom = {
      toolId:   toolId,
      type:     type,       // 'startup' | 'memory' | 'thermal' | 'failure-spike'
      metric:   metric,
      actual:   actual,
      baseline: baseline,
      ratio:    baseline > 0 ? actual / baseline : 0,
      severity: severity,   // 'P1' | 'P2'
      ts:       Date.now(),
    };
    _anomalies.push(anom);
    if (_anomalies.length > MAX_ANOMS) _anomalies.shift();
    _metrics.detected++;
    if (severity === 'P1') _metrics.critical++;
    console.warn(LOG, severity, toolId, type, ':', actual.toFixed(0), 'vs baseline', baseline.toFixed(0));
    _dispatch('arc13:anomaly-detected', anom);
    _raiseIncident(severity, toolId, toolId + ' anomaly — ' + type + ': ' + actual.toFixed(0) + ' (baseline ' + baseline.toFixed(0) + ')');
  }

  // ── Check one tool ────────────────────────────────────────────────────────────
  function checkTool(toolId) {
    var profiler = G.RuntimeToolProfiler;
    var reg      = G.RuntimeToolRegistry;
    if (!profiler || !reg) return;

    var profile = profiler.getProfile && profiler.getProfile(toolId);
    var tool    = reg.getTool && reg.getTool(toolId);
    if (!profile || !tool) return;

    var b = _baseline(toolId);

    // Build/update baseline on first few samples (warm-up: 3 cycles)
    if (b.samples < 3) {
      if (profile.startupMs  && profile.startupMs.p50)   b.startupMs   = profile.startupMs.p50;
      if (profile.memoryMb   && profile.memoryMb.p50)    b.memoryMb    = profile.memoryMb.p50;
      if (profile.thermal    && profile.thermal.p50)      b.thermal     = profile.thermal.p50;
      var total = (tool.successes || 0) + (tool.failures || 0);
      b.failureRate = total > 0 ? (tool.failures / total) : 0;
      b.samples++;
      return;
    }

    // Startup anomaly
    if (b.startupMs > 0 && profile.startupMs && profile.startupMs.p90) {
      var ratio = profile.startupMs.p90 / b.startupMs;
      if (ratio >= CRITICAL_MULT) _record(toolId, 'startup', 'startupMs', profile.startupMs.p90, b.startupMs, 'P1');
      else if (ratio >= ANOMALY_MULT) _record(toolId, 'startup', 'startupMs', profile.startupMs.p90, b.startupMs, 'P2');
    }

    // Memory anomaly
    if (b.memoryMb > 0 && profile.memoryMb && profile.memoryMb.p90) {
      var mRatio = profile.memoryMb.p90 / b.memoryMb;
      if (mRatio >= CRITICAL_MULT) _record(toolId, 'memory', 'memoryMb', profile.memoryMb.p90, b.memoryMb, 'P1');
      else if (mRatio >= ANOMALY_MULT) _record(toolId, 'memory', 'memoryMb', profile.memoryMb.p90, b.memoryMb, 'P2');
    }

    // Thermal anomaly
    if (b.thermal > 0 && profile.thermal && profile.thermal.p90) {
      var tRatio = profile.thermal.p90 / b.thermal;
      if (tRatio >= CRITICAL_MULT) _record(toolId, 'thermal', 'thermal', profile.thermal.p90, b.thermal, 'P1');
      else if (tRatio >= ANOMALY_MULT) _record(toolId, 'thermal', 'thermal', profile.thermal.p90, b.thermal, 'P2');
    }

    // Failure spike
    var totalNow  = (tool.successes || 0) + (tool.failures || 0);
    var failNow   = totalNow > 0 ? (tool.failures / totalNow) : 0;
    if (b.failureRate > 0 && failNow / b.failureRate >= FAILURE_SPIKE_MULT && totalNow > 10) {
      _record(toolId, 'failure-spike', 'failureRate',
        Math.round(failNow * 100), Math.round(b.failureRate * 100), 'P1');
    }
  }

  function checkAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    reg.getAllTools().forEach(function (t) { checkTool(t.id); });
  }

  function getAnomalies(toolId) {
    if (toolId) return _anomalies.filter(function (a) { return a.toolId === toolId; });
    return _anomalies.slice();
  }

  function clearAnomalies(toolId) {
    var before = _anomalies.length;
    if (toolId) {
      for (var i = _anomalies.length - 1; i >= 0; i--) {
        if (_anomalies[i].toolId === toolId) _anomalies.splice(i, 1);
      }
    } else {
      _anomalies.length = 0;
    }
    _metrics.cleared += before - _anomalies.length;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-check
  setTimeout(function _tick() {
    checkAll();
    setTimeout(_tick, CHECK_MS);
  }, CHECK_MS);

  G.RuntimeToolAnomaly = Object.freeze({
    checkTool:    checkTool,
    checkAll:     checkAll,
    getAnomalies: getAnomalies,
    clearAnomalies: clearAnomalies,
    getMetrics:   getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
