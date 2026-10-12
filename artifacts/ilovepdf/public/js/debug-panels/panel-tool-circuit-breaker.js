(function (G) {
  'use strict';
  if (G.PanelToolCircuitBreaker) return;

  var STATE_COLOR = { CLOSED: '#2ecc71', OPEN: '#e74c3c', HALF_OPEN: '#f39c12' };

  function PanelToolCircuitBreaker(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._filter   = 'ALL';
  }

  PanelToolCircuitBreaker.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">' +
        '<span style="font-size:12px;color:#aaa">Filter:</span>' +
        ['ALL', 'CLOSED', 'OPEN', 'HALF_OPEN'].map(function (s) {
          return '<button data-state="' + s + '" style="padding:3px 8px;font-size:11px;cursor:pointer">' + s + '</button>';
        }).join('') +
      '</div>' +
      '<div id="p13cb-body"></div></div>';
    container.querySelectorAll('button[data-state]').forEach(function (btn) {
      btn.onclick = function () { self._filter = btn.dataset.state; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 3000);
  };

  PanelToolCircuitBreaker.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13cb-body');
    if (!el) return;
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb) { el.innerHTML = '<em>RuntimeToolCircuitBreaker not loaded</em>'; return; }
    var all     = cb.getAll();
    var m       = cb.getMetrics();
    var ids     = Object.keys(all).filter(function (id) {
      return this._filter === 'ALL' || all[id].state === this._filter;
    }, this);
    var summary = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
      'Opened: <b style="color:#e74c3c">' + m.opened + '</b>  ' +
      'Closed: <b style="color:#2ecc71">' + m.closed + '</b>  ' +
      'Denied: <b style="color:#f39c12">' + m.denied + '</b></div>';
    if (!ids.length) { el.innerHTML = summary + '<em style="color:#888">No breakers in ' + this._filter + ' state</em>'; return; }
    var rows = ids.map(function (id) {
      var b   = all[id];
      var col = STATE_COLOR[b.state] || '#aaa';
      return '<tr>' +
        '<td style="padding:4px 8px;color:#eee">' + id + '</td>' +
        '<td style="padding:4px 8px"><span style="background:' + col + ';color:#000;padding:1px 6px;border-radius:3px;font-size:11px">' + b.state + '</span></td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">' + (b.openedAt ? new Date(b.openedAt).toLocaleTimeString() : '—') + '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">' + b.crashesInWindow + ' crashes/10m</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = summary +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">Tool</th>' +
      '<th align="left" style="padding:3px 8px">State</th>' +
      '<th align="left" style="padding:3px 8px">Opened At</th>' +
      '<th align="left" style="padding:3px 8px">Crashes (window)</th></tr>' +
      rows + '</table>';
  };

  PanelToolCircuitBreaker.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolCircuitBreaker = PanelToolCircuitBreaker;

}(typeof window !== 'undefined' ? window : this));
