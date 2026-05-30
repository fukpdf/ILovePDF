(function (G) {
  'use strict';
  if (G.RuntimeForecast) return;

  var LOG = '[Arc14:Forecast]';

  var HORIZON_MS = 30 * 60 * 1000;   // 30-minute forecast horizon
  var _forecasts = [];
  var _metrics   = { generated: 0, accurate: 0 };
  var MAX_F      = 50;
  var GEN_MS     = 5 * 60 * 1000;   // generate every 5 min

  function _id() { return 'fcast-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

  function _add(type, message, confidence, horizon, severity) {
    var f = {
      id:         _id(),
      type:       type,
      message:    message,
      confidence: confidence,   // 0–100
      horizonMs:  horizon || HORIZON_MS,
      expectedAt: Date.now() + (horizon || HORIZON_MS),
      severity:   severity || 'info',
      ts:         Date.now(),
    };
    _forecasts.unshift(f);
    if (_forecasts.length > MAX_F) _forecasts.pop();
    _metrics.generated++;
    try {
      G.dispatchEvent(new CustomEvent('arc14:forecast-generated', { detail: f }));
    } catch (_) {}
    return f;
  }

  // ── Forecast generators ──────────────────────────────────────────────────────

  function _forecastIncidents() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('15m');
    if (!t || !t.incidents) return;
    var slope = t.incidents.trend;  // per minute
    var avg   = t.incidents.avg;
    if (slope > 0.1 && avg > 0) {
      var est = avg + slope * 30;  // +30 min
      var conf = Math.min(85, Math.round(slope * 100));
      _add('incidents', 'Incident count trending up (' + slope.toFixed(2) + '/min) — expect ~' + est.toFixed(0) + ' incidents in 30 min.', conf, HORIZON_MS, 'warning');
    }
  }

  function _forecastMemoryPressure() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('15m');
    if (!t || !t.memory) return;
    var slope = t.memory.trend;
    var avg   = t.memory.avg;
    if (slope > 0.5 && avg > 30) {
      var timeToWarn = (60 - avg) / slope;  // minutes to reach 60% threshold
      if (timeToWarn < 60 && timeToWarn > 0) {
        _add('memory', 'Memory at ' + avg.toFixed(0) + '% with slope ' + slope.toFixed(2) + '%/min — may reach warning level in ~' + timeToWarn.toFixed(0) + ' min.', 70, timeToWarn * 60000, 'warning');
      }
    }
  }

  function _forecastThermalSpikes() {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return;
    var curr = hm.getCurrent();
    if (!curr || !curr.thermal) return;
    if (curr.thermal.level === 'ORANGE') {
      _add('thermal', 'Thermal score in ORANGE (' + curr.thermal.maxScore + '). Sustained heavy workloads may cause RED spike soon.', 60, HORIZON_MS, 'warning');
    }
  }

  function _forecastSLABreaches() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('1h');
    if (!t || !t.slaViolations) return;
    if (t.slaViolations.trend > 0.05) {
      _add('sla', 'SLA violations trending up — current average: ' + t.slaViolations.avg.toFixed(1) + '/sample. Monitor critical tool performance.', 65, HORIZON_MS, 'warning');
    }
  }

  function _forecastCircuitOpenings() {
    var cb  = G.RuntimeToolCircuitBreaker;
    var reg = G.RuntimeToolRegistry;
    if (!cb || !reg) return;
    var all   = cb.getAll();
    var tools = reg.getAllTools ? reg.getAllTools() : [];
    var risk  = tools.filter(function (t) {
      var b = all[t.id];
      if (!b) return false;
      var total = (t.successes || 0) + (t.failures || 0);
      var rate  = total > 5 ? (t.failures / total) : 0;
      return rate > 0.10 && b.state === 'CLOSED';
    });
    if (risk.length > 0) {
      _add('circuit-breaker', risk.length + ' tool(s) have >10% failure rate and CLOSED breakers (' + risk.map(function (t) { return t.id; }).slice(0, 3).join(', ') + ') — may trip soon.', 75, HORIZON_MS, 'critical');
    }
  }

  function _forecastToolDegradation() {
    var ins = G.RuntimeToolInsights;
    if (!ins) return;
    var critical = ins.getInsights({ severity: 'critical' });
    if (critical.length > 3) {
      _add('tool-degradation', critical.length + ' critical tool insights active — system degradation likely if unaddressed.', 80, HORIZON_MS, 'critical');
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function generateForecasts() {
    _forecastIncidents();
    _forecastMemoryPressure();
    _forecastThermalSpikes();
    _forecastSLABreaches();
    _forecastCircuitOpenings();
    _forecastToolDegradation();
  }

  function getForecasts(opts) {
    opts = opts || {};
    var result = _forecasts.slice();
    if (opts.type)     result = result.filter(function (f) { return f.type === opts.type; });
    if (opts.severity) result = result.filter(function (f) { return f.severity === opts.severity; });
    if (opts.limit)    result = result.slice(0, opts.limit);
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-generate
  setTimeout(function _tick() {
    generateForecasts();
    setTimeout(_tick, GEN_MS);
  }, GEN_MS);

  G.RuntimeForecast = Object.freeze({
    generateForecasts: generateForecasts,
    getForecasts:      getForecasts,
    getMetrics:        getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
