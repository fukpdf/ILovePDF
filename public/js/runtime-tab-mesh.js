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
