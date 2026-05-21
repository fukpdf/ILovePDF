// RuntimeSecurityTiers v1.0 — Phase 3 / Task 4 (Adaptive Security Tiers)
// ============================================================================
// Central tier authority that all Phase 3 modules query for feature gating.
// Replaces ad-hoc device-score comparisons scattered across Phase 1/2 modules.
//
// Tiers:
//   LOW     — mobile / weak CPU / lite mode      (score < 40)
//   MEDIUM  — normal desktop/mobile              (score 40–69)
//   HIGH    — powerful desktop                   (score ≥70)
//   EXTREME — HIGH + confirmed suspicious state  (tamper/foreign/replay)
//
// Feature gates (canDo):
//   sweep            — periodic integrity sweeps
//   periodicVerify   — rollback/verify cycle
//   sriVerify        — advisory hash verification
//   sriEnforce       — blocking hash mismatch (EXTREME only)
//   workerHeartbeat  — worker liveness pings
//   noncePool        — full nonce replay tracking
//   telemetryFull    — extended telemetry depth
//   perfMonitor      — memory pressure monitoring
//   blobCleanup      — Blob URL leak detection & cleanup
//   wasmVerify       — WASM module integrity tracking
//   foreignDegrade   — soft feature reduction on clone domains
//
// window.RuntimeSecurityTiers
//   .current()         → 'LOW'|'MEDIUM'|'HIGH'|'EXTREME'
//   .score()           → number (device score)
//   .canDo(feature)    → boolean
//   .upgrade(reason)   → void (escalate toward EXTREME — only from HIGH)
//   .downgrade(reason) → void (step back one level, never below MEDIUM)
//   .onTierChange(fn)  → unsubscribe function
//   .status()          → { tier, score, flags, upgrades, downgrades }
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityTiers) return;

  var VERSION = '1.0';
  var LOG     = '[SecTiers]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device score ──────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);

  // ── Base tier from device score ───────────────────────────────────────────
  function _baseTier(s) {
    if (s < 40) return 'LOW';
    if (s < 70) return 'MEDIUM';
    return 'HIGH';
  }

  // ── Tier numeric ordering ─────────────────────────────────────────────────
  var TIER_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, EXTREME: 3 };

  // ── Feature minimum tier table ────────────────────────────────────────────
  var FEATURE_MIN = {
    blobCleanup:     'LOW',
    foreignDegrade:  'LOW',
    sweep:           'MEDIUM',
    periodicVerify:  'MEDIUM',
    workerHeartbeat: 'MEDIUM',
    perfMonitor:     'MEDIUM',
    sriVerify:       'HIGH',
    noncePool:       'HIGH',
    telemetryFull:   'HIGH',
    wasmVerify:      'HIGH',
    sriEnforce:      'EXTREME',
  };

  // ── Mutable state ─────────────────────────────────────────────────────────
  var _tier       = _baseTier(_score);
  var _upgrades   = [];
  var _downgrades = [];
  var _flags      = [];
  var _listeners  = [];

  // ── Feature gate ──────────────────────────────────────────────────────────
  function canDo(feature) {
    var min = FEATURE_MIN[feature];
    if (!min) return false;
    return TIER_ORDER[_tier] >= TIER_ORDER[min];
  }

  // ── Tier mutation ─────────────────────────────────────────────────────────
  function _setTier(newTier, reason) {
    if (newTier === _tier) return;
    var prev = _tier;
    _tier = newTier;
    console.info(LOG, 'tier:', prev, '→', newTier, '| reason:', reason);
    _s(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('security-tier:change', { from: prev, to: newTier, reason: reason });
      }
    });
    _listeners.forEach(function (fn) { _s(function () { fn(newTier, prev, reason); }); });
  }

  function upgrade(reason) {
    _flags.push(reason);
    _upgrades.push({ reason: reason, ts: Date.now() });
    // Only HIGH can escalate to EXTREME; LOW/MEDIUM devices stay at base tier
    if (_tier === 'HIGH') {
      _setTier('EXTREME', reason);
    }
    // EXTREME stays EXTREME; LOW/MEDIUM don't get EXTREME (resource constraint)
    console.debug(LOG, 'upgrade signal:', reason, '| tier:', _tier);
  }

  function downgrade(reason) {
    _downgrades.push({ reason: reason, ts: Date.now() });
    // Step down one level — never below MEDIUM (minimum secure baseline)
    if (_tier === 'EXTREME') { _setTier('HIGH',   reason); }
    else if (_tier === 'HIGH') { _setTier('MEDIUM', reason); }
    // MEDIUM and LOW: no downgrade (already at or below security floor)
  }

  function onTierChange(fn) {
    if (typeof fn !== 'function') return function () {};
    _listeners.push(fn);
    return function () {
      _listeners = _listeners.filter(function (f) { return f !== fn; });
    };
  }

  // ── Auto-upgrade hooks ────────────────────────────────────────────────────
  // Subscribe to Phase 1/2 suspicious event signals
  _s(function () {
    var bus = G.RuntimeEventBus;
    if (!bus || typeof bus.on !== 'function') return;
    bus.on('shield:tamper-response', function (d) {
      upgrade('tamper:' + (d && d.reason ? d.reason : 'unknown'));
    });
    bus.on('security:foreign-deploy', function () {
      upgrade('foreign-deploy');
    });
    bus.on('panic:activated', function (d) {
      upgrade('panic:' + (d && d.reason ? d.reason : 'unknown'));
    });
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Check if Phase 1 already flagged this session
    _s(function () {
      var reg = G.RuntimeShieldCore && G.RuntimeShieldCore.registry;
      if (reg && typeof reg.get === 'function' && reg.get('core:flagged')) {
        upgrade('phase1-flagged-at-boot');
      }
    });
    // Check if deployment mismatch already detected
    _s(function () {
      var db = G.RuntimeDeploymentBind;
      if (!db || typeof db.status !== 'function') return;
      var st = db.status();
      if (st && st.deployReady === false) {
        upgrade('deploy-mismatch-at-boot');
      }
    });
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| score:', _score);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1200); }, { once: true });
  } else {
    setTimeout(_boot, 1200);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeSecurityTiers = Object.freeze({
    VERSION:      VERSION,
    current:      function () { return _tier; },
    score:        function () { return _score; },
    canDo:        canDo,
    upgrade:      upgrade,
    downgrade:    downgrade,
    onTierChange: onTierChange,
    status: function () {
      return {
        tier:       _tier,
        score:      _score,
        flags:      _flags.slice(),
        upgrades:   _upgrades.slice(),
        downgrades: _downgrades.slice(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | base tier:', _tier, '| score:', _score);

}(window));
