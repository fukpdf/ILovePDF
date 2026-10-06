(function (G) {
  'use strict';
  if (G.RuntimeReports) return;

  var LOG = '[Arc14:Reports]';

  var _generated = [];   // report index (id, type, ts)
  var _seq       = 0;
  var MAX_REP    = 20;
  var _metrics   = { generated: 0 };

  function _ts() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

  function _id(type) { return 'rep-' + type + '-' + (++_seq); }

  function _register(type) {
    var entry = { id: _id(type), type: type, ts: Date.now() };
    _generated.unshift(entry);
    if (_generated.length > MAX_REP) _generated.pop();
    _metrics.generated++;
    return entry.id;
  }

  // ── Section builders ─────────────────────────────────────────────────────────
  function _sysHealth() {
    var cc = G.RuntimeCommandCenter;
    return cc && cc.getSystemHealth ? cc.getSystemHealth() : null;
  }

  function _incidentSection() {
    var ic = G.RuntimeIncidentCorrelation;
    return ic && ic.getMetrics ? ic.getMetrics() : null;
  }

  function _toolSection() {
    var reg  = G.RuntimeToolRegistry;
    var rank = G.RuntimeToolRanking;
    if (!reg || !reg.getAllTools) return null;
    var tools = reg.getAllTools();
    var top5  = rank && rank.getTopN ? rank.getTopN(5) : [];
    var total = tools.length;
    var active = tools.filter(function (t) { return t.launches > 0; }).length;
    return { total: total, active: active, top5: top5 };
  }

  function _slaSection() {
    var sla = G.RuntimeToolSLA;
    if (!sla) return null;
    var viols    = sla.getViolations();
    var critical = viols.filter(function (v) { return v.critical; }).length;
    return { totalViolations: viols.length, critical: critical, metrics: sla.getMetrics() };
  }

  function _cbSection() {
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb) return null;
    var all  = cb.getAll();
    var open = Object.keys(all).filter(function (id) { return all[id].state === 'OPEN'; });
    var ho   = Object.keys(all).filter(function (id) { return all[id].state === 'HALF_OPEN'; });
    return { open: open.length, halfOpen: ho.length, total: Object.keys(all).length, metrics: cb.getMetrics() };
  }

  function _anomalySection() {
    var anm = G.RuntimeToolAnomaly;
    if (!anm) return null;
    var all = anm.getAnomalies();
    return { total: all.length, critical: all.filter(function (a) { return a.severity === 'P1'; }).length, metrics: anm.getMetrics() };
  }

  function _insightSection() {
    var ins = G.RuntimeToolInsights;
    if (!ins) return null;
    return { items: ins.getInsights({ limit: 20 }), metrics: ins.getMetrics() };
  }

  function _recoverySection() {
    var rm = G.RuntimeRecoveryMemory;
    if (!rm || !rm.getMetrics) return null;
    return rm.getMetrics();
  }

  function _analyticsSection(windowId) {
    var analy = G.RuntimeCommandAnalytics;
    return analy && analy.getTrends ? analy.getTrends(windowId || '1h') : null;
  }

  function _heatmapSection() {
    var hm = G.RuntimeHeatmaps;
    return hm && hm.getCurrent ? hm.getCurrent() : null;
  }

  // ── Report generators ────────────────────────────────────────────────────────
  function generateHealthReport() {
    _register('health');
    return {
      type: 'health', generatedAt: new Date().toISOString(),
      systemHealth:   _sysHealth(),
      heatmap:        _heatmapSection(),
      tools:          _toolSection(),
      incidents:      _incidentSection(),
      recovery:       _recoverySection(),
    };
  }

  function generateIncidentReport() {
    _register('incidents');
    return {
      type: 'incidents', generatedAt: new Date().toISOString(),
      incidents:   _incidentSection(),
      anomalies:   _anomalySection(),
      circuitBreakers: _cbSection(),
      alerts: G.RuntimeAlerts ? G.RuntimeAlerts.getMetrics() : null,
    };
  }

  function generateSLAReport() {
    _register('sla');
    return {
      type: 'sla', generatedAt: new Date().toISOString(),
      sla:            _slaSection(),
      tools:          _toolSection(),
      analytics:      _analyticsSection('6h'),
    };
  }

  function generateToolReport() {
    _register('tools');
    var lc   = G.RuntimeToolLifecycle;
    var disc = G.RuntimeToolDiscovery;
    return {
      type: 'tools', generatedAt: new Date().toISOString(),
      tools:       _toolSection(),
      lifecycle:   lc && lc.getAllStates ? lc.getAllStates() : null,
      discovery:   disc ? { sequences: disc.getSequences().length, discovered: disc.getDiscovered().length } : null,
      insights:    _insightSection(),
    };
  }

  function generateRecoveryReport() {
    _register('recovery');
    return {
      type: 'recovery', generatedAt: new Date().toISOString(),
      recovery:    _recoverySection(),
      circuitBreakers: _cbSection(),
      insights:    _insightSection(),
    };
  }

  function generateDailyReport() {
    _register('daily');
    return {
      type: 'daily', generatedAt: new Date().toISOString(),
      systemHealth:    _sysHealth(),
      heatmap:         _heatmapSection(),
      tools:           _toolSection(),
      sla:             _slaSection(),
      incidents:       _incidentSection(),
      anomalies:       _anomalySection(),
      circuitBreakers: _cbSection(),
      insights:        _insightSection(),
      recovery:        _recoverySection(),
      analytics:       _analyticsSection('24h'),
    };
  }

  function generateWeeklyReport() {
    _register('weekly');
    return Object.assign(generateDailyReport(), {
      type: 'weekly',
      forecasts: G.RuntimeForecast ? G.RuntimeForecast.getForecasts() : [],
    });
  }

  // ── Export helpers ───────────────────────────────────────────────────────────
  function exportJSON(report) {
    try {
      var json = JSON.stringify(report, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = 'arc14-report-' + (report.type || 'unknown') + '-' + _ts() + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { console.warn(LOG, 'export error:', e.message); }
  }

  function getHistory() { return _generated.slice(); }
  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeReports = Object.freeze({
    generateHealthReport:   generateHealthReport,
    generateIncidentReport: generateIncidentReport,
    generateSLAReport:      generateSLAReport,
    generateToolReport:     generateToolReport,
    generateRecoveryReport: generateRecoveryReport,
    generateDailyReport:    generateDailyReport,
    generateWeeklyReport:   generateWeeklyReport,
    exportJSON:             exportJSON,
    getHistory:             getHistory,
    getMetrics:             getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
