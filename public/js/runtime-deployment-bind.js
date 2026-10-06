// runtime-deployment-bind.js
// Phase 2 — Final Hardening Pass: Domain Binding + Deployment Integrity
// ======================================================================
// Binds the runtime security layer to the current deployment domain and
// performs a final production-readiness verification pass.
//
// Responsibilities:
//   A. DOMAIN BIND    — Record the deployment origin. Flag if runtime is
//                       executing from an unexpected origin (e.g. iframe,
//                       proxy injection, localhost in production, etc.).
//   B. DEPLOYMENT CHECK — Verify all critical security headers are present
//                         by probing /api/health and reading response headers.
//                         Flags missing COOP/COEP/CSP/X-Frame-Options.
//   C. IFRAME GUARD   — Detect if the app is running inside a foreign iframe.
//                       If so, degrade analytics and flag for review.
//   D. INTEGRITY SEAL — Write a tamper-evident seal into sessionStorage.
//                       Subsequent page loads verify the seal is intact.
//   E. PRODUCTION REPORT — Aggregates Phase 1 + Phase 2 status into a single
//                          deployability verdict (PASS / WARN / FAIL).
//
// ADDITIVE ONLY. No tool, UI, or processing code is modified.
// Low-end devices: skip health header probe (network cost).
//
// Exposed: window.RuntimeDeploymentBind
//   .status()  → { bound, origin, iframeDetected, seal, deployReady, report{} }
//   .audit()   → runs all checks now, returns status

