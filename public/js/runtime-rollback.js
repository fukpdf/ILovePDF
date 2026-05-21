// runtime-rollback.js
// Phase 2 — Final Hardening Pass: Rollback Safety System
// =======================================================
// Provides snapshot + rollback capabilities for the Phase 1 & 2 security layer.
//
// Responsibilities:
//   A. SNAPSHOT  — Capture a baseline of critical security globals at boot-time
//                  (after all runtime systems have initialised).
//   B. VERIFY    — Periodically re-check that globals match their snapshot state.
//                  Flags drift (NOOP substitution, deletion, mutation).
//   C. ROLLBACK  — Restore globals to their snapshotted state if drift is detected
//                  and rollback is considered safe.
//   D. ESCALATE  — If rollback cannot restore a critical system, escalate to
//                  RuntimeRecovery / RuntimeHardening.
//
// Strategy:
//   - Snapshots store weak fingerprints (type, method count, version string,
//     NOOP detection) rather than full references — avoids memory leaks.
//   - Actual reference restoration from a second Map<name, original_ref>.
//   - Rollback is conservative: only restores if the replacement looks like
//     a NOOP stub or has fewer methods than the original.
//
// ADDITIVE ONLY. Never breaks tools or processing.
// Low-end devices: no periodic verification (only boot snapshot + manual check).
//
// Exposed: window.RuntimeRollback
//   .snapshot()    → records baseline now (auto-called at boot)
//   .verify()      → re-checks all critical globals, returns { ok, drifted[] }
//   .rollback(name)→ attempt restoration of a single system
//   .rollbackAll() → attempt restoration of all drifted systems
//   .status()      → { snapshotTs, verifications, drifts, rollbacks }

