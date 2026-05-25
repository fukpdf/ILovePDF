// RuntimeAdaptiveBundles v1.0 — Arc 9 / Phase H
// =====================================================================
// Self-optimizing bundle engine. Tracks usage patterns and dynamically
// adjusts bundle prioritization, lazy-loading strategy, and dormant
// bundle management based on device tier and session behavior.
//
// Distinct from RuntimeProcessorBundles (Arc 6 — processor code loading)
// and RuntimeBundleGraph (Arc 4 — bundle dependency graph).
//
// Features:
//   - Usage tracker: per-bundle activation count + recency
//   - Device-tier bundle plans: low-end minimizes, high-end pre-activates
//   - Dormant detection: bundle unused for 30min → candidate for advisory unload
//   - Predictive hydration: if AdaptiveAI predicts tool X → pre-load X's bundle
//   - Usage-based reprioritization: high-frequency bundles get early loading
//   - Low-end minimization: defer Arc4+ bundles on constrained devices
//   - High-end pre-activation: warm up all processor bundles on capable devices
//
// Integrates: RuntimeProcessorBundles, RuntimeBundleGraph,
//   RuntimeAdaptiveAI, RuntimePredictiveLoader, RuntimeProcessorLoader
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAdaptiveBundles) return;

  var LOG     = '[AdaptiveBundles]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  function _deviceTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getDeviceTier) return mh.getDeviceTier();
    } catch (_) {}
    var mem = navigator.deviceMemory || 4;
    var cpu = navigator.hardwareConcurrency || 4;
    if (mem >= 8 && cpu >= 8) return 'high';
    if (mem >= 4 && cpu >= 4) return 'mid';
    return 'low';
  }

  var _tier = _deviceTier();

  // ── Bundle registry ───────────────────────────────────────────────
  // Known runtime bundles (in load priority order)
  var ALL_BUNDLES = [
    { id: 'arc2',  path: '/js/bundles/runtime-arc2.bundle.js',  tier: 1, tools: [] },
    { id: 'arc3',  path: '/js/bundles/runtime-arc3.bundle.js',  tier: 1, tools: [] },
    { id: 'arc4',  path: '/js/bundles/runtime-arc4.bundle.js',  tier: 2, tools: [] },
    { id: 'arc5',  path: '/js/bundles/runtime-arc5.bundle.js',  tier: 2, tools: [] },
    { id: 'arc6',  path: '/js/bundles/runtime-arc6.bundle.js',  tier: 2, tools: ['merge','split','compress','ocr','image','ai','convert','watermark','repair'] },
    { id: 'arc7',  path: '/js/bundles/runtime-arc7.bundle.js',  tier: 3, tools: [] },
    { id: 'arc8',  path: '/js/bundles/runtime-arc8.bundle.js',  tier: 3, tools: [] },
    { id: 'arc9',  path: '/js/bundles/runtime-arc9.bundle.js',  tier: 3, tools: [] },
  ];

  // ── Usage tracking ────────────────────────────────────────────────
  var _usage = {};
  // bundleId → { activations, lastUsed, firstUsed, toolActivations }

  function _ensureBundle(id) {
    if (!_usage[id]) _usage[id] = { activations: 0, lastUsed: 0, firstUsed: Date.now(), toolActivations: {} };
    return _usage[id];
  }

  function recordActivation(bundleId, toolId) {
    var u = _ensureBundle(bundleId);
    u.activations++;
    u.lastUsed = Date.now();
    if (toolId) u.toolActivations[toolId] = (u.toolActivations[toolId] || 0) + 1;
  }

  // ── Device bundle plan ────────────────────────────────────────────
  function _bundlePlan() {
    var plan = {
      eager:    [],  // load immediately
      deferred: [],  // load on demand
      skip:     [],  // skip entirely (low-end only)
    };

    if (_tier === 'low') {
      // Low-end: only critical runtime (arc2, arc3), rest deferred
      ALL_BUNDLES.forEach(function (b) {
        if (b.tier === 1) plan.eager.push(b.id);
        else if (b.tier === 2) plan.deferred.push(b.id);
        else plan.skip.push(b.id);
      });
    } else if (_tier === 'mid') {
      // Mid: eager arc2-arc5, deferred arc6+
      ALL_BUNDLES.forEach(function (b) {
        if (b.tier <= 2) plan.eager.push(b.id);
        else plan.deferred.push(b.id);
      });
    } else {
      // High: eager everything
      ALL_BUNDLES.forEach(function (b) { plan.eager.push(b.id); });
    }

    return plan;
  }

  // ── Dormant detection ─────────────────────────────────────────────
  var DORMANT_MS = 30 * 60 * 1000;  // 30 minutes

  function getDormantBundles() {
    var now      = Date.now();
    var dormant  = [];
    ALL_BUNDLES.forEach(function (b) {
      var u = _usage[b.id];
      if (!u) return;  // never activated → not dormant (unknown state)
      if ((now - u.lastUsed) > DORMANT_MS && u.activations > 0) {
        dormant.push({ id: b.id, lastUsed: u.lastUsed, ageMin: Math.round((now - u.lastUsed) / 60000) });
      }
    });
    return dormant;
  }

  // Advisory: emit event for RuntimeProcessorBundles to handle actual unload
  function adviseDormantUnload() {
    var dormant = getDormantBundles();
    if (!dormant.length) return dormant;
    dormant.forEach(function (d) {
      try {
        G.dispatchEvent(new CustomEvent('arc9:bundle-dormant', { detail: d }));
      } catch (_) {}
    });
    console.debug(LOG, 'dormant advisory:', dormant.map(function (d) { return d.id; }).join(','));
    return dormant;
  }

  // ── Predictive bundle hydration ───────────────────────────────────
  function predictivePreload(toolId) {
    // Find bundles that contain this tool
    var toPreload = ALL_BUNDLES.filter(function (b) {
      return b.tools.indexOf(toolId) !== -1;
    });

    toPreload.forEach(function (b) {
      try {
        // Use PredictiveLoader if available
        var pl = G.RuntimePredictiveLoader;
        if (pl && pl.preloadBundle) pl.preloadBundle(b.path, 'adaptive-bundles');
        recordActivation(b.id, toolId);
      } catch (_) {}
      try {
        G.dispatchEvent(new CustomEvent('arc9:bundle-preload', { detail: { bundleId: b.id, toolId: toolId } }));
      } catch (_) {}
    });

    return toPreload.map(function (b) { return b.id; });
  }

  // ── Usage-based reprioritization ─────────────────────────────────
  function getReprioritizedOrder() {
    var bundles = ALL_BUNDLES.slice();
    bundles.sort(function (a, b) {
      var ua = (_usage[a.id] && _usage[a.id].activations) || 0;
      var ub = (_usage[b.id] && _usage[b.id].activations) || 0;
      if (ua !== ub) return ub - ua;  // higher usage first
      return a.tier - b.tier;         // lower tier first (critical first)
    });
    return bundles.map(function (b) { return b.id; });
  }

  // ── High-end pre-activation ───────────────────────────────────────
  function _highEndPreActivate() {
    if (_tier !== 'high') return;
    // Pre-activate all processor bundle globals if not already present
    setTimeout(function () {
      ALL_BUNDLES.forEach(function (b) {
        try {
          G.dispatchEvent(new CustomEvent('arc9:bundle-preload', { detail: { bundleId: b.id, reason: 'high-end-preactivation' } }));
        } catch (_) {}
      });
      console.debug(LOG, 'high-end pre-activation sweep complete');
    }, 3000);
  }

  // ── Hook AdaptiveAI predictions ───────────────────────────────────
  G.addEventListener('arc9:preactivate', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.toolId) predictivePreload(d.toolId);
    } catch (_) {}
  });

  // Track tool activations from hydration events
  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.toolId) return;
      // Map tool to its bundle (arc6 contains all processors)
      recordActivation('arc6', d.toolId);
    } catch (_) {}
  });

  // Dormant sweep every 15 min
  setInterval(adviseDormantUnload, 15 * 60 * 1000);

  // High-end pre-activation at boot
  _highEndPreActivate();

  G.RuntimeAdaptiveBundles = Object.freeze({
    VERSION:              VERSION,
    recordActivation:     recordActivation,
    predictivePreload:    predictivePreload,
    getDormantBundles:    getDormantBundles,
    adviseDormantUnload:  adviseDormantUnload,
    getReprioritizedOrder: getReprioritizedOrder,
    getBundlePlan:        _bundlePlan,
    getDeviceTier:        function () { return _tier; },
    getUsage: function () {
      var result = {};
      Object.keys(_usage).forEach(function (k) { result[k] = Object.assign({}, _usage[k]); });
      return result;
    },
    getAll: function () { return ALL_BUNDLES.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — device tier:', _tier, '| dormant window:', DORMANT_MS / 60000 + 'min |', ALL_BUNDLES.length, 'bundles tracked');

}(window));
