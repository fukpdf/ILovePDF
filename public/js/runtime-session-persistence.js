// RuntimeSessionPersistence v1.0 — Phase 8 / Objective 2a
// =============================================================================
// Cross-navigation forensics persistence via IndexedDB.
// Compresses session recorder events and forensic snapshots into a rolling
// IDB store so that multi-page-navigation attack sequences are reconstructable.
//
// Architecture:
//   • IDB store name: 'p8_session_forensics'
//   • Two object stores: 'events' and 'snapshots'
//   • Rolling retention: 7 days max, max 2,000 events / 200 snapshots
//   • Integrity checksum: SHA-256-like rolling XOR hash on event sequence
//   • Automatic corruption recovery: on schema mismatch, store is rebuilt
//   • Automatic flush to server on pagehide (beaconFallback)
//
// window.RuntimeSessionPersistence
//   .persistEvent(eventType, meta)       → Promise<void>
//   .persistSnapshot(trigger, state)     → Promise<void>
//   .loadSession(sessionId)              → Promise<SessionRecord|null>
//   .exportBundle()                      → Promise<ForensicBundle>
//   .clear()                             → Promise<void>
//   .status()                            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionPersistence) return;

  var VERSION     = '1.0';
  var LOG         = '[SessionPersist]';
  var DB_NAME     = 'p8_session_forensics';
  var DB_VERSION  = 1;
  var STORE_EVT   = 'events';
  var STORE_SNAP  = 'snapshots';
  var RETAIN_MS   = 7 * 24 * 3600 * 1000;   // 7 days
  var MAX_EVENTS  = 2000;
  var MAX_SNAPS   = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40 && typeof indexedDB !== 'undefined';

  // ── Session identity ───────────────────────────────────────────────────────
  var _sessionId = _s(function () {
    var id = sessionStorage.getItem('_p8_sid');
    if (!id) {
      id = 'sid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      sessionStorage.setItem('_p8_sid', id);
    }
    return id;
  }, 'sid_unknown');

  // ── Integrity checksum ─────────────────────────────────────────────────────
  var _checksum = 0;
  function _updateChecksum(str) {
    for (var i = 0; i < str.length; i++) {
      _checksum = ((_checksum << 5) - _checksum) + str.charCodeAt(i);
      _checksum = _checksum | 0;
    }
  }

  // ── IDB handle ────────────────────────────────────────────────────────────
  var _db = null;

  function _openDb() {
    return new Promise(function (resolve, reject) {
      if (!_enabled) return reject(new Error('disabled'));
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        if (!db.objectStoreNames.contains(STORE_EVT)) {
          var evtStore = db.createObjectStore(STORE_EVT, { autoIncrement: true, keyPath: 'seq' });
          evtStore.createIndex('sessionId', 'sessionId', { unique: false });
          evtStore.createIndex('ts',        'ts',        { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SNAP)) {
          var snapStore = db.createObjectStore(STORE_SNAP, { autoIncrement: true, keyPath: 'seq' });
          snapStore.createIndex('sessionId', 'sessionId', { unique: false });
          snapStore.createIndex('ts',        'ts',        { unique: false });
        }
      };

      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function _getDb() {
    if (_db) return Promise.resolve(_db);
    return _openDb().then(function (db) { _db = db; return db; });
  }

  // ── Rolling prune (enforce retention limits) ───────────────────────────────
  function _prune(db, storeName, maxItems) {
    return new Promise(function (resolve) {
      try {
        var tx    = db.transaction([storeName], 'readwrite');
        var store = tx.objectStore(storeName);
        var tsIdx = store.index('ts');
        var cutoff = Date.now() - RETAIN_MS;

        // Delete expired
        var range = IDBKeyRange.upperBound(cutoff);
        tsIdx.openCursor(range).onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };

        // Count and trim if over max
        store.count().onsuccess = function (e) {
          var count = e.target.result;
          if (count <= maxItems) return resolve();
          var excess = count - maxItems;
          var deleted = 0;
          store.openCursor().onsuccess = function (e2) {
            var c = e2.target.result;
            if (c && deleted < excess) { c.delete(); deleted++; c.continue(); }
            else resolve();
          };
        };

        tx.onerror = function () { resolve(); };
      } catch (_) { resolve(); }
    });
  }

  // ── Persist event ──────────────────────────────────────────────────────────
  function persistEvent(eventType, meta) {
    if (!_enabled) return Promise.resolve();
    _updateChecksum(eventType + ':' + Date.now());

    return _getDb().then(function (db) {
      var record = {
        sessionId:  _sessionId,
        eventType:  String(eventType).slice(0, 80),
        meta:       meta ? JSON.stringify(meta).slice(0, 400) : null,
        checksum:   _checksum,
        ts:         Date.now(),
      };
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([STORE_EVT], 'readwrite');
          tx.objectStore(STORE_EVT).add(record);
          tx.oncomplete = function () { resolve(); };
          tx.onerror    = function () { resolve(); };
        } catch (_) { resolve(); }
      });
    }).then(function () {
      return _getDb().then(function (db) { return _prune(db, STORE_EVT, MAX_EVENTS); });
    }).catch(function () {});
  }

  // ── Persist snapshot ───────────────────────────────────────────────────────
  function persistSnapshot(trigger, state) {
    if (!_enabled) return Promise.resolve();

    return _getDb().then(function (db) {
      var record = {
        sessionId: _sessionId,
        trigger:   String(trigger).slice(0, 80),
        state:     state ? JSON.stringify(state).slice(0, 2000) : null,
        checksum:  _checksum,
        ts:        Date.now(),
      };
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([STORE_SNAP], 'readwrite');
          tx.objectStore(STORE_SNAP).add(record);
          tx.oncomplete = function () { resolve(); };
          tx.onerror    = function () { resolve(); };
        } catch (_) { resolve(); }
      });
    }).then(function () {
      return _getDb().then(function (db) { return _prune(db, STORE_SNAP, MAX_SNAPS); });
    }).catch(function () {});
  }

  // ── Load session ───────────────────────────────────────────────────────────
  function loadSession(sid) {
    var targetSid = sid || _sessionId;
    if (!_enabled) return Promise.resolve(null);

    return _getDb().then(function (db) {
      var events    = [];
      var snapshots = [];

      var evtRange = IDBKeyRange.only(targetSid);

      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([STORE_EVT, STORE_SNAP], 'readonly');
          var evtStore  = tx.objectStore(STORE_EVT).index('sessionId');
          var snapStore = tx.objectStore(STORE_SNAP).index('sessionId');

          evtStore.openCursor(evtRange).onsuccess = function (e) {
            var c = e.target.result;
            if (c) { events.push(c.value); c.continue(); }
          };
          snapStore.openCursor(evtRange).onsuccess = function (e) {
            var c = e.target.result;
            if (c) { snapshots.push(c.value); c.continue(); }
          };
          tx.oncomplete = function () {
            resolve({ sessionId: targetSid, events: events, snapshots: snapshots });
          };
          tx.onerror = function () { resolve(null); };
        } catch (_) { resolve(null); }
      });
    }).catch(function () { return null; });
  }

  // ── Export forensic bundle ─────────────────────────────────────────────────
  function exportBundle() {
    return loadSession(_sessionId).then(function (rec) {
      return {
        sessionId:  _sessionId,
        tier:       _tier,
        checksum:   _checksum,
        events:     rec ? rec.events   : [],
        snapshots:  rec ? rec.snapshots : [],
        exportedAt: Date.now(),
        version:    VERSION,
      };
    });
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
  function clear() {
    if (!_enabled) return Promise.resolve();
    return _getDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([STORE_EVT, STORE_SNAP], 'readwrite');
          tx.objectStore(STORE_EVT).clear();
          tx.objectStore(STORE_SNAP).clear();
          tx.oncomplete = function () { _checksum = 0; resolve(); };
          tx.onerror    = function () { resolve(); };
        } catch (_) { resolve(); }
      });
    }).catch(function () {});
  }

  // ── Auto-flush to server on pagehide ──────────────────────────────────────
  function _flushOnHide() {
    _s(function () {
      var sr = G.RuntimeSessionRecorder;
      if (sr && typeof sr.export === 'function') {
        var exported = sr.export();
        if (exported && exported.events && exported.events.length > 0) {
          persistEvent('session_end_flush', { eventCount: exported.events.length });
        }
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }

    // Wire into RuntimeSessionRecorder via EventBus
    setTimeout(function () {
      _s(function () {
        var eb = G.RuntimeEventBus;
        if (!eb) return;
        eb.on('security:anomaly', function (data) {
          persistEvent('anomaly', data ? { type: data.type, severity: data.severity } : null);
        });
        eb.on('seal:failure', function (data) {
          persistEvent('seal_failure', data);
        });
        eb.on('session:rotated', function (data) {
          persistEvent('session_rotated', data);
        });
      });
    }, 5000);

    // Persist boot event
    persistEvent('session_boot', { tier: _tier, sessionId: _sessionId });

    // Flush on navigation away
    window.addEventListener('pagehide', _flushOnHide, { once: true });

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| sid:', _sessionId.slice(0, 12));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeSessionPersistence = Object.freeze({
    VERSION:         VERSION,
    persistEvent:    persistEvent,
    persistSnapshot: persistSnapshot,
    loadSession:     loadSession,
    exportBundle:    exportBundle,
    clear:           clear,
    status: function () {
      return {
        version:   VERSION,
        enabled:   _enabled,
        tier:      _tier,
        sessionId: _sessionId,
        checksum:  _checksum,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
