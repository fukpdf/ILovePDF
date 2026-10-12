(function (G) {
  'use strict';
  if (G.PanelTraces) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelTraces]';

  function PanelTraces(container) {
    this._c     = container;
    this._built = false;
    this._diffA = null;
    this._diffB = null;
  }

  PanelTraces.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🔍 Traces & Snapshots' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tr-export-snaps', text: 'Export Snapshots' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tr-take-snap',   text: 'Take Snapshot Now' }),
    ]);

    // Trace stats
    var statsSection = Ren.el('div', { cls: 'panel-metrics', id: 'tr-stats' });

    // Active traces
    var activeTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Active Traces' });
    var activeList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-active', style: 'max-height:100px;overflow-y:auto;' });

    // Trace telemetry — slow paths
    var slowTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Traces (slow paths highlighted)' });
    var slowList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-slow', style: 'height:200px;overflow-y:auto;' });

    // Snapshots
    var snapTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Snapshots' });
    var snapList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-snaps', style: 'max-height:200px;overflow-y:auto;' });

    // Diff area
    var diffTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Snapshot Diff (select two)' });
    var diffArea  = Ren.el('pre', { id: 'tr-diff', style: 'background:#1a1a2e;padding:8px;border-radius:4px;overflow:auto;max-height:200px;font-size:11px;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statsSection);
    this._c.appendChild(activeTitle);
    this._c.appendChild(activeList);
    this._c.appendChild(slowTitle);
    this._c.appendChild(slowList);
    this._c.appendChild(snapTitle);
    this._c.appendChild(snapList);
    this._c.appendChild(diffTitle);
    this._c.appendChild(diffArea);

    toolbar.querySelector('#tr-export-snaps').addEventListener('click', function () {
      var SS = G.RuntimeStateSnapshots;
      var Ex = G.RuntimeDebugExport;
      if (SS && Ex) Ex.exportJson(SS.list(), 'snapshots-list');
    });

    toolbar.querySelector('#tr-take-snap').addEventListener('click', function () {
      var SS = G.RuntimeStateSnapshots;
      if (!SS) { alert('RuntimeStateSnapshots not available'); return; }
      var s = SS.take('manual-debug', false);
      alert('Snapshot taken: ' + (s && s.id ? s.id : 'ok'));
    });

    this._built = true;
  };

  PanelTraces.prototype.refresh = function () {
    if (!this._built) return;
    var TE  = G.RuntimeTraceEngine;
    var SS  = G.RuntimeStateSnapshots;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    // Stats
    var statsEl = this._c.querySelector('#tr-stats');
    if (statsEl && TE) {
      statsEl.innerHTML = '';
      var stats = TE.getStats();
      [
        ['Total Traces',  stats.total     || 0],
        ['Active',        Object.keys(TE.getActive()).length],
        ['Slow Paths',    stats.slowPaths  || 0],
        ['p50 ms',        stats.p50        ? stats.p50.toFixed(1) : '—'],
        ['p90 ms',        stats.p90        ? stats.p90.toFixed(1) : '—'],
        ['p99 ms',        stats.p99        ? stats.p99.toFixed(1) : '—'],
      ].forEach(function (pair) {
        statsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Active traces
    var activeEl = this._c.querySelector('#tr-active');
    if (activeEl && TE) {
      activeEl.innerHTML = '';
      var active = TE.getActive();
      var ids    = Object.keys(active);
      if (!ids.length) {
        activeEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No active traces.' }));
      } else {
        ids.forEach(function (id) {
          var tr = active[id];
          activeEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: tr.name || id }),
            Ren.el('span', { cls: 'metric-chip', text: Math.round(Date.now() - (tr.startTs || Date.now())) + 'ms' }),
          ]));
        });
      }
    }

    // Slow traces from telemetry
    var slowEl = this._c.querySelector('#tr-slow');
    if (slowEl && TE) {
      slowEl.innerHTML = '';
      var tels = TE.getTelemetry().slice(-30).reverse();
      if (!tels.length) {
        slowEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No traces recorded.' }));
      } else {
        tels.forEach(function (tr) {
          var isSlow = tr.durationMs && tr.durationMs > 500;
          slowEl.appendChild(Ren.el('div', { cls: 'tl-row' + (isSlow ? ' tr-slow' : '') }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(tr.ts) }),
            Ren.el('span', { cls: 'tl-type', text: tr.name || '—' }),
            Ren.el('span', { cls: isSlow ? 'chip-warn' : 'metric-chip', text: (tr.durationMs || 0) + 'ms' }),
            isSlow ? Ren.el('span', { text: ' ⚠ SLOW' }) : null,
          ].filter(Boolean)));
        });
      }
    }

    // Snapshots
    var snapEl = this._c.querySelector('#tr-snaps');
    if (snapEl && SS) {
      snapEl.innerHTML = '';
      var snaps = SS.list().slice().reverse();
      if (!snaps.length) {
        snapEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No snapshots taken.' }));
      } else {
        snaps.forEach(function (s) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(s.ts) }),
            Ren.el('span', { cls: 'tl-type', text: s.label || s.id }),
            s.isCheckpoint ? Ren.el('span', { cls: 'metric-chip', text: '📌 checkpoint' }) : null,
            Ren.el('span', { cls: 'metric-chip', text: 'crc: ' + (s.checksum || '—').slice(0, 8) }),
          ].filter(Boolean));

          // Select for diff
          var selABtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'A' });
          var selBBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'B' });
          selABtn.addEventListener('click', function () { self._diffA = s.id; self._runDiff(); });
          selBBtn.addEventListener('click', function () { self._diffB = s.id; self._runDiff(); });

          // Export snapshot
          var expBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Export' });
          expBtn.addEventListener('click', function () {
            var Ex = G.RuntimeDebugExport;
            var full = SS.get(s.id);
            if (Ex && full) Ex.exportJson(full, 'snapshot-' + s.id);
          });

          row.appendChild(selABtn);
          row.appendChild(selBBtn);
          row.appendChild(expBtn);
          snapEl.appendChild(row);
        });
      }
    }
  };

  PanelTraces.prototype._runDiff = function () {
    var SS      = G.RuntimeStateSnapshots;
    var Ren     = G.RuntimeDebugRenderer;
    var diffEl  = this._c.querySelector('#tr-diff');
    if (!SS || !Ren || !diffEl || !this._diffA || !this._diffB) {
      if (diffEl) diffEl.textContent = 'Select snapshot A and B to diff.';
      return;
    }
    try {
      var result = SS.diff(this._diffA, this._diffB);
      diffEl.textContent = JSON.stringify(result, null, 2).slice(0, 3000);
    } catch (e) {
      diffEl.textContent = 'Diff error: ' + e.message;
    }
  };

  G.PanelTraces = PanelTraces;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
