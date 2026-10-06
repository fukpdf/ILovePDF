(function (G) {
  'use strict';
  if (G.PanelIncidents) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelIncidents]';

  function PanelIncidents(container) {
    this._c        = container;
    this._filter   = { sev: -1, search: '' };
    this._paused   = false;
    this._built    = false;
  }

  PanelIncidents.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    // Toolbar
    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🚨 Incident Center' }),
      Ren.el('select', { cls: 'dbg-sel', id: 'inc-sev-sel' }, [
        Ren.el('option', { value: '-1', text: 'All severities' }),
        Ren.el('option', { value: '0',  text: 'P0 Critical' }),
        Ren.el('option', { value: '1',  text: 'P1 High' }),
        Ren.el('option', { value: '2',  text: 'P2 Medium' }),
        Ren.el('option', { value: '3',  text: 'P3 Low' }),
      ]),
      Ren.el('input', { cls: 'dbg-input', id: 'inc-search', placeholder: 'Search…', type: 'text' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'inc-export', text: 'Export JSON' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'inc-clear', text: 'Clear Resolved' }),
    ]);

    // Metrics strip
    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'inc-metrics' });

    // Incident list
    var listWrap = Ren.el('div', { cls: 'panel-list-wrap', id: 'inc-list-wrap', style: 'height:420px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metrics);
    this._c.appendChild(listWrap);

    // Wire controls
    toolbar.querySelector('#inc-sev-sel').addEventListener('change', function (e) {
      self._filter.sev = parseInt(e.target.value, 10);
      self.refresh();
    });
    toolbar.querySelector('#inc-search').addEventListener('input', function (e) {
      self._filter.search = e.target.value.toLowerCase();
      self.refresh();
    });
    toolbar.querySelector('#inc-export').addEventListener('click', function () {
      var Ex = G.RuntimeDebugExport;
      var IC = G.RuntimeIncidentCenter;
      if (Ex && IC) Ex.exportJson(IC.query({}), 'incidents');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(listWrap);
  };

  PanelIncidents.prototype.refresh = function () {
    if (!this._built) return;
    var IC  = G.RuntimeIncidentCenter;
    var AH  = G.RuntimeAutonomousHealing;
    var RO  = G.RuntimeRecoveryOrchestrator;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#inc-metrics');
    if (metricsEl && IC) {
      var m = IC.getMetrics();
      metricsEl.innerHTML = '';
      [
        ['Total', m.total || 0],
        ['P0',    m.bySev && m.bySev[0] || 0],
        ['P1',    m.bySev && m.bySev[1] || 0],
        ['P2',    m.bySev && m.bySev[2] || 0],
        ['P3',    m.bySev && m.bySev[3] || 0],
        ['Resolved', m.resolved || 0],
      ].forEach(function (pair) {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      if (AH) {
        var as = AH.getState();
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Heals: ' + (as.stats && as.stats.total || 0) }));
      }
    }

    // Incidents list
    var listWrap = this._c.querySelector('#inc-list-wrap');
    if (!listWrap || !IC) return;

    var filter  = this._filter;
    var allIncs = IC.query({});
    var items   = allIncs.filter(function (inc) {
      if (filter.sev >= 0 && inc.severity !== filter.sev) return false;
      if (filter.search) {
        var haystack = ((inc.category || '') + ' ' + (inc.msg || '')).toLowerCase();
        if (haystack.indexOf(filter.search) === -1) return false;
      }
      return true;
    });

    listWrap.innerHTML = '';

    if (!items.length) {
      listWrap.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No incidents match current filter.' }));
      return;
    }

    items.slice().reverse().forEach(function (inc) {
      var row = Ren.el('div', { cls: 'inc-row' + (inc.resolved ? ' inc-resolved' : '') });

      // Badge + category
      row.appendChild(Ren.badge(inc.severity));
      row.appendChild(Ren.el('span', { cls: 'inc-cat', text: ' ' + (inc.category || '—') }));

      // Message
      row.appendChild(Ren.el('div', { cls: 'inc-msg', text: inc.msg || '' }));

      // Meta row: ts + age + count
      var meta = Ren.el('div', { cls: 'inc-meta' }, [
        Ren.el('span', { text: Ren.fmtTs(inc.ts) + ' · ' + Ren.fmtAge(inc.ts) }),
      ]);
      if (inc.count > 1) {
        meta.appendChild(Ren.el('span', { cls: 'inc-count', text: ' ×' + inc.count }));
      }
      row.appendChild(meta);

      // Recovery suggestion (from AH patterns)
      if (AH && inc.severity <= 1) {
        var state = AH.getState();
        var pat   = state.patterns && state.patterns[inc.category];
        if (pat && pat.count >= 2) {
          row.appendChild(Ren.el('div', { cls: 'inc-suggest', text: '💡 Auto-heal attempted ' + pat.count + 'x for this category' }));
        }
      }

      // Resolve button
      if (!inc.resolved && inc.id && IC.resolve) {
        var btn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Resolve' });
        btn.addEventListener('click', function () { IC.resolve(inc.id); });
        row.appendChild(btn);
      }

      // Recovery suggestion
      if (RO && inc.severity === 0) {
        var simBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm dbg-btn-warn', text: 'Simulate Recovery' });
        simBtn.addEventListener('click', function () {
          var result = RO.simulate({ reason: 'debug-panel-p0' });
          alert('Simulation: ' + JSON.stringify(result && result.steps ? result.steps.length + ' steps' : result, null, 2).slice(0, 300));
        });
        row.appendChild(simBtn);
      }

      listWrap.appendChild(row);
    });
  };

  G.PanelIncidents = PanelIncidents;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
