// ad-responsive-engine.js — Phase 5: Responsive Multi-Stage Ad Orchestration
// =====================================================================
// Companion module to ad-manager.js. Extends it without modifying it
// (AdManager is a frozen object — this module calls its public API).
//
// Responsibilities:
//   1. Breakpoint detection (desktop/tablet/mobile)
//   2. Visit tracking + session-aware ad density
//   3. Tool step awareness — injects upload (201) + preview (202) slots
//      in response to ilpdf:step events dispatched by tool-page.js
//   4. Processing state detection — MutationObserver watches for modal/
//      processing overlays; sets body.tool-processing to hide ads
//   5. Sticky footer padding — adds body.has-sticky-ad so responsive-ads.css
//      can compensate body bottom padding on mobile
//
// ADDITIVE ONLY. Never touches:
//   BrowserTools, Workers, Security, Arc, processing logic, AdManager internals.
//
// window.AdResponsiveEngine API:
//   .getBreakpoint()     → 'desktop' | 'tablet' | 'mobile'
//   .getDensity()        → 'low' | 'normal'  (new vs returning visitor)
//   .getVisits()         → number
//   .isProcessing()      → boolean
//   .injectUploadSlot()  → inject Ezoic-201 slot into upload step
//   .injectPreviewSlot() → inject Ezoic-202 slot into preview step
//
// Session density rules:
//   First visit (_visits === 1)  → 'low'  : skip upload+preview slots
//   Return visits (_visits >= 2) → 'normal': show all slots
//   Download slot (104) is shown regardless of density.
//
// Responsive slot sizes (enforced by responsive-ads.css):
//   Desktop (≥1200px):  728×90  leaderboard
//   Tablet (768-1199px): 468×60  banner
//   Mobile (≤767px):    320×100  large mobile
// =====================================================================
(function (G) {
  'use strict';

  if (G.AdResponsiveEngine) return;

  var LOG       = '[AdRE]';
  var VISIT_KEY = 'ilpdf_visits_v1';

  // ── Breakpoint detection ──────────────────────────────────────────────────
  function getBreakpoint() {
    var w = (G.innerWidth) ||
            (G.screen && G.screen.availWidth) || 1200;
    if (w >= 1200) return 'desktop';
    if (w >= 768)  return 'tablet';
    return 'mobile';
  }

  // ── Visit tracking + session density ─────────────────────────────────────
  var _visits  = 1;
  var _density = 'low'; // 'low' for first visit, 'normal' for returning

  function _initVisitTracking() {
    try {
      var raw  = localStorage.getItem(VISIT_KEY);
      var data = raw ? JSON.parse(raw) : { count: 0, lastSession: 0 };
      var now  = Date.now();
      var NEW_SESSION_GAP = 30 * 60 * 1000; // 30 min = new session

      var isNewSession = (now - (data.lastSession || 0)) > NEW_SESSION_GAP;
      if (isNewSession) {
        data.count       = (data.count || 0) + 1;
        data.lastSession = now;
        try { localStorage.setItem(VISIT_KEY, JSON.stringify(data)); } catch (_) {}
      }
      _visits  = data.count || 1;
      _density = _visits <= 1 ? 'low' : 'normal';
    } catch (_) {
      _visits  = 1;
      _density = 'low';
    }
  }

  function getDensity() { return _density; }
  function getVisits()  { return _visits;  }

  // ── Processing state detection ─────────────────────────────────────────────
  // Watches the DOM for modal/processing overlays. When found, sets
  // body.tool-processing so responsive-ads.css can hide/slide ads away.
  // Zero changes to processFile() or BrowserTools.
  var _processing = false;

  var _PROCESSING_SELECTORS = [
    'modal-overlay',
    'processing-card',
    'process-overlay',
    'processing-overlay',
    'modal-backdrop',
  ];

  function _isProcessingNode(node) {
    if (!node || node.nodeType !== 1 || !node.classList) return false;
    for (var i = 0; i < _PROCESSING_SELECTORS.length; i++) {
      if (node.classList.contains(_PROCESSING_SELECTORS[i])) return true;
    }
    if (node.id === 'processing-overlay' || node.id === 'modal-overlay') return true;
    return false;
  }

  function _watchProcessingState() {
    if (!G.MutationObserver) return;
    var obs = new G.MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (_isProcessingNode(n)) _setProcessing(true);
        });
        Array.prototype.forEach.call(m.removedNodes, function (n) {
          if (_isProcessingNode(n)) _setProcessing(false);
        });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function _setProcessing(on) {
    if (_processing === on) return;
    _processing = on;
    document.body.classList.toggle('tool-processing', on);
  }

  function isProcessing() { return _processing; }

  // ── Slot HTML builder ──────────────────────────────────────────────────────
  function _makeSlotHtml(slotId, ezoicId, modifierClass) {
    var bp = getBreakpoint();
    return '<div class="ad-wrap ad-wrap--tight" role="complementary" aria-label="Advertisement">' +
      '<div' +
        ' class="ad-slot ' + modifierClass + '"' +
        ' id="ad-' + slotId + '"' +
        ' data-ad-slot="' + slotId + '"' +
        ' data-ad-ezoic="' + ezoicId + '"' +
        ' data-ad-pending="1"' +
        ' data-ad-bp="' + bp + '"' +
        ' aria-hidden="true">' +
      '</div>' +
    '</div>';
  }

  function _registerWithAdManager(slotId) {
    try {
      if (G.AdManager) {
        var el = document.getElementById('ad-' + slotId);
        if (el) {
          G.AdManager.register(slotId, el);
          G.AdManager.activateAll();
        }
      }
    } catch (e) {
      console.warn(LOG, 'register failed for', slotId, ':', e && e.message);
    }
  }

  // ── Upload slot injection (Ezoic 201) ────────────────────────────────────
  // Inserted after the .upload-step section so it appears below the upload
  // card, never inside it. Skipped for brand-new visitors (density = low).
  function injectUploadSlot() {
    if (_density === 'low') return; // lower ad density for first-time visitors
    if (document.getElementById('ad-upload-banner')) return; // guard: already present
    var anchor = document.querySelector('#tool-content .upload-step');
    if (!anchor) return;
    try {
      anchor.insertAdjacentHTML(
        'afterend',
        _makeSlotHtml('upload-banner', '201', 'ad-slot--upload')
      );
      setTimeout(function () { _registerWithAdManager('upload-banner'); }, 60);
    } catch (e) {
      console.warn(LOG, 'injectUploadSlot error:', e && e.message);
    }
  }

  // ── Preview slot injection (Ezoic 202) ───────────────────────────────────
  // Inserted after the .ew-preview-workspace so it appears below the preview
  // panel, never inside it. Shown for all visitors (preview = high intent).
  function injectPreviewSlot() {
    if (document.getElementById('ad-preview-banner')) return; // guard
    var anchor = document.querySelector('#tool-content .ew-preview-workspace');
    if (!anchor) return;
    try {
      anchor.insertAdjacentHTML(
        'afterend',
        _makeSlotHtml('preview-banner', '202', 'ad-slot--preview')
      );
      setTimeout(function () { _registerWithAdManager('preview-banner'); }, 60);
    } catch (e) {
      console.warn(LOG, 'injectPreviewSlot error:', e && e.message);
    }
  }

  // ── Step event listener ───────────────────────────────────────────────────
  // tool-page.js dispatches 'ilpdf:step' with { detail: { step: '...' } }
  // after each step's DOM is fully settled.
  function _listenStepEvents() {
    G.addEventListener('ilpdf:step', function (e) {
      var step = e && e.detail && e.detail.step;
      // Brief delay to ensure DOM is fully rendered before injecting
      setTimeout(function () {
        try {
          if (step === 'upload') {
            injectUploadSlot();
          } else if (step === 'preview') {
            injectPreviewSlot();
          } else if (step === 'download') {
            // Re-discover existing slot 104 (download-banner) which was
            // injected by renderDownloadStep() via tool-page.js innerHTML
            if (G.AdManager) G.AdManager.discoverSlots();
          }
        } catch (_) {}
      }, 200);
    });
  }

  // ── Sticky footer body padding ────────────────────────────────────────────
  // Adds body.has-sticky-ad so responsive-ads.css can compensate the fixed
  // footer height and prevent content being hidden beneath it.
  function _manageStickyFooterPadding() {
    var footer = document.getElementById('ad-slot-sticky-footer');
    if (!footer) return;
    document.body.classList.add('has-sticky-ad');

    // Watch in case footer is removed later
    if (!G.MutationObserver) return;
    var obs = new G.MutationObserver(function () {
      if (!document.getElementById('ad-slot-sticky-footer')) {
        document.body.classList.remove('has-sticky-ad');
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  }

  // ── Breakpoint attribute refresh on resize ────────────────────────────────
  // Updates data-ad-bp on all registered slots so CSS or JS can read the
  // current breakpoint from the element itself.
  function _onResize() {
    var bp = getBreakpoint();
    try {
      document.querySelectorAll('[data-ad-slot]').forEach(function (el) {
        el.setAttribute('data-ad-bp', bp);
      });
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _initVisitTracking();
    _watchProcessingState();
    _listenStepEvents();

    // Sticky footer padding — wait briefly for AdManager to inject footer first
    setTimeout(_manageStickyFooterPadding, 400);

    // Resize debounce
    var _resizeTimer;
    if (G.addEventListener) {
      G.addEventListener('resize', function () {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(_onResize, 150);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    setTimeout(_boot, 0);
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  G.AdResponsiveEngine = Object.freeze({
    getBreakpoint:    getBreakpoint,
    getDensity:       getDensity,
    getVisits:        getVisits,
    isProcessing:     isProcessing,
    injectUploadSlot:  injectUploadSlot,
    injectPreviewSlot: injectPreviewSlot,
  });

}(window));
