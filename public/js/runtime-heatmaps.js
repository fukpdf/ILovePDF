(function (G) {
  'use strict';
  if (G.RuntimeHeatmaps) return;

  var LOG = '[Arc14:Heatmaps]';

  var LEVEL_GREEN  = 'GREEN';
  var LEVEL_YELLOW = 'YELLOW';
  var LEVEL_ORANGE = 'ORANGE';
  var LEVEL_RED    = 'RED';

  var REFRESH_MS = 15 * 1000;
  var _snapshots = [];   // ring buffer, cap 60
  var MAX_SNAPS  = 60;
  var _metrics   = { refreshes: 0, redEvents: 0 };

  function _level(val, warn, crit, fatal) {
    if (val >= fatal)  return LEVEL_RED;
    if (val >= crit)   return LEVEL_ORANGE;
    if (val >= warn)   return LEVEL_YELLOW;
    return LEVEL_GREEN;
  }

  // ── Collectors ───────────────────────────────────────────────────────────────
  function _collectMemory() {
    try {
      var perf = G.performance;
      if (perf && perf.memory) {
        var mb   = perf.memory.usedJSHeapSize / 1048576;
        var limMb = perf.memory.jsHeapSizeLimit / 1048576;
        var pct  = limMb > 0 ? (mb / limMb) * 100 : 0;
        return { valueMb: Math.round(mb), pct: Math.round(pct),
                 level: _level(pct, 40, 60, 80) };
      }
    } catch (_) {}
    return { valueMb: 0, pct: 0, level: LEVEL_GREEN };
  }

  function _collectWorkers() {
    try {
      var prof = G.RuntimePerformanceProfiler;
      if (prof && prof.getProfile) {
        var p = prof.getProfile();
        var cnt = (p && p.workers && p.workers.active) || 0;
        return { active: cnt, level: _level(cnt, 4, 8, 12) };
      }
    } catch (_) {}
    return { active: 0, level: LEVEL_GREEN };
  }

  function _collectThermal() {
    try {
      var profiler = G.RuntimeToolProfiler;
      if (profiler && profiler.getProfile) {
        var tools = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getAllTools ? G.RuntimeToolRegistry.getAllTools() : [];
        var maxThermal = 0;
        tools.forEach(function (t) {
          var p = profiler.getProfile(t.id);
          if (p && p.thermal && p.thermal.p90) maxThermal = Math.max(maxThermal, p.thermal.p90);
        });
        return { maxScore: Math.round(maxThermal), level: _level(maxThermal, 30, 60, 80) };
      }
    } catch (_) {}
    return { maxScore: 0, level: LEVEL_GREEN };
  }

  function _collectFailures() {
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.getAllTools) {
        var tools  = reg.getAllTools();
        var total  = 0, failures = 0;
        tools.forEach(function (t) {
          total    += (t.successes || 0) + (t.failures || 0);
          failures += (t.failures || 0);
        });
        var pct = total > 0 ? (failures / total) * 100 : 0;
        return { failures: failures, pct: Math.round(pct), level: _level(pct, 5, 15, 30) };
      }
    } catch (_) {}
    return { failures: 0, pct: 0, level: LEVEL_GREEN };
  }

  function _collectIncidents() {
    try {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.getMetrics) {
        var m = ic.getMetrics();
        var active = m.active || m.raised || 0;
        return { active: active, level: _level(active, 1, 3, 6) };
      }
    } catch (_) {}
    return { active: 0, level: LEVEL_GREEN };
  }

  function _collectSLA() {
    try {
      var sla = G.RuntimeToolSLA;
      if (sla && sla.getViolations) {
        var recent = sla.getViolations().filter(function (v) { return Date.now() - v.ts < 300000; });
        var critical = recent.filter(function (v) { return v.critical; }).length;
        return { violations: recent.length, critical: critical, level: _level(critical, 1, 3, 6) };
      }
    } catch (_) {}
    return { violations: 0, critical: 0, level: LEVEL_GREEN };
  }

  function _collectCircuitBreakers() {
    try {
      var cb = G.RuntimeToolCircuitBreaker;
      if (cb && cb.getAll) {
        var all  = cb.getAll();
        var open = Object.keys(all).filter(function (id) { return all[id].state === 'OPEN'; }).length;
        return { open: open, total: Object.keys(all).length, level: _level(open, 1, 3, 5) };
      }
    } catch (_) {}
    return { open: 0, total: 0, level: LEVEL_GREEN };
  }

  function _collectTools() {
    var cells = [];
    try {
      var reg = G.RuntimeToolRegistry;
      var hlth = G.RuntimeToolHealth;
      if (reg && reg.getAllTools) {
        reg.getAllTools().forEach(function (t) {
          var h = hlth && hlth.getHealth ? hlth.getHealth(t.id) : null;
          var level = h ? (h.level === 'EXCELLENT' ? LEVEL_GREEN : h.level === 'GOOD' ? LEVEL_YELLOW : h.level === 'DEGRADED' ? LEVEL_ORANGE : LEVEL_RED) : LEVEL_GREEN;
          cells.push({ toolId: t.id, score: h ? h.score : 100, level: level });
        });
      }
    } catch (_) {}
    return cells;
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────
  function refresh() {
    var snap = {
      ts:             Date.now(),
      memory:         _collectMemory(),
      workers:        _collectWorkers(),
      thermal:        _collectThermal(),
      failures:       _collectFailures(),
      incidents:      _collectIncidents(),
      sla:            _collectSLA(),
      circuitBreakers: _collectCircuitBreakers(),
    };
    _snapshots.push(snap);
    if (_snapshots.length > MAX_SNAPS) _snapshots.shift();
    _metrics.refreshes++;
    var hasRed = [snap.memory, snap.workers, snap.thermal, snap.failures, snap.incidents].some(function (s) { return s.level === LEVEL_RED; });
    if (hasRed) _metrics.redEvents++;
    try {
      G.dispatchEvent(new CustomEvent('arc14:heatmap-updated', { detail: { ts: snap.ts } }));
    } catch (_) {}
    return snap;
  }

  function getCurrent() {
    if (!_snapshots.length) return refresh();
    return _snapshots[_snapshots.length - 1];
  }

  function getHistory(limit) {
    var n = Math.min(limit || 20, _snapshots.length);
    return _snapshots.slice(-n);
  }

  function getToolHeatmap() { return _collectTools(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-refresh
  setInterval(refresh, REFRESH_MS);
  refresh();

  G.RuntimeHeatmaps = Object.freeze({
    refresh:         refresh,
    getCurrent:      getCurrent,
    getHistory:      getHistory,
    getToolHeatmap:  getToolHeatmap,
    getMetrics:      getMetrics,
    LEVELS: Object.freeze({ GREEN: LEVEL_GREEN, YELLOW: LEVEL_YELLOW, ORANGE: LEVEL_ORANGE, RED: LEVEL_RED }),
  });

}(typeof window !== 'undefined' ? window : this));
