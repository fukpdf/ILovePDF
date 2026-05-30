(function (G) {
  'use strict';
  if (G.PanelToolPersistence) return;

  function PanelToolPersistence(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
  }

  PanelToolPersistence.prototype.render = function (container) {
    this._el = container;
    container.innerHTML = '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<button id="p13per-save" style="padding:4px 10px;cursor:pointer">💾 Save Now</button>' +
      '<button id="p13per-restore" style="padding:4px 10px;cursor:pointer">📂 Restore</button>' +
      '<button id="p13per-clear" style="padding:4px 10px;cursor:pointer;color:red">🗑 Clear</button>' +
      '</div>' +
      '<div id="p13per-body"></div></div>';
    container.querySelector('#p13per-save').onclick    = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.save();
    };
    container.querySelector('#p13per-restore').onclick = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.restore();
    };
    container.querySelector('#p13per-clear').onclick   = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.clear();
    };
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 5000);
  };

  PanelToolPersistence.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13per-body');
    if (!el) return;
    var p   = G.RuntimeToolPersistence;
    var reg = G.RuntimeToolRegistry;
    if (!p) { el.innerHTML = '<em>RuntimeToolPersistence not loaded</em>'; return; }
    var m   = p.getMetrics();
    var regCount = reg && reg.getAllTools ? reg.getAllTools().length : '?';
    var rows = [
      ['Database', 'tool-intelligence-v1 (IndexedDB)'],
      ['Stores', 'registry · predictor · recovery · optimizer'],
      ['Auto-save interval', '60 seconds'],
      ['Saves completed', m.saves],
      ['Restores completed', m.restores],
      ['Errors', m.errors],
      ['Last save', m.lastSaveTs ? new Date(m.lastSaveTs).toLocaleTimeString() : '—'],
      ['Last restore', m.lastRestoreTs ? new Date(m.lastRestoreTs).toLocaleTimeString() : '—'],
      ['Registry tools loaded', regCount],
    ];
    el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      rows.map(function (r) {
        return '<tr><td style="padding:3px 8px;color:#aaa;white-space:nowrap">' + r[0] + '</td>' +
               '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
      }).join('') + '</table>';
  };

  PanelToolPersistence.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolPersistence = PanelToolPersistence;

}(typeof window !== 'undefined' ? window : this));
