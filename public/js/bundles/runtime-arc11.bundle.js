// ── Arc 11 Distributed Runtime Mesh + Persistent Diagnostics — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-29T10:30:45.763Z  BUILD_ID: mpqs70k8
// Files: 13

// ── SOURCE: public/js/runtime-tab-mesh.js ──
// RuntimeTabMesh v2.0 — Arc 11 / Phase A
// =============================================================================
// Cross-tab runtime coordination mesh.
//
// v2.0 additions over v1.0:
//   - Shared workload map (cross-tab workload tracking)
//   - Shared thermal state (device heat level coordination)
//   - Shared memory pressure map (per-tab memory tier awareness)
//   - Active tab registry with capability scoring
//   - Workload broadcast + lease acknowledgement protocol
//   - Stale workload reclaim (orphaned leases auto-returned)
//   - Full shared state replication by leader every 10 s
//
// v1.0 APIs fully preserved:
//   .broadcast(type, data)          → void
//   .getTabs()                      → Tab[]
//   .isLeader()                     → boolean
//   .lockAllTabs(reason)            → void
//   .getIncidentHistory()           → Incident[]
//   .status()                       → StatusObject
//
// New v2.0 APIs:
//   .getWorkloadMap()               → WorkloadEntry[]
//   .getThermalState()              → ThermalSnapshot
//   .getMemoryPressureMap()         → { [tabId]: tier }
//   .broadcastWorkload(item)        → leaseId
//   .reclaimOrphanedWorkloads()     → number reclaimed
//
// Protocol messages (extends v1.0):
//   WORKLOAD_OFFER   — leader distributes a workload unit
//   WORKLOAD_ACK     — tab claims a workload lease
//   WORKLOAD_DONE    — tab signals workload completion
//   THERMAL_SYNC     — device thermal state broadcast
//   MEMORY_SYNC      — per-tab memory pressure update
//   SHARED_STATE     — full mesh state replication (leader → peers)
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeTabMesh) return;

  var VERSION    = '2.0';
  var LOG        = '[TabMesh]';
  var CHANNEL    = 'p8_tab_mesh';
  var HEARTBEAT_INTERVAL   = 2000;
  var STALE_THRESHOLD      = 6000;
  var WORKLOAD_LEASE_TTL   = 30000;
  var SHARED_STATE_INTERVAL = 10000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40 && typeof BroadcastChannel !== 'undefined';

  // ── Tab identity ───────────────────────────────────────────────────────────
  var _tabId  = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  var _bid    = Math.random();
  var _leader = null;
  var _isLeader = false;

  // ── Core state ─────────────────────────────────────────────────────────────
  var _tabs             = {};
  var _incidentHistory  = [];
  var _locked           = false;
  var _channel          = null;
  var _sharedStateTimer = null;

  // ── v2.0 shared state ─────────────────────────────────────────────────────
  var _workloadMap  = {};
  var _thermalState = { level: 'nominal', ts: 0, source: null };
  var _memPressureMap = {};

  // ── Channel ────────────────────────────────────────────────────────────────
  function _openChannel() {
    try {
      _channel = new BroadcastChannel(CHANNEL);
      _channel.onmessage = _onMessage;
    } catch (e) {
      console.warn(LOG, 'BroadcastChannel unavailable:', e.message);
      _channel = null;
    }
  }

  function _send(type, data) {
    if (!_channel) return;
    try {
      _channel.postMessage({ type: type, tabId: _tabId, bid: _bid, ts: Date.now(), data: data || null });
    } catch (_) {}
  }

  // ── Message dispatch ───────────────────────────────────────────────────────
  function _onMessage(evt) {
    var msg = evt && evt.data;
    if (!msg || !msg.tabId || msg.tabId === _tabId) return;
    var tid = msg.tabId;

    switch (msg.type) {
      case 'HEARTBEAT':
        _tabs[tid] = { id: tid, ts: msg.ts, bid: msg.bid, isLeader: msg.data && msg.data.isLeader,
                       thermal: msg.data && msg.data.thermal, memTier: msg.data && msg.data.memTier };
        if (msg.data && msg.data.memTier) _memPressureMap[tid] = msg.data.memTier;
        _pruneStale();
        _checkLeader();
        break;

      case 'INCIDENT':
        _receiveIncident(msg.data, tid);
        break;

      case 'ANOMALY':
        _s(function () {
          var ba = G.RuntimeBehaviorAnalysis;
          if (ba && typeof ba.externalSignal === 'function') ba.externalSignal('tab-mesh', msg.data);
        });
        break;

      case 'LOCK':
        if (!_locked) {
          _locked = true;
          console.warn(LOG, 'session lock received from tab:', tid);
          _s(function () {
            var eb = G.RuntimeEventBus;
            if (eb && typeof eb.emit === 'function') eb.emit('session:lock', { source: 'tab-mesh', from: tid });
          });
        }
        break;

      case 'LEADER_BID':
        if (msg.bid > _bid || (msg.bid === _bid && tid > _tabId)) {
          _send('LEADER_ACK', { winner: tid });
          _isLeader = false;
        }
        break;

      case 'LEADER_ACK':
        if (msg.data && msg.data.winner === _tabId) {
          _isLeader = true;
          _leader   = _tabId;
          console.info(LOG, 'became mesh leader v2.0');
          _scheduleSharedStateSync();
        }
        break;

      case 'WORKLOAD_OFFER':
        if (msg.data && msg.data.leaseId) {
          _s(function () {
            var dw = G.RuntimeDistributedWorkload;
            if (dw && typeof dw._onWorkloadOffer === 'function') dw._onWorkloadOffer(msg.data, tid);
          });
        }
        break;

      case 'WORKLOAD_ACK':
        if (msg.data && msg.data.leaseId && _workloadMap[msg.data.leaseId]) {
          _workloadMap[msg.data.leaseId].status  = 'claimed';
          _workloadMap[msg.data.leaseId].tabId   = tid;
          _workloadMap[msg.data.leaseId].claimedTs = Date.now();
        }
        break;

      case 'WORKLOAD_DONE':
        if (msg.data && msg.data.leaseId && _workloadMap[msg.data.leaseId]) {
          _workloadMap[msg.data.leaseId].status = 'done';
          _workloadMap[msg.data.leaseId].doneTs = Date.now();
        }
        break;

      case 'THERMAL_SYNC':
        if (msg.data) {
          var lvl  = msg.data.level || 'nominal';
          var LVLS = ['nominal', 'warm', 'hot', 'critical'];
          if (LVLS.indexOf(lvl) > LVLS.indexOf(_thermalState.level)) {
            _thermalState = { level: lvl, ts: msg.ts, source: tid };
          }
        }
        break;

      case 'MEMORY_SYNC':
        if (msg.data && msg.data.tier) _memPressureMap[tid] = msg.data.tier;
        break;

      case 'SHARED_STATE':
        if (msg.data) {
          if (msg.data.workloadMap)    Object.assign(_workloadMap, msg.data.workloadMap);
          if (msg.data.thermalState)   _thermalState = msg.data.thermalState;
          if (msg.data.memPressureMap) Object.assign(_memPressureMap, msg.data.memPressureMap);
        }
        break;
    }
  }

  // ── Incident relay ─────────────────────────────────────────────────────────
  function _receiveIncident(data, fromTab) {
    if (!data) return;
    _incidentHistory.push({ id: data.id, type: data.type, severity: data.severity,
                            fromTab: fromTab, ts: Date.now() });
    if (_incidentHistory.length > 100) _incidentHistory.shift();
    _s(function () {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie._create === 'function') {
        ie._create('cross-tab:' + (data.type || 'unknown'), (data.score || 30), 'tab-mesh',
          { fromTab: fromTab, original: data.id });
      }
    });
    _s(function () {
      var ss = G.RuntimeSecurityStream;
      if (ss && typeof ss.push === 'function') {
        ss.push('tab-mesh-incident', 'tab-mesh', data.severity || 'MEDIUM',
          'Cross-tab incident: ' + (data.type || 'unknown'), { from: fromTab });
      }
    });
  }

  // ── Stale pruning ─────────────────────────────────────────────────────────
  function _pruneStale() {
    var cutoff = Date.now() - STALE_THRESHOLD;
    Object.keys(_tabs).forEach(function (id) {
      if (_tabs[id].ts < cutoff) { delete _tabs[id]; delete _memPressureMap[id]; }
    });
  }

  // ── Leader election ────────────────────────────────────────────────────────
  function _checkLeader() {
    if (_leader && _tabs[_leader] && _tabs[_leader].ts > Date.now() - STALE_THRESHOLD) return;
    var candidates = [{ id: _tabId, bid: _bid }];
    Object.keys(_tabs).forEach(function (id) { candidates.push({ id: id, bid: _tabs[id].bid || 0 }); });
    candidates.sort(function (a, b) { return b.bid !== a.bid ? b.bid - a.bid : b.id > a.id ? 1 : -1; });
    var winner = candidates[0];
    if (winner.id === _tabId && !_isLeader) {
      _isLeader = true; _leader = _tabId;
      _send('LEADER_BID', null);
      console.info(LOG, 'leader election won by this tab (v2.0)');
      _scheduleSharedStateSync();
    } else if (winner.id !== _tabId) {
      _isLeader = false; _leader = winner.id;
    }
  }

  // ── Shared state replication (leader only) ────────────────────────────────
  function _scheduleSharedStateSync() {
    if (_sharedStateTimer) return;
    _sharedStateTimer = setInterval(function () {
      if (!_isLeader) { clearInterval(_sharedStateTimer); _sharedStateTimer = null; return; }
      _reclaimInternal();
      _send('SHARED_STATE', { workloadMap: _workloadMap, thermalState: _thermalState,
                               memPressureMap: _memPressureMap });
    }, SHARED_STATE_INTERVAL);
  }

  // ── Workload management ────────────────────────────────────────────────────
  function broadcastWorkload(item) {
    var leaseId = 'wl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    _workloadMap[leaseId] = { leaseId: leaseId, tabId: _tabId, type: item.type || 'generic',
                               ts: Date.now(), status: 'offered', data: item.data || null };
    _send('WORKLOAD_OFFER', Object.assign({}, item, { leaseId: leaseId }));
    return leaseId;
  }

  function _reclaimInternal() {
    var cutoff = Date.now() - WORKLOAD_LEASE_TTL;
    var n = 0;
    Object.keys(_workloadMap).forEach(function (id) {
      var w = _workloadMap[id];
      if ((w.status === 'offered' || w.status === 'claimed') && w.ts < cutoff) {
        _workloadMap[id].status = 'orphaned'; n++;
      }
    });
    return n;
  }

  function reclaimOrphanedWorkloads() { return _reclaimInternal(); }
  function getWorkloadMap() {
    return Object.keys(_workloadMap).map(function (id) { return Object.assign({}, _workloadMap[id]); });
  }
  function getThermalState()      { return Object.assign({}, _thermalState); }
  function getMemoryPressureMap() { return Object.assign({}, _memPressureMap); }

  // ── Thermal / memory periodic sync ────────────────────────────────────────
  function _syncThermal() {
    var lvl = _s(function () {
      var ai = G.RuntimeAdaptiveAI;
      return ai && typeof ai.getThermal === 'function' ? ai.getThermal().level : null;
    }, null);
    if (lvl) { _thermalState = { level: lvl, ts: Date.now(), source: _tabId }; _send('THERMAL_SYNC', { level: lvl }); }
  }

  function _syncMemory() {
    var tier = _s(function () {
      var pm = G.RuntimeProcessorMemory;
      if (pm && typeof pm.getTier === 'function') return pm.getTier();
      var mm = G.RuntimeMemoryOrchestrator;
      return mm && typeof mm.getTier === 'function' ? mm.getTier() : null;
    }, null);
    if (tier) { _memPressureMap[_tabId] = tier; _send('MEMORY_SYNC', { tier: tier }); }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function broadcast(type, data) { _send(type, data); }

  function getTabs() {
    _pruneStale();
    var list = [{ id: _tabId, ts: Date.now(), bid: _bid, isLeader: _isLeader, self: true }];
    Object.keys(_tabs).forEach(function (id) { list.push(Object.assign({}, _tabs[id], { self: false })); });
    return list;
  }

  function isLeader() { return _isLeader; }

  function lockAllTabs(reason) {
    _locked = true;
    _send('LOCK', { reason: reason || 'manual' });
    console.warn(LOG, 'issuing session lock to all tabs | reason:', reason);
  }

  function getIncidentHistory() { return _incidentHistory.slice(); }

  // ── Local incident subscription ────────────────────────────────────────────
  function _subscribeToLocalIncidents() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      eb.on('security:anomaly', function (data) {
        if (!data) return;
        _send('ANOMALY', { score: data.score, severity: data.severity, type: data.type });
      });
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _openChannel();
    setInterval(function () {
      _send('HEARTBEAT', { isLeader: _isLeader, thermal: _thermalState.level,
                           memTier: _memPressureMap[_tabId] || null });
      _pruneStale();
    }, HEARTBEAT_INTERVAL);

    setTimeout(function () { _send('LEADER_BID', null); setTimeout(_checkLeader, 1000); }, 500);
    setTimeout(_subscribeToLocalIncidents, 5000);
    setInterval(_syncThermal, 15000);
    setInterval(_syncMemory, 10000);

    console.debug(LOG, 'v' + VERSION + ' ready | tabId:', _tabId, '| tier:', _tier, '| channel:', CHANNEL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  window.addEventListener('pagehide', function () {
    if (_sharedStateTimer) clearInterval(_sharedStateTimer);
    if (_channel) { try { _channel.close(); } catch (_) {} }
  }, { once: true });

  G.RuntimeTabMesh = Object.freeze({
    VERSION:                  VERSION,
    broadcast:                broadcast,
    getTabs:                  getTabs,
    isLeader:                 isLeader,
    lockAllTabs:              lockAllTabs,
    getIncidentHistory:       getIncidentHistory,
    getWorkloadMap:           getWorkloadMap,
    getThermalState:          getThermalState,
    getMemoryPressureMap:     getMemoryPressureMap,
    broadcastWorkload:        broadcastWorkload,
    reclaimOrphanedWorkloads: reclaimOrphanedWorkloads,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, tabId: _tabId,
               isLeader: _isLeader, tabs: Object.keys(_tabs).length + 1, locked: _locked,
               incidents: _incidentHistory.length, workloads: Object.keys(_workloadMap).length,
               thermalLevel: _thermalState.level, memPressureTabs: Object.keys(_memPressureMap).length };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-blackbox-storage.js ──
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

// ── SOURCE: public/js/runtime-crash-survival.js ──
// RuntimeCrashSurvival v1.0 — Arc 11 / Phase C
// =============================================================================
// Crash detection and cross-reload session recovery.
//
// Detection methods:
//   unexpected_reload   — page was loaded without a clean unload marker
//   memory_panic        — browser OOM signal (processor-memory:panic event)
//   worker_crash_storm  — > WORKER_STORM_THRESHOLD crashes in STORM_WINDOW_MS
//   tab_kill            — visibilitychange + pagehide w/o user navigation
//
// Recovery flow:
//   1. On boot, check sessionStorage for crash markers left by previous session
//   2. If crash detected, load pre-crash snapshot from RuntimeBlackboxStorage
//   3. Replay diagnostics into RuntimeReplayEngine if available
//   4. Notify RuntimeAutonomousHealing so it can adjust recovery strategy
//   5. Emit 'crash-survival:recovered' event with recovery context
//
// Crash markers (written to sessionStorage):
//   _css_alive          — set on load, cleared on clean pagehide
//   _css_crash_type     — type of last crash
//   _css_crash_ts       — timestamp of last crash
//   _css_worker_storms  — running count of worker crash events
//
// window.RuntimeCrashSurvival
//   .getLastCrash()         → CrashRecord | null
//   .hasCrashed()           → boolean
//   .markCleanExit()        → void
//   .recover()              → Promise<RecoveryResult>
//   .getMetrics()           → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCrashSurvival) return;

  var VERSION = '1.0';
  var LOG     = '[CrashSurvival]';

  var KEY_ALIVE   = '_css_alive';
  var KEY_TYPE    = '_css_crash_type';
  var KEY_TS      = '_css_crash_ts';
  var KEY_STORMS  = '_css_worker_storms';

  var WORKER_STORM_THRESHOLD = 3;
  var STORM_WINDOW_MS        = 10000;

  var _ss = (function () {
    try { var t = sessionStorage; t.setItem('_css_test', '1'); t.removeItem('_css_test'); return t; }
    catch (_) { return null; }
  }());

  function _sGet(k) { try { return _ss && _ss.getItem(k); } catch (_) { return null; } }
  function _sSet(k, v) { try { if (_ss) _ss.setItem(k, String(v)); } catch (_) {} }
  function _sDel(k)    { try { if (_ss) _ss.removeItem(k); } catch (_) {} }
  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Crash detection on boot ───────────────────────────────────────────────
  var _wasAlive    = _sGet(KEY_ALIVE) === '1';
  var _lastType    = _sGet(KEY_TYPE)  || null;
  var _lastTs      = parseInt(_sGet(KEY_TS) || '0', 10);
  var _hasCrashed  = _wasAlive;  // alive marker was set but never cleared → crash

  var _lastCrash   = _hasCrashed ? { type: _lastType || 'unexpected_reload', ts: _lastTs } : null;
  var _metrics     = { crashes: _hasCrashed ? 1 : 0, recoveries: 0, workerStorms: 0, panics: 0 };
  var _workerCrashQ = [];  // timestamps of recent worker crashes

  // ── Set alive marker ──────────────────────────────────────────────────────
  _sSet(KEY_ALIVE, '1');
  _sSet(KEY_TS,    Date.now());

  // ── Clean exit ────────────────────────────────────────────────────────────
  function markCleanExit() {
    _sDel(KEY_ALIVE);
    _sDel(KEY_TYPE);
    _sDel(KEY_TS);
    _sDel(KEY_STORMS);
  }

  window.addEventListener('pagehide', function (e) {
    // persisted = true means the page went into bfcache (not a crash)
    if (!e || !e.persisted) markCleanExit();
  }, { once: true });

  // ── Worker crash storm detection ───────────────────────────────────────────
  window.addEventListener('tool:worker-crash', function () {
    var now = Date.now();
    _workerCrashQ.push(now);
    _workerCrashQ = _workerCrashQ.filter(function (t) { return now - t < STORM_WINDOW_MS; });
    if (_workerCrashQ.length >= WORKER_STORM_THRESHOLD) {
      _metrics.workerStorms++;
      _sSet(KEY_TYPE, 'worker_crash_storm');
      _sSet(KEY_TS, now);
      console.warn(LOG, 'worker crash storm detected (', _workerCrashQ.length, 'crashes in', STORM_WINDOW_MS, 'ms)');
      _s(function () {
        G.dispatchEvent(new CustomEvent('crash-survival:worker-storm', {
          detail: { count: _workerCrashQ.length, windowMs: STORM_WINDOW_MS },
        }));
      });
    }
  });

  // ── Memory panic detection ─────────────────────────────────────────────────
  window.addEventListener('processor-memory:panic', function (evt) {
    _metrics.panics++;
    _sSet(KEY_TYPE, 'memory_panic');
    _sSet(KEY_TS,   Date.now());
    console.warn(LOG, 'memory panic recorded for crash survival');
    // Trigger a pre-crash snapshot save
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      var ss  = G.RuntimeStateSnapshots;
      if (bbs && ss && typeof ss.take === 'function') {
        ss.take('pre-crash-memory-panic').then(function (snap) {
          if (snap) bbs.persist(snap);
        }).catch(function () {});
      }
    });
  });

  // ── Recovery ──────────────────────────────────────────────────────────────
  function recover() {
    if (!_hasCrashed) return Promise.resolve({ recovered: false, reason: 'no-crash-detected' });
    _metrics.recoveries++;
    console.info(LOG, 'recovering from crash:', _lastCrash.type, 'at', new Date(_lastCrash.ts).toISOString());

    return Promise.resolve()
      .then(function () {
        // 1. Load last snapshot from IndexedDB
        var bbs = G.RuntimeBlackboxStorage;
        if (!bbs || !bbs.isAvailable()) return null;
        return bbs.loadLastSession();
      })
      .then(function (snap) {
        var context = { crash: _lastCrash, hasSnapshot: !!snap };

        // 2. Replay into RuntimeReplayEngine
        _s(function () {
          var re = G.RuntimeReplayEngine;
          if (re && typeof re.load === 'function' && snap && snap.data && snap.data.events) {
            re.load(snap.data.events, { label: 'crash-recovery', crash: _lastCrash });
          }
        });

        // 3. Notify healing engine
        _s(function () {
          var ah = G.RuntimeAutonomousHealing;
          if (ah && typeof ah.heal === 'function') {
            ah.heal('crash-survival:' + _lastCrash.type);
          }
        });

        // 4. Emit recovery event
        _s(function () {
          G.dispatchEvent(new CustomEvent('crash-survival:recovered', { detail: context }));
          var eb = G.RuntimeEventBus;
          if (eb && typeof eb.emit === 'function') eb.emit('crash-survival:recovered', context);
        });

        console.info(LOG, 'recovery complete | snapshot:', !!snap);
        return { recovered: true, crash: _lastCrash, hasSnapshot: !!snap };
      })
      .catch(function (e) {
        console.warn(LOG, 'recovery error:', e.message);
        return { recovered: false, error: e.message };
      });
  }

  // ── Deferred recovery on boot ─────────────────────────────────────────────
  if (_hasCrashed) {
    console.warn(LOG, 'previous session crashed | type:', _lastType, '| ts:', _lastTs);
    setTimeout(function () {
      recover().catch(function () {});
    }, 5000);  // defer so all other systems have time to boot
  }

  G.RuntimeCrashSurvival = Object.freeze({
    VERSION:       VERSION,
    hasCrashed:    function () { return _hasCrashed; },
    getLastCrash:  function () { return _lastCrash ? Object.assign({}, _lastCrash) : null; },
    markCleanExit: markCleanExit,
    recover:       recover,
    getMetrics:    function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded | crashed:', _hasCrashed, '| type:', _lastType);
}(window));

// ── SOURCE: public/js/runtime-sw-bridge.js ──
// RuntimeSWBridge v1.0 — Arc 11 / Phase D
// =============================================================================
// Service Worker ↔ Runtime diagnostics bridge.
//
// Capabilities:
//   - snapshot sync   : sends state snapshots to SW cache for offline access
//   - blackbox sync   : pushes rolling blackbox entries to SW via postMessage
//   - deploy sync     : relays BUILD_ID changes so SW knows when to update cache
//   - crash markers   : writes crash markers into SW cache for post-reload access
//   - offline persist : ensures key diagnostics survive offline periods
//
// Integration points:
//   RuntimeDeploySync  — listens to deploy:stale / deploy:new-build events
//   RuntimeBlackboxStorage — pulls snapshots to relay into SW
//
// Message protocol (window → SW):
//   { type: 'BB_SNAPSHOT',    payload: <snapshot_json> }
//   { type: 'BB_EVENTS',      payload: <events[]>      }
//   { type: 'DEPLOY_NOTIFY',  payload: { buildId, prevBuildId } }
//   { type: 'CRASH_MARKER',   payload: { type, ts }     }
//
// Message protocol (SW → window):
//   { type: 'SW_ACK',         payload: <ack_data>      }
//   { type: 'SW_CACHE_READY', payload: { cacheKey }    }
//
// window.RuntimeSWBridge
//   .syncSnapshot(snapshot)   → Promise<boolean>
//   .syncBlackbox(events)     → Promise<boolean>
//   .notifyDeploy(info)       → void
//   .writeCrashMarker(type)   → void
//   .isAvailable()            → boolean
//   .getMetrics()             → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSWBridge) return;

  var VERSION = '1.0';
  var LOG     = '[SWBridge]';

  var _sw       = null;
  var _ready    = false;
  var _metrics  = { sent: 0, acks: 0, errors: 0, deployNotifs: 0, crashMarkers: 0 };

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Service Worker acquisition ────────────────────────────────────────────
  function _acquireSW() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (reg) {
      _sw = reg.active || reg.waiting || reg.installing;
      if (_sw) {
        _ready = true;
        console.debug(LOG, 'v' + VERSION + ' SW acquired | state:', _sw.state);
      }
      // Update _sw reference when SW activates
      reg.addEventListener('statechange', function () {
        _sw = reg.active || _sw;
        if (!_ready && _sw) { _ready = true; }
      });
    }).catch(function (e) {
      console.debug(LOG, 'SW not ready:', e.message);
    });

    // Listen for messages from SW
    navigator.serviceWorker.addEventListener('message', function (evt) {
      var msg = evt && evt.data;
      if (!msg) return;
      if (msg.type === 'SW_ACK')         { _metrics.acks++; }
      if (msg.type === 'SW_CACHE_READY') { console.debug(LOG, 'SW cache ready:', msg.payload); }
    });
  }

  // ── Post message to SW ────────────────────────────────────────────────────
  function _post(type, payload) {
    if (!_ready || !_sw) return false;
    try {
      _sw.postMessage({ type: type, payload: payload, ts: Date.now() });
      _metrics.sent++;
      return true;
    } catch (e) {
      _metrics.errors++;
      console.debug(LOG, 'postMessage failed:', e.message);
      return false;
    }
  }

  // ── Sync snapshot to SW ───────────────────────────────────────────────────
  function syncSnapshot(snapshot) {
    if (!snapshot) return Promise.resolve(false);
    var ok = _post('BB_SNAPSHOT', snapshot);
    // Also persist to BlackboxStorage
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) bbs.persist(snapshot);
    });
    return Promise.resolve(ok);
  }

  // ── Sync blackbox events to SW ────────────────────────────────────────────
  function syncBlackbox(events) {
    if (!Array.isArray(events) || !events.length) return Promise.resolve(false);
    var ok = _post('BB_EVENTS', events.slice(-200));  // cap at 200 to avoid SW message overflow
    return Promise.resolve(ok);
  }

  // ── Deploy notification ───────────────────────────────────────────────────
  function notifyDeploy(info) {
    _metrics.deployNotifs++;
    _post('DEPLOY_NOTIFY', info || {});
  }

  // ── Crash marker ──────────────────────────────────────────────────────────
  function writeCrashMarker(type) {
    _metrics.crashMarkers++;
    _post('CRASH_MARKER', { type: type || 'unknown', ts: Date.now() });
  }

  // ── Integrate with RuntimeDeploySync ─────────────────────────────────────
  function _bindDeploySync() {
    window.addEventListener('deploy:new-build', function (evt) {
      if (!evt || !evt.detail) return;
      notifyDeploy(evt.detail);
    });
    window.addEventListener('deploy:stale', function (evt) {
      if (!evt || !evt.detail) return;
      notifyDeploy(Object.assign({}, evt.detail, { stale: true }));
    });
  }

  // ── Periodic blackbox relay ────────────────────────────────────────────────
  function _startPeriodicSync() {
    if (!_ready) return;
    setInterval(function () {
      if (!_ready) return;
      _s(function () {
        var bb = G.RuntimeBlackbox;
        if (bb && typeof bb.query === 'function') {
          var events = bb.query({ limit: 50 });
          if (events && events.length) syncBlackbox(events);
        }
      });
    }, 60000);  // relay last 50 events every minute
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    _acquireSW();
    _bindDeploySync();
    setTimeout(_startPeriodicSync, 8000);
    console.debug(LOG, 'v' + VERSION + ' ready | SW available:', !!navigator.serviceWorker);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeSWBridge = Object.freeze({
    VERSION:        VERSION,
    syncSnapshot:   syncSnapshot,
    syncBlackbox:   syncBlackbox,
    notifyDeploy:   notifyDeploy,
    writeCrashMarker: writeCrashMarker,
    isAvailable:    function () { return _ready; },
    getMetrics:     function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-distributed-workload.js ──
// RuntimeDistributedWorkload v1.0 — Arc 11 / Phase E
// =============================================================================
// Cross-tab workload balancing and lease management.
//
// Responsibilities:
//   - Workload leasing: claim work units distributed by the mesh leader
//   - Ownership tracking: one tab owns each workload unit at a time
//   - Duplicate prevention: singleton guard via leaseId
//   - Thermal-aware distribution: hotter tabs reject new leases
//   - Idle tab detection: tabs with no active workloads can absorb more
//   - Overload detection: tabs at capacity signal back-pressure
//
// Integrates with:
//   RuntimeTabMesh  — receives WORKLOAD_OFFER, sends WORKLOAD_ACK / WORKLOAD_DONE
//
// window.RuntimeDistributedWorkload
//   .submitWorkload(type, data)   → leaseId (leader distributes; peers claim)
//   .getActiveLeases()            → Lease[]
//   .getCapacity()                → { active, max, thermal, canAccept }
//   .releaseAll()                 → void
//   .getMetrics()                 → MetricsObject
//   ._onWorkloadOffer(offer, tid) — internal hook called by RuntimeTabMesh
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDistributedWorkload) return;

  var VERSION = '1.0';
  var LOG     = '[DistributedWorkload]';

  var MAX_LEASES_DEFAULT   = 3;
  var THERMAL_HOT_SKIP     = true;   // hot/critical thermal → skip new work
  var LEASE_TIMEOUT_MS     = 30000;  // auto-expire claimed but un-completed leases
  var METRICS_WINDOW_MS    = 60000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _leases   = {};   // leaseId → { leaseId, type, ts, status, tabId, data }
  var _metrics  = { offered: 0, claimed: 0, completed: 0, rejected: 0, expired: 0, errors: 0 };
  var _maxLeases = MAX_LEASES_DEFAULT;

  // ── Capacity ───────────────────────────────────────────────────────────────
  function getCapacity() {
    var active  = Object.keys(_leases).filter(function (id) { return _leases[id].status === 'active'; }).length;
    var thermal = _s(function () {
      var tm = G.RuntimeTabMesh;
      return tm ? tm.getThermalState().level : 'nominal';
    }, 'nominal');
    var canAccept = active < _maxLeases && (!THERMAL_HOT_SKIP || (thermal !== 'hot' && thermal !== 'critical'));
    return { active: active, max: _maxLeases, thermal: thermal, canAccept: canAccept };
  }

  // ── Claim a workload offer from another tab ────────────────────────────────
  function _onWorkloadOffer(offer, fromTab) {
    if (!offer || !offer.leaseId) return;
    // Prevent duplicate claims
    if (_leases[offer.leaseId]) return;

    var cap = getCapacity();
    if (!cap.canAccept) {
      _metrics.rejected++;
      return;
    }

    // Claim the lease
    var leaseId = offer.leaseId;
    _leases[leaseId] = {
      leaseId:  leaseId,
      type:     offer.type || 'generic',
      ts:       Date.now(),
      status:   'active',
      tabId:    _tabId(),
      fromTab:  fromTab,
      data:     offer.data || null,
    };
    _metrics.claimed++;

    // Acknowledge back through TabMesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.broadcast === 'function') {
        tm.broadcast('WORKLOAD_ACK', { leaseId: leaseId });
      }
    });

    // Auto-expire after LEASE_TIMEOUT_MS
    setTimeout(function () {
      if (_leases[leaseId] && _leases[leaseId].status === 'active') {
        _leases[leaseId].status = 'expired';
        _metrics.expired++;
        console.debug(LOG, 'lease expired:', leaseId);
      }
    }, LEASE_TIMEOUT_MS);

    console.debug(LOG, 'lease claimed:', leaseId, 'type:', offer.type);
  }

  // ── Submit workload (leader distributes, or self-executes if solo) ─────────
  function submitWorkload(type, data) {
    var tm = _s(function () { return G.RuntimeTabMesh; }, null);
    if (tm && typeof tm.broadcastWorkload === 'function' && tm.isLeader()) {
      var leaseId = tm.broadcastWorkload({ type: type, data: data });
      _metrics.offered++;
      return leaseId;
    }
    // Single-tab or non-leader: self-execute
    var selfId = 'local_' + Date.now().toString(36);
    _leases[selfId] = { leaseId: selfId, type: type, ts: Date.now(), status: 'active', tabId: _tabId(), data: data };
    _metrics.claimed++;
    return selfId;
  }

  // ── Complete a lease ───────────────────────────────────────────────────────
  function completeLease(leaseId) {
    if (!_leases[leaseId]) return false;
    _leases[leaseId].status = 'done';
    _leases[leaseId].doneTs = Date.now();
    _metrics.completed++;
    // Notify mesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.broadcast === 'function') tm.broadcast('WORKLOAD_DONE', { leaseId: leaseId });
    });
    return true;
  }

  function releaseAll() {
    Object.keys(_leases).forEach(function (id) { _leases[id].status = 'released'; });
  }

  function getActiveLeases() {
    return Object.keys(_leases)
      .filter(function (id) { return _leases[id].status === 'active'; })
      .map(function (id) { return Object.assign({}, _leases[id]); });
  }

  function _tabId() {
    return _s(function () { var tm = G.RuntimeTabMesh; return tm ? tm.status().tabId : 'local'; }, 'local');
  }

  // ── Periodic expired lease cleanup ─────────────────────────────────────────
  setInterval(function () {
    var cutoff = Date.now() - METRICS_WINDOW_MS * 2;
    Object.keys(_leases).forEach(function (id) {
      var w = _leases[id];
      if ((w.status === 'done' || w.status === 'expired' || w.status === 'released') && w.ts < cutoff) {
        delete _leases[id];
      }
    });
  }, METRICS_WINDOW_MS);

  // ── Boot ───────────────────────────────────────────────────────────────────
  console.debug(LOG, 'v' + VERSION + ' ready | maxLeases:', _maxLeases);

  G.RuntimeDistributedWorkload = Object.freeze({
    VERSION:          VERSION,
    submitWorkload:   submitWorkload,
    completeLease:    completeLease,
    releaseAll:       releaseAll,
    getActiveLeases:  getActiveLeases,
    getCapacity:      getCapacity,
    getMetrics:       function () { return Object.assign({}, _metrics); },
    _onWorkloadOffer: _onWorkloadOffer,
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-incident-correlation.js ──
// RuntimeIncidentCorrelation v1.0 — Arc 11 / Phase F
// =============================================================================
// Cross-tab, cross-session, cross-reload incident correlation.
//
// Capabilities:
//   - Recurring pattern detection: same incident type repeating across sessions
//   - Root cause grouping: cluster incidents sharing a common root
//   - Incident clustering: spatially (co-occurring in time) + semantically
//   - Cross-tab correlation: incidents from multiple tabs analysed together
//   - Persistence: correlated patterns stored in RuntimeBlackboxStorage
//
// Pattern types detected:
//   RECURRING   — same category appears ≥ RECUR_THRESHOLD times in RECUR_WINDOW_MS
//   CLUSTER     — ≥ CLUSTER_SIZE incidents within CLUSTER_WINDOW_MS
//   CASCADE     — incident A reliably precedes incident B within CASCADE_WINDOW_MS
//   TAB_WIDE    — incident appears in ≥ 2 tabs simultaneously
//
// window.RuntimeIncidentCorrelation
//   .ingest(incident)           → void  (accepts incidents from any source)
//   .getPatterns()              → Pattern[]
//   .getClusters()              → Cluster[]
//   .getCascades()              → Cascade[]
//   .getTopRootCauses(n)        → RootCause[]
//   .flush()                    → void  (clear all state)
//   .getMetrics()               → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeIncidentCorrelation) return;

  var VERSION = '1.0';
  var LOG     = '[IncidentCorrelation]';

  var RECUR_THRESHOLD    = 3;
  var RECUR_WINDOW_MS    = 5 * 60 * 1000;   // 5 min
  var CLUSTER_SIZE       = 4;
  var CLUSTER_WINDOW_MS  = 30 * 1000;        // 30 s
  var CASCADE_WINDOW_MS  = 10 * 1000;        // 10 s
  var MAX_INCIDENTS      = 2000;
  var MAX_PATTERNS       = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _incidents = [];   // { id, type, category, severity, ts, tabId, score }
  var _patterns  = [];   // { type, category, count, firstTs, lastTs, details }
  var _clusters  = [];   // { id, incidents[], startTs, endTs, size }
  var _cascades  = [];   // { trigger, effect, count, avgDelayMs }
  var _rootCauses = {};  // category → { count, severity, firstTs, lastTs }
  var _metrics   = { ingested: 0, patterns: 0, clusters: 0, cascades: 0, persisted: 0 };

  // ── Ingest an incident ────────────────────────────────────────────────────
  function ingest(incident) {
    if (!incident) return;
    var now = Date.now();
    var rec = {
      id:       incident.id || ('ic_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5)),
      type:     incident.type     || incident.category || 'unknown',
      category: incident.category || incident.type     || 'unknown',
      severity: incident.severity || 'MEDIUM',
      score:    incident.score    || 0,
      ts:       incident.ts       || now,
      tabId:    incident.tabId    || 'local',
    };
    _incidents.push(rec);
    if (_incidents.length > MAX_INCIDENTS) _incidents.shift();
    _metrics.ingested++;
    _rootCauses[rec.category] = _rootCauses[rec.category] || { count: 0, severity: rec.severity, firstTs: rec.ts, lastTs: 0 };
    _rootCauses[rec.category].count++;
    _rootCauses[rec.category].lastTs = rec.ts;

    _analyseRecurring(rec);
    _analyseCluster(rec, now);
    _analyseCascade(rec, now);
    _persistIfCritical(rec);
  }

  // ── Recurring pattern detection ────────────────────────────────────────────
  function _analyseRecurring(rec) {
    var since = rec.ts - RECUR_WINDOW_MS;
    var same  = _incidents.filter(function (i) { return i.category === rec.category && i.ts >= since; });
    if (same.length >= RECUR_THRESHOLD) {
      var existing = _findPattern('RECURRING', rec.category);
      if (!existing) {
        var pat = { type: 'RECURRING', category: rec.category, count: same.length,
                    firstTs: same[0].ts, lastTs: rec.ts, details: { windowMs: RECUR_WINDOW_MS } };
        _addPattern(pat);
        console.debug(LOG, 'recurring pattern:', rec.category, 'x', same.length);
      } else {
        existing.count = same.length;
        existing.lastTs = rec.ts;
      }
    }
  }

  // ── Cluster detection ──────────────────────────────────────────────────────
  function _analyseCluster(rec, now) {
    var since   = now - CLUSTER_WINDOW_MS;
    var cluster = _incidents.filter(function (i) { return i.ts >= since; });
    if (cluster.length >= CLUSTER_SIZE) {
      var lastCluster = _clusters[_clusters.length - 1];
      if (!lastCluster || now - lastCluster.endTs > CLUSTER_WINDOW_MS) {
        var cl = { id: 'cl_' + now.toString(36), incidents: cluster.map(function (i) { return i.id; }),
                   startTs: cluster[0].ts, endTs: now, size: cluster.length };
        _clusters.push(cl);
        if (_clusters.length > 100) _clusters.shift();
        _metrics.clusters++;
        console.debug(LOG, 'incident cluster detected:', cl.size, 'incidents in', CLUSTER_WINDOW_MS, 'ms');
      } else {
        lastCluster.endTs  = now;
        lastCluster.size   = cluster.length;
      }
    }
  }

  // ── Cascade detection ──────────────────────────────────────────────────────
  function _analyseCascade(rec, now) {
    var since  = now - CASCADE_WINDOW_MS;
    var before = _incidents.filter(function (i) { return i.ts >= since && i.ts < rec.ts && i.category !== rec.category; });
    before.forEach(function (prior) {
      var key = prior.category + '→' + rec.category;
      var existing = _cascades.find(function (c) { return c.trigger === prior.category && c.effect === rec.category; });
      if (!existing) {
        _cascades.push({ trigger: prior.category, effect: rec.category, count: 1,
                         avgDelayMs: rec.ts - prior.ts, key: key });
        if (_cascades.length > 100) _cascades.shift();
        _metrics.cascades++;
      } else {
        existing.count++;
        existing.avgDelayMs = Math.round((existing.avgDelayMs * (existing.count - 1) + (rec.ts - prior.ts)) / existing.count);
      }
    });
  }

  // ── Persist critical patterns ──────────────────────────────────────────────
  function _persistIfCritical(rec) {
    if (rec.severity === 'CRITICAL' || rec.severity === 'P0') {
      _s(function () {
        var bbs = G.RuntimeBlackboxStorage;
        if (bbs && bbs.isAvailable()) {
          bbs.store('incidents', rec);
          _metrics.persisted++;
        }
      });
    }
  }

  // ── Pattern helpers ────────────────────────────────────────────────────────
  function _findPattern(type, category) {
    return _patterns.find(function (p) { return p.type === type && p.category === category; }) || null;
  }

  function _addPattern(pat) {
    if (_patterns.length >= MAX_PATTERNS) _patterns.shift();
    _patterns.push(pat);
    _metrics.patterns++;
  }

  // ── Subscribe to live incident sources ─────────────────────────────────────
  function _bindSources() {
    // Arc 8 incidents
    window.addEventListener('arc8:incident', function (evt) {
      if (evt && evt.detail) ingest(evt.detail);
    });
    // Cross-tab incidents from TabMesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.getIncidentHistory === 'function') {
        var hist = tm.getIncidentHistory();
        hist.forEach(function (i) { ingest(i); });
      }
    });
    // Arc8 control plane commands
    window.addEventListener('arc8:command', function (evt) {
      if (evt && evt.detail && evt.detail.type === 'incident') ingest(evt.detail);
    });
  }

  function flush() {
    _incidents = []; _patterns = []; _clusters = []; _cascades = []; _rootCauses = {};
    _metrics = { ingested: 0, patterns: 0, clusters: 0, cascades: 0, persisted: 0 };
  }

  function getTopRootCauses(n) {
    return Object.keys(_rootCauses)
      .map(function (k) { return Object.assign({ category: k }, _rootCauses[k]); })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, n || 10);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_bindSources, 6000); }, { once: true });
  } else {
    setTimeout(_bindSources, 6000);
  }

  G.RuntimeIncidentCorrelation = Object.freeze({
    VERSION:         VERSION,
    ingest:          ingest,
    getPatterns:     function () { return _patterns.slice(); },
    getClusters:     function () { return _clusters.slice(); },
    getCascades:     function () { return _cascades.slice(); },
    getTopRootCauses: getTopRootCauses,
    flush:           flush,
    getMetrics:      function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-recovery-memory.js ──
// RuntimeRecoveryMemory v1.0 — Arc 11 / Phase G
// =============================================================================
// Adaptive recovery strategy memory. Learns from past recovery outcomes to
// recommend the most effective strategy for each failure class.
//
// Storage:
//   - Recovery records: { strategy, category, outcome, durationMs, ts }
//   - Strategy success rates per failure category
//   - Failed strategy blocklist (avoid repeating known-bad approaches)
//   - Incident patterns with associated effective strategies
//   - Healing effectiveness scores (0–100) per strategy
//
// Capabilities:
//   - recommend(category)     → best strategy for this failure class
//   - recordOutcome(...)      → store a recovery attempt result
//   - avoid(strategy, reason) → add to failure blocklist
//   - getEffectiveness(strat) → 0–100 score
//   - getHistory(n)           → recent recovery attempts
//
// Persists to RuntimeBlackboxStorage (recovery_history store) across reloads.
//
// window.RuntimeRecoveryMemory
//   .recommend(category)         → { strategy, confidence, reason }
//   .recordOutcome(opts)         → void
//   .getEffectiveness(strategy)  → number 0-100
//   .getHistory(n)               → RecoveryRecord[]
//   .getBlocklist()              → BlockEntry[]
//   .reset()                     → void
//   .getMetrics()                → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryMemory) return;

  var VERSION = '1.0';
  var LOG     = '[RecoveryMemory]';

  var MAX_HISTORY      = 500;
  var BLOCKLIST_TTL_MS = 10 * 60 * 1000;  // 10 min — re-try blocked strategies after this
  var MIN_SAMPLES      = 3;               // minimum samples to trust a rate

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _history   = [];    // RecoveryRecord[]
  var _rates     = {};    // strategy → { success, total, categories: { cat → {s,t} } }
  var _blocklist = [];    // { strategy, reason, ts }
  var _patterns  = {};    // category → { bestStrategy, confidence, lastTs }
  var _metrics   = { recorded: 0, recommended: 0, blocked: 0, loaded: 0 };

  // ── Record an outcome ─────────────────────────────────────────────────────
  function recordOutcome(opts) {
    opts = opts || {};
    var rec = {
      strategy:   opts.strategy   || 'unknown',
      category:   opts.category   || 'general',
      outcome:    opts.outcome     || 'unknown',   // 'success' | 'failed' | 'partial'
      durationMs: opts.durationMs  || 0,
      ts:         Date.now(),
      attempts:   opts.attempts    || 1,
    };
    _history.push(rec);
    if (_history.length > MAX_HISTORY) _history.shift();
    _metrics.recorded++;

    // Update rates
    var strat = rec.strategy;
    _rates[strat] = _rates[strat] || { success: 0, total: 0, categories: {} };
    _rates[strat].total++;
    if (rec.outcome === 'success') _rates[strat].success++;

    var cat = rec.category;
    _rates[strat].categories[cat] = _rates[strat].categories[cat] || { s: 0, t: 0 };
    _rates[strat].categories[cat].t++;
    if (rec.outcome === 'success') _rates[strat].categories[cat].s++;

    // Update category pattern
    _updatePattern(cat);

    // Persist to storage
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) bbs.store('recovery_history', rec);
    });
  }

  // ── Update best strategy for a category ───────────────────────────────────
  function _updatePattern(category) {
    var best = null;
    var bestRate = -1;
    Object.keys(_rates).forEach(function (strat) {
      var catStats = _rates[strat].categories[category];
      if (!catStats || catStats.t < MIN_SAMPLES) return;
      if (_isBlocked(strat)) return;
      var rate = catStats.s / catStats.t;
      if (rate > bestRate) { bestRate = rate; best = strat; }
    });
    if (best) {
      _patterns[category] = {
        bestStrategy: best,
        confidence:   Math.round(bestRate * 100),
        lastTs:       Date.now(),
      };
    }
  }

  // ── Blocklist management ──────────────────────────────────────────────────
  function avoid(strategy, reason) {
    _blocklist = _blocklist.filter(function (b) { return b.strategy !== strategy; });
    _blocklist.push({ strategy: strategy, reason: reason || 'manual', ts: Date.now() });
    _metrics.blocked++;
    console.debug(LOG, 'strategy blocked:', strategy, '|', reason);
  }

  function _isBlocked(strategy) {
    var cutoff = Date.now() - BLOCKLIST_TTL_MS;
    return _blocklist.some(function (b) { return b.strategy === strategy && b.ts > cutoff; });
  }

  // ── Recommend ─────────────────────────────────────────────────────────────
  function recommend(category) {
    _metrics.recommended++;
    // Check learned pattern first
    var pattern = _patterns[category];
    if (pattern && !_isBlocked(pattern.bestStrategy)) {
      return { strategy: pattern.bestStrategy, confidence: pattern.confidence, reason: 'learned' };
    }
    // Fall back to global best non-blocked strategy
    var best = null; var bestRate = -1;
    Object.keys(_rates).forEach(function (strat) {
      if (_isBlocked(strat)) return;
      var r = _rates[strat];
      if (r.total < MIN_SAMPLES) return;
      var rate = r.success / r.total;
      if (rate > bestRate) { bestRate = rate; best = strat; }
    });
    if (best) return { strategy: best, confidence: Math.round(bestRate * 100), reason: 'global-best' };
    // No data
    return { strategy: null, confidence: 0, reason: 'insufficient-data' };
  }

  // ── Effectiveness score ────────────────────────────────────────────────────
  function getEffectiveness(strategy) {
    var r = _rates[strategy];
    if (!r || r.total < 1) return 50;  // neutral default
    return Math.round((r.success / r.total) * 100);
  }

  // ── Load history from persistence ─────────────────────────────────────────
  function _loadFromStorage() {
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (!bbs || !bbs.isAvailable()) return;
      bbs.load('recovery_history', { limit: 200 }).then(function (rows) {
        if (!Array.isArray(rows)) return;
        rows.forEach(function (row) {
          if (row && row.strategy && row.category && row.outcome) {
            _history.push(row);
            _metrics.loaded++;
          }
        });
        // Rebuild rates from loaded history
        _history.forEach(function (rec) {
          var strat = rec.strategy;
          _rates[strat] = _rates[strat] || { success: 0, total: 0, categories: {} };
          _rates[strat].total++;
          if (rec.outcome === 'success') _rates[strat].success++;
          var cat = rec.category;
          _rates[strat].categories[cat] = _rates[strat].categories[cat] || { s: 0, t: 0 };
          _rates[strat].categories[cat].t++;
          if (rec.outcome === 'success') _rates[strat].categories[cat].s++;
        });
        Object.keys(_rates).forEach(function (strat) {
          Object.keys(_rates[strat].categories).forEach(function (cat) { _updatePattern(cat); });
        });
        console.debug(LOG, 'loaded', _metrics.loaded, 'recovery records from storage');
      }).catch(function () {});
    });
  }

  function reset() {
    _history = []; _rates = {}; _blocklist = []; _patterns = {};
    _metrics = { recorded: 0, recommended: 0, blocked: 0, loaded: 0 };
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  setTimeout(_loadFromStorage, 4000);

  G.RuntimeRecoveryMemory = Object.freeze({
    VERSION:          VERSION,
    recommend:        recommend,
    recordOutcome:    recordOutcome,
    avoid:            avoid,
    getEffectiveness: getEffectiveness,
    getHistory:       function (n) { return _history.slice(-(n || 50)); },
    getBlocklist:     function () { return _blocklist.slice(); },
    getPatterns:      function () { return Object.assign({}, _patterns); },
    reset:            reset,
    getMetrics:       function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-deploy-resilience.js ──
// RuntimeDeployResilience v1.0 — Arc 11 / Phase H
// =============================================================================
// Safe deploy transition management.
//
// Features:
//   - Build migration tracking: monitor active → stale → refreshed state
//   - Pre-deploy snapshots: capture state before a new deploy is applied
//   - Rollback markers: record rollback points in RuntimeBlackboxStorage
//   - Stale tab detection: identify tabs still running old code
//   - Deploy health scoring: assess runtime integrity post-deploy
//
// Integrates with:
//   RuntimeDeploySync — listens to deploy:stale, deploy:new-build events
//   RuntimeStateSnapshots — captures pre-deploy state snapshot
//   RuntimeBlackboxStorage — persists rollback markers and deploy records
//
// Deploy lifecycle states:
//   FRESH    — tab is running the current build
//   STALE    — server has a newer build; this tab is behind
//   UPDATING — user has acknowledged stale; reload in progress
//   ROLLBACK — deploy caused errors; rolling back to known-good state
//
// window.RuntimeDeployResilience
//   .getState()                → { buildState, currentBuild, serverBuild, ts }
//   .capturePreDeploySnapshot() → Promise<snapshotId|null>
//   .markRollback(reason)      → void
//   .getDeployHistory()        → DeployRecord[]
//   .getStaleTabs()            → string[]  (from TabMesh)
//   .getHealthScore()          → number 0-100
//   .getMetrics()              → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeployResilience) return;

  var VERSION = '1.0';
  var LOG     = '[DeployResilience]';

  var HEALTH_WINDOW_MS = 5 * 60 * 1000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _buildState   = 'FRESH';   // FRESH | STALE | UPDATING | ROLLBACK
  var _currentBuild = '';
  var _serverBuild  = '';
  var _stateTs      = Date.now();
  var _history      = [];        // DeployRecord[]
  var _rollbacks    = [];        // { reason, ts, buildId }
  var _metrics      = { deployDetected: 0, snapshots: 0, rollbacks: 0, staleTabs: 0, errors: 0 };
  var _healthEvents = [];        // { ts, ok }

  // ── Build state management ─────────────────────────────────────────────────
  function _setState(newState, extra) {
    if (_buildState !== newState) {
      console.debug(LOG, 'deploy state:', _buildState, '→', newState, extra ? JSON.stringify(extra) : '');
      _buildState = newState;
      _stateTs    = Date.now();
      _s(function () {
        G.dispatchEvent(new CustomEvent('deploy-resilience:state-change', {
          detail: { state: newState, currentBuild: _currentBuild, serverBuild: _serverBuild, ts: _stateTs },
        }));
      });
    }
  }

  // ── Pre-deploy snapshot ────────────────────────────────────────────────────
  function capturePreDeploySnapshot() {
    _metrics.snapshots++;
    return Promise.resolve()
      .then(function () {
        // Take a state snapshot via RuntimeStateSnapshots
        var ss = _s(function () { return G.RuntimeStateSnapshots; }, null);
        if (ss && typeof ss.take === 'function') {
          return ss.take('pre-deploy:' + _serverBuild);
        }
        return null;
      })
      .then(function (snap) {
        if (snap) {
          _s(function () {
            var bbs = G.RuntimeBlackboxStorage;
            if (bbs && bbs.isAvailable()) {
              bbs.store('snapshots', { type: 'pre-deploy', build: _serverBuild, snap: snap, ts: Date.now() });
            }
          });
          console.debug(LOG, 'pre-deploy snapshot captured for build:', _serverBuild);
          return snap.id || 'snap-' + Date.now().toString(36);
        }
        return null;
      })
      .catch(function (e) {
        _metrics.errors++;
        console.warn(LOG, 'pre-deploy snapshot failed:', e.message);
        return null;
      });
  }

  // ── Rollback marker ────────────────────────────────────────────────────────
  function markRollback(reason) {
    _metrics.rollbacks++;
    var rb = { reason: reason || 'manual', ts: Date.now(), buildId: _currentBuild };
    _rollbacks.push(rb);
    _setState('ROLLBACK', rb);
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) {
        bbs.store('recovery_history', { type: 'deploy-rollback', buildId: _currentBuild,
                                        reason: reason, ts: Date.now() });
      }
    });
    console.warn(LOG, 'rollback marker set | reason:', reason, '| build:', _currentBuild);
  }

  // ── Stale tab detection ────────────────────────────────────────────────────
  function getStaleTabs() {
    return _s(function () {
      var tm = G.RuntimeTabMesh;
      if (!tm) return [];
      var tabs = tm.getTabs();
      return tabs
        .filter(function (t) { return !t.self; })
        .map(function (t) { return t.id; });
    }, []);
  }

  // ── Health scoring ─────────────────────────────────────────────────────────
  function _recordHealthEvent(ok) {
    _healthEvents.push({ ts: Date.now(), ok: ok });
    var cutoff = Date.now() - HEALTH_WINDOW_MS;
    _healthEvents = _healthEvents.filter(function (e) { return e.ts >= cutoff; });
  }

  function getHealthScore() {
    if (!_healthEvents.length) return 100;
    var ok = _healthEvents.filter(function (e) { return e.ok; }).length;
    return Math.round((ok / _healthEvents.length) * 100);
  }

  // ── Build deploy record ────────────────────────────────────────────────────
  function _recordDeploy(prevBuild, newBuild) {
    var rec = { prevBuild: prevBuild, newBuild: newBuild, ts: Date.now(),
                state: _buildState, tabStale: getStaleTabs().length };
    _history.push(rec);
    if (_history.length > 50) _history.shift();
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) {
        bbs.store('blackbox_events', { type: 'deploy', detail: rec });
      }
    });
  }

  // ── Bind to RuntimeDeploySync ──────────────────────────────────────────────
  function _bindDeploySync() {
    _s(function () {
      var ds = G.RuntimeDeploySync;
      if (ds) {
        _currentBuild = ds.getBuildId()     || '';
        _serverBuild  = ds.getServerBuild() || _currentBuild;
        if (ds.isStale()) _setState('STALE');
      }
    });

    window.addEventListener('deploy:new-build', function (evt) {
      if (!evt || !evt.detail) return;
      _metrics.deployDetected++;
      var prev = evt.detail.prevBuildId || _currentBuild;
      _serverBuild  = evt.detail.newBuildId || '';
      _setState('STALE', { prevBuild: prev, newBuild: _serverBuild });

      // Capture pre-deploy snapshot before we go stale
      capturePreDeploySnapshot();
      _recordDeploy(prev, _serverBuild);
      _recordHealthEvent(true);
    });

    window.addEventListener('deploy:stale', function () {
      _setState('STALE');
      _recordHealthEvent(false);
      var staleTabs = getStaleTabs();
      _metrics.staleTabs += staleTabs.length;
    });

    window.addEventListener('deploy:sync-ready', function (evt) {
      if (evt && evt.detail) {
        _currentBuild = evt.detail.buildId || _currentBuild;
        if (_buildState === 'FRESH') _recordHealthEvent(true);
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_bindDeploySync, 2000); }, { once: true });
  } else {
    setTimeout(_bindDeploySync, 2000);
  }

  G.RuntimeDeployResilience = Object.freeze({
    VERSION:                  VERSION,
    getState:                 function () {
      return { buildState: _buildState, currentBuild: _currentBuild,
               serverBuild: _serverBuild, ts: _stateTs };
    },
    capturePreDeploySnapshot: capturePreDeploySnapshot,
    markRollback:             markRollback,
    getDeployHistory:         function () { return _history.slice(); },
    getRollbacks:             function () { return _rollbacks.slice(); },
    getStaleTabs:             getStaleTabs,
    getHealthScore:           getHealthScore,
    getMetrics:               function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/debug-panels/panel-tab-mesh.js ──
(function (G) {
  'use strict';
  if (G.PanelTabMesh) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelTabMesh]';

  function PanelTabMesh(container) {
    this._c     = container;
    this._built = false;
  }

  PanelTabMesh.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🕸 Tab Mesh v2.0' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-lock',    text: 'Lock All Tabs' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-reclaim', text: 'Reclaim Orphans' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tm-refresh', text: 'Refresh' }),
    ]);

    var statusStrip  = Ren.el('div', { cls: 'panel-metrics', id: 'tm-status' });
    var tabsTitle    = Ren.el('div', { cls: 'panel-subtitle', text: 'Connected Tabs' });
    var tabsList     = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-tabs', style: 'max-height:120px;overflow-y:auto;' });
    var wlTitle      = Ren.el('div', { cls: 'panel-subtitle', text: 'Workload Map' });
    var wlList       = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-wl', style: 'max-height:120px;overflow-y:auto;' });
    var thermalTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Thermal + Memory Pressure' });
    var thermalEl    = Ren.el('div', { cls: 'panel-metrics', id: 'tm-thermal' });
    var incTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Cross-Tab Incidents (last 20)' });
    var incList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'tm-incidents', style: 'max-height:140px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statusStrip);
    this._c.appendChild(tabsTitle);
    this._c.appendChild(tabsList);
    this._c.appendChild(wlTitle);
    this._c.appendChild(wlList);
    this._c.appendChild(thermalTitle);
    this._c.appendChild(thermalEl);
    this._c.appendChild(incTitle);
    this._c.appendChild(incList);

    toolbar.querySelector('#tm-lock').addEventListener('click', function () {
      var TM = G.RuntimeTabMesh;
      if (!TM) { alert('RuntimeTabMesh not available'); return; }
      if (confirm('Lock all connected tabs?')) TM.lockAllTabs('debug-panel');
    });

    toolbar.querySelector('#tm-reclaim').addEventListener('click', function () {
      var TM = G.RuntimeTabMesh;
      if (!TM) return;
      var n = TM.reclaimOrphanedWorkloads();
      alert('Reclaimed ' + n + ' orphaned workload(s).');
      self.refresh();
    });

    toolbar.querySelector('#tm-refresh').addEventListener('click', function () { self.refresh(); });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(incList);
  };

  PanelTabMesh.prototype.refresh = function () {
    if (!this._built) return;
    var TM  = G.RuntimeTabMesh;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status strip
    var statusEl = this._c.querySelector('#tm-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (TM) {
        var s = TM.status();
        [
          ['Version',   s.version],
          ['Leader',    s.isLeader ? 'YES' : 'no'],
          ['Tabs',      s.tabs],
          ['Locked',    s.locked ? 'YES' : 'no'],
          ['Workloads', s.workloads],
          ['Incidents', s.incidents],
          ['Thermal',   s.thermalLevel],
        ].forEach(function (p) {
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] }));
        });
      } else {
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeTabMesh not loaded' }));
      }
    }

    // Tabs list
    var tabsEl = this._c.querySelector('#tm-tabs');
    if (tabsEl && TM) {
      tabsEl.innerHTML = '';
      TM.getTabs().forEach(function (tab) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: tab.self ? '★ ' : '○ ' }),
          Ren.el('span', { text: tab.id }),
          tab.isLeader ? Ren.el('span', { cls: 'metric-chip', text: 'LEADER' }) : null,
          Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(tab.ts) }),
        ].filter(Boolean));
        tabsEl.appendChild(row);
      });
      if (!TM.getTabs().length) tabsEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No other tabs detected.' }));
    }

    // Workload map
    var wlEl = this._c.querySelector('#tm-wl');
    if (wlEl && TM) {
      wlEl.innerHTML = '';
      var wl = TM.getWorkloadMap();
      wl.slice(-15).forEach(function (w) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: w.type }),
          Ren.el('span', { cls: 'metric-chip', text: w.status }),
          Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(w.ts) }),
        ]);
        wlEl.appendChild(row);
      });
      if (!wl.length) wlEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No active workloads.' }));
    }

    // Thermal + memory
    var thermalEl = this._c.querySelector('#tm-thermal');
    if (thermalEl && TM) {
      thermalEl.innerHTML = '';
      var thermal = TM.getThermalState();
      var memMap  = TM.getMemoryPressureMap();
      var memEntries = Object.keys(memMap);
      thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Thermal: ' + thermal.level }));
      thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Memory tabs: ' + memEntries.length }));
      memEntries.slice(0, 5).forEach(function (id) {
        thermalEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: id.slice(0, 10) + ': ' + memMap[id] }));
      });
    }

    // Incident history
    var incEl = this._c.querySelector('#tm-incidents');
    if (incEl && TM) {
      incEl.innerHTML = '';
      var incidents = TM.getIncidentHistory().slice(-20).reverse();
      incidents.forEach(function (inc) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(inc.ts) }),
          Ren.el('span', { cls: 'tl-type', text: inc.type || '—' }),
          Ren.el('span', { cls: 'metric-chip', text: inc.severity || '?' }),
          Ren.el('span', { text: 'from: ' + (inc.fromTab || '?').slice(0, 12) }),
        ]);
        incEl.appendChild(row);
      });
      if (!incidents.length) incEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No cross-tab incidents.' }));
    }
  };

  G.PanelTabMesh = PanelTabMesh;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));