(function (G) {
  'use strict';

  if (G.RuntimeRollback) return;

  var VERSION = '1.0';
  var LOG = '[RRB]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ─────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  // ── Configuration ────────────────────────────────────────────────────────────
  var VERIFY_INTERVAL_MS = _lite ? 0 : 30000;     // 30s periodic check on capable devices
  var CRITICAL_SYSTEMS = [
    // Phase 1
    'RuntimeProtection',
    'RuntimeShieldCore',
    'RuntimeShieldIntegrity',
    'RuntimeShieldWorkers',
    'RuntimeShieldDependency',
    'RuntimeSecurity',
    // Phase 2
    'RuntimeManifest',
    'RuntimeWorkerFactory',
    'RuntimeHardening',
    // Core processing
    'RuntimeKernel',
    'RuntimeState',
    'RuntimeAnalytics',
    'RuntimeTelemetry',
    'ILovePDFContracts',
    'ILovePDFConstants',
  ];

  // ── Internal state ───────────────────────────────────────────────────────────
  var _snapshots   = Object.create(null);  // name → fingerprint
  var _origRefs    = Object.create(null);  // name → original reference
  var _snapshotTs  = null;
  var _stats = {
    verifications:  0,
    drifts:         0,
    rollbacks:      0,
    rollbackFailed: 0,
  };

  // ── Fingerprinting ───────────────────────────────────────────────────────────
  // Creates a weak fingerprint that can detect NOOP substitutions and gross
  // mutations without storing the full object reference in the snapshot.

  function _fingerprint(name, obj) {
    if (!obj) return { present: false, type: 'undefined' };

    var fp = {
      present:    true,
      type:       typeof obj,
      version:    _s(function () { return String(obj.VERSION || obj.version || ''); }, ''),
      methodCount:0,
      isNoop:     false,
      isObject:   typeof obj === 'object' || typeof obj === 'function',
    };

    // Count methods (public API surface)
    _s(function () {
      var keys = Object.keys(obj);
      var methods = keys.filter(function (k) { return typeof obj[k] === 'function'; });
      fp.methodCount = methods.length;
    });

    // NOOP detection: an object with no methods is suspicious
    if (fp.isObject && fp.methodCount === 0 && fp.type !== 'undefined') {
      fp.isNoop = true;
    }

    return fp;
  }

  function _isDrifted(name, fp, current) {
    // Not present when it was
    if (fp.present && !current.present) return { drifted: true, reason: 'deleted' };
    // Appeared when it should not have (allow — new systems can be added)
    if (!fp.present) return { drifted: false };
    // Type changed
    if (fp.type !== current.type) return { drifted: true, reason: 'type-change:' + fp.type + '->' + current.type };
    // Became a NOOP stub
    if (!fp.isNoop && current.isNoop) return { drifted: true, reason: 'nooped' };
    // Lost methods (NOOP injection — method count dropped by >50%)
    if (fp.methodCount > 2 && current.methodCount < Math.floor(fp.methodCount * 0.5)) {
      return { drifted: true, reason: 'method-loss:' + fp.methodCount + '->' + current.methodCount };
    }
    // Version changed (unusual — flag as warning only)
    if (fp.version && current.version && fp.version !== current.version) {
      // Not a drift — version upgrades are expected
    }
    return { drifted: false };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § A — SNAPSHOT
  // ══════════════════════════════════════════════════════════════════════════════

  function _snapshot() {
    var snapped = 0;
    CRITICAL_SYSTEMS.forEach(function (name) {
      var obj = G[name];
      _snapshots[name]  = _fingerprint(name, obj);
      _origRefs[name]   = obj;  // preserve reference for rollback
      if (obj) snapped++;
    });
    _snapshotTs = Date.now();
    console.info(LOG, 'v' + VERSION, 'snapshot captured —', snapped + '/' + CRITICAL_SYSTEMS.length, 'systems present');
    return { snapped: snapped, total: CRITICAL_SYSTEMS.length, ts: _snapshotTs };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § B — VERIFY
  // ══════════════════════════════════════════════════════════════════════════════

  var _drifted = [];   // names of currently drifted systems

  function _verify() {
    if (!_snapshotTs) {
      console.warn(LOG, 'verify called before snapshot — taking snapshot now');
      _snapshot();
      return { ok: true, drifted: [] };
    }

    _stats.verifications++;
    _drifted = [];

    CRITICAL_SYSTEMS.forEach(function (name) {
      var fp      = _snapshots[name];
      var current = _fingerprint(name, G[name]);
      var check   = _isDrifted(name, fp, current);

      if (check.drifted) {
        _drifted.push({ name: name, reason: check.reason });
        _stats.drifts++;
        console.error(LOG, 'DRIFT DETECTED:', name, '—', check.reason);
        _s(function () {
          if (G.RuntimeTelemetry) {
            G.RuntimeTelemetry.record('rollback:drift', { name: name, reason: check.reason });
          }
        });
        _s(function () {
          if (G.RuntimeShieldIntegrity) {
            G.RuntimeShieldIntegrity.flag && G.RuntimeShieldIntegrity.flag('drift:' + name);
          }
        });
      }
    });

    var ok = _drifted.length === 0;
    if (ok) {
      console.debug(LOG, 'integrity check passed — no drift detected');
    }
    return { ok: ok, drifted: _drifted.slice(), ts: Date.now() };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § C — ROLLBACK
  // ══════════════════════════════════════════════════════════════════════════════

  function _rollback(name) {
    var orig = _origRefs[name];
    if (!orig) {
      console.warn(LOG, 'rollback: no snapshot reference for', name);
      _stats.rollbackFailed++;
      return { ok: false, reason: 'no-snapshot-ref' };
    }

    var current = G[name];
    // Safety: do NOT rollback if current looks healthy (could be a version upgrade)
    var currentFp = _fingerprint(name, current);
    var snapFp    = _snapshots[name];
    var check     = _isDrifted(name, snapFp, currentFp);
    if (!check.drifted) {
      return { ok: true, reason: 'no-drift-detected' };
    }

    try {
      // Attempt restoration
      G[name] = orig;
      _stats.rollbacks++;
      console.warn(LOG, 'rolled back:', name, '(reason:', check.reason + ')');
      _s(function () {
        if (G.RuntimeTelemetry) {
          G.RuntimeTelemetry.record('rollback:restored', { name: name });
        }
      });
      return { ok: true, reason: 'restored', name: name };
    } catch (e) {
      _stats.rollbackFailed++;
      console.error(LOG, 'rollback failed for', name, ':', e.message);
      // Escalate to RuntimeHardening
      _s(function () {
        if (G.RuntimeHardening && typeof G.RuntimeHardening.escalate === 'function') {
          G.RuntimeHardening.escalate('rollback-failed:' + name);
        }
      });
      return { ok: false, reason: 'restore-failed:' + e.message };
    }
  }

  function _rollbackAll() {
    var results = [];
    _drifted.forEach(function (d) {
      results.push(_rollback(d.name));
    });
    return results;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § D — PERIODIC VERIFICATION
  // ══════════════════════════════════════════════════════════════════════════════

  function _startPeriodicVerify() {
    if (_lite || !VERIFY_INTERVAL_MS) return;
    setInterval(function () {
      var result = _verify();
      if (!result.ok) {
        _rollbackAll();
      }
    }, VERIFY_INTERVAL_MS);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  // Snapshot after all deferred scripts have had time to load

  function _boot() {
    setTimeout(function () {
      _snapshot();
      _startPeriodicVerify();
    }, 2500); // P3 Fix: 2.5s — allow all deferred scripts to fully settle before snapshot
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  G.RuntimeRollback = Object.freeze({
    VERSION:     VERSION,
    snapshot:    _snapshot,
    verify:      _verify,
    rollback:    _rollback,
    rollbackAll: _rollbackAll,
    status: function () {
      return {
        snapshotTs:    _snapshotTs,
        verifications: _stats.verifications,
        drifts:        _stats.drifts,
        rollbacks:     _stats.rollbacks,
        rollbackFailed:_stats.rollbackFailed,
        driftedNow:    _drifted.slice(),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION, 'ready — snapshot scheduled in 1s');

}(typeof window !== 'undefined' ? window : this));
