(function (G) {
  'use strict';
  if (G.PanelToolDiscovery) return;

  function PanelToolDiscovery(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._tab      = 'discovered';
  }

  PanelToolDiscovery.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button data-tab="discovered" style="padding:3px 10px;cursor:pointer">Auto-Discovered</button>' +
        '<button data-tab="sequences" style="padding:3px 10px;cursor:pointer">All Sequences</button>' +
        '<button data-tab="metrics" style="padding:3px 10px;cursor:pointer">Metrics</button>' +
      '</div>' +
      '<div id="p13disc-body"></div></div>';
    container.querySelectorAll('button[data-tab]').forEach(function (btn) {
      btn.onclick = function () { self._tab = btn.dataset.tab; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 4000);
  };

  PanelToolDiscovery.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13disc-body');
    if (!el) return;
    var disc = G.RuntimeToolDiscovery;
    if (!disc) { el.innerHTML = '<em>RuntimeToolDiscovery not loaded</em>'; return; }

    if (this._tab === 'discovered') {
      var found = disc.getDiscovered();
      var thresh = (disc.CONFIDENCE_THRESH * 100).toFixed(0) + '%';
      var header = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
        found.length + ' dependencies auto-discovered (confidence ≥ ' + thresh + ')</div>';
      if (!found.length) { el.innerHTML = header + '<em style="color:#888">No dependencies discovered yet — keep using tools to build sequences</em>'; return; }
      var rows = found.map(function (d) {
        var conf = Math.round(d.confidence * 100);
        var col  = conf >= 90 ? '#2ecc71' : conf >= 80 ? '#f39c12' : '#e74c3c';
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + d.fromTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">→</td>' +
          '<td style="padding:3px 8px;color:#eee">' + d.toTool + '</td>' +
          '<td style="padding:3px 8px"><span style="color:' + col + '">' + conf + '%</span></td>' +
          '<td style="padding:3px 8px;color:#aaa;font-size:10px">' + new Date(d.addedAt).toLocaleTimeString() + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = header + '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">From</th>' +
        '<th></th><th align="left" style="padding:3px 8px">To</th>' +
        '<th align="left" style="padding:3px 8px">Confidence</th>' +
        '<th align="left" style="padding:3px 8px">Added</th></tr>' + rows + '</table>';
    } else if (this._tab === 'sequences') {
      var seqs = disc.getSequences();
      if (!seqs.length) { el.innerHTML = '<em style="color:#888">No sequences observed yet</em>'; return; }
      var rows2 = seqs.slice(0, 40).map(function (s) {
        var conf = Math.round(s.confidence * 100);
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + s.fromTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">→</td>' +
          '<td style="padding:3px 8px;color:#eee">' + s.toTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + s.occurrences + ' / ' + s.total + '</td>' +
          '<td style="padding:3px 8px;color:' + (conf >= 80 ? '#2ecc71' : '#aaa') + '">' + conf + '%</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">From</th>' +
        '<th></th><th align="left" style="padding:3px 8px">To</th>' +
        '<th align="left" style="padding:3px 8px">Obs/Total</th>' +
        '<th align="left" style="padding:3px 8px">Confidence</th></tr>' + rows2 + '</table>';
    } else {
      var m = disc.getMetrics();
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        [['Transitions observed', m.observed],
         ['Dependencies discovered', m.discovered],
         ['Promoted to dependency graph', m.promoted],
         ['Confidence threshold', (disc.CONFIDENCE_THRESH * 100) + '%']]
        .map(function (r) {
          return '<tr><td style="padding:3px 8px;color:#aaa">' + r[0] + '</td>' +
            '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
        }).join('') + '</table>';
    }
  };

  PanelToolDiscovery.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolDiscovery = PanelToolDiscovery;

}(typeof window !== 'undefined' ? window : this));
