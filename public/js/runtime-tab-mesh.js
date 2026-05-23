// RuntimeTabMesh v1.0 — Phase 8 / Objective 5
// =============================================================================
// Multi-tab incident correlation and synchronized security coordination.
// Uses BroadcastChannel for zero-latency cross-tab communication.
//
// Protocol:
//   HEARTBEAT   — liveness ping from every tab (2-second interval)
//   INCIDENT    — incident propagated from reporting tab to all others
//   ANOMALY     — anomaly score update shared across tabs
//   LOCK        — coordinated session lock from any tab
//   LEADER_BID  — leader election bid
//   LEADER_ACK  — leader acknowledgment
//
// Leader election:
//   • Tabs bid with a random nonce on first heartbeat
//   • Highest nonce wins; ties resolved by tabId lexicographic order
//   • If leader goes silent > 6s, a new election is triggered
//   • Leader is responsible for polling ThreatFeed on behalf of the mesh
//
// window.RuntimeTabMesh
//   .broadcast(type, data)          → void
//   .getTabs()                      → Tab[]
//   .isLeader()                     → boolean
//   .lockAllTabs(reason)            → void
//   .getIncidentHistory()           → Incident[]
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeTabMesh) return;

  var VERSION    = '1.0';
  var LOG        = '[TabMesh]';
  var CHANNEL    = 'p8_tab_mesh';
  var HEARTBEAT_INTERVAL = 2000;
  var STALE_THRESHOLD    = 6000;

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
  var _bid    = Math.random();   // leader election bid (higher = more likely to win)
  var _leader = null;
  var _isLeader = false;

  // ── State ──────────────────────────────────────────────────────────────────
  var _tabs             = {};   // { tabId: { id, ts, score, isLeader } }
  var _incidentHistory  = [];   // cross-tab incident log (max 100)
  var _locked           = false;
  var _channel          = null;
  var _heartbeatTimer   = null;
  var _staleTimer       = null;

  // ── Open channel ───────────────────────────────────────────────────────────
  function _openChannel() {
    try {
      _channel = new BroadcastChannel(CHANNEL);
      _channel.onmessage = _onMessage;
    } catch (e) {
      console.warn(LOG, 'BroadcastChannel unavailable:', e.message);
      _channel = null;
    }
  }

  // ── Send message ───────────────────────────────────────────────────────────
  function _send(type, data) {
    if (!_channel) return;
    try {
      _channel.postMessage({
        type:  type,
        tabId: _tabId,
        bid:   _bid,
        ts:    Date.now(),
        data:  data || null,
      });
    } catch (_) {}
  }

  // ── Receive message ────────────────────────────────────────────────────────
  function _onMessage(evt) {
    var msg = evt && evt.data;
    if (!msg || !msg.tabId || msg.tabId === _tabId) return;

    var tid = msg.tabId;

    switch (msg.type) {
      case 'HEARTBEAT':
        _tabs[tid] = { id: tid, ts: msg.ts, bid: msg.bid, isLeader: msg.data && msg.data.isLeader };
        _pruneStale();
        _checkLeader();
        break;

      case 'INCIDENT':
        _receiveIncident(msg.data, tid);
        break;

      case 'ANOMALY':
        _s(function () {
          var ba = G.RuntimeBehaviorAnalysis;
          if (ba && typeof ba.externalSignal === 'function') {
            ba.externalSignal('tab-mesh', msg.data);
          }
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
        // Another tab is bidding — compare bids
        if (msg.bid > _bid || (msg.bid === _bid && tid > _tabId)) {
          // Other tab wins — acknowledge
          _send('LEADER_ACK', { winner: tid });
          _isLeader = false;
        }
        break;

      case 'LEADER_ACK':
        if (msg.data && msg.data.winner === _tabId) {
          _isLeader = true;
          _leader   = _tabId;
          console.info(LOG, 'became mesh leader');
        }
        break;
    }
  }

  // ── Receive incident from another tab ─────────────────────────────────────
  function _receiveIncident(data, fromTab) {
    if (!data) return;
    _incidentHistory.push({
      id:      data.id,
      type:    data.type,
      severity: data.severity,
      fromTab: fromTab,
      ts:      Date.now(),
    });
    if (_incidentHistory.length > 100) _incidentHistory.shift();

    // Feed into local IncidentEngine for unified scoring
    _s(function () {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie._create === 'function') {
        ie._create(
          'cross-tab:' + (data.type || 'unknown'),
          (data.score || 30),
          'tab-mesh',
          { fromTab: fromTab, original: data.id }
        );
      }
    });

    // Update SecurityStream
    _s(function () {
      var ss = G.RuntimeSecurityStream;
      if (ss && typeof ss.push === 'function') {
        ss.push('tab-mesh-incident', 'tab-mesh', data.severity || 'MEDIUM',
          'Cross-tab incident: ' + (data.type || 'unknown'), { from: fromTab });
      }
    });
  }

  // ── Prune stale tabs ───────────────────────────────────────────────────────
  function _pruneStale() {
    var cutoff = Date.now() - STALE_THRESHOLD;
    Object.keys(_tabs).forEach(function (id) {
      if (_tabs[id].ts < cutoff) delete _tabs[id];
    });
  }

  // ── Leader check / election ────────────────────────────────────────────────
  function _checkLeader() {
    // If current leader is stale, hold an election
    if (_leader && _tabs[_leader] && _tabs[_leader].ts > Date.now() - STALE_THRESHOLD) {
      return; // leader is alive
    }
    // Elect: highest bid wins among known tabs + self
    var candidates = [{ id: _tabId, bid: _bid }];
    Object.keys(_tabs).forEach(function (id) {
      candidates.push({ id: id, bid: _tabs[id].bid || 0 });
    });
    candidates.sort(function (a, b) {
      return b.bid !== a.bid ? b.bid - a.bid : b.id > a.id ? 1 : -1;
    });
    var winner = candidates[0];
    if (winner.id === _tabId && !_isLeader) {
      _isLeader = true;
      _leader   = _tabId;
      _send('LEADER_BID', null);
      console.info(LOG, 'leader election won by this tab');
    } else if (winner.id !== _tabId) {
      _isLeader = false;
      _leader   = winner.id;
    }
  }

  // ── Public broadcast ───────────────────────────────────────────────────────
  function broadcast(type, data) {
    _send(type, data);
  }

  function getTabs() {
    _pruneStale();
    var list = [{ id: _tabId, ts: Date.now(), bid: _bid, isLeader: _isLeader, self: true }];
    Object.keys(_tabs).forEach(function (id) {
      list.push(Object.assign({}, _tabs[id], { self: false }));
    });
    return list;
  }

  function isLeader() { return _isLeader; }

  function lockAllTabs(reason) {
    _locked = true;
    _send('LOCK', { reason: reason || 'manual' });
    console.warn(LOG, 'issuing session lock to all tabs | reason:', reason);
  }

  function getIncidentHistory() { return _incidentHistory.slice(); }

  // ── Subscribe to local IncidentEngine and propagate across tabs ────────────
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

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  function _startHeartbeat() {
    _heartbeatTimer = setInterval(function () {
      _send('HEARTBEAT', { isLeader: _isLeader });
      _pruneStale();
    }, HEARTBEAT_INTERVAL);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ', BroadcastChannel:', typeof BroadcastChannel + ')');
      return;
    }

    _openChannel();
    _startHeartbeat();

    // Initial leader bid
    setTimeout(function () {
      _send('LEADER_BID', null);
      setTimeout(_checkLeader, 1000); // if no ACK received, assume leader
    }, 500);

    setTimeout(_subscribeToLocalIncidents, 5000);

    console.debug(LOG, 'v' + VERSION + ' ready | tabId:', _tabId,
      '| tier:', _tier, '| channel:', CHANNEL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    if (_channel) { try { _channel.close(); } catch (_) {} }
  }, { once: true });

  G.RuntimeTabMesh = Object.freeze({
    VERSION:            VERSION,
    broadcast:          broadcast,
    getTabs:            getTabs,
    isLeader:           isLeader,
    lockAllTabs:        lockAllTabs,
    getIncidentHistory: getIncidentHistory,
    status: function () {
      return {
        version:   VERSION,
        enabled:   _enabled,
        tier:      _tier,
        tabId:     _tabId,
        isLeader:  _isLeader,
        tabs:      Object.keys(_tabs).length + 1,
        locked:    _locked,
        incidents: _incidentHistory.length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
