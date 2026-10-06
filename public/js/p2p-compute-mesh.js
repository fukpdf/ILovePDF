// Phase D — P2P Compute Mesh v1.0
// PURELY ADDITIVE — zero changes to any existing file.
// OFF BY DEFAULT — requires explicit user opt-in via P2PComputeMesh.enable().
//
// § D1  PeerMesh      — WebRTC signalling stubs + peer registry
// § D2  ChunkExchange — encrypted shard distribution (AES-GCM)
// § D3  TaskMesh      — distributed task sharding, aggregation, retry
// § D4  PeerScoring   — trust scores, timeout recovery, idle detection
//
// Exposes: window.P2PComputeMesh

(function () {
  'use strict';

  var VERSION   = '1.0';
  var LOG_PFX   = '[P2P]';
  var _enabled  = false;   // OFF by default
  var _optedIn  = false;

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  function _requireEnabled(fn) {
    return function () {
      if (!_enabled) { _log('disabled', {}); return Promise.resolve(null); }
      return fn.apply(this, arguments);
    };
  }

  // ── Encryption helpers (AES-GCM, key per-session) ─────────────────────────
  var _cryptoKey = null;

  async function _ensureKey() {
    if (_cryptoKey) return _cryptoKey;
    _cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return _cryptoKey;
  }

  async function _encrypt(data) {
    var key = await _ensureKey();
    var iv  = crypto.getRandomValues(new Uint8Array(12));
    var buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    var ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, buf);
    return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
  }

  async function _decrypt(payload) {
    var key = await _ensureKey();
    var iv  = new Uint8Array(payload.iv);
    var ct  = new Uint8Array(payload.ct);
    var pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    return new TextDecoder().decode(pt);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § D1  PEER MESH
  // Manages WebRTC peer connections (stubs until ICE server configured).
  // ═══════════════════════════════════════════════════════════════════════════
  var PeerMesh = (function () {
    var _peers       = {};   // peerId → { conn, dataChannel, score, lastSeen }
    var _localId     = Math.random().toString(36).slice(2);

    function addPeer(peerId, opts) {
      if (!_enabled) return;
      if (_peers[peerId]) return;
      // WebRTC stub — actual signalling requires server coordination
      _peers[peerId] = { peerId: peerId, score: 50, lastSeen: Date.now(), ready: false, opts: opts || {} };
      _log('peer-added', { peerId: peerId });
    }

    function removePeer(peerId) {
      var p = _peers[peerId];
      if (!p) return;
      if (p.conn) { try { p.conn.close(); } catch (_) {} }
      delete _peers[peerId];
      _log('peer-removed', { peerId: peerId });
    }

    function getReady() {
      return Object.values(_peers).filter(function (p) { return p.ready && p.score > 20; });
    }

    function send(peerId, data) {
      var p = _peers[peerId];
      if (!p || !p.dataChannel || p.dataChannel.readyState !== 'open') return false;
      try { p.dataChannel.send(JSON.stringify(data)); return true; } catch (_) { return false; }
    }

    function broadcast(data) {
      var sent = 0;
      Object.keys(_peers).forEach(function (id) { if (send(id, data)) sent++; });
      return sent;
    }

    function getPeers() { return Object.assign({}, _peers); }
    function getLocalId() { return _localId; }

    function shutdown() {
      Object.keys(_peers).forEach(removePeer);
      _log('shutdown', {});
    }

    return { addPeer: addPeer, removePeer: removePeer, getReady: getReady, send: send, broadcast: broadcast, getPeers: getPeers, getLocalId: getLocalId, shutdown: shutdown };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § D2  CHUNK EXCHANGE
  // Encrypted shard serialization and distribution
  // ═══════════════════════════════════════════════════════════════════════════
  var ChunkExchange = (function () {
    var _pending = {};   // chunkId → { resolve, reject, timer }

    var createShard = _requireEnabled(async function (data, chunkId) {
      var encrypted = await _encrypt(typeof data === 'string' ? data : JSON.stringify(data));
      return { chunkId: chunkId || Math.random().toString(36).slice(2), payload: encrypted, ts: Date.now() };
    });

    var receiveShard = _requireEnabled(async function (shard) {
      try {
        var plain = await _decrypt(shard.payload);
        var data  = JSON.parse(plain);
        var cb    = _pending[shard.chunkId];
        if (cb) { clearTimeout(cb.timer); cb.resolve(data); delete _pending[shard.chunkId]; }
        return data;
      } catch (ex) {
        _err('recv-shard', ex);
        return null;
      }
    });

    function expectShard(chunkId, timeoutMs) {
      return new Promise(function (res, rej) {
        var timer = setTimeout(function () {
          delete _pending[chunkId];
          rej(new Error('shard_timeout:' + chunkId));
        }, timeoutMs || 30000);
        _pending[chunkId] = { resolve: res, reject: rej, timer: timer };
      });
    }

    return { createShard: createShard, receiveShard: receiveShard, expectShard: expectShard };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § D3  TASK MESH
  // Distribute tasks across peers, aggregate results, retry failed shards
  // ═══════════════════════════════════════════════════════════════════════════
  var TaskMesh = (function () {
    var _activeTasks = {};

    var distribute = _requireEnabled(async function (taskId, chunks, opts) {
      var peers   = PeerMesh.getReady();
      if (peers.length === 0) {
        _log('no-peers', { taskId: taskId });
        return null;
      }
      _activeTasks[taskId] = { chunks: chunks, results: [], startedAt: Date.now() };
      var maxRetries = (opts && opts.maxRetries) || 3;
      var results    = [];

      for (var i = 0; i < chunks.length; i++) {
        var peer   = peers[i % peers.length];
        var shard  = await ChunkExchange.createShard(chunks[i], taskId + ':' + i);
        if (!shard) { results.push(null); continue; }

        var ok   = PeerMesh.send(peer.peerId, { type: 'task-shard', shard: shard, taskId: taskId, chunkIdx: i });
        if (!ok) { results.push(null); PeerScoring.penalize(peer.peerId, 10); continue; }

        // Wait for result shard with retry
        var result = null;
        for (var attempt = 0; attempt < maxRetries; attempt++) {
          try {
            result = await ChunkExchange.expectShard(taskId + ':' + i + ':result', 30000);
            PeerScoring.reward(peer.peerId, 5);
            break;
          } catch (ex) {
            PeerScoring.penalize(peer.peerId, 15);
            _log('shard-retry', { taskId: taskId, chunk: i, attempt: attempt + 1 });
          }
        }
        results.push(result);
      }

      delete _activeTasks[taskId];
      return results;
    });

    function aggregate(results, aggregatorFn) {
      var valid = results.filter(function (r) { return r !== null && r !== undefined; });
      return aggregatorFn ? aggregatorFn(valid) : valid;
    }

    function getStats() {
      return { activeTasks: Object.keys(_activeTasks).length };
    }

    return { distribute: distribute, aggregate: aggregate, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § D4  PEER SCORING
  // ═══════════════════════════════════════════════════════════════════════════
  var PeerScoring = (function () {
    var _scores = {};   // peerId → score (0–100)
    var DECAY   = 0.98;

    function reward(peerId, amount) {
      _scores[peerId] = Math.min(100, (_scores[peerId] || 50) + (amount || 5));
    }
    function penalize(peerId, amount) {
      _scores[peerId] = Math.max(0, (_scores[peerId] || 50) - (amount || 10));
      // Update peer score in mesh
      var peers = PeerMesh.getPeers();
      if (peers[peerId]) peers[peerId].score = _scores[peerId];
    }
    function getScore(peerId) { return _scores[peerId] !== undefined ? _scores[peerId] : 50; }

    // Decay all scores slowly to prevent permanent bans
    setInterval(function () {
      Object.keys(_scores).forEach(function (id) {
        _scores[id] = Math.min(100, _scores[id] * DECAY + 1);
      });
    }, 60000);

    function getStats() { return Object.assign({}, _scores); }
    return { reward: reward, penalize: penalize, getScore: getScore, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.P2PComputeMesh = {
    version:       VERSION,
    enabled:       false,

    PeerMesh:      PeerMesh,
    ChunkExchange: ChunkExchange,
    TaskMesh:      TaskMesh,
    PeerScoring:   PeerScoring,

    // Explicit user opt-in required
    enable: function () {
      _enabled = true;
      _optedIn = true;
      this.enabled = true;
      _log('enabled-by-user', {});
    },

    disable: function () {
      _enabled = false;
      this.enabled = false;
      PeerMesh.shutdown();
      _log('disabled-by-user', {});
    },

    isEnabled: function () { return _enabled; },

    audit: function () {
      return {
        version:     VERSION,
        enabled:     _enabled,
        optedIn:     _optedIn,
        peers:       Object.keys(PeerMesh.getPeers()).length,
        readyPeers:  PeerMesh.getReady().length,
        tasks:       TaskMesh.getStats(),
        peerScores:  PeerScoring.getStats(),
        warning:     _enabled ? null : 'P2P is OFF — call P2PComputeMesh.enable() to activate',
      };
    },
  };

  _log('loaded', { enabled: false, note: 'call P2PComputeMesh.enable() to opt in' });
}());
