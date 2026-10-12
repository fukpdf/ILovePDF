// ad-manager.js — Phase 4: Revenue Architecture Foundation
// =====================================================================
// Display ad slot lifecycle manager: discovery → viewability → activation.
// Separate from runtime-ads.js (which handles rewarded/interstitial ads).
// This module handles display/banner ads for AdSense, Ezoic, Media.net.
//
// ADDITIVE ONLY. Never touches BrowserTools, Workers, Arc, Security, or
// any output/processing logic.
//
// window.AdManager API:
//   .register(id, el)        — register a slot element manually
//   .discoverSlots()         — scan DOM for [data-ad-slot] elements
//   .activate(id)            — activate a specific slot
//   .activateAll()           — activate all viewable slots
//   .setProvider(name)       — 'none' | 'adsense' | 'ezoic' | 'medianet'
//   .onViewable(id, cb)      — callback when slot enters viewport
//   .getStats()              — { total, active, viewable, provider }
//   .createStickyFooter()    — inject mobile sticky footer ad slot
//
// Slot HTML convention:
//   <div class="ad-slot ad-slot--TYPE"
//        data-ad-slot="UNIQUE-ID"
//        data-ad-ezoic="NNN"
//        data-ad-adsense="ADSENSE-SLOT-ID"   ← added when slot IDs are issued
//        data-ad-pending="1"                  ← removed when slot activates
//        aria-hidden="true"
//        role="complementary"></div>
//
// Ezoic placeholder IDs in use:
//   101 — homepage hero-below (leaderboard)
//   102 — homepage in-content / between sections
//   103 — homepage footer (leaderboard)
//   104 — download page banner
//   105 — tool page sidebar rectangle (future)
//   106 — mobile sticky footer (anchor)
// =====================================================================
(function (G) {
  'use strict';

  if (G.AdManager) return;

  var PUB_ID   = 'ca-pub-3242156405919556';
  var LOG      = '[AdManager]';
  var _provider = 'none';
  var _slots   = {};     // slotId → { el, active, viewable, ezoicId, adsenseId }
  var _viewCbs = {};     // slotId → [callbacks]
  var _observer = null;
  var _mobile  = typeof G.navigator !== 'undefined' &&
    /Mobi|Android|iPhone|iPad/i.test(G.navigator.userAgent || '');

  // ── Provider auto-detection ───────────────────────────────────────────────
  function _detectProvider() {
    if (G.ezstandalone && typeof G.ezstandalone.cmd === 'object') return 'ezoic';
    if (G.adsbygoogle || (G.googletag && G.googletag.pubadsReady)) return 'adsense';
    return 'none';
  }

  // ── IntersectionObserver (lazy viewability) ───────────────────────────────
  function _initObserver() {
    if (_observer || !G.IntersectionObserver) return;
    _observer = new G.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = entry.target.getAttribute('data-ad-slot');
        if (!id || !_slots[id]) return;
        var s = _slots[id];
        if (s.viewable) return;
        s.viewable = true;
        _observer.unobserve(entry.target);
        // Fire viewable callbacks
        (_viewCbs[id] || []).forEach(function (cb) {
          try { cb(id); } catch (_) {}
        });
        _viewCbs[id] = [];
        // Auto-activate if provider is ready
        if (_provider !== 'none') _activateSlot(id);
      });
    }, { rootMargin: '200px 0px', threshold: 0.01 });
  }

  // ── Register one slot ─────────────────────────────────────────────────────
  function register(id, el) {
    if (!id || !el) return;
    if (_slots[id]) return; // already registered
    _slots[id] = {
      el:        el,
      active:    false,
      viewable:  false,
      ezoicId:   el.getAttribute('data-ad-ezoic')  || null,
      adsenseId: el.getAttribute('data-ad-adsense') || null,
      type:      el.getAttribute('data-ad-type')    || 'auto',
    };
    _initObserver();
    if (_observer) _observer.observe(el);
  }

  // ── Discover all slots in current DOM ────────────────────────────────────
  function discoverSlots() {
    try {
      document.querySelectorAll('[data-ad-slot]').forEach(function (el) {
        var id = el.getAttribute('data-ad-slot');
        if (id && !_slots[id]) register(id, el);
      });
    } catch (e) {
      console.warn(LOG, 'discoverSlots error:', e && e.message);
    }
  }

  // ── Activate a slot (internal) ────────────────────────────────────────────
  function _activateSlot(id) {
    var s = _slots[id];
    if (!s || s.active) return;
    var p = _provider !== 'none' ? _provider : _detectProvider();
    if (p === 'adsense')  _activateAdSense(id, s);
    else if (p === 'ezoic') _activateEzoic(id, s);
    // else: pending — slot reserved, no fill yet
  }

  // ── AdSense activation ────────────────────────────────────────────────────
  // Slots need explicit slot IDs (issued after AdSense account approval).
  // Until then, data-ad-adsense is absent and the slot stays reserved/empty.
  function _activateAdSense(id, s) {
    s.adsenseId = s.adsenseId || s.el.getAttribute('data-ad-adsense');
    if (!s.adsenseId) return; // pending approval — slot reserved but not filled
    try {
      s.el.innerHTML = '';
      var ins = document.createElement('ins');
      ins.className                       = 'adsbygoogle';
      ins.style.display                   = 'block';
      ins.dataset.adClient                = PUB_ID;
      ins.dataset.adSlot                  = s.adsenseId;
      ins.dataset.adFormat                = 'auto';
      ins.dataset.fullWidthResponsive     = 'true';
      s.el.appendChild(ins);
      (G.adsbygoogle = G.adsbygoogle || []).push({});
      s.el.removeAttribute('data-ad-pending');
      s.el.classList.add('ad-slot--active');
      s.active = true;
    } catch (e) {
      console.warn(LOG, 'AdSense activation failed for', id, ':', e && e.message);
    }
  }

  // ── Ezoic activation ─────────────────────────────────────────────────────
  // Renames container to ezoic-pub-ad-placeholder-NNN and triggers displayAd.
  function _activateEzoic(id, s) {
    if (!s.ezoicId) return;
    try {
      s.el.id = 'ezoic-pub-ad-placeholder-' + s.ezoicId;
      if (G.ezstandalone && G.ezstandalone.cmd) {
        var ezId = parseInt(s.ezoicId, 10);
        G.ezstandalone.cmd.push(function () {
          if (typeof G.ezstandalone.displayAd === 'function') {
            G.ezstandalone.displayAd(ezId);
          }
        });
      }
      s.el.removeAttribute('data-ad-pending');
      s.el.classList.add('ad-slot--active');
      s.active = true;
    } catch (e) {
      console.warn(LOG, 'Ezoic activation failed for', id, ':', e && e.message);
    }
  }

  // ── Public: activate a specific slot ─────────────────────────────────────
  function activate(id) {
    if (!_slots[id]) return;
    _activateSlot(id);
  }

  // ── Public: activate all viewable slots ──────────────────────────────────
  function activateAll() {
    _provider = _detectProvider();
    discoverSlots();
    Object.keys(_slots).forEach(function (id) {
      if (_slots[id].viewable) _activateSlot(id);
    });
  }

  // ── Mobile sticky footer injection ────────────────────────────────────────
  // Appends a fixed-bottom anchor ad container on mobile only.
  // Slot ID: sticky-footer | Ezoic placeholder: 106
  function createStickyFooter() {
    if (!_mobile) return;
    if (document.getElementById('ad-slot-sticky-footer')) return;
    try {
      var el = document.createElement('div');
      el.className                  = 'ad-slot ad-slot--sticky-footer';
      el.id                         = 'ad-slot-sticky-footer';
      el.setAttribute('data-ad-slot',   'sticky-footer');
      el.setAttribute('data-ad-ezoic',  '106');
      el.setAttribute('data-ad-pending','1');
      el.setAttribute('aria-label',     'Advertisement');
      el.setAttribute('role',           'complementary');
      el.setAttribute('aria-hidden',    'true');
      document.body.appendChild(el);
      register('sticky-footer', el);
    } catch (e) {
      console.warn(LOG, 'createStickyFooter error:', e && e.message);
    }
  }

  // ── Public: onViewable callback ───────────────────────────────────────────
  function onViewable(id, cb) {
    if (typeof cb !== 'function') return;
    if (_slots[id] && _slots[id].viewable) { try { cb(id); } catch (_) {} return; }
    if (!_viewCbs[id]) _viewCbs[id] = [];
    _viewCbs[id].push(cb);
  }

  // ── Public: setProvider ───────────────────────────────────────────────────
  function setProvider(name) {
    _provider = (name === 'adsense' || name === 'ezoic' || name === 'medianet')
      ? name : 'none';
  }

  // ── Public: getStats ──────────────────────────────────────────────────────
  function getStats() {
    var ids = Object.keys(_slots);
    return {
      total:    ids.length,
      active:   ids.filter(function (id) { return _slots[id].active; }).length,
      viewable: ids.filter(function (id) { return _slots[id].viewable; }).length,
      provider: _provider,
      slots:    ids.reduce(function (acc, id) {
        var s = _slots[id];
        acc[id] = { active: s.active, viewable: s.viewable, type: s.type };
        return acc;
      }, {}),
    };
  }

  // ── Boot: discover slots + create sticky footer once DOM is ready ─────────
  function _boot() {
    discoverSlots();
    createStickyFooter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    // DOM already ready (idle loader calls us after first paint)
    setTimeout(_boot, 0);
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  G.AdManager = Object.freeze({
    register:           register,
    discoverSlots:      discoverSlots,
    activate:           activate,
    activateAll:        activateAll,
    setProvider:        setProvider,
    onViewable:         onViewable,
    getStats:           getStats,
    createStickyFooter: createStickyFooter,
  });

}(window));
