(function (G) {
  'use strict';
  if (G.PanelAlerts) return;

  var _el     = null;
  var _filter = 'ALL';

  var LEVEL_COLOR = { INFO: '#3498db', WARN: '#f1c40f', P2: '#e67e22', P1: '#e74c3c', P0: '#8e44ad' };
  var LEVELS      = ['ALL', 'P0', 'P1', 'P2', 'WARN', 'INFO'];

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var alt = G.RuntimeAlerts;
    if (!alt) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeAlerts not loaded</p>'; return; }

    var metrics = alt.getMetrics();
    var opts    = _filter === 'ALL' ? {} : { level: _filter };
    var alerts  = alt.getAlerts(Object.assign({ limit: 100 }, opts));

    var levelBtns = LEVELS.map(function (l) {
      var active = l === _filter;
      var color  = LEVEL_COLOR[l] || '#aaa';
      var cnt    = l === 'ALL' ? metrics.raised : (metrics.byLevel[l] || 0);
      return '<button onclick="G&&G.PanelAlerts&&G.PanelAlerts._setFilter(\'' + l + '\')" ' +
        'style="margin:0 3px;padding:3px 8px;cursor:pointer;background:' + (active ? color : '#222') + ';' +
        'color:' + (active ? '#000' : color) + ';border:1px solid ' + color + ';border-radius:3px">' +
        l + (cnt ? ' (' + cnt + ')' : '') + '</button>';
    }).join('');

    var rows = alerts.map(function (a) {
      var color = LEVEL_COLOR[a.level] || '#aaa';
      var ack   = a.acknowledged ? '✓' : '';
      var t     = new Date(a.ts).toTimeString().slice(0, 8);
      return '<tr style="opacity:' + (a.acknowledged ? '0.5' : '1') + '">' +
        '<td style="padding:3px 6px;color:' + color + ';font-weight:bold">' + a.level + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + a.source + '</td>' +
        '<td style="padding:3px 6px">' + a.message + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + (a.toolId || '') + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + t + '</td>' +
        '<td style="padding:3px 6px">' +
          (!a.acknowledged ? '<button onclick="G&&G.RuntimeAlerts&&G.RuntimeAlerts.acknowledge(\'' + a.id + '\');G&&G.PanelAlerts&&G.PanelAlerts.refresh()" ' +
            'style="font-size:10px;padding:2px 5px;cursor:pointer">Ack</button>' : ack) +
        '</td></tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Raised', metrics.raised, '#3498db') +
        _kpi('P0', metrics.byLevel.P0, '#8e44ad') +
        _kpi('P1', metrics.byLevel.P1, '#e74c3c') +
        _kpi('P2', metrics.byLevel.P2, '#e67e22') +
        _kpi('Acked', metrics.acknowledged, '#2ecc71') +
      '</div>' +
      '<div style="margin-bottom:8px">' + levelBtns + '</div>' +
      '<div style="margin-bottom:6px">' +
        '<button onclick="G&&G.RuntimeAlerts&&G.RuntimeAlerts.acknowledgeAll();G&&G.PanelAlerts&&G.PanelAlerts.refresh()" style="padding:3px 8px;cursor:pointer">✓ Ack All</button>' +
      '</div>' +
      (alerts.length ? '<div style="overflow-y:auto;max-height:300px"><table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="padding:3px 6px;text-align:left">Level</th>' +
          '<th style="padding:3px 6px;text-align:left">Source</th>' +
          '<th style="padding:3px 6px;text-align:left">Message</th>' +
          '<th style="padding:3px 6px;text-align:left">Tool</th>' +
          '<th style="padding:3px 6px;text-align:left">Time</th>' +
          '<th></th></tr>' + rows + '</table></div>' :
        '<p style="color:#aaa;text-align:center;padding:20px">No alerts' + (_filter !== 'ALL' ? ' for ' + _filter : '') + '</p>') +
      '</div>';
  }

  function _setFilter(level) { _filter = level; refresh(); }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px;text-align:center">' +
      '<div style="font-size:10px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:bold;color:' + color + '">' + (value || 0) + '</div></div>';
  }

  var _pub = Object.freeze({ render: render, refresh: refresh, _setFilter: _setFilter });
  G.PanelAlerts = _pub;

}(typeof window !== 'undefined' ? window : this));
