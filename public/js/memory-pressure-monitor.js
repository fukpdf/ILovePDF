// Memory Pressure Monitor v1.0 — Phase 23A
// Comprehensive memory tier classification, adaptive scaling, emergency cleanup,
// and tier-change event subscription. Builds on the memTier() pattern in
// advanced-engine.js with a richer, more granular API.
// Exposes: window.MemPressure
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Tier thresholds (JS heap used) ────────────────────────────────────────
  var TIER_REDUCE = 400 * MB;  // 400 MB → moderate caution
  var TIER_LOW    = 550 * MB;  // 550 MB → aggressive reduction
  var TIER_CRIT   = 720 * MB;  // 720 MB → critical — emergency cleanup
  var TIER_ABORT  = 900 * MB;  // 900 MB → abort heaviest ops

  // ── Adaptive render/OCR scale per tier ────────────────────────────────────
  var SCALES = {
    ok:       { pdf: 2.0, ocr: 2.0, img: 1.0 },
    reduce:   { pdf: 1.5, ocr: 1.5, img: 0.85 },
    low:      { pdf: 1.2, ocr: 1.2, img: 0.70 },
    critical: { pdf: 0.9, ocr: 1.0, img: 0.55 },
    abort:    { pdf: 0.7, ocr: 0.8, img: 0.40 },
  };

  // ── Max concurrent workers per tier ───────────────────────────────────────
  var W_COUNTS = { ok: 4, reduce: 3, low: 2, critical: 1, abort: 1 };

  // ── Memory reading ────────────────────────────────────────────────────────
  function memUsed() {
    try {
      return (performance && performance.memory &&
              performance.memory.usedJSHeapSize) || 0;
    } catch (_) { return 0; }
  }

  function memLimit() {
    try {
      return (performance && performance.memory &&
              performance.memory.jsHeapSizeLimit) || TIER_ABORT * 3;
    } catch (_) { return TIER_ABORT * 3; }
  }

  function memAvail() { return Math.max(0, memLimit() - memUsed()); }

  // ── Tier classification ────────────────────────────────────────────────────
  function tier() {
    var u = memUsed();
    if (u >= TIER_ABORT) return 'abort';
    if (u >= TIER_CRIT)  return 'critical';
    if (u >= TIER_LOW)   return 'low';
    if (u >= TIER_REDUCE) return 'reduce';
    return 'ok';
  }

  function isUnderPressure() {
    var t = tier();
    return t === 'low' || t === 'critical' || t === 'abort';
  }

  function isCritical() {
    var t = tier();
    return t === 'critical' || t === 'abort';
  }

  // Returns true if allocating bytesNeeded × safetyFactor would exceed limit.
  function wouldExceedLimit(bytesNeeded, safetyFactor) {
    return (bytesNeeded * (safetyFactor || 4)) > memAvail();
  }

  // ── Adaptive scale getters ─────────────────────────────────────────────────
  // type: 'pdf' | 'ocr' | 'img'
  function renderScale(type) {
    return (SCALES[tier()] || SCALES.ok)[type] || 1.0;
  }

  function maxWorkers() {
    return W_COUNTS[tier()] || 1;
  }

  // ── Recommended I/O chunk size ─────────────────────────────────────────────
  function chunkSize() {
    var t = tier();
    if (t === 'abort' || t === 'critical') return 1 * MB;
    if (t === 'low')                        return 2 * MB;
    if (t === 'reduce')                     return 4 * MB;
    return 8 * MB;
  }

  // ── OCR mode recommendation ────────────────────────────────────────────────
  function ocrMode() {
    var t = tier();
    if (t === 'abort' || t === 'critical') return 'fast';
    if (t === 'low')                        return 'balanced';
    return 'accurate';
  }

  // ── Emergency cleanup ──────────────────────────────────────────────────────
  var _cleanupCbs = [];

  function onPressure(fn) {
    if (typeof fn === 'function') _cleanupCbs.push(fn);
    // Returns unsubscribe function
    return function () {
      var i = _cleanupCbs.indexOf(fn);
      if (i !== -1) _cleanupCbs.splice(i, 1);
    };
  }

  function emergencyCleanup() {
    _cleanupCbs.forEach(function (fn) { try { fn(); } catch (_) {} });
    // Chrome non-standard GC hint
    if (typeof gc === 'function') { try { gc(); } catch (_) {} }
    // Sweep stale OPFS files if OPFSManager is loaded
    if (window.OPFSManager && window.OPFSManager.sweep) {
      window.OPFSManager.sweep().catch(function () {});
    }
  }

  // ── Tier-change monitoring loop ────────────────────────────────────────────
  var _lastTier  = 'ok';
  var _tierCbs   = [];
  var _monitorId = null;

  function onTierChange(fn) {
    if (typeof fn === 'function') _tierCbs.push(fn);
    return function () {
      var i = _tierCbs.indexOf(fn);
      if (i !== -1) _tierCbs.splice(i, 1);
    };
  }

  function startMonitoring(ms) {
    if (_monitorId) return;
    _monitorId = setInterval(function () {
      var cur = tier();
      if (cur !== _lastTier) {
        var old = _lastTier;
        _lastTier = cur;
        _tierCbs.forEach(function (fn) { try { fn(cur, old); } catch (_) {} });
        if (cur === 'critical' || cur === 'abort') emergencyCleanup();
      }
    }, ms || 8000);
  }

  function stopMonitoring() {
    if (_monitorId) { clearInterval(_monitorId); _monitorId = null; }
  }

  // ── Stats snapshot ────────────────────────────────────────────────────────
  function stats() {
    var u = memUsed(), l = memLimit();
    return {
      tier:       tier(),
      usedMB:     Math.round(u / MB),
      limitMB:    Math.round(l / MB),
      availMB:    Math.round(memAvail() / MB),
      pct:        l > 0 ? Math.round(u / l * 100) : 0,
      scales:     SCALES[tier()] || SCALES.ok,
      maxWorkers: maxWorkers(),
    };
  }

  // Begin monitoring immediately
  startMonitoring(8000);

  // ── Integrate with the existing MemoryMonitor if present ──────────────────
  if (window.MemoryMonitor) {
    try {
      window.MemoryMonitor.isUnderPressure  = isUnderPressure;
      window.MemoryMonitor.wouldExceedLimit = wouldExceedLimit;
    } catch (_) {}
  }

  window.MemPressure = {
    // Tier
    tier:             tier,
    isUnderPressure:  isUnderPressure,
    isCritical:       isCritical,
    wouldExceedLimit: wouldExceedLimit,
    // Scaling
    renderScale:      renderScale,
    maxWorkers:       maxWorkers,
    chunkSize:        chunkSize,
    ocrMode:          ocrMode,
    // Memory readings
    memUsed:          memUsed,
    memLimit:         memLimit,
    memAvail:         memAvail,
    // Emergency
    emergencyCleanup: emergencyCleanup,
    onPressure:       onPressure,
    // Monitoring
    onTierChange:     onTierChange,
    startMonitoring:  startMonitoring,
    stopMonitoring:   stopMonitoring,
    // Debug
    stats:            stats,
    TIERS: {
      reduce:   TIER_REDUCE,
      low:      TIER_LOW,
      critical: TIER_CRIT,
      abort:    TIER_ABORT,
    },
  };

}());
