(function (G) {
  'use strict';
  if (G.PanelBlackbox) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelBlackbox]';

  function PanelBlackbox(container) {
    this._c     = container;
    this._built = false;
  }

  PanelBlackbox.prototype.init = function () {
    var Ren  = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '⚫ Blackbox Recorder' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-pause',   text: 'Pause Recording' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-export',  text: 'Export Buffer' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-replay',  text: 'Send to Replay' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-session', text: 'Save Session' }),
    ]);

    // Buffer gauge
    var gaugeWrap = Ren.el('div', { cls: 'panel-metrics', id: 'bb-gauge-wrap' });

    // Metrics strip
    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'bb-metrics' });

    // Sessions list
    var sessTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Saved Sessions' });
    var sessList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-sessions', style: 'max-height:120px;overflow-y:auto;' });

    // Recent exports
    var expTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Exports' });
    var expList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-exports', style: 'max-height:120px;overflow-y:auto;' });

    // Event preview
    var evTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Buffer Preview (last 20 events)' });
    var evList   = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-evlist', style: 'height:240px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(gaugeWrap);
    this._c.appendChild(metrics);
    this._c.appendChild(sessTitle);
    this._c.appendChild(sessList);
    this._c.appendChild(expTitle);
    this._c.appendChild(expList);
    this._c.appendChild(evTitle);
    this._c.appendChild(evList);

    // Controls
    var _paused = false;
    toolbar.querySelector('#bb-pause').addEventListener('click', function (e) {
      var BB = G.RuntimeBlackbox;
      if (!BB) return;
      _paused = !_paused;
      _paused ? BB.pause() : BB.resume();
      e.target.textContent = _paused ? 'Resume Recording' : 'Pause Recording';
    });

    toolbar.querySelector('#bb-export').addEventListener('click', function () {
      var BB = G.RuntimeBlackbox;
      var Ex = G.RuntimeDebugExport;
      if (!BB || !Ex) return;
      var result = BB.export('manual-' + Date.now().toString(36));
      if (result && result.url) {
        var a = document.createElement('a');
        a.href = result.url; a.download = 'blackbox-' + Date.now().toString(36) + '.json';
        a.click();
      }
    });

    toolbar.querySelector('#bb-replay').addEventListener('click', function () {
      var BB = G.RuntimeBlackbox;
      if (!BB) return;
      var count = BB.handoffToReplay({ lastMinutes: 5 });
      alert('Sent ' + count + ' events to RuntimeReplayEngine.');
    });

    toolbar.querySelector('#bb-session').addEventListener('click', function () {
      var BB    = G.RuntimeBlackbox;
      if (!BB) return;
      var label = 'session-' + Date.now().toString(36);
      BB.saveSession(label);
      alert('Session saved: ' + label);
      self.refresh();
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(evList);
  };

  PanelBlackbox.prototype.refresh = function () {
    if (!this._built) return;
    var BB  = G.RuntimeBlackbox;
    var RE  = G.RuntimeReplayEngine;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren || !BB) return;

    var m       = BB.getMetrics();
    var count   = BB.getCount();
    var CAP     = 10000;

    // Gauge
    var gaugeEl = this._c.querySelector('#bb-gauge-wrap');
    if (gaugeEl) {
      var pct = Math.round(count / CAP * 100);
      gaugeEl.innerHTML = '';
      var bar = Ren.el('div', { cls: 'bb-gauge-bar', style: 'width:' + pct + '%;background:' + (pct > 80 ? '#f44' : pct > 50 ? '#fa0' : '#4af') + ';height:8px;border-radius:4px;' });
      var wrap = Ren.el('div', { style: 'background:#333;border-radius:4px;overflow:hidden;flex:1;margin:0 8px;' }, [bar]);
      gaugeEl.appendChild(Ren.el('span', { text: 'Buffer: ' }));
      gaugeEl.appendChild(wrap);
      gaugeEl.appendChild(Ren.el('span', { text: count + '/' + CAP + ' (' + pct + '%)' }));
    }

    // Metrics
    var metricsEl = this._c.querySelector('#bb-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      [
        ['Events',    count],
        ['Recorded',  m.recorded  || 0],
        ['Evicted',   m.evicted   || 0],
        ['Exported',  m.exported  || 0],
        ['Sessions',  BB.getSessions().length],
        ['Panics',    m.panics    || 0],
        ['P0 Exports', m.p0exports || 0],
      ].forEach(function (pair) {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Sessions
    var sessEl = this._c.querySelector('#bb-sessions');
    if (sessEl) {
      sessEl.innerHTML = '';
      BB.getSessions().forEach(function (sess) {
        var row = Ren.el('div', { cls: 'bb-sess-row' }, [
          Ren.el('span', { text: sess.label || sess.id }),
          Ren.el('span', { cls: 'metric-chip', text: (sess.count || 0) + ' events' }),
          Ren.el('span', { text: Ren.fmtTs(sess.ts) }),
        ]);
        sessEl.appendChild(row);
      });
      if (!BB.getSessions().length) {
        sessEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No saved sessions.' }));
      }
    }

    // Event preview
    var evEl = this._c.querySelector('#bb-evlist');
    if (evEl) {
      evEl.innerHTML = '';
      var events = BB.query({}) || [];
      events.slice(-20).reverse().forEach(function (ev) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(ev.ts) }),
          Ren.el('span', { cls: 'tl-type', text: ev.type || '—' }),
        ]);
        evEl.appendChild(row);
      });
    }
  };

  G.PanelBlackbox = PanelBlackbox;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));
