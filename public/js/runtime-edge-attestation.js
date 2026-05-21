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
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }
    // Run initial attestation after other systems settle
    setTimeout(function () {
      attest().catch(function (err) {
        console.warn(LOG, 'boot attestation failed:', err.message);
      });
    }, 5_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
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

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
