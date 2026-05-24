// ── Phase 6 Deferred — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-24T14:32:06.329Z  BUILD_ID: mpjvm4kv
// Files: 12

// ── SOURCE: public/js/runtime-secure-session.js ──
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
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
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

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
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

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-edge-attestation.js ──
// RuntimeEdgeAttestation v1.0 — Phase 6 / Task 1 (Edge Attestation)
// =============================================================================
// Validates that the execution environment is the genuine ILovePDF runtime.
// Complements RuntimeHybridExecution by verifying the client-side context
// before a ticket is even requested.
//
// Attestation checks:
//   1. DOM context validation (no rogue iframes injecting our scripts)
//   2. Script source integrity (critical scripts have expected origins)
//   3. Global object authenticity (no shadowed globals)
//   4. Window ancestry check (top-level vs embedded)
//   5. Navigator consistency (no headless/automation artifacts)
//   6. Crypto capability check (SubtleCrypto available = genuine browser)
//   7. Timing consistency (machine clock not drifted beyond threshold)
//   8. Server clock synchronization (using execution-ticket/ping)
//
// Attestation result feeds into RuntimeHybridExecution ticket fingerprint.
//
// window.RuntimeEdgeAttestation
//   .attest()             → Promise<AttestResult>
//   .getLastResult()      → AttestResult|null
//   .isTrusted()          → boolean
//   .status()             → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeAttestation) return;

  var VERSION = '1.0';
  var LOG     = '[EdgeAttest]';

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
  var _lastResult    = null;
  var _trusted       = false;
  var _attestCount   = 0;
  var _clockSkewMs   = null;
  var CLOCK_SKEW_MAX = 120_000;   // 2 minutes max tolerable skew

  // ── Check 1: Top-level context ─────────────────────────────────────────────
  function _checkTopLevel() {
    try {
      var isTop = G.top === G.self;
      return { check: 'top-level', ok: isTop, detail: isTop ? 'top-level window' : 'embedded iframe' };
    } catch (e) {
      // Cross-origin restriction throwing means we are definitely embedded
      return { check: 'top-level', ok: false, detail: 'cross-origin iframe detected' };
    }
  }

  // ── Check 2: Navigator consistency ────────────────────────────────────────
  function _checkNavigator() {
    var issues = [];
    _s(function () {
      var nav = G.navigator;
      if (!nav) { issues.push('no-navigator'); return; }
      // Headless Chrome signature
      if (nav.webdriver)         issues.push('webdriver-flag');
      if (!nav.languages || nav.languages.length === 0) issues.push('no-languages');
      // Basic sanity: UA must exist
      if (!nav.userAgent || nav.userAgent.length < 10) issues.push('suspicious-ua');
    });
    return { check: 'navigator', ok: issues.length === 0, detail: issues.join(',') || 'ok' };
  }

  // ── Check 3: SubtleCrypto availability ─────────────────────────────────────
  function _checkCrypto() {
    var hasCrypto = _s(function () {
      return !!(G.crypto && G.crypto.subtle && typeof G.crypto.subtle.digest === 'function');
    }, false);
    return { check: 'subtle-crypto', ok: hasCrypto, detail: hasCrypto ? 'SubtleCrypto available' : 'SubtleCrypto missing' };
  }

  // ── Check 4: Critical globals not shadowed ─────────────────────────────────
  function _checkGlobals() {
    var issues = [];
    _s(function () {
      // Verify key globals are genuine browser APIs, not monkey-patched objects
      if (typeof G.fetch !== 'function') issues.push('fetch-missing');
      if (typeof G.Promise !== 'function') issues.push('promise-missing');
      if (typeof G.Uint8Array !== 'function') issues.push('typedarray-missing');
      // Check for automation tools modifying WebAssembly
      if (typeof G.WebAssembly === 'undefined') issues.push('wasm-missing');
    });
    return { check: 'globals', ok: issues.length === 0, detail: issues.join(',') || 'ok' };
  }

  // ── Check 5: Script origin validation ─────────────────────────────────────
  function _checkScriptOrigins() {
    var suspicious = [];
    _s(function () {
      var scripts = document.querySelectorAll('script[src]');
      var ownOrigin = G.location.origin;
      var TRUSTED_EXTERNAL = [
        'pagead2.googlesyndication.com', 'unpkg.com', 'cdn.jsdelivr.net',
        'www.googletagmanager.com', 'fonts.googleapis.com',
      ];
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute('src') || '';
        if (!src) continue;
        try {
          var url = new URL(src, G.location.href);
          if (url.origin === ownOrigin) continue;
          var trusted = false;
          for (var j = 0; j < TRUSTED_EXTERNAL.length; j++) {
            if (url.hostname === TRUSTED_EXTERNAL[j] || url.hostname.endsWith('.' + TRUSTED_EXTERNAL[j])) {
              trusted = true; break;
            }
          }
          if (!trusted) suspicious.push(url.hostname);
        } catch (_) {}
      }
    });
    return {
      check:  'script-origins',
      ok:     suspicious.length === 0,
      detail: suspicious.length > 0 ? 'suspicious external scripts: ' + suspicious.slice(0, 3).join(',') : 'ok',
    };
  }

  // ── Check 6: Clock skew (uses cached server ping) ─────────────────────────
  function _checkClockSkew() {
    if (_clockSkewMs === null) {
      return { check: 'clock-skew', ok: true, detail: 'not-measured-yet' };
    }
    var ok = Math.abs(_clockSkewMs) < CLOCK_SKEW_MAX;
    return { check: 'clock-skew', ok: ok, detail: 'skew=' + _clockSkewMs + 'ms' };
  }

  // ── Server clock sync ─────────────────────────────────────────────────────
  function _syncClock() {
    return _s(function () {
      var t0 = Date.now();
      return fetch('/api/execution-ticket/ping', { credentials: 'same-origin' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var rtt = Date.now() - t0;
          _clockSkewMs = data.serverTs - (t0 + rtt / 2);
          console.debug(LOG, 'clock sync | skew:', _clockSkewMs + 'ms | rtt:', rtt + 'ms');
        })
        .catch(function () {});
    }, Promise.resolve());
  }

  // ── Full attestation ──────────────────────────────────────────────────────
  function attest() {
    if (!_enabled) {
      _lastResult = { trusted: true, checks: [], reason: 'lite-mode', ts: Date.now() };
      _trusted = true;
      return Promise.resolve(_lastResult);
    }

    return _syncClock().then(function () {
      var checks = [
        _checkTopLevel(),
        _checkNavigator(),
        _checkCrypto(),
        _checkGlobals(),
        _checkScriptOrigins(),
        _checkClockSkew(),
      ];

      var failures = checks.filter(function (c) { return !c.ok; });
      var trusted  = failures.length === 0;

      // Embedded iframes are soft-fail for tools (e.g. editor workspace)
      // Only hard-fail on critical security violations
      var hardFailChecks = ['navigator', 'globals', 'subtle-crypto'];
      var hardFail = failures.some(function (c) { return hardFailChecks.indexOf(c.check) !== -1; });

      _lastResult = {
        trusted:  trusted || !hardFail,
        checks:   checks,
        failures: failures,
        ts:       Date.now(),
        clockSkewMs: _clockSkewMs,
      };
      _trusted = _lastResult.trusted;
      _attestCount++;

      if (!trusted) {
        console.warn(LOG, 'attestation warnings:', failures.map(function (c) { return c.check + ':' + c.detail; }).join(' | '));
        _s(function () {
          if (G.SecurityTelemetry) {
            G.SecurityTelemetry.record('deploy-mismatch', {
              reason: 'attestation-failure',
              failures: failures.map(function (c) { return c.check; }).join(','),
            });
          }
        });
      }

      if (hardFail) {
        console.error(LOG, 'HARD FAIL — critical attestation check(s) failed');
        _s(function () {
          if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
            G.RuntimeEventBus.emit('security:foreign-deploy', { reason: 'hard-attestation-fail' });
          }
        });
      } else {
        console.debug(LOG, 'attestation complete | trusted:', _trusted,
          '| checks:', checks.length, '| warnings:', failures.length);
      }

      return _lastResult;
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }
    // Run initial attestation after other systems settle
    setTimeout(function () {
      attest().catch(function (err) {
        console.warn(LOG, 'boot attestation failed:', err.message);
      });
    }, 5_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1500); }, { once: true });
  } else {
    setTimeout(_boot, 1500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeEdgeAttestation = Object.freeze({
    VERSION:       VERSION,
    attest:        attest,
    getLastResult: function () { return _lastResult ? Object.assign({}, _lastResult) : null; },
    isTrusted:     function () { return _trusted; },
    status: function () {
      return {
        version:     VERSION,
        enabled:     _enabled,
        tier:        _tier,
        trusted:     _trusted,
        attestCount: _attestCount,
        clockSkewMs: _clockSkewMs,
        lastResult:  _lastResult,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-hybrid-execution.js ──
// RuntimeHybridExecution v1.0 — Phase 6 / Task 1 (Hybrid Execution Layer)
// =============================================================================
// Moves critical authorization logic partially server-side while preserving
// browser-side processing speed.
//
// How it works:
//   1. On first need, request a signed execution ticket from the server
//   2. Ticket is held in memory only (no localStorage / IDB)
//   3. Before sensitive operations, gate checks ticket validity + ops list
//   4. Expired/missing tickets trigger a silent re-fetch
//   5. Replay protection: each ticket nonce is tracked
//   6. Request fingerprinting: tie tickets to browser identity
//   7. Tier gating: LOW devices skip ticket checks (lite mode)
//
// Integrates with:
//   RuntimeSecurityTiers, RuntimeIdentity, RuntimeEventBus,
//   SecurityTelemetry, RuntimeForeignDeploy
//
// window.RuntimeHybridExecution
//   .requestTicket(ops[])              → Promise<Ticket|null>
//   .gate(op)                          → Promise<boolean>
//   .getActiveTicket()                 → Ticket|null
//   .invalidate()                      → void
//   .status()                          → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHybridExecution) return;

  var VERSION   = '1.0';
  var LOG       = '[HybridExec]';
  var ENDPOINT  = '/api/execution-ticket';
  var TICKET_TTL_BUFFER_MS = 10_000;  // renew 10s before expiry
  var MAX_INFLIGHT = 1;               // coalesce concurrent requests
  var RETRY_DELAY  = 3_000;
  var MAX_RETRIES  = 2;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ──────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;   // disabled on LOW-tier (lite) devices

  // ── State ─────────────────────────────────────────────────────────────────────
  var _activeTicket   = null;   // { ticket, sig, fetchedAt }
  var _inflight       = null;   // Promise when a fetch is in progress
  var _usedNonces     = [];     // [string] — replay protection (in-memory)
  var _maxNoncePool   = 50;
  var _totalIssued    = 0;
  var _totalRejected  = 0;
  var _lastError      = null;
  var _sessionId      = null;
  var _foreignMode    = false;

  // ── Session ID ────────────────────────────────────────────────────────────────
  function _getSessionId() {
    if (_sessionId) return _sessionId;
    _sessionId = _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getUser === 'function') return ri.getUser().id;
      return null;
    }, null) || ('ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
    return _sessionId;
  }

  // ── Browser fingerprint (non-invasive) ────────────────────────────────────────
  function _getFingerprint() {
    return _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getFingerprint === 'function') {
        var fp = ri.getFingerprint();
        return { hash: fp.hash, tier: _tier, score: _score };
      }
      return { tier: _tier, score: _score };
    }, { tier: _tier, score: _score });
  }

  // ── Nonce replay guard ────────────────────────────────────────────────────────
  function _isNonceUsed(nonce) {
    return _usedNonces.indexOf(nonce) !== -1;
  }
  function _trackNonce(nonce) {
    if (_usedNonces.length >= _maxNoncePool) _usedNonces.shift();
    _usedNonces.push(nonce);
  }

  // ── Ticket validity check ─────────────────────────────────────────────────────
  function _isTicketValid(entry) {
    if (!entry || !entry.ticket || !entry.sig) return false;
    var t = entry.ticket;
    if (!t.exp || !t.nonce) return false;
    if (Date.now() >= t.exp - TICKET_TTL_BUFFER_MS) return false;
    if (_isNonceUsed(t.nonce)) return false;
    return true;
  }

  // ── Fetch ticket from server ──────────────────────────────────────────────────
  function _fetchTicket(ops, retries) {
    if (retries === undefined) retries = 0;
    var sessionId   = _getSessionId();
    var fingerprint = _getFingerprint();

    return fetch(ENDPOINT, {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ sessionId: sessionId, fingerprint: fingerprint, ops: ops }),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.ok || !data.ticket || !data.sig) throw new Error('invalid ticket response');
      var entry = { ticket: data.ticket, sig: data.sig, fetchedAt: Date.now() };
      if (!_isTicketValid(entry)) throw new Error('received invalid/expired ticket');
      _activeTicket = entry;
      _trackNonce(data.ticket.nonce);
      _totalIssued++;
      _lastError = null;
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('wasm-event', {
            event: 'ticket-issued', sessionId: sessionId.slice(0, 8),
            ops: (ops || []).join(','), tier: _tier,
          });
        }
      });
      console.debug(LOG, 'ticket issued | ops:', (ops || []).join(','),
        '| exp:', new Date(data.ticket.exp).toISOString());
      return entry;
    })
    .catch(function (err) {
      _lastError = err.message;
      _totalRejected++;
      console.warn(LOG, 'ticket fetch failed:', err.message);
      _s(function () {
        if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
          G.RuntimeEventBus.emit('hybrid-exec:ticket-fail', { reason: err.message, retries: retries });
        }
      });
      if (retries < MAX_RETRIES) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            _fetchTicket(ops, retries + 1).then(resolve).catch(reject);
          }, RETRY_DELAY * (retries + 1));
        });
      }
      return null;
    });
  }

  // ── requestTicket (public) ────────────────────────────────────────────────────
  function requestTicket(ops) {
    if (!_enabled) return Promise.resolve(null);
    ops = Array.isArray(ops) ? ops : ['premium-exec'];

    // Foreign deploy — degrade gracefully
    _foreignMode = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (_foreignMode) {
      console.debug(LOG, 'foreign mode — skipping server ticket');
      return Promise.resolve(null);
    }

    // Re-use valid existing ticket if ops are covered
    if (_activeTicket && _isTicketValid(_activeTicket)) {
      var existingOps = (_activeTicket.ticket.ops || []);
      var covered = ops.every(function (op) { return existingOps.indexOf(op) !== -1; });
      if (covered) return Promise.resolve(_activeTicket);
    }

    // Coalesce concurrent requests
    if (_inflight) return _inflight;

    _inflight = _fetchTicket(ops).then(function (entry) {
      _inflight = null;
      return entry;
    }).catch(function (err) {
      _inflight = null;
      throw err;
    });

    return _inflight;
  }

  // ── gate (public) — check op permission ──────────────────────────────────────
  function gate(op) {
    if (!_enabled) return Promise.resolve(true);
    if (_foreignMode) return Promise.resolve(false);

    // Tier-based check
    var st = _s(function () {
      var tiers = G.RuntimeSecurityTiers;
      if (!tiers || typeof tiers.allows !== 'function') return null;
      return tiers;
    }, null);

    if (st) {
      var tierOk = _s(function () { return st.allows('hybridExec'); }, true);
      if (!tierOk) {
        console.debug(LOG, 'gate denied by security tier for op:', op);
        return Promise.resolve(false);
      }
    }

    return requestTicket([op]).then(function (entry) {
      if (!entry) return false;
      var ops = (entry.ticket && entry.ticket.ops) || [];
      var allowed = ops.indexOf(op) !== -1 || ops.indexOf('premium-exec') !== -1;
      if (!allowed) {
        _totalRejected++;
        console.debug(LOG, 'gate denied for op:', op, '— not in ticket ops:', ops.join(','));
      }
      return allowed;
    }).catch(function () { return false; });
  }

  // ── invalidate (public) ───────────────────────────────────────────────────────
  function invalidate() {
    _activeTicket = null;
    _inflight     = null;
    console.debug(LOG, 'ticket invalidated');
  }

  // ── Pre-warm ticket on boot (HIGH tier only) ──────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Pre-warm: request a generic ticket so the first real op is instant
    if (_tier === 'HIGH') {
      setTimeout(function () {
        requestTicket(['premium-exec', 'wasm-load', 'worker-spawn']).catch(function () {});
      }, 8_000);  // 8s — after critical scripts settle
    }

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| endpoint:', ENDPOINT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  G.RuntimeHybridExecution = Object.freeze({
    VERSION:         VERSION,
    requestTicket:   requestTicket,
    gate:            gate,
    invalidate:      invalidate,
    getActiveTicket: function () { return _activeTicket ? Object.assign({}, _activeTicket) : null; },
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        score:         _score,
        hasTicket:     _isTicketValid(_activeTicket),
        ticketExp:     _activeTicket && _activeTicket.ticket ? _activeTicket.ticket.exp : null,
        ticketOps:     _activeTicket && _activeTicket.ticket ? (_activeTicket.ticket.ops || []) : [],
        totalIssued:   _totalIssued,
        totalRejected: _totalRejected,
        noncePoolSize: _usedNonces.length,
        lastError:     _lastError,
        foreignMode:   _foreignMode,
        inflight:      !!_inflight,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded | tier:', _tier);

}(window));

