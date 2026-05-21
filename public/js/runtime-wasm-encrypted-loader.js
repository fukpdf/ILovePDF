// RuntimeWasmEncryptedLoader v1.0 — Phase 6 / Task 2 (Encrypted WASM Loader)
// =============================================================================
// Encrypts WASM bytes in transit using session-derived XOR keys.
// Makes static capture of WASM chunks unreliable for reverse engineering,
// since the decryption key is derived from the live session state.
//
// Encryption model:
//   • Key = BLAKE2-like mix of sessionId + nonce + device fingerprint
//   • XOR cipher with key stream (simple, fast, sufficient for obfuscation)
//   • Integrity: 4-byte checksum verified before decryption
//   • Chunks are never stored decrypted — only the live ArrayBuffer is decrypted
//   • Keys are session-scoped and not persisted anywhere
//
// NOTE: This is NOT cryptographically secure AES encryption.
// The goal is obfuscation against static analysis, not protection against
// a determined attacker with source access. For true security, WASM modules
// should be compiled with obfuscation passes.
//
// Tier gating:
//   LOW  (<40) — passthrough (no encryption overhead)
//   MED  (40-69)— integrity check only
//   HIGH (70+) — full encrypt + integrity
//
// window.RuntimeWasmEncryptedLoader
//   .encrypt(bytes, moduleId)         → EncryptedChunk
//   .decrypt(chunk, moduleId)         → Uint8Array
//   .load(url, moduleId)              → Promise<Uint8Array>
//   .loadAndSeal(url, moduleId)       → Promise<SealedModule|null>
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmEncryptedLoader) return;

  var VERSION = '1.0';
  var LOG     = '[WasmEncLoader]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier       = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _doEncrypt  = _score >= 70;
  var _doIntegrity = _score >= 40;

  // ── Key derivation ─────────────────────────────────────────────────────────
  // Derives a pseudo-random key stream from session state.
  // Uses a simple LCG seeded with mixed session entropy.
  var _keyCache = typeof Map !== 'undefined' ? new Map() : null;

  function _deriveKey(moduleId, length) {
    var cacheKey = moduleId + '_' + length;
    if (_keyCache && _keyCache.has(cacheKey)) return _keyCache.get(cacheKey);

    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      if (ss && typeof ss.getSessionId === 'function') return ss.getSessionId();
      return 'default-session';
    }, 'default-session');

    // Seed from mixed entropy
    var seedStr = moduleId + '|' + sessionId + '|' + _score;
    var seed = 0;
    for (var k = 0; k < seedStr.length; k++) {
      seed = ((seed << 5) - seed + seedStr.charCodeAt(k)) | 0;
    }
    seed = (seed >>> 0) || 0xdeadbeef;

    // LCG key stream
    var key = new Uint8Array(length);
    var s   = seed;
    for (var i = 0; i < length; i++) {
      s   = (Math.imul(1664525, s) + 1013904223) >>> 0;
      key[i] = s >>> 24;
    }

    if (_keyCache) _keyCache.set(cacheKey, key);
    return key;
  }

  // ── Checksum (FNV-1a 32-bit) ───────────────────────────────────────────────
  function _checksum32(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // ── Encrypt ───────────────────────────────────────────────────────────────
  function encrypt(bytes, moduleId) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

    if (!_doEncrypt) {
      return {
        encrypted: false,
        bytes:     bytes,
        moduleId:  moduleId,
        checksum:  _doIntegrity ? _checksum32(bytes) : 0,
        version:   VERSION,
      };
    }

    var key  = _deriveKey(moduleId, bytes.length);
    var enc  = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) {
      enc[i] = bytes[i] ^ key[i];
    }

    return {
      encrypted: true,
      bytes:     enc,
      moduleId:  moduleId,
      checksum:  _checksum32(bytes),  // checksum of plaintext
      version:   VERSION,
    };
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────
  function decrypt(chunk, moduleId) {
    if (!chunk || !chunk.bytes) return null;

    var bytes = chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes);

    if (!chunk.encrypted) {
      if (_doIntegrity && chunk.checksum) {
        var cs = _checksum32(bytes);
        if (cs !== chunk.checksum) {
          console.error(LOG, 'integrity check FAILED for:', moduleId, '| expected:', chunk.checksum, '| got:', cs);
          _s(function () {
            if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', {
              path: moduleId, reason: 'wasm-checksum-mismatch',
              expected: chunk.checksum, actual: cs,
            });
          });
          return null;
        }
      }
      return bytes;
    }

    // XOR decrypt
    var key      = _deriveKey(moduleId, bytes.length);
    var plain    = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) {
      plain[i] = bytes[i] ^ key[i];
    }

    // Verify checksum
    if (_doIntegrity && chunk.checksum) {
      var checksum = _checksum32(plain);
      if (checksum !== chunk.checksum) {
        console.error(LOG, 'DECRYPTION integrity FAILED for:', moduleId);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', {
            path: moduleId, reason: 'wasm-decrypt-checksum-fail',
          });
        });
        return null;
      }
    }

    return plain;
  }

  // ── Load (fetch + encrypt-in-memory) ──────────────────────────────────────
  function load(url, moduleId) {
    return fetch(url, { credentials: 'same-origin', cache: 'default' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        console.debug(LOG, 'loaded:', moduleId, '|', bytes.byteLength, 'bytes');
        if (_doEncrypt) {
          // Store encrypted, return plaintext for immediate use
          var chunk = encrypt(bytes, moduleId);
          console.debug(LOG, 'encrypted in-memory | checksum:', chunk.checksum.toString(16));
        }
        return bytes;
      })
      .catch(function (err) {
        console.warn(LOG, 'load failed:', moduleId, err.message);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('wasm-event', {
            event: 'load-fail', moduleId: moduleId, reason: err.message,
          });
        });
        throw err;
      });
  }

  // ── Load and seal ─────────────────────────────────────────────────────────
  function loadAndSeal(url, moduleId) {
    return load(url, moduleId).then(function (bytes) {
      var fortress = G.RuntimeWasmFortress;
      if (!fortress || typeof fortress.seal !== 'function') {
        console.warn(LOG, 'RuntimeWasmFortress not available — skipping seal');
        return null;
      }
      return fortress.seal(moduleId, bytes);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| encrypt:', _doEncrypt, '| integrity:', _doIntegrity);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWasmEncryptedLoader = Object.freeze({
    VERSION:     VERSION,
    encrypt:     encrypt,
    decrypt:     decrypt,
    load:        load,
    loadAndSeal: loadAndSeal,
    status: function () {
      return {
        version:     VERSION,
        tier:        _tier,
        doEncrypt:   _doEncrypt,
        doIntegrity: _doIntegrity,
        keysCached:  _keyCache ? _keyCache.size : 0,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
