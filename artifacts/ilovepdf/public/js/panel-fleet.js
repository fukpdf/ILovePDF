(function (G) {
  'use strict';
  if (G.PanelFleet) return;

  var _el = null;

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var fm = G.RuntimeFleetManager;
    var cc = G.RuntimeCommandCenter;
    if (!fm) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeFleetManager not loaded</p>'; return; }

    var fleet   = fm.getFleetStatus();
    var metrics = fm.getMetrics();

    var rows = fleet.map(function (s) {
      var stateColor = !s.present ? '#555' : s.paused ? '#e74c3c' : s.isolated ? '#e67e22' : '#2ecc71';
      var stateLabel = !s.present ? 'absent' : s.paused ? 'paused' : s.isolated ? 'isolated' : 'active';
      var id = s.id;
      var esc = id.replace(/'/g, "\\'");
      return '<tr>' +
        '<td style="padding:4px 8px"><span style="color:' + stateColor + '">●</span> ' + s.label + '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">arc' + s.arc + '</td>' +
        '<td style="padding:4px 8px;color:' + stateColor + ';font-weight:bold;font-size:11px">' + stateLabel.toUpperCase() + '</td>' +
        '<td style="padding:4px 8px">' +
          (s.present ? (
            (!s.paused ?
              '<button onclick="G.RuntimeFleetManager.pause(\'' + esc + '\',\'manual\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">⏸ Pause</button>' :
              '<button onclick="G.RuntimeFleetManager.resume(\'' + esc + '\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">▶ Resume</button>'
            ) +
            '<button onclick="G.RuntimeFleetManager.restart(\'' + esc + '\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">🔄 Restart</button>' +
            '<button onclick="G.RuntimeFleetManager.isolate(\'' + esc + '\',\'manual\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">🔒 Isolate</button>' +
            '<button onclick="G.RuntimeFleetManager.quarantine(\'' + esc + '\',\'manual\');G.PanelFleet.refresh()" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer;background:#3a1020;color:#e74c3c;border:1px solid #e74c3c">⛔ Quarantine</button>'
          ) : '<span style="color:#555;font-size:11px">not loaded</span>') +
        '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:10px">' + (s.lastAction || '—') + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Paused', metrics.paused, '#e74c3c') +
        _kpi('Resumed', metrics.resumed, '#2ecc71') +
        _kpi('Restarted', metrics.restarted, '#3498db') +
        _kpi('Isolated', metrics.isolated, '#e67e22') +
        _kpi('Quarantined', metrics.quarantined, '#8e44ad') +
      '</div>' +
      '<div style="overflow-y:auto;max-height:400px">' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="text-align:left;padding:4px 8px">Subsystem</th>' +
          '<th style="text-align:left;padding:4px 8px">Arc</th>' +
          '<th style="text-align:left;padding:4px 8px">State</th>' +
          '<th style="text-align:left;padding:4px 8px">Actions</th>' +
          '<th style="text-align:left;padding:4px 8px">Last Action</th></tr>' +
        rows +
      '</table></div>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.PanelFleet&&G.PanelFleet.refresh()" style="padding:4px 10px;cursor:pointer">🔄 Refresh Fleet</button>' +
      '</div>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px;text-align:center">' +
      '<div style="font-size:10px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:bold;color:' + color + '">' + (value || 0) + '</div></div>';
  }

  G.PanelFleet = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));
