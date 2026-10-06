(function (G) {
  'use strict';
  if (G.PanelWorkflowEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _statusColor(s) {
    return s === 'COMPLETE' ? '#2ecc71' : s === 'FAILED' ? '#e74c3c' : s === 'ROLLED_BACK' ? '#e67e22' :
           s === 'RUNNING'  ? '#3498db' : '#888';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var wfe = G.RuntimeWorkflowEngine;
    if (!wfe) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeWorkflowEngine not loaded</p>'; return; }

    var m       = wfe.getMetrics();
    var active  = wfe.getActiveRuns();
    var history = wfe.getHistory(10);
    var wfs     = wfe.getWorkflows();

    var activeRows = active.length ? active.map(function (r) {
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 6px;font-size:11px;color:#3498db">' + r.runId + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + r.workflowId + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#f39c12">RUNNING</td>' +
        '<td style="padding:3px 4px"><button onclick="window.RuntimeWorkflowEngine&&window.RuntimeWorkflowEngine.cancelWorkflow(\'' + r.runId + '\')" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #e74c3c;background:#2a0a0a;color:#e74c3c">Cancel</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="4" style="padding:8px;color:#555;text-align:center;font-size:11px">No active runs</td></tr>';

    var histRows = history.map(function (h) {
      var sCol  = _statusColor(h.status);
      var steps = h.steps ? h.steps.map(function (s) {
        var sc = s.status === 'success' ? '#2ecc71' : '#e74c3c';
        return '<span style="font-size:10px;padding:1px 4px;border-radius:3px;background:#111;color:' + sc + ';margin:1px">' + s.label + '</span>';
      }).join(' → ') : '';
      return '<tr style="border-bottom:1px solid #111">' +
        '<td style="padding:3px 6px;font-size:11px;color:' + sCol + '">' + h.status + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + h.workflowId + '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#888">' + h.durationMs + 'ms</td>' +
        '<td style="padding:3px 6px;font-size:10px">' + steps + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Workflows', m.workflows, '#3498db') +
        _kpi('Completed', m.completed, '#2ecc71') +
        _kpi('Failed', m.failed, m.failed > 0 ? '#e74c3c' : '#888') +
        _kpi('Active', m.active, m.active > 0 ? '#f39c12' : '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Started', m.started, '#9b59b6') +
        _kpi('Rolled Back', m.rolledBack, m.rolledBack > 0 ? '#e67e22' : '#888') +
        _kpi('Created', m.created, '#888') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Active Runs (' + active.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Run ID</th><th style="text-align:left">Workflow</th><th>Status</th><th></th></tr></thead>' +
        '<tbody>' + activeRows + '</tbody></table></details>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Runs</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Workflow</th><th>ms</th><th>Steps</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      '<details style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Registered Workflows (' + wfs.length + ')</summary>' +
        wfs.map(function (w) { return '<div style="padding:4px 8px;font-size:11px;color:#aaa">▸ <b>' + w.label + '</b> (' + w.steps.length + ' steps)</div>'; }).join('') +
      '</details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="try{window.RuntimeWorkflowEngine&&window.RuntimeWorkflowEngine.runWorkflow(\'incident-response\')}catch(e){}" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Run Incident Response</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'workflows\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
      '</div></div>';
  }

  G.PanelWorkflowEngine = Object.freeze({ render: render, refresh: refresh });
}(window));
