(function (G) {
  'use strict';
  if (G.PanelCrashSurvival) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelCrashSurvival]';

  function PanelCrashSurvival(container) {
    this._c     = container;
    this._built = false;
  }

  PanelCrashSurvival.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '💥 Crash Survival' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'cs-recover',   text: 'Run Recovery' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'cs-clean-exit', text: 'Mark Clean Exit' }),
    ]);

    var statusEl = Ren.el('div', { cls: 'panel-metrics', id: 'cs-status' });

    var crashTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Last Crash Record' });
    var crashEl    = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-crash', style: 'max-height:80px;overflow-y:auto;' });

    var corrTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Incident Correlation Patterns' });
    var corrEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-corr', style: 'max-height:120px;overflow-y:auto;' });

    var cascTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Cascade Patterns' });
    var cascEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-casc', style: 'max-height:100px;overflow-y:auto;' });

    var rootTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Top Root Causes' });
    var rootEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-root', style: 'max-height:100px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statusEl);
    this._c.appendChild(crashTitle);
    this._c.appendChild(crashEl);
    this._c.appendChild(corrTitle);
    this._c.appendChild(corrEl);
    this._c.appendChild(cascTitle);
    this._c.appendChild(cascEl);
    this._c.appendChild(rootTitle);
    this._c.appendChild(rootEl);

    toolbar.querySelector('#cs-recover').addEventListener('click', function () {
      var CS = G.RuntimeCrashSurvival;
      if (!CS) { alert('RuntimeCrashSurvival not available'); return; }
      CS.recover().then(function (r) {
        alert('Recovery: ' + JSON.stringify(r));
        self.refresh();
      }).catch(function (e) { alert('Recovery error: ' + e.message); });
    });

    toolbar.querySelector('#cs-clean-exit').addEventListener('click', function () {
      var CS = G.RuntimeCrashSurvival;
      if (!CS) return;
      CS.markCleanExit();
      alert('Clean exit marker written. Session will not be treated as a crash on next load.');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) {
      G.RuntimeDebugMobile.makeTouchScrollable(corrEl);
      G.RuntimeDebugMobile.makeTouchScrollable(cascEl);
    }
  };

  PanelCrashSurvival.prototype.refresh = function () {
    if (!this._built) return;
    var CS  = G.RuntimeCrashSurvival;
    var IC  = G.RuntimeIncidentCorrelation;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status strip
    var statusEl = this._c.querySelector('#cs-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (CS) {
        var m = CS.getMetrics();
        [
          ['Crashed',     CS.hasCrashed() ? 'YES' : 'no'],
          ['Crashes',     m.crashes],
          ['Recoveries',  m.recoveries],
          ['Wkr Storms',  m.workerStorms],
          ['Panics',      m.panics],
        ].forEach(function (p) {
          var chip = Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] });
          if (p[0] === 'Crashed' && CS.hasCrashed()) chip.style.color = '#f44';
          statusEl.appendChild(chip);
        });
        // IC metrics
        if (IC) {
          var im = IC.getMetrics();
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Ingested: ' + im.ingested }));
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Clusters: ' + im.clusters }));
        }
      } else {
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeCrashSurvival not loaded' }));
      }
    }

    // Last crash
    var crashEl = this._c.querySelector('#cs-crash');
    if (crashEl && CS) {
      crashEl.innerHTML = '';
      var crash = CS.getLastCrash();
      if (crash) {
        crashEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: crash.type }),
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(crash.ts) }),
        ]));
      } else {
        crashEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No crash recorded.' }));
      }
    }

    // Correlation patterns
    var corrEl = this._c.querySelector('#cs-corr');
    if (corrEl && IC) {
      corrEl.innerHTML = '';
      var patterns = IC.getPatterns();
      if (!patterns.length) {
        corrEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No correlation patterns yet.' }));
      } else {
        patterns.slice(-10).forEach(function (p) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'metric-chip', text: p.type }),
            Ren.el('span', { cls: 'tl-type', text: p.category }),
            Ren.el('span', { text: 'x' + p.count }),
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(p.lastTs) }),
          ]);
          corrEl.appendChild(row);
        });
      }
    } else if (corrEl) {
      corrEl.innerHTML = '';
      corrEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'RuntimeIncidentCorrelation not loaded.' }));
    }

    // Cascade patterns
    var cascEl = this._c.querySelector('#cs-casc');
    if (cascEl && IC) {
      cascEl.innerHTML = '';
      var cascades = IC.getCascades();
      if (!cascades.length) {
        cascEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No cascade patterns yet.' }));
      } else {
        cascades.slice(-8).forEach(function (c) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: c.trigger + ' → ' + c.effect }),
            Ren.el('span', { cls: 'metric-chip', text: 'x' + c.count }),
            Ren.el('span', { text: Math.round(c.avgDelayMs) + 'ms avg' }),
          ]);
          cascEl.appendChild(row);
        });
      }
    }

    // Root causes
    var rootEl = this._c.querySelector('#cs-root');
    if (rootEl && IC) {
      rootEl.innerHTML = '';
      var roots = IC.getTopRootCauses(8);
      if (!roots.length) {
        rootEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No root causes identified.' }));
      } else {
        roots.forEach(function (r) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type',     text: r.category }),
            Ren.el('span', { cls: 'metric-chip', text: 'x' + r.count }),
            Ren.el('span', { cls: 'metric-chip', text: r.severity }),
          ]);
          rootEl.appendChild(row);
        });
      }
    }
  };

  G.PanelCrashSurvival = PanelCrashSurvival;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));
