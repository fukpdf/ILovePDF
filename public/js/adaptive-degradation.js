// Adaptive Degradation v1.0 — Phase 1C Stabilization (T010)
// Tier-driven quality degradation controller that acts on MemPressure tier
// changes to automatically reduce canvas scale, concurrency, preview quality,
// and chunk size — then ramps back up when pressure eases.
//
// DESIGN PRINCIPLE: additive observer over MemPressure. Does NOT replace
// MemPressure's scaling APIs — extends them with a reactive config surface
// that consumers read at processing time.
//
// Integrates with: MemPressure, WorkerPool, TimerRegistry, StabilityMetrics,
//                  LifecycleManager, NavCancel
//
// Exposed as: window.AdaptiveDegradation
//
// [FUTURE: AdaptiveRuntime] When a central AdaptiveRuntime is built,
// replace the tier-change callbacks here with AdaptiveRuntime.onProfile()
// so all subsystems share one authoritative scaling profile.
(function () {
  'use strict';

  if (window.AdaptiveDegradation) return;

  var LOG = '[AD]';

  // ── Degradation profiles per memory tier ──────────────────────────────────
  // Each profile describes the maximum safe configuration for that tier.
  // Consumers call AdaptiveDegradation.getConfig() to read these values.
  var PROFILES = {
    ok: {
      canvasScale:       1.0,
      maxConcurrentJobs: 4,
      maxPreviews:       4,
      chunkMultiplier:   1.0,
      ocrAccuracy:       'accurate',
      imageQuality:      0.90,
      enableAnimations:  true,
      enablePreview:     true,
      description:       'full quality',
    },
    reduce: {
      canvasScale:       0.85,
      maxConcurrentJobs: 3,
      maxPreviews:       3,
      chunkMultiplier:   0.5,
      ocrAccuracy:       'balanced',
      imageQuality:      0.80,
      enableAnimations:  true,
      enablePreview:     true,
      description:       'moderate reduction',
    },
    low: {
      canvasScale:       0.70,
      maxConcurrentJobs: 2,
      maxPreviews:       2,
      chunkMultiplier:   0.25,
      ocrAccuracy:       'balanced',
      imageQuality:      0.70,
      enableAnimations:  false,
      enablePreview:     true,
      description:       'aggressive reduction',
    },
    critical: {
      canvasScale:       0.55,
      maxConcurrentJobs: 1,
      maxPreviews:       1,
      chunkMultiplier:   0.125,
      ocrAccuracy:       'fast',
      imageQuality:      0.60,
      enableAnimations:  false,
      enablePreview:     false,
      description:       'critical — minimal ops',
    },
    abort: {
      canvasScale:       0.40,
      maxConcurrentJobs: 1,
      maxPreviews:       0,
      chunkMultiplier:   0.0625,
      ocrAccuracy:       'fast',
      imageQuality:      0.50,
      enableAnimations:  false,
      enablePreview:     false,
      description:       'abort — emergency degradation',
    },
  };

  // ── Mobile-specific profile adjustments ───────────────────────────────────
  // Mobile devices get tighter limits regardless of reported JS heap.
  var _ua = navigator.userAgent || '';
  var IS_MOBILE = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  var IS_LOW_END_MOBILE = IS_MOBILE &&
    (typeof navigator.hardwareConcurrency === 'number' &&
     navigator.hardwareConcurrency <= 4);

  if (IS_LOW_END_MOBILE) {
    // Shift all mobile profiles one tier tighter
    PROFILES.ok.maxConcurrentJobs     = 2;
    PROFILES.ok.maxPreviews           = 2;
    PROFILES.ok.canvasScale           = 0.85;
    PROFILES.reduce.maxConcurrentJobs = 1;
    PROFILES.reduce.maxPreviews       = 1;
    PROFILES.low.enablePreview        = false;
    PROFILES.critical.enablePreview   = false;
  } else if (IS_MOBILE) {
    PROFILES.ok.maxConcurrentJobs     = 3;
    PROFILES.ok.maxPreviews           = 3;
  }

  // ── Current state ─────────────────────────────────────────────────────────
  var _currentTier    = 'ok';
  var _currentProfile = PROFILES.ok;

  // Subscribers that receive profile changes
  // { fn: Function, lastTier: string }
  var _subscribers = new Set();

  // ── Tier → profile resolution ─────────────────────────────────────────────
  function _profileFor(tier) {
    return PROFILES[tier] || PROFILES.ok;
  }

  // ── Apply a new profile ───────────────────────────────────────────────────
  function _applyProfile(newTier, oldTier) {
    var profile = _profileFor(newTier);
    _currentTier    = newTier;
    _currentProfile = profile;

    // Notify subscribers
    _subscribers.forEach(function (entry) {
      try { entry.fn(profile, newTier, oldTier); } catch (_) {}
    });

    // Enforce WorkerPool concurrency cap when available
    if (window.WorkerPool && window.WorkerPool.setMaxWorkers) {
      try { window.WorkerPool.setMaxWorkers(profile.maxConcurrentJobs); } catch (_) {}
    }

    // Record metric
    if (window.StabilityMetrics) {
      try {
        window.StabilityMetrics.recordEvent('ad-tier:' + newTier + (IS_MOBILE ? ':mobile' : ''));
      } catch (_) {}
    }

    console.debug(LOG, 'profile applied → ' + newTier + ' (' + profile.description + ')');
  }

  // ── MemPressure integration ───────────────────────────────────────────────
  // Subscribe to tier changes from MemPressure.onTierChange().
  if (window.MemPressure && window.MemPressure.onTierChange) {
    window.MemPressure.onTierChange(function (newTier, oldTier) {
      _applyProfile(newTier, oldTier);
    });
    // Seed initial tier
    if (window.MemPressure.tier) {
      _currentTier    = window.MemPressure.tier();
      _currentProfile = _profileFor(_currentTier);
    }
  } else {
    // MemPressure not available: fallback polling.
    // performance.memory is Chrome/Edge-only; on Safari/Firefox it is absent.
    // Use navigator.deviceMemory (where available) for an initial conservative tier,
    // then rely on session step-down and mobile stress guard for ongoing adaptation.
    var MB = 1024 * 1024;
    var _hasHeapAPI = !!(typeof performance !== 'undefined' &&
      performance.memory &&
      typeof performance.memory.usedJSHeapSize === 'number');
    var _deviceMemGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;

    // On devices with ≤2 GB RAM (or low-end mobile without heap API), start at 'reduce'.
    if (!_hasHeapAPI) {
      if (_deviceMemGB > 0 && _deviceMemGB <= 2) {
        _applyProfile('reduce', 'ok');
      } else if (IS_LOW_END_MOBILE) {
        _applyProfile('reduce', 'ok');
      }
    }

    var _fbTimer = setInterval(function () {
      try {
        if (!_hasHeapAPI) return; // no heap API (Safari/Firefox) — rely on step-down/stress guard
        var used = performance.memory.usedJSHeapSize;
        var tier = 'ok';
        if      (used > 900 * MB) tier = 'abort';
        else if (used > 720 * MB) tier = 'critical';
        else if (used > 550 * MB) tier = 'low';
        else if (used > 400 * MB) tier = 'reduce';
        if (tier !== _currentTier) _applyProfile(tier, _currentTier);
      } catch (_) {}
    }, 10000);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerInterval('ad-fallback-poll', _fbTimer);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  // Returns the current degradation profile (object, never null)
  function getConfig() {
    return _currentProfile;
  }

  // Returns the current tier string
  function getTier() {
    return _currentTier;
  }

  // Returns a specific config value with an optional fallback
  function get(key, fallback) {
    var v = _currentProfile[key];
    return v !== undefined ? v : fallback;
  }

  // Subscribe to profile changes.
  // fn(profile, newTier, oldTier)
  // Returns an unsubscribe function.
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    var entry = { fn: fn };
    _subscribers.add(entry);
    // Fire immediately with current state
    try { fn(_currentProfile, _currentTier, null); } catch (_) {}
    return function () { _subscribers.delete(entry); };
  }

  // Manually force a tier (for testing or forced override)
  function forceProfile(tier) {
    if (!PROFILES[tier]) { console.warn(LOG, 'unknown tier:', tier); return; }
    _applyProfile(tier, _currentTier);
  }

  // Check if a specific capability should be enabled at the current tier
  function isEnabled(capability) {
    switch (capability) {
      case 'preview':    return !!_currentProfile.enablePreview;
      case 'animations': return !!_currentProfile.enableAnimations;
      default:           return true;
    }
  }

  // Get the effective canvas scale, merging with MemPressure.renderScale if available
  function canvasScale(type) {
    var baseScale = _currentProfile.canvasScale;
    if (window.MemPressure && window.MemPressure.renderScale) {
      try {
        var mpScale = window.MemPressure.renderScale(type || 'pdf');
        // Use the more conservative of the two
        return Math.min(baseScale, mpScale);
      } catch (_) {}
    }
    return baseScale;
  }

  // ── Long-session stabilization (T014) ─────────────────────────────────────
  // After 45 minutes of activity, automatically step down one tier level
  // to proactively handle accumulated memory fragmentation and GC pressure.
  var SESSION_STEP_DOWN_MS = 45 * 60 * 1000;
  var _sessionTimer = null;

  function _startSessionStepDown() {
    if (_sessionTimer) return;
    _sessionTimer = setTimeout(function () {
      _sessionTimer = null;
      var TIER_ORDER = ['ok', 'reduce', 'low', 'critical', 'abort'];
      var idx = TIER_ORDER.indexOf(_currentTier);
      if (idx < TIER_ORDER.length - 2) {
        var nextTier = TIER_ORDER[idx + 1];
        console.debug(LOG, 'long-session step-down:', _currentTier, '→', nextTier);
        if (window.StabilityMetrics) {
          try { window.StabilityMetrics.recordEvent('ad-session-stepdown:' + nextTier); } catch (_) {}
        }
        _applyProfile(nextTier, _currentTier);
      }
      // Schedule the next step-down
      _startSessionStepDown();
    }, SESSION_STEP_DOWN_MS);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerTimeout('ad-session-stepdown', _sessionTimer);
    }
  }

  _startSessionStepDown();

  // ── Mobile stress guard (T013) ─────────────────────────────────────────────
  // On mobile, if memory APIs are unavailable (common on iOS), we use a
  // heuristic: after N tool runs, step down one tier proactively.
  var MOBILE_RUN_STEP_DOWN = 3; // step down every 3 tool completions on mobile
  var _mobileRunCount = 0;

  function recordToolRun() {
    if (!IS_MOBILE) return;
    _mobileRunCount++;
    if (_mobileRunCount % MOBILE_RUN_STEP_DOWN === 0) {
      var TIER_ORDER = ['ok', 'reduce', 'low', 'critical', 'abort'];
      var idx = TIER_ORDER.indexOf(_currentTier);
      if (idx < TIER_ORDER.length - 2) {
        var nextTier = TIER_ORDER[idx + 1];
        console.debug(LOG, 'mobile-stress step-down after', _mobileRunCount, 'runs:',
          _currentTier, '→', nextTier);
        if (window.StabilityMetrics) {
          try { window.StabilityMetrics.recordEvent('ad-mobile-stress:' + nextTier); } catch (_) {}
        }
        _applyProfile(nextTier, _currentTier);
      }
    }
  }

  // Restore to 'ok' on pagehide (fresh start for next session / bfcache restore)
  window.addEventListener('pagehide', function () {
    _currentTier    = 'ok';
    _currentProfile = PROFILES.ok;
    _mobileRunCount = 0;
    if (_sessionTimer) { clearTimeout(_sessionTimer); _sessionTimer = null; }
  }, { passive: true });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      tier:         _currentTier,
      profile:      _currentProfile,
      isMobile:     IS_MOBILE,
      isLowEnd:     IS_LOW_END_MOBILE,
      mobileRunCount: _mobileRunCount,
      subscriberCount: _subscribers.size,
    };
  }

  window.AdaptiveDegradation = {
    getConfig:     getConfig,
    getTier:       getTier,
    get:           get,
    onChange:      onChange,
    forceProfile:  forceProfile,
    isEnabled:     isEnabled,
    canvasScale:   canvasScale,
    recordToolRun: recordToolRun,
    getStats:      getStats,
    PROFILES:      PROFILES,
  };

  console.debug('[AdaptiveDegradation] ready — T010/T013/T014 adaptive degradation active',
    '(tier:', _currentTier + ', mobile:', IS_MOBILE + ')');
}());
