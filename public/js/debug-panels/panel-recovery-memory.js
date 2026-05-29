(function (G) {
  'use strict';
  if (G.PanelRecoveryMemory) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelRecoveryMemory]';

  function PanelRecoveryMemory(container) {
    this._c     = container;
    this._built = false;
  }

  PanelRecoveryMemory.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🧠 Recovery Memory' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rm-recommend', text: 'Get Recommendation' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'rm-reset', text: 'Reset Memory' }),
    ]);

    var metricsEl   = Ren.el('div', { cls: 'panel-metrics', id: 'rm-metrics' });
    var rcTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Strategy Effectiveness' });
    var rcList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-effectiveness', style: 'max-height:120px;overflow-y:auto;' });
    var blTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Blocked Strategies' });
    var blList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-blocklist', style: 'max-height:80px;overflow-y:auto;' });
    var patTitle    = Ren.el('div', { cls: 'panel-subtitle', text: 'Learned Patterns' });
    var patList     = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-patterns', style: 'max-height:100px;overflow-y:auto;' });
    var histTitle   = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Recovery History' });
    var histList    = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-history', style: 'max-height:140px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metricsEl);
    this._c.appendChild(rcTitle);
    this._c.appendChild(rcList);
    this._c.appendChild(blTitle);
    this._c.appendChild(blList);
    this._c.appendChild(patTitle);
    this._c.appendChild(patList);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);

    toolbar.querySelector('#rm-recommend').addEventListener('click', function () {
      var RM = G.RuntimeRecoveryMemory;
      if (!RM) { alert('RuntimeRecoveryMemory not available'); return; }
      var category = prompt('Enter failure category (e.g. worker-crash):') || 'general';
      var rec = RM.recommend(category);
      alert('Category: ' + category + '\nStrategy: ' + (rec.strategy || 'none') +
            '\nConfidence: ' + rec.confidence + '%\nReason: ' + rec.reason);
    });

    toolbar.querySelector('#rm-reset').addEventListener('click', function () {
      var RM = G.RuntimeRecoveryMemory;
      if (!RM) return;
      if (confirm('Reset all recovery memory? This will erase learned strategy data.')) {
        RM.reset();
        self.refresh();
        alert('Recovery memory cleared.');
      }
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(histList);
  };

  PanelRecoveryMemory.prototype.refresh = function () {
    if (!this._built) return;
    var RM  = G.RuntimeRecoveryMemory;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#rm-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      if (RM) {
        var m = RM.getMetrics();
        [
          ['Recorded',    m.recorded],
          ['Recommended', m.recommended],
          ['Blocked',     m.blocked],
          ['Loaded',      m.loaded],
        ].forEach(function (p) {
          metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] }));
        });
      } else {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeRecoveryMemory not loaded' }));
      }
    }

    // Effectiveness
    var rcEl = this._c.querySelector('#rm-effectiveness');
    if (rcEl && RM) {
      rcEl.innerHTML = '';
      var patterns = RM.getPatterns();
      var cats = Object.keys(patterns);
      if (!cats.length) {
        rcEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No strategy data yet.' }));
      } else {
        cats.forEach(function (cat) {
          var p   = patterns[cat];
          var eff = RM.getEffectiveness(p.bestStrategy);
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: cat }),
            Ren.el('span', { text: '→ ' + p.bestStrategy }),
            Ren.el('span', { cls: 'metric-chip', text: eff + '% effective' }),
          ]);
          rcEl.appendChild(row);
        });
      }
    }

    // Blocklist
    var blEl = this._c.querySelector('#rm-blocklist');
    if (blEl && RM) {
      blEl.innerHTML = '';
      var bl = RM.getBlocklist();
      if (!bl.length) {
        blEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No blocked strategies.' }));
      } else {
        bl.forEach(function (b) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: b.strategy }),
            Ren.el('span', { text: b.reason }),
            Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(b.ts) }),
          ]);
          blEl.appendChild(row);
        });
      }
    }

    // Patterns
    var patEl = this._c.querySelector('#rm-patterns');
    if (patEl && RM) {
      patEl.innerHTML = '';
      var patData = RM.getPatterns();
      Object.keys(patData).forEach(function (cat) {
        var p   = patData[cat];
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: cat }),
          Ren.el('span', { text: p.bestStrategy }),
          Ren.el('span', { cls: 'metric-chip', text: p.confidence + '% confidence' }),
        ]);
        patEl.appendChild(row);
      });
      if (!Object.keys(patData).length) {
        patEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No patterns learned yet.' }));
      }
    }

    // History
    var histEl = this._c.querySelector('#rm-history');
    if (histEl && RM) {
      histEl.innerHTML = '';
      var hist = RM.getHistory(20);
      hist.slice().reverse().forEach(function (rec) {
        var ok  = rec.outcome === 'success';
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rec.ts) }),
          Ren.el('span', { cls: 'tl-type', text: rec.strategy }),
          Ren.el('span', { text: rec.category }),
          Ren.el('span', { cls: 'metric-chip', style: ok ? 'color:#4af' : 'color:#f44',
                           text: rec.outcome }),
        ]);
        histEl.appendChild(row);
      });
      if (!hist.length) histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No recovery history.' }));
    }
  };

  G.PanelRecoveryMemory = PanelRecoveryMemory;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));
