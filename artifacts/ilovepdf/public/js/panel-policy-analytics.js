(function (G) {
  'use strict';
  if (G.PanelPolicyAnalytics) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var pa = G.RuntimePolicyAnalytics;
    if (!pa) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimePolicyAnalytics not loaded</p>'; return; }

    var snap     = pa.getSnapshot();
    var m        = pa.getMetrics();
    var records  = pa.getRecords(20);

    var successRate  = snap && snap.recentRate ? snap.recentRate.success  : 0;
    var failureRate  = snap && snap.recentRate ? snap.recentRate.failure  : 0;
    var rollbackRate = snap && snap.recentRate ? snap.recentRate.rollback : 0;

    var sColor  = successRate  >= 80 ? '#2ecc71' : successRate  >= 60 ? '#f39c12' : '#e74c3c';
    var fColor  = failureRate  > 20  ? '#e74c3c' : failureRate  > 10  ? '#f39c12' : '#2ecc71';
    var rbColor = rollbackRate > 10  ? '#e67e22' : '#888';

    function _rankRows(list, label) {
      if (!list || !list.length) return '<tr><td colspan="4" style="padding:4px;color:#555;font-size:11px">No data</td></tr>';
      return list.map(function (r, i) {
        return '<tr style="border-bottom:1px solid #1a1a2e">' +
          '<td style="padding:2px 6px;font-size:11px;color:#888">#' + (i + 1) + '</td>' +
          '<td style="padding:2px 8px;font-size:11px">' + r.policyId + '</td>' +
          '<td style="padding:2px 6px;font-size:11px;color:#3498db">' + r.total + '</td>' +
          '<td style="padding:2px 6px;font-size:10px;color:#2ecc71">' + r.successRate + '%</td>' +
          '</tr>';
      }).join('');
    }

    var recRows = records.map(function (r) {
      var sCol = r.status === 'success' ? '#2ecc71' : r.status === 'rollback' ? '#e67e22' : '#e74c3c';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + r.status + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + r.policyId + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#888">' + r.action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + new Date(r.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var rankings = snap && snap.rankings ? snap.rankings : {};

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Tracked', m.total || 0, '#3498db') +
        _kpi('Success Rate', successRate + '%', sColor) +
        _kpi('Failure Rate', failureRate + '%', fColor) +
        _kpi('Rollback Rate', rollbackRate + '%', rbColor) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Successes', m.tracked > 0 ? Math.round(m.successes || 0) : 0, '#2ecc71') +
        _kpi('Failures', m.tracked > 0 ? Math.round(m.failures  || 0) : 0, '#e74c3c') +
        _kpi('Rollbacks', m.tracked > 0 ? Math.round(m.rollbacks || 0) : 0, '#e67e22') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">' +
        '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px;font-size:11px">Top by Executions</summary>' +
        '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>#</th><th style="text-align:left">Policy</th><th>Runs</th><th>S%</th></tr></thead>' +
        '<tbody>' + _rankRows(rankings.byExecutions, 'executions') + '</tbody></table></details>' +
        '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px;font-size:11px">Top by Failure</summary>' +
        '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>#</th><th style="text-align:left">Policy</th><th>Runs</th><th>S%</th></tr></thead>' +
        '<tbody>' + _rankRows(rankings.byFailure, 'failure') + '</tbody></table></details>' +
      '</div>' +
      '<details><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Executions (' + records.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Policy</th><th>Action</th><th>Time</th></tr></thead>' +
      '<tbody>' + recRows + '</tbody></table></details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'analytics\')" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'executions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelPolicyAnalytics = Object.freeze({ render: render, refresh: refresh });
}(window));
