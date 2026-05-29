(function (G) {
  'use strict';
  if (G.PanelTabMesh) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelTabMesh]';

  function PanelTabMesh(container) {
    this._c     = container;
    this._built = false;
  }

  PanelTabMesh.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🕸 Tab Mesh v2.0' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-lock',    text: 'Lock All Tabs' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-reclaim', text: 'Reclaim Orphans' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-refresh', text: 'Refresh' }),
    ]);

    var statusStrip  = Ren.el('div', { cls: 'panel-metrics', id: 'tm-status' });
    var tabsTitle    = Ren.el('div', { cls: 'panel-subtitle', text: 'Connected Tabs' });
    var tabsList     = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-tabs', style: 'max-height:120px;overflow-y:auto;' });
    var wlTitle      = Ren.el('div', { cls: 'panel-subtitle', text: 'Workload Map' });
    var wlList       = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-wl', style: 'max-height:120px;overflow-y:auto;' });
    var thermalTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Thermal + Memory Pressure' });
    var thermalEl    = Ren.el('div', { cls: 'panel-metrics', id: 'tm-thermal' });
    var incTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Cross-Tab Incidents (last 20)' });
    var incList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-incidents', style: 'max-height:140px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statusStrip);
    this._c.appendChild(tabsTitle);
    this._c.appendChild(tabsList);
    this._c.appendChild(wlTitle);
    this._c.appendChild(wlList);
    this._c.appendChild(thermalTitle);
    this._c.appendChild(thermalEl);
    this._c.appendChild(incTitle);
    this._c.appendChild(incList);

    toolbar.querySelector('#tm-lock').addEventListener('click', function () {
      var TM = G.RuntimeTabMesh;
      if (!TM) { alert('RuntimeTabMesh not available'); return; }
      if (confirm('Lock all connected tabs?')) TM.lockAllTabs('debug-panel');
    });

    toolbar.querySelector('#tm-reclaim').addEventListener('click', function () {
      var TM = G.RuntimeTabMesh;
      if (!TM) return;
      var n = TM.reclaimOrphanedWorkloads();
      alert('Reclaimed ' + n + ' orphaned workload(s).');
      self.refresh();
    });

    toolbar.querySelector('#tm-refresh').addEventListener('click', function () { self.refresh(); });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(incList);
  };

  PanelTabMesh.prototype.refresh = function () {
    if (!this._built) return;
    var TM  = G.RuntimeTabMesh;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status strip
    var statusEl = this._c.querySelector('#tm-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (TM) {
        var s = TM.status();
        [
          ['Version',   s.version],
          ['Leader',    s.isLeader ? 'YES' : 'no'],
          ['Tabs',      s.tabs],
          ['Locked',    s.locked ? 'YES' : 'no'],
          ['Workloads', s.workloads],
          ['Incidents', s.incidents],
          ['Thermal',   s.thermalLevel],
        ].forEach(function (p) {
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] }));
        });
      } else {
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeTabMesh not loaded' }));
      }
    }

    // Tabs list
    var tabsEl = this._c.querySelector('#tm-tabs');
    if (tabsEl && TM) {
      tabsEl.innerHTML = '';
      TM.getTabs().forEach(function (tab) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: tab.self ? '★ ' : '○ ' }),
          Ren.el('span', { text: tab.id }),
          tab.isLeader ? Ren.el('span', { cls: 'metric-chip', text: 'LEADER' }) : null,
          Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(tab.ts) }),
        ].filter(Boolean));
        tabsEl.appendChild(row);
      });
      if (!TM.getTabs().length) tabsEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No other tabs detected.' }));
    }

    // Workload map
    var wlEl = this._c.querySelector('#tm-wl');
    if (wlEl && TM) {
      wlEl.innerHTML = '';
      var wl = TM.getWorkloadMap();
      wl.slice(-15).forEach(function (w) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: w.type }),
          Ren.el('span', { cls: 'metric-chip', text: w.status }),
          Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(w.ts) }),
        ]);
        wlEl.appendChild(row);
      });
      if (!wl.length) wlEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No active workloads.' }));
    }

    // Thermal + memory
    var thermalEl = this._c.querySelector('#tm-thermal');
    if (thermalEl && TM) {
      thermalEl.innerHTML = '';
      var thermal = TM.getThermalState();
      var memMap  = TM.getMemoryPressureMap();
      var memEntries = Object.keys(memMap);
      thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Thermal: ' + thermal.level }));
      thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Memory tabs: ' + memEntries.length }));
      memEntries.slice(0, 5).forEach(function (id) {
        thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: id.slice(0, 10) + ': ' + memMap[id] }));
      });
    }

    // Incident history
    var incEl = this._c.querySelector('#tm-incidents');
    if (incEl && TM) {
      incEl.innerHTML = '';
      var incidents = TM.getIncidentHistory().slice(-20).reverse();
      incidents.forEach(function (inc) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(inc.ts) }),
          Ren.el('span', { cls: 'tl-type', text: inc.type || '—' }),
          Ren.el('span', { cls: 'metric-chip', text: inc.severity || '?' }),
          Ren.el('span', { text: 'from: ' + (inc.fromTab || '?').slice(0, 12) }),
        ]);
        incEl.appendChild(row);
      });
      if (!incidents.length) incEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No cross-tab incidents.' }));
    }
  };

  G.PanelTabMesh = PanelTabMesh;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));
