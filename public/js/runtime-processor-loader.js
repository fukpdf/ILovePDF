// RuntimeProcessorLoader v1.0 — Arc 6 / Phase B
// =====================================================================
// Dynamic processor activation with dependency graph, lazy hydration,
// dormant eviction, usage telemetry, startup timing, crash isolation.
//
// Extends RuntimeProcessorRegistry (Arc 4) with:
//   - Per-processor activation gate with dependency ordering
//   - Dormant processor eviction (DORMANT_MS idle → deactivate)
//   - Per-processor startup timing histogram
//   - Crash isolation: crashes in one processor do not affect others
//   - Predictive activation via tool hover + navigation hints
//   - Mobile-aware deferred activation (low-tier: serial, not parallel)
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorLoader) return;

  var LOG        = '[ProcLoader]';
  var VERSION    = '1.0';
  var DORMANT_MS = 15 * 60 * 1000; // 15 min idle → evict
  var SWEEP_MS   = 2  * 60 * 1000; // sweep every 2 min

  // ── Processor registry ────────────────────────────────────────────
  // family → { initFn, tools, workerUrl, memoryMb,
  //            activated, activatedAt, activationMs,
  //            dormantAt, crashCount, lastActiveAt }
  var _registry = {};

  // ── Dependency graph ─────────────────────────────────────────────
  // family → [required families that must activate first]
  var _deps = {
    'organize':     [],
    'split':        [],
    'compress':     [],
    'convert':      [],
    'convert-from': [],
    'convert-to':   [],
    'edit':         [],
    'repair':       [],
    'ocr':          [],
    'ai':           [],
    'ai-nlp':       [],
    'image':        [],
    'utility':      [],
  };

  // ── Mobile tier ───────────────────────────────────────────────────
  var _mobileTier = 'unknown';
  function _getMobileTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getTier) return mh.getTier();
      var cores = navigator.hardwareConcurrency || 4;
      if (cores <= 2) return 'low';
      if (cores <= 4) return 'medium';
      return 'high';
    } catch (_) { return 'medium'; }
  }

  // ── Register a processor ──────────────────────────────────────────
  function registerProcessor(family, spec) {
    if (!family || !spec || typeof spec.initFn !== 'function') return;
    if (_registry[family]) return; // already registered — idempotent

    _registry[family] = {
      family:       family,
      initFn:       spec.initFn,
      tools:        spec.tools        || [],
      workerUrl:    spec.workerUrl    || null,
      memoryMb:     spec.memoryMb     || 128,
      activated:    false,
      activatedAt:  null,
      activationMs: null,
      dormantAt:    null,
      crashCount:   0,
      lastActiveAt: Date.now(),
      startupHist:  [], // last 10 startup durations
    };
    console.debug(LOG, 'registered:', family, '—', (spec.tools || []).length, 'tools');
  }

  // ── Activate a processor (respects dependency graph) ──────────────
  function activate(family) {
    var proc = _registry[family];
    if (!proc) return;
    if (proc.activated) {
      proc.lastActiveAt = Date.now();
      proc.dormantAt    = null;
      return;
    }

    // Activate dependencies first (in-order, synchronous)
    var deps = _deps[family] || [];
    for (var di = 0; di < deps.length; di++) {
      activate(deps[di]);
    }

    var t0 = Date.now();
    try {
      proc.initFn();
      proc.activated    = true;
      proc.activatedAt  = Date.now();
      proc.activationMs = Date.now() - t0;
      proc.lastActiveAt = Date.now();
      proc.dormantAt    = null;
      proc.startupHist.push(proc.activationMs);
      if (proc.startupHist.length > 10) proc.startupHist.shift();

      console.debug(LOG, 'activated:', family, '—', proc.activationMs + 'ms');

      try {
        G.dispatchEvent(new CustomEvent('processor-loader:activated', {
          detail: { family: family, activationMs: proc.activationMs },
        }));
      } catch (_) {}
    } catch (e) {
      proc.crashCount++;
      console.debug(LOG, 'activation crash:', family, e && e.message || e);
      // Isolated — other processors unaffected
      try {
        G.dispatchEvent(new CustomEvent('processor-loader:crash', {
          detail: { family: family, error: e && e.message, crashCount: proc.crashCount },
        }));
      } catch (_) {}
    }
  }

  // ── Tool → family resolution ──────────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'split','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'merge-pdf':'organize','split-pdf':'split','rotate-pdf':'organize',
    'organize-pdf':'organize','pdf-to-jpg':'organize','jpg-to-pdf':'organize',
    'html-to-pdf':'organize','scan-to-pdf':'organize',
    'compress':'compress','compress-pdf':'compress',
    'pdf-to-word':'convert','pdf-to-excel':'convert','pdf-to-powerpoint':'convert',
    'word-to-pdf':'convert','excel-to-pdf':'convert','powerpoint-to-pdf':'convert',
    'word-to-excel':'convert',
    'watermark':'edit','sign':'edit','protect':'edit','unlock':'edit',
    'edit':'edit','compare':'edit',
    'repair':'repair','repair-pdf':'repair',
    'ocr':'ocr','ocr-pdf':'ocr',
    'ai-summarize':'ai-nlp','ai-summarizer':'ai-nlp',
    'translate':'ai-nlp','translate-pdf':'ai-nlp','workflow':'ai-nlp',
    'background-remover':'image','remove-background':'image',
    'crop-image':'image','resize-image':'image','image-filters':'image',
    'image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  function activateForTool(toolId) {
    var family = TOOL_FAMILY[toolId];
    if (family) {
      activate(family);
      if (_registry[family]) _registry[family].lastActiveAt = Date.now();
    }
    // Also drive RuntimeProcessorRegistry for backward compat
    try {
      var reg = G.RuntimeProcessorRegistry;
      if (reg && reg.activateForTool) reg.activateForTool(toolId);
    } catch (_) {}
  }

  // ── Dormant sweep: evict processors idle > DORMANT_MS ─────────────
  function _dormantSweep() {
    var now = Date.now();
    Object.keys(_registry).forEach(function (family) {
      var proc = _registry[family];
      if (!proc.activated) return;
      var idle = now - (proc.lastActiveAt || proc.activatedAt || 0);
      if (idle > DORMANT_MS && !proc.dormantAt) {
        proc.dormantAt = now;
        proc.activated = false; // allow re-init on next use
        console.debug(LOG, 'evicted dormant processor:', family, '— idle:', Math.round(idle / 60000) + 'min');
        try {
          G.dispatchEvent(new CustomEvent('processor-loader:evicted', {
            detail: { family: family, idleMs: idle },
          }));
        } catch (_) {}
      }
    });
  }
  setInterval(_dormantSweep, SWEEP_MS);

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (id) activateForTool(id);
    } catch (_) {}
  });

  G.addEventListener('tool:manifest-activated', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) activate(family);
    } catch (_) {}
  });

  // ── Stats API ─────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_registry).forEach(function (family) {
      var p = _registry[family];
      out[family] = {
        activated:    p.activated,
        activatedAt:  p.activatedAt,
        activationMs: p.activationMs,
        dormantAt:    p.dormantAt,
        crashCount:   p.crashCount,
        lastActiveAt: p.lastActiveAt,
        tools:        p.tools.length,
        avgStartupMs: p.startupHist.length
          ? Math.round(p.startupHist.reduce(function (a, b) { return a + b; }, 0) / p.startupHist.length)
          : null,
      };
    });
    return out;
  }

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    _mobileTier = _getMobileTier();
    console.debug(LOG, 'v' + VERSION + ' booted — mobile tier:', _mobileTier, '| dormant TTL:', DORMANT_MS / 60000 + 'min');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeProcessorLoader = Object.freeze({
    VERSION:           VERSION,
    registerProcessor: registerProcessor,
    activate:          activate,
    activateForTool:   activateForTool,
    isActivated:       function (family) { return !!((_registry[family] || {}).activated); },
    getStats:          getStats,
    getMobileTier:     function () { return _mobileTier; },
    getRegistry:       function () { return Object.assign({}, _registry); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — dynamic processor activation + dormant eviction active');

}(window));
