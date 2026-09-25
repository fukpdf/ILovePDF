// RuntimeHydrationDomains v1.0 — Arc 3 / Phase B / Target 3
// =====================================================================
// Per-tool isolated hydration queues.
//
// Problem: RuntimeHydrationScheduler is globally shared. Activating P2 for
// OCR triggers all globally-registered P2 modules (including those for
// Merge PDF, Compress, etc.) — wasting cycles and causing cross-tool
// interference.
//
// Solution: Each tool gets its own hydration domain with independent
// P0/P1/P2 queues and activation flags. Modules register with a toolId
// instead of (or in addition to) the global scheduler.
//
// Domain lifecycle:
//   createDomain(toolId, defaultTier) → domain object
//   register(toolId, name, fn, tier)  → enqueue module
//   activate(toolId, tier)            → flush that tier's queue
//   activateAll(toolId)               → flush all tiers
//
// Domains are automatically flushed by RuntimeToolLoader after manifest
// activation.
//
// The global RuntimeHydrationScheduler is preserved and continues to run
// for modules that don't use tool-scoped registration.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHydrationDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HydDomains]';
  var VERSION = '1.1';

  // ── Domain registry ───────────────────────────────────────────────────────
  var _domains = {};

  function _now() { return Date.now(); }

  function _newDomain(toolId, defaultTier) {
    return {
      toolId:    toolId,
      defaultTier: defaultTier || 'P2',
      registry:  [],
      activated: { P0: false, P1: false, P2: false },
      metrics:   { P0: null, P1: null, P2: null },
    };
  }

  function createDomain(toolId, defaultTier) {
    if (_domains[toolId]) return _domains[toolId];
    _domains[toolId] = _newDomain(toolId, defaultTier);
    console.debug(LOG, 'domain created:', toolId, '— defaultTier:', defaultTier || 'P2');
    return _domains[toolId];
  }

  // ── Run one tier within a domain ──────────────────────────────────────────
  function _runTier(domain, tier) {
    if (domain.activated[tier]) {
      return { ok: true, alreadyActive: true, toolId: domain.toolId, tier: tier, errors: 0, modules: 0 };
    }
    var start = _now();
    var modules = domain.registry.filter(function (m) { return m.tier === tier && !m.activated; });
    var errors = [];
    modules.forEach(function (m) {
      try {
        var t0 = _now();
        m.fn();
        m.activated = true;
        m.durationMs = _now() - t0;
      } catch (e) {
        var message = e && e.message || String(e);
        errors.push({ name: m.name, message: message });
        console.debug(LOG, 'module error:', domain.toolId, '/', m.name, message);
      }
    });
    var dur = _now() - start;
    var ok = errors.length === 0;
    if (ok) domain.activated[tier] = true;
    domain.metrics[tier] = {
      startTs: start,
      durationMs: dur,
      count: modules.length,
      activatedCount: modules.filter(function (m) { return m.activated; }).length,
      errorCount: errors.length,
      errors: errors.slice(),
      ok: ok,
    };
    try {
      G.dispatchEvent(new CustomEvent(ok ? 'hydration-domain:activated' : 'hydration-domain:activation-failed', {
        detail: { toolId: domain.toolId, tier: tier, durationMs: dur, ok: ok, errorCount: errors.length },
      }));
    } catch (_) {}
    return { ok: ok, alreadyActive: false, toolId: domain.toolId, tier: tier, errors: errors.slice(), modules: modules.length, activatedCount: modules.filter(function (m) { return m.activated; }).length };
  }

  // ── Schedule a tier with appropriate timing ───────────────────────────────
  function _scheduleTier(domain, tier) {
    if (tier === 'P0') {
      _runTier(domain, 'P0');
      return;
    }
    if (tier === 'P1') {
      if (G.requestIdleCallback) {
        G.requestIdleCallback(function () { _runTier(domain, 'P1'); }, { timeout: 1000 });
      } else {
        setTimeout(function () { _runTier(domain, 'P1'); }, 500);
      }
      return;
    }
    if (tier === 'P2') {
      // First interaction or 5s timeout
      var triggered = false;
      var handlers  = ['click', 'touchstart', 'keydown', 'scroll'];
      var timer     = null;
      function trigger() {
        if (triggered) return;
        triggered = true;
        clearTimeout(timer);
        handlers.forEach(function (ev) {
          document.removeEventListener(ev, trigger, true);
        });
        _runTier(domain, 'P2');
      }
      handlers.forEach(function (ev) {
        document.addEventListener(ev, trigger, { passive: true, capture: true, once: true });
      });
      timer = setTimeout(trigger, 5000);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function register(toolId, name, fn, tier) {
    if (typeof fn !== 'function') return;
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);

    var t = (tier === 'P0' || tier === 'P1' || tier === 'P2') ? tier : (domain.defaultTier || 'P2');
    domain.registry.push({ name: name, fn: fn, tier: t, activated: false, durationMs: null });

    // Late-register: if tier already active, run immediately
    if (domain.activated[t]) {
      try {
        var t0 = _now();
        fn();
        domain.registry[domain.registry.length - 1].activated  = true;
        domain.registry[domain.registry.length - 1].durationMs = _now() - t0;
      } catch (e) { console.debug(LOG, 'late-register error:', toolId, '/', name, e); }
    }
  }

  function activate(toolId, tier) {
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);
    return _runTier(domain, tier);
  }

  function activateAll(toolId) {
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);
    _runTier(domain, 'P0');
    _scheduleTier(domain, 'P1');
    _scheduleTier(domain, 'P2');
  }

  function getMetrics(toolId) {
    var domain = _domains[toolId];
    if (!domain) return null;
    return {
      toolId:    toolId,
      activated: Object.assign({}, domain.activated),
      metrics:   Object.assign({}, domain.metrics),
      activationStatus: Object.keys(domain.metrics).reduce(function (out, tier) {
        var metric = domain.metrics[tier];
        out[tier] = metric ? { ok: metric.ok !== false, errorCount: metric.errorCount || 0 } : null;
        return out;
      }, {}),
      modules:   domain.registry.map(function (m) {
        return { name: m.name, tier: m.tier, activated: m.activated, durationMs: m.durationMs };
      }),
    };
  }

  G.RuntimeHydrationDomains = Object.freeze({
    VERSION:     VERSION,
    createDomain: createDomain,
    register:    register,
    activate:    activate,
    activateAll: activateAll,
    getMetrics:  getMetrics,
    getDomains:  function () { return Object.keys(_domains); },
  });

}(window));
