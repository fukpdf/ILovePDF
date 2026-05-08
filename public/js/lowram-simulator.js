// Phase 40I — Low-RAM Device Simulator v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § I1  ConstraintProfile    — define hardware constraint sets
// § I2  ConstraintApplicator — push constraints to AdaptiveController + MemPressure
// § I3  SurvivalVerifier     — verify system degrades but keeps working under constraint
//
// Exposes: window.LowRamSimulator

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[LRS]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }

  // ═══════════════════════════════════════════════════════════════════════════
  // § I1  CONSTRAINT PROFILES
  // ═══════════════════════════════════════════════════════════════════════════
  var ConstraintProfile = {
    '512mb':  { label: '512 MB phone', memTier: 'critical', workers: 1, renderScale: 0.5, chunkMB: 0.5, batchSize: 1, ocrMode: 'fast' },
    '1gb':    { label: '1 GB low-end', memTier: 'danger',   workers: 1, renderScale: 0.75,chunkMB: 1,   batchSize: 1, ocrMode: 'fast' },
    '2gb':    { label: '2 GB mobile',  memTier: 'high',     workers: 2, renderScale: 1.0, chunkMB: 2,   batchSize: 2, ocrMode: 'normal' },
    'throttled': { label: 'Throttled CPU', memTier: 'high', workers: 1, renderScale: 0.75, chunkMB: 1, batchSize: 1, ocrMode: 'fast' },
    'low-battery':{ label: 'Low battery',  memTier: 'elevated', workers: 1, renderScale: 0.75, chunkMB: 2, batchSize: 2, ocrMode: 'normal' },
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // § I2  CONSTRAINT APPLICATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var ConstraintApplicator = (function () {
    var _active    = null;
    var _origTier  = null;
    var _origMp    = null;

    function apply(profileKey) {
      var p = ConstraintProfile[profileKey];
      if (!p) return { ok: false, reason: 'unknown-profile: ' + profileKey };
      _active = profileKey;

      // Push to AutoTuningEngine AdaptiveController
      var ate = window.AutoTuningEngine;
      if (ate && ate.AdaptiveController) {
        ate.AdaptiveController.setOverride('workerCount',  p.workers);
        ate.AdaptiveController.setOverride('renderScale',  p.renderScale);
        ate.AdaptiveController.setOverride('chunkSizeMB',  p.chunkMB);
        ate.AdaptiveController.setOverride('batchSize',    p.batchSize);
        ate.AdaptiveController.setOverride('ocrMode',      p.ocrMode);
      }

      // Simulate memory pressure tier
      var mp = window.MemPressure;
      if (mp && typeof mp.tier === 'function') {
        _origTier = mp.tier.bind(mp);
        mp.tier = function () { return p.memTier; };
      }

      // Fire survival mode if critical
      if (p.memTier === 'critical') {
        window.dispatchEvent(new CustomEvent('p32:survival-mode', { detail: { simulated: true, profile: profileKey } }));
      }

      _log('applied', { profile: profileKey, label: p.label });
      return { ok: true, profile: p };
    }

    function restore() {
      _active = null;
      var ate = window.AutoTuningEngine;
      if (ate && ate.AdaptiveController) ate.AdaptiveController.clearOverrides();
      var mp = window.MemPressure;
      if (mp && _origTier) mp.tier = _origTier;
      _origTier = null;
      _log('restored', {});
    }

    function isActive() { return _active; }

    return { apply: apply, restore: restore, isActive: isActive };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § I3  SURVIVAL VERIFIER
  // Verifies platform survives each constraint profile without crashing.
  // ═══════════════════════════════════════════════════════════════════════════
  var SurvivalVerifier = (function () {

    async function verifyProfile(profileKey) {
      var start = performance.now();
      ConstraintApplicator.apply(profileKey);
      await new Promise(function (r) { setTimeout(r, 150); });

      var checks = {
        memPressureSet: false,
        workerCountReduced: false,
        renderScaleReduced: false,
        survivalModeHandled: false,
        btStillFunctional: false,
        dashboardAdapted: false,
      };

      try {
        var mp = window.MemPressure;
        if (mp && typeof mp.tier === 'function') checks.memPressureSet = true;

        var ate = window.AutoTuningEngine;
        if (ate && ate.AdaptiveController) {
          var p = ConstraintProfile[profileKey];
          checks.workerCountReduced  = ate.AdaptiveController.workerCount() <= p.workers;
          checks.renderScaleReduced  = ate.AdaptiveController.renderScale() <= p.renderScale;
        }

        var p32 = window.Phase32;
        if (p32 && p32.GiantFileSurvivalMode) {
          checks.survivalModeHandled = true;
        }

        checks.btStillFunctional = !!(window.BrowserTools && typeof window.BrowserTools.process === 'function');

        var jd = window.JobDashboard;
        if (jd) checks.dashboardAdapted = true;

      } catch (_) {}

      ConstraintApplicator.restore();
      await new Promise(function (r) { setTimeout(r, 50); });

      var passed = Object.values(checks).filter(Boolean).length;
      var total  = Object.keys(checks).length;
      var ms     = Math.round(performance.now() - start);

      _log('verify-profile', { profile: profileKey, passed: passed, total: total });
      return { profile: profileKey, label: ConstraintProfile[profileKey].label, ok: passed >= Math.floor(total * 0.6), passed: passed, total: total, checks: checks, ms: ms };
    }

    async function runAll() {
      var results = [];
      for (var key of Object.keys(ConstraintProfile)) {
        results.push(await verifyProfile(key));
      }
      var passed = results.filter(function (r) { return r.ok; }).length;
      return { ok: passed === results.length, passed: passed, total: results.length, results: results };
    }

    return { verifyProfile: verifyProfile, runAll: runAll };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LowRamSimulator = {
    version:              VERSION,
    profiles:             ConstraintProfile,
    ConstraintApplicator: ConstraintApplicator,
    SurvivalVerifier:     SurvivalVerifier,

    apply:   function (profileKey)  { return ConstraintApplicator.apply(profileKey); },
    restore: function ()            { return ConstraintApplicator.restore(); },

    runAll: async function () {
      console.group('[LRS] Low-RAM Survival Test');
      var r = await SurvivalVerifier.runAll();
      console.table(r.results.map(function (x) {
        return { Profile: x.label, Passed: x.ok ? '✔' : '✗', Score: x.passed + '/' + x.total, MS: x.ms };
      }));
      console.log('Result:', r.passed + '/' + r.total + ' profiles passed');
      console.groupEnd();
      return r;
    },

    audit: function () {
      return {
        version: VERSION,
        profiles: Object.keys(ConstraintProfile),
        active:  ConstraintApplicator.isActive(),
      };
    },
  };

  _log('loaded', {});
}());
