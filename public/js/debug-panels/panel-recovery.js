(function (G) {
  'use strict';
  if (G.PanelRecovery) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelRecovery]';

  function PanelRecovery(container) {
    this._c     = container;
    this._built = false;
  }

  PanelRecovery.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🔄 Recovery & Healing' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-simulate', text: 'Simulate Recovery' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'rec-safemode', text: 'Enter Safe Mode' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-exit-safe', text: 'Exit Safe Mode' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-export', text: 'Export History' }),
    ]);

    // Status strip
    var status   = Ren.el('div', { cls: 'panel-metrics', id: 'rec-status' });

    // Dep graph
    var graphTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Subsystem Recovery Order' });
    var graphEl    = Ren.el('div', { cls: 'rec-graph', id: 'rec-graph', style: 'overflow-x:auto;padding:8px 0;' });

    // Healing actions
    var healTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Healing Actions' });
    var healList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-heals', style: 'max-height:160px;overflow-y:auto;' });

    // Recovery history
    var histTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recovery History' });
    var histList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-history', style: 'max-height:160px;overflow-y:auto;' });

    // Governance quarantine
    var govTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Governance Violations' });
    var govList   = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-gov', style: 'max-height:120px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(status);
    this._c.appendChild(graphTitle);
    this._c.appendChild(graphEl);
    this._c.appendChild(healTitle);
    this._c.appendChild(healList);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);
    this._c.appendChild(govTitle);
    this._c.appendChild(govList);

    // Controls
    toolbar.querySelector('#rec-simulate').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('RuntimeRecoveryOrchestrator not available'); return; }
      var result = RO.simulate({ reason: 'debug-panel-simulate' });
      var steps  = result && result.steps ? result.steps.length : 'N/A';
      alert('Simulation complete: ' + steps + ' recovery steps planned.');
    });

    toolbar.querySelector('#rec-safemode').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('Not available'); return; }
      if (confirm('Enter safe mode? This disables optimizer + predictive loader.')) {
        RO.enterSafeMode();
      }
    });

    toolbar.querySelector('#rec-exit-safe').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('Not available'); return; }
      RO.exitSafeMode();
    });

    toolbar.querySelector('#rec-export').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      var Ex = G.RuntimeDebugExport;
      if (RO && Ex) Ex.exportJson(RO.getHistory(), 'recovery-history');
    });

    this._built = true;
  };

  PanelRecovery.prototype.refresh = function () {
    if (!this._built) return;
    var RO  = G.RuntimeRecoveryOrchestrator;
    var AH  = G.RuntimeAutonomousHealing;
    var Gov = G.RuntimeGovernance;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status
    var statusEl = this._c.querySelector('#rec-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (RO) {
        var stats    = RO.getStats();
        var safeMode = RO.isSafeMode();
        var active   = RO.getActive();
        [
          ['Safe Mode', safeMode ? '🔴 YES' : '🟢 No'],
          ['Active Recovery', active ? '⚡ Running' : 'Idle'],
          ['Total Recoveries', stats.total || 0],
          ['Subsystems', RO.getRecoveryOrder().length],
        ].forEach(function (pair) {
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip' + (pair[1] === '🔴 YES' ? ' chip-warn' : ''), text: pair[0] + ': ' + pair[1] }));
        });
      }
      if (AH) {
        var ahState = AH.getState();
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Heals: ' + (ahState.stats && ahState.stats.total || 0) }));
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Rollbacks: ' + (ahState.stats && ahState.stats.rollbacks || 0) }));
      }
    }

    // Dep graph (compact chip row)
    var graphEl = this._c.querySelector('#rec-graph');
    if (graphEl && RO) {
      graphEl.innerHTML = '';
      var order = RO.getRecoveryOrder();
      order.forEach(function (id, i) {
        var chip = Ren.el('span', { cls: 'rec-chip', text: (i + 1) + '. ' + id, style: 'margin:2px;display:inline-block;' });
        graphEl.appendChild(chip);
        if (i < order.length - 1) graphEl.appendChild(Ren.el('span', { text: '→', style: 'color:#888;margin:0 2px;' }));
      });
    }

    // Healing actions
    var healEl = this._c.querySelector('#rec-heals');
    if (healEl && AH) {
      healEl.innerHTML = '';
      var heals = AH.getTelemetry().slice(-20).reverse();
      if (!heals.length) {
        healEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No healing actions recorded.' }));
      } else {
        heals.forEach(function (h) {
          healEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(h.ts) }),
            Ren.el('span', { cls: 'tl-type', text: h.phase + ' · ' + (h.category || '—') }),
            Ren.el('span', { cls: h.ok === false ? 'chip-warn' : 'metric-chip', text: h.ok === false ? '✗ fail' : '✓ ok' }),
          ]));
        });
      }
    }

    // Recovery history
    var histEl = this._c.querySelector('#rec-history');
    if (histEl && RO) {
      histEl.innerHTML = '';
      var history = RO.getHistory().slice(-10).reverse();
      if (!history.length) {
        histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No recoveries recorded.' }));
      } else {
        history.forEach(function (h) {
          histEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(h.ts) }),
            Ren.el('span', { cls: 'tl-type', text: h.reason || '—' }),
            Ren.el('span', { cls: 'metric-chip', text: (h.steps || []).length + ' steps' }),
            Ren.el('span', { cls: h.ok ? 'metric-chip' : 'chip-warn', text: h.ok ? '✓' : '✗' }),
          ]));
        });
      }
    }

    // Governance
    var govEl = this._c.querySelector('#rec-gov');
    if (govEl && Gov) {
      govEl.innerHTML = '';
      var violations = Gov.getViolations().slice(-10).reverse();
      if (!violations.length) {
        govEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No governance violations.' }));
      } else {
        violations.forEach(function (v) {
          govEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(v.ts) }),
            Ren.el('span', { cls: 'tl-type', text: v.policy + ': ' + (v.msg || '') }),
          ]));
        });
      }
    }
  };

  G.PanelRecovery = PanelRecovery;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
