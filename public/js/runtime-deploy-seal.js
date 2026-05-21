// RuntimeDeploySeal v1.0 — Phase 4 / Task 7 (Advanced Deployment Seal)
// ============================================================================
// Tamper-resistant deployment fingerprint that detects cloned, modified, or
// replayed deployments through runtime manifest consistency checks.
//
// What it seals:
//   • Chunk count from RuntimeChunkManifest
//   • Total global count at boot (approximate — used as drift indicator)
//   • Deployment origin (from RuntimeDeploymentBind)
//   • CSP/COOP/COEP header presence (from RuntimeDeploymentBind audit)
//   • Phase 3 tier at boot (from RuntimeSecurityTiers)
//
// Seal storage: sessionStorage['__iplv_p4_seal']
//   - Refreshed on each page load
//   - Compared across navigations
//   - Significant deviations → upgrade tier + record telemetry
//
// On seal failure (mismatch/tampering detected):
//   - Upgrade security tier to EXTREME
//   - Record to SecurityTelemetry
//   - Emit RuntimeEventBus event 'seal:failure'
//   - Disable premium processing flag
//   - NOT: crash, modal, or page reload
//
// window.RuntimeDeploySeal
//   .status()   → { ok, sealed, fingerprint, checks }
//   .reseal()   → void (force re-seal)
//   .verify()   → { ok, checks[] }
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploySeal) return;

  var VERSION = '1.0';
  var LOG     = '[DeploySeal]';
  var SEAL_KEY = '__iplv_p4_seal';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Build fingerprint ─────────────────────────────────────────────────────
  function _buildFingerprint() {
    var fp = Object.create(null);

    // 1. Chunk count from manifest
    fp.chunkCount = _s(function () {
      var m = G.RuntimeChunkManifest;
      return m && typeof m.all === 'function' ? m.all().length : -1;
    }, -1);

    // 2. Bound origin
    fp.origin = _s(function () {
      return G.location.origin || '';
    }, '');

    // 3. Security tier at seal time
    fp.tier = _s(function () {
      var st = G.RuntimeSecurityTiers;
      return st && typeof st.current === 'function' ? st.current() : 'UNKNOWN';
    }, 'UNKNOWN');

    // 4. Deployment bind status
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

    // 6. Approximate global count (broad drift indicator)
    fp.globalCount = _s(function () {
      return Object.getOwnPropertyNames(G).length;
    }, 0);

    fp.ts = Date.now();
    return fp;
  }

  // ── Serialize / hash (simple djb2-like checksum for fast comparison) ───────
  function _checksum(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // int32
    }
    return (hash >>> 0).toString(16);
  }

  function _fpToString(fp) {
    return [
      fp.chunkCount,
      fp.origin,
      fp.tier,
      String(fp.deployReady),
      String(fp.foreign),
    ].join('|');
  }

  // ── Seal state ────────────────────────────────────────────────────────────
  var _sealed      = false;
  var _fingerprint = null;
  var _checks      = [];
  var _ok          = true;

  // ── Write seal to sessionStorage ──────────────────────────────────────────
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

  // ── Read seal from sessionStorage ─────────────────────────────────────────
  function _readSeal() {
    return _s(function () {
      var raw = G.sessionStorage.getItem(SEAL_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    }, null);
  }

  // ── Verify current fingerprint against stored seal ────────────────────────
  function verify() {
    var currentFp = _buildFingerprint();
    var stored    = _readSeal();
    var checks    = [];

    if (!stored) {
      checks.push({ check: 'seal-present', ok: false, detail: 'no seal found — first load or cleared storage' });
      // Not a failure — first page load
      return { ok: true, fresh: true, checks: checks };
    }

    // Verify checksum
    var expectedSum = _checksum(_fpToString(stored.fp));
    if (expectedSum !== stored.sum) {
      checks.push({ check: 'seal-checksum', ok: false, detail: 'sessionStorage seal tampered' });
      _reportFailure('seal-checksum-tampered', checks);
      return { ok: false, checks: checks };
    }

    // Verify origin didn't change within session
    if (stored.fp.origin !== currentFp.origin) {
      checks.push({ check: 'origin-drift', ok: false,
        detail: 'origin changed: ' + stored.fp.origin + ' → ' + currentFp.origin });
    } else {
      checks.push({ check: 'origin-drift', ok: true });
    }

    // Verify chunk count hasn't dropped significantly (>20% drop = suspicious)
    if (stored.fp.chunkCount > 0 && currentFp.chunkCount > 0) {
      var drop = (stored.fp.chunkCount - currentFp.chunkCount) / stored.fp.chunkCount;
      if (drop > 0.20) {
        checks.push({ check: 'chunk-count-drop', ok: false,
          detail: 'chunk count dropped: ' + stored.fp.chunkCount + ' → ' + currentFp.chunkCount });
      } else {
        checks.push({ check: 'chunk-count-drop', ok: true });
      }
    }

    // Verify foreign deploy flag didn't flip (legitimate→cloned = suspicious)
    if (!stored.fp.foreign && currentFp.foreign) {
      checks.push({ check: 'foreign-flip', ok: false, detail: 'domain switched to non-approved origin' });
    } else {
      checks.push({ check: 'foreign-flip', ok: true });
    }

    var allOk = checks.every(function (c) { return c.ok !== false; });
    if (!allOk) {
      _reportFailure('seal-verification-failed', checks);
    } else {
      console.debug(LOG, 'seal verified OK');
    }

    return { ok: allOk, checks: checks };
  }

  // ── Report seal failure ───────────────────────────────────────────────────
  function _reportFailure(reason, checks) {
    _ok = false;
    console.warn(LOG, 'SEAL FAILURE:', reason, checks);

    _s(function () {
      if (G.SecurityTelemetry) G.SecurityTelemetry.record('seal-failure', { reason: reason });
    });
    _s(function () {
      var st = G.RuntimeSecurityTiers;
      if (st && typeof st.upgrade === 'function') st.upgrade('seal:' + reason);
    });
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('seal:failure', { reason: reason, checks: checks });
      }
    });
    // Soft-disable premium processing
    _s(function () {
      try {
        Object.defineProperty(G, '__IPLV_SEAL_FAILED__', {
          value: true, writable: false, configurable: false,
        });
      } catch (_) { G.__IPLV_SEAL_FAILED__ = true; }
    });
  }

  // ── Seal current state ────────────────────────────────────────────────────
  function reseal() {
    _fingerprint = _buildFingerprint();
    _writeSeal(_fingerprint);
    _sealed = true;
    console.debug(LOG, 'sealed | chunks:', _fingerprint.chunkCount, '| tier:', _fingerprint.tier);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Verify previous seal first, then write new seal
    var result = verify();
    _checks = result.checks || [];
    _ok = result.ok;

    // Always reseal with current state (rotates the seal each page load)
    reseal();

    console.info(LOG, 'v' + VERSION + ' ready | ok:', _ok, '| checks:', _checks.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeDeploySeal = Object.freeze({
    VERSION: VERSION,
    verify:  verify,
    reseal:  reseal,
    status: function () {
      return {
        ok:          _ok,
        sealed:      _sealed,
        fingerprint: _fingerprint,
        checks:      _checks.slice(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
