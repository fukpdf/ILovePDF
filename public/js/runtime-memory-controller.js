// Runtime Memory Controller v1.0 — Phase 2 (T023)
// Unified memory management layer. Wraps MemPressure + AdaptiveDegradation
// into a single authoritative runtime source with 4 named tiers:
//   NORMAL → WARNING → CRITICAL → EMERGENCY
//
// All Phase 2 systems query RuntimeMemory instead of MemPressure directly.
// Provides: tier queries, adaptive config, cleanup escalation, emergency
// protection for low-end Android, Safari, giant PDFs, OCR spikes, long sessions.
//
// Integrates: MemPressure, AdaptiveDegradation, RuntimeState, RuntimeTelemetry,
//             RuntimeCancellation, CleanupContracts, LifecycleManager
//
// [FUTURE: AdaptiveRuntime] Memory events will feed a real-time ML model
// that predicts tier transitions before they happen (predictive degradation).
//
// Exposed as: window.RuntimeMemory
(function () {
  'use strict';

  if (window.RuntimeMemory) return;

  var LOG = '[RMC]';

  // ── Tier mapping ──────────────────────────────────────────────────────────
  // Maps MemPressure 5-tier system → Runtime 4-tier system
  var TIER_MAP = {
    ok:       'NORMAL',
    reduce:   'WARNING',
    low:      'WARNING',
    critical: 'CRITICAL',
    abort:    'EMERGENCY',
  };

  // ── Runtime tiers ─────────────────────────────────────────────────────────
  var TIERS = {
    NORMAL:    { maxWorkers: 4, maxPreviews: 4, canvasScale: 1.0, chunkMB: 8, enablePreview: true },
    WARNING:   { maxWorkers: 2, maxPreviews: 2, canvasScale: 0.80, chunkMB: 3, enablePreview: true },
    CRITICAL:  { maxWorkers: 1, maxPreviews: 1, canvasScale: 0.55, chunkMB: 1, enablePreview: false },
    EMERGENCY: { maxWorkers: 1, maxPreviews: 0, canvasScale: 0.40, chunkMB: 0.5, enablePreview: false },
  };

  // Mobile adjustment: halve worker/preview limits
  var _ua = navigator.userAgent || '';
  var IS_MOBILE = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  if (IS_MOBILE) {
    TIERS.NORMAL.maxWorkers  = 2; TIERS.NORMAL.maxPreviews  = 2;
    TIERS.WARNING.maxWorkers = 1; TIERS.WARNING.maxPreviews = 1;
  }

  // ── Current state ─────────────────────────────────────────────────────────
  var _currentTier = 'NORMAL';
  var _rawTier     = 'ok';
  var _subscribers = new Set();

  // ── Tier resolution ───────────────────────────────────────────────────────
  function _fromMemPressure(mpTier) {
    return TIER_MAP[mpTier] || 'NORMAL';
  }

  function _applyTier(newTier, oldTier, source) {
    _currentTier = newTier;
    var config = TIERS[newTier] || TIERS.NORMAL;

    // Update RuntimeState
    if (window.RuntimeState) {
      try {
        window.RuntimeState.set('memoryTier', newTier);
        if (newTier === 'EMERGENCY') {
          window.RuntimeState.set('emergencyActive', true);
          window.RuntimeState.set('lastEmergencyTs', Date.now());
          window.RuntimeState.set('runtimeMode', 'emergency');
        } else if (newTier === 'CRITICAL') {
          window.RuntimeState.set('runtimeMode', 'degraded');
        } else if (oldTier && (oldTier === 'CRITICAL' || oldTier === 'EMERGENCY')) {
          window.RuntimeState.set('runtimeMode', 'normal');
          window.RuntimeState.set('emergencyActive', false);
        }
      } catch (_) {}
    }

    // Telemetry
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('memory:tier-changed', { from: oldTier, to: newTier, source: source }); } catch (_) {}
    }

    // EventBus
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('memory:tier-changed', { tier: newTier, prev: oldTier, config: config }); } catch (_) {}
    }

    // Emergency actions
    if (newTier === 'EMERGENCY') {
      _handleEmergency();
    } else if (newTier === 'CRITICAL') {
      _handleCritical();
    }

    // Notify subscribers
    _subscribers.forEach(function (fn) {
      try { fn(newTier, oldTier, config); } catch (_) {}
    });

    console.debug(LOG, 'tier:', (oldTier || '?'), '→', newTier,
      '(workers:' + config.maxWorkers + ' previews:' + config.maxPreviews + ')');
  }

  // ── Emergency response ────────────────────────────────────────────────────
  function _handleEmergency() {
    // Cancel all background operations
    if (window.RuntimeCancellation) {
      try { window.RuntimeCancellation.cancelScope('background', 'memory-emergency'); } catch (_) {}
    }
    // Emergency cleanup
    if (window.CleanupContracts) {
      try { window.CleanupContracts.cleanup('memory-emergency'); } catch (_) {}
    }
    if (window.MemPressure) {
      try { window.MemPressure.emergencyCleanup(); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('memory:emergency', { tier: 'EMERGENCY' }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('memory:emergency', { tier: 'EMERGENCY' }); } catch (_) {}
    }
    console.warn(LOG, 'EMERGENCY tier — cancelling background ops and running cleanup');
  }

  function _handleCritical() {
    if (window.CleanupContracts) {
      try { window.CleanupContracts.cleanup('memory-critical'); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('memory:emergency', { tier: 'CRITICAL' }); } catch (_) {}
    }
  }

  // ── MemPressure integration ───────────────────────────────────────────────
  if (window.MemPressure) {
    // Subscribe to tier changes
    if (window.MemPressure.onTierChange) {
      window.MemPressure.onTierChange(function (newRaw, oldRaw) {
        _rawTier = newRaw;
        var newRuntime = _fromMemPressure(newRaw);
        var oldRuntime = _fromMemPressure(oldRaw || 'ok');
        if (newRuntime !== _currentTier) {
          _applyTier(newRuntime, _currentTier, 'MemPressure:' + newRaw);
        }
      });
    }
    // Seed initial tier
    if (window.MemPressure.tier) {
      _rawTier = window.MemPressure.tier();
      _currentTier = _fromMemPressure(_rawTier);
    }
  }

  // ── AdaptiveDegradation integration ───────────────────────────────────────
  if (window.AdaptiveDegradation && window.AdaptiveDegradation.onChange) {
    window.AdaptiveDegradation.onChange(function (profile, newTier) {
      // AdaptiveDegradation uses 'ok/reduce/low/critical/abort' — same map
      var runtimeTier = _fromMemPressure(newTier || 'ok');
      if (runtimeTier !== _currentTier) {
        _applyTier(runtimeTier, _currentTier, 'AdaptiveDegradation:' + newTier);
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getTier()    { return _currentTier; }
  function getConfig()  { return TIERS[_currentTier] || TIERS.NORMAL; }

  function isNormal()   { return _currentTier === 'NORMAL'; }
  function isWarning()  { return _currentTier === 'WARNING'; }
  function isCritical() { return _currentTier === 'CRITICAL' || _currentTier === 'EMERGENCY'; }
  function isEmergency(){ return _currentTier === 'EMERGENCY'; }

  function maxWorkers()  { return getConfig().maxWorkers; }
  function maxPreviews() { return getConfig().maxPreviews; }
  function canvasScale() {
    var base = getConfig().canvasScale;
    // Also consult AdaptiveDegradation if available
    if (window.AdaptiveDegradation && window.AdaptiveDegradation.canvasScale) {
      try { return Math.min(base, window.AdaptiveDegradation.canvasScale('pdf')); } catch (_) {}
    }
    return base;
  }
  function chunkBytes() { return (getConfig().chunkMB || 1) * 1024 * 1024; }
  function enablePreview() { return !!getConfig().enablePreview; }

  // Memory readings (delegates to MemPressure)
  function memUsedMB() {
    if (window.MemPressure && window.MemPressure.memUsed) {
      return Math.round(window.MemPressure.memUsed() / (1024 * 1024));
    }
    return 0;
  }

  function memAvailMB() {
    if (window.MemPressure && window.MemPressure.memAvail) {
      return Math.round(window.MemPressure.memAvail() / (1024 * 1024));
    }
    return 9999;
  }

  // Subscribe to tier changes: fn(newTier, oldTier, config)
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    _subscribers.add(fn);
    try { fn(_currentTier, null, getConfig()); } catch (_) {}
    return function () { _subscribers.delete(fn); };
  }

  // Force a tier for testing
  function forceTier(tier) {
    if (!TIERS[tier]) return;
    _applyTier(tier, _currentTier, 'force');
  }

  // Stats snapshot
  function getStats() {
    return {
      tier:        _currentTier,
      rawTier:     _rawTier,
      isMobile:    IS_MOBILE,
      config:      getConfig(),
      memUsedMB:   memUsedMB(),
      memAvailMB:  memAvailMB(),
      subscribers: _subscribers.size,
    };
  }

  // ── Pagehide cleanup ──────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    _subscribers.clear();
  }, { passive: true });

  window.RuntimeMemory = {
    getTier:       getTier,
    getConfig:     getConfig,
    isNormal:      isNormal,
    isWarning:     isWarning,
    isCritical:    isCritical,
    isEmergency:   isEmergency,
    maxWorkers:    maxWorkers,
    maxPreviews:   maxPreviews,
    canvasScale:   canvasScale,
    chunkBytes:    chunkBytes,
    enablePreview: enablePreview,
    memUsedMB:     memUsedMB,
    memAvailMB:    memAvailMB,
    onChange:      onChange,
    forceTier:     forceTier,
    getStats:      getStats,
    TIERS:         TIERS,
  };

  console.debug('[RuntimeMemory] ready — T023 memory controller active (tier:', _currentTier + ')');
}());
