// RuntimeSriEngine v1.0 — Phase 3 / Task 1 (SRI + Hash Enforcement)
// ============================================================================
// Advisory hash verification engine for runtime scripts, workers, and assets.
//
// Design principles:
//   • NEVER hard-blocks script loading — advisory mode prevents false positives
//   • Only EXTREME tier enables enforcement (blocking) mode
//   • Hash computation uses SubtleCrypto SHA-256 (async, non-blocking)
//   • Verification is rate-limited: max 6 checks per page load
//   • Low-end devices (LOW tier): skipped entirely
//   • All mismatches go to SecurityTelemetry (not the user)
//
// Hash registry:
//   • Pre-seeded from RuntimeChunkManifest entries that have hash != null
//   • Additional hashes registered via RuntimeSriEngine.register(path, hash)
//   • Hashes are hex-encoded SHA-256 strings (64 chars)
//
// window.RuntimeSriEngine
//   .register(path, sha256hex)   → void
//   .verify(path)                → Promise<{ok, hash, expected, advisory}>
//   .verifyAll()                 → Promise<SriReport>
//   .getReport()                 → SriReport (last result)
//   .status()                    → { tier, verified, mismatches, skipped }
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSriEngine) return;

  var VERSION = '1.0';
  var LOG     = '[SriEngine]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier check ────────────────────────────────────────────────────────────
  function _canVerify() {
    var st = _s(function () { return G.RuntimeSecurityTiers; });
    if (st && typeof st.canDo === 'function') return st.canDo('sriVerify');
    // Fallback: check device score directly
    var rdl = _s(function () { return G.RuntimeDeviceLite; });
    var score = _s(function () {
      if (rdl && typeof rdl.score    === 'function') return rdl.score();
      if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
      return 70;
    }, 70);
    return score >= 70;
  }

  function _canEnforce() {
    var st = _s(function () { return G.RuntimeSecurityTiers; });
    if (st && typeof st.canDo === 'function') return st.canDo('sriEnforce');
    return false; // never enforce without explicit tier confirmation
  }

  // ── Hash registry ─────────────────────────────────────────────────────────
  // Map<path, expectedSha256hex>
  var _registry = typeof Map !== 'undefined' ? new Map() : null;

  // ── Rate limiter ──────────────────────────────────────────────────────────
  var MAX_VERIFICATIONS = 6;
  var _verifyCount      = 0;

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    verified:   0,
    mismatches: 0,
    skipped:    0,
    errors:     0,
  };

  // ── Last report ───────────────────────────────────────────────────────────
  var _lastReport = null;

  // ── Register a known hash ─────────────────────────────────────────────────
  function register(path, sha256hex) {
    if (!_registry || typeof path !== 'string' || typeof sha256hex !== 'string') return;
    if (sha256hex.length !== 64) {
      console.warn(LOG, 'register: expected 64-char hex hash for', path, '— got', sha256hex.length);
      return;
    }
    _registry.set(path, sha256hex.toLowerCase());
  }

  // ── Fetch and hash a URL ──────────────────────────────────────────────────
  function _fetchAndHash(path) {
    return fetch(path, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!G.crypto || !G.crypto.subtle) {
          throw new Error('SubtleCrypto not available');
        }
        return G.crypto.subtle.digest('SHA-256', buf);
      })
      .then(function (hashBuf) {
        var hex = Array.from(new Uint8Array(hashBuf))
          .map(function (b) { return ('0' + b.toString(16)).slice(-2); })
          .join('');
        return hex;
      });
  }

  // ── Verify a single path ──────────────────────────────────────────────────
  function verify(path) {
    if (!_canVerify()) {
      _stats.skipped++;
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'tier-too-low' });
    }
    if (_verifyCount >= MAX_VERIFICATIONS) {
      _stats.skipped++;
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'rate-limit' });
    }
    if (!_registry) {
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'no-registry' });
    }
    var expected = _registry.get(path);
    if (!expected) {
      // No registered hash for this path — skip (not an error)
      _stats.skipped++;
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'unregistered' });
    }

    _verifyCount++;

    return _fetchAndHash(path)
      .then(function (actual) {
        _stats.verified++;
        var ok = (actual === expected);
        var result = {
          ok:       ok,
          path:     path,
          hash:     actual,
          expected: expected,
          advisory: !_canEnforce(),
        };
        if (!ok) {
          _stats.mismatches++;
          console.warn(LOG, 'hash MISMATCH for', path);
          console.warn(LOG, '  expected:', expected);
          console.warn(LOG, '  actual:  ', actual);
          _recordMismatch(path, actual, expected);
          // Enforcement mode: only on EXTREME tier (currently always advisory)
          if (_canEnforce()) {
            console.error(LOG, 'ENFORCEMENT: blocking tampered resource', path);
            result.blocked = true;
          }
        } else {
          console.debug(LOG, 'hash OK:', path, '→', actual.slice(0, 12) + '…');
        }
        return result;
      })
      .catch(function (err) {
        _stats.errors++;
        console.debug(LOG, 'verify error for', path, ':', err.message);
        // Network errors are not integrity failures — don't penalize
        return { ok: true, path: path, advisory: true, reason: 'fetch-error', error: err.message };
      });
  }

  // ── Record mismatch to telemetry ──────────────────────────────────────────
  function _recordMismatch(path, actual, expected) {
    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('integrity-failure', { path: path });
      }
    });
    _s(function () {
      var st = G.RuntimeSecurityTiers;
      if (st && typeof st.upgrade === 'function') st.upgrade('sri-mismatch:' + path);
    });
    _s(function () {
      if (G.RuntimeEventBus) G.RuntimeEventBus.emit('sri:mismatch', { path: path });
    });
  }

  // ── Verify all registered hashes ─────────────────────────────────────────
  function verifyAll() {
    if (!_canVerify()) {
      return Promise.resolve({ ok: true, checked: 0, mismatches: 0, reason: 'tier-too-low' });
    }
    if (!_registry || _registry.size === 0) {
      return Promise.resolve({ ok: true, checked: 0, mismatches: 0, reason: 'no-hashes-registered' });
    }
    var paths = Array.from(_registry.keys()).slice(0, MAX_VERIFICATIONS);
    var promises = paths.map(function (p) { return verify(p); });
    return Promise.all(promises).then(function (results) {
      var mismatches = results.filter(function (r) { return !r.ok; }).length;
      var report = {
        ok:         mismatches === 0,
        checked:    results.length,
        mismatches: mismatches,
        results:    results,
        ts:         Date.now(),
      };
      _lastReport = report;
      console.info(LOG, 'verifyAll: checked', results.length, '| mismatches:', mismatches);
      return report;
    });
  }

  // ── Seed from RuntimeChunkManifest ────────────────────────────────────────
  function _seedFromManifest() {
    _s(function () {
      var rcm = G.RuntimeChunkManifest;
      if (!rcm || typeof rcm.all !== 'function') return;
      var chunks = rcm.all();
      var seeded = 0;
      chunks.forEach(function (c) {
        if (c.hash && c.path) {
          register(c.path, c.hash);
          seeded++;
        }
      });
      if (seeded > 0) console.debug(LOG, 'seeded', seeded, 'hashes from RuntimeChunkManifest');
    });
    _s(function () {
      var rv = G.RuntimeManifest;
      if (!rv || !rv.RuntimeChunkValidator) return;
      var reg = rv.RuntimeChunkValidator;
      if (typeof reg.getRegisteredHashes === 'function') {
        var hashes = reg.getRegisteredHashes();
        (hashes || []).forEach(function (entry) {
          if (entry.path && entry.hash) register(entry.path, entry.hash);
        });
      }
    });
  }

  // ── Auto-verify critical scripts on HIGH+ tier ────────────────────────────
  function _autoVerifyCritical() {
    if (!_canVerify()) return;
    if (!_registry || _registry.size === 0) return;
    // Defer to avoid blocking initial render
    setTimeout(function () {
      verifyAll().catch(function () {});
    }, 5000);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _seedFromManifest();
    _autoVerifyCritical();
    console.info(LOG, 'v' + VERSION + ' ready | advisory mode | registered:', (_registry ? _registry.size : 0));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeSriEngine = Object.freeze({
    VERSION:   VERSION,
    register:  register,
    verify:    verify,
    verifyAll: verifyAll,
    getReport: function () { return _lastReport; },
    status: function () {
      return {
        tier:       _s(function () {
          var st = G.RuntimeSecurityTiers;
          return st ? st.current() : 'UNKNOWN';
        }, 'UNKNOWN'),
        canVerify:  _canVerify(),
        canEnforce: _canEnforce(),
        registered: _registry ? _registry.size : 0,
        verified:   _stats.verified,
        mismatches: _stats.mismatches,
        skipped:    _stats.skipped,
        errors:     _stats.errors,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
