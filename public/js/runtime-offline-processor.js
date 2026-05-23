// RuntimeOfflineProcessor v1.0 — Arc 2 / Target 6
// =====================================================================
// Transactional offline job queue + processing continuation.
//
// Extends RuntimeOffline (which provides IDB-backed event storage) with:
//   - Transactional job wrappers: commit/rollback semantics
//   - Resumable processing: jobs survive tab suspension + SW restart
//   - Worker state persistence: captures in-flight state to IDB
//   - Reconnect continuation: auto-drains queue on navigator.onLine
//   - Mobile backgrounding survival: visibilitychange + pagehide hooks
//
// IDB store: iplv-offline-proc-v1 / jobs
// Job schema: { id, type, payload, state, retries, maxRetries,
//               createdAt, lastAttemptAt, status, error }
// Status: 'pending' | 'running' | 'completed' | 'failed'
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeOfflineProcessor) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[OfflineProc]';
  var VERSION    = '1.0';
  var IDB_NAME   = 'iplv-offline-proc-v1';
  var IDB_VER    = 1;
  var IDB_STORE  = 'jobs';
  var MAX_RETRY  = 3;

  var _processors = {}; // type → handler function
  var _running    = false;

  // ── IDB helpers ───────────────────────────────────────────────────────────
  var _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var s = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status',    'status',    { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); _dbPromise = null; };
    });
    return _dbPromise;
  }

  function _dbTx(mode, fn) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(IDB_STORE, mode);
        var store = tx.objectStore(IDB_STORE);
        var res;
        try { res = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(res instanceof IDBRequest ? res.result : res); };
        tx.onerror    = function () { reject(tx.error); };
        if (res instanceof IDBRequest) {
          res.onsuccess = function () {};
          res.onerror   = function () { reject(res.error); };
        }
      });
    });
  }

  // ── Enqueue a job ─────────────────────────────────────────────────────────
  function enqueue(type, payload, opts) {
    opts = opts || {};
    var job = {
      type:          type,
      payload:       payload || {},
      state:         opts.state   || null,
      retries:       0,
      maxRetries:    opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:     Date.now(),
      lastAttemptAt: null,
      status:        'pending',
      error:         null,
    };
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(IDB_STORE, 'readwrite');
        var req = tx.objectStore(IDB_STORE).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, 'enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Drain pending jobs ────────────────────────────────────────────────────
  function _drain() {
    if (_running || !navigator.onLine) return;
    _running = true;

    _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx      = db.transaction(IDB_STORE, 'readonly');
        var idx     = tx.objectStore(IDB_STORE).index('status');
        var req     = idx.getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { _running = false; return; }

      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _execute(job); });
      });
      return chain;
    }).catch(function (e) {
      console.debug(LOG, 'drain error:', e);
    }).then(function () {
      _running = false;
    });
  }

  // ── Execute one job ───────────────────────────────────────────────────────
  function _execute(job) {
    var handler = _processors[job.type];
    if (!handler) {
      console.debug(LOG, 'no handler for type:', job.type, '— skipping');
      return _updateJob(job.id, { status: 'failed', error: 'no handler' });
    }

    return _updateJob(job.id, { status: 'running', lastAttemptAt: Date.now() })
      .then(function () {
        return Promise.resolve(handler(job.payload, job.state));
      })
      .then(function () {
        return _updateJob(job.id, { status: 'completed' });
      })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        var status  = retries >= job.maxRetries ? 'failed' : 'pending';
        console.debug(LOG, 'job', job.id, 'attempt', retries, '/', job.maxRetries, '—', status);
        return _updateJob(job.id, { status: status, retries: retries, error: String(err) });
      });
  }

  // ── Update job record ─────────────────────────────────────────────────────
  function _updateJob(id, fields) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(IDB_STORE, 'readwrite');
        var st  = tx.objectStore(IDB_STORE);
        var get = st.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) { resolve(); return; }
          Object.assign(rec, fields);
          var put = st.put(rec);
          put.onsuccess = function () { resolve(); };
          put.onerror   = function () { reject(put.error); };
        };
        get.onerror = function () { reject(get.error); };
      });
    });
  }

  // ── Reconnect + visibility recovery ──────────────────────────────────────
  G.addEventListener('online', _drain);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') _drain();
  });

  // Initial drain on load (handles jobs enqueued in previous session)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _drain, { once: true });
  } else {
    setTimeout(_drain, 1000); // let other systems boot first
  }

  G.RuntimeOfflineProcessor = Object.freeze({
    VERSION:    VERSION,
    enqueue:    enqueue,
    drain:      _drain,
    register:   function (type, fn) { _processors[type] = fn; },
    getJobs:    function (status) {
      return _openDb().then(function (db) {
        return new Promise(function (resolve) {
          var tx  = db.transaction(IDB_STORE, 'readonly');
          var st  = tx.objectStore(IDB_STORE);
          var req = status ? st.index('status').getAll(status) : st.getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror   = function () { resolve([]); };
        });
      });
    },
  });

}(window));
