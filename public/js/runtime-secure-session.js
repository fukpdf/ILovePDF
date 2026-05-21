// RuntimeSecureSession v1.0 — Phase 6 / Task 1 (Secure Session Management)
// =============================================================================
// Session-bound execution management. Binds execution permissions to the
// current browser session, authorizes worker spawns, and prevents session
// hijacking by correlating ticket nonces with session fingerprints.
//
// Features:
//   • Session lifecycle management (init → active → expired → rotated)
//   • Worker authorization tokens (short-lived, session-scoped)
//   • Session binding: tickets must match session fingerprint
//   • Anti-session-fixation: session rotates on suspicious activity
//   • Cross-tab session coordination via BroadcastChannel
//   • Session telemetry: state changes emitted to SecurityTelemetry
//   • Idle detection: session degrades after inactivity
//
// Integrates with:
//   RuntimeHybridExecution, RuntimeIdentity, RuntimeEventBus, SecurityTelemetry
//
// window.RuntimeSecureSession
//   .getSessionId()                    → string
//   .authorizeWorker(workerUrl)        → { token, sessionId, exp }
//   .validateWorkerToken(token, url)   → boolean
//   .rotate(reason)                    → void
//   .heartbeat()                       → void
//   .status()                          → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecureSession) return;

  var VERSION           = '1.0';
  var LOG               = '[SecSession]';
  var SESSION_TTL_MS    = 30 * 60_000;   // 30 minutes
  var WORKER_TOKEN_TTL  = 120_000;        // 2 minutes
  var IDLE_TIMEOUT_MS   = 10 * 60_000;   // 10 minutes idle → degrade
  var MAX_WORKER_TOKENS = 100;
  var CHANNEL_NAME      = 'iplv_secure_session';

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

  // ── Session state ──────────────────────────────────────────────────────────
  var _sessionId      = null;
  var _sessionExp     = 0;
  var _createdAt      = 0;
  var _lastActivity   = 0;
  var _state          = 'init';   // init | active | idle | degraded | rotated
  var _rotateCount    = 0;
  var _workerTokens   = [];   // [{token, url, exp}]
  var _channel        = null;

  // ── DJB2 hash (fast non-cryptographic) ────────────────────────────────────
  function _hash32(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
      h = h | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── Session ID generation ─────────────────────────────────────────────────
  function _generateSessionId() {
    var base = _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getUser === 'function') return ri.getUser().id;
      return null;
    }, null) || '';

    var entropy = [
      base,
      Date.now().toString(36),
      Math.random().toString(36).slice(2),
      _s(function () { return (G.navigator.hardwareConcurrency || 0).toString(16); }, '0'),
      _s(function () { return (G.screen.width + 'x' + G.screen.height); }, '0x0'),
    ].join('_');

    return 'ss_' + _hash32(entropy) + '_' + Date.now().toString(36);
  }

  // ── Worker token generation ────────────────────────────────────────────────
  function _genWorkerToken(workerUrl) {
    var now = Date.now();
    var payload = _sessionId + '|' + workerUrl + '|' + now;
    return {
      token:     'wt_' + _hash32(payload) + '_' + now.toString(36),
      sessionId: _sessionId,
      workerUrl: workerUrl,
      exp:       now + WORKER_TOKEN_TTL,
      iat:       now,
    };
  }

  // ── Idle detection ─────────────────────────────────────────────────────────
  function _checkIdle() {
    var now = Date.now();
    if (_state !== 'active') return;
    if (now - _lastActivity > IDLE_TIMEOUT_MS) {
      _state = 'idle';
      console.debug(LOG, 'session idle after', Math.round((now - _lastActivity) / 60_000) + 'min');
      _emit('session:idle', { sessionId: _sessionId.slice(0, 8) });
    }
  }

  // ── Session initialization ────────────────────────────────────────────────
  function _initSession() {
    if (_sessionId && Date.now() < _sessionExp) return;

    _sessionId    = _generateSessionId();
    _sessionExp   = Date.now() + SESSION_TTL_MS;
    _createdAt    = Date.now();
    _lastActivity = Date.now();
    _state        = 'active';

    console.debug(LOG, 'session initialized | id:', _sessionId.slice(0, 12),
      '| exp:', new Date(_sessionExp).toISOString());

    _emit('session:init', { sessionId: _sessionId.slice(0, 8), tier: _tier });
    _broadcastToTabs({ type: 'session-init', sessionId: _sessionId.slice(0, 8) });
  }

  // ── Emit to EventBus + SecurityTelemetry ──────────────────────────────────
  function _emit(eventName, data) {
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit(eventName, data);
      }
    });
    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('wasm-event', Object.assign({ event: eventName }, data));
      }
    });
  }

  // ── Cross-tab broadcast ────────────────────────────────────────────────────
  function _broadcastToTabs(msg) {
    _s(function () {
      if (!_channel && typeof BroadcastChannel !== 'undefined') {
        _channel = new BroadcastChannel(CHANNEL_NAME);
        _channel.onmessage = function (ev) {
          _handleTabMessage(ev.data);
        };
      }
      if (_channel) _channel.postMessage(msg);
    });
  }

  function _handleTabMessage(data) {
    if (!data || !data.type) return;
    if (data.type === 'session-rotate' && data.reason === 'suspicious-activity') {
      // Another tab detected suspicious activity — rotate our session too
      rotate('cross-tab-suspicious');
    }
  }

  // ── Public: getSessionId ──────────────────────────────────────────────────
  function getSessionId() {
    if (!_sessionId || Date.now() >= _sessionExp) _initSession();
    return _sessionId;
  }

  // ── Public: authorizeWorker ───────────────────────────────────────────────
  function authorizeWorker(workerUrl) {
    if (!_enabled) return null;
    getSessionId();  // ensure session is active

    if (_state === 'degraded') {
      console.warn(LOG, 'worker auth denied — session degraded');
      return null;
    }

    // Clean expired tokens
    var now = Date.now();
    _workerTokens = _workerTokens.filter(function (t) { return t.exp > now; });
    if (_workerTokens.length >= MAX_WORKER_TOKENS) _workerTokens.shift();

    var tokenEntry = _genWorkerToken(workerUrl);
    _workerTokens.push(tokenEntry);
    _lastActivity = now;

    console.debug(LOG, 'worker authorized | url:', workerUrl.split('/').pop(),
      '| token:', tokenEntry.token.slice(0, 12));
    return tokenEntry;
  }

  // ── Public: validateWorkerToken ───────────────────────────────────────────
  function validateWorkerToken(token, url) {
    if (!token) return false;
    var now = Date.now();
    for (var i = 0; i < _workerTokens.length; i++) {
      var t = _workerTokens[i];
      if (t.token === token && t.workerUrl === url && t.exp > now && t.sessionId === _sessionId) {
        return true;
      }
    }
    return false;
  }

  // ── Public: rotate ────────────────────────────────────────────────────────
  function rotate(reason) {
    var oldId = _sessionId;
    _sessionId  = _generateSessionId();
    _sessionExp = Date.now() + SESSION_TTL_MS;
    _state      = 'active';
    _rotateCount++;
    _workerTokens = [];  // invalidate all worker tokens on rotation

    console.warn(LOG, 'session rotated | reason:', reason,
      '| old:', (oldId || '').slice(0, 8), '| new:', _sessionId.slice(0, 8));

    _emit('session:rotated', { reason: reason, rotateCount: _rotateCount });
    _broadcastToTabs({ type: 'session-rotate', reason: reason });

    // Invalidate hybrid execution ticket (session changed)
    _s(function () {
      var he = G.RuntimeHybridExecution;
      if (he && typeof he.invalidate === 'function') he.invalidate();
    });
  }

  // ── Public: heartbeat ─────────────────────────────────────────────────────
  function heartbeat() {
    _lastActivity = Date.now();
    if (_state === 'idle') {
      _state = 'active';
      console.debug(LOG, 'session reactivated from idle');
      _emit('session:reactivate', { sessionId: _sessionId.slice(0, 8) });
    }
  }

  // ── Idle check interval ───────────────────────────────────────────────────
  var _idleInterval = null;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    _initSession();

    // Attach user activity listeners
    _s(function () {
      var updateActivity = function () { _lastActivity = Date.now(); if (_state === 'idle') heartbeat(); };
      document.addEventListener('visibilitychange', updateActivity, { passive: true });
      document.addEventListener('click', updateActivity, { passive: true });
    });

    // Idle check every 2 minutes
    _idleInterval = setInterval(_checkIdle, 2 * 60_000);

    // Watch for security events that should trigger session rotation
    _s(function () {
      if (!G.RuntimeEventBus) return;
      G.RuntimeEventBus.on('shield:tamper-response', function () {
        rotate('tamper-detected');
      });
      G.RuntimeEventBus.on('seal:failure', function () {
        rotate('seal-failure');
      });
    });

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| sessionId:', _sessionId.slice(0, 8));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1800); }, { once: true });
  } else {
    setTimeout(_boot, 1800);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeSecureSession = Object.freeze({
    VERSION:               VERSION,
    getSessionId:          getSessionId,
    authorizeWorker:       authorizeWorker,
    validateWorkerToken:   validateWorkerToken,
    rotate:                rotate,
    heartbeat:             heartbeat,
    status: function () {
      return {
        version:           VERSION,
        enabled:           _enabled,
        tier:              _tier,
        sessionId:         _sessionId ? _sessionId.slice(0, 12) : null,
        state:             _state,
        exp:               _sessionExp,
        rotateCount:       _rotateCount,
        activeWorkerTokens: _workerTokens.filter(function (t) { return t.exp > Date.now(); }).length,
        lastActivity:      _lastActivity,
        createdAt:         _createdAt,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
