// ILovePDF — RuntimeIDB v1.0 — Phase 6A + 6F
// =====================================================================
// Real IndexedDB persistence layer.
// Implements:
//   CentralRuntime.persistState()    — checkpoint runtime state → IDB
//   CentralRuntime.restoreState()    — restore state from IDB on boot
//   RuntimeIDB.saveCheckpoint()      — persist workflow checkpoint
//   RuntimeIDB.getCheckpoint()       — retrieve latest checkpoint
//   RuntimeIDB.clearCheckpoint()     — remove checkpoint after completion
//   RuntimeIDB.sweepOrphans()        — purge records older than maxAgeMs
//   RuntimeIDB.purge()               — wipe all stores (dev/test)
//
// Database  : ilovepdf-runtime
// Version   : 1
// Stores    :
//   runtime_state    — single-row RuntimeState snapshot
//   checkpoints      — per-tool workflow checkpoints (toolId key)
//   health_history   — rolling last-20 health snapshots
//   telemetry_summary— rolling last-100 telemetry event summaries
//
// Safety rules:
//   - Never persists raw file ArrayBuffers (too large, private)
//   - Never persists auth tokens or passwords
//   - All writes use IDB transactions with onerror rollback
//   - Schema migration runs in onupgradeneeded (version-gated)
//
// Integrates: CentralRuntime, RuntimeState, RuntimeHealth,
//             RuntimeTelemetry, RuntimeEventBus, RuntimeCleanup
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeIDB) return;

  var DB_NAME    = 'ilovepdf-runtime';
  var DB_VERSION = 1;
  var LOG        = '[IDB]';

  // ── Store names ──────────────────────────────────────────────────────────
  var STORE_STATE    = 'runtime_state';
  var STORE_CKPT     = 'checkpoints';
  var STORE_HEALTH   = 'health_history';
  var STORE_TEL      = 'telemetry_summary';

  // ── DB handle ────────────────────────────────────────────────────────────
  var _db = null;
  var _openPromise = null;
  var _available = typeof indexedDB !== 'undefined';

  // ── Schema ───────────────────────────────────────────────────────────────
  function _open() {
    if (!_available) return Promise.reject(new Error('IndexedDB not available'));
    if (_db)          return Promise.resolve(_db);
    if (_openPromise) return _openPromise;

    _openPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        // runtime_state — keyed by constant 'snapshot'
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE, { keyPath: 'key' });
        }
        // checkpoints — keyed by toolId
        if (!db.objectStoreNames.contains(STORE_CKPT)) {
          var ckptStore = db.createObjectStore(STORE_CKPT, { keyPath: 'toolId' });
          ckptStore.createIndex('ts', 'ts', { unique: false });
        }
        // health_history — auto-increment key
        if (!db.objectStoreNames.contains(STORE_HEALTH)) {
          var hStore = db.createObjectStore(STORE_HEALTH, { autoIncrement: true });
          hStore.createIndex('ts', 'ts', { unique: false });
        }
        // telemetry_summary — auto-increment key
        if (!db.objectStoreNames.contains(STORE_TEL)) {
          var tStore = db.createObjectStore(STORE_TEL, { autoIncrement: true });
          tStore.createIndex('ts', 'ts', { unique: false });
        }
      };

      req.onsuccess = function (e) {
        _db = e.target.result;
        _db.onversionchange = function () { _db.close(); _db = null; _openPromise = null; };
        resolve(_db);
      };

      req.onerror = function (e) {
        _openPromise = null;
        reject(new Error('IDB open failed: ' + (e.target.error && e.target.error.message)));
      };

      req.onblocked = function () {
        console.warn(LOG, 'open blocked — another tab has an older version open');
      };
    });

    return _openPromise;
  }

  // ── Generic transaction helpers ───────────────────────────────────────────
  function _tx(storeName, mode, fn) {
    return _open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result = null;

        tx.oncomplete = function () { resolve(result); };
        tx.onerror    = function (e) { reject(new Error('IDB tx error: ' + (e.target.error && e.target.error.message))); };
        tx.onabort    = function ()  { reject(new Error('IDB tx aborted')); };

        try {
          var req = fn(store);
          if (req && typeof req.onsuccess === 'undefined') {
            // fn returned a plain value (e.g. a pre-resolved IDBRequest)
            result = req;
          } else if (req) {
            req.onsuccess = function (e) { result = e.target.result; };
            req.onerror   = function (e) { reject(new Error('IDB req error: ' + (e.target.error && e.target.error.message))); };
          }
        } catch (err) {
          tx.abort();
          reject(err);
        }
      });
    });
  }

  function _put(storeName, record) {
    return _tx(storeName, 'readwrite', function (store) { return store.put(record); });
  }

  function _get(storeName, key) {
    return _tx(storeName, 'readonly', function (store) { return store.get(key); });
  }

  function _delete(storeName, key) {
    return _tx(storeName, 'readwrite', function (store) { return store.delete(key); });
  }

  function _getAll(storeName) {
    return _tx(storeName, 'readonly', function (store) { return store.getAll ? store.getAll() : _getAllFallback(store); });
  }

  function _getAllFallback(store) {
    // IE/Edge fallback using cursor
    return new Promise(function (resolve) {
      var items = [];
      var req = store.openCursor();
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor) { items.push(cursor.value); cursor.continue(); }
        else resolve(items);
      };
    });
  }

  // ── SAFE SNAPSHOT — filters out raw buffers and secrets ──────────────────
  var BLOCKLIST = ['password', 'token', 'secret', 'key', 'auth', 'firebase'];

  function _safeSnapshot() {
    var raw = {};
    if (global.RuntimeState && global.RuntimeState.snapshot) {
      try { raw = global.RuntimeState.snapshot(); } catch (_) {}
    }
    // Remove any keys that match the security blocklist
    var safe = {};
    Object.keys(raw).forEach(function (k) {
      var kl = k.toLowerCase();
      var blocked = BLOCKLIST.some(function (b) { return kl.includes(b); });
      if (!blocked) safe[k] = raw[k];
    });
    return safe;
  }

  // ── PERSIST STATE (Phase 6A) ──────────────────────────────────────────────
  // Saves runtime state snapshot, last 5 health events, telemetry summary.
  function persistState() {
    if (!_available) return Promise.resolve(null);

    var stateSnap   = _safeSnapshot();
    var healthSnap  = [];
    var telSnap     = [];

    try {
      if (global.RuntimeHealth && global.RuntimeHealth.getHistory) {
        healthSnap = global.RuntimeHealth.getHistory().slice(-5);
      }
    } catch (_) {}

    try {
      if (global.RuntimeTelemetry && global.RuntimeTelemetry.getStats) {
        var ts = global.RuntimeTelemetry.getStats();
        telSnap = { totalRecords: ts.totalRecords || 0, ts: Date.now() };
      }
    } catch (_) {}

    var stateRecord = {
      key:          'snapshot',
      ts:           Date.now(),
      runtimeState: stateSnap,
      healthSnap:   healthSnap,
      telSnap:      telSnap,
      version:      DB_VERSION,
    };

    return _put(STORE_STATE, stateRecord).then(function () {
      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('idb:persist', { keys: Object.keys(stateSnap).length }); } catch (_) {}
      }
      return stateRecord;
    }).catch(function (err) {
      console.warn(LOG, 'persistState failed:', err.message);
      return null;
    });
  }

  // ── RESTORE STATE (Phase 6F) ──────────────────────────────────────────────
  // Reads the IDB snapshot and bulk-applies to RuntimeState.
  // Called on boot before DOMContentLoaded tools run.
  function restoreState() {
    if (!_available) return Promise.resolve(null);

    return _get(STORE_STATE, 'snapshot').then(function (record) {
      if (!record || !record.runtimeState) return null;

      // Age gate: don't restore snapshots older than 4 hours
      var AGE_LIMIT = 4 * 60 * 60 * 1000;
      if (Date.now() - record.ts > AGE_LIMIT) {
        console.info(LOG, 'state snapshot too old (' + Math.round((Date.now() - record.ts) / 60000) + 'min) — skipping restore');
        return null;
      }

      var snap = record.runtimeState;

      // Apply safe fields to RuntimeState
      var RESTORABLE = [
        'totalTasksRun', 'totalTasksFailed', 'totalTasksCancelled',
        'totalWorkersSpawned', 'totalRetries', 'navEpoch',
      ];

      if (global.RuntimeState) {
        RESTORABLE.forEach(function (key) {
          if (snap[key] !== undefined) {
            try { global.RuntimeState.set(key, snap[key]); } catch (_) {}
          }
        });
      }

      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('idb:restore', { ageMs: Date.now() - record.ts }); } catch (_) {}
      }
      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('idb:state-restored', { ageMs: Date.now() - record.ts }); } catch (_) {}
      }

      console.info(LOG, 'state restored from IDB (snapshot age:', Math.round((Date.now() - record.ts) / 1000) + 's)');
      return record;
    }).catch(function (err) {
      console.warn(LOG, 'restoreState failed:', err.message);
      return null;
    });
  }

  // ── WORKFLOW CHECKPOINTS (Phase 6F) ───────────────────────────────────────
  // Persist tool + step so a tab-refresh can resume where the user left off.
  // Does NOT persist raw file ArrayBuffers — only metadata.
  function saveCheckpoint(toolId, data) {
    if (!_available || !toolId) return Promise.resolve(null);

    var safe = {
      toolId:   toolId,
      ts:       Date.now(),
      step:     data.step || 'upload',
      options:  data.options || {},
      // file metadata only — never raw buffers
      files:    (data.files || []).map(function (f) {
        return { name: f.name, size: f.size, type: f.type, lastModified: f.lastModified };
      }),
      result:   data.result ? { hasResult: true, ts: data.result.ts } : null,
    };

    return _put(STORE_CKPT, safe).catch(function (err) {
      console.warn(LOG, 'saveCheckpoint failed:', err.message);
      return null;
    });
  }

  function getCheckpoint(toolId) {
    if (!_available || !toolId) return Promise.resolve(null);
    return _get(STORE_CKPT, toolId).catch(function () { return null; });
  }

  function clearCheckpoint(toolId) {
    if (!_available || !toolId) return Promise.resolve();
    return _delete(STORE_CKPT, toolId).catch(function () {});
  }

  function getAllCheckpoints() {
    if (!_available) return Promise.resolve([]);
    return _getAll(STORE_CKPT).catch(function () { return []; });
  }

  // ── HEALTH HISTORY ARCHIVING ───────────────────────────────────────────────
  var _MAX_HEALTH_RECORDS = 20;

  function archiveHealth(snapshot) {
    if (!_available || !snapshot) return Promise.resolve();
    return _put(STORE_HEALTH, Object.assign({ key: Date.now() }, snapshot))
      .then(function () {
        // Rolling trim: keep only last 20
        return _getAll(STORE_HEALTH).then(function (all) {
          if (!all || all.length <= _MAX_HEALTH_RECORDS) return;
          // Sort by ts, delete oldest
          all.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
          var toDelete = all.slice(0, all.length - _MAX_HEALTH_RECORDS);
          toDelete.forEach(function (r) {
            _delete(STORE_HEALTH, r.key).catch(function () {});
          });
        });
      }).catch(function () {});
  }

  // Subscribe to health changes
  if (global.RuntimeHealth && global.RuntimeHealth.onHealthChange) {
    global.RuntimeHealth.onHealthChange(function (snap) {
      archiveHealth(snap);
    });
  }

  // ── ORPHAN SWEEP (Phase 6F) ───────────────────────────────────────────────
  // Remove checkpoints and state records older than maxAgeMs.
  var ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  function sweepOrphans(maxAgeMs) {
    if (!_available) return Promise.resolve(0);
    maxAgeMs = maxAgeMs || ORPHAN_MAX_AGE_MS;
    var cutoff = Date.now() - maxAgeMs;
    var deleted = 0;

    return _getAll(STORE_CKPT).then(function (checkpoints) {
      var stale = (checkpoints || []).filter(function (c) { return c.ts < cutoff; });
      stale.forEach(function (c) {
        _delete(STORE_CKPT, c.toolId).catch(function () {});
        deleted++;
      });
      return deleted;
    }).then(function (n) {
      if (n > 0) console.info(LOG, 'swept', n, 'orphan checkpoint(s)');
      return n;
    }).catch(function () { return 0; });
  }

  // ── PURGE ALL (dev/test) ──────────────────────────────────────────────────
  function purge() {
    if (!_available) return Promise.resolve();
    return _open().then(function (db) {
      var stores = [STORE_STATE, STORE_CKPT, STORE_HEALTH, STORE_TEL];
      var txPromises = stores.map(function (s) {
        return new Promise(function (resolve) {
          try {
            var tx    = db.transaction(s, 'readwrite');
            var store = tx.objectStore(s);
            var req   = store.clear();
            req.onsuccess  = resolve;
            req.onerror    = resolve;
            tx.oncomplete  = resolve;
          } catch (_) { resolve(); }
        });
      });
      return Promise.all(txPromises);
    }).then(function () {
      console.info(LOG, 'all stores purged');
    }).catch(function (err) {
      console.warn(LOG, 'purge failed:', err.message);
    });
  }

  // ── STATS ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      available:  _available,
      dbOpen:     !!_db,
      dbName:     DB_NAME,
      dbVersion:  DB_VERSION,
      stores:     [STORE_STATE, STORE_CKPT, STORE_HEALTH, STORE_TEL],
    };
  }

  // ── AUTO-PERSIST on pagehide ───────────────────────────────────────────────
  global.addEventListener('pagehide', function () {
    persistState().catch(function () {});
  }, { passive: true });

  // ── Register with RuntimeCleanup ───────────────────────────────────────────
  if (global.RuntimeCleanup && global.RuntimeCleanup.register) {
    try {
      global.RuntimeCleanup.register('idb-sweep', function () {
        return sweepOrphans();
      }, { phase: 'idle', priority: 'low' });
    } catch (_) {}
  }

  // ── Wire into CentralRuntime (deferred — CRT may not exist yet) ───────────
  function _wireCentralRuntime() {
    var RT = global.CentralRuntime || global.RT;
    if (!RT) return;

    RT.persistState = persistState;
    RT.restoreState = restoreState;

    // Also wire RT.saveCheckpoint / RT.clearCheckpoint for tool-page.js
    RT.saveCheckpoint  = saveCheckpoint;
    RT.getCheckpoint   = getCheckpoint;
    RT.clearCheckpoint = clearCheckpoint;

    if (global.RT && global.RT !== RT) {
      global.RT.persistState  = persistState;
      global.RT.restoreState  = restoreState;
      global.RT.saveCheckpoint = saveCheckpoint;
      global.RT.getCheckpoint  = getCheckpoint;
      global.RT.clearCheckpoint = clearCheckpoint;
    }

    // Register as CRT subsystem
    if (RT.register) {
      try { RT.register('idb', global.RuntimeIDB); } catch (_) {}
    }

    console.info(LOG, 'wired into CentralRuntime — persistState() and restoreState() are now real');
  }

  // Boot: attempt restore, then register
  function _boot() {
    sweepOrphans().catch(function () {});

    // Restore previous session state (non-blocking — errors are swallowed)
    restoreState().catch(function () {});

    _wireCentralRuntime();

    // Also try to wire after CRT bootstrap fires
    if (global.RuntimeEventBus) {
      global.RuntimeEventBus.once('runtime:ready', function () {
        setTimeout(_wireCentralRuntime, 50);
      });
    }
    global.addEventListener('rt:runtime:ready', function () {
      setTimeout(_wireCentralRuntime, 50);
    }, { once: true });
  }

  // Expose immediately
  global.RuntimeIDB = {
    persistState:      persistState,
    restoreState:      restoreState,
    saveCheckpoint:    saveCheckpoint,
    getCheckpoint:     getCheckpoint,
    clearCheckpoint:   clearCheckpoint,
    getAllCheckpoints:  getAllCheckpoints,
    archiveHealth:     archiveHealth,
    sweepOrphans:      sweepOrphans,
    purge:             purge,
    getStats:          getStats,
    isAvailable:       function () { return _available; },
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 50);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(_boot, 50);
    }, { once: true });
  }

  console.info(LOG, 'RuntimeIDB v1.0 ready — IDB name:', DB_NAME, '| Phase 6A+6F persistence active');
}(window));
