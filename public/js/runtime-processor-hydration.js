// RuntimeProcessorHydration v1.0 — Arc 6 / Phase E
// =====================================================================
// Processor-specific hydration domains: no global hydration queues,
// idle cancellation, mobile-aware deferred hydration, predictive hooks.
//
// Extends RuntimeHydrationDomains (Arc 3) with processor-family-level
// orchestration:
//   - Each processor family gets its own hydration timeline (P0/P1/P2)
//   - Idle cancellation: if the tool that triggered hydration becomes
//     idle before P2 runs, the P2 queue is cleared
//   - Mobile-aware deferral: on low-tier devices, only P0 runs
//     immediately; P1 and P2 are deferred until tool is actually used
//   - Predictive hydration: register hints so that hovering a tool
//     pre-warms its processor's P1 queue
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorHydration) return;

  var LOG     = '[ProcHydration]';
  var VERSION = '1.0';
  var IDLE_CANCEL_MS = 5 * 60 * 1000; // 5 min idle → cancel pending P2

  // ── Processor hydration state ─────────────────────────────────────
  // family → { tiers: { P0, P1, P2 }, activated, lastActiveAt,
  //             idleCancelTimer, mobileTier, predictiveHints }
  var _hydration = {};

  // ── Mobile tier ───────────────────────────────────────────────────
  var _mobileTier = 'medium';
  function _initMobileTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getTier) { _mobileTier = mh.getTier(); return; }
      _mobileTier = (navigator.hardwareConcurrency || 4) <= 2 ? 'low' : 'medium';
    } catch (_) {}
  }

  // ── Create a processor hydration domain ───────────────────────────
  function createDomain(family, tools) {
    if (_hydration[family]) return _hydration[family];
    _hydration[family] = {
      family:         family,
      tools:          tools || [],
      tiers:          { P0: [], P1: [], P2: [] },
      activated:      { P0: false, P1: false, P2: false },
      metrics:        { P0: null, P1: null, P2: null },
      lastActiveAt:   0,
      idleCancelTimer: null,
    };
    console.debug(LOG, 'domain created:', family);
    return _hydration[family];
  }

  // ── Register a hydration module ───────────────────────────────────
  function register(family, name, fn, tier) {
    var dom = _hydration[family];
    if (!dom) dom = createDomain(family);
    tier = tier || 'P2';
    dom.tiers[tier] = dom.tiers[tier] || [];
    dom.tiers[tier].push({ name: name, fn: fn, activated: false });
  }

  // ── Activate a tier for a processor ───────────────────────────────
  function activate(family, tier) {
    var dom = _hydration[family];
    if (!dom) return;
    if (dom.activated[tier]) return;

    // Mobile low-tier: defer P1 + P2 until explicitly forced
    if (_mobileTier === 'low' && tier !== 'P0') {
      console.debug(LOG, 'mobile low-tier: deferring', family, tier);
      return;
    }

    dom.activated[tier] = true;
    dom.lastActiveAt    = Date.now();
    var modules = dom.tiers[tier] || [];
    var t0 = Date.now();

    modules.forEach(function (m) {
      if (m.activated) return;
      try {
        m.fn();
        m.activated = true;
      } catch (e) {
        console.debug(LOG, 'module error:', family, '/', m.name, e && e.message || e);
      }
    });

    var dur = Date.now() - t0;
    dom.metrics[tier] = { durationMs: dur, count: modules.length, ts: Date.now() };
    console.debug(LOG, family, tier, 'hydrated —', modules.length, 'modules in', dur + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('processor-hydration:activated', {
        detail: { family: family, tier: tier, durationMs: dur },
      }));
    } catch (_) {}
  }

  // ── Force-activate P1/P2 on low-tier (called on actual tool use) ──
  function forceActivate(family) {
    var dom = _hydration[family];
    if (!dom) return;
    ['P0', 'P1', 'P2'].forEach(function (tier) { activate(family, tier); });
  }

  // ── Idle cancellation ─────────────────────────────────────────────
  function _scheduleIdleCancel(family) {
    var dom = _hydration[family];
    if (!dom) return;
    if (dom.idleCancelTimer) clearTimeout(dom.idleCancelTimer);
    dom.idleCancelTimer = setTimeout(function () {
      if ((Date.now() - dom.lastActiveAt) < IDLE_CANCEL_MS) return;
      if (!dom.activated['P2']) {
        dom.tiers['P2'] = []; // clear P2 queue — it was never needed
        console.debug(LOG, 'idle cancel P2 queue cleared for:', family);
        try {
          G.dispatchEvent(new CustomEvent('processor-hydration:cancelled', {
            detail: { family: family, tier: 'P2' },
          }));
        } catch (_) {}
      }
    }, IDLE_CANCEL_MS);
  }

  // ── Predictive hydration via tool hover ───────────────────────────
  var _hoverScheduled = {};
  var TOOL_FAMILY = {
    'merge':'organize','split':'split','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress','compress-pdf':'compress',
    'pdf-to-word':'convert','pdf-to-excel':'convert','pdf-to-powerpoint':'convert',
    'word-to-pdf':'convert','excel-to-pdf':'convert','powerpoint-to-pdf':'convert',
    'watermark':'edit','sign':'edit','protect':'edit','unlock':'edit','edit':'edit',
    'repair':'repair','compare':'edit',
    'ocr':'ocr','ocr-pdf':'ocr',
    'ai-summarize':'ai-nlp','ai-summarizer':'ai-nlp','translate':'ai-nlp',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
  };

  function _installHoverPrewarm() {
    try {
      document.addEventListener('mouseover', function (e) {
        var el = e.target && e.target.closest && e.target.closest('[data-tool], .tool-card');
        if (!el) return;
        var toolId = el.getAttribute('data-tool') || '';
        if (!toolId) return;
        var family = TOOL_FAMILY[toolId];
        if (!family || _hoverScheduled[family]) return;
        _hoverScheduled[family] = true;
        setTimeout(function () {
          delete _hoverScheduled[family];
          var dom = _hydration[family];
          if (dom && !dom.activated['P1']) activate(family, 'P1');
        }, 300); // 300ms debounce
      }, { passive: true });
    } catch (_) {}
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (!id) return;
      var family = TOOL_FAMILY[id];
      if (!family) return;
      var dom = _hydration[family];
      if (dom) {
        dom.lastActiveAt = Date.now();
        forceActivate(family); // actual tool use → force all tiers
        _scheduleIdleCancel(family);
      }
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    _initMobileTier();
    _installHoverPrewarm();
    console.debug(LOG, 'v' + VERSION + ' booted — mobile tier:', _mobileTier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_hydration).forEach(function (family) {
      var d = _hydration[family];
      out[family] = {
        activated:    Object.assign({}, d.activated),
        metrics:      Object.assign({}, d.metrics),
        lastActiveAt: d.lastActiveAt,
        queueSizes:   { P0: d.tiers.P0.length, P1: d.tiers.P1.length, P2: d.tiers.P2.length },
      };
    });
    return out;
  }

  G.RuntimeProcessorHydration = Object.freeze({
    VERSION:        VERSION,
    createDomain:   createDomain,
    register:       register,
    activate:       activate,
    forceActivate:  forceActivate,
    getStats:       getStats,
    getMobileTier:  function () { return _mobileTier; },
    isActivated:    function (family, tier) { return !!((_hydration[family] || {}).activated || {})[tier || 'P0']; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — processor hydration domains active');

}(window));
