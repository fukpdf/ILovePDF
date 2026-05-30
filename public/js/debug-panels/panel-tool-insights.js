(function (G) {
  'use strict';
  if (G.PanelToolInsights) return;

  var SEV_COLOR = { critical: '#e74c3c', warning: '#f39c12', info: '#3498db' };
  var SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' };

  function PanelToolInsights(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._filter   = 'all';
  }

  PanelToolInsights.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">' +
        '<button id="p13ins-gen" style="padding:4px 10px;cursor:pointer">🔄 Generate Now</button>' +
        '<button id="p13ins-clear" style="padding:4px 10px;cursor:pointer;color:#e74c3c">🗑 Clear</button>' +
        '<span style="color:#aaa;font-size:11px;margin-left:8px">Filter:</span>' +
        ['all', 'critical', 'warning', 'info'].map(function (s) {
          return '<button data-sev="' + s + '" style="padding:2px 8px;font-size:11px;cursor:pointer">' + s + '</button>';
        }).join('') +
      '</div>' +
      '<div id="p13ins-body"></div></div>';
    container.querySelector('#p13ins-gen').onclick = function () {
      if (G.RuntimeToolInsights) { G.RuntimeToolInsights.generateInsights(); self._refresh(); }
    };
    container.querySelector('#p13ins-clear').onclick = function () {
      if (G.RuntimeToolInsights) { G.RuntimeToolInsights.clearInsights(); self._refresh(); }
    };
    container.querySelectorAll('button[data-sev]').forEach(function (btn) {
      btn.onclick = function () { self._filter = btn.dataset.sev; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 6000);
  };

  PanelToolInsights.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13ins-body');
    if (!el) return;
    var ins = G.RuntimeToolInsights;
    if (!ins) { el.innerHTML = '<em>RuntimeToolInsights not loaded</em>'; return; }
    var opts   = this._filter !== 'all' ? { severity: this._filter } : {};
    var items  = ins.getInsights(opts);
    var m      = ins.getMetrics();
    var header = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
      'Total generated: ' + m.generated + '  Cleared: ' + m.cleared + '</div>';
    if (!items.length) {
      el.innerHTML = header + '<em style="color:#888">No insights yet — click "Generate Now" or wait for auto-generation</em>';
      return;
    }
    var cards = items.slice(0, 20).map(function (i) {
      var col  = SEV_COLOR[i.severity] || '#aaa';
      var icon = SEV_ICON[i.severity]  || '⚪';
      return '<div style="border-left:3px solid ' + col + ';padding:6px 10px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:0 4px 4px 0">' +
        '<div style="font-size:11px;color:#aaa;margin-bottom:2px">' +
          icon + ' <span style="color:' + col + '">' + i.severity.toUpperCase() + '</span>' +
          (i.toolId ? '  <span style="color:#7f8c8d">' + i.toolId + '</span>' : '') +
          '  <span style="color:#636e72">' + new Date(i.ts).toLocaleTimeString() + '</span>' +
        '</div>' +
        '<div style="color:#ecf0f1;font-size:12px">' + _esc(i.message) + '</div>' +
        '</div>';
    }).join('');
    el.innerHTML = header + cards;
  };

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  PanelToolInsights.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolInsights = PanelToolInsights;

}(typeof window !== 'undefined' ? window : this));