// ── SOURCE: public/js/debug-panels/panel-persistent-storage.js ──
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

// ── SOURCE: public/js/debug-panels/panel-recovery-memory.js ──
(function (G) {
  'use strict';
  if (G.PanelRecoveryMemory) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelRecoveryMemory]';

  function PanelRecoveryMemory(container) {
    this._c     = container;
    this._built = false;
  }

  PanelRecoveryMemory.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🧠 Recovery Memory' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rm-recommend', text: 'Get Recommendation' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'rm-reset', text: 'Reset Memory' }),
    ]);

    var metricsEl   = Ren.el('div', { cls: 'panel-metrics', id: 'rm-metrics' });
    var rcTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Strategy Effectiveness' });
    var rcList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-effectiveness', style: 'max-height:120px;overflow-y:auto;' });
    var blTitle     = Ren.el('div', { cls: 'panel-subtitle', text: 'Blocked Strategies' });
    var blList      = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-blocklist', style: 'max-height:80px;overflow-y:auto;' });
    var patTitle    = Ren.el('div', { cls: 'panel-subtitle', text: 'Learned Patterns' });
    var patList     = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-patterns', style: 'max-height:100px;overflow-y:auto;' });
    var histTitle   = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Recovery History' });
    var histList    = Ren.el('div', { cls: 'panel-list-wrap', id: 'rm-history', style: 'max-height:140px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metricsEl);
    this._c.appendChild(rcTitle);
    this._c.appendChild(rcList);
    this._c.appendChild(blTitle);
    this._c.appendChild(blList);
    this._c.appendChild(patTitle);
    this._c.appendChild(patList);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);

    toolbar.querySelector('#rm-recommend').addEventListener('click', function () {
      var RM = G.RuntimeRecoveryMemory;
      if (!RM) { alert('RuntimeRecoveryMemory not available'); return; }
      var category = prompt('Enter failure category (e.g. worker-crash):') || 'general';
      var rec = RM.recommend(category);
      alert('Category: ' + category + '\nStrategy: ' + (rec.strategy || 'none') +
            '\nConfidence: ' + rec.confidence + '%\nReason: ' + rec.reason);
    });

    toolbar.querySelector('#rm-reset').addEventListener('click', function () {
      var RM = G.RuntimeRecoveryMemory;
      if (!RM) return;
      if (confirm('Reset all recovery memory? This will erase learned strategy data.')) {
        RM.reset();
        self.refresh();
        alert('Recovery memory cleared.');
      }
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(histList);
  };

  PanelRecoveryMemory.prototype.refresh = function () {
    if (!this._built) return;
    var RM  = G.RuntimeRecoveryMemory;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#rm-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      if (RM) {
        var m = RM.getMetrics();
        [
          ['Recorded',    m.recorded],
          ['Recommended', m.recommended],
          ['Blocked',     m.blocked],
          ['Loaded',      m.loaded],
        ].forEach(function (p) {
          metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] }));
        });
      } else {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeRecoveryMemory not loaded' }));
      }
    }

    // Effectiveness
    var rcEl = this._c.querySelector('#rm-effectiveness');
    if (rcEl && RM) {
      rcEl.innerHTML = '';
      var patterns = RM.getPatterns();
      var cats = Object.keys(patterns);
      if (!cats.length) {
        rcEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No strategy data yet.' }));
      } else {
        cats.forEach(function (cat) {
          var p   = patterns[cat];
          var eff = RM.getEffectiveness(p.bestStrategy);
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: cat }),
            Ren.el('span', { text: '→ ' + p.bestStrategy }),
            Ren.el('span', { cls: 'metric-chip', text: eff + '% effective' }),
          ]);
          rcEl.appendChild(row);
        });
      }
    }

    // Blocklist
    var blEl = this._c.querySelector('#rm-blocklist');
    if (blEl && RM) {
      blEl.innerHTML = '';
      var bl = RM.getBlocklist();
      if (!bl.length) {
        blEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No blocked strategies.' }));
      } else {
        bl.forEach(function (b) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: b.strategy }),
            Ren.el('span', { text: b.reason }),
            Ren.el('span', { cls: 'tl-ts', text: Ren.fmtTs(b.ts) }),
          ]);
          blEl.appendChild(row);
        });
      }
    }

    // Patterns
    var patEl = this._c.querySelector('#rm-patterns');
    if (patEl && RM) {
      patEl.innerHTML = '';
      var patData = RM.getPatterns();
      Object.keys(patData).forEach(function (cat) {
        var p   = patData[cat];
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: cat }),
          Ren.el('span', { text: p.bestStrategy }),
          Ren.el('span', { cls: 'metric-chip', text: p.confidence + '% confidence' }),
        ]);
        patEl.appendChild(row);
      });
      if (!Object.keys(patData).length) {
        patEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No patterns learned yet.' }));
      }
    }

    // History
    var histEl = this._c.querySelector('#rm-history');
    if (histEl && RM) {
      histEl.innerHTML = '';
      var hist = RM.getHistory(20);
      hist.slice().reverse().forEach(function (rec) {
        var ok  = rec.outcome === 'success';
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rec.ts) }),
          Ren.el('span', { cls: 'tl-type', text: rec.strategy }),
          Ren.el('span', { text: rec.category }),
          Ren.el('span', { cls: 'metric-chip', style: ok ? 'color:#4af' : 'color:#f44',
                           text: rec.outcome }),
        ]);
        histEl.appendChild(row);
      });
      if (!hist.length) histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No recovery history.' }));
    }
  };

  G.PanelRecoveryMemory = PanelRecoveryMemory;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));

