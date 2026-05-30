(function (G) {
  'use strict';
  if (G.RuntimeToolPersistence) return;

  var LOG = '[Arc13:Persistence]';
  var DB_NAME    = 'tool-intelligence-v1';
  var DB_VERSION = 1;
  var STORES     = ['registry', 'predictor', 'recovery', 'optimizer'];
  var AUTO_SAVE_MS = 60 * 1000;

  var _db       = null;
  var _dbReady  = false;
  var _metrics  = { saves: 0, restores: 0, errors: 0, lastSaveTs: 0, lastRestoreTs: 0 };
  var _localTransitions = {};   // built by observing arc9:tool-recorded events
  var _lastFrom         = null; // previous tool for transition tracking

  // ── IndexedDB open ──────────────────────────────────────────────────────────
  function _openDB() {
    return new Promise(function (resolve, reject) {
      if (!G.indexedDB) { reject(new Error('IndexedDB not available')); return; }
      var req = G.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(s, { keyPath: 'id', autoIncrement: false });
          }
        });
      };
      req.onsuccess = function (e) { _db = e.target.result; _dbReady = true; resolve(_db); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function _ready() {
    if (_dbReady && _db) return Promise.resolve(_db);
    return _openDB();
  }

  // ── IDB helpers ─────────────────────────────────────────────────────────────
  function _put(storeName, key, value) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readwrite');
        var os  = tx.objectStore(storeName);
        var req = os.put({ id: key, value: value, ts: Date.now() });
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  function _get(storeName, key) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readonly');
        var req = tx.objectStore(storeName).get(key);
        req.onsuccess = function (e) { resolve(e.target.result ? e.target.result.value : null); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  function _clearStore(storeName) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readwrite');
        var req = tx.objectStore(storeName).clear();
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  // ── Collect Registry snapshot ────────────────────────────────────────────────
  function _collectRegistry() {
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.getAllTools) return reg.getAllTools();
    } catch (_) {}
    return [];
  }

  // ── Collect Predictor transitions (observed locally) ─────────────────────────
  function _collectPredictor() {
    return Object.assign({}, _localTransitions);
  }

  // ── Collect Recovery history ─────────────────────────────────────────────────
  function _collectRecovery() {
    try {
      var rec = G.RuntimeToolRecovery;
      if (rec && rec.getAllHistory) return rec.getAllHistory();
    } catch (_) {}
    return {};
  }

  // ── Collect Optimizer metrics ────────────────────────────────────────────────
  function _collectOptimizer() {
    try {
      var opt = G.RuntimeToolOptimizer;
      if (opt && opt.getMetrics) return opt.getMetrics();
    } catch (_) {}
    return {};
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  function save() {
    var snap = {
      registry:   _collectRegistry(),
      predictor:  _collectPredictor(),
      recovery:   _collectRecovery(),
      optimizer:  _collectOptimizer(),
    };
    return Promise.all([
      _put('registry',  'snapshot', snap.registry),
      _put('predictor', 'transitions', snap.predictor),
      _put('recovery',  'history', snap.recovery),
      _put('optimizer', 'metrics', snap.optimizer),
    ]).then(function () {
      _metrics.saves++;
      _metrics.lastSaveTs = Date.now();
      console.debug(LOG, 'saved — registry:', snap.registry.length,
        'transitions:', Object.keys(snap.predictor).length, 'tools');
      G.dispatchEvent(new CustomEvent('arc13:persistence-saved', { detail: { ts: _metrics.lastSaveTs } }));
    }).catch(function (e) {
      _metrics.errors++;
      console.warn(LOG, 'save error:', e.message || e);
    });
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  function restore() {
    return Promise.all([
      _get('registry',  'snapshot'),
      _get('predictor', 'transitions'),
      _get('recovery',  'history'),
      _get('optimizer', 'metrics'),
    ]).then(function (results) {
      var regSnap    = results[0];
      var predSnap   = results[1];
      var recSnap    = results[2];

      // Restore registry
      if (regSnap && Array.isArray(regSnap)) {
        var reg = G.RuntimeToolRegistry;
        if (reg && reg.registerTool) {
          regSnap.forEach(function (t) {
            try { reg.registerTool(t); } catch (_) {}
          });
        }
        console.debug(LOG, 'restored registry:', regSnap.length, 'tools');
      }

      // Restore predictor transitions (local copy only — feeds future saves)
      if (predSnap && typeof predSnap === 'object') {
        _localTransitions = predSnap;
        console.debug(LOG, 'restored predictor transitions:',
          Object.keys(_localTransitions).length, 'source tools');
      }

      // Restore recovery history (rebuild by emitting synthetic events is not
      // safe — store locally for inspection by export layer only)
      if (recSnap && typeof recSnap === 'object') {
        console.debug(LOG, 'restored recovery history:',
          Object.keys(recSnap).length, 'tools');
      }

      _metrics.restores++;
      _metrics.lastRestoreTs = Date.now();
      G.dispatchEvent(new CustomEvent('arc13:persistence-restored', {
        detail: {
          registryTools: regSnap ? regSnap.length : 0,
          predictorKeys: predSnap ? Object.keys(predSnap).length : 0,
          ts: _metrics.lastRestoreTs,
        },
      }));
    }).catch(function (e) {
      _metrics.errors++;
      console.warn(LOG, 'restore error:', e.message || e);
    });
  }

  // ── Clear all stores ─────────────────────────────────────────────────────────
  function clear() {
    return Promise.all(STORES.map(function (s) { return _clearStore(s); })).then(function () {
      _localTransitions = {};
      _lastFrom         = null;
      console.debug(LOG, 'all stores cleared');
    });
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Boot ────────────────────────────────────────────────────────────────────
  _openDB().then(function () {
    // Restore persisted state on boot
    return restore();
  }).then(function () {
    // Auto-save every 60s
    setInterval(function () { save(); }, AUTO_SAVE_MS);
  }).catch(function (e) {
    console.warn(LOG, 'boot error:', e.message || e);
  });

  // Observe arc9:tool-recorded to build local transition table for persistence
  G.addEventListener('arc9:tool-recorded', function (e) {
    var toolId = e && e.detail && e.detail.toolId;
    if (!toolId) return;
    if (_lastFrom && _lastFrom !== toolId) {
      if (!_localTransitions[_lastFrom]) _localTransitions[_lastFrom] = {};
      _localTransitions[_lastFrom][toolId] = (_localTransitions[_lastFrom][toolId] || 0) + 1;
    }
    _lastFrom = toolId;
  });

  G.RuntimeToolPersistence = Object.freeze({
    save:       save,
    restore:    restore,
    clear:      clear,
    getMetrics: getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
