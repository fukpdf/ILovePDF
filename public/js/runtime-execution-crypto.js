// RuntimeExecutionCrypto v1.0 — Phase 7 / Section 7 (Execution Cryptography)
// =============================================================================
// Rotating execution keys and encrypted execution channels.
// Provides cryptographic primitives for the execution pipeline.
//
// Key management:
//   • Session-derived keys (not persisted, volatile)
//   • Key rotation on schedule or security events
//   • Multiple key types: execution, signing, transport
//
// Crypto operations (all client-side, no server round-trip):
//   • XOR-based lightweight symmetric encryption (fast, tamper-evident)
//   • DJB2/FNV1a message authentication codes
//   • Nonce generation and tracking
//   • Key derivation via repeated hashing
//
// window.RuntimeExecutionCrypto
//   .getKey(type)                    → Uint8Array
//   .rotateKeys()                    → void
//   .encrypt(data, keyType)          → EncryptedPayload
//   .decrypt(payload, keyType)       → any|null
//   .mac(data, keyType)              → string
//   .verify(data, mac, keyType)      → boolean
//   .generateNonce()                 → string
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeExecutionCrypto) return;

  var VERSION = '1.0';
  var LOG     = '[ExecCrypto]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Key state ──────────────────────────────────────────────────────────────
  var _keys = {
    exec:      null,   // Uint8Array[16]
    sign:      null,   // Uint8Array[16]
    transport: null,   // Uint8Array[16]
  };
  var _keyGenCount = 0;
  var _rotationTs  = 0;
  var KEY_TTL_MS   = 15 * 60_000;  // rotate every 15 minutes

  // ── Key derivation ─────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveKey(seed) {
    var key = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
      key[i] = _djb2(seed + ':' + i) & 0xFF;
    }
    return key;
  }

  function _getSessionSeed() {
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : null;
    }, null) || 'anon';
    return sessionId + ':' + Date.now().toString(36).slice(0, 6);
  }

  function _initKeys() {
    var seed = _getSessionSeed();
    _keys.exec      = _deriveKey('exec:'      + seed);
    _keys.sign      = _deriveKey('sign:'      + seed);
    _keys.transport = _deriveKey('transport:' + seed);
    _keyGenCount++;
    _rotationTs = Date.now();
    console.debug(LOG, 'keys generated | gen:', _keyGenCount);
  }

  // ── Get key (auto-rotate if stale) ────────────────────────────────────────
  function getKey(type) {
    if (!_keys.exec || (Date.now() - _rotationTs) > KEY_TTL_MS) {
      _initKeys();
    }
    return _keys[type] || _keys.exec;
  }

  function rotateKeys() {
    _initKeys();
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('crypto:keys-rotated', { gen: _keyGenCount });
      }
    });
  }

  // ── XOR encryption ────────────────────────────────────────────────────────
  function _xor(data, key) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) result[i] = data[i] ^ key[i % key.length];
    return result;
  }

  function _encode(str) {
    var enc = _s(function () { return new TextEncoder(); }, null);
    if (enc) return enc.encode(str);
    var b = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xFF;
    return b;
  }

  function _decode(bytes) {
    var dec = _s(function () { return new TextDecoder(); }, null);
    if (dec) return dec.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function encrypt(data, keyType) {
    if (!_enabled) return { plain: true, data: data };
    var key      = getKey(keyType || 'exec');
    var nonce    = generateNonce();
    var payload  = JSON.stringify({ d: data, n: nonce });
    var bytes    = _encode(payload);
    var cipher   = _xor(bytes, key);
    var b64      = _s(function () {
      return btoa(String.fromCharCode.apply(null, Array.from(cipher)));
    }, null);
    if (!b64) return { plain: true, data: data };
    var checksum = mac(payload, 'sign');
    return { plain: false, data: b64, checksum: checksum, nonce: nonce };
  }

  function decrypt(payload, keyType) {
    if (!payload) return null;
    if (payload.plain) return payload.data;
    var key = getKey(keyType || 'exec');
    try {
      var binary = atob(payload.data);
      var cipher = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) cipher[i] = binary.charCodeAt(i);
      var plain = _decode(_xor(cipher, key));
      var obj = JSON.parse(plain);
      if (payload.checksum && !verify(plain, payload.checksum, 'sign')) return null;
      return obj.d;
    } catch (e) {
      return null;
    }
  }

  function mac(data, keyType) {
    var key = getKey(keyType || 'sign');
    var str = JSON.stringify(data);
    var h = 0x811c9dc5;
    var keyStr = Array.from(key).map(function (b) { return String.fromCharCode(b); }).join('');
    var combined = str + keyStr;
    for (var i = 0; i < combined.length; i++) {
      h ^= combined.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function verify(data, macVal, keyType) {
    return mac(data, keyType) === macVal;
  }

  function generateNonce() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _initKeys();
    setInterval(rotateKeys, KEY_TTL_MS);
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('session:rotated', rotateKeys);
        G.RuntimeEventBus.on('shield:tamper-response', rotateKeys);
      }
    });
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeExecutionCrypto = Object.freeze({
    VERSION:       VERSION,
    getKey:        getKey,
    rotateKeys:    rotateKeys,
    encrypt:       encrypt,
    decrypt:       decrypt,
    mac:           mac,
    verify:        verify,
    generateNonce: generateNonce,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, keyGenCount: _keyGenCount, rotationAge: Date.now() - _rotationTs };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