// ── SOURCE: public/js/debug-panels/panel-deploy-resilience.js ──
(function (G) {
  'use strict';
  if (G.PanelDeployResilience) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelDeployResilience]';

  function PanelDeployResilience(container) {
    this._c     = container;
    this._built = false;
  }

  PanelDeployResilience.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🚀 Deploy Resilience' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'dr-snapshot', text: 'Pre-Deploy Snapshot' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'dr-rollback', text: 'Mark Rollback' }),
    ]);

    var stateEl  = Ren.el('div', { cls: 'panel-metrics', id: 'dr-state' });
    var histTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Deploy History' });
    var histList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-history', style: 'max-height:160px;overflow-y:auto;' });
    var rbTitle   = Ren.el('div', { cls: 'panel-subtitle', text: 'Rollback Records' });
    var rbList    = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-rollbacks', style: 'max-height:100px;overflow-y:auto;' });
    var staleTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Stale Tabs' });
    var staleEl    = Ren.el('div', { cls: 'panel-list-wrap', id: 'dr-stale', style: 'max-height:80px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(stateEl);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);
    this._c.appendChild(rbTitle);
    this._c.appendChild(rbList);
    this._c.appendChild(staleTitle);
    this._c.appendChild(staleEl);

    toolbar.querySelector('#dr-snapshot').addEventListener('click', function () {
      var DR = G.RuntimeDeployResilience;
      if (!DR) { alert('RuntimeDeployResilience not available'); return; }
      DR.capturePreDeploySnapshot().then(function (id) {
        alert(id ? 'Snapshot captured: ' + id : 'Snapshot failed (no RuntimeStateSnapshots?)');
        self.refresh();
      });
    });

    toolbar.querySelector('#dr-rollback').addEventListener('click', function () {
      var DR = G.RuntimeDeployResilience;
      if (!DR) return;
      var reason = prompt('Rollback reason:') || 'debug-panel';
      if (confirm('Mark deploy rollback? Reason: ' + reason)) {
        DR.markRollback(reason);
        self.refresh();
      }
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(histList);
  };

  PanelDeployResilience.prototype.refresh = function () {
    if (!this._built) return;
    var DR  = G.RuntimeDeployResilience;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // State
    var stateEl = this._c.querySelector('#dr-state');
    if (stateEl) {
      stateEl.innerHTML = '';
      if (DR) {
        var state = DR.getState();
        var m     = DR.getMetrics();
        [
          ['Build State',   state.buildState],
          ['Current Build', state.currentBuild || '—'],
          ['Server Build',  state.serverBuild  || '—'],
          ['Health',        DR.getHealthScore() + '%'],
          ['Deploys Seen',  m.deployDetected],
          ['Rollbacks',     m.rollbacks],
          ['Stale Tabs',    m.staleTabs],
        ].forEach(function (p) {
          var chip = Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] });
          if (p[0] === 'Build State' && p[1] === 'ROLLBACK') chip.style.color = '#f44';
          if (p[0] === 'Build State' && p[1] === 'STALE')    chip.style.color = '#fa0';
          stateEl.appendChild(chip);
        });
      } else {
        stateEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeDeployResilience not loaded' }));
      }
    }

    // Deploy history
    var histEl = this._c.querySelector('#dr-history');
    if (histEl && DR) {
      histEl.innerHTML = '';
      var hist = DR.getDeployHistory().slice().reverse();
      hist.forEach(function (rec) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rec.ts) }),
          Ren.el('span', { text: (rec.prevBuild || '?').slice(0, 8) + ' → ' + (rec.newBuild || '?').slice(0, 8) }),
          Ren.el('span', { cls: 'metric-chip', text: 'stale tabs: ' + (rec.tabStale || 0) }),
        ]);
        histEl.appendChild(row);
      });
      if (!hist.length) histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No deploy events recorded.' }));
    }

    // Rollbacks
    var rbEl = this._c.querySelector('#dr-rollbacks');
    if (rbEl && DR) {
      rbEl.innerHTML = '';
      var rbs = DR.getRollbacks();
      rbs.forEach(function (rb) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(rb.ts) }),
          Ren.el('span', { cls: 'tl-type', text: rb.reason }),
          Ren.el('span', { text: rb.buildId || '—' }),
        ]);
        rbEl.appendChild(row);
      });
      if (!rbs.length) rbEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No rollbacks recorded.' }));
    }

    // Stale tabs
    var staleEl = this._c.querySelector('#dr-stale');
    if (staleEl && DR) {
      staleEl.innerHTML = '';
      var staleTabs = DR.getStaleTabs();
      staleTabs.forEach(function (id) {
        staleEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [ Ren.el('span', { text: id }) ]));
      });
      if (!staleTabs.length) staleEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No stale tabs.' }));
    }
  };

  G.PanelDeployResilience = PanelDeployResilience;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));

