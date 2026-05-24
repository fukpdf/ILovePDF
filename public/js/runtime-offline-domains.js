// RuntimeOfflineDomains v1.0 — Arc 4 / Phase B / Target 2
// =====================================================================
// Per-family isolated IndexedDB offline job queues.
//
// Problem: RuntimeOfflineProcessor uses a single IDB store with a single
// _running flag. OCR offline job failure stalls Compress offline jobs.
// A corrupt OCR job blocks the entire shared queue drain.
//
// Solution: Each of the 8 tool families gets its own IDB database:
//   iplv-offline-organize-v1
//   iplv-offline-compress-v1
//   iplv-offline-convert-from-v1
//   iplv-offline-convert-to-v1
//   iplv-offline-edit-v1
//   iplv-offline-ai-v1
//   iplv-offline-image-v1
//   iplv-offline-utility-v1
//
// Each family has independent:
//   - IDB connection + schema
//   - _running drain flag
//   - retry counter
//   - reconnect/visibility recovery
//
// RuntimeOfflineProcessor (Arc 2) is preserved and continues to work.
// RuntimeOfflineDomains supplements it with domain-aware routing.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeOfflineDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[OfflineDoms]';
  var VERSION = '1.0';
  var MAX_RETRY    = 3;
  var IDB_VER      = 1;
  var STORE_NAME   = 'jobs';
  var FAMILIES     = ['organize','compress','convert-from','convert-to','edit','ai','image','utility'];

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to','word-to-excel':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ai-summarize':'ai','translate':'ai','workflow':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Per-family state ──────────────────────────────────────────────────────
  // family → { dbPromise, processors, running }
  var _state = {};

  function _getFamilyState(family) {
    if (!_state[family]) {
      _state[family] = { dbPromise: null, processors: {}, running: false };
    }
    return _state[family];
  }

  // ── Open per-family IDB ───────────────────────────────────────────────────
  function _openDb(family) {
    var st = _getFamilyState(family);
    if (st.dbPromise) return st.dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));
    var dbName = 'iplv-offline-' + family + '-v1';
    st.dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var s = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status',    'status',    { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
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

  // ── IDB transaction helper ────────────────────────────────────────────────
  function _dbTx(family, mode, fn) {
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(STORE_NAME, mode);
        var store = tx.objectStore(STORE_NAME);
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

  // ── Enqueue a job for a specific family ───────────────────────────────────
  function enqueue(family, type, payload, opts) {
    opts = opts || {};
    if (!FAMILIES.includes(family)) {
      console.debug(LOG, 'unknown family:', family, '— falling back to organize');
      family = 'organize';
    }
    var job = {
      type:          type,
      family:        family,
      payload:       payload || {},
      state:         opts.state || null,
      retries:       0,
      maxRetries:    opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:     Date.now(),
      lastAttemptAt: null,
      status:        'pending',
      error:         null,
    };
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var req = tx.objectStore(STORE_NAME).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, family + ': enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Enqueue by toolId (auto-resolves family) ──────────────────────────────
  function enqueueForTool(toolId, type, payload, opts) {
    var family = TOOL_FAMILY[toolId] || 'organize';
    return enqueue(family, type, payload, opts);
  }

  // ── Drain pending jobs for one family ─────────────────────────────────────
  function drain(family) {
    var st = _getFamilyState(family);
    if (st.running || !navigator.onLine) return;
    st.running = true;

    _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readonly');
        var idx = tx.objectStore(STORE_NAME).index('status');
        var req = idx.getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { st.running = false; return; }
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _execute(family, job); });
      });
      return chain;
    }).catch(function (e) {
      console.debug(LOG, family + ': drain error:', e);
    }).then(function () {
      st.running = false;
    });
  }

  function drainAll() {
    FAMILIES.forEach(function (f) { drain(f); });
  }

  // ── Execute one job ───────────────────────────────────────────────────────
  function _execute(family, job) {
    var st      = _getFamilyState(family);
    var handler = st.processors[job.type];
    if (!handler) {
      console.debug(LOG, family + ': no handler for type:', job.type);
      return _updateJob(family, job.id, { status: 'failed', error: 'no-handler' });
    }
    return _updateJob(family, job.id, { status: 'running', lastAttemptAt: Date.now() })
      .then(function () { return Promise.resolve(handler(job.payload, job.state)); })
      .then(function () { return _updateJob(family, job.id, { status: 'completed' }); })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        var status  = retries >= job.maxRetries ? 'failed' : 'pending';
        return _updateJob(family, job.id, { status: status, retries: retries, error: String(err) });
      });
  }

  function _updateJob(family, id, fields) {
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var st  = tx.objectStore(STORE_NAME);
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

  // ── Register a handler for a family + type ────────────────────────────────
  function register(family, type, fn) {
    var st = _getFamilyState(family);
    st.processors[type] = fn;
  }

  // ── Stats for RuntimeHealthOrchestrator ──────────────────────────────────
  function getQueueStats(family) {
    if (family) {
      return _openDb(family).then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var st = tx.objectStore(STORE_NAME);
          var pending = 0, failed = 0, completed = 0;
          var req = st.openCursor();
          req.onsuccess = function (e) {
            var cursor = e.target.result;
            if (cursor) {
              if (cursor.value.status === 'pending')   pending++;
              if (cursor.value.status === 'failed')    failed++;
              if (cursor.value.status === 'completed') completed++;
              cursor.continue();
            } else {
              resolve({ family: family, pending: pending, failed: failed, completed: completed });
            }
          };
          req.onerror = function () { resolve({ family: family, error: true }); };
        });
      }).catch(function () { return { family: family, error: true }; });
    }
    // All families
    return Promise.all(FAMILIES.map(function (f) { return getQueueStats(f); }))
      .then(function (results) {
        var out = {};
        results.forEach(function (r) { out[r.family] = r; });
        return out;
      });
  }

  // ── Reconnect + visibility recovery ──────────────────────────────────────
  G.addEventListener('online', drainAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') drainAll();
  });

  // Initial drain
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(drainAll, 1500); }, { once: true });
  } else {
    setTimeout(drainAll, 1500);
  }

  G.RuntimeOfflineDomains = Object.freeze({
    VERSION:        VERSION,
    enqueue:        enqueue,
    enqueueForTool: enqueueForTool,
    drain:          drain,
    drainAll:       drainAll,
    register:       register,
    getQueueStats:  getQueueStats,
    getFamilies:    function () { return FAMILIES.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-family offline queues active');

}(window));
