(function (G) {
  'use strict';
  if (G.PanelDeployResilience) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelDeployResilience]';

  function PanelDeployResilience(container) {
    this._c     = container;
    this._built = false;
  }

  PanelDeployResilience.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🚀 Deploy Resilience' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'dr-snapshot', text: 'Pre-Deploy Snapshot' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'dr-rollback', text: 'Mark Rollback' }),
    ]);

    var stateEl  = Ren.el('div', { cls: 'panel-metrics', id: 'dr-state' });
    var histTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Deploy History' });
    var histList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-history', style: 'max-height:160px;overflow-y:auto;' });
    var rbTitle   = Ren.el('div', { cls: 'panel-subtitle', text: 'Rollback Records' });
    var rbList    = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-rollbacks', style: 'max-height:100px;overflow-y:auto;' });
    var staleTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Stale Tabs' });
    var staleEl    = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-stale', style: 'max-height:80px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(stateEl);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);
    this._c.appendChild(rbTitle);
    this._c.appendChild(rbList);
    this._c.appendChild(staleTitle);
    this._c.appendChild(staleEl);

    toolbar.querySelector('#dr-snapshot').addEventListener('click', function () {
      var DR = G.RuntimeDeployResilience;
      if (!DR) { alert('RuntimeDeployResilience not available'); return; }
      DR.capturePreDeploySnapshot().then(function (id) {
        alert(id ? 'Snapshot captured: ' + id : 'Snapshot failed (no RuntimeStateSnapshots?)');
        self.refresh();
      });
    });

    toolbar.querySelector('#dr-rollback').addEventListener('click', function () {
      var DR = G.RuntimeDeployResilience;
      if (!DR) return;
      var reason = prompt('Rollback reason:') || 'debug-panel';
      if (confirm('Mark deploy rollback? Reason: ' + reason)) {
        DR.markRollback(reason);
        self.refresh();
      }
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(histList);
  };

  PanelDeployResilience.prototype.refresh = function () {
    if (!this._built) return;
    var DR  = G.RuntimeDeployResilience;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // State
    var stateEl = this._c.querySelector('#dr-state');
    if (stateEl) {
      stateEl.innerHTML = '';
      if (DR) {
        var state = DR.getState();
        var m     = DR.getMetrics();
        [
          ['Build State',   state.buildState],
          ['Current Build', state.currentBuild || '—'],
          ['Server Build',  state.serverBuild  || '—'],
          ['Health',        DR.getHealthScore() + '%'],
          ['Deploys Seen',  m.deployDetected],
          ['Rollbacks',     m.rollbacks],
          ['Stale Tabs',    m.staleTabs],
        ].forEach(function (p) {
          var chip = Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] });
          if (p[0] === 'Build State' && p[1] === 'ROLLBACK') chip.style.color = '#f44';
          if (p[0] === 'Build State' && p[1] === 'STALE')    chip.style.color = '#fa0';
          stateEl.appendChild(chip);
        });
      } else {
        stateEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeDeployResilience not loaded' }));
      }
    }

    // Deploy history
    var histEl = this._c.querySelector('#dr-history');
    if (histEl && DR) {
      histEl.innerHTML = '';
      var hist = DR.getDeployHistory().slice().reverse();
      hist.forEach(function (rec) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rec.ts) }),
          Ren.el('span', { text: (rec.prevBuild || '?').slice(0, 8) + ' → ' + (rec.newBuild || '?').slice(0, 8) }),
          Ren.el('span', { cls: 'metric-chip', text: 'stale tabs: ' + (rec.tabStale || 0) }),
        ]);
        histEl.appendChild(row);
      });
      if (!hist.length) histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No deploy events recorded.' }));
    }

    // Rollbacks
    var rbEl = this._c.querySelector('#dr-rollbacks');
    if (rbEl && DR) {
      rbEl.innerHTML = '';
      var rbs = DR.getRollbacks();
      rbs.forEach(function (rb) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rb.ts) }),
          Ren.el('span', { cls: 'tl-type', text: rb.reason }),
          Ren.el('span', { text: rb.buildId || '—' }),
        ]);
        rbEl.appendChild(row);
      });
      if (!rbs.length) rbEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No rollbacks recorded.' }));
    }

    // Stale tabs
    var staleEl = this._c.querySelector('#dr-stale');
    if (staleEl && DR) {
      staleEl.innerHTML = '';
      var staleTabs = DR.getStaleTabs();
      staleTabs.forEach(function (id) {
        staleEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [ Ren.el('span', { text: id }) ]));
      });
      if (!staleTabs.length) staleEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No stale tabs.' }));
    }
  };

  G.PanelDeployResilience = PanelDeployResilience;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));
