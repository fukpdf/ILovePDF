(function (G) {
  'use strict';
  if (G.PanelPerformance) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelPerformance]';

  function PanelPerformance(container) {
    this._c         = container;
    this._built     = false;
    this._heapHist  = [];
    this._fpsHist   = [];
    this._qHist     = {};
  }

  PanelPerformance.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '⚡ Performance & Workload' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'perf-export', text: 'Export Profile' }),
    ]);

    // Perf metrics
    var perfMetrics = Ren.el('div', { cls: 'panel-metrics', id: 'perf-metrics' });

    // Heap sparkline
    var heapSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Heap Usage (MB)' }),
      Ren.el('div', { id: 'perf-heap-spark' }),
    ]);

    // Session stability
    var stabSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Session Stability' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-stability' }),
    ]);

    // Workload section
    var wlSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Workload Intelligence' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-workload' }),
    ]);

    // AI section
    var aiSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Adaptive AI Predictions' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-ai' }),
    ]);

    // Bundle dormancy
    var bundSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Bundle Usage' }),
      Ren.el('div', { cls: 'panel-list-wrap', id: 'perf-bundles', style: 'max-height:120px;overflow-y:auto;' }),
    ]);

    // Top tools
    var toolSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Top Tools (AI Model)' }),
      Ren.el('div', { cls: 'panel-list-wrap', id: 'perf-tools', style: 'max-height:120px;overflow-y:auto;' }),
    ]);

    this._c.appendChild(toolbar);
    this._c.appendChild(perfMetrics);
    this._c.appendChild(heapSection);
    this._c.appendChild(stabSection);
    this._c.appendChild(wlSection);
    this._c.appendChild(aiSection);
    this._c.appendChild(bundSection);
    this._c.appendChild(toolSection);

    toolbar.querySelector('#perf-export').addEventListener('click', function () {
      var PP = G.RuntimePerformanceProfiler;
      var Ex = G.RuntimeDebugExport;
      if (PP && Ex) Ex.exportJson(PP.getProfile(), 'performance-profile');
    });

    this._built = true;
  };

  PanelPerformance.prototype.refresh = function () {
    if (!this._built) return;
    var PP  = G.RuntimePerformanceProfiler;
    var WI  = G.RuntimeWorkloadIntelligence;
    var SS  = G.RuntimeSessionStability;
    var AI  = G.RuntimeAdaptiveAI;
    var AB  = G.RuntimeAdaptiveBundles;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Perf metrics
    var pmEl = this._c.querySelector('#perf-metrics');
    if (pmEl && PP) {
      pmEl.innerHTML = '';
      var m = PP.getMetrics();
      [
        ['FPS',          m.fps        || '—'],
        ['Frame Drops',  m.frameDrops || 0],
        ['LongTasks',    m.longTasks  || 0],
        ['Heap MB',      m.heapMb     ? m.heapMb.toFixed(1) : '—'],
        ['Heap Limit MB',m.heapLimitMb ? m.heapLimitMb.toFixed(1) : '—'],
        ['Samples',      m.samples    || 0],
      ].forEach(function (pair) {
        pmEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });

      // Track sparkline history
      if (m.heapMb) { this._heapHist.push(m.heapMb); if (this._heapHist.length > 60) this._heapHist.shift(); }
      if (m.fps)    { this._fpsHist.push(m.fps);      if (this._fpsHist.length  > 60) this._fpsHist.shift(); }
    }

    // Heap sparkline
    var sparkEl = this._c.querySelector('#perf-heap-spark');
    if (sparkEl && this._heapHist.length > 1) {
      sparkEl.innerHTML = '';
      sparkEl.appendChild(Ren.sparkline(this._heapHist, 280, 40, '#4af'));
      sparkEl.appendChild(Ren.el('span', { style: 'margin-left:8px;font-size:11px;color:#aaa;', text: 'Last ' + this._heapHist.length + ' samples' }));
    }

    // Session stability
    var stabEl = this._c.querySelector('#perf-stability');
    if (stabEl && SS) {
      stabEl.innerHTML = '';
      var st = SS.getState();
      var LEVEL_COLORS = ['#4af', '#4fa', '#fa0', '#f84', '#f44'];
      [
        ['Age',         Math.floor(st.ageMin || 0) + ' min'],
        ['Tier',        st.ageTier || '—'],
        ['Level',       st.levelName || '—'],
        ['Heap Rate',   st.heapRate  ? st.heapRate.toFixed(2) + ' MB/min'    : '—'],
        ['Event Rate',  st.eventRate ? st.eventRate.toFixed(1) + ' ev/min'   : '—'],
        ['Incident Rate', st.incidentRate ? st.incidentRate.toFixed(2) + '/min' : '—'],
        ['Sweeps',      st.sweeps || 0],
      ].forEach(function (pair) {
        var extra = (pair[0] === 'Level') ? ';background:' + (LEVEL_COLORS[st.level] || '#aaa') : '';
        stabEl.appendChild(Ren.el('span', { cls: 'metric-chip', style: extra, text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Workload
    var wlEl = this._c.querySelector('#perf-workload');
    if (wlEl && WI) {
      wlEl.innerHTML = '';
      var ws = WI.getState();
      var families = WI.getFamilies();
      [
        ['Running',   ws.running   || 0],
        ['Throttled', ws.throttled || 0],
        ['Starved',   ws.starved   || 0],
      ].forEach(function (pair) {
        wlEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      Object.keys(families).forEach(function (fam) {
        var f = families[fam];
        wlEl.appendChild(Ren.el('span', {
          cls:  'metric-chip',
          text: fam + ': Q=' + (f.queue || 0) + ' R=' + (f.running || 0) + ' T=' + (f.thermal || 0),
        }));
      });
    }

    // Adaptive AI
    var aiEl = this._c.querySelector('#perf-ai');
    if (aiEl && AI) {
      aiEl.innerHTML = '';
      var tier    = AI.getDeviceTier();
      var thermal = AI.predictThermal();
      [
        ['Device Tier', tier],
        ['Predicted Thermal', thermal],
        ['Should Throttle', AI.shouldThrottle ? AI.shouldThrottle('?') : '—'],
      ].forEach(function (pair) {
        aiEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      // Top 5 tools
      var tops = AI.getTopTools ? AI.getTopTools(5) : [];
      if (tops.length) {
        aiEl.appendChild(Ren.el('span', { text: '  Top tools: ' }));
        tops.forEach(function (t) {
          aiEl.appendChild(Ren.el('span', { cls: 'rec-chip', text: t.id + ' ×' + t.count }));
        });
      }
    }

    // Bundle dormancy
    var bundEl = this._c.querySelector('#perf-bundles');
    if (bundEl && AB) {
      bundEl.innerHTML = '';
      var dormant = AB.getDormantBundles ? AB.getDormantBundles() : [];
      var plan    = AB.getBundlePlan ? AB.getBundlePlan() : null;
      if (plan) {
        bundEl.appendChild(Ren.el('div', { cls: 'tl-row', text: 'Device plan: ' + plan.tier }));
      }
      if (!dormant.length) {
        bundEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No dormant bundles.' }));
      } else {
        dormant.forEach(function (b) {
          bundEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'chip-warn', text: '💤 Dormant: ' + b }),
          ]));
        });
      }
    }

    // Top tools AI model
    var toolEl = this._c.querySelector('#perf-tools');
    if (toolEl && AI && AI.getTopTools) {
      toolEl.innerHTML = '';
      var tools = AI.getTopTools(10);
      if (!tools.length) {
        toolEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No tool usage data yet.' }));
      } else {
        tools.forEach(function (t) {
          toolEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: t.id }),
            Ren.el('span', { cls: 'metric-chip', text: 'session ×' + t.sessionCount }),
            Ren.el('span', { cls: 'metric-chip', text: 'lifetime ×' + t.lifetimeCount }),
          ]));
        });
      }
    }
  };

  G.PanelPerformance = PanelPerformance;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
