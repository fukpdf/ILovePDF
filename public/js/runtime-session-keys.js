// RuntimeSessionKeys v1.0 — Phase 7 / Section 7 (Session Key Derivation)
// =============================================================================
// Session-scoped key derivation and lifecycle management.
// Keys are derived from session identity + device fingerprint + time epoch.
// All keys are volatile (in-memory only), rotated on session events.
//
// Key hierarchy:
//   Master key  ← session identity + device fingerprint
//   ├── exec key       ← master + "exec" + epoch
//   ├── sign key       ← master + "sign" + epoch
//   ├── transport key  ← master + "transport" + epoch
//   ├── worker key     ← master + "worker" + workerId
//   └── chunk key      ← master + "chunk" + chunkId
//
// window.RuntimeSessionKeys
//   .derive(purpose, context)    → Uint8Array[16]
//   .getMaster()                 → Uint8Array[16] (read-only copy)
//   .rotate(reason)              → void
//   .getEpoch()                  → number
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionKeys) return;

  var VERSION = '1.0';
  var LOG     = '[SessionKeys]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _masterKey   = null;   // Uint8Array[32]
  var _epoch       = 0;
  var _rotations   = 0;
  var _derivedKeys = typeof Map !== 'undefined' ? new Map() : null;

  // ── DJB2 key derivation ────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveBytes(seed, length) {
    var result = new Uint8Array(length);
    for (var i = 0; i < length; i++) {
      result[i] = _djb2(seed + ':' + i) & 0xFF;
    }
    return result;
  }

  // ── Build master key ───────────────────────────────────────────────────────
  function _buildMaster() {
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');

    var fingerprint = _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getFingerprint === 'function') {
        var fp = ri.getFingerprint();
        return fp.hash || fp.id || '';
      }
      return '';
    }, '');

    _epoch = Math.floor(Date.now() / (5 * 60_000));  // 5-minute epochs
    var seed = 'sk:' + sessionId + ':' + fingerprint + ':' + _epoch;
    _masterKey = _deriveBytes(seed, 32);
    if (_derivedKeys) _derivedKeys.clear();
    console.debug(LOG, 'master key derived | epoch:', _epoch);
  }

  // ── Derive a purpose key ────────────────────────────────────────────────────
  function derive(purpose, context) {
    if (!_masterKey) _buildMaster();

    var cacheKey = purpose + ':' + (context || '');
    if (_derivedKeys && _derivedKeys.has(cacheKey)) {
      return new Uint8Array(_derivedKeys.get(cacheKey));
    }

    var masterHex = Array.from(_masterKey).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');

    var purposeSeed = masterHex + ':' + purpose + ':' + (context || '') + ':' + _epoch;
    var key = _deriveBytes(purposeSeed, 16);

    if (_derivedKeys) {
      _derivedKeys.set(cacheKey, key.slice());
      if (_derivedKeys.size > 100) {
        var iter = _derivedKeys.keys();
        _derivedKeys.delete(iter.next().value);
      }
    }

    return key;
  }

  function getMaster() {
    if (!_masterKey) _buildMaster();
    return new Uint8Array(_masterKey); // copy, not reference
  }

  function rotate(reason) {
    _buildMaster();
    _rotations++;
    console.info(LOG, 'keys rotated | reason:', reason || 'manual', '| rotations:', _rotations);
    _s(function () {
      var ec = G.RuntimeExecutionCrypto;
      if (ec && typeof ec.rotateKeys === 'function') ec.rotateKeys();
    });
  }

  function getEpoch() { return _epoch; }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _buildMaster();
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('session:rotated', function () { rotate('session-rotated'); });
        G.RuntimeEventBus.on('seal:failure',    function () { rotate('seal-failure'); });
      }
    });
    // Rotate on epoch change
    setInterval(function () {
      var newEpoch = Math.floor(Date.now() / (5 * 60_000));
      if (newEpoch !== _epoch) rotate('epoch-change');
    }, 30_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| epoch:', _epoch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeSessionKeys = Object.freeze({
    VERSION:   VERSION,
    derive:    derive,
    getMaster: getMaster,
    rotate:    rotate,
    getEpoch:  getEpoch,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, epoch: _epoch, rotations: _rotations };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
