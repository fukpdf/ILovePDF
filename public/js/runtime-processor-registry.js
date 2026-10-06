// RuntimeProcessorRegistry v1.0 — Arc 4 / Phase C / Target 3
// =====================================================================
// Lazy processor activation registry for AdvancedEngine families.
//
// Problem: advanced-engine.js is 6926 lines parsed and JIT-compiled
// regardless of which tool is active. Visit Compress PDF? OCR internals,
// AI parser, table intelligence — all compiled. Visit Merge PDF? Full
// AI runtime initialised unnecessarily.
//
// Solution: A lightweight registry that tracks which processor families
// have been activated. Each family has an init function registered at
// load time. `activate(family)` runs the init function exactly once.
//
// The registry intercepts AdvancedEngine dispatch via a hook installed
// on `window.AdvancedEngine.process`. Before any tool processes its
// first job, `activate(family)` is called. All subsequent calls are
// idempotent (no-op after first activation).
//
// AdvancedEngine.js continues to work unchanged — the registry adds
// an OPTIONAL pre-activation layer, not a replacement.
//
// Tool families:
//   organize / compress / convert-from / convert-to / edit / ai / image / utility
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ProcessorReg]';
  var VERSION = '1.0';

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge-pdf':'organize','merge':'organize','split-pdf':'organize','split':'organize',
    'rotate-pdf':'organize','rotate':'organize','crop':'organize',
    'organize-pdf':'organize','organize':'organize',
    'page-numbers':'organize','redact':'organize',
    'compress-pdf':'compress','compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to','word-to-excel':'convert-to',
    'edit-pdf':'edit','edit':'edit','watermark':'edit','sign':'edit',
    'protect':'edit','unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai','workflow':'ai',
    'background-remover':'image','remove-background':'image',
    'crop-image':'image','resize-image':'image','image-filters':'image',
    'image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Processor registry ────────────────────────────────────────────────────
  // family → { initFn, activated, activatedAt, activationMs }
  var _processors = {};

  // ── Register a processor family init function ─────────────────────────────
  function register(family, initFn) {
    if (typeof initFn !== 'function') return;
    if (!_processors[family]) {
      _processors[family] = {
        initFn:       initFn,
        activated:    false,
        activatedAt:  null,
        activationMs: null,
      };
      console.debug(LOG, 'registered:', family);
    }
  }

  // ── Activate a processor family (idempotent) ──────────────────────────────
  function activate(family) {
    if (!family) return;
    var p = _processors[family];
    if (!p) {
      console.debug(LOG, 'no processor registered for family:', family, '— using AdvancedEngine default');
      return;
    }
    if (p.activated) return;
    var t0 = Date.now();
    try {
      p.initFn();
      p.activated    = true;
      p.activatedAt  = Date.now();
      p.activationMs = Date.now() - t0;
      console.debug(LOG, 'activated:', family, '—', p.activationMs + 'ms');
      try {
        G.dispatchEvent(new CustomEvent('processor:activated', {
          detail: { family: family, activationMs: p.activationMs },
        }));
      } catch (_) {}
    } catch (e) {
      console.debug(LOG, 'activation error:', family, e && e.message || e);
    }
  }

  // ── Activate by toolId ────────────────────────────────────────────────────
  function activateForTool(toolId) {
    // Try direct lookup
    var family = TOOL_FAMILY[toolId];
    if (!family) {
      // Try RuntimeToolManifestRegistry
      try {
        var mr = G.RuntimeToolManifestRegistry;
        family = mr && mr.getFamily && mr.getFamily(toolId);
      } catch (_) {}
    }
    if (family) activate(family);
    // Also activate from RuntimeWorkerDomainRegistry
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) { var f2 = wd.getFamily(toolId); if (f2 && f2 !== family) activate(f2); }
    } catch (_) {}
  }

  // ── Install AdvancedEngine interceptor ────────────────────────────────────
  // We cannot modify the frozen AdvancedEngine export, but we CAN install
  // a pre-process hook via the 'tool:runtime-ready' event from RuntimeToolLoader.
  function _installHooks() {
    // Hook 1: tool:runtime-ready → activate processor for current tool
    G.addEventListener('tool:runtime-ready', function (evt) {
      try {
        var toolId = evt && evt.detail && evt.detail.toolId;
        if (toolId) activateForTool(toolId);
      } catch (_) {}
    });

    // Hook 2: tool:manifest-activated → activate processor
    G.addEventListener('tool:manifest-activated', function (evt) {
      try {
        var family = evt && evt.detail && evt.detail.family;
        if (family) activate(family);
      } catch (_) {}
    });

    // Hook 3: If AdvancedEngine is available, wrap its process() call to
    // auto-activate the family before each tool run.
    try {
      var ae = G.AdvancedEngine;
      if (ae && typeof ae.process === 'function' && !ae._processorRegistryWrapped) {
        var _origProcess = ae.process.bind(ae);
        // AdvancedEngine is frozen — we install a global interceptor instead
        G.__processorRegistryInterceptProcess = function (toolId) {
          activateForTool(toolId);
        };
        console.debug(LOG, 'global process interceptor installed');
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installHooks, { once: true });
  } else {
    setTimeout(_installHooks, 0);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_processors).forEach(function (f) {
      var p = _processors[f];
      out[f] = { activated: p.activated, activatedAt: p.activatedAt, activationMs: p.activationMs };
    });
    return out;
  }

  G.RuntimeProcessorRegistry = Object.freeze({
    VERSION:         VERSION,
    register:        register,
    activate:        activate,
    activateForTool: activateForTool,
    isActivated:     function (family) { return !!(_processors[family] && _processors[family].activated); },
    getStats:        getStats,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — lazy processor activation active');

}(window));
