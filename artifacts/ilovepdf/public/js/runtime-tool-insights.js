(function (G) {
  'use strict';
  if (G.RuntimeToolInsights) return;

  var LOG = '[Arc13:Insights]';

  var _insights   = [];   // { id, toolId, type, message, severity, ts }
  var _metrics    = { generated: 0, cleared: 0 };
  var _idSeq      = 0;
  var MAX_INSIGHTS = 50;
  var REFRESH_MS  = 2 * 60 * 1000;   // generate every 2 min

  // Baselines for trend detection
  var _prevStartup = {};   // toolId → prev p90 startupMs

  function _id() { return 'ins-' + (++_idSeq); }

  function _add(toolId, type, message, severity) {
    severity = severity || 'info';
    var ins = { id: _id(), toolId: toolId || null, type: type, message: message, severity: severity, ts: Date.now() };
    _insights.unshift(ins);
    if (_insights.length > MAX_INSIGHTS) _insights.pop();
    _metrics.generated++;
    console.debug(LOG, '[' + severity + ']', message);
    try {
      G.dispatchEvent(new CustomEvent('arc13:insight-generated', { detail: ins }));
    } catch (_) {}
    return ins;
  }

  // ── Generators ────────────────────────────────────────────────────────────────

  function _insightsFromAnomalies() {
    var anm = G.RuntimeToolAnomaly;
    if (!anm || !anm.getAnomalies) return;
    var recent = anm.getAnomalies().filter(function (a) { return Date.now() - a.ts < REFRESH_MS * 2; });
    var seen   = {};
    recent.forEach(function (a) {
      var key = a.toolId + ':' + a.type;
      if (seen[key]) return;
      seen[key] = true;
      var pct  = a.baseline > 0 ? Math.round((a.actual / a.baseline - 1) * 100) : 0;
      var msg;
      if (a.type === 'startup')       msg = a.toolId + ' startup time increased ' + pct + '% above baseline.';
      else if (a.type === 'memory')   msg = a.toolId + ' memory usage spiked ' + pct + '% above normal.';
      else if (a.type === 'thermal')  msg = a.toolId + ' thermal score elevated ' + pct + '% — consider cooling interval.';
      else if (a.type === 'failure-spike') msg = a.toolId + ' failure rate spiked ' + pct + '% — check bundle health.';
      else msg = a.toolId + ' anomaly detected: ' + a.type + '.';
      _add(a.toolId, 'anomaly', msg, a.severity === 'P1' ? 'critical' : 'warning');
    });
  }

  function _insightsFromCircuitBreakers() {
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb || !cb.getAll) return;
    var all = cb.getAll();
    Object.keys(all).forEach(function (id) {
      var b = all[id];
      if (b.state === 'OPEN') {
        _add(id, 'circuit-breaker', id + ' circuit breaker is OPEN — executions are being blocked.', 'critical');
      } else if (b.state === 'HALF_OPEN') {
        _add(id, 'circuit-breaker', id + ' circuit breaker is in HALF_OPEN state — monitoring recovery.', 'warning');
      }
    });
  }

  function _insightsFromSLA() {
    var sla = G.RuntimeToolSLA;
    if (!sla || !sla.getViolations) return;
    var recent = sla.getViolations().filter(function (v) { return Date.now() - v.ts < REFRESH_MS * 2 && v.critical; });
    var seen   = {};
    recent.forEach(function (v) {
      var key = v.toolId + ':' + v.metric;
      if (seen[key]) return;
      seen[key] = true;
      _add(v.toolId, 'sla', v.toolId + ' critically breached ' + v.metric + ' SLA: ' +
        v.actual.toFixed(0) + ' vs target ' + v.target + '.', 'critical');
    });
  }

  function _insightsFromLifecycle() {
    var lc = G.RuntimeToolLifecycle;
    if (!lc || !lc.getAllStates) return;
    var states = lc.getAllStates();
    Object.keys(states).forEach(function (id) {
      var s = states[id];
      if (s.state === 'DORMANT' && s.transitions.length > 0) {
        var last = s.transitions[s.transitions.length - 1];
        if (last && last.to === 'DORMANT' && Date.now() - last.ts < REFRESH_MS * 2) {
          _add(id, 'lifecycle', id + ' tool is becoming dormant — consider advisory unload or deprecation.', 'info');
        }
      }
      if (s.state === 'RETIRED') {
        _add(id, 'lifecycle', id + ' tool is RETIRED (no use in 90+ days) — may be removed safely.', 'warning');
      }
    });
  }

  function _insightsFromRanking() {
    var rank = G.RuntimeToolRanking;
    if (!rank || !rank.getTopN) return;
    var top = rank.getTopN(3);
    if (!top.length) return;
    var names = top.map(function (t) { return t.id; }).join(', ');
    _add(null, 'ranking', 'Top tools by enterprise score: ' + names + '. Consider ensuring these bundles are preloaded.', 'info');
  }

  function _insightsFromOptimizer() {
    var opt = G.RuntimeToolOptimizer;
    if (!opt || !opt.getMetrics) return;
    var m = opt.getMetrics();
    if (m.savingsMs > 5000) {
      _add(null, 'optimizer', 'Preloading hot tools has saved ~' + Math.round(m.savingsMs / 1000) + 's of startup latency this session.', 'info');
    }
    if (m.dormantAdvisories > 0) {
      _add(null, 'optimizer', m.dormantAdvisories + ' tools are candidates for advisory unload to free memory.', 'info');
    }
  }

  function _insightsFromProfiler() {
    var profiler = G.RuntimeToolProfiler;
    var reg      = G.RuntimeToolRegistry;
    if (!profiler || !reg) return;
    reg.getAllTools().forEach(function (t) {
      var p = profiler.getProfile && profiler.getProfile(t.id);
      if (!p || !p.startupMs) return;
      var prev = _prevStartup[t.id];
      if (prev && p.startupMs.p90 > 0 && prev > 0) {
        var pct = Math.round((p.startupMs.p90 / prev - 1) * 100);
        if (pct >= 40) {
          _add(t.id, 'startup-trend',
            t.id + ' startup time increased ' + pct + '% since last check — bundle may need preloading.', 'warning');
        }
      }
      if (p.startupMs.p90 > 0) _prevStartup[t.id] = p.startupMs.p90;
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function generateInsights() {
    _insightsFromAnomalies();
    _insightsFromCircuitBreakers();
    _insightsFromSLA();
    _insightsFromLifecycle();
    _insightsFromRanking();
    _insightsFromOptimizer();
    _insightsFromProfiler();
  }

  function getInsights(opts) {
    opts = opts || {};
    var result = _insights.slice();
    if (opts.toolId)   result = result.filter(function (i) { return i.toolId === opts.toolId; });
    if (opts.severity) result = result.filter(function (i) { return i.severity === opts.severity; });
    if (opts.type)     result = result.filter(function (i) { return i.type === opts.type; });
    return result;
  }

  function clearInsights(toolId) {
    var before = _insights.length;
    if (toolId) {
      for (var i = _insights.length - 1; i >= 0; i--) {
        if (_insights[i].toolId === toolId) { _insights.splice(i, 1); }
      }
    } else {
      _insights.length = 0;
    }
    _metrics.cleared += before - _insights.length;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-generate
  setTimeout(function _tick() {
    generateInsights();
    setTimeout(_tick, REFRESH_MS);
  }, REFRESH_MS);

  G.RuntimeToolInsights = Object.freeze({
    generateInsights: generateInsights,
    getInsights:      getInsights,
    clearInsights:    clearInsights,
    getMetrics:       getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
