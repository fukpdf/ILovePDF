// ILovePDF — RuntimeCrossTab v1.0 — Phase 6D
// =====================================================================
// BroadcastChannel-based cross-tab coordination cluster.
//
// Responsibilities:
//   - Share memory tier, emergency state, worker pressure across tabs
//   - When any tab enters CRITICAL/ABORT memory tier, all tabs reduce
//     their concurrency limits automatically
//   - Prevent worker storms: broadcast active worker counts so tabs
//     back off spawning when the cluster total is too high
//   - Coordinate emergency cleanup: one tab broadcasts, all respond
//   - Heartbeat every 30 s so tabs know who is alive
//
// Channel: ilovepdf-cluster-v1
//
// Message schema:
//   { type, tabId, ts, payload }
//
// Message types:
//   HEARTBEAT      — periodic presence + state report
//   MEMORY_TIER    — a tab changed memory tier
//   EMERGENCY      — a tab entered emergency mode
//   WORKER_COUNT   — a tab's active worker count changed
//   HEALTH_DROP    — a tab's health score dropped critically
//   TAB_GONE       — BroadcastChannel closed (pagehide)
//
// Integrates: RuntimeEventBus, RuntimeState, RuntimeMemory,
//             RuntimeWorkers, RuntimeCancellation, RuntimeTelemetry
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeCrossTab) return;
  if (typeof BroadcastChannel === 'undefined') {
    global.RuntimeCrossTab = { available: false, getStats: function () { return { available: false }; } };
    console.info('[CrossTab] BroadcastChannel not available — cross-tab coordination disabled');
    return;
  }

  var LOG     = '[XTab]';
  var CHANNEL = 'ilovepdf-cluster-v1';
  var TAB_ID  = Math.random().toString(36).slice(2, 10) + '-' + Date.now();

  var HEARTBEAT_INTERVAL_MS = 30000;
  var TAB_STALE_MS          = 90000; // 3× heartbeat = stale
  var MAX_CLUSTER_WORKERS   = 8;     // cluster-wide worker ceiling

  // ── Message types ──────────────────────────────────────────────────────────
  var MSG = {
    HEARTBEAT:   'HEARTBEAT',
    MEMORY_TIER: 'MEMORY_TIER',
    EMERGENCY:   'EMERGENCY',
    WORKER_COUNT:'WORKER_COUNT',
    HEALTH_DROP: 'HEALTH_DROP',
    TAB_GONE:    'TAB_GONE',
  };

  // ── Channel ────────────────────────────────────────────────────────────────
  var _channel = null;
  try { _channel = new BroadcastChannel(CHANNEL); }
  catch (e) {
    global.RuntimeCrossTab = { available: false, getStats: function () { return { available: false }; } };
    console.warn(LOG, 'BroadcastChannel open failed:', e.message);
    return;
  }

  // ── Cluster peer registry ─────────────────────────────────────────────────
  // Map<tabId, { ts, tier, workers, health, emergency }>
  var _peers = new Map();

  function _recordPeer(tabId, data) {
    _peers.set(tabId, Object.assign({ ts: Date.now() }, data || {}));
  }

  function _evictStalePeers() {
    var cutoff = Date.now() - TAB_STALE_MS;
    _peers.forEach(function (peer, id) {
      if (peer.ts < cutoff) _peers.delete(id);
    });
  }

  // ── Send helpers ───────────────────────────────────────────────────────────
  function _send(type, payload) {
    if (!_channel) return;
    try {
      _channel.postMessage({ type: type, tabId: TAB_ID, ts: Date.now(), payload: payload || {} });
    } catch (_) {}
  }

  function _currentState() {
    return {
      tier:      _safe(function () { return global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL'; }, 'NORMAL'),
      workers:   _safe(function () { return global.RuntimeState  ? global.RuntimeState.get('activeWorkers') : 0; }, 0),
      health:    _safe(function () { return global.RuntimeHealth  ? global.RuntimeHealth.getScore() : 100; }, 100),
      emergency: _safe(function () { return global.RuntimeState  ? global.RuntimeState.get('emergencyActive') : false; }, false),
    };
  }

  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }

  // ── Cluster-wide worker ceiling ────────────────────────────────────────────
  function _clusterWorkerTotal() {
    var total = _safe(function () { return global.RuntimeState ? global.RuntimeState.get('activeWorkers') : 0; }, 0);
    _peers.forEach(function (p) { total += (p.workers || 0); });
    return total;
  }

  function _shouldBackOff() {
    _evictStalePeers();
    // Back off if any peer is in critical/emergency or cluster total is too high
    var anyEmergency  = false;
    var anyCritical   = false;
    _peers.forEach(function (p) {
      if (p.emergency) anyEmergency = true;
      if (p.tier === 'CRITICAL' || p.tier === 'ABORT' || p.tier === 'EMERGENCY') anyCritical = true;
    });
    var clusterOverload = _clusterWorkerTotal() >= MAX_CLUSTER_WORKERS;
    return { anyEmergency: anyEmergency, anyCritical: anyCritical, clusterOverload: clusterOverload };
  }

  // ── Apply incoming cluster state change locally ────────────────────────────
  function _applyMemoryTier(peerTier, peerTabId) {
    var critical = (peerTier === 'CRITICAL' || peerTier === 'ABORT' || peerTier === 'EMERGENCY');
    if (!critical) return;

    console.warn(LOG, 'peer tab', peerTabId, 'entered', peerTier, '— reducing local concurrency');

    // Emit local memory pressure event so RuntimeMemory reduces config
    if (global.RuntimeEventBus) {
      try {
        global.RuntimeEventBus.emit('memory:tier-changed', {
          tier:       peerTier,
          source:     'cross-tab',
          peerTabId:  peerTabId,
        });
      } catch (_) {}
    }

    // Also directly reduce RuntimeMemory worker limit if possible
    if (global.RuntimeMemory && global.RuntimeMemory.applyConfig) {
      try {
        global.RuntimeMemory.applyConfig({ maxWorkers: 1, chunkMB: 4 });
      } catch (_) {}
    }

    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('cross-tab:memory-pressure', { peerTier: peerTier }); } catch (_) {}
    }
  }

  function _applyEmergency(peerTabId) {
    console.warn(LOG, 'peer tab', peerTabId, 'entered EMERGENCY — cancelling background tasks');
    if (global.RuntimeCancellation) {
      try { global.RuntimeCancellation.cancelScope('background', 'cross-tab-emergency'); } catch (_) {}
    }
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('memory:emergency', { source: 'cross-tab', peerTabId: peerTabId }); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('cross-tab:emergency-received', { peerTabId: peerTabId }); } catch (_) {}
    }
  }

  // ── Message receiver ───────────────────────────────────────────────────────
  _channel.onmessage = function (ev) {
    var msg = ev.data;
    if (!msg || msg.tabId === TAB_ID) return; // ignore own messages

    switch (msg.type) {
      case MSG.HEARTBEAT:
        _recordPeer(msg.tabId, msg.payload);
        break;

      case MSG.MEMORY_TIER:
        _recordPeer(msg.tabId, { tier: msg.payload.tier });
        _applyMemoryTier(msg.payload.tier, msg.tabId);
        break;

      case MSG.EMERGENCY:
        _recordPeer(msg.tabId, { emergency: true, tier: 'EMERGENCY' });
        _applyEmergency(msg.tabId);
        break;

      case MSG.WORKER_COUNT:
        _recordPeer(msg.tabId, { workers: msg.payload.count });
        // If cluster total exceeds ceiling, pause new worker spawns
        if (_clusterWorkerTotal() >= MAX_CLUSTER_WORKERS) {
          if (global.RuntimeEventBus) {
            try { global.RuntimeEventBus.emit('cross-tab:worker-ceiling', { total: _clusterWorkerTotal() }); } catch (_) {}
          }
        }
        break;

      case MSG.HEALTH_DROP:
        _recordPeer(msg.tabId, { health: msg.payload.score });
        if (global.RuntimeEventBus) {
          try { global.RuntimeEventBus.emit('cross-tab:health-drop', { peerTabId: msg.tabId, score: msg.payload.score }); } catch (_) {}
        }
        break;

      case MSG.TAB_GONE:
        _peers.delete(msg.tabId);
        break;
    }
  };

  // ── Subscribe to local runtime events and broadcast them ──────────────────
  function _subscribeLocalEvents() {
    if (!global.RuntimeEventBus) return;

    // Memory tier changes → broadcast
    global.RuntimeEventBus.on('memory:tier-changed', function (data) {
      if (data && data.source === 'cross-tab') return; // don't re-broadcast peer events
      _send(MSG.MEMORY_TIER, { tier: data && data.tier });
    });

    // Emergency → broadcast
    global.RuntimeEventBus.on('memory:emergency', function (data) {
      if (data && data.source === 'cross-tab') return;
      _send(MSG.EMERGENCY, { reason: data && data.reason });
    });

    // Worker spawned/released → broadcast count
    global.RuntimeEventBus.on('worker:spawned', function () {
      var count = _safe(function () { return global.RuntimeState ? global.RuntimeState.get('activeWorkers') : 0; }, 0);
      _send(MSG.WORKER_COUNT, { count: count });
    });
    global.RuntimeEventBus.on('worker:released', function () {
      var count = _safe(function () { return global.RuntimeState ? global.RuntimeState.get('activeWorkers') : 0; }, 0);
      _send(MSG.WORKER_COUNT, { count: count });
    });

    // Health degraded → broadcast
    global.RuntimeEventBus.on('health:degraded', function (data) {
      if (data && data.score < 40) {
        _send(MSG.HEALTH_DROP, { score: data.score });
      }
    });
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  var _heartbeatId = null;

  function _startHeartbeat() {
    if (_heartbeatId) return;
    _heartbeatId = setInterval(function () {
      _evictStalePeers();
      _send(MSG.HEARTBEAT, _currentState());
    }, HEARTBEAT_INTERVAL_MS);
    if (global.TimerRegistry) {
      try { global.TimerRegistry.registerInterval('cross-tab-heartbeat', _heartbeatId); } catch (_) {}
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  function getStats() {
    _evictStalePeers();
    var peers = [];
    _peers.forEach(function (p, id) { peers.push(Object.assign({ tabId: id }, p)); });
    return {
      available:     true,
      channel:       CHANNEL,
      tabId:         TAB_ID,
      peerCount:     _peers.size,
      peers:         peers,
      clusterWorkers:_clusterWorkerTotal(),
      backOff:       _shouldBackOff(),
    };
  }

  // ── Manual broadcast API ───────────────────────────────────────────────────
  function broadcast(type, payload) { _send(type, payload); }
  function MSG_TYPES() { return Object.assign({}, MSG); }

  // ── Pagehide ───────────────────────────────────────────────────────────────
  global.addEventListener('pagehide', function () {
    _send(MSG.TAB_GONE, {});
    if (_heartbeatId) { clearInterval(_heartbeatId); _heartbeatId = null; }
    try { _channel.close(); } catch (_) {}
  }, { passive: true });

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    _subscribeLocalEvents();
    _startHeartbeat();

    // Register with CentralRuntime
    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('crossTab', global.RuntimeCrossTab); } catch (_) {}
    }

    // Announce presence
    _send(MSG.HEARTBEAT, _currentState());

    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('cross-tab:init', { tabId: TAB_ID }); } catch (_) {}
    }
  }

  // Subscribe after runtime:ready so all subsystems exist
  if (global.RuntimeEventBus) {
    global.RuntimeEventBus.once('runtime:ready', function () { setTimeout(_boot, 100); });
  }
  global.addEventListener('rt:runtime:ready', function () { setTimeout(_boot, 100); }, { once: true });

  // Fallback boot if event was already fired
  if (document.readyState === 'complete') setTimeout(_boot, 300);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 300); }, { once: true });

  global.RuntimeCrossTab = {
    available:     true,
    tabId:         TAB_ID,
    broadcast:     broadcast,
    getStats:      getStats,
    shouldBackOff: _shouldBackOff,
    MSG:           MSG_TYPES,
  };

  console.info('[CrossTab] RuntimeCrossTab v1.0 ready — channel:', CHANNEL, '| tabId:', TAB_ID);
}(window));
