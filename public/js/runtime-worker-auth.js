// RuntimeWorkerAuth v1.0 — Phase 7 / Section 2 (Worker Authentication)
// =============================================================================
// Signed worker identity tokens. Every spawned worker receives a short-lived
// signed token that proves it was spawned by this session and not injected.
//
// Token structure (client-side only, not server-signed):
//   { workerId, sessionId, url, spawnTs, exp, nonce, sig }
//   sig = DJB2(workerId + sessionId + url + exp + nonce + SALT)
//
// Note: This is a client-side defense layer. Server-verified tokens are
// handled by RuntimeSecureSession.authorizeWorker(). This layer adds
// additional identity binding for worker-to-main-thread trust.
//
// window.RuntimeWorkerAuth
//   .issueToken(workerId, url)           → WorkerToken
//   .verifyToken(token)                  → boolean
//   .revokeToken(workerId)               → void
//   .getToken(workerId)                  → WorkerToken|null
//   .isAuthenticated(workerId)           → boolean
//   .status()                            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerAuth) return;

  var VERSION    = '1.0';
  var LOG        = '[WorkerAuth]';
  var TOKEN_TTL  = 8 * 60_000;  // 8 minutes

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

  // ── SALT (session-scoped, not persisted) ───────────────────────────────────
  var _salt = 'wauth_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);

  // ── DJB2-based client signing ──────────────────────────────────────────────
  function _sign(data) {
    var str = data + _salt;
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── Token store ────────────────────────────────────────────────────────────
  var _tokens  = typeof Map !== 'undefined' ? new Map() : null;   // workerId → token
  var _revoked = [];   // revoked token nonces

  function _getSessionId() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : null;
    }, null) || 'anon';
  }

  // ── Issue token ───────────────────────────────────────────────────────────
  function issueToken(workerId, url) {
    if (!_tokens) return null;

    var sessionId = _getSessionId();
    var spawnTs   = Date.now();
    var exp       = spawnTs + TOKEN_TTL;
    var nonce     = Math.random().toString(36).slice(2, 10);
    var payload   = workerId + '|' + sessionId + '|' + url + '|' + exp + '|' + nonce;
    var sig       = _sign(payload);

    var token = {
      workerId:  workerId,
      sessionId: sessionId,
      url:       url,
      spawnTs:   spawnTs,
      exp:       exp,
      nonce:     nonce,
      sig:       sig,
    };

    _tokens.set(workerId, token);
    console.debug(LOG, 'token issued for worker:', workerId);
    return token;
  }

  // ── Verify token ──────────────────────────────────────────────────────────
  function verifyToken(token) {
    if (!token || typeof token !== 'object') return false;

    // Expiry check
    if (token.exp < Date.now()) return false;

    // Revocation check
    if (_revoked.indexOf(token.nonce) !== -1) return false;

    // Signature check
    var payload = token.workerId + '|' + token.sessionId + '|' + token.url +
      '|' + token.exp + '|' + token.nonce;
    var expected = _sign(payload);

    return expected === token.sig;
  }

  // ── Revoke token ──────────────────────────────────────────────────────────
  function revokeToken(workerId) {
    if (!_tokens || !_tokens.has(workerId)) return;
    var token = _tokens.get(workerId);
    if (token && token.nonce) {
      _revoked.push(token.nonce);
      if (_revoked.length > 500) _revoked.shift();
    }
    _tokens.delete(workerId);
    console.debug(LOG, 'token revoked for worker:', workerId);
  }

  function getToken(workerId) {
    if (!_tokens) return null;
    var t = _tokens.get(workerId);
    if (!t) return null;
    if (t.exp < Date.now()) {
      _tokens.delete(workerId);
      return null;
    }
    return Object.assign({}, t);
  }

  function isAuthenticated(workerId) {
    var token = getToken(workerId);
    return token !== null && verifyToken(token);
  }

  // ── Subscribe to worker events ────────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:spawned', function (data) {
        if (data && data.workerId) {
          var token = issueToken(data.workerId, data.url || '');
          if (token) {
            // Register with mesh
            _s(function () {
              var mesh = G.RuntimeWorkerMesh;
              if (mesh && typeof mesh.register === 'function') {
                mesh.register(data.workerId, data.worker, data.url);
              }
            });
          }
        }
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId) revokeToken(data.workerId);
      });

      eb.on('mesh:worker-quarantined', function (data) {
        if (data && data.workerId) revokeToken(data.workerId);
      });

      // Session rotation → revoke all worker tokens
      eb.on('session:rotated', function () {
        if (!_tokens) return;
        var ids = [];
        _tokens.forEach(function (_, id) { ids.push(id); });
        ids.forEach(function (id) { revokeToken(id); });
        console.info(LOG, 'all worker tokens revoked on session rotation');
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerAuth = Object.freeze({
    VERSION:         VERSION,
    issueToken:      issueToken,
    verifyToken:     verifyToken,
    revokeToken:     revokeToken,
    getToken:        getToken,
    isAuthenticated: isAuthenticated,
    status: function () {
      var active = _tokens ? _tokens.size : 0;
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        activeTokens:  active,
        revokedCount:  _revoked.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
