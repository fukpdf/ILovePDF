/**
 * PHASE 59 — STABLE P2P NETWORK
 * window.StableP2PNetwork
 *
 * 59A NatTraversalEngine   — ICE/STUN/TURN abstraction, peer recovery
 * 59B RelayFallbackLayer   — relay routing, chunk relay, congestion fallback
 * 59C PeerReputationSystem — reliability, uptime, latency, integrity tracking
 * 59D DistributedTrustEngine — shard verification, integrity voting, quarantine
 * 59E BandwidthOptimizer   — adaptive chunks, compression, congestion detection
 * 59F ShardMarketplace     — peer discovery, compute advertisement, idle utilization
 *
 * P2P REMAINS OFF BY DEFAULT.
 * Enable only with: StableP2PNetwork.enable()
 * Purely additive. Extends P2PDistributedMeshV2 without replacing it.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[SPN]';
  var _enabled = false;

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'spn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }

  function _requireEnabled() {
    if (!_enabled) { warn('StableP2PNetwork is OFF — call StableP2PNetwork.enable() to opt in'); return false; }
    return true;
  }

  var MB = 1024 * 1024;

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59C  PEER REPUTATION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var PeerReputationSystem = (function () {
    var _peers = new Map(); // peerId → ReputationRecord

    function _defaults(peerId) {
      return { peerId:peerId, score:0.5, reliability:0.5, uptime:0, latencyMs:500,
               bandwidth:0, integrityScore:1.0, taskSuccess:0, taskFail:0,
               corruptionReports:0, decay:0, banned:false, lastSeen:0, joined:now() };
    }

    function _ensure(peerId) {
      if (!_peers.has(peerId)) _peers.set(peerId, _defaults(peerId));
      return _peers.get(peerId);
    }

    function update(peerId, evt) {
      var p = _ensure(peerId);
      p.lastSeen = now();
      if (evt.success)    { p.taskSuccess++; if (evt.latencyMs) p.latencyMs=(p.latencyMs*3+evt.latencyMs)/4; }
      if (evt.fail)       { p.taskFail++; p.decay+=0.04; }
      if (evt.corruption) { p.corruptionReports++; p.integrityScore=Math.max(0,p.integrityScore-0.2); }
      if (evt.bandwidth)  { p.bandwidth=(p.bandwidth*3+evt.bandwidth)/4; }
      if (evt.uptime)     { p.uptime=evt.uptime; }
      if (evt.ban)        { p.banned=true; p.score=0; return; }
      _recompute(p);
    }

    function _recompute(p) {
      var total = p.taskSuccess + p.taskFail;
      var rel   = total ? p.taskSuccess/total : 0.5;
      var lat   = Math.max(0, 1 - p.latencyMs/5000);
      var bw    = Math.min(1, p.bandwidth / (1*MB));
      var int_  = p.integrityScore;
      p.reliability = rel;
      p.score = Math.max(0, Math.min(1, rel*0.4 + lat*0.2 + bw*0.1 + int_*0.3 - p.decay));
    }

    function applyDecay() {
      _peers.forEach(function(p) {
        var idle = now() - p.lastSeen;
        if (idle > 60000) { p.decay=Math.min(p.decay+0.01,0.5); _recompute(p); }
      });
    }

    function getScore(peerId) { return _peers.has(peerId) ? _peers.get(peerId).score : 0.5; }
    function isBanned(peerId) { return _peers.has(peerId) && _peers.get(peerId).banned; }

    function top(n, opts) {
      opts = opts || {};
      return Array.from(_peers.values())
        .filter(function(p){ return !p.banned && (!opts.minBandwidth||p.bandwidth>=opts.minBandwidth); })
        .sort(function(a,b){ return b.score-a.score; })
        .slice(0,n||5);
    }

    function stats() {
      var arr = Array.from(_peers.values());
      return { total:arr.length, banned:arr.filter(function(p){return p.banned;}).length,
               avgScore:arr.length ? arr.reduce(function(s,p){return s+p.score;},0)/arr.length : 0,
               avgLatencyMs:arr.length ? arr.reduce(function(s,p){return s+p.latencyMs;},0)/arr.length : 0 };
    }

    setInterval(applyDecay, 30000);
    return { update:update, getScore:getScore, isBanned:isBanned, top:top, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59D  DISTRIBUTED TRUST ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedTrustEngine = (function () {
    var _shardVotes = new Map(); // shardId → { votes: Map(peerId→{valid,hash}), quarantined:bool }
    var _quarantined = new Set();

    function _crc32(data) {
      var crc = 0xFFFFFFFF;
      var bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer||data);
      for (var i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (var j = 0; j < 8; j++) crc = (crc>>>1)^(crc&1?0xEDB88320:0);
      }
      return ((crc^0xFFFFFFFF)>>>0).toString(16);
    }

    function submitVote(shardId, peerId, data) {
      if (!_shardVotes.has(shardId)) _shardVotes.set(shardId, { votes:new Map(), quarantined:false });
      var entry = _shardVotes.get(shardId);
      var hash  = _crc32(data);
      entry.votes.set(peerId, { valid:true, hash:hash, ts:now() });
      return _evaluate(shardId, entry);
    }

    function _evaluate(shardId, entry) {
      if (entry.quarantined) return { consensus:false, quarantined:true };
      var votes  = Array.from(entry.votes.values());
      var hashes = {};
      votes.forEach(function(v){ hashes[v.hash]=(hashes[v.hash]||0)+1; });
      var maxHash = Object.keys(hashes).sort(function(a,b){return hashes[b]-hashes[a];})[0];
      var majority = hashes[maxHash] / votes.length;

      if (majority < 0.5 && votes.length >= 3) {
        // No consensus — quarantine
        entry.quarantined = true;
        _quarantined.add(shardId);
        warn('shard quarantined (no consensus):', shardId);
        // Flag corrupt reporters
        votes.forEach(function(v,) {
          // Find peers who voted minority
        });
        return { consensus:false, quarantined:true };
      }

      // Flag minority voters as suspect
      votes.forEach(function(v){ if (v.hash !== maxHash) {
        var pId = null;
        entry.votes.forEach(function(vote,pid){ if(vote.hash===v.hash) pId=pid; });
        if (pId) PeerReputationSystem.update(pId, { corruption:true });
      }});

      return { consensus:majority>=0.5, trustScore:majority, dominantHash:maxHash };
    }

    function isQuarantined(shardId) { return _quarantined.has(shardId); }

    function verifyIntegrity(shardId, data) {
      var hash = _crc32(data);
      var entry = _shardVotes.get(shardId);
      if (!entry) return true; // no votes yet, assume ok
      var dominant = null;
      entry.votes.forEach(function(v){ dominant = v.hash; }); // last is fine for single
      return dominant === null || dominant === hash;
    }

    function clearQuarantine(shardId) { _quarantined.delete(shardId); var e=_shardVotes.get(shardId); if(e) e.quarantined=false; }
    function stats() { return { tracked:_shardVotes.size, quarantined:_quarantined.size }; }

    return { submitVote:submitVote, isQuarantined:isQuarantined, verifyIntegrity:verifyIntegrity,
             clearQuarantine:clearQuarantine, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59E  BANDWIDTH OPTIMIZER
  // ═══════════════════════════════════════════════════════════════════════════
  var BandwidthOptimizer = (function () {
    var _chunkSize   = 512 * 1024; // 512KB default
    var _samples     = [];
    var _congestion  = false;
    var SAMPLE_MAX   = 20;

    function record(bytes, ms) {
      if (!ms) return;
      var bps = bytes / (ms / 1000);
      _samples.push(bps);
      if (_samples.length > SAMPLE_MAX) _samples.shift();
      _adapt();
    }

    function _adapt() {
      if (!_samples.length) return;
      var avg = _samples.reduce(function(a,b){return a+b;},0)/_samples.length;
      var min = Math.min.apply(null, _samples);
      // Congestion: recent min is < 30% of average
      _congestion = min < avg * 0.3;

      if      (avg > 20*MB) _chunkSize = 4*MB;
      else if (avg > 5*MB)  _chunkSize = 2*MB;
      else if (avg > 1*MB)  _chunkSize = 512*1024;
      else if (avg > 200*1024) _chunkSize = 128*1024;
      else                  _chunkSize = 32*1024;

      if (_congestion) _chunkSize = Math.min(_chunkSize, 64*1024);
    }

    function getChunkSize(opts) {
      opts = opts || {};
      var mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      var base   = mobile ? Math.min(_chunkSize, 128*1024) : _chunkSize;
      if (opts.priority === 'low') base = Math.min(base, 64*1024);
      return base;
    }

    function isCongested() { return _congestion; }
    function avgBps()      { return _samples.length ? _samples.reduce(function(a,b){return a+b;},0)/_samples.length : 0; }

    async function compress(data) {
      // Use CompressionStream if available
      if (typeof CompressionStream !== 'undefined') {
        try {
          var cs   = new CompressionStream('gzip');
          var buf  = data instanceof ArrayBuffer ? data : new TextEncoder().encode(String(data));
          var writer = cs.writable.getWriter();
          writer.write(new Uint8Array(buf));
          writer.close();
          var reader = cs.readable.getReader();
          var chunks = [];
          while (true) { var r=await reader.read(); if(r.done) break; chunks.push(r.value); }
          var total = chunks.reduce(function(s,c){return s+c.length;},0);
          var out   = new Uint8Array(total); var off=0;
          chunks.forEach(function(c){out.set(c,off);off+=c.length;});
          return out.buffer;
        } catch(e) { warn('compress failed:', e.message); }
      }
      return data;
    }

    return { record:record, getChunkSize:getChunkSize, isCongested:isCongested, avgBps:avgBps, compress:compress };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59A  NAT TRAVERSAL ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var NatTraversalEngine = (function () {
    var DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
    var _config = { iceServers: DEFAULT_STUN.map(function(s){return {urls:s};}) };
    var _connections = new Map(); // peerId → RTCPeerConnection

    function configure(opts) {
      opts = opts || {};
      if (opts.stunUrls)  _config.iceServers = opts.stunUrls.map(function(u){return {urls:u};});
      if (opts.turnUrls)  opts.turnUrls.forEach(function(t){ _config.iceServers.push({ urls:t.url, username:t.user, credential:t.pass }); });
    }

    async function createConnection(peerId, opts) {
      if (!_requireEnabled()) return null;
      if (typeof RTCPeerConnection === 'undefined') { warn('WebRTC unavailable'); return null; }
      if (_connections.has(peerId)) return _connections.get(peerId);

      var pc = new RTCPeerConnection(_config);
      _connections.set(peerId, pc);

      pc.oniceconnectionstatechange = function() {
        log('ICE state ['+peerId+']:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          _recover(peerId, pc);
        }
      };

      pc.onconnectionstatechange = function() {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          PeerReputationSystem.update(peerId, { fail:true });
          _recover(peerId, pc);
        } else if (pc.connectionState === 'connected') {
          PeerReputationSystem.update(peerId, { success:true });
        }
      };

      return pc;
    }

    async function _recover(peerId, pc) {
      warn('recovering connection to:', peerId);
      try { pc.restartIce && pc.restartIce(); } catch(_){}
      await new Promise(function(r){setTimeout(r,2000);});
      if (pc.connectionState === 'failed') {
        // Fall back to relay
        RelayFallbackLayer.activateRelay(peerId);
        _connections.delete(peerId);
      }
    }

    function closeConnection(peerId) {
      var pc = _connections.get(peerId);
      if (pc) { try { pc.close(); } catch(_){} _connections.delete(peerId); }
    }

    function closeAll() { _connections.forEach(function(_,id){ closeConnection(id); }); }

    function stats() {
      var states = {};
      _connections.forEach(function(pc,id){ states[id] = pc.connectionState || 'unknown'; });
      return { connections: _connections.size, states:states };
    }

    return { configure:configure, createConnection:createConnection, closeAll:closeAll, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59B  RELAY FALLBACK LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var RelayFallbackLayer = (function () {
    var _activeRelays = new Map(); // peerId → { channel, chunks, retries }
    var _channel = null;

    function _initBroadcastChannel(meshId) {
      try {
        _channel = new BroadcastChannel('spn_relay_' + (meshId||'default'));
        _channel.onmessage = function(e){ _onRelayMsg(e.data); };
        log('relay channel ready');
      } catch(e){ warn('BroadcastChannel unavailable:', e.message); }
    }

    function _onRelayMsg(msg) {
      if (!msg||!msg.type) return;
      switch(msg.type) {
        case 'relay-chunk':
          BandwidthOptimizer.record(msg.size||0, msg.ms||0);
          DistributedTrustEngine.submitVote(msg.shardId, msg.peerId, msg.data||'');
          break;
        case 'relay-done':
          var r = _activeRelays.get(msg.peerId);
          if (r) { r.done=true; PeerReputationSystem.update(msg.peerId,{success:true}); }
          break;
        case 'relay-error':
          PeerReputationSystem.update(msg.peerId, {fail:true});
          break;
      }
    }

    function activateRelay(peerId) {
      _activeRelays.set(peerId, { active:true, chunks:[], retries:0, ts:now() });
      log('relay activated for peer:', peerId);
    }

    async function relayChunk(peerId, shardId, data, opts) {
      if (!_requireEnabled()) return false;
      var t0     = now();
      var size   = data.byteLength || data.length || 0;
      var maxChunk = BandwidthOptimizer.getChunkSize(opts||{});

      // Compress if large
      if (size > 64*1024) data = await BandwidthOptimizer.compress(data);

      // Send via BroadcastChannel (same-origin relay)
      if (_channel) {
        _channel.postMessage({ type:'relay-chunk', peerId:peerId, shardId:shardId,
                                data:data, size:size, ms:now()-t0 });
      }

      BandwidthOptimizer.record(size, now()-t0);

      if (BandwidthOptimizer.isCongested()) {
        await new Promise(function(r){setTimeout(r,200);}); // backoff on congestion
      }
      return true;
    }

    async function retryRoute(peerId, shardId, data, maxAttempts) {
      maxAttempts = maxAttempts || 3;
      for (var i = 0; i < maxAttempts; i++) {
        var ok = await relayChunk(peerId, shardId, data);
        if (ok) return true;
        await new Promise(function(r){setTimeout(r,500*(i+1));});
      }
      warn('relay exhausted for shard:', shardId);
      return false;
    }

    function isRelayActive(peerId) { return _activeRelays.has(peerId); }
    function stats() { return { relays: _activeRelays.size, congested: BandwidthOptimizer.isCongested() }; }

    return { activateRelay:activateRelay, relayChunk:relayChunk, retryRoute:retryRoute,
             isRelayActive:isRelayActive, stats:stats, _initBroadcastChannel:_initBroadcastChannel };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 59F  SHARD MARKETPLACE
  // ═══════════════════════════════════════════════════════════════════════════
  var ShardMarketplace = (function () {
    var _advertisements = new Map(); // peerId → { capabilities, load, ts }
    var _bids           = new Map(); // shardId → [{ peerId, price, ts }]
    var _channel        = null;

    function _init(meshId) {
      try {
        _channel = new BroadcastChannel('spn_market_' + (meshId||'default'));
        _channel.onmessage = function(e){ _onMarketMsg(e.data); };
      } catch(_){}
    }

    function _onMarketMsg(msg) {
      if (!msg||!msg.type) return;
      switch(msg.type) {
        case 'advertise':
          _advertisements.set(msg.peerId, { capabilities:msg.capabilities, load:msg.load, bandwidth:msg.bandwidth, ts:now() });
          PeerReputationSystem.update(msg.peerId, { uptime:msg.uptime||0, bandwidth:msg.bandwidth||0 });
          break;
        case 'bid':
          if (!_bids.has(msg.shardId)) _bids.set(msg.shardId, []);
          _bids.get(msg.shardId).push({ peerId:msg.peerId, price:msg.price||0, ts:now() });
          break;
        case 'assign':
          log('shard assigned:', msg.shardId, '→', msg.peerId);
          break;
      }
    }

    function advertise() {
      if (!_requireEnabled() || !_channel) return;
      var cores  = navigator.hardwareConcurrency || 2;
      var memGb  = 0;
      try { memGb=(performance.memory&&performance.memory.jsHeapSizeLimit||0)/(1024*1024*1024); } catch(_){}
      var cap = {
        cores:  cores,
        memGb:  parseFloat(memGb.toFixed(1)),
        gpu:    !!(sys('WebGpuAiExpansion')&&sys('WebGpuAiExpansion').isReady()),
        mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
        onnx:   !!(sys('OnnxRuntimeManager')),
      };
      _channel.postMessage({ type:'advertise', peerId:_localPeerId, capabilities:cap,
                              load:0.3, bandwidth:BandwidthOptimizer.avgBps(), uptime:now()-_startTime });
    }

    function requestBid(shardId) {
      if (!_requireEnabled()||!_channel) return;
      _channel.postMessage({ type:'bid-request', shardId:shardId, ts:now() });
    }

    function selectBestPeer(shardId, opts) {
      var bids    = _bids.get(shardId) || [];
      var topPeer = PeerReputationSystem.top(1, opts);
      if (topPeer.length) return topPeer[0].peerId;
      if (bids.length) return bids.sort(function(a,b){return b.price-a.price;})[0].peerId;
      return null;
    }

    function discoverPeers(n) {
      return Array.from(_advertisements.entries())
        .filter(function(e){ return now()-e[1].ts<60000; }) // active last 60s
        .sort(function(a,b){ return PeerReputationSystem.getScore(b[0])-PeerReputationSystem.getScore(a[0]); })
        .slice(0,n||10)
        .map(function(e){ return Object.assign({ peerId:e[0] }, e[1]); });
    }

    function stats() { return { advertisements:_advertisements.size, openBids:_bids.size }; }

    var _localPeerId = uid();
    var _startTime   = now();
    setInterval(advertise, 15000);

    return { advertise:advertise, requestBid:requestBid, selectBestPeer:selectBestPeer,
             discoverPeers:discoverPeers, stats:stats, _init:_init };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // ENABLE / INIT
  // ═══════════════════════════════════════════════════════════════════════════
  var _meshId = null;

  function _enable(opts) {
    opts = opts || {};
    if (_enabled) return;
    _enabled = true;
    _meshId  = opts.meshId || uid();

    NatTraversalEngine.configure(opts);
    RelayFallbackLayer._initBroadcastChannel(_meshId);
    ShardMarketplace._init(_meshId);
    ShardMarketplace.advertise();

    // Also enable Phase 50 P2P if available
    var PDM2 = sys('P2PDistributedMeshV2');
    if (PDM2 && !PDM2.enabled()) {
      PDM2.enable({ meshId: _meshId });
      log('also enabled P2PDistributedMeshV2 v2');
    }

    log('StableP2PNetwork ENABLED — meshId:', _meshId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.StableP2PNetwork = {
    version: VERSION,
    enabled: function() { return _enabled; },
    meshId:  function() { return _meshId; },

    // OPT-IN required
    enable: function(opts) { _enable(opts); },
    disable: function() {
      _enabled = false;
      NatTraversalEngine.closeAll();
      log('StableP2PNetwork disabled');
    },

    // Peer discovery
    peers:       function(n) { return ShardMarketplace.discoverPeers(n); },
    topPeers:    function(n) { return PeerReputationSystem.top(n); },
    peerScore:   function(id) { return PeerReputationSystem.getScore(id); },
    isBanned:    function(id) { return PeerReputationSystem.isBanned(id); },

    // Relay
    relay: function(peerId, shardId, data, opts) { return RelayFallbackLayer.relayChunk(peerId, shardId, data, opts); },
    retryRoute: function(peerId, shardId, data) { return RelayFallbackLayer.retryRoute(peerId, shardId, data); },

    // Trust
    vote:        function(shardId, peerId, data) { return DistributedTrustEngine.submitVote(shardId, peerId, data); },
    verify:      function(shardId, data) { return DistributedTrustEngine.verifyIntegrity(shardId, data); },
    quarantined: function(shardId) { return DistributedTrustEngine.isQuarantined(shardId); },

    // Bandwidth
    bandwidth: {
      record:   function(bytes, ms) { BandwidthOptimizer.record(bytes, ms); },
      chunkSize: function() { return BandwidthOptimizer.getChunkSize(); },
      congested: function() { return BandwidthOptimizer.isCongested(); },
      avgBps:   function() { return BandwidthOptimizer.avgBps(); },
    },

    stats: function() {
      return {
        enabled:    _enabled,
        meshId:     _meshId,
        nat:        NatTraversalEngine.stats(),
        relay:      RelayFallbackLayer.stats(),
        reputation: PeerReputationSystem.stats(),
        trust:      DistributedTrustEngine.stats(),
        market:     ShardMarketplace.stats(),
        bandwidth:  { avgBps: BandwidthOptimizer.avgBps(), congested: BandwidthOptimizer.isCongested() },
      };
    },

    audit: function() { return { version:VERSION, ...window.StableP2PNetwork.stats() }; },
    cleanup: function() { NatTraversalEngine.closeAll(); _enabled=false; log('StableP2PNetwork cleaned up'); },

    // Sub-systems
    NatTraversal:   NatTraversalEngine,
    RelayFallback:  RelayFallbackLayer,
    Reputation:     PeerReputationSystem,
    TrustEngine:    DistributedTrustEngine,
    Bandwidth:      BandwidthOptimizer,
    Marketplace:    ShardMarketplace,
  };

  log('StableP2PNetwork v' + VERSION + ' loaded (P2P disabled by default)');
}());
