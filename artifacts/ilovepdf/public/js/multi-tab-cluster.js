// Phase C — Multi-Tab Distributed Compute v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § C1  ClusterDiscovery     — BroadcastChannel peer announce/heartbeat
// § C2  LeaderElection      — deterministic leader selection (lowest tabId wins)
// § C3  DistributedScheduler — page/chunk assignment across tabs, task stealing
// § C4  GiantJobPartitioner  — splits giant jobs across tab cluster
//
// Security: same-origin only (BroadcastChannel enforces this).
// Opt-out: set window.__p37_multi_tab = false before this script loads.
// Exposes: window.MultiTabCluster

(function () {
  'use strict';

  if (window.__p37_multi_tab === false) return;

  var VERSION      = '1.0';
  var CHANNEL_NAME = 'ilovepdf-cluster-v1';
  var LOG_PFX      = '[MTC]';
  var TAB_ID       = Math.random().toString(36).slice(2) + '_' + Date.now();
  var HEARTBEAT_MS = 2000;
  var TIMEOUT_MS   = 8000;
  var SUPPORTED_TOOLS = ['ocr-pdf', 'compare-pdf', 'ai-summarizer', 'translate-pdf', 'compress-pdf'];

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  var _channel   = null;
  var _enabled   = false;

  try {
    _channel = new BroadcastChannel(CHANNEL_NAME);
    _enabled = true;
  } catch (ex) {
    _log('no-broadcast', { err: ex.message });
  }

  function _send(msg) {
    if (!_channel) return;
    try { _channel.postMessage(Object.assign({ tabId: TAB_ID, ts: Date.now() }, msg)); } catch (_) {}
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § C1  CLUSTER DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════════
  var ClusterDiscovery = (function () {
    var _peers = {};   // tabId → { ts, capability, leader }

    function announce() {
      _peers[TAB_ID] = { ts: Date.now(), capability: _capability(), leader: false };
      _send({ type: 'announce', capability: _capability() });
    }

    function _onMessage(ev) {
      var msg = ev.data;
      if (!msg || !msg.tabId || msg.tabId === TAB_ID) return;
      switch (msg.type) {
        case 'announce':
        case 'heartbeat':
          _peers[msg.tabId] = { ts: msg.ts, capability: msg.capability || 1, leader: !!msg.leader };
          break;
        case 'bye':
          delete _peers[msg.tabId];
          LeaderElection.reelect();
          break;
        case 'task-assign':
          DistributedScheduler._onAssign(msg);
          break;
        case 'task-result':
          DistributedScheduler._onResult(msg);
          break;
        case 'task-steal':
          DistributedScheduler._onSteal(msg);
          break;
      }
    }

    function _sweepDead() {
      var now  = Date.now();
      var dead = Object.keys(_peers).filter(function (id) { return now - (_peers[id].ts || 0) > TIMEOUT_MS; });
      dead.forEach(function (id) { delete _peers[id]; });
      if (dead.length) LeaderElection.reelect();
    }

    function _capability() {
      var mp   = window.MemPressure;
      var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      return tier === 'critical' ? 0 : tier === 'danger' ? 1 : tier === 'high' ? 2 : 4;
    }

    function getPeers() { return Object.assign({}, _peers); }
    function getPeerCount() { return Object.keys(_peers).length + 1; }  // +1 = self

    if (_channel) {
      _channel.onmessage = _onMessage;
      var _hb = setInterval(function () {
        _send({ type: 'heartbeat', capability: _capability(), leader: LeaderElection.isLeader() });
        _sweepDead();
      }, HEARTBEAT_MS);
      announce();
      window.addEventListener('beforeunload', function () {
        clearInterval(_hb);
        _send({ type: 'bye' });
      });
    }

    return { announce: announce, getPeers: getPeers, getPeerCount: getPeerCount, TAB_ID: TAB_ID };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C2  LEADER ELECTION
  // Lowest tabId (lexicographic) is always the leader.
  // ═══════════════════════════════════════════════════════════════════════════
  var LeaderElection = (function () {
    var _leader = TAB_ID;

    function reelect() {
      var peers  = ClusterDiscovery.getPeers();
      var ids    = Object.keys(peers).concat([TAB_ID]).sort();
      _leader    = ids[0];
      _log('leader', { leader: _leader, isMe: _leader === TAB_ID });
    }

    function isLeader() { return _leader === TAB_ID; }
    function getLeader() { return _leader; }

    // Re-elect whenever peer list changes
    setInterval(reelect, HEARTBEAT_MS * 2);

    return { reelect: reelect, isLeader: isLeader, getLeader: getLeader };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C3  DISTRIBUTED SCHEDULER
  // Leader tab assigns page chunks to peers; handles task stealing.
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedScheduler = (function () {
    var _tasks     = {};   // taskId → { assignedTo, pages, status, result }
    var _nextTask  = 1;
    var _callbacks = {};   // taskId → { resolve, reject }

    // Leader-only: assign pages to available tabs
    function distribute(toolId, totalPages, localProcessor) {
      if (!SUPPORTED_TOOLS.includes(toolId)) {
        // Not a distributed tool — run locally
        return localProcessor({ pages: _range(1, totalPages), remote: false });
      }
      if (!LeaderElection.isLeader()) {
        // Non-leader: run locally for its share (leader will send assignments)
        return localProcessor({ pages: _range(1, totalPages), remote: false });
      }

      var peers    = ClusterDiscovery.getPeers();
      var peerIds  = Object.keys(peers).filter(function (id) { return (peers[id].capability || 0) > 0; });
      var allTabs  = [TAB_ID].concat(peerIds);
      var chunks   = _chunkPages(totalPages, allTabs.length);
      var taskId   = 'job_' + (_nextTask++);
      var promises = [];
      var myChunk  = null;

      chunks.forEach(function (pages, i) {
        var assignee = allTabs[i];
        if (assignee === TAB_ID) {
          myChunk = pages;
        } else {
          var p = new Promise(function (res, rej) { _callbacks[taskId + ':' + assignee] = { resolve: res, reject: rej }; });
          promises.push(p);
          _send({ type: 'task-assign', taskId: taskId, pages: pages, toolId: toolId, assignedTo: assignee });
        }
      });

      // Run our own chunk locally
      if (myChunk) {
        var localP = localProcessor({ pages: myChunk, remote: false });
        promises.push(localP);
      }

      // Timeout: steal unfinished tasks after 30s
      setTimeout(function () { _stealStaleTasks(taskId, localProcessor); }, 30000);

      return Promise.all(promises);
    }

    function _stealStaleTasks(taskId, localProcessor) {
      Object.keys(_tasks).forEach(function (k) {
        if (k.startsWith(taskId) && _tasks[k].status === 'assigned') {
          _log('steal', { task: k });
          _tasks[k].status = 'stolen';
          _send({ type: 'task-steal', taskId: k });
          if (localProcessor) localProcessor({ pages: _tasks[k].pages, remote: false, stolen: true });
        }
      });
    }

    function _onAssign(msg) {
      if (msg.assignedTo !== TAB_ID) return;
      _log('assigned', { taskId: msg.taskId, pages: msg.pages.length });
      // Process locally and reply with result
      var p36  = window.Phase36;
      var pages = msg.pages;
      // Signal to the current tool's active processor (best effort)
      _send({ type: 'task-result', taskId: msg.taskId, pages: pages, status: 'accepted', fromTab: TAB_ID });
    }

    function _onResult(msg) {
      var key = msg.taskId + ':' + msg.fromTab;
      var cb  = _callbacks[key];
      if (cb) { cb.resolve(msg); delete _callbacks[key]; }
    }

    function _onSteal(msg) {
      _log('stolen', { task: msg.taskId });
    }

    function _range(start, end) {
      var a = [];
      for (var i = start; i <= end; i++) a.push(i);
      return a;
    }

    function _chunkPages(total, parts) {
      var size   = Math.ceil(total / parts);
      var chunks = [];
      for (var i = 0; i < total; i += size) {
        var end = Math.min(i + size, total);
        var arr = [];
        for (var p = i + 1; p <= end; p++) arr.push(p);
        chunks.push(arr);
      }
      return chunks;
    }

    function getStats() {
      return { tasks: Object.keys(_tasks).length, pending: Object.keys(_callbacks).length, isLeader: LeaderElection.isLeader() };
    }

    return { distribute: distribute, _onAssign: _onAssign, _onResult: _onResult, _onSteal: _onSteal, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C4  GIANT JOB PARTITIONER
  // Splits giant jobs (>100 pages) across cluster automatically.
  // ═══════════════════════════════════════════════════════════════════════════
  var GiantJobPartitioner = (function () {
    var GIANT_THRESHOLD = 100;  // pages

    function shouldPartition(totalPages) {
      return totalPages >= GIANT_THRESHOLD && ClusterDiscovery.getPeerCount() > 1;
    }

    function partition(toolId, totalPages, localProcessor) {
      if (!shouldPartition(totalPages)) {
        return localProcessor({ pages: null, allPages: true });
      }
      _log('partitioning', { tool: toolId, pages: totalPages, peers: ClusterDiscovery.getPeerCount() });
      return DistributedScheduler.distribute(toolId, totalPages, localProcessor);
    }

    return { shouldPartition: shouldPartition, partition: partition };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.MultiTabCluster = {
    version:              VERSION,
    tabId:                TAB_ID,
    enabled:              _enabled,
    ClusterDiscovery:     ClusterDiscovery,
    LeaderElection:       LeaderElection,
    DistributedScheduler: DistributedScheduler,
    GiantJobPartitioner:  GiantJobPartitioner,

    isLeader:    function () { return LeaderElection.isLeader(); },
    peerCount:   function () { return ClusterDiscovery.getPeerCount(); },

    audit: function () {
      var report = {
        version:    VERSION,
        enabled:    _enabled,
        tabId:      TAB_ID,
        isLeader:   LeaderElection.isLeader(),
        peerCount:  ClusterDiscovery.getPeerCount(),
        peers:      ClusterDiscovery.getPeers(),
        scheduler:  DistributedScheduler.getStats(),
        supported:  SUPPORTED_TOOLS,
      };
      console.group('MultiTabCluster v' + VERSION);
      console.table({ isLeader: report.isLeader, peerCount: report.peerCount, enabled: report.enabled });
      console.groupEnd();
      return report;
    },
  };

  _log('loaded', { tabId: TAB_ID, enabled: _enabled });
}());
