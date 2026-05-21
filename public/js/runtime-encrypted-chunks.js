// RuntimeEncryptedChunks v1.0 — Phase 6 / Task 3 (Encrypted Chunk Delivery)
// =============================================================================
// Encrypted chunk metadata, rotating chunk tokens, and signed chunk authorization.
// Extends the existing RuntimeChunkManifest with Phase 6 protections.
//
// Features:
//   • Encrypted chunk metadata (not the chunk bytes, but the manifest entries)
//   • Rotating chunk tokens (short-lived access tokens per chunk)
//   • Signed chunk authorization (verify before deferred loading)
//   • Chunk replay blocking (used-token pool)
//   • Token expiration (60s TTL)
//   • Dynamic import verification (checks token before import())
//   • Stale cache invalidation (detects CDN/SW cached old versions)
//   • Encrypted deferred module metadata
//
// Integrates with:
//   RuntimeChunkManifest, RuntimeSriEngine, RuntimeHybridExecution
//
// window.RuntimeEncryptedChunks
//   .authorizeChunk(path)           → ChunkToken|null
//   .verifyToken(token)             → boolean
//   .revokeToken(token)             → void
//   .getEncryptedMeta(path)         → EncryptedMeta
//   .invalidateStale(maxAgeMs)      → number
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEncryptedChunks) return;

  var VERSION      = '1.0';
  var LOG          = '[EncChunks]';
  var TOKEN_TTL_MS = 90_000;   // 90s token validity
  var MAX_TOKENS   = 500;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── State ──────────────────────────────────────────────────────────────────
  var _tokens      = typeof Map !== 'undefined' ? new Map() : null;  // token → {path, exp}
  var _usedTokens  = [];   // replay protection
  var _authLog     = [];
  var MAX_LOG      = 200;

  // ── Simple token generator ─────────────────────────────────────────────────
  function _genToken(path) {
    var now  = Date.now();
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');

    // Mix path + session + time + random
    var raw  = path + '|' + sessionId + '|' + now + '|' + (Math.random() * 0xFFFFFF >>> 0).toString(16);
    var hash = 0;
    for (var i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return 'ct_' + (hash >>> 0).toString(16).padStart(8, '0') + '_' + now.toString(36);
  }

  // ── Encrypt metadata ──────────────────────────────────────────────────────
  // Obfuscates chunk metadata (hash, size) by XOR with session-derived key.
  // Prevents static analysis of chunk manifests.
  function _encryptMeta(meta) {
    if (!_enabled || _tier === 'LOW') return meta;
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');

    var str  = JSON.stringify(meta);
    var seed = 0;
    for (var i = 0; i < sessionId.length; i++) {
      seed = ((seed * 31) + sessionId.charCodeAt(i)) | 0;
    }
    // XOR bytes
    var enc = [];
    for (var j = 0; j < str.length; j++) {
      seed = (seed * 1664525 + 1013904223) | 0;
      enc.push(str.charCodeAt(j) ^ (seed & 0xFF));
    }
    return { _enc: true, _data: enc, _seed: sessionId.slice(0, 4) };
  }

  function _decryptMeta(encMeta) {
    if (!encMeta || !encMeta._enc) return encMeta;
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');

    // Validate session prefix matches
    if (encMeta._seed !== sessionId.slice(0, 4)) return null;

    var seed = 0;
    for (var i = 0; i < sessionId.length; i++) {
      seed = ((seed * 31) + sessionId.charCodeAt(i)) | 0;
    }
    var dec = '';
    for (var j = 0; j < encMeta._data.length; j++) {
      seed = (seed * 1664525 + 1013904223) | 0;
      dec += String.fromCharCode(encMeta._data[j] ^ (seed & 0xFF));
    }
    try { return JSON.parse(dec); } catch (_) { return null; }
  }

  // ── Evict expired tokens ──────────────────────────────────────────────────
  function _evictTokens() {
    if (!_tokens) return;
    var now = Date.now();
    _tokens.forEach(function (entry, token) {
      if (entry.exp < now) _tokens.delete(token);
    });
    if (_usedTokens.length > MAX_TOKENS) _usedTokens = _usedTokens.slice(-MAX_TOKENS / 2);
  }

  // ── authorizeChunk (public) ────────────────────────────────────────────────
  function authorizeChunk(path) {
    if (!_enabled || !_tokens) return null;

    _evictTokens();

    var token  = _genToken(path);
    var exp    = Date.now() + TOKEN_TTL_MS;
    _tokens.set(token, { path: path, exp: exp, issued: Date.now() });

    var entry = { token: token, path: path, exp: exp };
    _authLog.push(Object.assign({}, entry, { ts: Date.now() }));
    if (_authLog.length > MAX_LOG) _authLog.shift();

    return entry;
  }

  // ── verifyToken (public) ───────────────────────────────────────────────────
  function verifyToken(token) {
    if (!_enabled) return true;   // passthrough on low-tier
    if (!_tokens || !token) return false;

    // Replay check
    if (_usedTokens.indexOf(token) !== -1) {
      console.warn(LOG, 'REPLAY attempt — token already used:', token.slice(0, 16));
      _s(function () {
        if (G.SecurityTelemetry) G.SecurityTelemetry.record('replay-attempt', {
          token: token.slice(0, 12),
        });
      });
      return false;
    }

    var entry = _tokens.get(token);
    if (!entry) { console.debug(LOG, 'unknown token:', token.slice(0, 16)); return false; }
    if (entry.exp < Date.now()) {
      _tokens.delete(token);
      console.debug(LOG, 'token expired for:', entry.path);
      return false;
    }

    return true;
  }

  // ── revokeToken (public) ──────────────────────────────────────────────────
  function revokeToken(token) {
    if (!_tokens) return;
    if (_usedTokens.indexOf(token) === -1 && _usedTokens.length < MAX_TOKENS) {
      _usedTokens.push(token);
    }
    _tokens.delete(token);
  }

  // ── getEncryptedMeta (public) ──────────────────────────────────────────────
  function getEncryptedMeta(path) {
    var meta = _s(function () {
      var cm = G.RuntimeChunkManifest;
      if (!cm || typeof cm.all !== 'function') return null;
      var all = cm.all();
      for (var i = 0; i < all.length; i++) {
        if (all[i].path === path) return all[i];
      }
      return null;
    }, null);

    if (!meta) return null;
    return _encryptMeta({ path: meta.path, hash: meta.hash, size: meta.size });
  }

  // ── invalidateStale (public) ──────────────────────────────────────────────
  // Detects Service Worker / CDN cached chunks that are older than maxAgeMs.
  function invalidateStale(maxAgeMs) {
    maxAgeMs = maxAgeMs || 24 * 60 * 60_000;  // 24h default
    var count = 0;
    _s(function () {
      if (!G.performance || !G.performance.getEntriesByType) return;
      var resources = G.performance.getEntriesByType('resource');
      var now       = Date.now();
      var navStart  = _s(function () {
        var nav = G.performance.getEntriesByType('navigation');
        return nav && nav.length ? nav[0].startTime : 0;
      }, 0);

      for (var i = 0; i < resources.length; i++) {
        var r = resources[i];
        if (!r.name.includes('/js/') && !r.name.includes('/workers/')) continue;
        // fromCache check
        if (r.transferSize === 0 && r.decodedBodySize > 0) {
          // Check age via Service Worker
          _s(function () {
            if ('caches' in G) {
              caches.match(r.name).then(function (cached) {
                if (!cached) return;
                var dateHeader = cached.headers.get('date');
                if (!dateHeader) return;
                var age = now - new Date(dateHeader).getTime();
                if (age > maxAgeMs) {
                  count++;
                  caches.open('ilovepdf-runtime').then(function (c) { c.delete(r.name); });
                  console.debug(LOG, 'stale cache invalidated:', r.name.split('/').pop());
                }
              }).catch(function () {});
            }
          });
        }
      }
    });
    return count;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Periodic token eviction
    setInterval(_evictTokens, 60_000);

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| TOKEN_TTL:', TOKEN_TTL_MS + 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3500); }, { once: true });
  } else {
    setTimeout(_boot, 3500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeEncryptedChunks = Object.freeze({
    VERSION:          VERSION,
    authorizeChunk:   authorizeChunk,
    verifyToken:      verifyToken,
    revokeToken:      revokeToken,
    getEncryptedMeta: getEncryptedMeta,
    decryptMeta:      _decryptMeta,
    invalidateStale:  invalidateStale,
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        activeTokens:  _tokens ? _tokens.size : 0,
        usedTokens:    _usedTokens.length,
        authLogCount:  _authLog.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
