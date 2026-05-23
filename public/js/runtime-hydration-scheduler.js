// RuntimeHydrationScheduler v1.0 — Arc 2 / Target 3
// =====================================================================
// Tier-based runtime hydration coordinator.
//
// Hydration groups:
//   P0  — critical/core (boot immediately, never deferred)
//   P1  — analytics/observability (on idle, max 1s delay)
//   P2  — AI extras / forensic replay / heavy telemetry (on interaction
//          or 5s idle — whichever comes first)
//
// Usage:
//   RuntimeHydrationScheduler.register(name, fn, tier)
//   RuntimeHydrationScheduler.activate(tier)   — manual override
//
// The scheduler does NOT load script tags. It manages the ACTIVATION
// of runtime modules registered via this API. Existing eagerly-loaded
// scripts continue to boot via their own DOMContentLoaded flow.
//
// Arc 2 runtime files (T5–T9) register themselves with the scheduler
// so their initialization is tier-aware.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHydrationScheduler) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HydSched]';
  var VERSION = '1.0';

  // ── Module registry ───────────────────────────────────────────────────────
  // { name, fn, tier, activated, durationMs }
  var _registry = [];
  var _activated = { P0: false, P1: false, P2: false };
  var _metrics   = { P0: null, P1: null, P2: null }; // { startTs, durationMs }

  function _now() { return Date.now(); }

  function _run(group) {
    if (_activated[group]) return;
    _activated[group] = true;
    var start = _now();
    var modules = _registry.filter(function (m) { return m.tier === group && !m.activated; });

    modules.forEach(function (m) {
      try {
        var t0 = _now();
        m.fn();
        m.activated  = true;
        m.durationMs = _now() - t0;
      } catch (e) {
        console.debug(LOG, 'module error:', m.name, e);
      }
    });

    _metrics[group] = { startTs: start, durationMs: _now() - start, count: modules.length };
    console.debug(LOG, group, 'activated —', modules.length, 'modules in', _metrics[group].durationMs + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('hydration:group-activated', {
        detail: { group: group, durationMs: _metrics[group].durationMs },
      }));
    } catch (_) {}
  }

  // ── P0: boot immediately ──────────────────────────────────────────────────
  function _bootP0() { _run('P0'); }

  // ── P1: boot on idle (requestIdleCallback or 1 s timeout) ────────────────
  function _scheduleP1() {
    if (G.requestIdleCallback) {
      G.requestIdleCallback(function () { _run('P1'); }, { timeout: 1000 });
    } else {
      setTimeout(function () { _run('P1'); }, 500);
    }
  }

  // ── P2: boot on first interaction OR 5 s idle ────────────────────────────
  var _p2Timer    = null;
  var _p2Handlers = ['click', 'touchstart', 'keydown', 'scroll', 'mousemove'];

  function _scheduleP2() {
    function _triggerP2() {
      clearTimeout(_p2Timer);
      _p2Handlers.forEach(function (ev) {
        document.removeEventListener(ev, _triggerP2, { passive: true, capture: true });
      });
      _run('P2');
    }
    _p2Handlers.forEach(function (ev) {
      document.addEventListener(ev, _triggerP2, { passive: true, capture: true, once: true });
    });
    _p2Timer = setTimeout(_triggerP2, 5000);
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────
  function _start() {
    _bootP0();
    _scheduleP1();
    _scheduleP2();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start, { once: true });
  } else {
    _start();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeHydrationScheduler = {
    VERSION: VERSION,

    register: function (name, fn, tier) {
      if (typeof fn !== 'function') return;
      var t = (tier === 'P0' || tier === 'P1' || tier === 'P2') ? tier : 'P2';
      _registry.push({ name: name, fn: fn, tier: t, activated: false, durationMs: null });
      // If the target tier is already activated, run immediately
      if (_activated[t]) {
        try {
          var t0 = _now();
          fn();
          _registry[_registry.length - 1].activated  = true;
          _registry[_registry.length - 1].durationMs = _now() - t0;
        } catch (e) { console.debug(LOG, 'late-register error:', name, e); }
      }
    },

    activate: function (tier) { _run(tier); },

    getMetrics: function () {
      return {
        P0: _metrics.P0,
        P1: _metrics.P1,
        P2: _metrics.P2,
        modules: _registry.map(function (m) {
          return { name: m.name, tier: m.tier, activated: m.activated, durationMs: m.durationMs };
        }),
      };
    },

    isActivated: function (tier) { return !!_activated[tier]; },
  };

}(window));
