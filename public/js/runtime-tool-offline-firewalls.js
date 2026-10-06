// RuntimeToolOfflineFirewalls v1.0 — Arc 5 / Phase I / Target 9
// =====================================================================
// Per-TOOL isolated offline job queues (tool-level, not family-level).
//
// Arc 4 gap: RuntimeOfflineDomains creates 8 IDB stores, one per
// family. But within the 'ai' family, OCR and AI-Summarize still share
// one store. If OCR generates 50 corrupt jobs, they fill the ai store
// and block AI-Summarize from draining its legitimate jobs.
//
// Solution: Each tool gets its own IDB store:
//   iplv-tool-offline-{toolId}-v1
//
// Independent per TOOL:
//   - IDB database + 'jobs' object store
//   - _running drain flag
//   - retry counter
//   - background sync registration
//   - error recovery state
//   - queue corruption isolation (corrupt jobs in OCR never reach AI-Sum)
//
// RuntimeOfflineDomains (Arc 4) is preserved and continues working at
// family level. RuntimeToolOfflineFirewalls adds a deeper tool-level
// layer for tools that need fine-grained isolation.
//
// A tool must OPT IN by calling RuntimeToolOfflineFirewalls.enqueue()
// instead of RuntimeOfflineDomains.enqueueForTool(). Both APIs coexist.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolOfflineFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[ToolOfflineFW]';
  var VERSION    = '1.0';
  var MAX_RETRY  = 3;
  var IDB_VER    = 1;
  var STORE_NAME = 'jobs';

  // ── Per-tool IDB state ────────────────────────────────────────────────────
  // toolId → { dbPromise, processors, running, errorCount, lastErrorAt }
  var _state = {};

  function _ensureState(toolId) {
    if (!_state[toolId]) {
      _state[toolId] = {
        dbPromise: null,
        processors: {},
        running: false,
        errorCount: 0,
        lastErrorAt: null,
      };
    }
    return _state[toolId];
  }

  // ── Open per-tool IDB ─────────────────────────────────────────────────────
  function _openDb(toolId) {
    var st = _ensureState(toolId);
    if (st.dbPromise) return st.dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));

    // Sanitize toolId for DB name (replace special chars)
    var safeId = toolId.replace(/[^a-z0-9-]/g, '-');
    var dbName  = 'iplv-tool-offline-' + safeId + '-v1';

    st.dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('ts',     'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) {
        reject(e.target.error);
        st.dbPromise = null;
      };
    });
    return st.dbPromise;
  }

  // ── Enqueue a job for a specific tool ─────────────────────────────────────
  function enqueue(toolId, type, payload, opts) {
    opts = opts || {};
    var job = {
      toolId:     toolId,
      type:       type,
      payload:    payload || {},
      retries:    0,
      maxRetries: opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:  Date.now(),
      status:     'pending',
      error:      null,
    };
    return _openDb(toolId).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var req = tx.objectStore(STORE_NAME).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, toolId + ': enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Drain pending jobs for a tool ─────────────────────────────────────────
  function drain(toolId) {
    var st = _ensureState(toolId);
    if (st.running || !navigator.onLine) return;
    st.running = true;

    _openDb(toolId).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).index('status').getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { st.running = false; return; }
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _executeJob(toolId, job); });
      });
      return chain;
    }).catch(function (e) {
      st.errorCount++;
      st.lastErrorAt = Date.now();
      console.debug(LOG, toolId + ': drain error:', e && e.message || e);
      // Isolation: errors in this tool's drain never propagate to other tools
    }).then(function () {
      st.running = false;
    });
  }

  function _executeJob(toolId, job) {
    var st      = _ensureState(toolId);
    var handler = st.processors[job.type];
    if (!handler) {
      return _updateStatus(toolId, job.id, { status: 'failed', error: 'no-handler' });
    }
    return _updateStatus(toolId, job.id, { status: 'running' })
      .then(function () { return Promise.resolve(handler(job.payload)); })
      .then(function () { return _updateStatus(toolId, job.id, { status: 'completed' }); })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        return _updateStatus(toolId, job.id, {
          status:  retries >= job.maxRetries ? 'failed' : 'pending',
          retries: retries,
          error:   String(err),
        });
      });
  }

  function _updateStatus(toolId, id, fields) {
    return _openDb(toolId).then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var st = tx.objectStore(STORE_NAME);
        var get = st.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) { resolve(); return; }
          Object.assign(rec, fields);
          var put = st.put(rec);
          put.onsuccess = function () { resolve(); };
          put.onerror   = function () { resolve(); }; // non-fatal
        };
        get.onerror = function () { resolve(); };
      });
    });
  }

  // ── Register a handler for a tool + type ─────────────────────────────────
  function register(toolId, type, fn) {
    var st = _ensureState(toolId);
    st.processors[type] = fn;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    if (toolId) {
      var st = _state[toolId];
      return st ? {
        toolId:     toolId,
        running:    st.running,
        errorCount: st.errorCount,
        hasDb:      !!st.dbPromise,
      } : null;
    }
    var out = {};
    Object.keys(_state).forEach(function (k) { out[k] = getStats(k); });
    return out;
  }

  // ── Drain all registered tools on reconnect ───────────────────────────────
  function drainAll() { Object.keys(_state).forEach(drain); }

  G.addEventListener('online', drainAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') drainAll();
  });

  G.RuntimeToolOfflineFirewalls = Object.freeze({
    VERSION:  VERSION,
    enqueue:  enqueue,
    drain:    drain,
    drainAll: drainAll,
    register: register,
    getStats: getStats,
    getTools: function () { return Object.keys(_state); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool isolated offline queues active');

}(window));
