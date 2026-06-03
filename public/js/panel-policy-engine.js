(function (G) {
  'use strict';
  if (G.PanelPolicyEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _sevColor(sev) {
    return sev === 'EMERGENCY' ? '#e74c3c' : sev === 'CRITICAL' ? '#e67e22' : sev === 'WARN' ? '#f39c12' : '#3498db';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var pe = G.RuntimePolicyEngine;
    if (!pe) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimePolicyEngine not loaded</p>'; return; }

    var m        = pe.getMetrics();
    var policies = pe.getPolicies();
    var history  = pe.getHistory(10);
    var enabled  = policies.filter(function (p) { return p.enabled; }).length;

    var polRows = policies.slice(0, 20).map(function (p) {
      var dot    = p.enabled ? '🟢' : '⚫';
      var sCol   = _sevColor(p.severity);
      return '<tr style="border-bottom:1px solid #222">' +
        '<td style="padding:3px 6px">' + dot + '</td>' +
        '<td style="padding:3px 8px;font-size:12px">' + p.label + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:' + sCol + '">' + p.severity + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#888">P' + p.priority + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#aaa">' + (p.action || '—') + '</td>' +
        '<td style="padding:3px 4px">' +
          '<button onclick="(function(){var pe=window.RuntimePolicyEngine;if(!pe)return;pe.' + (p.enabled ? 'disablePolicy' : 'enablePolicy') + '(\'' + p.id + '\');})()" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #444;background:#2a2a3e;color:#ccc">' +
          (p.enabled ? 'Disable' : 'Enable') + '</button></td>' +
        '</tr>';
    }).join('');

    var histRows = history.map(function (h) {
      var sCol = _sevColor(h.severity);
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + h.severity + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + h.label + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#888">' + h.action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#666">' + new Date(h.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Policies', m.total, '#3498db') +
        _kpi('Enabled', enabled, '#2ecc71') +
        _kpi('Triggered', m.triggered, m.triggered > 0 ? '#f39c12' : '#888') +
        _kpi('Errors', m.errors, m.errors > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Evaluated', m.evaluated, '#9b59b6') +
        _kpi('Suppressed', m.suppressed, '#888') +
        _kpi('By CRITICAL', m.bySeverity && m.bySeverity.CRITICAL || 0, '#e67e22') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Policies (' + policies.length + ')</summary>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr style="color:#888;font-size:10px"><th>St</th><th style="text-align:left">Label</th><th>Sev</th><th>Pri</th><th>Action</th><th></th></tr></thead>' +
        '<tbody>' + polRows + '</tbody></table></div></details>' +
      (history.length ? '<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Triggers (' + history.length + ')</summary>' +
        '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Sev</th><th style="text-align:left">Policy</th><th>Action</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' : '') +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimePolicyEngine)window.RuntimePolicyEngine.evaluateAll()" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Evaluate All</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'policies\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
      '</div></div>';
  }

  G.PanelPolicyEngine = Object.freeze({ render: render, refresh: refresh });
}(window));
