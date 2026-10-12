// RuntimeBlackboxStorage v1.0 — Arc 11 / Phase B
// =============================================================================
// IndexedDB-backed persistent diagnostics store.
// Survives page reload, browser restart (within IndexedDB retention limits).
//
// Distinct from RuntimeBlackbox (Arc 9) which holds an in-memory rolling
// buffer. This module persists selected records to IndexedDB so that:
//   - Crash investigators can access pre-crash state after reload
//   - Long-running incident patterns are traceable across sessions
//   - Recovery history is never lost to an unexpected unload
//
// Storage schema (object stores):
//   incidents        — severity + context, capped at INCIDENT_MAX
//   traces           — trace entries from RuntimeTraceEngine, capped at TRACE_MAX
//   snapshots        — RuntimeStateSnapshots JSON, capped at SNAPSHOT_MAX
//   blackbox_events  — rolling events from RuntimeBlackbox, capped at EVENT_MAX
//   recovery_history — recovery outcomes from RuntimeRecoveryOrchestrator
//
// Auto-cleanup: on open and every SWEEP_INTERVAL_MS, oldest records are
// pruned to keep each store within capacity.
//
// Corruption detection: DB open errors trigger a full database delete + recreate.
//
// window.RuntimeBlackboxStorage
//   .store(storeName, record)         → Promise<key>
//   .load(storeName, opts)            → Promise<record[]>
//   .clear(storeName)                 → Promise<void>
//   .sweep()                          → Promise<{ [store]: pruned }>
//   .persist(snapshot)               → Promise<void>  (convenience: saves full snapshot)
//   .loadLastSession()               → Promise<SessionSnapshot|null>
//   .getMetrics()                    → MetricsObject
//   .isAvailable()                   → boolean
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBlackboxStorage) return;

  var VERSION        = '1.0';
  var LOG            = '[BBStorage]';
  var DB_NAME        = 'ilovepdf_blackbox';
  var DB_VERSION     = 1;
  var SWEEP_INTERVAL = 5 * 60 * 1000;  // 5 min

  // Store caps
  var CAPS = {
    incidents:       500,
    traces:          2000,
    snapshots:       20,
    blackbox_events: 5000,
    recovery_history: 200,
  };

  var _db       = null;
  var _ready    = false;
  var _failed   = false;
  var _metrics  = { stored: 0, loaded: 0, pruned: 0, errors: 0, opens: 0 };
  var _stores   = Object.keys(CAPS);

  // ── IndexedDB open ────────────────────────────────────────────────────────
  function _openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB not available')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        _stores.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { autoIncrement: true, keyPath: '_bbKey' });
          }
        });
      };

      req.onsuccess = function (e) {
        _metrics.opens++;
        resolve(e.target.result);
      };

      req.onerror = function (e) {
        reject(new Error('IDB open error: ' + (e.target.error && e.target.error.message)));
      };
    });
  }

  function _deleteAndRecreate() {
    console.warn(LOG, 'corrupted DB — deleting and recreating');
    return new Promise(function (resolve) {
      var req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = function () { resolve(_openDB()); };
    });
  }

  function _init() {
    return _openDB()
      .then(function (db) { _db = db; _ready = true; _sweep(); return db; })
      .catch(function (e) {
        console.warn(LOG, 'open failed, attempting recreate:', e.message);
        return _deleteAndRecreate()
          .then(function (db) { _db = db; _ready = true; return db; })
          .catch(function (e2) {
            _failed = true;
            console.error(LOG, 'DB unavailable:', e2.message);
          });
      });
  }

  // ── Generic store ─────────────────────────────────────────────────────────
  function store(storeName, record) {
    if (!_ready || !_db || _failed) return Promise.resolve(null);
    if (!CAPS[storeName]) return Promise.reject(new Error('Unknown store: ' + storeName));
    return new Promise(function (resolve, reject) {
      try {
        var tx  = _db.transaction([storeName], 'readwrite');
        var os  = tx.objectStore(storeName);
        var rec = Object.assign({}, record, { _bbTs: Date.now(), _bbKey: undefined });
        delete rec._bbKey;
        var req = os.add(rec);
        req.onsuccess = function () { _metrics.stored++; resolve(req.result); };
        req.onerror   = function () { _metrics.errors++; reject(req.error); };
      } catch (e) { _metrics.errors++; reject(e); }
    });
  }

  // ── Generic load ──────────────────────────────────────────────────────────
  function load(storeName, opts) {
    opts = opts || {};
    if (!_ready || !_db || _failed) return Promise.resolve([]);
    return new Promise(function (resolve) {
      try {
        var tx     = _db.transaction([storeName], 'readonly');
        var os     = tx.objectStore(storeName);
        var result = [];
        var req    = os.openCursor();
        req.onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) {
            _metrics.loaded += result.length;
            if (opts.limit) result = result.slice(-opts.limit);
            if (opts.since) result = result.filter(function (r) { return (r._bbTs || 0) >= opts.since; });
            resolve(result);
            return;
          }
          result.push(cursor.value);
          cursor.continue();
        };
        req.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  }

  // ── Clear a store ─────────────────────────────────────────────────────────
  function clear(storeName) {
    if (!_ready || !_db) return Promise.resolve();
    return new Promise(function (resolve) {
      try {
        var tx  = _db.transaction([storeName], 'readwrite');
        var req = tx.objectStore(storeName).clear();
        req.onsuccess = req.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }

  // ── Auto-sweep: prune each store to its cap ────────────────────────────────
  function _pruneStore(storeName) {
    var cap = CAPS[storeName];
    return new Promise(function (resolve) {
      try {
        var tx    = _db.transaction([storeName], 'readwrite');
        var os    = tx.objectStore(storeName);
        var count = 0;
        var keys  = [];
        var cReq  = os.openCursor();
        cReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) { keys.push(cursor.primaryKey); count++; cursor.continue(); }
          else {
            var excess = count - cap;
            if (excess <= 0) { resolve(0); return; }
            var del = 0;
            keys.slice(0, excess).forEach(function (k) {
              var tx2 = _db.transaction([storeName], 'readwrite');
              tx2.objectStore(storeName).delete(k);
              del++;
            });
            _metrics.pruned += del;
            resolve(del);
          }
        };
        cReq.onerror = function () { resolve(0); };
      } catch (e) { resolve(0); }
    });
  }

  function _sweep() {
    if (!_ready || !_db) return Promise.resolve({});
    var promises = _stores.map(function (name) {
      return _pruneStore(name).then(function (n) { return [name, n]; });
    });
    return Promise.all(promises).then(function (results) {
      var summary = {};
      results.forEach(function (pair) { summary[pair[0]] = pair[1]; });
      return summary;
    });
  }

  function sweep() { return _sweep(); }

  // ── Convenience: persist a full session snapshot ──────────────────────────
  function persist(snapshot) {
    return store('snapshots', { type: 'session-snapshot', data: snapshot, _bbTs: Date.now() });
  }

  // ── Load the most recent session snapshot ─────────────────────────────────
  function loadLastSession() {
    return load('snapshots', { limit: 1 }).then(function (rows) {
      return rows.length ? rows[rows.length - 1] : null;
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  var _initPromise = _init();

  // Subscribe to blackbox events once ready
  _initPromise.then(function () {
    if (!_ready) return;
    // Relay RuntimeBlackbox events to IDB
    window.addEventListener('arc9:blackbox-export', function (evt) {
      if (!evt || !evt.detail) return;
      store('blackbox_events', { type: 'blackbox-export', detail: evt.detail });
    });
    // Relay incidents
    window.addEventListener('arc8:incident', function (evt) {
      if (!evt || !evt.detail) return;
      store('incidents', evt.detail);
    });
    // Relay traces
    window.addEventListener('arc8:trace', function (evt) {
      if (!evt || !evt.detail) return;
      store('traces', evt.detail);
    });
    // Relay recovery history
    window.addEventListener('arc9:recovery-complete', function (evt) {
      if (!evt || !evt.detail) return;
      store('recovery_history', evt.detail);
    });
    // Periodic sweep
    setInterval(_sweep, SWEEP_INTERVAL);
    console.debug(LOG, 'v' + VERSION + ' ready — IDB open, ' + _stores.length + ' stores');
  });

  G.RuntimeBlackboxStorage = Object.freeze({
    VERSION:         VERSION,
    store:           store,
    load:            load,
    clear:           clear,
    sweep:           sweep,
    persist:         persist,
    loadLastSession: loadLastSession,
    isAvailable:     function () { return _ready && !_failed; },
    getMetrics:      function () { return Object.assign({}, _metrics); },
    stores:          _stores.slice(),
  });

  console.debug(LOG, 'v' + VERSION + ' loaded — initialising IndexedDB');
}(window));
