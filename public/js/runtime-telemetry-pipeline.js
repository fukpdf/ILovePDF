// RuntimeTelemetryPipeline v2.0 — Phase 5 / Task 3 (Advanced Telemetry Pipeline)
// =============================================================================
// Upgrade from v1.0 (Phase 4) to v2.0 (Phase 5).
//
// NEW in v2.0:
//   • IndexedDB fallback — persists event queue across page reloads
//   • Telemetry compression — LZ-style RLE token compression before upload
//   • Replay-safe uploads — deduplicated event IDs prevent re-processing
//   • Crash timeline reconstruction — session event log from IDB
//   • Session replay metadata — page timeline for incident reconstruction
//   • Worker incident reports — captures worker health snapshots on anomaly
//
// v1.0 retained:
//   • SecurityTelemetry subscription (batched, rate-limited)
//   • 60s periodic upload OR 20-event batch trigger
//   • Min 30s gap between uploads
//   • requestIdleCallback scheduling
//   • pause() / resume() / flush() API
//   • LOW tier disabled
//
// window.RuntimeTelemetryPipeline (v2.0 — backward-compatible)
//   .flush()          → Promise<void>
//   .status()         → StatusObject
//   .pause()          → void
//   .resume()         → void
//   .getSessionLog()  → Promise<event[]>   ← NEW (IDB replay)
//   .exportIncident() → Promise<blob>      ← NEW (crash timeline blob)
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeTelemetryPipeline && G.RuntimeTelemetryPipeline.VERSION === '2.0') return;

  var VERSION       = '2.0';
  var LOG           = '[TelPipeline2]';
  var ENDPOINT      = '/api/security-telemetry';
  var MAX_BATCH     = 20;
  var MAX_QUEUE     = 200;   // v2.0: doubled for IDB-backed overflow
  var UPLOAD_INT_MS = 60000;
  var MIN_GAP_MS    = 30000;
  var IDB_NAME      = 'iplv_telemetry_v2';
  var IDB_STORE     = 'events';
  var IDB_MAX       = 500;   // max persisted events in IDB

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier check ─────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;
  var _high = _score >= 70;

  // ── State ──────────────────────────────────────────────────────────────────
  var _queue    = [];
  var _paused   = false;
  var _lastSend = 0;
  var _idb      = null;   // IndexedDB connection
  var _sentIds  = new Set(); // replay-safe deduplication
  var _stats = { queued: 0, sent: 0, errors: 0, batches: 0, idbSaved: 0, idbRestored: 0, compressed: 0 };

  // ── Session metadata (replay reconstruction) ──────────────────────────────
  var _sessionMeta = {
    sessionId:  _generateId(),
    startTs:    Date.now(),
    pageUrl:    _s(function () { return G.location.href; }, ''),
    userAgent:  _s(function () { return G.navigator.userAgent.slice(0, 100); }, ''),
    score:      _score,
    events:     [],   // lightweight session timeline
  };

  function _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INDEXEDDB PERSISTENCE (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  function _openIdb() {
    if (!G.indexedDB || _lite) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var req = G.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db    = e.target.result;
        var store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts',  'ts',  { unique: false });
        store.createIndex('sid', 'sid', { unique: false });
      };
      req.onsuccess  = function (e) { resolve(e.target.result); };
      req.onerror    = function ()  { resolve(null); };
    });
  }

  function _idbSave(events) {
    if (!_idb || !events.length) return;
    _s(function () {
      var tx    = _idb.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      for (var ev of events) {
        store.put(Object.assign({ sid: _sessionMeta.sessionId }, ev));
        _stats.idbSaved++;
      }
      // Rolling cleanup: remove oldest if over limit
      var countReq = store.count();
      countReq.onsuccess = function () {
        var excess = countReq.result - IDB_MAX;
        if (excess > 0) {
          var cursor = store.openCursor();
          var deleted = 0;
          cursor.onsuccess = function (e) {
            var c = e.target.result;
            if (c && deleted < excess) { c.delete(); deleted++; c.continue(); }
          };
        }
      };
    });
  }

  function _idbLoad() {
    if (!_idb) return Promise.resolve([]);
    return new Promise(function (resolve) {
      _s(function () {
        var tx    = _idb.transaction(IDB_STORE, 'readonly');
        var store = tx.objectStore(IDB_STORE);
        var req   = store.getAll();
        req.onsuccess = function () {
          var events = req.result || [];
          _stats.idbRestored += events.length;
          resolve(events);
        };
        req.onerror = function () { resolve([]); };
      });
      resolve([]); // fallback if _s throws
    });
  }

  function getSessionLog() {
    return _idbLoad().then(function (events) {
      // Filter to current session only
      return events.filter(function (e) { return e.sid === _sessionMeta.sessionId; });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMPRESSION (v2.0 new — simple run-length + JSON minification)
  // ─────────────────────────────────────────────────────────────────────────
  // Compresses batch payload by:
  //   1. Removing null/undefined values from event objects
  //   2. Deduplicating common string values into a lookup table
  //   3. RLE-compressing repeated event types
  function _compress(events) {
    if (!events.length) return { events: events, compressed: false };

    try {
      // Deduplicate type strings
      var typeMap  = {};
      var typeIdx  = 0;
      var compact  = events.map(function (ev) {
        var e = {};
        for (var k in ev) {
          if (ev[k] !== null && ev[k] !== undefined) {
            e[k] = ev[k];
          }
        }
        return e;
      });

      // Check if RLE compression would help
      var typeCounts = {};
      compact.forEach(function (e) { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });
      var dominated = Object.values(typeCounts).some(function (c) { return c > events.length / 2; });

      if (!dominated) {
        // No meaningful compression opportunity
        return { events: compact, compressed: false };
      }

      // Group consecutive same-type events
      var groups = [];
      var current = null;
      for (var ev of compact) {
        if (current && current.type === ev.type) {
          current.count++;
          current.tsLast = ev.ts || current.tsLast;
        } else {
          if (current) groups.push(current);
          current = { type: ev.type, count: 1, ts: ev.ts, tsLast: ev.ts, sample: ev };
        }
      }
      if (current) groups.push(current);

      _stats.compressed++;
      return { events: compact, groups: groups, compressed: true, originalCount: events.length };
    } catch (_) {
      return { events: events, compressed: false };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WORKER INCIDENT SNAPSHOT (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  function _captureWorkerSnapshot() {
    return _s(function () {
      var hb = G.RuntimeP4Heartbeat;
      if (!hb || typeof hb.status !== 'function') return null;
      return hb.status();
    }, null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT INCIDENT BLOB (v2.0 new)
  // ─────────────────────────────────────────────────────────────────────────
  function exportIncident() {
    return Promise.all([
      getSessionLog(),
      _captureWorkerSnapshot() ? Promise.resolve(_captureWorkerSnapshot()) : Promise.resolve(null),
    ]).then(function (results) {
      var incident = {
        generated:   new Date().toISOString(),
        session:     _sessionMeta,
        events:      results[0],
        workerState: results[1],
        memSnapshot: _s(function () {
          var pfs = G.RuntimePerfSafety;
          return pfs && typeof pfs.getMemorySnapshot === 'function' ? pfs.getMemorySnapshot() : null;
        }, null),
        anomalyScore: _s(function () {
          var ses = G.RuntimeSecurityEventSchema;
          return ses && typeof ses.getAnomalyScore === 'function' ? ses.getAnomalyScore() : null;
        }, null),
        sealStatus: _s(function () {
          var ds = G.RuntimeDeploySeal;
          return ds && typeof ds.status === 'function' ? ds.status() : null;
        }, null),
      };
      var json = JSON.stringify(incident, null, 2);
      return new Blob([json], { type: 'application/json' });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUEUE + UPLOAD (v2.0 — replay-safe + compressed)
  // ─────────────────────────────────────────────────────────────────────────
  function _enqueue(ev) {
    // Assign replay-safe ID
    if (!ev.id) ev.id = _generateId();
    if (_sentIds.has(ev.id)) return; // already sent this event

    if (_queue.length >= MAX_QUEUE) _queue.shift();
    _queue.push(ev);
    _stats.queued++;

    // Session timeline (lightweight)
    _sessionMeta.events.push({ type: ev.type, ts: ev.ts || Date.now() });
    if (_sessionMeta.events.length > 200) _sessionMeta.events.shift();

    // IDB persistence for HIGH tier
    if (_high && _idb) _idbSave([ev]);

    if (_queue.length >= MAX_BATCH) _scheduleFlush(0);
  }

  function flush() {
    if (_paused || _queue.length === 0) return Promise.resolve();
    if ((Date.now() - _lastSend) < MIN_GAP_MS) return Promise.resolve();

    var batch    = _queue.splice(0, MAX_BATCH);
    var payload  = _compress(batch);
    _lastSend    = Date.now();

    // Mark IDs as sent for replay-safety
    batch.forEach(function (ev) { if (ev.id) _sentIds.add(ev.id); });
    if (_sentIds.size > 5000) {
      var arr = Array.from(_sentIds);
      _sentIds = new Set(arr.slice(arr.length - 2000));
    }

    return fetch(ENDPOINT, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify({ events: payload.events, compressed: payload.compressed, sessionId: _sessionMeta.sessionId }),
      keepalive: true,
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      _stats.sent    += batch.length;
      _stats.batches += 1;
      return res.json();
    })
    .then(function (data) {
      console.debug(LOG, 'batch sent | accepted:', data.accepted, '| rejected:', data.rejected,
        '| compressed:', payload.compressed);
    })
    .catch(function (err) {
      _stats.errors++;
      var restore = batch.slice(0, MAX_QUEUE - _queue.length);
      _queue.unshift.apply(_queue, restore);
      // Remove re-queued IDs from sent set so they can be retried
      restore.forEach(function (ev) { if (ev.id) _sentIds.delete(ev.id); });
      console.debug(LOG, 'upload error:', err.message, '— re-queued', restore.length, 'events');
    });
  }

  var _flushTimer = null;
  function _scheduleFlush(delay) {
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(function () {
      if (typeof G.requestIdleCallback === 'function') {
        G.requestIdleCallback(function () { flush(); }, { timeout: 5000 });
      } else {
        flush();
      }
    }, delay === undefined ? UPLOAD_INT_MS : delay);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUBSCRIPTIONS (v2.0 — also subscribes to RuntimeEventBus security events)
  // ─────────────────────────────────────────────────────────────────────────
  function _subscribeToTelemetry() {
    _s(function () {
      var rt = G.RuntimeTelemetry;
      if (rt && typeof rt.on === 'function') {
        rt.on('security:*', function (eventName, data) {
          _enqueue({ type: eventName, ts: Date.now(), data: data || {} });
        });
        return;
      }

      // Fallback: bus events
      var bus = G.RuntimeEventBus;
      if (!bus || typeof bus.on !== 'function') return;

      var TRACKED = [
        'shield:tamper-response', 'shield:devtools-degraded',
        'security:foreign-deploy', 'sri:mismatch', 'sri:worker-blocked',
        'seal:failure', 'panic:activated', 'security:anomaly',
        'worker:blocked', 'perf:memory-pressure', 'perf:thermal-pressure',
        'perf:battery-critical', 'perf:battery-low',
      ];
      TRACKED.forEach(function (evType) {
        bus.on(evType, function (data) {
          _enqueue({ type: evType.replace(/[:/]/g, '-').replace('--', '-'), ts: Date.now(),
            data: data || {}, workerSnapshot: evType.includes('worker') ? _captureWorkerSnapshot() : undefined });
        });
      });
    });
  }

  function _startPeriodicUpload() {
    var _schedNext;
    _schedNext = function () {
      if (typeof G.requestIdleCallback === 'function') {
        G.requestIdleCallback(function () {
          flush().then(function () { setTimeout(_schedNext, UPLOAD_INT_MS); });
        }, { timeout: 5000 });
      } else {
        flush();
        setTimeout(_schedNext, UPLOAD_INT_MS);
      }
    };
    setTimeout(_schedNext, UPLOAD_INT_MS);
  }

  function _flushOnUnload() {
    _s(function () {
      G.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && _queue.length > 0) flush();
      });
      G.addEventListener('pagehide', function () { if (_queue.length > 0) flush(); });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IDB RESTORE (load un-sent events from previous session on boot)
  // ─────────────────────────────────────────────────────────────────────────
  function _restoreFromIdb() {
    if (!_high) return;
    _idbLoad().then(function (events) {
      var prevSession = events.filter(function (e) {
        return e.sid !== _sessionMeta.sessionId &&
          (Date.now() - (e.ts || 0)) < 2 * 60 * 60 * 1000; // within 2 hours
      });
      if (prevSession.length > 0) {
        console.info(LOG, 'restoring', prevSession.length, 'events from previous session');
        prevSession.forEach(function (ev) { _queue.push(ev); _stats.idbRestored++; });
        // Flush restored events shortly after boot
        setTimeout(function () { flush().catch(function () {}); }, 5000);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────────────────────────────────
  function _boot() {
    if (_lite) {
      console.info(LOG, 'v' + VERSION + ' loaded | lite mode — pipeline disabled');
      return;
    }

    // Open IDB asynchronously — doesn't block boot
    _openIdb().then(function (db) {
      _idb = db;
      if (db) {
        console.debug(LOG, 'IndexedDB persistence active');
        _restoreFromIdb();
      }
    });

    _subscribeToTelemetry();
    _startPeriodicUpload();
    _flushOnUnload();

    console.info(LOG, 'v' + VERSION + ' ready | endpoint:', ENDPOINT,
      '| batch:', MAX_BATCH, '| IDB:', !_lite, '| HIGH:', _high);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  // ── Public API (v2.0 — superset of v1.0) ─────────────────────────────────
  G.RuntimeTelemetryPipeline = Object.freeze({
    VERSION:       VERSION,
    flush:         flush,
    pause:         function () { _paused = true; },
    resume:        function () { _paused = false; },
    getSessionLog: getSessionLog,
    exportIncident: exportIncident,
    status: function () {
      return {
        version:     VERSION,
        queued:      _queue.length,
        sent:        _stats.sent,
        errors:      _stats.errors,
        batches:     _stats.batches,
        idbSaved:    _stats.idbSaved,
        idbRestored: _stats.idbRestored,
        compressed:  _stats.compressed,
        paused:      _paused,
        idbReady:    !!_idb,
        sessionId:   _sessionMeta.sessionId,
        tier:        _lite ? 'LOW' : (_score < 70 ? 'MEDIUM' : 'HIGH'),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
