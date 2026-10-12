(function (G) {
  'use strict';
  if (G.PanelAutomationEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var ae = G.RuntimeAutomationEngine;
    if (!ae) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeAutomationEngine not loaded</p>'; return; }

    var m       = ae.getMetrics();
    var queue   = ae.getQueue();
    var history = ae.getHistory(15);

    var rate = m.executed > 0 ? Math.round(m.succeeded / m.executed * 100) : 0;
    var rateColor = rate >= 80 ? '#2ecc71' : rate >= 60 ? '#f39c12' : '#e74c3c';

    var queueRows = queue.length ? queue.map(function (q) {
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 6px;font-size:11px;color:#9b59b6">' + q.id + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + q.type + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#888">' + (q.target || '—') + '</td>' +
        '<td style="padding:3px 4px"><button onclick="window.RuntimeAutomationEngine&&window.RuntimeAutomationEngine.cancelAction(\'' + q.id + '\')" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #e74c3c;background:#2a0a0a;color:#e74c3c">Cancel</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="4" style="padding:8px;color:#555;text-align:center;font-size:11px">Queue empty</td></tr>';

    var histRows = history.map(function (h) {
      var sCol = h.status === 'success' ? '#2ecc71' : '#e74c3c';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + h.status + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + h.type + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#888">' + (h.target || '—') + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#666">' + h.durationMs + 'ms</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + new Date(h.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var typeRows = Object.entries(m.byType || {}).map(function (kv) {
      return '<tr style="border-bottom:1px solid #1a1a2e"><td style="padding:2px 8px;font-size:11px">' + kv[0] + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#3498db">' + kv[1] + '</td></tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Executed', m.executed, '#3498db') +
        _kpi('Succeeded', m.succeeded, '#2ecc71') +
        _kpi('Failed', m.failed, m.failed > 0 ? '#e74c3c' : '#888') +
        _kpi('Success Rate', rate + '%', rateColor) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Queued', m.queued, '#9b59b6') +
        _kpi('Pending', queue.length, queue.length > 0 ? '#f39c12' : '#888') +
        _kpi('Cancelled', m.cancelled, '#888') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Action Queue (' + queue.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>ID</th><th style="text-align:left">Type</th><th>Target</th><th></th></tr></thead>' +
        '<tbody>' + queueRows + '</tbody></table></details>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Actions</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Type</th><th>Target</th><th>ms</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      (typeRows ? '<details><summary style="cursor:pointer;font-weight:bold;padding:4px">By Action Type</summary>' +
        '<table style="width:100%;border-collapse:collapse"><tbody>' + typeRows + '</tbody></table></details>' : '') +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimeAutomationEngine)window.RuntimeAutomationEngine.executeAction(\'log\',\'panel-test\')" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Test Log Action</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'executions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelAutomationEngine = Object.freeze({ render: render, refresh: refresh });
}(window));
