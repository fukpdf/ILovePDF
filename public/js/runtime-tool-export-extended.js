(function (G) {
  'use strict';
  if (G.RuntimeToolExportExtended) return;

  var LOG = '[Arc13:ExportExtended]';

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn(LOG, 'download failed:', e.message || e);
    }
  }

  function _csvRow(cells) {
    return cells.map(function (c) {
      var s = String(c == null ? '' : c);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  function _ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  // ── Section collectors ───────────────────────────────────────────────────────
  function _collectSLA() {
    var sla = G.RuntimeToolSLA;
    return sla ? { violations: sla.getViolations(), metrics: sla.getMetrics(), defaults: sla.DEFAULTS } : null;
  }

  function _collectCircuitBreakers() {
    var cb = G.RuntimeToolCircuitBreaker;
    return cb ? { breakers: cb.getAll(), metrics: cb.getMetrics() } : null;
  }

  function _collectInsights() {
    var ins = G.RuntimeToolInsights;
    return ins ? { insights: ins.getInsights(), metrics: ins.getMetrics() } : null;
  }

  function _collectRankings() {
    var rank = G.RuntimeToolRanking;
    return rank ? { rankings: rank.getRankings(), metrics: rank.getMetrics() } : null;
  }

  function _collectPredictorHistory() {
    var pred = G.RuntimeToolPredictor;
    return pred && pred.getHistory ? { history: pred.getHistory() } : null;
  }

  function _collectDiscovery() {
    var disc = G.RuntimeToolDiscovery;
    return disc ? { sequences: disc.getSequences(), discovered: disc.getDiscovered(), metrics: disc.getMetrics() } : null;
  }

  function _collectAnomaly() {
    var anm = G.RuntimeToolAnomaly;
    return anm ? { anomalies: anm.getAnomalies(), metrics: anm.getMetrics() } : null;
  }

  function _collectLifecycle() {
    var lc = G.RuntimeToolLifecycle;
    return lc ? { states: lc.getAllStates(), metrics: lc.getMetrics() } : null;
  }

  function _collectPersistence() {
    var p = G.RuntimeToolPersistence;
    return p ? { metrics: p.getMetrics() } : null;
  }

  // ── Full JSON export ─────────────────────────────────────────────────────────
  function exportJSON(opts) {
    opts = opts || {};
    var payload = {
      exportedAt:      new Date().toISOString(),
      arc:             13,
      version:         '1.0',
      sla:             _collectSLA(),
      circuitBreakers: _collectCircuitBreakers(),
      insights:        _collectInsights(),
      rankings:        _collectRankings(),
      predictorHistory: _collectPredictorHistory(),
      discovery:       _collectDiscovery(),
      anomaly:         _collectAnomaly(),
      lifecycle:       _collectLifecycle(),
      persistence:     _collectPersistence(),
    };
    var json = JSON.stringify(payload, null, 2);
    if (!opts.noDownload) {
      _download('arc13-tool-intelligence-' + _ts() + '.json', json, 'application/json');
    }
    return json;
  }

  // ── SLA violations CSV ───────────────────────────────────────────────────────
  function exportSLACSV() {
    var sla = G.RuntimeToolSLA;
    if (!sla) { console.warn(LOG, 'RuntimeToolSLA not loaded'); return ''; }
    var viols = sla.getViolations();
    var header = _csvRow(['toolId', 'metric', 'percentile', 'actual', 'target', 'critical', 'ts']);
    var rows   = viols.map(function (v) {
      return _csvRow([v.toolId, v.metric, 'p' + v.percentile, v.actual, v.target, v.critical, new Date(v.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-sla-violations-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Rankings CSV ─────────────────────────────────────────────────────────────
  function exportRankingsCSV() {
    var rank = G.RuntimeToolRanking;
    if (!rank) { console.warn(LOG, 'RuntimeToolRanking not loaded'); return ''; }
    var rankings = rank.getRankings();
    var header   = _csvRow(['rank', 'toolId', 'score', 'usageScore', 'successScore', 'latencyScore', 'recoveryScore', 'successRate', 'launches', 'avgExecutionMs']);
    var rows     = rankings.map(function (r) {
      return _csvRow([r.rank, r.id, r.score, r.usageScore, r.successScore, r.latencyScore, r.recoveryScore, r.successRate, r.launches, r.avgExecutionMs]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-tool-rankings-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Insights CSV ─────────────────────────────────────────────────────────────
  function exportInsightsCSV() {
    var ins = G.RuntimeToolInsights;
    if (!ins) { console.warn(LOG, 'RuntimeToolInsights not loaded'); return ''; }
    var insights = ins.getInsights();
    var header   = _csvRow(['id', 'toolId', 'type', 'severity', 'message', 'ts']);
    var rows     = insights.map(function (i) {
      return _csvRow([i.id, i.toolId || '', i.type, i.severity, i.message, new Date(i.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-tool-insights-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Historical report (aggregated summary) ───────────────────────────────────
  function exportHistoricalReport() {
    var reg   = G.RuntimeToolRegistry;
    var rank  = G.RuntimeToolRanking;
    var sla   = G.RuntimeToolSLA;
    var cb    = G.RuntimeToolCircuitBreaker;
    var anm   = G.RuntimeToolAnomaly;
    var disc  = G.RuntimeToolDiscovery;
    var lc    = G.RuntimeToolLifecycle;

    var report = {
      generatedAt:  new Date().toISOString(),
      arc:          13,
      reportType:   'historical-summary',
      toolCount:    reg && reg.getAllTools ? reg.getAllTools().length : 0,
      topTools:     rank && rank.getTopN ? rank.getTopN(5) : [],
      slaMetrics:   sla && sla.getMetrics ? sla.getMetrics() : {},
      cbMetrics:    cb  && cb.getMetrics  ? cb.getMetrics()  : {},
      anomalyMetrics: anm && anm.getMetrics ? anm.getMetrics() : {},
      discoveredDeps: disc && disc.getDiscovered ? disc.getDiscovered().length : 0,
      lifecycleSummary: lc && lc.getAllStates ? (function () {
        var states = lc.getAllStates();
        var counts = {};
        Object.keys(states).forEach(function (id) {
          var s = states[id].state;
          counts[s] = (counts[s] || 0) + 1;
        });
        return counts;
      }()) : {},
    };

    var json = JSON.stringify(report, null, 2);
    _download('arc13-historical-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  G.RuntimeToolExportExtended = Object.freeze({
    exportJSON:             exportJSON,
    exportSLACSV:           exportSLACSV,
    exportRankingsCSV:      exportRankingsCSV,
    exportInsightsCSV:      exportInsightsCSV,
    exportHistoricalReport: exportHistoricalReport,
  });

}(typeof window !== 'undefined' ? window : this));
