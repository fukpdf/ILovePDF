(function (G) {
  'use strict';
  if (G.RuntimeCommandExport) return;

  var LOG = '[Arc14:CommandExport]';

  function _ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  function _download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { console.warn(LOG, 'download failed:', e.message); }
  }

  function _csvRow(cells) {
    return cells.map(function (c) {
      var s = String(c == null ? '' : c);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  // ── Topology export ──────────────────────────────────────────────────────────
  function exportTopology() {
    var topo = G.RuntimeTopology;
    if (!topo) { console.warn(LOG, 'RuntimeTopology not loaded'); return ''; }
    var graph = topo.getGraph();
    var json  = JSON.stringify({ arc: 14, type: 'topology', exportedAt: new Date().toISOString(), graph: graph }, null, 2);
    _download('arc14-topology-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Heatmap export ───────────────────────────────────────────────────────────
  function exportHeatmaps(limit) {
    var hm = G.RuntimeHeatmaps;
    if (!hm) { console.warn(LOG, 'RuntimeHeatmaps not loaded'); return ''; }
    var history = hm.getHistory(limit || 20);
    var json = JSON.stringify({ arc: 14, type: 'heatmaps', exportedAt: new Date().toISOString(), snapshots: history }, null, 2);
    _download('arc14-heatmaps-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Heatmap CSV ──────────────────────────────────────────────────────────────
  function exportHeatmapsCSV(limit) {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return '';
    var history = hm.getHistory(limit || 20);
    var header  = _csvRow(['ts', 'memory_pct', 'memory_level', 'workers_active', 'thermal_score', 'thermal_level', 'failures_pct', 'incidents_active', 'sla_violations', 'cb_open']);
    var rows = history.map(function (s) {
      return _csvRow([
        new Date(s.ts).toISOString(),
        s.memory ? s.memory.pct : '',
        s.memory ? s.memory.level : '',
        s.workers ? s.workers.active : '',
        s.thermal ? s.thermal.maxScore : '',
        s.thermal ? s.thermal.level : '',
        s.failures ? s.failures.pct : '',
        s.incidents ? s.incidents.active : '',
        s.sla ? s.sla.violations : '',
        s.circuitBreakers ? s.circuitBreakers.open : '',
      ]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc14-heatmaps-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Alerts export ────────────────────────────────────────────────────────────
  function exportAlerts() {
    var alt = G.RuntimeAlerts;
    if (!alt) { console.warn(LOG, 'RuntimeAlerts not loaded'); return ''; }
    var alerts = alt.getAlerts();
    var json   = JSON.stringify({ arc: 14, type: 'alerts', exportedAt: new Date().toISOString(), alerts: alerts, metrics: alt.getMetrics() }, null, 2);
    _download('arc14-alerts-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  function exportAlertsCSV() {
    var alt = G.RuntimeAlerts;
    if (!alt) return '';
    var alerts = alt.getAlerts();
    var header = _csvRow(['id', 'level', 'source', 'toolId', 'message', 'acknowledged', 'ts']);
    var rows   = alerts.map(function (a) {
      return _csvRow([a.id, a.level, a.source, a.toolId || '', a.message, a.acknowledged, new Date(a.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc14-alerts-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Reports export ───────────────────────────────────────────────────────────
  function exportDailyReport() {
    var rep  = G.RuntimeReports;
    if (!rep) { console.warn(LOG, 'RuntimeReports not loaded'); return ''; }
    var report = rep.generateDailyReport();
    var json   = JSON.stringify(report, null, 2);
    _download('arc14-daily-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  function exportWeeklyReport() {
    var rep = G.RuntimeReports;
    if (!rep) return '';
    var json = JSON.stringify(rep.generateWeeklyReport(), null, 2);
    _download('arc14-weekly-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Forecasts export ─────────────────────────────────────────────────────────
  function exportForecasts() {
    var fc  = G.RuntimeForecast;
    if (!fc) { console.warn(LOG, 'RuntimeForecast not loaded'); return ''; }
    var json = JSON.stringify({ arc: 14, type: 'forecasts', exportedAt: new Date().toISOString(),
      forecasts: fc.getForecasts(), metrics: fc.getMetrics() }, null, 2);
    _download('arc14-forecasts-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Fleet state export ───────────────────────────────────────────────────────
  function exportFleetState() {
    var fm  = G.RuntimeFleetManager;
    var cc  = G.RuntimeCommandCenter;
    if (!fm) { console.warn(LOG, 'RuntimeFleetManager not loaded'); return ''; }
    var json = JSON.stringify({
      arc: 14, type: 'fleet-state', exportedAt: new Date().toISOString(),
      fleet:       fm.getFleetStatus(),
      systemHealth: cc && cc.getSystemHealth ? cc.getSystemHealth() : null,
      metrics:     fm.getMetrics(),
    }, null, 2);
    _download('arc14-fleet-state-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Full system snapshot ─────────────────────────────────────────────────────
  function exportFullSnapshot() {
    var cc   = G.RuntimeCommandCenter;
    var topo = G.RuntimeTopology;
    var hm   = G.RuntimeHeatmaps;
    var alt  = G.RuntimeAlerts;
    var fc   = G.RuntimeForecast;
    var rep  = G.RuntimeReports;
    var fm   = G.RuntimeFleetManager;
    var payload = {
      arc: 14, type: 'full-snapshot', exportedAt: new Date().toISOString(),
      systemHealth:  cc  && cc.getSystemHealth   ? cc.getSystemHealth()    : null,
      topology:      topo && topo.getGraph        ? topo.getGraph()         : null,
      clusterHealth: topo && topo.getClusterHealth ? topo.getClusterHealth() : null,
      heatmapCurrent: hm && hm.getCurrent        ? hm.getCurrent()         : null,
      alerts:        alt  && alt.getAlerts        ? alt.getAlerts({ limit: 50 }) : null,
      forecasts:     fc   && fc.getForecasts      ? fc.getForecasts()       : null,
      fleetState:    fm   && fm.getFleetStatus    ? fm.getFleetStatus()     : null,
      dailyReport:   rep  && rep.generateDailyReport ? rep.generateDailyReport() : null,
    };
    var json = JSON.stringify(payload, null, 2);
    _download('arc14-full-snapshot-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  G.RuntimeCommandExport = Object.freeze({
    exportTopology:    exportTopology,
    exportHeatmaps:    exportHeatmaps,
    exportHeatmapsCSV: exportHeatmapsCSV,
    exportAlerts:      exportAlerts,
    exportAlertsCSV:   exportAlertsCSV,
    exportDailyReport: exportDailyReport,
    exportWeeklyReport: exportWeeklyReport,
    exportForecasts:   exportForecasts,
    exportFleetState:  exportFleetState,
    exportFullSnapshot: exportFullSnapshot,
  });

}(typeof window !== 'undefined' ? window : this));
