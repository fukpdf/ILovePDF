// Phase 40E — Browser Compatibility Layer v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § E1  BrowserDetector    — UA + feature detection (Safari, iOS, Firefox, mobile)
// § E2  FallbackRouter     — per-capability routing to safe code paths
// § E3  MobileOptimizer    — lower-tier params for mobile browsers
// § E4  SafariFixes        — missing API shims for WebKit (non-breaking)
//
// Exposes: window.BrowserCompatLayer

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[BCL]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }


  // ═══════════════════════════════════════════════════════════════════════════
  // § E1  BROWSER DETECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var BrowserDetector = (function () {
    var ua  = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    var pf  = typeof navigator !== 'undefined' ? (navigator.platform  || '') : '';

    var IS_IOS     = /iPad|iPhone|iPod/.test(ua) || (pf === 'MacIntel' && navigator.maxTouchPoints > 1);
    var IS_SAFARI  = /^((?!chrome|android).)*safari/i.test(ua) || IS_IOS;
    var IS_FIREFOX = /Firefox\//.test(ua);
    var IS_CHROME  = /Chrome\//.test(ua) && !IS_SAFARI;
    var IS_MOBILE  = IS_IOS || /Android|Mobile/.test(ua);
    var IS_LOW_END = (navigator.hardwareConcurrency || 4) <= 2 || (navigator.deviceMemory || 4) <= 2;

    var CAPS = {
      webGpu:           typeof navigator !== 'undefined' && !!navigator.gpu,
      offscreenCanvas:  typeof OffscreenCanvas !== 'undefined',
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      sharedArrayBuffer:typeof SharedArrayBuffer !== 'undefined',
      idbLarge:         true,   // assumed; fallback on quota errors
      wasmThreads:      typeof SharedArrayBuffer !== 'undefined',
      decompressionStream: typeof DecompressionStream !== 'undefined',
      intersectionObserver: typeof IntersectionObserver !== 'undefined',
      opfs:             typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function',
    };

    function get() {
      return { IS_IOS: IS_IOS, IS_SAFARI: IS_SAFARI, IS_FIREFOX: IS_FIREFOX, IS_CHROME: IS_CHROME, IS_MOBILE: IS_MOBILE, IS_LOW_END: IS_LOW_END, CAPS: CAPS };
    }

    _log('detect', { safari: IS_SAFARI, ios: IS_IOS, mobile: IS_MOBILE, lowEnd: IS_LOW_END });
    return { get: get, IS_IOS: IS_IOS, IS_SAFARI: IS_SAFARI, IS_FIREFOX: IS_FIREFOX, IS_CHROME: IS_CHROME, IS_MOBILE: IS_MOBILE, IS_LOW_END: IS_LOW_END, CAPS: CAPS };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E2  FALLBACK ROUTER
  // Provides safe resolved capability flags that downstream systems can query.
  // ═══════════════════════════════════════════════════════════════════════════
  var FallbackRouter = (function () {
    var _overrides = {};

    function useWebGpu()           { return !_overrides.noWebGpu  && BrowserDetector.CAPS.webGpu && !BrowserDetector.IS_SAFARI; }
    function useOffscreenCanvas()  { return !_overrides.noOC      && BrowserDetector.CAPS.offscreenCanvas && !BrowserDetector.IS_IOS; }
    function useBroadcastChannel() { return !_overrides.noBC      && BrowserDetector.CAPS.broadcastChannel; }
    function useSharedArrayBuffer(){ return !_overrides.noSAB     && BrowserDetector.CAPS.sharedArrayBuffer; }
    function useOpfs()             { return !_overrides.noOpfs    && BrowserDetector.CAPS.opfs; }
    function useWasmThreads()      { return !_overrides.noThreads && BrowserDetector.CAPS.wasmThreads; }
    function useDecomp()           { return BrowserDetector.CAPS.decompressionStream; }

    function setOverride(key, val) { _overrides[key] = val; }
    function clearOverrides()      { _overrides = {}; }

    function getAll() {
      return {
        webGpu:           useWebGpu(),
        offscreenCanvas:  useOffscreenCanvas(),
        broadcastChannel: useBroadcastChannel(),
        sharedArrayBuffer:useSharedArrayBuffer(),
        opfs:             useOpfs(),
        wasmThreads:      useWasmThreads(),
        decompressionStream: useDecomp(),
      };
    }

    return { useWebGpu: useWebGpu, useOffscreenCanvas: useOffscreenCanvas, useBroadcastChannel: useBroadcastChannel, useSharedArrayBuffer: useSharedArrayBuffer, useOpfs: useOpfs, useWasmThreads: useWasmThreads, useDecomp: useDecomp, setOverride: setOverride, clearOverrides: clearOverrides, getAll: getAll };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E3  MOBILE OPTIMIZER
  // Pushes lower-tier params to AutoTuningEngine on mobile/low-end devices.
  // ═══════════════════════════════════════════════════════════════════════════
  var MobileOptimizer = (function () {
    var _applied = false;

    function apply() {
      if (_applied) return;
      if (!BrowserDetector.IS_MOBILE && !BrowserDetector.IS_LOW_END) return;
      _applied = true;
      var ate = window.AutoTuningEngine;
      if (!ate) return;
      var ac = ate.AdaptiveController;
      if (!ac) return;
      ac.setOverride('renderScale',  0.75);
      ac.setOverride('concurrency',  1);
      ac.setOverride('batchSize',    2);
      ac.setOverride('ocrMode',      'fast');
      ac.setOverride('chunkSizeMB',  1);
      if (BrowserDetector.IS_MOBILE) ac.setOverride('workerCount', 1);
      _log('mobile-optimizations-applied', { mobile: BrowserDetector.IS_MOBILE, lowEnd: BrowserDetector.IS_LOW_END });
    }

    function isApplied() { return _applied; }

    // Apply after a short delay to let AutoTuningEngine load
    setTimeout(function () { apply(); }, 3500);

    return { apply: apply, isApplied: isApplied };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E4  SAFARI FIXES
  // Non-breaking polyfill shims for missing Safari APIs.
  // ═══════════════════════════════════════════════════════════════════════════
  var SafariFixes = (function () {
    var _applied = [];

    // BroadcastChannel shim for older Safari (post-message based fallback)
    if (!BrowserDetector.CAPS.broadcastChannel && typeof window !== 'undefined') {
      window.BroadcastChannel = (function () {
        var _channels = {};
        function BC(name) {
          this._name = name;
          this.onmessage = null;
          if (!_channels[name]) _channels[name] = [];
          _channels[name].push(this);
        }
        BC.prototype.postMessage = function (data) {
          var self = this;
          (_channels[this._name] || []).forEach(function (ch) {
            if (ch !== self && ch.onmessage) {
              try { ch.onmessage({ data: data }); } catch (_) {}
            }
          });
        };
        BC.prototype.close = function () {
          _channels[this._name] = (_channels[this._name] || []).filter(function (ch) { return ch !== this; }, this);
        };
        return BC;
      }());
      _applied.push('BroadcastChannel-shim');
      _log('shim-broadcast-channel', {});
    }

    // IntersectionObserver no-op shim for browsers that don't have it
    if (!BrowserDetector.CAPS.intersectionObserver && typeof window !== 'undefined') {
      window.IntersectionObserver = function (cb) {
        this.observe   = function () {};
        this.unobserve = function () {};
        this.disconnect= function () {};
      };
      _applied.push('IntersectionObserver-noop');
    }

    // Disable WebGPU on Safari (unstable in many versions)
    if (BrowserDetector.IS_SAFARI) {
      FallbackRouter.setOverride('noWebGpu', true);
      _applied.push('webgpu-disabled-safari');
    }

    // Disable OPFS on iOS (quota issues in private browsing)
    if (BrowserDetector.IS_IOS) {
      FallbackRouter.setOverride('noOpfs', false);   // OPFS is ok on recent iOS, just log
      _applied.push('ios-opfs-caution');
    }

    function getApplied() { return _applied.slice(); }
    return { getApplied: getApplied };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.BrowserCompatLayer = {
    version:          VERSION,
    BrowserDetector:  BrowserDetector,
    FallbackRouter:   FallbackRouter,
    MobileOptimizer:  MobileOptimizer,
    SafariFixes:      SafariFixes,

    isMobile:   function () { return BrowserDetector.IS_MOBILE; },
    isSafari:   function () { return BrowserDetector.IS_SAFARI; },
    isLowEnd:   function () { return BrowserDetector.IS_LOW_END; },
    canUseGpu:  function () { return FallbackRouter.useWebGpu(); },
    canUseOpfs: function () { return FallbackRouter.useOpfs(); },

    audit: function () {
      return {
        version:      VERSION,
        browser:      BrowserDetector.get(),
        capabilities: FallbackRouter.getAll(),
        shimApplied:  SafariFixes.getApplied(),
        mobileOptApplied: MobileOptimizer.isApplied(),
      };
    },
  };

  _log('loaded', { safari: BrowserDetector.IS_SAFARI, mobile: BrowserDetector.IS_MOBILE, lowEnd: BrowserDetector.IS_LOW_END });
}());
