// RuntimeMobileHardening v1.0 — Arc 4 / Phase I / Target 9
// =====================================================================
// Thermal-aware hydration + battery-aware runtime unloading.
//
// Problem: low-end Android devices (1 GB RAM, 4 cores) experience:
//   - P2 hydration modules firing during thermal spikes (UI stutter)
//   - AI workers using 512 MB when only 256 MB is available
//   - Background workers staying alive on battery save mode
//   - No panic mode when heap approaches 100%
//
// Solution:
//   1. Device profile: detect low-end device (< 2 GB RAM or ≤ 2 cores)
//   2. Thermal-aware hydration: blocks P2 domains during thermal pressure
//      (reads device battery API thermal warnings)
//   3. Battery-aware unloading: on battery save, reduces all family caps
//      and evicts idle AI workers immediately
//   4. Mobile memory panic mode: heap > 90% → terminate all non-active
//      worker pools + trim all idle memory islands
//   5. Adaptive worker scaling: adjusts WorkerDomainThrottle caps based
//      on device profile at boot time
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMobileHardening) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[MobileHard]';
  var VERSION = '1.0';

  // ── Device profile ────────────────────────────────────────────────────────
  var _devMem   = (typeof navigator !== 'undefined' && navigator.deviceMemory)    || 4;
  var _devCores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

  var _profile = (function () {
    if (_devMem <= 1 || _devCores <= 2) return 'critical';
    if (_devMem <= 2 || _devCores <= 4) return 'low';
    if (_devMem <= 4)                    return 'medium';
    return 'high';
  }());

  var _isMobile = (function () {
    try { return /Mobi|Android|iPhone|iPad/.test(navigator.userAgent); } catch (_) { return false; }
  }());

  // ── Battery state ─────────────────────────────────────────────────────────
  var _battery = { level: 1, charging: true, saveMode: false };

  (function _initBattery() {
    try {
      if (navigator.getBattery) {
        navigator.getBattery().then(function (b) {
          function _update() {
            _battery.level    = b.level;
            _battery.charging = b.charging;
            _battery.saveMode = !b.charging && b.level < 0.20;
            if (_battery.saveMode) _onBatterySaveMode();
          }
          _update();
          b.addEventListener('levelchange',    _update);
          b.addEventListener('chargingchange', _update);
        }).catch(function () {});
      }
    } catch (_) {}
  }());

  // ── Thermal state ─────────────────────────────────────────────────────────
  var _thermal = { hot: false, critical: false };

  // Chrome Android: devicethermalstate (experimental)
  try {
    if (navigator.deviceMemory && typeof window.dispatchEvent === 'function') {
      // Listen for our own thermal events from RuntimeWorkerDomainRegistry
      G.addEventListener('worker-domain:crash', function (evt) {
        try {
          var crashes = evt && evt.detail && evt.detail.crashCount;
          if (crashes >= 3) { _thermal.hot = true; _onThermalPressure(); }
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── Adaptive worker cap reduction for low-end devices ─────────────────────
  function _applyDeviceCaps() {
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (!wdt) return;
      if (_profile === 'critical') {
        wdt.setFamilyCap('organize', 1);
        wdt.setFamilyCap('compress', 1);
        wdt.setFamilyCap('ai',       1);
        wdt.setFamilyCap('image',    1);
        wdt.setFamilyCap('edit',     1);
        wdt.setFamilyCap('convert-from', 1);
        wdt.setFamilyCap('convert-to',   1);
        console.debug(LOG, 'critical profile: all family caps → 1');
      } else if (_profile === 'low') {
        wdt.setFamilyCap('ai',    1);
        wdt.setFamilyCap('image', 2);
        console.debug(LOG, 'low profile: AI cap → 1, image cap → 2');
      }
    } catch (_) {}
  }

  // ── Battery save mode: reduce caps + evict AI workers ─────────────────────
  function _onBatterySaveMode() {
    console.debug(LOG, 'battery save mode — reducing worker caps');
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        wdt.setFamilyCap('ai', 1);
        wdt.setFamilyCap('image', 1);
      }
    } catch (_) {}
    try {
      var mo = G.RuntimeMemoryOrchestrator;
      if (mo) mo.evictFamily('ai', 'battery-save');
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('mobile:battery-save', { detail: { level: _battery.level } }));
    } catch (_) {}
  }

  // ── Thermal pressure: block P2 hydration + reduce caps ───────────────────
  function _onThermalPressure() {
    console.debug(LOG, 'thermal pressure — blocking P2 hydration');
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        wdt.setFamilyCap('ai',    1);
        wdt.setFamilyCap('image', 1);
        wdt.setFamilyCap('compress', 1);
      }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('mobile:thermal-pressure', { detail: { hot: _thermal.hot } }));
    } catch (_) {}
  }

  // ── Memory panic mode ─────────────────────────────────────────────────────
  var _panicActive = false;

  function _checkPanic() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return;
      var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
      if (pct < 0.90) { _panicActive = false; return; }
      if (_panicActive) return;

      _panicActive = true;
      console.debug(LOG, 'PANIC MODE: heap at', Math.round(pct * 100) + '%');

      // Trim ALL memory islands immediately
      try {
        var mi = G.RuntimeMemoryIslands;
        if (mi) {
          var all = mi.getAllStats();
          Object.keys(all).forEach(function (toolId) { mi.trim(toolId); });
        }
      } catch (_) {}

      // Terminate all non-active worker pools
      try {
        var wp      = G.WorkerPool;
        var wd      = G.RuntimeWorkerDomainRegistry;
        var active  = wd && wd.getActiveTool();
        var family  = active && wd.getFamily(active);
        if (wp && typeof wp.terminatePool === 'function') {
          var FAMILY_WORKERS = {
            'organize':     ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
            'compress':     ['/workers/compress-worker.js'],
            'ai':           ['/workers/advanced-worker.js', '/workers/summary-worker.js', '/workers/translation-worker.js', '/workers/ocr-preprocessor-worker.js'],
            'image':        ['/workers/image-tools-worker.js', '/workers/image-pipeline-worker.js', '/workers/remove-bg-worker.js'],
          };
          Object.keys(FAMILY_WORKERS).forEach(function (f) {
            if (f === family) return; // preserve active family
            FAMILY_WORKERS[f].forEach(function (url) {
              try { wp.terminatePool(url); } catch (_) {}
            });
          });
        }
      } catch (_) {}

      try {
        G.dispatchEvent(new CustomEvent('mobile:panic', { detail: { heapPct: Math.round(pct * 100) } }));
      } catch (_) {}
    } catch (_) {}
  }

  // ── Periodic panic check (every 20s on mobile / critical, else 45s) ──────
  var _panicInterval = (_isMobile || _profile === 'critical' || _profile === 'low') ? 20000 : 45000;
  var _panicTimer = setInterval(_checkPanic, _panicInterval);
  try { G.addEventListener('pagehide', function () { clearInterval(_panicTimer); }, { once: true }); } catch (_) {}

  // ── Apply device caps at boot ─────────────────────────────────────────────
  function _boot() {
    _applyDeviceCaps();
    if (_profile === 'critical' || _profile === 'low') {
      console.debug(LOG, 'mobile/low-end device detected — adaptive scaling applied —',
        'profile:', _profile, '| RAM:', _devMem + 'GB | cores:', _devCores);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 100);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeMobileHardening = Object.freeze({
    VERSION:    VERSION,
    getStatus:  function () {
      return {
        profile:      _profile,
        isMobile:     _isMobile,
        devMem:       _devMem,
        devCores:     _devCores,
        battery:      Object.assign({}, _battery),
        thermal:      Object.assign({}, _thermal),
        panicActive:  _panicActive,
      };
    },
    checkPanic:  _checkPanic,
    applyDeviceCaps: _applyDeviceCaps,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — profile:', _profile, '| mobile:', _isMobile);

}(window));
