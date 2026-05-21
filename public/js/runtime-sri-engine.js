// RuntimeSriEngine v2.0 — Phase 4 / Task 2 (Real SRI Enforcement)
// ============================================================================
// Upgraded from v1.0 (advisory) to v2.0 (HIGH=report-only, EXTREME=hard-block)
//
// Phase 4 additions over v1.0:
//   • HIGH tier  → report-only (same as before, but richer reporting)
//   • EXTREME tier → hard-block: quarantine chunk, block tampered workers
//   • Quarantine registry: Map<path, { reason, ts, retries }>
//   • Retry validation: up to 2 retries on fetch-error before quarantine
//   • Stale-cache bust: re-fetch with cache:'reload' on 2nd attempt
//   • Dynamic import support: verify() accepts data: URIs (skipped) and blob: (skip)
//   • Deferred chunk support: verifyDeferred() — called after lazy-loaded chunks resolve
//   • Worker tamper response: emits 'sri:worker-blocked' to RuntimeEventBus
//
// Tier mapping (via RuntimeSecurityTiers.canDo):
//   sriVerify   → enabled on MEDIUM+
//   sriEnforce  → enabled on EXTREME only
//
// window.RuntimeSriEngine (v2.0 API — backward-compatible with v1.0)
//   .register(path, sha256hex)    → void
//   .verify(path)                 → Promise<SriResult>
//   .verifyAll()                  → Promise<SriReport>
//   .verifyDeferred(path)         → Promise<SriResult>  ← NEW
//   .quarantine(path, reason)     → void                ← NEW
//   .isQuarantined(path)          → boolean             ← NEW
//   .getQuarantineList()          → Array               ← NEW
//   .getReport()                  → SriReport
//   .status()                     → StatusObject
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSriEngine && G.RuntimeSriEngine.VERSION === '2.0') return;

  var VERSION = '2.0';
  var LOG     = '[SriEngine2]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier checks ───────────────────────────────────────────────────────────
  function _canVerify() {
    var st = _s(function () { return G.RuntimeSecurityTiers; });
    if (st && typeof st.canDo === 'function') return st.canDo('sriVerify');
    var rdl = _s(function () { return G.RuntimeDeviceLite; });
    var score = _s(function () {
      if (rdl && typeof rdl.score    === 'function') return rdl.score();
      if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
      return 70;
    }, 70);
    return score >= 50; // MEDIUM+ for v2.0
  }

  function _canEnforce() {
    var st = _s(function () { return G.RuntimeSecurityTiers; });
    if (st && typeof st.canDo === 'function') return st.canDo('sriEnforce');
    return false;
  }

  function _currentTier() {
    return _s(function () {
      var st = G.RuntimeSecurityTiers;
      return st && typeof st.current === 'function' ? st.current() : 'UNKNOWN';
    }, 'UNKNOWN');
  }

  // ── Hash registry: Map<path, expectedSha256hex> ───────────────────────────
  var _registry = typeof Map !== 'undefined' ? new Map() : null;

  // ── Quarantine registry: Map<path, { reason, ts, retries }> ──────────────
  var _quarantine = typeof Map !== 'undefined' ? new Map() : null;
  var MAX_RETRIES = 2;

  // ── Rate limiter ──────────────────────────────────────────────────────────
  var MAX_VERIFICATIONS = 12; // v2.0 raises cap for deferred chunk support
  var _verifyCount      = 0;

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    verified:    0,
    mismatches:  0,
    skipped:     0,
    errors:      0,
    quarantined: 0,
    blocked:     0,
    retries:     0,
    deferred:    0,
  };

  // ── Last full report ──────────────────────────────────────────────────────
  var _lastReport = null;

  // ── Register a known hash ─────────────────────────────────────────────────
  function register(path, sha256hex) {
    if (!_registry || typeof path !== 'string' || typeof sha256hex !== 'string') return;
    if (sha256hex.length !== 64) {
      console.warn(LOG, 'register: expected 64-char hex for', path, '— got length', sha256hex.length);
      return;
    }
    _registry.set(path, sha256hex.toLowerCase());
  }

  // ── Quarantine management ─────────────────────────────────────────────────
  function quarantine(path, reason) {
    if (!_quarantine) return;
    var existing = _quarantine.get(path) || { retries: 0 };
    _quarantine.set(path, { reason: reason || 'unknown', ts: Date.now(), retries: existing.retries });
    _stats.quarantined++;
    console.warn(LOG, 'QUARANTINED:', path, '| reason:', reason);
    _s(function () {
      if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', { path: path, reason: reason });
    });
    _s(function () {
      if (G.RuntimeEventBus) G.RuntimeEventBus.emit('sri:quarantine', { path: path, reason: reason });
    });
  }

  function isQuarantined(path) {
    return !!(_quarantine && _quarantine.has(path));
  }

  function getQuarantineList() {
    if (!_quarantine) return [];
    var list = [];
    _quarantine.forEach(function (v, k) { list.push({ path: k, reason: v.reason, ts: v.ts }); });
    return list;
  }

  // ── Fetch and hash a URL ──────────────────────────────────────────────────
  function _fetchAndHash(path, bustCache) {
    var cacheMode = bustCache ? 'reload' : 'no-store';
    return fetch(path, { cache: cacheMode, credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!G.crypto || !G.crypto.subtle) throw new Error('SubtleCrypto unavailable');
        return G.crypto.subtle.digest('SHA-256', buf);
      })
      .then(function (hashBuf) {
        return Array.from(new Uint8Array(hashBuf))
          .map(function (b) { return ('0' + b.toString(16)).slice(-2); })
          .join('');
      });
  }

  // ── Core verify logic (internal) ──────────────────────────────────────────
  function _doVerify(path, attempt) {
    attempt = attempt || 1;
    var bustCache = attempt > 1; // stale-cache bust on retry

    return _fetchAndHash(path, bustCache)
      .then(function (actual) {
        _stats.verified++;
        var expected = _registry ? _registry.get(path) : null;
        var ok = !expected || (actual === expected);

        var result = {
          ok:        ok,
          path:      path,
          hash:      actual,
          expected:  expected || null,
          advisory:  !_canEnforce(),
          tier:      _currentTier(),
          attempt:   attempt,
        };

        if (!ok) {
          _stats.mismatches++;
          console.warn(LOG, 'v2 MISMATCH:', path);
          console.warn(LOG, '  expected:', expected);
          console.warn(LOG, '  actual:  ', actual);

          _recordMismatch(path, actual, expected);

          if (_canEnforce()) {
            // EXTREME tier: hard-block
            _stats.blocked++;
            result.blocked = true;
            quarantine(path, 'hash-mismatch');
            _blockTamperedWorker(path);
            console.error(LOG, 'HARD-BLOCK: tampered resource quarantined:', path);
          } else {
            // HIGH tier: report-only, still quarantine for awareness
            result.quarantined = true;
            quarantine(path, 'hash-mismatch-advisory');
          }
        }
        return result;
      })
      .catch(function (err) {
        // Retry logic: up to MAX_RETRIES on fetch/crypto errors
        if (attempt < MAX_RETRIES) {
          _stats.retries++;
          console.debug(LOG, 'verify error, retry', attempt, '/', MAX_RETRIES, ':', err.message);
          return new Promise(function (res) { setTimeout(res, 800 * attempt); })
            .then(function () { return _doVerify(path, attempt + 1); });
        }
        _stats.errors++;
        console.debug(LOG, 'verify failed after', MAX_RETRIES, 'attempts:', path, '|', err.message);
        return { ok: true, path: path, advisory: true, reason: 'fetch-error', error: err.message };
      });
  }

  // ── Public: verify a single path ─────────────────────────────────────────
  function verify(path) {
    // Skip non-path URLs (blob:, data:, http://cdn)
    if (typeof path === 'string') {
      if (path.startsWith('blob:') || path.startsWith('data:')) {
        _stats.skipped++;
        return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'skip-blob-data' });
      }
      if (path.startsWith('http://') || path.startsWith('https://')) {
        _stats.skipped++;
        return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'skip-cdn' });
      }
    }

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

    // Already quarantined
    if (isQuarantined(path)) {
      _stats.skipped++;
      var q = _quarantine.get(path);
      return Promise.resolve({
        ok:          !_canEnforce(), // enforcement = blocked; advisory = ok:true
        path:        path,
        quarantined: true,
        reason:      'already-quarantined',
        qReason:     q ? q.reason : 'unknown',
      });
    }

    var expected = _registry.get(path);
    if (!expected) {
      _stats.skipped++;
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'unregistered' });
    }

    _verifyCount++;
    return _doVerify(path, 1);
  }

  // ── Deferred chunk verification ───────────────────────────────────────────
  // Called after lazy-loaded / dynamically-imported chunks resolve.
  // Uses a separate counter budget to not exhaust the main limit.
  var _deferredCount = 0;
  var MAX_DEFERRED   = 8;

  function verifyDeferred(path) {
    _stats.deferred++;
    if (_deferredCount >= MAX_DEFERRED) {
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'deferred-rate-limit' });
    }
    if (!_canVerify()) {
      return Promise.resolve({ ok: true, path: path, advisory: true, reason: 'tier-too-low' });
    }
    _deferredCount++;
    return _doVerify(path, 1).then(function (result) {
      result.deferred = true;
      return result;
    });
  }

  // ── Block tampered worker ─────────────────────────────────────────────────
  function _blockTamperedWorker(path) {
    // Only act on worker paths
    if (!path || !path.includes('/workers/')) return;
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.emit('sri:worker-blocked', { path: path });
      }
    });
    // Remove from RuntimeWorkerFactory allowlist if in enforcement mode
    _s(function () {
      var factory = G.RuntimeWorkerFactory;
      if (factory && typeof factory.blockPath === 'function') {
        factory.blockPath(path);
        console.warn(LOG, 'blocked tampered worker from factory:', path);
      }
    });
  }

  // ── Record mismatch ───────────────────────────────────────────────────────
  function _recordMismatch(path, actual, expected) {
    _s(function () {
      if (G.SecurityTelemetry) G.SecurityTelemetry.record('sri-mismatch', { path: path });
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
      return Promise.resolve({ ok: true, checked: 0, mismatches: 0, reason: 'no-hashes' });
    }
    var paths = Array.from(_registry.keys()).slice(0, MAX_VERIFICATIONS);
    return Promise.all(paths.map(function (p) { return verify(p); }))
      .then(function (results) {
        var mismatches = results.filter(function (r) { return !r.ok; }).length;
        var blocked    = results.filter(function (r) { return r.blocked; }).length;
        var report = {
          ok:         mismatches === 0,
          checked:    results.length,
          mismatches: mismatches,
          blocked:    blocked,
          quarantined: getQuarantineList().length,
          enforcing:  _canEnforce(),
          tier:       _currentTier(),
          results:    results,
          ts:         Date.now(),
        };
        _lastReport = report;
        console.info(LOG, 'verifyAll: checked', results.length,
          '| mismatches:', mismatches, '| blocked:', blocked,
          '| enforcing:', _canEnforce());
        return report;
      });
  }

  // ── Seed from RuntimeChunkManifest ────────────────────────────────────────
  function _seedFromManifest() {
    _s(function () {
      var rcm = G.RuntimeChunkManifest;
      if (!rcm || typeof rcm.all !== 'function') return;
      var seeded = 0;
      rcm.all().forEach(function (c) {
        if (c.hash && c.path) { register(c.path, c.hash); seeded++; }
      });
      if (seeded > 0) console.debug(LOG, 'seeded', seeded, 'hashes from RuntimeChunkManifest');
    });
  }

  // ── Auto-verify critical scripts on MEDIUM+ tier ──────────────────────────
  function _autoVerifyCritical() {
    if (!_canVerify()) return;
    if (!_registry || _registry.size === 0) return;
    // Defer so initial render is never blocked
    setTimeout(function () {
      verifyAll().catch(function () {});
    }, 6000); // 6s — longer than v1 to give dynamic imports time to settle
  }

  // ── Listen for dynamic chunk load events ─────────────────────────────────
  function _listenDynamicImports() {
    _s(function () {
      var bus = G.RuntimeEventBus;
      if (!bus || typeof bus.on !== 'function') return;
      bus.on('chunk:loaded', function (data) {
        if (data && data.path) {
          setTimeout(function () { verifyDeferred(data.path).catch(function () {}); }, 200);
        }
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _seedFromManifest();
    _listenDynamicImports();
    _autoVerifyCritical();
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _currentTier(),
      '| verify:', _canVerify(), '| enforce:', _canEnforce(),
      '| registered:', (_registry ? _registry.size : 0));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  // ── Public API (v2.0 — superset of v1.0) ─────────────────────────────────
  G.RuntimeSriEngine = Object.freeze({
    VERSION:          VERSION,
    register:         register,
    verify:           verify,
    verifyAll:        verifyAll,
    verifyDeferred:   verifyDeferred,
    quarantine:       quarantine,
    isQuarantined:    isQuarantined,
    getQuarantineList: getQuarantineList,
    getReport:        function () { return _lastReport; },
    status: function () {
      return {
        tier:        _currentTier(),
        canVerify:   _canVerify(),
        canEnforce:  _canEnforce(),
        registered:  _registry ? _registry.size : 0,
        verified:    _stats.verified,
        mismatches:  _stats.mismatches,
        blocked:     _stats.blocked,
        quarantined: _quarantine ? _quarantine.size : 0,
        retries:     _stats.retries,
        skipped:     _stats.skipped,
        errors:      _stats.errors,
        deferred:    _stats.deferred,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
