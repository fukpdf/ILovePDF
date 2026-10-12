(function (G) {
  'use strict';
  if (G.PanelTimeline) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelTimeline]';

  var FAMILY_COLORS = {
    pdf: '#4af', image: '#fa4', convert: '#a4f', security: '#f44',
    edit: '#4fa', merge: '#4af', organize: '#8af', ai: '#f4a',
  };

  function PanelTimeline(container) {
    this._c      = container;
    this._paused = false;
    this._filter = { search: '', type: '' };
    this._built  = false;
    this._vlist  = null;
    this._items  = [];
  }

  PanelTimeline.prototype.init = function () {
    var Ren  = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '📊 Event Timeline' }),
      Ren.el('input', { cls: 'dbg-input', id: 'tl-search', placeholder: 'Search events…', type: 'text' }),
      Ren.el('input', { cls: 'dbg-input', id: 'tl-type',   placeholder: 'Event type filter…', type: 'text' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-pause',   text: 'Pause' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-snapshot', text: 'Snapshot' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-export',  text: 'Export' }),
    ]);

    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'tl-metrics' });
    var listEl  = Ren.el('div', { id: 'tl-list', style: 'height:440px;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metrics);
    this._c.appendChild(listEl);

    // VirtualList — 28px row height
    var Ren2 = Ren;
    this._vlist = new Ren.VirtualList(listEl, 28, function (ev, i) {
      var family = (ev.type || '').split(':')[0];
      var color  = FAMILY_COLORS[family] || '#aaa';
      var row = Ren2.el('div', { cls: 'tl-row', style: 'border-left:3px solid ' + color });
      row.appendChild(Ren2.el('span', { cls: 'tl-ts',   text: Ren2.fmtTs(ev.ts) }));
      row.appendChild(Ren2.el('span', { cls: 'tl-type', text: ev.type || '—' }));
      if (ev.toolId) row.appendChild(Ren2.el('span', { cls: 'tl-tool', text: '[' + ev.toolId + ']' }));
      return row;
    });

    // Controls
    toolbar.querySelector('#tl-pause').addEventListener('click', function (e) {
      self._paused = !self._paused;
      e.target.textContent = self._paused ? 'Resume' : 'Pause';
      e.target.classList.toggle('dbg-btn-active', self._paused);
    });

    toolbar.querySelector('#tl-search').addEventListener('input', function (e) {
      self._filter.search = e.target.value.toLowerCase();
      self._applyFilter();
    });

    toolbar.querySelector('#tl-type').addEventListener('input', function (e) {
      self._filter.type = e.target.value.toLowerCase();
      self._applyFilter();
    });

    toolbar.querySelector('#tl-snapshot').addEventListener('click', function () {
      var ET = G.RuntimeEventTimeline;
      if (!ET) return;
      var snap = ET.snapshot();
      alert('Snapshot taken: ' + (snap && snap.id ? snap.id : 'ok'));
    });

    toolbar.querySelector('#tl-export').addEventListener('click', function () {
      var ET = G.RuntimeEventTimeline;
      var Ex = G.RuntimeDebugExport;
      if (ET && Ex) Ex.exportJson(ET.search({}), 'timeline');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(listEl);
  };

  PanelTimeline.prototype._applyFilter = function () {
    var search = this._filter.search;
    var type   = this._filter.type;
    var items  = this._items.filter(function (ev) {
      if (type   && (ev.type   || '').toLowerCase().indexOf(type)   === -1) return false;
      if (search && (ev.type   || '').toLowerCase().indexOf(search) === -1 &&
                    (ev.toolId || '').toLowerCase().indexOf(search) === -1) return false;
      return true;
    });
    if (this._vlist) this._vlist.setItems(items.slice().reverse());
  };

  PanelTimeline.prototype.refresh = function () {
    if (!this._built || this._paused) return;
    var ET  = G.RuntimeEventTimeline;
    var TE  = G.RuntimeTraceEngine;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#tl-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      if (ET) {
        var m = ET.getMetrics();
        [
          ['Events', ET.getCount()],
          ['Captured', m.captured || 0],
          ['Bursts',   m.bursts   || 0],
          ['Groups',   m.groups   || 0],
        ].forEach(function (pair) {
          metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
        });
      }
      if (TE) {
        var ts = TE.getStats();
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Traces: ' + (ts.total || 0) }));
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Slow: '   + (ts.slowPaths || 0) }));
      }
    }

    // Items
    if (ET) {
      this._items = ET.search({}) || [];
      this._applyFilter();
    }
  };

  G.PanelTimeline = PanelTimeline;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
