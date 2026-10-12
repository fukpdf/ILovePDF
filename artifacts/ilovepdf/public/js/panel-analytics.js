(function (G) {
  'use strict';
  if (G.PanelAnalytics) return;

  var _el     = null;
  var _window = '15m';

  var WINDOWS = ['5m', '15m', '1h', '6h', '24h'];

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var analy = G.RuntimeCommandAnalytics;
    var fc    = G.RuntimeForecast;

    if (!analy) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeCommandAnalytics not loaded</p>'; return; }

    var trends  = analy.getTrends(_window);
    var growth  = analy.getGrowthRates(_window);
    var usage   = analy.getToolUsageTrend().slice(0, 10);
    var forecasts = fc && fc.getForecasts ? fc.getForecasts({ limit: 5 }) : [];

    var winBtns = WINDOWS.map(function (w) {
      var active = w === _window;
      return '<button onclick="G&&G.PanelAnalytics&&G.PanelAnalytics._setWindow(\'' + w + '\')" ' +
        'style="margin:0 2px;padding:3px 8px;cursor:pointer;background:' + (active ? '#3498db' : '#222') + ';' +
        'color:' + (active ? '#fff' : '#3498db') + ';border:1px solid #3498db;border-radius:3px">' + w + '</button>';
    }).join('');

    function trendRow(label, key, unit) {
      var d = trends[key] || {};
      var t = d.trend || 0;
      var arrow = t > 0.01 ? '↑' : t < -0.01 ? '↓' : '→';
      var color = key === 'memory' || key === 'failures' || key === 'incidents' || key === 'slaViolations'
        ? (t > 0.1 ? '#e74c3c' : t > 0 ? '#f1c40f' : '#2ecc71')
        : (t > 0 ? '#2ecc71' : '#aaa');
      return '<tr>' +
        '<td style="padding:3px 8px">' + label + '</td>' +
        '<td style="padding:3px 8px;text-align:right;color:#aaa">' + (d.avg || 0).toFixed(1) + (unit || '') + '</td>' +
        '<td style="padding:3px 8px;text-align:right;color:' + color + '">' + arrow + ' ' + Math.abs(t).toFixed(3) + '/min</td>' +
        '<td style="padding:3px 8px;text-align:right;color:' + (growth[key] > 0 ? '#e74c3c' : '#2ecc71') + '">' + (growth[key] || 0) + '%</td>' +
        '</tr>';
    }

    var usageRows = usage.map(function (t) {
      return '<tr><td style="padding:2px 6px">' + t.toolId + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:#3498db">' + (t.launches || 0) + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:' + (t.successRate >= 90 ? '#2ecc71' : t.successRate >= 70 ? '#f1c40f' : '#e74c3c') + '">' +
        (t.successRate != null ? t.successRate + '%' : '—') + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:#f39c12">' + (t.score != null ? t.score.toFixed(1) : '—') + '</td>' +
        '</tr>';
    }).join('');

    var SCOLORS = { info: '#3498db', warning: '#f1c40f', critical: '#e74c3c' };
    var fcastHtml = forecasts.length ? forecasts.map(function (f) {
      var col = SCOLORS[f.severity] || '#aaa';
      return '<div style="border-left:3px solid ' + col + ';padding:4px 8px;margin:4px 0;background:#1a1a2e">' +
        '<span style="color:' + col + ';font-size:11px;font-weight:bold">' + f.type.toUpperCase() + ' ' + f.confidence + '%</span><br>' +
        '<span style="font-size:11px">' + f.message + '</span></div>';
    }).join('') : '<p style="color:#aaa;font-size:11px">No forecasts yet — generates every 5 min</p>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="margin-bottom:8px">' + winBtns + '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Trends (' + trends.sampleCount + ' samples in window)</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="text-align:left;padding:3px 8px">Metric</th>' +
          '<th style="text-align:right;padding:3px 8px">Avg</th>' +
          '<th style="text-align:right;padding:3px 8px">Trend</th>' +
          '<th style="text-align:right;padding:3px 8px">Growth</th></tr>' +
        trendRow('Memory', 'memory', '%') +
        trendRow('Workers', 'workers', '') +
        trendRow('Failures', 'failures', '%') +
        trendRow('Incidents', 'incidents', '') +
        trendRow('SLA Violations', 'slaViolations', '') +
        trendRow('CB Open', 'cbOpen', '') +
      '</table></details>' +
      (usage.length ? '<details><summary style="cursor:pointer;font-weight:bold;margin:6px 0">Top Tools by Usage</summary>' +
        '<table style="width:100%;border-collapse:collapse">' +
          '<tr style="color:#aaa;font-size:11px"><th style="text-align:left;padding:2px 6px">Tool</th>' +
            '<th style="text-align:right;padding:2px 6px">Launches</th>' +
            '<th style="text-align:right;padding:2px 6px">Success</th>' +
            '<th style="text-align:right;padding:2px 6px">Score</th></tr>' +
          usageRows + '</table></details>' : '') +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin:6px 0">Forecasts</summary>' +
        fcastHtml +
        '<button onclick="G&&G.RuntimeForecast&&G.RuntimeForecast.generateForecasts();G&&G.PanelAnalytics&&G.PanelAnalytics.refresh()" style="margin-top:6px;padding:3px 8px;cursor:pointer">🔮 Generate Now</button>' +
      '</details>' +
      '</div>';
  }

  function _setWindow(w) { _window = w; refresh(); }

  var _pub = Object.freeze({ render: render, refresh: refresh, _setWindow: _setWindow });
  G.PanelAnalytics = _pub;

}(typeof window !== 'undefined' ? window : this));
