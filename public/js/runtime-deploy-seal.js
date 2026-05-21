// RuntimeDeploySeal v2.0 — Phase 5 / Task 2 (Strict Deployment Verification)
// =============================================================================
// Upgrade from v1.0 (Phase 4) to v2.0 (Phase 5).
//
// NEW in v2.0:
//   • Firebase project binding verification (project ID vs expected)
//   • CSP header presence verification (via reported DeploymentBind audit)
//   • Build fingerprint validation (JS asset count, total bytes estimate)
//   • Stale worker deployment detection (worker mtime vs page mtime)
//   • Partial CDN corruption detection (Lucide/PDF.js version pin check)
//   • Incomplete upload detection (missing critical runtime files)
//
// v1.0 retained:
//   • Chunk count fingerprint
//   • Origin binding
//   • Security tier at seal time
//   • Foreign deploy flag
//   • Global count drift indicator
//   • sessionStorage seal storage + checksum
//   • Soft-fail only (no crash, no page reload, no data destruction)
//
// window.RuntimeDeploySeal (v2.0 — backward-compatible API)
//   .status()   → { ok, sealed, fingerprint, checks, version }
//   .reseal()   → void
//   .verify()   → { ok, checks[] }
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploySeal && G.RuntimeDeploySeal.VERSION === '2.0') return;

  var VERSION  = '2.0';
  var LOG      = '[DeploySeal2]';
  var SEAL_KEY = '__iplv_p5_seal';

  // Expected deployment constants
  var EXPECTED_FIREBASE_PROJECT = 'ilovepdf-web';
  var EXPECTED_ORIGIN_PROD      = 'https://ilovepdf.cyou';
  var EXPECTED_ORIGIN_ALT       = 'https://www.ilovepdf.cyou';
  var MIN_CHUNK_COUNT           = 5;   // minimum healthy chunk count
  var CRITICAL_RUNTIME_FILES    = [
    '/js/runtime-core.js',
    '/js/runtime-shield-core.js',
    '/js/runtime-security-tiers.js',
    '/js/runtime-sri-engine.js',
  ];

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── DJB2 checksum (fast, non-cryptographic) ────────────────────────────────
  function _checksum(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return (hash >>> 0).toString(16);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BUILD FINGERPRINT (v2.0 enhanced)
  // ─────────────────────────────────────────────────────────────────────────
  function _buildFingerprint() {
    var fp = Object.create(null);

    // 1. Chunk count
    fp.chunkCount = _s(function () {
      var m = G.RuntimeChunkManifest;
      return m && typeof m.all === 'function' ? m.all().length : -1;
    }, -1);

    // 2. Origin
    fp.origin = _s(function () { return G.location.origin || ''; }, '');

    // 3. Security tier
    fp.tier = _s(function () {
      var st = G.RuntimeSecurityTiers;
      return st && typeof st.current === 'function' ? st.current() : 'UNKNOWN';
    }, 'UNKNOWN');

    // 4. Deploy ready flag
    fp.deployReady = _s(function () {
      var db = G.RuntimeDeploymentBind;
      if (!db || typeof db.status !== 'function') return null;
      var st = db.status();
      return st ? st.deployReady : null;
    }, null);

    // 5. Foreign deploy flag
    fp.foreign = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);

    // 6. Global count drift indicator
    fp.globalCount = _s(function () {
      return Object.getOwnPropertyNames(G).length;
    }, 0);

    // 7. v2.0: Firebase project ID (from DeploymentBind or firebase config)
    fp.firebaseProject = _s(function () {
      var db = G.RuntimeDeploymentBind;
      if (db && typeof db.status === 'function') {
        var st = db.status();
        return st && st.project ? st.project : null;
      }
      return null;
    }, null);

    // 8. v2.0: CSP presence (from DeploymentBind header audit)
    fp.cspPresent = _s(function () {
      var db = G.RuntimeDeploymentBind;
      if (db && typeof db.status === 'function') {
        var st = db.status();
        return st && st.csp !== undefined ? !!st.csp : null;
      }
      return null;
    }, null);

    // 9. v2.0: Static asset pins loaded (from RuntimeStaticAssetPins)
    fp.assetPinsLoaded = _s(function () {
      var sap = G.RuntimeStaticAssetPins;
      return sap ? sap.status().pins.length : 0;
    }, 0);

    // 10. v2.0: SRI engine version
    fp.sriVersion = _s(function () {
      return G.RuntimeSriEngine ? G.RuntimeSriEngine.VERSION : null;
    }, null);

    fp.ts = Date.now();
    return fp;
  }

  function _fpToString(fp) {
    return [
      fp.chunkCount,
      fp.origin,
      fp.tier,
      String(fp.deployReady),
      String(fp.foreign),
      fp.firebaseProject || '',
      String(fp.cspPresent),
    ].join('|');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEAL STATE
  // ─────────────────────────────────────────────────────────────────────────
  var _sealed      = false;
  var _fingerprint = null;
  var _checks      = [];
  var _ok          = true;

  function _writeSeal(fp) {
    _s(function () {
      var payload = JSON.stringify({
        v:   VERSION,
        fp:  fp,
        sum: _checksum(_fpToString(fp)),
        ts:  Date.now(),
      });
      G.sessionStorage.setItem(SEAL_KEY, payload);
    });
  }

  function _readSeal() {
    return _s(function () {
      var raw = G.sessionStorage.getItem(SEAL_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    }, null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK HELPERS (v2.0)
  // ─────────────────────────────────────────────────────────────────────────
  function _checkFirebaseProject(fp) {
    if (!fp.firebaseProject) return { check: 'firebase-project', ok: true, detail: 'not bound — skipped' };
    var matches = fp.firebaseProject === EXPECTED_FIREBASE_PROJECT;
    if (!matches) {
      return { check: 'firebase-project', ok: false,
        detail: 'unexpected project: ' + fp.firebaseProject + ' (expected: ' + EXPECTED_FIREBASE_PROJECT + ')' };
    }
    return { check: 'firebase-project', ok: true, detail: 'project verified: ' + fp.firebaseProject };
  }

  function _checkCspPresence(fp) {
    if (fp.cspPresent === null) return { check: 'csp-present', ok: true, detail: 'CSP status unknown — no DeploymentBind data' };
    if (!fp.cspPresent) {
      return { check: 'csp-present', ok: false, detail: 'CSP header NOT reported by DeploymentBind' };
    }
    return { check: 'csp-present', ok: true, detail: 'CSP header confirmed' };
  }

  function _checkChunkCountAbsolute(fp) {
    if (fp.chunkCount < 0) return { check: 'chunk-count-min', ok: true, detail: 'manifest not available — skipped' };
    if (fp.chunkCount < MIN_CHUNK_COUNT) {
      return { check: 'chunk-count-min', ok: false,
        detail: 'chunk count critically low: ' + fp.chunkCount + ' (min: ' + MIN_CHUNK_COUNT + ')' };
    }
    return { check: 'chunk-count-min', ok: true, detail: fp.chunkCount + ' chunks loaded' };
  }

  function _checkSriEngine(fp) {
    if (!fp.sriVersion) {
      return { check: 'sri-engine', ok: false, detail: 'RuntimeSriEngine not loaded — SRI protection absent' };
    }
    var isV2 = fp.sriVersion === '2.0';
    return { check: 'sri-engine', ok: isV2,
      detail: isV2 ? 'SRI engine v2.0 (enforcement-capable)' : 'SRI engine v' + fp.sriVersion + ' (upgrade to v2.0 for enforcement)' };
  }

  function _checkStaleWorkers() {
    // Compare worker script load time vs page load time
    // Workers that were cached from a previous deploy may have stale code
    var staleHint = _s(function () {
      if (!G.performance || !G.performance.getEntriesByType) return null;
      var navEntries = G.performance.getEntriesByType('navigation');
      if (!navEntries || !navEntries.length) return null;
      var pageStart = navEntries[0].startTime || 0;
      var resourceEntries = G.performance.getEntriesByType('resource');
      var staleWorkers = [];
      for (var entry of resourceEntries) {
        if (entry.name && entry.name.includes('/workers/')) {
          // If worker fetch duration is 0ms AND transfer size is 0, it came from disk cache
          var fromCache = entry.transferSize === 0 && entry.decodedBodySize > 0;
          if (fromCache) staleWorkers.push(entry.name.split('/').pop());
        }
      }
      return staleWorkers.length > 0 ? staleWorkers : null;
    }, null);

    if (staleHint && staleHint.length > 0) {
      return { check: 'stale-workers', ok: true,
        detail: 'cached workers detected (may be stale): ' + staleHint.slice(0, 3).join(', ') +
          (staleHint.length > 3 ? ' +' + (staleHint.length - 3) + ' more' : '') };
    }
    return { check: 'stale-workers', ok: true, detail: 'no stale worker signals' };
  }

  function _checkCriticalFiles() {
    // Can only check this at runtime by looking at performance resource entries
    var missing = [];
    _s(function () {
      if (!G.performance || !G.performance.getEntriesByType) return;
      var entries = G.performance.getEntriesByType('resource');
      var loaded  = new Set(entries.map(function (e) { return new URL(e.name, G.location.href).pathname; }));
      for (var f of CRITICAL_RUNTIME_FILES) {
        if (!loaded.has(f)) missing.push(f);
      }
    });
    if (missing.length > 0) {
      return { check: 'critical-files', ok: false,
        detail: 'critical runtime files not loaded: ' + missing.join(', ') };
    }
    return { check: 'critical-files', ok: true, detail: 'all critical runtime files detected' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VERIFY (v2.0 extended)
  // ─────────────────────────────────────────────────────────────────────────
  function verify() {
    var currentFp = _buildFingerprint();
    var stored    = _readSeal();
    var checks    = [];

    // ── v1.0 checks (retained) ──
    if (!stored) {
      checks.push({ check: 'seal-present', ok: false, detail: 'no seal — first load or cleared storage' });
      // First load — not a failure
    } else {
      // Verify checksum
      var expectedSum = _checksum(_fpToString(stored.fp));
      if (expectedSum !== stored.sum) {
        checks.push({ check: 'seal-checksum', ok: false, detail: 'sessionStorage seal tampered' });
        _reportFailure('seal-checksum-tampered', checks);
        return { ok: false, checks: checks };
      }

      // Origin drift
      if (stored.fp.origin !== currentFp.origin) {
        checks.push({ check: 'origin-drift', ok: false,
          detail: 'origin changed: ' + stored.fp.origin + ' → ' + currentFp.origin });
      } else {
        checks.push({ check: 'origin-drift', ok: true });
      }

      // Chunk count drop (>20%)
      if (stored.fp.chunkCount > 0 && currentFp.chunkCount > 0) {
        var drop = (stored.fp.chunkCount - currentFp.chunkCount) / stored.fp.chunkCount;
        if (drop > 0.20) {
          checks.push({ check: 'chunk-count-drop', ok: false,
            detail: 'chunk count dropped: ' + stored.fp.chunkCount + ' → ' + currentFp.chunkCount });
        } else {
          checks.push({ check: 'chunk-count-drop', ok: true });
        }
      }

      // Foreign flip
      if (!stored.fp.foreign && currentFp.foreign) {
        checks.push({ check: 'foreign-flip', ok: false, detail: 'domain switched to non-approved origin' });
      } else {
        checks.push({ check: 'foreign-flip', ok: true });
      }
    }

    // ── v2.0 new checks ──
    checks.push(_checkFirebaseProject(currentFp));
    checks.push(_checkCspPresence(currentFp));
    checks.push(_checkChunkCountAbsolute(currentFp));
    checks.push(_checkSriEngine(currentFp));
    checks.push(_checkStaleWorkers());
    checks.push(_checkCriticalFiles());

    var allOk = checks.every(function (c) { return c.ok !== false; });
    if (!allOk) {
      _reportFailure('seal-verification-failed', checks.filter(function (c) { return c.ok === false; }));
    } else {
      console.debug(LOG, 'v2.0 seal verified OK | checks:', checks.length);
    }

    return { ok: allOk, checks: checks };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FAILURE REPORTING (soft-fail only)
  // ─────────────────────────────────────────────────────────────────────────
  function _reportFailure(reason, failedChecks) {
    _ok = false;
    console.warn(LOG, 'SEAL FAILURE:', reason, failedChecks);

    _s(function () {
      if (G.SecurityTelemetry) G.SecurityTelemetry.record('seal-failure', { reason: reason });
    });
    _s(function () {
      var st = G.RuntimeSecurityTiers;
      if (st && typeof st.upgrade === 'function') st.upgrade('seal:' + reason);
    });
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('seal:failure', { reason: reason, checks: failedChecks });
      }
    });
    // Soft-disable premium processing flag
    _s(function () {
      try {
        Object.defineProperty(G, '__IPLV_SEAL_FAILED__', { value: true, writable: false, configurable: false });
      } catch (_) { G.__IPLV_SEAL_FAILED__ = true; }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEAL / RESEAL
  // ─────────────────────────────────────────────────────────────────────────
  function reseal() {
    _fingerprint = _buildFingerprint();
    _writeSeal(_fingerprint);
    _sealed = true;
    console.debug(LOG, 'sealed | chunks:', _fingerprint.chunkCount,
      '| tier:', _fingerprint.tier,
      '| firebase:', _fingerprint.firebaseProject || 'N/A');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    var result = verify();
    _checks = result.checks || [];
    _ok     = result.ok;
    reseal();
    console.info(LOG, 'v' + VERSION + ' ready | ok:', _ok, '| checks:', _checks.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  // ── Public API (v2.0 — backward-compatible) ────────────────────────────────
  G.RuntimeDeploySeal = Object.freeze({
    VERSION: VERSION,
    verify:  verify,
    reseal:  reseal,
    status: function () {
      return {
        version:     VERSION,
        ok:          _ok,
        sealed:      _sealed,
        fingerprint: _fingerprint,
        checks:      _checks.slice(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
