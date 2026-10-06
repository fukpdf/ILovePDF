(function (G) {
  'use strict';
  if (G.PanelCommandCenter) return;

  var _el = null;

  function render(container) {
    _el = container;
    refresh();
  }

  function refresh() {
    if (!_el) return;
    var cc  = G.RuntimeCommandCenter;
    var alt = G.RuntimeAlerts;
    var fc  = G.RuntimeForecast;
    if (!cc) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeCommandCenter not loaded</p>'; return; }

    var health = cc.getSystemHealth();
    var subs   = cc.getSubsystems();
    var metrics= cc.getMetrics();

    var scoreColor = health.score >= 90 ? '#2ecc71' : health.score >= 70 ? '#f39c12' : '#e74c3c';
    var unacked    = alt && alt.getAlerts ? alt.getAlerts({ unacknowledged: true }).length : 0;
    var forecasts  = fc  && fc.getForecasts ? fc.getForecasts({ severity: 'critical' }).length : 0;

    var arcGroups = {};
    subs.forEach(function (s) {
      var k = 'arc' + s.arc;
      if (!arcGroups[k]) arcGroups[k] = [];
      arcGroups[k].push(s);
    });

    var groupHtml = Object.keys(arcGroups).sort().map(function (k) {
      var list = arcGroups[k].map(function (s) {
        var dot = s.present ? (s.healthy ? '🟢' : '🟡') : '🔴';
        return '<tr><td style="padding:2px 6px">' + dot + '</td><td style="padding:2px 8px">' + s.label + '</td>' +
          '<td style="padding:2px 6px;color:#aaa;font-size:11px">' + s.global + '</td></tr>';
      }).join('');
      return '<details style="margin:4px 0"><summary style="cursor:pointer;font-weight:bold">' + k.toUpperCase() +
        ' (' + arcGroups[k].filter(function (s) { return s.present; }).length + '/' + arcGroups[k].length + ')</summary>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' + list + '</table></details>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Health Score', health.score + '%', scoreColor) +
        _kpi('Level', health.level, scoreColor) +
        _kpi('Subsystems', health.present + '/' + health.total, '#3498db') +
        _kpi('Commands Run', metrics.commands, '#9b59b6') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Unacked Alerts', unacked, unacked > 0 ? '#e74c3c' : '#2ecc71') +
        _kpi('Critical Forecasts', forecasts, forecasts > 0 ? '#e74c3c' : '#2ecc71') +
        _kpi('Command Errors', metrics.errors, metrics.errors > 0 ? '#e74c3c' : '#2ecc71') +
      '</div>' +
      '<div>' + groupHtml + '</div>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'refresh-health\')" style="margin-right:6px;padding:4px 10px;cursor:pointer">🔄 Refresh</button>' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'generate-insights\')" style="margin-right:6px;padding:4px 10px;cursor:pointer">💡 Insights</button>' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'check-sla\')" style="padding:4px 10px;cursor:pointer">📏 Check SLA</button>' +
      '</div>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;text-align:center">' +
      '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:20px;font-weight:bold;color:' + color + '">' + value + '</div></div>';
  }

  G.PanelCommandCenter = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));
