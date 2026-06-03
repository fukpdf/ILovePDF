(function (G) {
  'use strict';
  if (G.PanelAutonomousOps) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _stateColor(s) {
    return s === 'IDLE' ? '#2ecc71' : s === 'RECOVERING' ? '#f39c12' : s === 'DETECTING' ? '#3498db' : '#888';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var ao = G.RuntimeAutonomousOps;
    if (!ao) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeAutonomousOps not loaded</p>'; return; }

    var status = ao.getLoopStatus();
    var m      = status.metrics || {};
    var cycles = ao.getCycles(15);

    var healRate = m.healCycles > 0 ? Math.round(m.successfulHeals / m.healCycles * 100) : 0;
    var healColor = healRate >= 80 ? '#2ecc71' : healRate >= 60 ? '#f39c12' : '#e74c3c';
    var stateColor = _stateColor(status.state);

    var cycleRows = cycles.length ? cycles.map(function (c) {
      var sCol    = c.state === 'HEALED' ? '#2ecc71' : c.state === 'FAILED' ? '#e74c3c' : c.state === 'NO_ACTION' ? '#888' : '#f39c12';
      var action  = c.decision && c.decision.action ? c.decision.action : '—';
      var conf    = c.decision && c.decision.confidence != null ? c.decision.confidence + '%' : '—';
      var health  = c.verify && c.verify.score != null ? c.verify.score + '%' : '—';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + c.state + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#888">' + (c.signals || 0) + ' signals</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#9b59b6">' + conf + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#2ecc71">' + health + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + (c.durationMs || 0) + 'ms</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="6" style="padding:8px;color:#555;text-align:center;font-size:11px">No cycles yet</td></tr>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:8px;background:#1a1a2e;border-radius:6px">' +
        '<div style="font-size:22px">' + (status.running ? '🔄' : '⏸') + '</div>' +
        '<div>' +
          '<div style="font-weight:700;color:' + (status.running ? '#2ecc71' : '#888') + '">' + (status.running ? 'RUNNING' : 'STOPPED') + '</div>' +
          '<div style="font-size:11px;color:' + stateColor + '">' + status.state + '</div>' +
        '</div>' +
        '<div style="margin-left:auto;font-size:11px;color:#666">Interval: ' + Math.round((status.interval || 0) / 1000) + 's</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Cycles', m.totalCycles || 0, '#3498db') +
        _kpi('Heal Cycles', m.healCycles || 0, '#9b59b6') +
        _kpi('Heal Rate', healRate + '%', healColor) +
        _kpi('No Action', m.noActionCycles || 0, '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Successful Heals', m.successfulHeals || 0, '#2ecc71') +
        _kpi('Failed Heals', m.failedHeals || 0, (m.failedHeals || 0) > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px">Heal Cycles (' + cycles.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>State</th><th>Signals</th><th style="text-align:left">Action</th><th>Conf</th><th>Health</th><th>ms</th></tr></thead>' +
        '<tbody>' + cycleRows + '</tbody></table></details>' +
      '<div style="margin-top:10px;display:flex;gap:8px">' +
        '<button onclick="if(window.RuntimeAutonomousOps)' + (status.running ? 'window.RuntimeAutonomousOps.stop()' : 'window.RuntimeAutonomousOps.start()') + '" ' +
          'style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">' + (status.running ? '⏸ Stop' : '▶ Start') + '</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'heal-cycles\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelAutonomousOps = Object.freeze({ render: render, refresh: refresh });
}(window));
