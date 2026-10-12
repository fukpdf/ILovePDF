// RuntimeProcessorBundles v1.0 — Arc 6 / Phase F
// =====================================================================
// Per-processor bundle tracking, independent activation/GC,
// dormant processor unloading, bundle telemetry.
//
// Extends RuntimeToolBundleIsolation (Arc 5) with processor-family
// granularity:
//   - Each processor family tracks which bundles it has activated
//   - Bundle GC: when a processor becomes dormant, its bundles are
//     flagged as GC-eligible (after GC_TTL_MS with no active tools)
//   - Dormant unloading: dormant processor clears its bundle refs so
//     they can be GC'd by the browser
//   - Bundle telemetry: activation counts, load times, last used
//   - Cross-processor bundle deduplication: shared base bundles are
//     only marked GC-eligible when ALL processors using them are dormant
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorBundles) return;

  var LOG       = '[ProcBundles]';
  var VERSION   = '1.0';
  var GC_TTL_MS = 20 * 60 * 1000; // 20 min → GC-eligible

  // ── Base bundles shared by all processors ─────────────────────────
  var BASE_BUNDLES = ['core', 'security', 'zero-trust', 'hardening', 'infra',
                      'arc2', 'arc3', 'arc4', 'arc5', 'arc6'];

  // ── Processor-specific bundle extras ─────────────────────────────
  // (all processors inherit BASE_BUNDLES)
  var PROC_EXTRA_BUNDLES = {
    'organize':  [],
    'split':     [],
    'compress':  [],
    'convert':   [],
    'edit':      [],
    'repair':    [],
    'ocr':       [], // tesseract loaded on-demand in worker
    'ai-nlp':    [],
    'image':     [],
    'utility':   [],
  };

  // ── Bundle GC registry ────────────────────────────────────────────
  // bundleName → { activeProcessors: Set, lastActiveAt, gcEligibleSince, activations }
  var _gc = {};

  function _ensureBundle(name) {
    if (!_gc[name]) {
      _gc[name] = { name: name, activeProcessors: [], lastActiveAt: 0,
                    gcEligibleSince: null, activations: 0, telemetry: [] };
    }
    return _gc[name];
  }

  // ── Per-processor bundle state ────────────────────────────────────
  // family → { bundles: [], activatedAt, dormant, dormantAt, telemetry }
  var _procs = {};

  function _ensureProc(family) {
    if (!_procs[family]) {
      _procs[family] = {
        family: family,
        bundles: [],
        activatedAt: null,
        dormant: false,
        dormantAt: null,
        telemetry: [],
      };
    }
    return _procs[family];
  }

  // ── Activate bundles for a processor ─────────────────────────────
  function activateProcessor(family) {
    var proc = _ensureProc(family);
    if (proc.activatedAt && !proc.dormant) return; // already active

    proc.dormant    = false;
    proc.dormantAt  = null;
    proc.activatedAt = proc.activatedAt || Date.now();

    var bundles = BASE_BUNDLES.concat(PROC_EXTRA_BUNDLES[family] || []);
    proc.bundles = bundles.slice();

    bundles.forEach(function (b) {
      var rec = _ensureBundle(b);
      if (rec.activeProcessors.indexOf(family) === -1) rec.activeProcessors.push(family);
      rec.lastActiveAt = Date.now();
      rec.gcEligibleSince = null;
      rec.activations++;
      rec.telemetry.push({ ts: Date.now(), event: 'activate', family: family });
      if (rec.telemetry.length > 50) rec.telemetry.shift();
    });

    proc.telemetry.push({ ts: Date.now(), event: 'activated', bundles: bundles.length });
    console.debug(LOG, 'activated:', family, '—', bundles.length, 'bundles');

    try {
      G.dispatchEvent(new CustomEvent('processor-bundles:activated', {
        detail: { family: family, bundleCount: bundles.length },
      }));
    } catch (_) {}
  }

  // ── Mark a processor dormant (release its bundle refs) ────────────
  function markDormant(family) {
    var proc = _procs[family];
    if (!proc || proc.dormant) return;
    proc.dormant   = true;
    proc.dormantAt = Date.now();

    proc.bundles.forEach(function (b) {
      var rec = _gc[b];
      if (!rec) return;
      rec.activeProcessors = rec.activeProcessors.filter(function (f) { return f !== family; });
      if (rec.activeProcessors.length === 0) {
        rec.gcEligibleSince = rec.gcEligibleSince || Date.now();
        console.debug(LOG, 'bundle GC-eligible:', b, '— all processors dormant');
      }
    });

    proc.bundles = [];
    proc.telemetry.push({ ts: Date.now(), event: 'dormant' });
    console.debug(LOG, 'dormant:', family);

    try {
      G.dispatchEvent(new CustomEvent('processor-bundles:dormant', {
        detail: { family: family },
      }));
    } catch (_) {}
  }

  // ── GC scan ───────────────────────────────────────────────────────
  function getGCEligible() {
    var now = Date.now();
    return Object.keys(_gc).filter(function (name) {
      var rec = _gc[name];
      return rec.gcEligibleSince && (now - rec.gcEligibleSince) > GC_TTL_MS;
    }).map(function (name) {
      var rec = _gc[name];
      return { name: name, gcAge: now - rec.gcEligibleSince, activations: rec.activations };
    });
  }

  // ── Listen for processor-loader events ───────────────────────────
  G.addEventListener('processor-loader:activated', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) activateProcessor(family);
    } catch (_) {}
  });

  G.addEventListener('processor-loader:evicted', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) markDormant(family);
    } catch (_) {}
  });

  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (!id) return;
      // Refresh bundle activation for any processor that owns this tool
      Object.keys(_procs).forEach(function (family) {
        var proc = _procs[family];
        if (proc && proc.dormant) return;
        if (proc && !proc.activatedAt) activateProcessor(family);
      });
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = { processors: {}, bundles: {} };
    Object.keys(_procs).forEach(function (family) {
      var p = _procs[family];
      out.processors[family] = { dormant: p.dormant, bundles: p.bundles.length, activatedAt: p.activatedAt };
    });
    Object.keys(_gc).forEach(function (name) {
      var b = _gc[name];
      out.bundles[name] = { activeProcessors: b.activeProcessors.length, gcEligible: !!b.gcEligibleSince, activations: b.activations };
    });
    return out;
  }

  G.RuntimeProcessorBundles = Object.freeze({
    VERSION:           VERSION,
    activateProcessor: activateProcessor,
    markDormant:       markDormant,
    getGCEligible:     getGCEligible,
    getStats:          getStats,
    isActive:          function (family) { return !!((_procs[family] || {}).activatedAt && !(_procs[family] || {}).dormant); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-processor bundle GC active');

}(window));
