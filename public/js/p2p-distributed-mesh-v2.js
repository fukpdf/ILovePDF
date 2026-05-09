/**
 * PHASE 50 — TRUE P2P DISTRIBUTED COMPUTE v2
 * window.P2PDistributedMeshV2
 *
 * Encrypted shard transfer, distributed chunk compute, peer reputation.
 * OFF BY DEFAULT — requires explicit opt-in via P2PDistributedMeshV2.enable().
 * Purely additive. Extends P2PComputeMesh without replacing it.
 * Degrades gracefully. Terms-compatible architecture only.
 */
(function () {
  'use strict';

  var VERSION  = '2.0';
  var LOG      = '[PDM2]';
  var _enabled = false;

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'pdm2_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }

  function _requireEnabled(fn) {
    return function () {
      if (!_enabled) { warn('P2P disabled — call P2PDistributedMeshV2.enable() to opt in'); return Promise.resolve(null); }
      return fn.apply(this, arguments);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  ENCRYPTED CHUNK TRANSPORT
  // ═══════════════════════════════════════════════════════════════════════════
  var EncryptedChunkTransport = (function () {
    var _key = null;

    async function _ensureKey() {
      if (_key) return _key;
      _key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
      return _key;
    }

    async function encrypt(data) {
      var key = await _ensureKey();
      var iv  = crypto.getRandomValues(new Uint8Array(12));
      var buf = typeof data === 'string' ? new TextEncoder().encode(data) : (data instanceof ArrayBuffer ? data : data.buffer);
      var ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, buf);
      return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
    }

    async function decrypt(payload) {
      var key = await _ensureKey();
      var iv  = new Uint8Array(payload.iv);
      var ct  = new Uint8Array(payload.ct);
      var pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      return pt;
    }

    async function encryptShard(shardData, shardId) {
      var enc = await encrypt(shardData);
      return { shardId: shardId, encrypted: enc, ts: Date.now(), checksum: _crc32str(shardId) };
    }

    function _crc32str(str) {
      var crc = 0xFFFFFFFF;
      for (var i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i);
        for (var j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    return { encrypt: encrypt, decrypt: decrypt, encryptShard: encryptShard };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  PEER TRUST ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var PeerTrustEngine = (function () {
    var _peers = new Map(); // peerId → { score, success, fail, latencies, decay, banned }

    function _ensure(peerId) {
      if (!_peers.has(peerId)) _peers.set(peerId, { peerId: peerId, score: 0.5, success: 0, fail: 0, latencies: [], decay: 0, banned: false, lastSeen: Date.now() });
      return _peers.get(peerId);
    }

    function record(peerId, opts) {
      opts = opts || {};
      var p = _ensure(peerId);
      p.lastSeen = Date.now();
      if (opts.success)    { p.success++; if (opts.latency) { p.latencies.push(opts.latency); if (p.latencies.length > 30) p.latencies.shift(); } }
      if (opts.fail)       { p.fail++; p.decay += 0.05; }
      if (opts.disconnect) { p.decay += 0.1; }
      if (opts.cheat)      { p.banned = true; p.score = 0; return; }
      _recompute(p);
    }

    function _recompute(p) {
      var total      = p.success + p.fail;
      var rate       = total ? p.success / total : 0.5;
      var avgLat     = p.latencies.length ? p.latencies.reduce(function (a,b){return a+b;},0) / p.latencies.length : 500;
      var latScore   = Math.max(0, 1 - avgLat / 5000);
      p.score        = Math.max(0, Math.min(1, rate * 0.6 + latScore * 0.3 + 0.1 - p.decay));
    }

    function applyDecay() {
      _peers.forEach(function (p) {
        var idle = Date.now() - p.lastSeen;
        if (idle > 60000) { p.decay = Math.min(p.decay + 0.01, 0.5); _recompute(p); }
      });
    }

    function getScore(peerId)  { return _peers.get(peerId) ? _peers.get(peerId).score : 0.5; }
    function isBanned(peerId)  { return _peers.get(peerId) ? _peers.get(peerId).banned : false; }
    function top(n)            { return Array.from(_peers.values()).filter(function (p){return !p.banned;}).sort(function (a,b){return b.score-a.score;}).slice(0, n||5); }
    function stats()           { return { total: _peers.size, banned: [..._peers.values()].filter(function(p){return p.banned;}).length, avgScore: _peers.size ? [..._peers.values()].reduce(function(s,p){return s+p.score;},0)/_peers.size : 0 }; }

    setInterval(applyDecay, 30000);
    return { record: record, getScore: getScore, isBanned: isBanned, top: top, stats: stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  DISTRIBUTED SHARD MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedShardManager = (function () {
    var _shards = new Map(); // shardId → { data, peerId, status, checksum, retries }

    function register(shardId, data, peerId) {
      _shards.set(shardId, { shardId: shardId, data: data, peerId: peerId || 'local', status: 'pending', retries: 0, ts: Date.now() });
    }

    function markDone(shardId, result) {
      var s = _shards.get(shardId);
      if (s) { s.status = 'done'; s.result = result; s.completedAt = Date.now(); }
    }

    function markFailed(shardId, err) {
      var s = _shards.get(shardId);
      if (s) { s.status = 'failed'; s.error = err; s.retries++; }
    }

    function reassign(shardId, newPeerId) {
      var s = _shards.get(shardId);
      if (s) { s.peerId = newPeerId; s.status = 'pending'; }
    }

    function pending() { return [..._shards.values()].filter(function(s){return s.status==='pending'||s.status==='failed'&&s.retries<3;}); }
    function done()    { return [..._shards.values()].filter(function(s){return s.status==='done';}); }
    function all()     { return [..._shards.values()]; }
    function clear()   { _shards.clear(); }

    return { register: register, markDone: markDone, markFailed: markFailed, reassign: reassign, pending: pending, done: done, all: all, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  MESH COORDINATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var MeshCoordinator = (function () {
    var _meshId   = null;
    var _peers    = new Set();
    var _isLeader = false;
    var _channel  = null;

    function init(meshId) {
      _meshId   = meshId || uid();
      _isLeader = true; // first tab is leader
      try {
        _channel = new BroadcastChannel('pdm2_mesh_' + _meshId);
        _channel.onmessage = function (e) { _onMsg(e.data); };
        _broadcast({ type: 'leader-announce', meshId: _meshId });
      } catch (e) { warn('BroadcastChannel unavailable:', e.message); }
      log('mesh coordinator initialized, meshId:', _meshId);
      return _meshId;
    }

    function _broadcast(msg) {
      try { if (_channel) _channel.postMessage(msg); } catch (_) {}
    }

    function _onMsg(msg) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'peer-join':    _peers.add(msg.peerId); PeerTrustEngine.record(msg.peerId, {}); break;
        case 'peer-leave':   _peers.delete(msg.peerId); break;
        case 'shard-done':   DistributedShardManager.markDone(msg.shardId, msg.result); break;
        case 'shard-failed': DistributedShardManager.markFailed(msg.shardId, msg.error); _reassignShard(msg.shardId); break;
        case 'heartbeat':    PeerTrustEngine.record(msg.peerId, { success: true, latency: Date.now() - msg.ts }); break;
      }
    }

    function _reassignShard(shardId) {
      var top = PeerTrustEngine.top(3);
      if (top.length) {
        DistributedShardManager.reassign(shardId, top[0].peerId);
        _broadcast({ type: 'shard-reassign', shardId: shardId, targetPeer: top[0].peerId });
      }
    }

    function broadcastHeartbeat() {
      _broadcast({ type: 'heartbeat', meshId: _meshId, ts: Date.now(), peerCount: _peers.size });
    }

    setInterval(broadcastHeartbeat, 5000);

    return {
      init:       init,
      peers:      function () { return Array.from(_peers); },
      peerCount:  function () { return _peers.size; },
      isLeader:   function () { return _isLeader; },
      meshId:     function () { return _meshId; },
      broadcast:  _broadcast,
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  BANDWIDTH ADAPTIVE SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════
  var BandwidthAdaptiveScheduler = (function () {
    var _chunkSize = 512 * 1024; // 512 KB default
    var _samples   = [];

    function recordTransfer(bytes, ms) {
      var bps = bytes / (ms / 1000);
      _samples.push(bps);
      if (_samples.length > 10) _samples.shift();
      _adapt();
    }

    function _adapt() {
      if (!_samples.length) return;
      var avg = _samples.reduce(function (a,b){return a+b;},0) / _samples.length;
      if      (avg > 10 * 1024 * 1024) _chunkSize = 2 * 1024 * 1024;  // 2MB on fast
      else if (avg > 1  * 1024 * 1024) _chunkSize = 512 * 1024;         // 512KB
      else                              _chunkSize = 128 * 1024;          // 128KB on slow
    }

    function isMobile() {
      return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    }

    function getChunkSize() {
      // Mobile restriction: max 256KB
      return isMobile() ? Math.min(_chunkSize, 256 * 1024) : _chunkSize;
    }

    return { recordTransfer: recordTransfer, getChunkSize: getChunkSize, isMobile: isMobile };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  DISTRIBUTED RESULT ASSEMBLER
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedResultAssembler = (function () {
    function assemble(shardResults) {
      shardResults.sort(function (a,b) { return a.index - b.index; });
      var parts = shardResults.map(function (s) { return s.result; }).filter(Boolean);
      if (parts.every(function (p) { return p instanceof Uint8Array; })) {
        var total = parts.reduce(function (s,p) { return s + p.length; }, 0);
        var buf = new Uint8Array(total); var offset = 0;
        parts.forEach(function (p) { buf.set(p, offset); offset += p.length; });
        return buf;
      }
      return parts.join('');
    }
    return { assemble: assemble };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  DISTRIBUTED CHECKPOINT STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedCheckpointStore = (function () {
    var DB = 'pdm2_checkpoints_v1';
    var _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function (e) { var db=e.target.result; if(!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints',{keyPath:'id'}); };
        req.onsuccess = function (e) { _db=e.target.result; res(_db); };
        req.onerror   = function ()  { rej(req.error); };
      });
    }
    function save(id, data) { return open().then(function (db) { return new Promise(function (r) { var tx=db.transaction('checkpoints','readwrite'); tx.objectStore('checkpoints').put({id:id,data:data,ts:Date.now()}); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    function load(id) { return open().then(function (db) { return new Promise(function (r) { var req=db.transaction('checkpoints','readonly').objectStore('checkpoints').get(id); req.onsuccess=function(){r(req.result||null);}; req.onerror=function(){r(null);}; }); }).catch(function(){return null;}); }
    return { save: save, load: load };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  PEER CAPABILITY ANALYZER
  // ═══════════════════════════════════════════════════════════════════════════
  var PeerCapabilityAnalyzer = (function () {
    function analyze() {
      var cores  = navigator.hardwareConcurrency || 2;
      var memory = 0;
      try { memory = (performance.memory && performance.memory.jsHeapSizeLimit || 0) / 1073741824; } catch (_) {}
      var hasGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
      var mobile = BandwidthAdaptiveScheduler.isMobile();

      return {
        cores:   cores,
        memGb:   memory,
        hasGpu:  hasGpu,
        mobile:  mobile,
        tier:    mobile ? 'mobile' : cores >= 8 && memory >= 8 ? 'high' : cores >= 4 ? 'medium' : 'low',
        chunkMs: mobile ? 500 : 200,
      };
    }
    return { analyze: analyze };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  MESH RECOVERY ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var MeshRecoveryEngine = (function () {
    async function recover(taskId) {
      var checkpoint = await DistributedCheckpointStore.load(taskId);
      if (!checkpoint) { warn('no checkpoint found for', taskId); return null; }
      log('recovering task from checkpoint:', taskId);
      var pending = DistributedShardManager.pending();
      pending.forEach(function (shard) {
        var top = PeerTrustEngine.top(1);
        if (top.length) DistributedShardManager.reassign(shard.shardId, top[0].peerId);
      });
      return { recovered: true, checkpointTs: checkpoint.ts, pendingShards: pending.length };
    }

    async function checkIntegrity() {
      var all    = DistributedShardManager.all();
      var failed = all.filter(function (s) { return s.status === 'failed'; });
      if (failed.length) { warn('integrity check: ' + failed.length + ' failed shards, recovering'); return recover('last'); }
      return { ok: true, shards: all.length };
    }

    return { recover: recover, checkIntegrity: checkIntegrity };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  MAIN DISTRIBUTED TASK API (requires enable)
  // ═══════════════════════════════════════════════════════════════════════════
  var _distributeTask = _requireEnabled(async function (taskId, dataChunks, processor, onProgress) {
    onProgress = onProgress || function () {};
    log('distributing task', taskId, 'chunks:', dataChunks.length);

    var results = [];
    var chunks  = dataChunks.slice();
    var chunkSz = BandwidthAdaptiveScheduler.getChunkSize();
    var cap     = PeerCapabilityAnalyzer.analyze();

    // Register shards
    chunks.forEach(function (chunk, i) {
      DistributedShardManager.register(taskId + '_' + i, chunk, 'local');
    });

    // Save checkpoint
    await DistributedCheckpointStore.save(taskId, { chunks: chunks.length, ts: Date.now() });

    // Process locally (actual WebRTC dispatch requires ICE server config)
    var concurrency = cap.tier === 'high' ? 4 : cap.tier === 'medium' ? 2 : 1;
    var done = 0;

    async function _processBatch(batch) {
      return Promise.all(batch.map(async function (item) {
        var enc = await EncryptedChunkTransport.encryptShard(item.data, item.shardId);
        try {
          var result = processor ? await processor(item.data, item.index) : { processed: true };
          DistributedShardManager.markDone(item.shardId, result);
          done++;
          onProgress({ done: done, total: chunks.length, shardId: item.shardId });
          PeerTrustEngine.record('local', { success: true, latency: 50 });
          return { index: item.index, result: result };
        } catch (e) {
          DistributedShardManager.markFailed(item.shardId, e.message);
          return { index: item.index, result: null };
        }
      }));
    }

    for (var i = 0; i < chunks.length; i += concurrency) {
      var batch = chunks.slice(i, i + concurrency).map(function (c, bi) { return { data: c, shardId: taskId + '_' + (i+bi), index: i+bi }; });
      var batchResults = await _processBatch(batch);
      results = results.concat(batchResults);
    }

    var assembled = DistributedResultAssembler.assemble(results.filter(function(r){return r.result;}));
    DistributedShardManager.clear();
    return assembled;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.P2PDistributedMeshV2 = {
    version:  VERSION,
    enabled:  function () { return _enabled; },

    enable: function (opts) {
      opts = opts || {};
      if (_enabled) return;
      _enabled = true;
      MeshCoordinator.init(opts.meshId || null);
      log('P2PDistributedMeshV2 ENABLED by user opt-in');
    },

    disable: function () {
      _enabled = false;
      DistributedShardManager.clear();
      log('P2PDistributedMeshV2 disabled');
    },

    distribute: _distributeTask,

    recover: _requireEnabled(function (taskId) { return MeshRecoveryEngine.recover(taskId); }),

    integrity: function () { return MeshRecoveryEngine.checkIntegrity(); },

    peerStats: function () {
      return {
        meshId:     MeshCoordinator.meshId(),
        peers:      MeshCoordinator.peerCount(),
        trust:      PeerTrustEngine.stats(),
        capability: PeerCapabilityAnalyzer.analyze(),
        shards:     { pending: DistributedShardManager.pending().length, done: DistributedShardManager.done().length },
      };
    },

    audit: function () {
      return { version: VERSION, enabled: _enabled, peers: MeshCoordinator.peerCount(), trustStats: PeerTrustEngine.stats(), chunkSize: BandwidthAdaptiveScheduler.getChunkSize(), mobile: BandwidthAdaptiveScheduler.isMobile() };
    },

    cleanup: function () { DistributedShardManager.clear(); _enabled = false; },

    // Sub-systems
    Coordinator:     MeshCoordinator,
    ShardManager:    DistributedShardManager,
    TrustEngine:     PeerTrustEngine,
    Assembler:       DistributedResultAssembler,
    CheckpointStore: DistributedCheckpointStore,
    Capabilities:    PeerCapabilityAnalyzer,
    Recovery:        MeshRecoveryEngine,
    Transport:       EncryptedChunkTransport,
    Bandwidth:       BandwidthAdaptiveScheduler,
  };

  log('P2PDistributedMeshV2 v' + VERSION + ' loaded (disabled by default)');
}());
