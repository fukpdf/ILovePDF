(function (G) {
  'use strict';
  if (G.PanelPersistentStorage) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelPersistentStorage]';

  function PanelPersistentStorage(container) {
    this._c     = container;
    this._built = false;
  }

  PanelPersistentStorage.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '💾 Persistent Storage' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ps-sweep',    text: 'Run Sweep' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ps-snapshot', text: 'Persist Snapshot' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ps-load-last', text: 'Load Last Session' }),
    ]);

    var metricsEl  = Ren.el('div', { cls: 'panel-metrics', id: 'ps-metrics' });
    var storeTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Store Contents (last 20 per store)' });
    var storeEl    = Ren.el('div', { cls: 'panel-list-wrap', id: 'ps-stores', style: 'max-height:240px;overflow-y:auto;' });
    var sessTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Last Session Snapshot' });
    var sessEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'ps-session', style: 'max-height:100px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metricsEl);
    this._c.appendChild(storeTitle);
    this._c.appendChild(storeEl);
    this._c.appendChild(sessTitle);
    this._c.appendChild(sessEl);

    toolbar.querySelector('#ps-sweep').addEventListener('click', function () {
      var BBS = G.RuntimeBlackboxStorage;
      if (!BBS || !BBS.isAvailable()) { alert('RuntimeBlackboxStorage not available'); return; }
      BBS.sweep().then(function (r) {
        alert('Sweep complete: ' + JSON.stringify(r));
        self.refresh();
      }).catch(function (e) { alert('Sweep error: ' + e.message); });
    });

    toolbar.querySelector('#ps-snapshot').addEventListener('click', function () {
      var BBS = G.RuntimeBlackboxStorage;
      var SS  = G.RuntimeStateSnapshots;
      if (!BBS || !BBS.isAvailable()) { alert('RuntimeBlackboxStorage not available'); return; }
      var snap = SS && typeof SS.take === 'function' ? SS.take('debug-panel') : Promise.resolve({ ts: Date.now(), label: 'manual' });
      snap.then(function (s) { return BBS.persist(s); })
          .then(function () { alert('Snapshot persisted.'); self.refresh(); })
          .catch(function (e) { alert('Error: ' + e.message); });
    });

    toolbar.querySelector('#ps-load-last').addEventListener('click', function () {
      var BBS = G.RuntimeBlackboxStorage;
      if (!BBS || !BBS.isAvailable()) { alert('RuntimeBlackboxStorage not available'); return; }
      BBS.loadLastSession().then(function (sess) {
        var sessEl = self._c.querySelector('#ps-session');
        if (!sessEl) return;
        var Ren2 = G.RuntimeDebugRenderer;
        if (!Ren2) return;
        sessEl.innerHTML = '';
        if (sess) {
          sessEl.appendChild(Ren2.el('pre', { style: 'font-size:11px;white-space:pre-wrap;',
            text: JSON.stringify(sess, null, 2).slice(0, 800) }));
        } else {
          sessEl.appendChild(Ren2.el('div', { cls: 'empty-state', text: 'No saved session found.' }));
        }
      }).catch(function () {});
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(storeEl);
  };

  PanelPersistentStorage.prototype.refresh = function () {
    if (!this._built) return;
    var BBS = G.RuntimeBlackboxStorage;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#ps-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      if (BBS) {
        var m = BBS.getMetrics();
        [
          ['Available', BBS.isAvailable() ? 'YES' : 'NO'],
          ['Stored',    m.stored],
          ['Loaded',    m.loaded],
          ['Pruned',    m.pruned],
          ['Errors',    m.errors],
          ['Opens',     m.opens],
          ['Stores',    BBS.stores.length],
        ].forEach(function (p) {
          metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] }));
        });
      } else {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeBlackboxStorage not loaded' }));
      }
    }

    // Store contents
    var storeEl = this._c.querySelector('#ps-stores');
    if (storeEl && BBS && BBS.isAvailable()) {
      storeEl.innerHTML = '';
      var stores = BBS.stores;
      var promises = stores.map(function (name) {
        return BBS.load(name, { limit: 5 }).then(function (rows) { return { name: name, rows: rows }; });
      });
      Promise.all(promises).then(function (results) {
        results.forEach(function (r) {
          var hdr = Ren.el('div', { cls: 'panel-subtitle', style: 'margin-top:6px;',
                                    text: r.name + ' (' + r.rows.length + ' shown)' });
          storeEl.appendChild(hdr);
          if (!r.rows.length) {
            storeEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'empty' }));
          } else {
            r.rows.slice(-5).reverse().forEach(function (row) {
              var preview = JSON.stringify(row).slice(0, 120);
              var item = Ren.el('div', { cls: 'tl-row' }, [
                Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(row._bbTs || row.ts || 0) }),
                Ren.el('span', { text: preview }),
              ]);
              storeEl.appendChild(item);
            });
          }
        });
      }).catch(function () {});
    } else if (storeEl) {
      storeEl.innerHTML = '';
      storeEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'RuntimeBlackboxStorage not available.' }));
    }
  };

  G.PanelPersistentStorage = PanelPersistentStorage;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));
