(function (G) {
  'use strict';
  if (G.PanelToolSLA) return;

  function PanelToolSLA(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._tab      = 'violations';
  }

  PanelToolSLA.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button data-tab="violations" style="padding:3px 10px;cursor:pointer">Violations</button>' +
        '<button data-tab="targets" style="padding:3px 10px;cursor:pointer">Targets</button>' +
        '<button data-tab="metrics" style="padding:3px 10px;cursor:pointer">Metrics</button>' +
      '</div>' +
      '<div id="p13sla-body"></div></div>';
    container.querySelectorAll('button[data-tab]').forEach(function (btn) {
      btn.onclick = function () { self._tab = btn.dataset.tab; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 5000);
  };

  PanelToolSLA.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13sla-body');
    if (!el) return;
    var sla = G.RuntimeToolSLA;
    if (!sla) { el.innerHTML = '<em>RuntimeToolSLA not loaded</em>'; return; }

    if (this._tab === 'violations') {
      var viols = sla.getViolations();
      if (!viols.length) { el.innerHTML = '<em style="color:#888">No SLA violations recorded</em>'; return; }
      var rows  = viols.slice(-30).reverse().map(function (v) {
        var style = v.critical ? 'color:#e74c3c' : 'color:#f39c12';
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + v.toolId + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + v.metric + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">p' + v.percentile + '</td>' +
          '<td style="padding:3px 8px;' + style + '">' + (v.actual || 0).toFixed(0) + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + v.target + '</td>' +
          '<td style="padding:3px 8px;color:#aaa;font-size:10px">' + new Date(v.ts).toLocaleTimeString() + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px">' +
        '<th align="left" style="padding:3px 8px">Tool</th><th align="left" style="padding:3px 8px">Metric</th>' +
        '<th align="left" style="padding:3px 8px">Pct</th><th align="left" style="padding:3px 8px">Actual</th>' +
        '<th align="left" style="padding:3px 8px">Target</th><th align="left" style="padding:3px 8px">Time</th></tr>' +
        rows + '</table>';
    } else if (this._tab === 'targets') {
      var def = sla.DEFAULTS;
      var html = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">Default SLA targets (configurable per tool via setSLA)</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
      html += '<tr style="color:#888"><th align="left" style="padding:3px 8px">Metric</th>' +
        '<th align="left" style="padding:3px 8px">p50</th><th align="left" style="padding:3px 8px">p90</th>' +
        '<th align="left" style="padding:3px 8px">p99</th></tr>';
      Object.keys(def).forEach(function (k) {
        var t = def[k];
        html += '<tr><td style="padding:3px 8px;color:#eee">' + k + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p50 + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p90 + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p99 + '</td></tr>';
      });
      html += '</table>';
      el.innerHTML = html;
    } else {
      var m = sla.getMetrics();
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        [['Checks run', m.checked], ['Violations', m.violated], ['Critical breaches', m.critical]]
        .map(function (r) {
          return '<tr><td style="padding:3px 8px;color:#aaa">' + r[0] + '</td>' +
            '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
        }).join('') + '</table>';
    }
  };

  PanelToolSLA.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolSLA = PanelToolSLA;

}(typeof window !== 'undefined' ? window : this));