// ── SOURCE: public/js/debug-panels/panel-crash-survival.js ──
(function (G) {
  'use strict';
  if (G.PanelCrashSurvival) return;

  var VERSION = '11.0.0';
  var LOG     = '[PanelCrashSurvival]';

  function PanelCrashSurvival(container) {
    this._c     = container;
    this._built = false;
  }

  PanelCrashSurvival.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '💥 Crash Survival' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'cs-recover',   text: 'Run Recovery' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'cs-clean-exit', text: 'Mark Clean Exit' }),
    ]);

    var statusEl = Ren.el('div', { cls: 'panel-metrics', id: 'cs-status' });

    var crashTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Last Crash Record' });
    var crashEl    = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-crash', style: 'max-height:80px;overflow-y:auto;' });

    var corrTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Incident Correlation Patterns' });
    var corrEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-corr', style: 'max-height:120px;overflow-y:auto;' });

    var cascTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Cascade Patterns' });
    var cascEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-casc', style: 'max-height:100px;overflow-y:auto;' });

    var rootTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Top Root Causes' });
    var rootEl     = Ren.el('div', { cls: 'panel-list-wrap', id: 'cs-root', style: 'max-height:100px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statusEl);
    this._c.appendChild(crashTitle);
    this._c.appendChild(crashEl);
    this._c.appendChild(corrTitle);
    this._c.appendChild(corrEl);
    this._c.appendChild(cascTitle);
    this._c.appendChild(cascEl);
    this._c.appendChild(rootTitle);
    this._c.appendChild(rootEl);

    toolbar.querySelector('#cs-recover').addEventListener('click', function () {
      var CS = G.RuntimeCrashSurvival;
      if (!CS) { alert('RuntimeCrashSurvival not available'); return; }
      CS.recover().then(function (r) {
        alert('Recovery: ' + JSON.stringify(r));
        self.refresh();
      }).catch(function (e) { alert('Recovery error: ' + e.message); });
    });

    toolbar.querySelector('#cs-clean-exit').addEventListener('click', function () {
      var CS = G.RuntimeCrashSurvival;
      if (!CS) return;
      CS.markCleanExit();
      alert('Clean exit marker written. Session will not be treated as a crash on next load.');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) {
      G.RuntimeDebugMobile.makeTouchScrollable(corrEl);
      G.RuntimeDebugMobile.makeTouchScrollable(cascEl);
    }
  };

  PanelCrashSurvival.prototype.refresh = function () {
    if (!this._built) return;
    var CS  = G.RuntimeCrashSurvival;
    var IC  = G.RuntimeIncidentCorrelation;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status strip
    var statusEl = this._c.querySelector('#cs-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (CS) {
        var m = CS.getMetrics();
        [
          ['Crashed',     CS.hasCrashed() ? 'YES' : 'no'],
          ['Crashes',     m.crashes],
          ['Recoveries',  m.recoveries],
          ['Wkr Storms',  m.workerStorms],
          ['Panics',      m.panics],
        ].forEach(function (p) {
          var chip = Ren.el('span', { cls: 'metric-chip', text: p[0] + ': ' + p[1] });
          if (p[0] === 'Crashed' && CS.hasCrashed()) chip.style.color = '#f44';
          statusEl.appendChild(chip);
        });
        // IC metrics
        if (IC) {
          var im = IC.getMetrics();
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Ingested: ' + im.ingested }));
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Clusters: ' + im.clusters }));
        }
      } else {
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'RuntimeCrashSurvival not loaded' }));
      }
    }

    // Last crash
    var crashEl = this._c.querySelector('#cs-crash');
    if (crashEl && CS) {
      crashEl.innerHTML = '';
      var crash = CS.getLastCrash();
      if (crash) {
        crashEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: crash.type }),
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(crash.ts) }),
        ]));
      } else {
        crashEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No crash recorded.' }));
      }
    }

    // Correlation patterns
    var corrEl = this._c.querySelector('#cs-corr');
    if (corrEl && IC) {
      corrEl.innerHTML = '';
      var patterns = IC.getPatterns();
      if (!patterns.length) {
        corrEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No correlation patterns yet.' }));
      } else {
        patterns.slice(-10).forEach(function (p) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'metric-chip', text: p.type }),
            Ren.el('span', { cls: 'tl-type', text: p.category }),
            Ren.el('span', { text: 'x' + p.count }),
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(p.lastTs) }),
          ]);
          corrEl.appendChild(row);
        });
      }
    } else if (corrEl) {
      corrEl.innerHTML = '';
      corrEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'RuntimeIncidentCorrelation not loaded.' }));
    }

    // Cascade patterns
    var cascEl = this._c.querySelector('#cs-casc');
    if (cascEl && IC) {
      cascEl.innerHTML = '';
      var cascades = IC.getCascades();
      if (!cascades.length) {
        cascEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No cascade patterns yet.' }));
      } else {
        cascades.slice(-8).forEach(function (c) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: c.trigger + ' → ' + c.effect }),
            Ren.el('span', { cls: 'metric-chip', text: 'x' + c.count }),
            Ren.el('span', { text: Math.round(c.avgDelayMs) + 'ms avg' }),
          ]);
          cascEl.appendChild(row);
        });
      }
    }

    // Root causes
    var rootEl = this._c.querySelector('#cs-root');
    if (rootEl && IC) {
      rootEl.innerHTML = '';
      var roots = IC.getTopRootCauses(8);
      if (!roots.length) {
        rootEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No root causes identified.' }));
      } else {
        roots.forEach(function (r) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type',     text: r.category }),
            Ren.el('span', { cls: 'metric-chip', text: 'x' + r.count }),
            Ren.el('span', { cls: 'metric-chip', text: r.severity }),
          ]);
          rootEl.appendChild(row);
        });
      }
    }
  };

  G.PanelCrashSurvival = PanelCrashSurvival;
  console.debug(LOG, 'v' + VERSION + ' ready');
}(window));