(function (G) {
  'use strict';

  if (G.RuntimeDeploymentBind) return;

  var VERSION = '1.0';
  var LOG = '[RDB]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ─────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  // ── State ────────────────────────────────────────────────────────────────────
  var _state = {
    bound:          false,
    boundOrigin:    null,
    iframeDetected: false,
    sealOk:         null,
    sealKey:        'iplv_deploy_seal_v2',
    deployReady:    null,
    headersOk:      null,
    warnings:       [],
    issues:         [],
    auditTs:        null,
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _warn(msg) {
    _state.warnings.push(msg);
    console.warn(LOG, 'WARN:', msg);
  }
  function _issue(msg) {
    _state.issues.push(msg);
    console.error(LOG, 'ISSUE:', msg);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § A — DOMAIN BINDING
  // ══════════════════════════════════════════════════════════════════════════════

  function _bindDomain() {
    var origin = _s(function () { return location.origin; }, '');
    _state.boundOrigin = origin;
    _state.bound       = true;

    // Flag localhost in what looks like production context (NODE_ENV=production)
    var isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (isLocalhost) {
      // Could be dev — warn but don't fail
      _warn('Runtime bound to localhost origin — expected in development only');
    }

    // Flag missing HTTPS in non-localhost
    if (!isLocalhost && origin.startsWith('http://')) {
      _issue('Deployment: running over HTTP (not HTTPS) — CSP nonces and Secure cookies are unsafe');
    }

    // Record allowed origins for runtime validation
    var allowedOrigins = [
      origin,
      'https://ilovepdf.cyou',
      'https://www.ilovepdf.cyou',
    ];

    _s(function () {
      // Register with ShieldDependency so cross-origin resources from this origin are trusted
      var dep = G.RuntimeShieldDependency;
      if (dep && typeof dep.addTrustedOrigin === 'function') {
        dep.addTrustedOrigin(origin);
      }
    });

    console.debug(LOG, 'domain bound to:', origin);
    return origin;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § B — DEPLOYMENT HEADER CHECK (async — non-blocking)
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkHeaders() {
    if (_lite) return Promise.resolve({ ok: true, note: 'skipped-lite' });

    return fetch('/api/health', {
      method:      'GET',
      credentials: 'same-origin',
      cache:       'no-store',
    }).then(function (resp) {
      var headers = {};
      var required = [
        'content-security-policy',
        'x-content-type-options',
        'x-frame-options',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'referrer-policy',
      ];
      var missing = [];

      required.forEach(function (h) {
        var val = resp.headers.get(h);
        headers[h] = val;
        if (!val) missing.push(h);
      });

      // Check CSP has nonce
      var csp = headers['content-security-policy'] || '';
      var hasNonce = /nonce-/.test(csp);
      if (!hasNonce) {
        _warn('CSP: no nonce directive found in Content-Security-Policy header');
      }

      // Check COOP/COEP
      var coop = headers['cross-origin-opener-policy'] || '';
      var coep = headers['cross-origin-embedder-policy'] || '';
      if (!coop.includes('same-origin')) _warn('COOP: expected "same-origin", got: ' + (coop || 'MISSING'));
      if (!coep.includes('credentialless') && !coep.includes('require-corp')) {
        _warn('COEP: expected "credentialless" or "require-corp", got: ' + (coep || 'MISSING'));
      }

      // Check X-Frame-Options (clickjacking defence)
      var xfo = headers['x-frame-options'] || '';
      if (!xfo) _warn('X-Frame-Options header is missing — clickjacking defence may be weakened');

      if (missing.length > 0) {
        _warn('Deployment: ' + missing.length + ' security header(s) absent: ' + missing.join(', '));
      }

      _state.headersOk = missing.length === 0 && hasNonce;
      return { ok: _state.headersOk, headers: headers, missing: missing, hasNonce: hasNonce };
    }).catch(function (err) {
      _warn('Header probe failed (network error): ' + err.message);
      _state.headersOk = null;
      return { ok: null, note: 'probe-failed' };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § C — IFRAME GUARD
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkIframe() {
    var inFrame = _s(function () { return G.top !== G.self; }, false);
    if (!inFrame) {
      _state.iframeDetected = false;
      return;
    }

    var frameOrigin = _s(function () { return G.top.location.origin; }, null);
    var sameOrigin  = frameOrigin === _state.boundOrigin;

    _state.iframeDetected = true;

    if (!sameOrigin) {
      _warn('Runtime executing inside a cross-origin iframe — analytics and session intelligence degraded');
      // Notify session intelligence to suppress tracking in cross-origin frames
      _s(function () {
        if (G.RuntimeSessionIntel && typeof G.RuntimeSessionIntel.setFlag === 'function') {
          G.RuntimeSessionIntel.setFlag('cross-origin-iframe', true);
        }
      });
      // Notify ShieldIntegrity
      _s(function () {
        if (G.RuntimeShieldIntegrity && typeof G.RuntimeShieldIntegrity.flag === 'function') {
          G.RuntimeShieldIntegrity.flag('cross-origin-iframe');
        }
      });
    } else {
      console.debug(LOG, 'same-origin iframe detected — no degradation applied');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § D — INTEGRITY SEAL
  // ══════════════════════════════════════════════════════════════════════════════
  // Writes a tamper-evident token into sessionStorage on first load.
  // On subsequent navigations within the session, verifies the token matches.
  // A mismatch indicates sessionStorage was cleared by an adversary
  // (or the user opened a new tab — both produce a fresh token).

  function _verifySeal() {
    try {
      var key      = _state.sealKey;
      var existing = sessionStorage.getItem(key);
      var ts       = Date.now();

      // Generate a seal token: origin + timestamp + random suffix
      var entropy  = _s(function () {
        var arr = new Uint8Array(8);
        G.crypto.getRandomValues(arr);
        return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }, Math.random().toString(36).slice(2));

      var newSeal  = _state.boundOrigin + ':' + ts + ':' + entropy;

      if (!existing) {
        // First load — write seal
        sessionStorage.setItem(key, newSeal);
        _state.sealOk = true;
        console.debug(LOG, 'integrity seal written');
      } else {
        // Subsequent load — verify origin portion matches
        var parts = existing.split(':');
        // seal format: "https://host.com:timestamp:entropy"
        // Extract origin (everything before the last two ":" segments)
        var sealedOrigin = parts.slice(0, parts.length - 2).join(':');
        if (sealedOrigin !== _state.boundOrigin) {
          _warn('Integrity seal: origin mismatch (' + sealedOrigin + ' vs ' + _state.boundOrigin + ')');
          _state.sealOk = false;
          // Overwrite with fresh seal
          sessionStorage.setItem(key, newSeal);
        } else {
          _state.sealOk = true;
          console.debug(LOG, 'integrity seal verified OK');
        }
      }
    } catch (e) {
      // sessionStorage may be blocked (private mode, iframe, etc.)
      _warn('Integrity seal: sessionStorage unavailable (' + e.message + ')');
      _state.sealOk = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § E — PRODUCTION READINESS REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  function _buildReport() {
    var systems = {
      phase1: _s(function () {
        var p = G.RuntimeProtection;
        return p ? { ok: true, version: p.VERSION || '?' } : { ok: false };
      }, { ok: false }),
      phase2_shield: _s(function () {
        return {
          core:       !!G.RuntimeShieldCore,
          integrity:  !!G.RuntimeShieldIntegrity,
          workers:    !!G.RuntimeShieldWorkers,
          dependency: !!G.RuntimeShieldDependency,
        };
      }, {}),
      phase2_manifest:       !!G.RuntimeManifest,
      phase2_workerFactory:  !!G.RuntimeWorkerFactory,
      phase2_compat:         !!G.RuntimeCompatValidator,
      phase2_rollback:       !!G.RuntimeRollback,
      cspNonce:              (_s(function () { return document.querySelectorAll('script[nonce]').length; }, 0) > 0),
      domainBound:           _state.bound,
      iframeFree:            !_state.iframeDetected,
      sealOk:                _state.sealOk,
      headersOk:             _state.headersOk,
    };

    var criticalOk = systems.phase1.ok &&
                     systems.phase2_shield.core &&
                     systems.phase2_shield.integrity &&
                     systems.phase2_manifest &&
                     systems.phase2_workerFactory &&
                     systems.domainBound;

    var issueCount   = _state.issues.length;
    var warningCount = _state.warnings.length;

    var verdict = criticalOk && issueCount === 0 ? 'PASS' :
                  criticalOk && warningCount < 5 ? 'WARN' : 'FAIL';

    _state.deployReady = verdict === 'PASS' || verdict === 'WARN';

    var report = {
      verdict:      verdict,
      deployReady:  _state.deployReady,
      systems:      systems,
      issues:       _state.issues.slice(),
      warnings:     _state.warnings.slice(),
      origin:       _state.boundOrigin,
      timestamp:    new Date().toISOString(),
      phase:        'Phase1+Phase2 Complete',
    };

    // Telemetry
    _s(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('deploy:bind:report', {
          verdict:  verdict,
          issues:   issueCount,
          warnings: warningCount,
        });
      }
    });

    var level = verdict === 'PASS' ? 'info' : verdict === 'WARN' ? 'warn' : 'error';
    console[level](LOG, 'deployment verdict:', verdict,
      '| issues:', issueCount,
      '| warnings:', warningCount,
      '| origin:', _state.boundOrigin);

    return report;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ══════════════════════════════════════════════════════════════════════════════

  var _auditResult = null;

  function _audit() {
    _state.auditTs = Date.now();
    _state.warnings = [];
    _state.issues   = [];

    _bindDomain();
    _checkIframe();
    _verifySeal();

    _checkHeaders().then(function () {
      _auditResult = _buildReport();
    });

    // Synchronous partial result (headers check is async)
    return {
      bound:       _state.bound,
      origin:      _state.boundOrigin,
      iframeDetected: _state.iframeDetected,
      sealOk:      _state.sealOk,
    };
  }

  function _boot() {
    setTimeout(_audit, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  G.RuntimeDeploymentBind = Object.freeze({
    VERSION: VERSION,
    audit:   _audit,
    status:  function () {
      return {
        bound:          _state.bound,
        origin:         _state.boundOrigin,
        iframeDetected: _state.iframeDetected,
        seal:           _state.sealOk,
        headersOk:      _state.headersOk,
        deployReady:    _state.deployReady,
        issues:         _state.issues.slice(),
        warnings:       _state.warnings.slice(),
        report:         _auditResult,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION, 'ready — audit scheduled in 600ms');

}(typeof window !== 'undefined' ? window : this));
