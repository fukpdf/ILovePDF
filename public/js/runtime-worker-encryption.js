// RuntimeWorkerEncryption v1.0 — Phase 7 / Section 2 (Worker Channel Encryption)
// =============================================================================
// Encrypted messaging channels between main thread and workers.
// Uses XOR + rotating keys derived from session identity.
//
// Architecture:
//   • Each worker gets a per-session derived key (not stored, session-volatile)
//   • Messages encrypted before postMessage, decrypted on receipt
//   • Key rotation on session events (heartbeat interval)
//   • Replay protection via message nonces
//   • Graceful fallback: when encryption unavailable, messages pass through
//     with a plaintext flag for detection
//
// Encryption scheme (client-side, fast, tamper-evident):
//   key    = DJB2(sessionId + workerId + salt) → Uint8Array[16]
//   cipher = XOR(payload, key) + HMAC-DJB2 checksum
//
// NOTE: This is an anti-scraping and anti-tampering layer, not a replacement
// for TLS. The wire is already TLS-protected; this adds origin binding.
//
// window.RuntimeWorkerEncryption
//   .encrypt(workerId, message)    → EncryptedPacket
//   .decrypt(workerId, packet)     → message|null
//   .rotateKey(workerId)           → void
//   .getKeyFingerprint(workerId)   → string
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerEncryption) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerEnc]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 70;  // only on HIGH tier to avoid perf impact

  // ── Key derivation ────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveKey(workerId, sessionId, salt) {
    var seed = workerId + '|' + sessionId + '|' + salt;
    var key = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
      key[i] = _djb2(seed + i) & 0xFF;
    }
    return key;
  }

  // ── Key store ──────────────────────────────────────────────────────────────
  var _keys    = typeof Map !== 'undefined' ? new Map() : null;
  var _nonces  = typeof Set !== 'undefined' ? new Set() : null;
  var _salt    = 'enc_' + Date.now().toString(36);

  function _getSessionId() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');
  }

  function _getOrCreateKey(workerId) {
    if (!_keys) return null;
    if (_keys.has(workerId)) return _keys.get(workerId);
    var key = _deriveKey(workerId, _getSessionId(), _salt);
    _keys.set(workerId, key);
    return key;
  }

  // ── XOR cipher ────────────────────────────────────────────────────────────
  function _xorBytes(data, key) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) {
      result[i] = data[i] ^ key[i % key.length];
    }
    return result;
  }

  // ── Text encode/decode ────────────────────────────────────────────────────
  function _encode(str) {
    var enc = _s(function () { return new TextEncoder(); }, null);
    if (enc) return enc.encode(str);
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
  }

  function _decode(bytes) {
    var dec = _s(function () { return new TextDecoder(); }, null);
    if (dec) return dec.decode(bytes);
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return str;
  }

  // ── Encrypt ───────────────────────────────────────────────────────────────
  function encrypt(workerId, message) {
    if (!_enabled) {
      return { plain: true, data: message, nonce: null };
    }

    var key = _getOrCreateKey(workerId);
    if (!key) return { plain: true, data: message, nonce: null };

    var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var payload = JSON.stringify({ d: message, n: nonce });
    var bytes = _encode(payload);
    var encrypted = _xorBytes(bytes, key);

    // Base64-like encoding using btoa
    var binaryStr = '';
    encrypted.forEach(function (b) { binaryStr += String.fromCharCode(b); });
    var b64 = _s(function () { return btoa(binaryStr); }, binaryStr);

    // Checksum
    var checksum = (_djb2(payload + _salt) >>> 0).toString(16);

    return { plain: false, data: b64, checksum: checksum, nonce: nonce };
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────
  function decrypt(workerId, packet) {
    if (!packet) return null;
    if (packet.plain) return packet.data;

    var key = _getOrCreateKey(workerId);
    if (!key) return null;

    try {
      var binaryStr = atob(packet.data);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      var decBytes = _xorBytes(bytes, key);
      var payload = _decode(decBytes);
      var obj = JSON.parse(payload);

      // Replay protection
      if (_nonces && _nonces.has(obj.n)) return null;
      if (_nonces) {
        _nonces.add(obj.n);
        if (_nonces.size > 1000) {
          var iter = _nonces.values();
          _nonces.delete(iter.next().value);
        }
      }

      // Checksum verification
      var expectedChecksum = (_djb2(payload + _salt) >>> 0).toString(16);
      if (packet.checksum !== expectedChecksum) {
        console.warn(LOG, 'checksum mismatch for worker:', workerId);
        return null;
      }

      return obj.d;
    } catch (e) {
      console.warn(LOG, 'decrypt failed:', e.message);
      return null;
    }
  }

  // ── Key rotation ──────────────────────────────────────────────────────────
  function rotateKey(workerId) {
    if (!_keys) return;
    _keys.delete(workerId);
    _salt = 'enc_' + Date.now().toString(36);
    console.debug(LOG, 'key rotated for worker:', workerId);
  }

  function getKeyFingerprint(workerId) {
    var key = _getOrCreateKey(workerId);
    if (!key) return 'none';
    return Array.from(key.slice(0, 4)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' | encryption disabled (tier:', _tier + ', needs HIGH)');
      return;
    }
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| salt:', _salt.slice(0, 8));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerEncryption = Object.freeze({
    VERSION:            VERSION,
    encrypt:            encrypt,
    decrypt:            decrypt,
    rotateKey:          rotateKey,
    getKeyFingerprint:  getKeyFingerprint,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        keyCount:   _keys ? _keys.size : 0,
        nonceCount: _nonces ? _nonces.size : 0,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
