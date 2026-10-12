(function (G) {
  'use strict';
  if (G.RuntimeDebugExport) return;

  var VERSION     = '10.0.0';
  var LOG         = '[DebugExport]';
  var RATE_LIMIT  = 10; // max exports per minute

  // ── JSON export ───────────────────────────────────────────────────────────────
  function exportJson(data, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('json-export', RATE_LIMIT)) {
      console.warn(LOG, 'export rate limit exceeded');
      return null;
    }
    try {
      var cleaned = sec ? sec.redact(data) : data;
      var json    = JSON.stringify(cleaned, null, 2);
      var blob    = new Blob([json], { type: 'application/json' });
      var url     = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-export') + '.json');
      return url;
    } catch (e) {
      console.warn(LOG, 'export failed:', e.message);
      return null;
    }
  }

  // ── Text/log export ───────────────────────────────────────────────────────────
  function exportText(lines, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('text-export', RATE_LIMIT)) return null;
    try {
      var content = Array.isArray(lines) ? lines.join('\n') : String(lines);
      var blob    = new Blob([content], { type: 'text/plain' });
      var url     = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-log') + '.txt');
      return url;
    } catch (e) {
      console.warn(LOG, 'text export failed:', e.message);
      return null;
    }
  }

  // ── CSV export ────────────────────────────────────────────────────────────────
  function exportCsv(rows, headers, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('csv-export', RATE_LIMIT)) return null;
    try {
      var lines = [];
      if (headers) lines.push(headers.join(','));
      rows.forEach(function (row) {
        lines.push(row.map(function (c) {
          var s = String(c === null || c === undefined ? '' : c);
          return s.indexOf(',') !== -1 || s.indexOf('"') !== -1
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
        }).join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var url  = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-data') + '.csv');
      return url;
    } catch (e) {
      console.warn(LOG, 'csv export failed:', e.message);
      return null;
    }
  }

  // ── Full dashboard snapshot ───────────────────────────────────────────────────
  function exportDashboardSnapshot() {
    var snap = {
      ts:         Date.now(),
      buildId:    (G.RuntimeDebugState && G.RuntimeDebugState.get('buildId')) || '—',
      incidents:  G.RuntimeIncidentCenter  ? G.RuntimeIncidentCenter.query({}) : [],
      timeline:   G.RuntimeEventTimeline   ? G.RuntimeEventTimeline.search({})  : [],
      blackbox:   G.RuntimeBlackbox        ? G.RuntimeBlackbox.getMetrics()      : {},
      healing:    G.RuntimeAutonomousHealing ? G.RuntimeAutonomousHealing.getState() : {},
      governance: G.RuntimeGovernance      ? G.RuntimeGovernance.getViolations()  : [],
      recovery:   G.RuntimeRecoveryOrchestrator ? G.RuntimeRecoveryOrchestrator.getHistory() : [],
      profiler:   G.RuntimePerformanceProfiler  ? G.RuntimePerformanceProfiler.getMetrics()  : {},
      stability:  G.RuntimeSessionStability     ? G.RuntimeSessionStability.getState()       : {},
    };
    return exportJson(snap, 'dashboard-snapshot-' + Date.now().toString(36));
  }

  // ── Download trigger ──────────────────────────────────────────────────────────
  function _trigger(url, name) {
    var a = document.createElement('a');
    a.href     = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  G.RuntimeDebugExport = Object.freeze({
    VERSION:                VERSION,
    exportJson:             exportJson,
    exportText:             exportText,
    exportCsv:              exportCsv,
    exportDashboardSnapshot: exportDashboardSnapshot,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — export rate-limited at', RATE_LIMIT, 'ops/min');

}(window));