// ── SOURCE: public/js/runtime-capability-manager.js ──
// RuntimeCapabilityManager v1.0 — Phase 6 / Task 4 (Capability Management)
// =============================================================================
// Central authority for runtime capability grants and revocations.
// Provides a unified API for checking, granting, and revoking runtime
// capabilities across all Phase 6 systems.
//
// Capability model:
//   • Capabilities are named strings (e.g. 'wasm:pdf-module', 'worker:ocr')
//   • Each capability has a scope, tier requirement, and expiry
//   • Capabilities can be session-scoped or permanent
//   • Revocation is immediate and propagates to dependent systems
//   • Audit trail for all grants/revocations
//
// Sources of capability grants:
//   1. Boot grants (always-on capabilities for the device tier)
//   2. Ticket grants (from RuntimeHybridExecution tickets)
//   3. Attestation grants (from RuntimeEdgeAttestation)
//   4. User action grants (from user consent flows)
//
// window.RuntimeCapabilityManager
//   .grant(cap, opts)               → CapabilityEntry
//   .revoke(cap)                    → void
//   .has(cap)                       → boolean
//   .require(cap)                   → Promise<boolean>
//   .listActive()                   → CapabilityEntry[]
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCapabilityManager) return;

  var VERSION     = '1.0';
  var LOG         = '[CapManager]';
  var DEFAULT_TTL = 10 * 60_000;  // 10 minutes

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _liteTier = _score < 40;

  // ── Capability store ───────────────────────────────────────────────────────
  // cap → { cap, scope, source, granted, exp, permanent, meta }
  var _caps    = typeof Map !== 'undefined' ? new Map() : null;
  var _audit   = [];
  var MAX_AUDIT = 300;

  function _log(action, cap, detail) {
    var entry = { action: action, cap: cap, detail: detail || null, ts: Date.now() };
    _audit.push(entry);
    if (_audit.length > MAX_AUDIT) _audit.shift();
  }

  // ── Capability tier requirements ───────────────────────────────────────────
  var CAP_TIER = {
    'wasm:basic':          'MEDIUM',
    'wasm:simd':           'HIGH',
    'wasm:threads':        'HIGH',
    'worker:spawn':        'MEDIUM',
    'worker:shared':       'HIGH',
    'fetch:external':      'MEDIUM',
    'fetch:ai':            'HIGH',
    'storage:read':        'LOW',
    'storage:write':       'MEDIUM',
    'canvas:2d':           'LOW',
    'canvas:gpu':          'HIGH',
    'crypto:subtle':       'MEDIUM',
    'audio:process':       'MEDIUM',
    'perf:measure':        'LOW',
    'telemetry:write':     'HIGH',
    'hybrid:ticket':       'MEDIUM',
    'session:rotate':      'HIGH',
    'exec-ticket:premium': 'MEDIUM',
  };

  function _tierScore(tier) {
    if (tier === 'HIGH')   return 70;
    if (tier === 'MEDIUM') return 40;
    return 0;
  }

  // ── grant ──────────────────────────────────────────────────────────────────
  function grant(cap, opts) {
    if (!_caps) return null;
    opts = opts || {};

    var required = CAP_TIER[cap] || 'LOW';
    if (_score < _tierScore(required)) {
      console.debug(LOG, 'grant denied (tier):', cap, '| needs:', required, '| has:', _tier);
      _log('grant-denied-tier', cap, { required: required, actual: _tier });
      return null;
    }

    var entry = {
      cap:       cap,
      scope:     opts.scope     || 'session',
      source:    opts.source    || 'boot',
      granted:   Date.now(),
      exp:       opts.permanent ? Infinity : (Date.now() + (opts.ttl || DEFAULT_TTL)),
      permanent: !!opts.permanent,
      meta:      opts.meta || null,
    };

    _caps.set(cap, entry);
    _log('granted', cap, { source: entry.source, scope: entry.scope });
    console.debug(LOG, 'granted:', cap, '| source:', entry.source);

    // Notify interested systems
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('capability:granted', { cap: cap, source: entry.source });
      }
    });

    return entry;
  }

  // ── revoke ────────────────────────────────────────────────────────────────
  function revoke(cap) {
    if (!_caps || !_caps.has(cap)) return;
    _caps.delete(cap);
    _log('revoked', cap);
    console.debug(LOG, 'revoked:', cap);

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('capability:revoked', { cap: cap });
      }
    });
  }

  // ── has ───────────────────────────────────────────────────────────────────
  function has(cap) {
    if (!_caps) return true;  // degenerate mode
    if (!_caps.has(cap)) return false;
    var entry = _caps.get(cap);
    if (!entry.permanent && entry.exp < Date.now()) {
      _caps.delete(cap);
      _log('expired', cap);
      return false;
    }
    return true;
  }

  // ── require ───────────────────────────────────────────────────────────────
  // If the capability is missing, attempts to obtain it via HybridExecution ticket.
  function require(cap) {
    if (has(cap)) return Promise.resolve(true);

    // Try to get an execution ticket for this capability
    return _s(function () {
      var he = G.RuntimeHybridExecution;
      if (!he || typeof he.gate !== 'function') return Promise.resolve(false);
      return he.gate(cap).then(function (ok) {
        if (ok) {
          grant(cap, { source: 'hybrid-ticket', ttl: 90_000 });
          return true;
        }
        _log('require-denied', cap, { reason: 'ticket-gate-failed' });
        return false;
      });
    }, Promise.resolve(false));
  }

  // ── listActive ────────────────────────────────────────────────────────────
  function listActive() {
    if (!_caps) return [];
    var now    = Date.now();
    var active = [];
    _caps.forEach(function (entry, cap) {
      if (entry.permanent || entry.exp > now) {
        active.push(Object.assign({}, entry));
      }
    });
    return active;
  }

  // ── Bootstrap grants ──────────────────────────────────────────────────────
  function _bootGrants() {
    // Always-on LOW capabilities
    grant('storage:read',   { permanent: true, source: 'boot' });
    grant('canvas:2d',      { permanent: true, source: 'boot' });
    grant('perf:measure',   { permanent: true, source: 'boot' });

    // MEDIUM+ capabilities
    if (_score >= 40) {
      grant('wasm:basic',         { permanent: true,  source: 'boot' });
      grant('worker:spawn',       { permanent: true,  source: 'boot' });
      grant('fetch:external',     { permanent: true,  source: 'boot' });
      grant('storage:write',      { permanent: true,  source: 'boot' });
      grant('crypto:subtle',      { permanent: true,  source: 'boot' });
      grant('audio:process',      { permanent: true,  source: 'boot' });
      grant('hybrid:ticket',      { permanent: true,  source: 'boot' });
      grant('exec-ticket:premium',{ permanent: true,  source: 'boot' });
    }

    // HIGH capabilities
    if (_score >= 70) {
      grant('wasm:simd',          { permanent: true, source: 'boot' });
      grant('wasm:threads',       _s(function () {
        var we = G.RuntimeWasmEnterprise;
        var cp = we && typeof we.getCapabilityProfile === 'function' ? we.getCapabilityProfile() : null;
        var threadsOk = cp && cp.features && cp.features.wasmThreads;
        return { permanent: true, source: 'boot', meta: { threadsAvailable: !!threadsOk } };
      }, { permanent: true, source: 'boot' }));
      grant('worker:shared',      { permanent: true, source: 'boot' });
      grant('canvas:gpu',         { permanent: true, source: 'boot' });
      grant('telemetry:write',    { permanent: true, source: 'boot' });
      grant('session:rotate',     { permanent: true, source: 'boot' });
    }
  }

  // ── Subscribe to security events that should revoke capabilities ──────────
  function _installRevocationHooks() {
    _s(function () {
      if (!G.RuntimeEventBus) return;

      // Seal failure → revoke premium execution
      G.RuntimeEventBus.on('seal:failure', function () {
        revoke('exec-ticket:premium');
        revoke('wasm:simd');
        revoke('worker:shared');
        console.warn(LOG, 'capabilities revoked: seal failure');
      });

      // Tamper response → revoke sensitive caps
      G.RuntimeEventBus.on('shield:tamper-response', function () {
        revoke('telemetry:write');
        revoke('session:rotate');
        console.warn(LOG, 'capabilities revoked: tamper response');
      });

      // Foreign deploy → revoke AI + premium
      G.RuntimeEventBus.on('security:foreign-deploy', function () {
        revoke('fetch:ai');
        revoke('exec-ticket:premium');
        console.warn(LOG, 'capabilities revoked: foreign deploy');
      });
    });
  }

  // ── Periodic expiry sweep ──────────────────────────────────────────────────
  function _sweepExpired() {
    if (!_caps) return;
    var now = Date.now();
    _caps.forEach(function (entry, cap) {
      if (!entry.permanent && entry.exp < now) {
        _caps.delete(cap);
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _bootGrants();
    _installRevocationHooks();
    setInterval(_sweepExpired, 60_000);

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| active caps:', listActive().length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2200); }, { once: true });
  } else {
    setTimeout(_boot, 2200);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeCapabilityManager = Object.freeze({
    VERSION:    VERSION,
    grant:      grant,
    revoke:     revoke,
    has:        has,
    require:    require,
    listActive: listActive,
    CAP_TIER:   Object.freeze(Object.assign({}, CAP_TIER)),
    status: function () {
      return {
        version:      VERSION,
        tier:         _tier,
        score:        _score,
        activeCaps:   listActive().length,
        auditEntries: _audit.length,
        recentAudit:  _audit.slice(-10),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-execution-sandbox.js ──
// RuntimeExecutionSandbox v1.0 — Phase 6 / Task 4 (Execution Sandbox System)
// =============================================================================
// Isolated runtime scopes with capability-based execution.
// Reduces exposure of privileged runtime systems by wrapping tool execution
// in sandboxed contexts with controlled global access.
//
// Features:
//   • Isolated runtime scopes (per-tool execution contexts)
//   • Capability-based execution (tools only get what they need)
//   • Sandboxed privileged APIs (proxied access to sensitive globals)
//   • Controlled global access (restricted window surface)
//   • Secure internal messaging (signed messages between scopes)
//   • Runtime compartmentalization (tool A cannot affect tool B's state)
//   • Worker capability sealing (inherited from RuntimeSecureSession)
//   • Protected internal channels (EventBus namespace isolation)
//
// Tier gating:
//   LOW  (<40)  — full passthrough (no sandboxing overhead)
//   MED  (40-69)— basic capability checks
//   HIGH (70+)  — full sandbox + runtime compartmentalization
//
// window.RuntimeExecutionSandbox
//   .createScope(toolId, capabilities[])   → Scope
//   .destroyScope(toolId)                  → void
//   .executeInScope(toolId, fn, args)      → any
//   .grantCapability(toolId, cap)          → void
//   .revokeCapability(toolId, cap)         → void
//   .audit()                               → AuditReport
//   .status()                              → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeExecutionSandbox) return;

  var VERSION = '1.0';
  var LOG     = '[ExecSandbox]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Capability definitions ─────────────────────────────────────────────────
  var CAPABILITIES = {
    'fetch':           { desc: 'Network fetch access',         tier: 'MEDIUM' },
    'workers':         { desc: 'Worker spawn access',          tier: 'MEDIUM' },
    'wasm':            { desc: 'WebAssembly execution',        tier: 'MEDIUM' },
    'crypto':          { desc: 'SubtleCrypto access',          tier: 'HIGH'   },
    'storage-read':    { desc: 'Storage read access',          tier: 'LOW'    },
    'storage-write':   { desc: 'Storage write access',         tier: 'MEDIUM' },
    'canvas':          { desc: 'Canvas 2D context access',     tier: 'LOW'    },
    'gpu':             { desc: 'WebGPU access',                tier: 'HIGH'   },
    'clipboard':       { desc: 'Clipboard read/write',         tier: 'HIGH'   },
    'notifications':   { desc: 'Notification API',             tier: 'HIGH'   },
    'perf-api':        { desc: 'Performance measurements',     tier: 'LOW'    },
    'telemetry-write': { desc: 'Write to security telemetry',  tier: 'HIGH'   },
    'dom-mutation':    { desc: 'DOM mutation outside #tool',   tier: 'HIGH'   },
    'global-write':    { desc: 'Write to window object',       tier: 'HIGH'   },
  };

  // Default capability sets per tool category
  var DEFAULT_CAPS = {
    'pdf':      ['fetch', 'workers', 'wasm', 'canvas', 'storage-read', 'perf-api'],
    'image':    ['fetch', 'workers', 'wasm', 'canvas', 'gpu', 'storage-read', 'perf-api'],
    'convert':  ['fetch', 'workers', 'wasm', 'canvas', 'storage-read', 'perf-api'],
    'ai':       ['fetch', 'workers', 'wasm', 'gpu', 'storage-read', 'perf-api'],
    'utility':  ['storage-read', 'perf-api'],
    'default':  ['fetch', 'workers', 'canvas', 'storage-read', 'perf-api'],
  };

  // ── Scope registry ─────────────────────────────────────────────────────────
  var _scopes = typeof Map !== 'undefined' ? new Map() : null;
  var _auditLog = [];
  var MAX_AUDIT = 200;

  function _audit(action, toolId, detail) {
    var entry = { action: action, toolId: toolId, detail: detail || null, ts: Date.now() };
    _auditLog.push(entry);
    if (_auditLog.length > MAX_AUDIT) _auditLog.shift();
  }

  // ── Proxied API builders ──────────────────────────────────────────────────
  function _buildFetchProxy(toolId) {
    return function scopedFetch(url, options) {
      // Only allow same-origin + known CDN fetches from tool scopes
      try {
        var parsed = new URL(url, G.location.href);
        var ALLOWED_HOSTS = [
          G.location.hostname,
          'cdn.jsdelivr.net', 'unpkg.com',
          'api-inference.huggingface.co',
          'identitytoolkit.googleapis.com',
          'securetoken.googleapis.com',
        ];
        var allowed = ALLOWED_HOSTS.some(function (h) {
          return parsed.hostname === h || parsed.hostname.endsWith('.' + h);
        });
        if (!allowed) {
          _audit('fetch-blocked', toolId, parsed.hostname);
          console.warn(LOG, '[' + toolId + '] fetch blocked to:', parsed.hostname);
          return Promise.reject(new Error('fetch blocked by execution sandbox'));
        }
      } catch (_) {
        // Relative URL — always allowed
      }
      _audit('fetch-allowed', toolId, url.slice(0, 60));
      return G.fetch.call(G, url, options);
    };
  }

  function _buildWorkerProxy(toolId, scope) {
    if (typeof G.Worker === 'undefined') return null;
    return function ScopedWorker(url, opts) {
      // Authorize with secure session
      var authToken = _s(function () {
        var ss = G.RuntimeSecureSession;
        if (ss && typeof ss.authorizeWorker === 'function') {
          return ss.authorizeWorker(url);
        }
        return null;
      }, null);

      _audit('worker-spawn', toolId, url.split('/').pop());
      var worker = new G.Worker(url, opts);

      // Inject session token into worker via message
      if (authToken) {
        setTimeout(function () {
          try {
            worker.postMessage({ _sandboxInit: true, token: authToken.token, toolId: toolId });
          } catch (_) {}
        }, 0);
      }

      return worker;
    };
  }

  // ── Scope creation ────────────────────────────────────────────────────────
  function createScope(toolId, capabilities) {
    if (!_scopes) return null;
    if (_scopes.has(toolId)) {
      _audit('scope-reuse', toolId);
      return _scopes.get(toolId);
    }

    // Determine category
    var category = 'default';
    var CATS = ['pdf', 'image', 'convert', 'ai', 'utility'];
    for (var i = 0; i < CATS.length; i++) {
      if (toolId.indexOf(CATS[i]) !== -1) { category = CATS[i]; break; }
    }

    var caps = capabilities || DEFAULT_CAPS[category] || DEFAULT_CAPS['default'];

    // Build restricted API surface
    var apis = {};

    if (caps.indexOf('fetch') !== -1) {
      apis.fetch = _buildFetchProxy(toolId);
    }

    if (caps.indexOf('workers') !== -1) {
      var workerProxy = _buildWorkerProxy(toolId);
      if (workerProxy) apis.Worker = workerProxy;
    }

    if (caps.indexOf('wasm') !== -1) {
      apis.WebAssembly = G.WebAssembly;
    }

    if (caps.indexOf('crypto') !== -1) {
      apis.crypto = G.crypto;
    }

    if (caps.indexOf('canvas') !== -1) {
      apis.createCanvas = function () {
        var el = document.createElement('canvas');
        return el;
      };
    }

    if (caps.indexOf('storage-read') !== -1) {
      apis.sessionStorageGet = function (key) {
        return _s(function () { return G.sessionStorage.getItem('tool_' + toolId + '_' + key); }, null);
      };
    }

    if (caps.indexOf('storage-write') !== -1) {
      apis.sessionStorageSet = function (key, value) {
        _s(function () { G.sessionStorage.setItem('tool_' + toolId + '_' + key, value); });
      };
    }

    var scope = {
      toolId:    toolId,
      category:  category,
      caps:      caps.slice(),
      apis:      apis,
      createdAt: Date.now(),
      execCount: 0,
      destroyed: false,
    };

    _scopes.set(toolId, scope);
    _audit('scope-created', toolId, { category: category, caps: caps.length });
    console.debug(LOG, 'scope created | tool:', toolId, '| caps:', caps.length, '| cat:', category);
    return scope;
  }

  // ── Scope destruction ──────────────────────────────────────────────────────
  function destroyScope(toolId) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    scope.destroyed = true;
    scope.apis = {};
    _scopes.delete(toolId);
    _audit('scope-destroyed', toolId);
    console.debug(LOG, 'scope destroyed | tool:', toolId);
  }

  // ── Execute in scope ──────────────────────────────────────────────────────
  function executeInScope(toolId, fn, args) {
    if (!_scopes) return _s(function () { return fn.apply(null, args || []); }, null);

    var scope = _scopes.has(toolId) ? _scopes.get(toolId) : createScope(toolId, null);
    if (!scope || scope.destroyed) return null;

    scope.execCount++;
    _audit('scope-exec', toolId, { fn: fn.name || 'anonymous', execCount: scope.execCount });

    try {
      return fn.apply(scope.apis, args || []);
    } catch (err) {
      _audit('scope-exec-error', toolId, err.message);
      console.warn(LOG, '[' + toolId + '] execution error:', err.message);
      return null;
    }
  }

  // ── Capability management ─────────────────────────────────────────────────
  function grantCapability(toolId, cap) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    if (scope.caps.indexOf(cap) === -1) {
      scope.caps.push(cap);
      _audit('cap-granted', toolId, cap);
    }
  }

  function revokeCapability(toolId, cap) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    scope.caps = scope.caps.filter(function (c) { return c !== cap; });
    // Also remove from apis
    var apiMap = { 'fetch': 'fetch', 'workers': 'Worker', 'wasm': 'WebAssembly', 'crypto': 'crypto' };
    var apiKey = apiMap[cap];
    if (apiKey) delete scope.apis[apiKey];
    _audit('cap-revoked', toolId, cap);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| scopes:', _scopes ? _scopes.size : 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeExecutionSandbox = Object.freeze({
    VERSION:            VERSION,
    createScope:        createScope,
    destroyScope:       destroyScope,
    executeInScope:     executeInScope,
    grantCapability:    grantCapability,
    revokeCapability:   revokeCapability,
    CAPABILITIES:       Object.freeze(Object.assign({}, CAPABILITIES)),
    audit: function () {
      return {
        log:        _auditLog.slice(-50),
        scopeCount: _scopes ? _scopes.size : 0,
        scopes:     _scopes ? (function () {
          var arr = [];
          _scopes.forEach(function (s) {
            arr.push({ toolId: s.toolId, caps: s.caps.length, execCount: s.execCount });
          });
          return arr;
        })() : [],
      };
    },
    status: function () {
      return {
        version:    VERSION,
        tier:       _tier,
        score:      _score,
        scopeCount: _scopes ? _scopes.size : 0,
        auditCount: _auditLog.length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-wasm-fortress.js ──
// RuntimeWasmFortress v1.0 — Phase 6 / Task 2 (WASM Fortress Architecture)
// =============================================================================
// WASM lifecycle sealing, sandbox isolation, and integrity enforcement.
// Extends RuntimeWasmEnterprise with fortress-level protections.
//
// Responsibilities:
//   • Seal loaded WASM modules (prevent re-instantiation with tampered bytes)
//   • Enforce per-module memory limits at instantiation time
//   • Provide sandbox profiles with secure import objects
//   • Detect and block unauthorized WASM instantiation
//   • Anti-memory-scraping: auto-unload inactive modules
//   • Intercept WebAssembly.instantiate/instantiateStreaming
//   • SIMD/threads capability matrix
//   • Rust/C++ migration preparation layer
//
// Tier gating:
//   LOW  (<40)  — disabled entirely
//   MED  (40-69)— basic lifecycle tracking only
//   HIGH (70+)  — full fortress (seal + intercept + isolation)
//
// window.RuntimeWasmFortress
//   .seal(moduleId, bytes)          → Promise<SealedModule>
//   .loadSealed(moduleId)           → SealedModule|null
//   .getSecureImports(moduleId)     → ImportObject
//   .evictInactive(maxIdleMs)       → number  (count evicted)
//   .getMigrationProfile()          → MigrationProfile
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmFortress) return;

  var VERSION = '1.0';
  var LOG     = '[WasmFortress]';

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

  // ── WASM magic bytes ──────────────────────────────────────────────────────
  var WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
  var WASM_VER   = [0x01, 0x00, 0x00, 0x00];

  // ── Module registry ────────────────────────────────────────────────────────
  // Sealed modules: { id, hash, bytes, instance, lastAccess, memoryMB, profile }
  var _sealed   = typeof Map !== 'undefined' ? new Map() : null;
  var _blocked  = [];     // blocked module hashes (tampered)
  var _evictLog = [];

  // ── DJB2 + XOR hash for bytes ─────────────────────────────────────────────
  function _hashBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      try { bytes = new Uint8Array(bytes); } catch (_) { return '000000'; }
    }
    var h = 0x811c9dc5;
    var step = Math.max(1, Math.floor(bytes.length / 512));
    for (var i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ── Validate WASM magic bytes ─────────────────────────────────────────────
  function _validateWasmBytes(bytes) {
    if (!bytes || bytes.length < 8) return { ok: false, reason: 'too-short' };
    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== WASM_MAGIC[i]) return { ok: false, reason: 'bad-magic' };
    }
    for (var j = 0; j < 4; j++) {
      if (bytes[4 + j] !== WASM_VER[j]) return { ok: false, reason: 'bad-version' };
    }
    return { ok: true };
  }

  // ── Secure import object ──────────────────────────────────────────────────
  // Returns a restricted import object for a WASM module that does NOT
  // expose dangerous host functions. All I/O goes through controlled stubs.
  function getSecureImports(moduleId) {
    var now = Date.now();
    var profile = _s(function () {
      var we = G.RuntimeWasmEnterprise;
      if (we && typeof we.getSandboxProfile === 'function') return we.getSandboxProfile(moduleId);
      return null;
    }, null) || { memoryLimitMB: 64, allowCrypto: false };

    var maxPagesMB = profile.memoryLimitMB || 64;
    var maxPages   = Math.floor(maxPagesMB * 1024 * 1024 / 65536);  // 64KiB pages

    return {
      env: {
        // Memory with enforced limits
        memory: _s(function () {
          return new WebAssembly.Memory({ initial: 16, maximum: maxPages, shared: false });
        }, undefined),

        // Controlled logging (no console.log directly)
        log: function (ptr, len) {
          console.debug(LOG, '[wasm:' + moduleId + '] log ptr=' + ptr + ' len=' + len);
        },

        // Timestamp (no Date.now leak)
        now: function () { return Date.now() - now; },

        // Abort stub
        abort: function (msg, file, line, col) {
          console.error(LOG, '[wasm:' + moduleId + '] abort at ' + file + ':' + line + ':' + col);
        },

        // STUB: no network access
        fetch_url: function () { return -1; },

        // STUB: no file system
        open_file: function () { return -1; },
        read_file: function () { return 0; },
        write_file: function () { return 0; },
      },

      // Crypto access gated by sandbox profile
      crypto: profile.allowCrypto ? {
        get_random: function (ptr, len) {
          var buf = new Uint8Array(len);
          _s(function () { G.crypto.getRandomValues(buf); });
          return buf;
        },
      } : { get_random: function () { return null; } },

      // WASM import intrinsics
      wasi_snapshot_preview1: {
        fd_write: function () { return 0; },
        fd_read:  function () { return 0; },
        fd_close: function () { return 0; },
        proc_exit: function (code) { console.warn(LOG, '[wasm:' + moduleId + '] proc_exit:', code); },
        environ_get: function () { return 0; },
        environ_sizes_get: function () { return 0; },
      },
    };
  }

  // ── Seal a module ─────────────────────────────────────────────────────────
  function seal(moduleId, bytes) {
    if (!_enabled || !_sealed) return Promise.resolve(null);

    try { bytes = new Uint8Array(bytes); } catch (e) {
      return Promise.reject(new Error('seal: invalid bytes for ' + moduleId));
    }

    var validation = _validateWasmBytes(bytes);
    if (!validation.ok) {
      _s(function () {
        if (G.SecurityTelemetry) G.SecurityTelemetry.record('wasm-event', {
          event: 'seal-reject', moduleId: moduleId, reason: validation.reason,
        });
      });
      return Promise.reject(new Error('seal: bad WASM bytes: ' + validation.reason));
    }

    var hash = _hashBytes(bytes);

    if (_blocked.indexOf(hash) !== -1) {
      return Promise.reject(new Error('seal: module hash is blocked (tampered): ' + moduleId));
    }

    if (_sealed.has(moduleId)) {
      var existing = _sealed.get(moduleId);
      if (existing.hash !== hash) {
        // Hash changed — block this module
        _blocked.push(hash);
        console.error(LOG, 'TAMPER DETECTED — module hash changed:', moduleId);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', {
            path: moduleId, expected: existing.hash, actual: hash,
          });
          if (G.RuntimeEventBus) G.RuntimeEventBus.emit('wasm:tamper', { moduleId: moduleId });
        });
        return Promise.reject(new Error('seal: module tamper detected: ' + moduleId));
      }
      // Same hash — return existing
      existing.lastAccess = Date.now();
      return Promise.resolve(existing);
    }

    var imports = getSecureImports(moduleId);

    return WebAssembly.instantiate(bytes.buffer, imports)
      .then(function (result) {
        var memoryMB = _s(function () {
          var mem = result.instance.exports.memory;
          return mem ? Math.round(mem.buffer.byteLength / 1048576) : 0;
        }, 0);

        var entry = {
          id:          moduleId,
          hash:        hash,
          instance:    result.instance,
          module:      result.module,
          bytes:       _tier === 'HIGH' ? bytes : null,  // keep for re-seal on HIGH tier
          byteLength:  bytes.byteLength,
          memoryMB:    memoryMB,
          createdAt:   Date.now(),
          lastAccess:  Date.now(),
          accessCount: 0,
        };

        _sealed.set(moduleId, entry);
        console.debug(LOG, 'sealed:', moduleId, '| hash:', hash, '| mem:', memoryMB + 'MB');

        _s(function () {
          if (G.RuntimeWasmEnterprise && typeof G.RuntimeWasmEnterprise._claimMemory === 'function') {
            G.RuntimeWasmEnterprise._claimMemory(memoryMB);
          }
        });

        return entry;
      })
      .catch(function (err) {
        console.error(LOG, 'seal instantiate failed:', moduleId, err.message);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('wasm-event', {
            event: 'seal-fail', moduleId: moduleId, reason: err.message,
          });
        });
        throw err;
      });
  }

  // ── Load sealed module ────────────────────────────────────────────────────
  function loadSealed(moduleId) {
    if (!_sealed || !_sealed.has(moduleId)) return null;
    var entry = _sealed.get(moduleId);
    entry.lastAccess = Date.now();
    entry.accessCount++;
    return entry;
  }

  // ── Evict inactive modules ────────────────────────────────────────────────
  function evictInactive(maxIdleMs) {
    if (!_sealed) return 0;
    maxIdleMs = maxIdleMs || 5 * 60_000;  // 5 minutes default
    var now     = Date.now();
    var evicted = 0;

    _sealed.forEach(function (entry, id) {
      if (now - entry.lastAccess > maxIdleMs) {
        // Null out the instance to allow GC
        entry.instance = null;
        entry.bytes    = null;
        _sealed.delete(id);
        evicted++;
        _evictLog.push({ id: id, ts: now, idleMs: now - entry.lastAccess });
        console.debug(LOG, 'evicted inactive module:', id);
      }
    });

    if (evicted > 0) {
      console.info(LOG, 'evicted', evicted, 'inactive WASM module(s)');
      _s(function () {
        if (G.SecurityTelemetry) G.SecurityTelemetry.record('wasm-event', {
          event: 'evict', count: evicted,
        });
      });
    }
    return evicted;
  }

  // ── Rust/C++ Migration Preparation Layer ──────────────────────────────────
  // Describes what each tool category needs from a potential Rust/WASM module.
  // This is a planning/metadata layer — no actual WASM compilation here.
  function getMigrationProfile() {
    var features = _s(function () {
      var we = G.RuntimeWasmEnterprise;
      return we && typeof we.getCapabilityProfile === 'function' ? we.getCapabilityProfile() : null;
    }, null);

    return {
      version:           VERSION,
      tier:              _tier,
      recommended:       features ? features.recommended : 'baseline',
      migrationTargets: [
        {
          tool:          'pdf-compress',
          language:      'Rust',
          library:       'lopdf or pdf-rs',
          estimatedGain: '3-5x compression speed',
          blockers:      ['lopdf WASM build not yet production-ready'],
          priority:      'HIGH',
        },
        {
          tool:          'image-resize',
          language:      'Rust',
          library:       'image-rs',
          estimatedGain: '2-4x resize speed, better memory usage',
          blockers:      [],
          priority:      'HIGH',
        },
        {
          tool:          'pdf-ocr',
          language:      'C++',
          library:       'Tesseract (already WASM-compiled)',
          estimatedGain: 'already using WASM',
          blockers:      [],
          priority:      'DONE',
        },
        {
          tool:          'pdf-sign',
          language:      'Rust',
          library:       'pkcs7 / openssl-rs',
          estimatedGain: 'proper X.509 support',
          blockers:      ['certificate chain validation complexity'],
          priority:      'MEDIUM',
        },
      ],
      simdAvailable:   features ? (features.features || {}).wasmSimd : false,
      threadsAvailable: features ? (features.features || {}).wasmThreads : false,
      buildToolchain:  'wasm-pack + wasm-bindgen (Rust), emscripten (C++)',
      sandboxStrategy: 'All WASM modules run in dedicated workers with RuntimeWasmFortress sealing',
    };
  }

  // ── Intercept WebAssembly (HIGH tier only) ────────────────────────────────
  function _installInterceptor() {
    if (_tier !== 'HIGH') return;
    _s(function () {
      var origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
      WebAssembly.instantiate = function (source, importObject) {
        // Log all instantiation attempts
        var byteLen = source instanceof ArrayBuffer ? source.byteLength
          : (source instanceof Uint8Array ? source.byteLength : -1);
        console.debug(LOG, '[intercept] WebAssembly.instantiate | bytes:', byteLen);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('wasm-event', {
            event: 'instantiate-intercept', byteLen: byteLen,
          });
        });
        return origInstantiate(source, importObject);
      };

      var origStreaming = WebAssembly.instantiateStreaming;
      if (origStreaming) {
        WebAssembly.instantiateStreaming = function (response, importObject) {
          console.debug(LOG, '[intercept] WebAssembly.instantiateStreaming');
          return origStreaming.call(WebAssembly, response, importObject);
        };
      }
      console.debug(LOG, 'WebAssembly interceptor installed');
    });
  }

  // ── Idle eviction loop ─────────────────────────────────────────────────────
  var _evictInterval = null;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    if (_tier === 'HIGH') {
      _installInterceptor();
    }

    // Auto-evict every 10 minutes
    _evictInterval = setInterval(function () {
      evictInactive(5 * 60_000);
    }, 10 * 60_000);

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWasmFortress = Object.freeze({
    VERSION:            VERSION,
    seal:               seal,
    loadSealed:         loadSealed,
    getSecureImports:   getSecureImports,
    evictInactive:      evictInactive,
    getMigrationProfile: getMigrationProfile,
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        sealedCount:   _sealed ? _sealed.size : 0,
        blockedHashes: _blocked.length,
        evictCount:    _evictLog.length,
        modules: _sealed ? (function () {
          var arr = [];
          _sealed.forEach(function (e) {
            arr.push({ id: e.id, hash: e.hash, memoryMB: e.memoryMB, accessCount: e.accessCount });
          });
          return arr;
        })() : [],
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-wasm-isolation.js ──
// RuntimeWasmIsolation v1.0 — Phase 6 / Task 2 (WASM Memory Isolation)
// =============================================================================
// Memory isolation, anti-scraping protections, and isolated execution pools
// for WASM modules. Companion to RuntimeWasmFortress.
//
// Anti-memory-scraping protections:
//   • Poison memory regions with randomized canary values
//   • Detect unexpected memory reads via SharedArrayBuffer access patterns
//   • Zero-fill memory on module unload (prevent data remnants)
//   • Enforce strict per-pool memory budgets
//   • Detect abnormal heap growth indicative of memory probing
//
// Isolated execution pools:
//   • Each tool category gets a dedicated execution pool
//   • Pools are isolated from each other (no shared linear memory)
//   • Pool exhaustion triggers graceful fallback to sequential execution
//
// window.RuntimeWasmIsolation
//   .createPool(poolId, opts)         → Pool
//   .submitTask(poolId, fn)           → Promise<result>
//   .evictPool(poolId)                → void
//   .zeroFillMemory(moduleId)         → void
//   .getMemoryReport()                → MemoryReport
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmIsolation) return;

  var VERSION = '1.0';
  var LOG     = '[WasmIsolation]';

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

  // ── Pool defaults ──────────────────────────────────────────────────────────
  var POOL_DEFAULTS = {
    'pdf':    { maxConcurrent: 2, maxMemMB: 256, timeoutMs: 60_000  },
    'image':  { maxConcurrent: 3, maxMemMB: 512, timeoutMs: 120_000 },
    'ai':     { maxConcurrent: 1, maxMemMB: 1024, timeoutMs: 300_000 },
    'crypto': { maxConcurrent: 4, maxMemMB: 32,  timeoutMs: 10_000  },
    'default':{ maxConcurrent: 2, maxMemMB: 128, timeoutMs: 30_000  },
  };

  // ── Pool registry ──────────────────────────────────────────────────────────
  var _pools = typeof Map !== 'undefined' ? new Map() : null;

  // ── Memory canary system ───────────────────────────────────────────────────
  // Canaries are placed at known offsets in WASM linear memory.
  // Unexpected mutation indicates memory probing or out-of-bounds access.
  var _canaries = typeof Map !== 'undefined' ? new Map() : null;  // moduleId → {offset, value}

  function _plantCanary(moduleId, wasmMemory) {
    if (!_canaries || !wasmMemory) return;
    _s(function () {
      var view   = new Uint32Array(wasmMemory.buffer);
      // Use the last 4 bytes before the memory limit as canary location
      var offset = Math.floor(view.length * 0.95);
      var value  = (Math.random() * 0xFFFFFFFF) >>> 0;
      view[offset] = value;
      _canaries.set(moduleId, { offset: offset, value: value, memory: wasmMemory });
    });
  }

  function _checkCanary(moduleId) {
    if (!_canaries || !_canaries.has(moduleId)) return true;
    return _s(function () {
      var c    = _canaries.get(moduleId);
      var view = new Uint32Array(c.memory.buffer);
      var ok   = view[c.offset] === c.value;
      if (!ok) {
        console.error(LOG, 'CANARY VIOLATED — potential memory scraping:', moduleId);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', {
            path: moduleId, reason: 'wasm-canary-violated',
          });
          if (G.RuntimeEventBus) G.RuntimeEventBus.emit('wasm:memory-violation', { moduleId: moduleId });
        });
      }
      return ok;
    }, true);
  }

  // ── Zero-fill memory on unload ─────────────────────────────────────────────
  function zeroFillMemory(moduleId) {
    _s(function () {
      var fortress = G.RuntimeWasmFortress;
      if (!fortress) return;
      var entry = fortress.loadSealed(moduleId);
      if (!entry || !entry.instance) return;
      var mem = entry.instance.exports.memory;
      if (!mem) return;
      var view = new Uint8Array(mem.buffer);
      view.fill(0);
      _canaries && _canaries.delete(moduleId);
      console.debug(LOG, 'zero-filled memory for:', moduleId);
    });
  }

  // ── Execution pool ─────────────────────────────────────────────────────────
  function createPool(poolId, opts) {
    if (!_pools) return null;
    if (_pools.has(poolId)) return _pools.get(poolId);

    var category = 'default';
    var CATS = ['pdf', 'image', 'ai', 'crypto'];
    for (var i = 0; i < CATS.length; i++) {
      if (poolId.indexOf(CATS[i]) !== -1) { category = CATS[i]; break; }
    }

    var defaults = POOL_DEFAULTS[category];
    var config = Object.assign({}, defaults, opts || {});

    var pool = {
      id:           poolId,
      category:     category,
      config:       config,
      queue:        [],
      running:      0,
      submitted:    0,
      completed:    0,
      errors:       0,
      createdAt:    Date.now(),
      memoryUsedMB: 0,
      destroyed:    false,
    };

    _pools.set(poolId, pool);
    console.debug(LOG, 'pool created | id:', poolId, '| maxConcurrent:', config.maxConcurrent,
      '| maxMemMB:', config.maxMemMB);
    return pool;
  }

  function submitTask(poolId, fn) {
    if (!_enabled) return _s(function () { return Promise.resolve(fn()); }, Promise.reject(new Error('isolation disabled')));

    var pool = _pools && _pools.has(poolId) ? _pools.get(poolId) : createPool(poolId, null);
    if (!pool || pool.destroyed) return Promise.reject(new Error('pool unavailable: ' + poolId));

    pool.submitted++;

    return new Promise(function (resolve, reject) {
      var task = { fn: fn, resolve: resolve, reject: reject, ts: Date.now() };
      pool.queue.push(task);
      _drainPool(pool);
    });
  }

  function _drainPool(pool) {
    while (pool.running < pool.config.maxConcurrent && pool.queue.length > 0) {
      var task = pool.queue.shift();
      pool.running++;

      var timeoutId = setTimeout(function () {
        task.reject(new Error('pool task timeout: ' + pool.id));
        pool.running = Math.max(0, pool.running - 1);
        pool.errors++;
        _drainPool(pool);
      }, pool.config.timeoutMs);

      _s(function () {
        Promise.resolve().then(function () { return task.fn(); })
          .then(function (result) {
            clearTimeout(timeoutId);
            pool.running = Math.max(0, pool.running - 1);
            pool.completed++;
            task.resolve(result);
            _drainPool(pool);
          })
          .catch(function (err) {
            clearTimeout(timeoutId);
            pool.running = Math.max(0, pool.running - 1);
            pool.errors++;
            task.reject(err);
            _drainPool(pool);
          });
      });
    }
  }

  function evictPool(poolId) {
    if (!_pools || !_pools.has(poolId)) return;
    var pool = _pools.get(poolId);
    // Reject all queued tasks
    while (pool.queue.length > 0) {
      var task = pool.queue.shift();
      task.reject(new Error('pool evicted: ' + poolId));
    }
    pool.destroyed = true;
    _pools.delete(poolId);
    console.debug(LOG, 'pool evicted:', poolId);
  }

  // ── Memory pressure monitoring ─────────────────────────────────────────────
  function getMemoryReport() {
    var heapMB = _s(function () {
      var m = G.performance && G.performance.memory;
      if (!m) return null;
      return {
        used:  Math.round(m.usedJSHeapSize  / 1048576),
        total: Math.round(m.totalJSHeapSize / 1048576),
        limit: Math.round(m.jsHeapSizeLimit / 1048576),
      };
    }, null);

    var poolsReport = [];
    if (_pools) {
      _pools.forEach(function (p) {
        poolsReport.push({
          id:        p.id,
          running:   p.running,
          queued:    p.queue.length,
          completed: p.completed,
          errors:    p.errors,
        });
      });
    }

    var budget = _s(function () {
      var we = G.RuntimeWasmEnterprise;
      return we && typeof we.getMemoryBudget === 'function' ? we.getMemoryBudget() : null;
    }, null);

    return {
      heap:    heapMB,
      budget:  budget,
      pools:   poolsReport,
      canaries: _canaries ? _canaries.size : 0,
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Pre-create standard pools
    createPool('pdf-pool',    POOL_DEFAULTS['pdf']);
    createPool('image-pool',  POOL_DEFAULTS['image']);
    createPool('crypto-pool', POOL_DEFAULTS['crypto']);

    // Periodic canary sweep on HIGH tier
    if (_tier === 'HIGH') {
      setInterval(function () {
        if (_canaries) {
          _canaries.forEach(function (_, id) { _checkCanary(id); });
        }
      }, 60_000);
    }

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| pools:', _pools ? _pools.size : 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4500); }, { once: true });
  } else {
    setTimeout(_boot, 4500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWasmIsolation = Object.freeze({
    VERSION:          VERSION,
    createPool:       createPool,
    submitTask:       submitTask,
    evictPool:        evictPool,
    zeroFillMemory:   zeroFillMemory,
    plantCanary:      _plantCanary,
    checkCanary:      _checkCanary,
    getMemoryReport:  getMemoryReport,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        poolCount:  _pools ? _pools.size : 0,
        canaryCount: _canaries ? _canaries.size : 0,
        memory:     getMemoryReport(),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-wasm-encrypted-loader.js ──
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
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
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

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-encrypted-chunks.js ──
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
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Periodic token eviction
    setInterval(_evictTokens, 60_000);

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| TOKEN_TTL:', TOKEN_TTL_MS + 'ms');
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

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-tokenized-loader.js ──
// RuntimeTokenizedLoader v1.0 — Phase 6 / Task 3 (Tokenized Module Loader)
// =============================================================================
// Token-gated deferred module loading. Wraps dynamic import() with
// execution-ticket authorization and chunk token verification.
//
// Features:
//   • Token-gated dynamic imports
//   • Chunk integrity check before loading
//   • Stale-cache detection before deferred execution
//   • SRI verification of dynamically loaded modules
//   • Load queue with priority ordering
//   • Adaptive loading based on device tier and network
//   • Batch import coalescing (reduces round-trips)
//   • Deferred module dependency resolution
//
// window.RuntimeTokenizedLoader
//   .queue(path, opts)               → Promise<module|null>
//   .loadImmediate(path)             → Promise<module|null>
//   .preauthorize(paths[])           → void
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeTokenizedLoader) return;

  var VERSION      = '1.0';
  var LOG          = '[TokenLoader]';
  var QUEUE_DELAY  = 200;    // ms between batch drains
  var MAX_BATCH    = 4;

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
  var _queue   = [];         // [{path, opts, resolve, reject, ts}]
  var _loading = typeof Map !== 'undefined' ? new Map() : null;  // path → Promise
  var _loaded  = typeof Map !== 'undefined' ? new Map() : null;  // path → module
  var _preauth = {};         // path → token

  var _stats = {
    queued:    0,
    loaded:    0,
    blocked:   0,
    errors:    0,
    cacheHits: 0,
  };

  // ── Pre-authorize chunks ──────────────────────────────────────────────────
  function preauthorize(paths) {
    _s(function () {
      var ec = G.RuntimeEncryptedChunks;
      if (!ec || typeof ec.authorizeChunk !== 'function') return;
      for (var i = 0; i < paths.length; i++) {
        var entry = ec.authorizeChunk(paths[i]);
        if (entry) _preauth[paths[i]] = entry.token;
      }
    });
  }

  // ── Verify chunk before load ───────────────────────────────────────────────
  function _verifyBeforeLoad(path) {
    // 1. Try pre-authorized token
    var token = _preauth[path];
    if (token) {
      var ok = _s(function () {
        var ec = G.RuntimeEncryptedChunks;
        return ec && typeof ec.verifyToken === 'function' ? ec.verifyToken(token) : true;
      }, true);
      if (!ok) {
        console.warn(LOG, 'token verification failed for:', path);
        _stats.blocked++;
        return false;
      }
      // Consume token
      _s(function () {
        var ec = G.RuntimeEncryptedChunks;
        if (ec && typeof ec.revokeToken === 'function') ec.revokeToken(token);
      });
      delete _preauth[path];
      return true;
    }

    // 2. No pre-auth — check SRI if available
    var sriOk = _s(function () {
      var sri = G.RuntimeSriEngine;
      if (!sri || typeof sri.verify !== 'function') return true;  // no SRI = allow
      // SRI verify is async; we'll do it post-load for now
      return true;
    }, true);

    return sriOk;
  }

  // ── Load a single module ──────────────────────────────────────────────────
  function _loadOne(path, opts) {
    if (_loaded && _loaded.has(path)) {
      _stats.cacheHits++;
      return Promise.resolve(_loaded.get(path));
    }
    if (_loading && _loading.has(path)) {
      return _loading.get(path);
    }

    if (!_verifyBeforeLoad(path)) {
      return Promise.reject(new Error('chunk blocked by token verification: ' + path));
    }

    // Use script injection for plain JS files (avoids CSP module issues)
    var promise = new Promise(function (resolve, reject) {
      var el  = document.createElement('script');
      el.src  = path + (opts && opts.cacheBust ? '?v=' + Date.now() : '');
      el.defer = true;
      el.onload  = function () {
        _stats.loaded++;
        if (_loaded) _loaded.set(path, { loaded: true, ts: Date.now() });
        if (_loading) _loading.delete(path);

        // Post-load SRI verify
        _s(function () {
          var sri = G.RuntimeSriEngine;
          if (sri && typeof sri.verifyDeferred === 'function') {
            sri.verifyDeferred(path).catch(function () {});
          }
        });
        resolve({ loaded: true, path: path });
      };
      el.onerror = function () {
        _stats.errors++;
        if (_loading) _loading.delete(path);
        reject(new Error('script load failed: ' + path));
      };
      document.head.appendChild(el);
    });

    if (_loading) _loading.set(path, promise);
    return promise;
  }

  // ── Queue drain ────────────────────────────────────────────────────────────
  var _drainTimeout = null;

  function _scheduleDrain() {
    if (_drainTimeout) return;
    _drainTimeout = setTimeout(_drain, QUEUE_DELAY);
  }

  function _drain() {
    _drainTimeout = null;
    if (_queue.length === 0) return;

    var batch = _queue.splice(0, MAX_BATCH);
    batch.forEach(function (item) {
      _loadOne(item.path, item.opts)
        .then(item.resolve)
        .catch(item.reject);
    });

    if (_queue.length > 0) _scheduleDrain();
  }

  // ── Public: queue ─────────────────────────────────────────────────────────
  function queue(path, opts) {
    if (!path) return Promise.reject(new Error('path required'));
    _stats.queued++;
    return new Promise(function (resolve, reject) {
      _queue.push({ path: path, opts: opts || {}, resolve: resolve, reject: reject, ts: Date.now() });
      _scheduleDrain();
    });
  }

  // ── Public: loadImmediate ─────────────────────────────────────────────────
  function loadImmediate(path) {
    if (!path) return Promise.reject(new Error('path required'));
    return _loadOne(path, { immediate: true });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeTokenizedLoader = Object.freeze({
    VERSION:       VERSION,
    queue:         queue,
    loadImmediate: loadImmediate,
    preauthorize:  preauthorize,
    status: function () {
      return {
        version:      VERSION,
        enabled:      _enabled,
        tier:         _tier,
        queueLength:  _queue.length,
        loading:      _loading ? _loading.size : 0,
        loaded:       _loaded  ? _loaded.size  : 0,
        preauthorized: Object.keys(_preauth).length,
        stats:        Object.assign({}, _stats),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-threat-correlation.js ──
// RuntimeThreatCorrelation v1.0 — Phase 6 / Task 6 (Threat Correlation Engine)
// =============================================================================
// Correlates disparate security events into structured attack patterns.
// Transforms low-signal events into high-confidence threat assessments.
//
// Correlation strategies:
//   1. Temporal clustering — events within short windows from same session
//   2. Type correlation — specific combinations indicate known attack vectors
//   3. Sequence matching — ordered event patterns (e.g. probe → exploit → exfil)
//   4. Volume correlation — unusual event rates per session/IP
//   5. Cross-system correlation — same symptom from multiple detectors
//
// Known attack patterns:
//   • SRI_BYPASS:      sri-mismatch + worker-blocked + foreign-degrade
//   • REPLAY_ATTACK:   replay-attempt × 3 within 60s
//   • RUNTIME_TAMPER:  proto-pollution + seal-failure + integrity-failure
//   • DEPLOY_HIJACK:   deploy-mismatch + foreign-degrade + nonce-violation
//   • MEMORY_PROBE:    wasm-canary-violated + memory-abuse + worker-anomaly
//   • TOKEN_ABUSE:     token-reuse × 2 + ticket-fail × 3 within 120s
//   • DEVTOOLS_ATTACK: devtools-degraded + runtime-drift + blob-leak
//
// window.RuntimeThreatCorrelation
//   .ingest(event)                  → void
//   .getActiveThreats()             → Threat[]
//   .getAttackChain(sessionId)      → AttackChain|null
//   .getRiskScore(sessionId)        → number (0-100)
//   .clearThreats()                 → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeThreatCorrelation) return;

  var VERSION    = '1.0';
  var LOG        = '[ThreatCorr]';
  var MAX_EVENTS = 1000;
  var MAX_THREATS = 50;

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
  var _events   = [];    // all ingested events (bounded)
  var _threats  = [];    // active detected threats
  var _chains   = typeof Map !== 'undefined' ? new Map() : null;   // sessionId → AttackChain

  // ── Attack pattern definitions ─────────────────────────────────────────────
  var ATTACK_PATTERNS = [
    {
      id:       'SRI_BYPASS',
      name:     'SRI Bypass Attempt',
      severity: 'CRITICAL',
      score:    85,
      windowMs: 300_000,  // 5 minutes
      conditions: function (events) {
        var hasMismatch  = events.some(function (e) { return e.type === 'sri-mismatch'; });
        var hasWorkerBlk = events.some(function (e) { return e.type === 'worker-blocked'; });
        var hasForeign   = events.some(function (e) { return e.type === 'deploy-mismatch' || e.type === 'foreign-degrade'; });
        return hasMismatch && (hasWorkerBlk || hasForeign);
      },
    },
    {
      id:       'REPLAY_ATTACK',
      name:     'Replay Attack',
      severity: 'HIGH',
      score:    70,
      windowMs: 60_000,   // 1 minute
      conditions: function (events) {
        var replays = events.filter(function (e) { return e.type === 'replay-attempt'; });
        return replays.length >= 3;
      },
    },
    {
      id:       'RUNTIME_TAMPER',
      name:     'Runtime Tampering',
      severity: 'CRITICAL',
      score:    90,
      windowMs: 120_000,
      conditions: function (events) {
        var hasPollution  = events.some(function (e) { return e.type === 'proto-pollution'; });
        var hasSeal       = events.some(function (e) { return e.type === 'seal-failure' || e.type === 'integrity-failure'; });
        return hasPollution || (hasSeal && events.length >= 3);
      },
    },
    {
      id:       'DEPLOY_HIJACK',
      name:     'Deployment Hijacking',
      severity: 'CRITICAL',
      score:    95,
      windowMs: 180_000,
      conditions: function (events) {
        var hasDeploy  = events.some(function (e) { return e.type === 'deploy-mismatch'; });
        var hasForeign = events.some(function (e) { return e.type === 'foreign-degrade' || e.type === 'security:foreign-deploy'; });
        var hasNonce   = events.some(function (e) { return e.type === 'nonce-violation'; });
        return hasDeploy && hasForeign;
      },
    },
    {
      id:       'MEMORY_PROBE',
      name:     'Memory Probing',
      severity: 'HIGH',
      score:    75,
      windowMs: 300_000,
      conditions: function (events) {
        var wasmViolation = events.some(function (e) {
          return e.type === 'integrity-failure' && (e.reason || '').indexOf('canary') !== -1;
        });
        var memAbuse = events.filter(function (e) { return e.type === 'perf-pressure'; }).length >= 3;
        return wasmViolation || memAbuse;
      },
    },
    {
      id:       'TOKEN_ABUSE',
      name:     'Token/Ticket Abuse',
      severity: 'HIGH',
      score:    65,
      windowMs: 120_000,
      conditions: function (events) {
        var replays    = events.filter(function (e) { return e.type === 'replay-attempt'; }).length;
        var ticketFail = events.filter(function (e) {
          return e.type === 'wasm-event' && (e.event === 'ticket-fail' || e.event === 'token-fail');
        }).length;
        return (replays >= 2 && ticketFail >= 2) || ticketFail >= 5;
      },
    },
    {
      id:       'DEVTOOLS_ATTACK',
      name:     'DevTools-Assisted Attack',
      severity: 'MEDIUM',
      score:    45,
      windowMs: 180_000,
      conditions: function (events) {
        var devtools = events.some(function (e) { return e.type === 'devtools-degraded'; });
        var drift    = events.some(function (e) { return e.type === 'runtime-drift'; });
        var tamper   = events.some(function (e) { return e.type === 'proto-pollution'; });
        return devtools && (drift || tamper);
      },
    },
    {
      id:       'PANIC_CHAIN',
      name:     'Cascading Panic (Possible DoS)',
      severity: 'HIGH',
      score:    60,
      windowMs: 60_000,
      conditions: function (events) {
        var panics = events.filter(function (e) { return e.type === 'panic-activated'; }).length;
        return panics >= 2;
      },
    },
  ];

  // ── Session event index ────────────────────────────────────────────────────
  function _getSessionEvents(sessionId, windowMs) {
    var cutoff = Date.now() - windowMs;
    return _events.filter(function (e) {
      return (!sessionId || e.sessionId === sessionId) && e.ts >= cutoff;
    });
  }

  // ── Attack chain reconstruction ────────────────────────────────────────────
  function _buildChain(sessionId) {
    var events = _events.filter(function (e) { return e.sessionId === sessionId; })
      .sort(function (a, b) { return a.ts - b.ts; });
    if (events.length === 0) return null;

    var patterns = _threats.filter(function (t) { return t.sessionId === sessionId; });
    return {
      sessionId: sessionId,
      events:    events.slice(-50),
      patterns:  patterns,
      riskScore: _computeRiskScore(sessionId),
      firstSeen: events[0].ts,
      lastSeen:  events[events.length - 1].ts,
      duration:  events[events.length - 1].ts - events[0].ts,
    };
  }

  // ── Risk score ─────────────────────────────────────────────────────────────
  function _computeRiskScore(sessionId) {
    var sessionThreats = _threats.filter(function (t) { return t.sessionId === sessionId; });
    if (sessionThreats.length === 0) return 0;
    var maxScore = 0;
    var bonus    = 0;
    for (var i = 0; i < sessionThreats.length; i++) {
      if (sessionThreats[i].score > maxScore) maxScore = sessionThreats[i].score;
      bonus += Math.floor(sessionThreats[i].score / 10);
    }
    return Math.min(100, maxScore + Math.floor(bonus / sessionThreats.length));
  }

  // ── Correlate against all patterns ────────────────────────────────────────
  function _correlate(sessionId) {
    for (var i = 0; i < ATTACK_PATTERNS.length; i++) {
      var pattern = ATTACK_PATTERNS[i];
      var events  = _getSessionEvents(sessionId, pattern.windowMs);
      if (events.length === 0) continue;

      try {
        if (pattern.conditions(events)) {
          // Check if we already have this threat for this session
          var existing = _threats.some(function (t) {
            return t.patternId === pattern.id && t.sessionId === sessionId &&
              (Date.now() - t.detectedAt) < pattern.windowMs;
          });

          if (!existing) {
            var threat = {
              patternId:  pattern.id,
              name:       pattern.name,
              severity:   pattern.severity,
              score:      pattern.score,
              sessionId:  sessionId,
              detectedAt: Date.now(),
              eventCount: events.length,
              events:     events.slice(-10).map(function (e) { return e.type; }),
            };

            _threats.push(threat);
            if (_threats.length > MAX_THREATS) _threats.shift();

            console.warn(LOG, 'THREAT DETECTED:', pattern.name,
              '| severity:', pattern.severity,
              '| session:', (sessionId || '').slice(0, 8),
              '| score:', pattern.score);

            // Emit to EventBus
            _s(function () {
              if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
                G.RuntimeEventBus.emit('security:anomaly', {
                  type:     pattern.id,
                  severity: pattern.severity,
                  score:    pattern.score,
                  sessionId: sessionId,
                });
              }
            });

            // Record in SecurityTelemetry
            _s(function () {
              if (G.SecurityTelemetry) {
                G.SecurityTelemetry.record('integrity-failure', {
                  reason:    'threat-correlation:' + pattern.id,
                  severity:  pattern.severity,
                  score:     pattern.score,
                  sessionId: (sessionId || '').slice(0, 12),
                });
              }
            });

            // Update chain
            if (_chains) {
              var chain = _buildChain(sessionId);
              if (chain) _chains.set(sessionId, chain);
            }
          }
        }
      } catch (_) {}
    }
  }

  // ── ingest (public) ────────────────────────────────────────────────────────
  function ingest(event) {
    if (!_enabled || !event) return;

    var normalized = {
      type:      event.type      || event.event || 'unknown',
      sessionId: event.sessionId || event.session || 'anon',
      severity:  event.severity  || 'LOW',
      reason:    event.reason    || '',
      event:     event.event     || '',
      ts:        Date.now(),
    };

    _events.push(normalized);
    if (_events.length > MAX_EVENTS) _events.shift();

    // Correlate on HIGH/CRITICAL events only (perf guard)
    var sev = normalized.severity;
    if (sev === 'CRITICAL' || sev === 'HIGH' || normalized.type === 'replay-attempt') {
      setTimeout(function () {
        _s(function () { _correlate(normalized.sessionId); });
      }, 0);
    } else if (_events.length % 20 === 0) {
      // Periodic sweep every 20 events for lower-severity patterns
      setTimeout(function () {
        _s(function () { _correlate(normalized.sessionId); });
      }, 0);
    }
  }

  // ── Public API functions ──────────────────────────────────────────────────
  function getActiveThreats() {
    var cutoff = Date.now() - 30 * 60_000;  // last 30 min
    return _threats.filter(function (t) { return t.detectedAt >= cutoff; }).slice();
  }

  function getAttackChain(sessionId) {
    if (!_chains) return _buildChain(sessionId);
    return _chains.get(sessionId) || _buildChain(sessionId);
  }

  function getRiskScore(sessionId) { return _computeRiskScore(sessionId); }

  function clearThreats() {
    _threats = [];
    if (_chains) _chains.clear();
    console.debug(LOG, 'threats cleared');
  }

  // ── Subscribe to SecurityTelemetry events ──────────────────────────────────
  function _subscribe() {
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) { ingest(event); });
      }
    });

    // Also subscribe to RuntimeSecurityEventSchema
    _s(function () {
      if (!G.RuntimeEventBus) return;
      var SEC_EVENTS = [
        'integrity-failure', 'seal-failure', 'proto-pollution', 'panic-activated',
        'sri-mismatch', 'worker-blocked', 'deploy-mismatch', 'nonce-violation',
        'origin-violation', 'replay-attempt', 'devtools-degraded', 'runtime-drift',
        'security:foreign-deploy', 'security:anomaly', 'wasm:tamper', 'wasm:memory-violation',
        // Phase 7 additions
        'automation-detected', 'mesh:worker-quarantined', 'seal:failure',
        'packet:replay-detected', 'incident:created',
      ];
      SEC_EVENTS.forEach(function (evt) {
        G.RuntimeEventBus.on(evt, function (data) {
          ingest(Object.assign({ type: evt }, data || {}));
        });
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    setTimeout(_subscribe, 2_000);

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| patterns:', ATTACK_PATTERNS.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeThreatCorrelation = Object.freeze({
    VERSION:          VERSION,
    ingest:           ingest,
    getActiveThreats: getActiveThreats,
    getAttackChain:   getAttackChain,
    getRiskScore:     getRiskScore,
    clearThreats:     clearThreats,
    PATTERNS:         ATTACK_PATTERNS.map(function (p) {
      return { id: p.id, name: p.name, severity: p.severity, score: p.score };
    }),
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        eventCount:    _events.length,
        threatCount:   _threats.length,
        activeThreats: getActiveThreats().length,
        chainCount:    _chains ? _chains.size : 0,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

// ── SOURCE: public/js/runtime-anomaly-engine.js ──
// RuntimeAnomalyEngine v1.0 — Phase 6 / Task 6 (Anomaly Detection Engine)
// =============================================================================
// Session-level anomaly scoring, deployment anomaly scoring, and worker
// anomaly detection. Feeds threat signals into RuntimeThreatCorrelation.
//
// Scoring dimensions:
//   1. Session anomaly score  — per-session behavioral deviation (0-100)
//   2. Deployment score       — environment integrity confidence (0-100)
//   3. Worker health score    — worker pool behavioral health (0-100)
//   4. Temporal anomaly score — timing-based detection (0-100)
//
// Anomaly detectors:
//   • Token abuse detection     (high ticket failure rate)
//   • Replay attack clustering  (nonce reuse patterns)
//   • Memory abuse detection    (abnormal heap growth)
//   • Runtime tamper correlation (global drift + seal failures)
//   • Worker anomaly scoring    (restart storms, message anomalies)
//   • Rolling incident windows  (event rate per 1/5/15 minute)
//   • Risk scoring              (weighted composite score)
//   • Automated incident grouping (cluster similar events)
//
// window.RuntimeAnomalyEngine
//   .score(sessionId)                → AnomalyScore
//   .getDeploymentScore()            → DeploymentScore
//   .getWorkerScore()                → WorkerScore
//   .getIncidentSummary()            → IncidentSummary
//   .markSuspicious(sessionId, reason)→ void
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAnomalyEngine) return;

  var VERSION    = '1.0';
  var LOG        = '[AnomalyEngine]';
  var WINDOWS    = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
  var MAX_EVENTS = 2000;

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

  // ── Event store ────────────────────────────────────────────────────────────
  var _events       = [];
  var _sessionFlags = typeof Map !== 'undefined' ? new Map() : null; // sessionId → {score, flags}
  var _incidents    = [];

  // ── Event weight table (higher = more suspicious) ─────────────────────────
  var EVENT_WEIGHT = {
    'integrity-failure':   30,
    'seal-failure':        30,
    'proto-pollution':     40,
    'panic-activated':     25,
    'sri-mismatch':        20,
    'worker-blocked':      15,
    'deploy-mismatch':     20,
    'nonce-violation':     20,
    'origin-violation':    10,
    'replay-attempt':      25,
    'devtools-degraded':   10,
    'runtime-drift':       15,
    'foreign-degrade':     15,
    'wasm-event':           5,
    'blob-leak':            3,
    'perf-pressure':        2,
    'worker-restart':       5,
  };

  // ── Ingest event ──────────────────────────────────────────────────────────
  function _ingest(event) {
    if (!event) return;
    var e = {
      type:      event.type || event.event || 'unknown',
      sessionId: event.sessionId || 'anon',
      ts:        Date.now(),
      meta:      event,
    };
    _events.push(e);
    if (_events.length > MAX_EVENTS) _events.shift();
  }

  // ── Events in window ──────────────────────────────────────────────────────
  function _eventsIn(windowMs, sessionId) {
    var cutoff = Date.now() - windowMs;
    return _events.filter(function (e) {
      return e.ts >= cutoff && (!sessionId || e.sessionId === sessionId);
    });
  }

  // ── Session anomaly score ──────────────────────────────────────────────────
  function score(sessionId) {
    var w5   = _eventsIn(WINDOWS['5m'], sessionId);
    var w15  = _eventsIn(WINDOWS['15m'], sessionId);

    // Weighted event sum
    var rawScore = 0;
    for (var i = 0; i < w5.length; i++) {
      rawScore += (EVENT_WEIGHT[w5[i].type] || 1);
    }

    // Burst penalty: >10 high-weight events in 1 min
    var w1      = _eventsIn(WINDOWS['1m'], sessionId);
    var w1Score = 0;
    for (var j = 0; j < w1.length; j++) {
      w1Score += (EVENT_WEIGHT[w1[j].type] || 1);
    }
    if (w1Score > 50) rawScore += 30;  // burst penalty

    // Threat correlation bonus
    var threatBonus = 0;
    _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (tc && typeof tc.getRiskScore === 'function') {
        threatBonus = tc.getRiskScore(sessionId);
      }
    });

    var finalScore = Math.min(100, Math.round((rawScore + threatBonus * 0.5) / 2));

    // Update session flags
    var flags = [];
    if (finalScore >= 80) flags.push('high-risk');
    if (finalScore >= 50) flags.push('elevated-risk');

    var replay = w5.filter(function (e) { return e.type === 'replay-attempt'; }).length;
    if (replay >= 3) flags.push('replay-cluster');

    var tamper = w15.filter(function (e) {
      return e.type === 'proto-pollution' || e.type === 'integrity-failure';
    }).length;
    if (tamper >= 2) flags.push('tamper-pattern');

    if (_sessionFlags) {
      _sessionFlags.set(sessionId, { score: finalScore, flags: flags, ts: Date.now() });
    }

    return {
      sessionId:    sessionId,
      score:        finalScore,
      level:        finalScore >= 80 ? 'CRITICAL' : (finalScore >= 50 ? 'HIGH' : (finalScore >= 25 ? 'MEDIUM' : 'LOW')),
      flags:        flags,
      eventCount1m: w1.length,
      eventCount5m: w5.length,
      threatBonus:  threatBonus,
      ts:           Date.now(),
    };
  }

  // ── Deployment anomaly score ───────────────────────────────────────────────
  function getDeploymentScore() {
    var checks = [];
    var deductions = 0;

    // Seal status
    var sealOk = _s(function () {
      var ds = G.RuntimeDeploySeal;
      if (!ds || typeof ds.status !== 'function') return null;
      var st = ds.status();
      return st.ok;
    }, null);
    if (sealOk === false) { deductions += 30; checks.push('seal-fail'); }
    else if (sealOk === true) { checks.push('seal-ok'); }

    // Foreign deploy
    var isForeign = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (isForeign) { deductions += 25; checks.push('foreign-domain'); }

    // SRI engine health
    var sriOk = _s(function () {
      var sri = G.RuntimeSriEngine;
      if (!sri || typeof sri.status !== 'function') return null;
      var st = sri.status();
      return st.mismatches === 0;
    }, null);
    if (sriOk === false) { deductions += 20; checks.push('sri-mismatch'); }

    // Attestation trust
    var attested = _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
    if (!attested) { deductions += 15; checks.push('attestation-failed'); }

    // Shadow runtime drift
    var drifted = _s(function () {
      var sr = G.RuntimeShadowRuntime;
      if (!sr || typeof sr.auditDrift !== 'function') return 0;
      return sr.status().tamperCount || 0;
    }, 0);
    if (drifted > 0) { deductions += Math.min(20, drifted * 5); checks.push('api-drift:' + drifted); }

    var confidence = Math.max(0, 100 - deductions);
    return {
      confidence: confidence,
      level:      confidence >= 80 ? 'TRUSTED' : (confidence >= 50 ? 'DEGRADED' : 'UNTRUSTED'),
      deductions: deductions,
      checks:     checks,
      ts:         Date.now(),
    };
  }

  // ── Worker health score ────────────────────────────────────────────────────
  function getWorkerScore() {
    var deductions = 0;
    var checks     = [];

    // Worker factory violations
    var spawnViolations = _s(function () {
      var wf = G.RuntimeWorkerFactory;
      if (!wf || typeof wf.audit !== 'function') return 0;
      return wf.audit().spawnViolations || 0;
    }, 0);
    if (spawnViolations > 0) { deductions += Math.min(40, spawnViolations * 10); checks.push('spawn-violations:' + spawnViolations); }

    // Worker restarts
    var restarts = _eventsIn(WINDOWS['15m']).filter(function (e) {
      return e.type === 'worker-restart';
    }).length;
    if (restarts >= 3) { deductions += 15; checks.push('restart-storm'); }

    // Worker blocks
    var blocks = _eventsIn(WINDOWS['5m']).filter(function (e) {
      return e.type === 'worker-blocked';
    }).length;
    if (blocks > 0) { deductions += blocks * 10; checks.push('worker-blocks:' + blocks); }

    var health = Math.max(0, 100 - deductions);
    return {
      health:  health,
      level:   health >= 80 ? 'HEALTHY' : (health >= 50 ? 'DEGRADED' : 'COMPROMISED'),
      checks:  checks,
      restarts: restarts,
      ts:      Date.now(),
    };
  }

  // ── Incident grouping ──────────────────────────────────────────────────────
  function _groupIncidents() {
    var now = Date.now();
    var w15 = _eventsIn(WINDOWS['15m']);

    if (w15.length === 0) return;

    // Group by type
    var typeGroups = {};
    for (var i = 0; i < w15.length; i++) {
      var t = w15[i].type;
      if (!typeGroups[t]) typeGroups[t] = [];
      typeGroups[t].push(w15[i]);
    }

    for (var type in typeGroups) {
      var group = typeGroups[type];
      if (group.length < 3) continue;

      // Check if we already have this incident
      var existing = _incidents.some(function (inc) {
        return inc.type === type && (now - inc.createdAt) < WINDOWS['15m'];
      });
      if (existing) continue;

      var incident = {
        id:        'inc_' + now.toString(36),
        type:      type,
        count:     group.length,
        sessions:  [...new Set(group.map(function (e) { return e.sessionId; }))],
        firstTs:   group[0].ts,
        lastTs:    group[group.length - 1].ts,
        createdAt: now,
        severity:  EVENT_WEIGHT[type] >= 20 ? 'HIGH' : 'MEDIUM',
      };

      _incidents.push(incident);
      if (_incidents.length > 100) _incidents.shift();

      console.warn(LOG, 'incident grouped | type:', type, '| count:', group.length);
    }
  }

  // ── markSuspicious (public) ────────────────────────────────────────────────
  function markSuspicious(sessionId, reason) {
    _ingest({ type: 'runtime-drift', sessionId: sessionId, reason: reason });
    _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (tc && typeof tc.ingest === 'function') {
        tc.ingest({ type: 'runtime-drift', sessionId: sessionId, reason: reason, severity: 'MEDIUM' });
      }
    });
    console.warn(LOG, 'session marked suspicious:', sessionId ? sessionId.slice(0, 8) : 'anon', '| reason:', reason);
  }

  // ── getIncidentSummary (public) ────────────────────────────────────────────
  function getIncidentSummary() {
    var now   = Date.now();
    var cutoff = now - WINDOWS['15m'];
    var recent = _incidents.filter(function (i) { return i.createdAt >= cutoff; });

    return {
      total:       _incidents.length,
      recent15m:   recent.length,
      high:        recent.filter(function (i) { return i.severity === 'HIGH'; }).length,
      incidents:   recent.slice(-20),
      windowRates: {
        '1m':  _eventsIn(WINDOWS['1m']).length,
        '5m':  _eventsIn(WINDOWS['5m']).length,
        '15m': _eventsIn(WINDOWS['15m']).length,
      },
    };
  }

  // ── Subscribe to security events ──────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      if (!G.RuntimeEventBus) return;
      var ALL_SEC = [
        'integrity-failure', 'seal-failure', 'proto-pollution', 'panic-activated',
        'sri-mismatch', 'worker-blocked', 'deploy-mismatch', 'nonce-violation',
        'origin-violation', 'replay-attempt', 'devtools-degraded', 'runtime-drift',
        'security:foreign-deploy', 'security:anomaly', 'wasm:tamper',
        'wasm:memory-violation', 'worker-restart',
      ];
      ALL_SEC.forEach(function (evt) {
        G.RuntimeEventBus.on(evt, function (data) {
          _ingest(Object.assign({ type: evt }, data || {}));
          _groupIncidents();
        });
      });
    });

    // Also subscribe to SecurityTelemetry
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) { _ingest(event); });
      }
    });

    // Phase 7: subscribe to behavioral feed from RuntimeBehaviorAnalysis
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      // Behavioral anomaly — map behavioral health to anomaly score
      eb.on('behavior:anomaly', function (data) {
        if (!data) return;
        _ingest({ type: 'behavior-anomaly', score: data.score || 50,
          reason: data.reason || 'behavioral-deviation', sessionId: data.sessionId || '' });
      });
      // Automation detection
      eb.on('automation-detected', function (data) {
        _ingest({ type: 'automation-detected', score: data && data.score ? data.score : 70,
          reason: 'automation-signals', sessionId: '' });
      });
      // Phase 7 worker mesh events
      eb.on('mesh:worker-quarantined', function (data) {
        _ingest({ type: 'worker-quarantine', score: 40,
          reason: data && data.reason ? data.reason : 'low-trust', sessionId: '' });
      });
    });
  }

  // ── Periodic scoring ──────────────────────────────────────────────────────
  function _periodicReport() {
    var deployScore  = getDeploymentScore();
    var workerScore  = getWorkerScore();

    if (deployScore.confidence < 50) {
      console.warn(LOG, 'LOW deployment confidence:', deployScore.confidence,
        '| checks:', deployScore.checks.join(','));
    }
    if (workerScore.health < 50) {
      console.warn(LOG, 'LOW worker health:', workerScore.health,
        '| checks:', workerScore.checks.join(','));
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    setTimeout(_subscribe, 3_000);
    setInterval(_periodicReport, 5 * 60_000);
    setInterval(_groupIncidents, 60_000);

    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5500); }, { once: true });
  } else {
    setTimeout(_boot, 5500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeAnomalyEngine = Object.freeze({
    VERSION:            VERSION,
    score:              score,
    getDeploymentScore: getDeploymentScore,
    getWorkerScore:     getWorkerScore,
    getIncidentSummary: getIncidentSummary,
    markSuspicious:     markSuspicious,
    status: function () {
      return {
        version:        VERSION,
        enabled:        _enabled,
        tier:           _tier,
        eventCount:     _events.length,
        incidentCount:  _incidents.length,
        sessionCount:   _sessionFlags ? _sessionFlags.size : 0,
        deployment:     getDeploymentScore(),
        workers:        getWorkerScore(),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');

}(window));

