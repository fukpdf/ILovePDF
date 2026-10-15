// RuntimeToolCodeLoader v1.0 — Arc 5 / Phase B / Target 2
// =====================================================================
// Per-tool dependency graph + dynamic code loading.
//
// Arc 4 gap: RuntimeProcessorRegistry tracks which FAMILY has been
// activated but has no tool-level dependency graph and no actual
// dynamic loading mechanism. It relies on the processor init function
// being registered externally; no script injection happens.
//
// Solution:
//   1. Per-tool dependency graph: each toolId maps to a list of
//      script files it actually needs (worker + optional extras)
//   2. Dynamic script injection with deduplication: scripts already
//      in the DOM are detected and skipped
//   3. Family-level lazy activation: calling load(toolId) triggers
//      the corresponding RuntimeProcessorRegistry.activate(family)
//   4. Dormant family eviction: families idle > DORMANT_MS are
//      flagged and their activation state reset (so next use re-inits)
//   5. Dependency resolution is async and cached per toolId
//
// Does NOT modify AdvancedEngine or any existing runtime files.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolCodeLoader) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[ToolCodeLoader]';
  var VERSION    = '1.0';
  var DORMANT_MS = 15 * 60 * 1000; // 15 min idle → family marked dormant

  // ── Tool → required script files ─────────────────────────────────────────
  // Only files that are NOT already guaranteed by the base bundle chain.
  // These are tool-specific extras beyond the shared runtime.
  var TOOL_SCRIPTS = {
    'merge':           ['/workers/pdf-lib-worker.js'],
    'split':           ['/workers/pdf-lib-worker.js'],
    'rotate':          ['/workers/pdf-lib-worker.js'],
    'crop':            ['/workers/pdf-lib-worker.js'],
    'organize':        ['/workers/pdf-lib-worker.js'],
    'page-numbers':    ['/workers/pdf-lib-worker.js'],
    'redact':          ['/workers/pdf-lib-worker.js'],
    'compress':        ['/workers/compress-worker.js'],
    'pdf-to-word':     ['/workers/pdf-word-docx-worker.js'],
    'word-to-pdf':     ['/workers/pdf-word-docx-worker.js'],
    'pdf-to-excel':    ['/workers/pdf-excel-xlsx-worker.js'],
    'excel-to-pdf':    ['/workers/pdf-excel-xlsx-worker.js'],
    'pdf-to-powerpoint':['/workers/pdf-ppt-pptx-worker.js'],
    'powerpoint-to-pdf':['/workers/pdf-ppt-pptx-worker.js'],
    'pdf-to-jpg':      ['/workers/pdf-lib-worker.js'],
    'jpg-to-pdf':      ['/workers/pdf-lib-worker.js'],
    'html-to-pdf':     ['/workers/pdf-lib-worker.js'],
    'scan-to-pdf':     ['/workers/pdf-lib-worker.js'],
    'edit':            ['/workers/pdf-lib-worker.js'],
    'watermark':       ['/workers/pdf-lib-worker.js'],
    'sign':            ['/workers/pdf-lib-worker.js'],
    'protect':         ['/workers/pdf-lib-worker.js'],
    'unlock':          ['/workers/pdf-lib-worker.js'],
    'repair':          ['/workers/repair-worker.js'],
    'compare':         ['/workers/compare-worker.js'],
    'ocr':             ['/workers/advanced-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'ocr-pdf':         ['/workers/advanced-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'ai-summarize':    ['/workers/summary-worker.js'],
    'ai-summarizer':   ['/workers/summary-worker.js'],
    'translate':       ['/workers/translation-worker.js'],
    'translate-pdf':   ['/workers/translation-worker.js'],
    'background-remover':['/workers/remove-bg-worker.js'],
    'crop-image':      ['/workers/image-tools-worker.js'],
    'resize-image':    ['/workers/image-tools-worker.js'],
    'image-filters':   ['/workers/image-tools-worker.js'],
    'image-compressor':['/workers/image-tools-worker.js'],
    'image-converter': ['/workers/image-pipeline-worker.js'],
  };

  // Selected processor family is loaded only after the active tool is resolved.
  var TOOL_PROCESSOR_SCRIPTS = {
    'merge': ['/js/processors/merge-processor.js'],
    'split': ['/js/processors/split-processor.js'],
    'rotate': ['/js/processors/merge-processor.js'],
    'crop': ['/js/processors/merge-processor.js'],
    'organize': ['/js/processors/merge-processor.js'],
    'page-numbers': ['/js/processors/watermark-processor.js'],
    'redact': ['/js/processors/watermark-processor.js'],
    'compare': ['/js/processors/watermark-processor.js'],
    'compress': ['/js/processors/compress-processor.js'],
    'pdf-to-word': ['/js/processors/convert-processor.js'],
    'pdf-to-excel': ['/js/processors/convert-processor.js'],
    'pdf-to-powerpoint': ['/js/processors/convert-processor.js'],
    'pdf-to-jpg': ['/js/processors/convert-processor.js'],
    'word-to-pdf': ['/js/processors/convert-processor.js'],
    'excel-to-pdf': ['/js/processors/convert-processor.js'],
    'powerpoint-to-pdf': ['/js/processors/convert-processor.js'],
    'word-to-excel': ['/js/processors/convert-processor.js'],
    'jpg-to-pdf': ['/js/processors/convert-processor.js'],
    'html-to-pdf': ['/js/processors/convert-processor.js'],
    'scan-to-pdf': ['/js/processors/convert-processor.js'],
    'edit': ['/js/processors/watermark-processor.js'],
    'watermark': ['/js/processors/watermark-processor.js'],
    'sign': ['/js/processors/watermark-processor.js'],
    'protect': ['/js/processors/watermark-processor.js'],
    'unlock': ['/js/processors/watermark-processor.js'],
    'repair': ['/js/processors/repair-processor.js'],
    'repair-pdf': ['/js/processors/repair-processor.js'],
    'ocr': ['/js/processors/ocr-processor.js'],
    'ocr-pdf': ['/js/processors/ocr-processor.js'],
    'ai-summarize': ['/js/processors/ai-processor.js'],
    'ai-summarizer': ['/js/processors/ai-processor.js'],
    'translate': ['/js/processors/ai-processor.js'],
    'translate-pdf': ['/js/processors/ai-processor.js'],
    'workflow': ['/js/processors/ai-processor.js'],
    'background-remover': ['/js/processors/image-processor.js'],
    'remove-background': ['/js/processors/image-processor.js'],
    'crop-image': ['/js/processors/image-processor.js'],
    'resize-image': ['/js/processors/image-processor.js'],
    'image-filters': ['/js/processors/image-processor.js'],
    'image-compressor': ['/js/processors/image-processor.js'],
    'image-converter': ['/js/processors/image-processor.js'],
    'qr-code-generator': ['/js/processors/image-processor.js'],
    'barcode-generator': ['/js/processors/image-processor.js'],
    'zip-builder': ['/js/processors/image-processor.js'],
  };

  // Tool-specific worker adapters are also loaded only for the active tool.
  var TOOL_ADAPTER_SCRIPTS = {
    'merge': ['/js/merge-worker-adapter.js'],
    'split': ['/js/split-worker-adapter.js'],
    'rotate': ['/js/rotate-worker-adapter.js'],
    'crop': ['/js/organize-worker-adapter.js'],
    'organize': ['/js/organize-worker-adapter.js'],
    'page-numbers': ['/js/page-numbers-worker-adapter.js'],
    'redact': ['/js/redact-worker-adapter.js'],
    'compress': ['/js/compress-worker-adapter.js'],
    'pdf-to-word': [],
    'pdf-to-excel': [],
    'pdf-to-powerpoint': [],
    'pdf-to-jpg': [],
    'word-to-pdf': [],
    'excel-to-pdf': [],
    'powerpoint-to-pdf': [],
    'word-to-excel': [],
    'jpg-to-pdf': [],
    'html-to-pdf': [],
    'scan-to-pdf': [],
    'edit': ['/js/edit-worker-adapter.js'],
    'watermark': ['/js/watermark-worker-adapter.js'],
    'sign': ['/js/sign-worker-adapter.js'],
    'protect': ['/js/protect-worker-adapter.js'],
    'unlock': ['/js/unlock-worker-adapter.js'],
    'repair': ['/js/repair-worker-adapter.js'],
    'repair-pdf': ['/js/repair-worker-adapter.js'],
    'compare': ['/js/compare-worker-adapter.js'],
    'ocr': ['/js/ocr-worker-adapter.js'],
    'ocr-pdf': ['/js/ocr-worker-adapter.js'],
    'ai-summarize': [],
    'ai-summarizer': [],
    'translate': ['/js/translate-worker-adapter.js'],
    'translate-pdf': ['/js/translate-worker-adapter.js'],
    'workflow': ['/js/workflow-worker-adapter.js'],
    'background-remover': [],
    'remove-background': [],
    'crop-image': [],
    'resize-image': [],
    'image-filters': [],
    'image-compressor': [],
    'image-converter': [],
    'qr-code-generator': [],
    'barcode-generator': [],
    'zip-builder': [],
    // These utilities redirect to standalone pages and intentionally have no tool-page bundle.
    'numbers-to-words': [],
    'currency-converter': [],
  };

  // Tool-specific runtime/UI modules stay out of the shared upload shell.
  var TOOL_FEATURE_SCRIPTS = {
    'merge': ['/js/merge-runtime.js', '/js/merge-pdf-app.js'],
    'split': ['/js/split-runtime.js', '/js/split-pdf-app.js', '/js/page-organizer.js'],
    'rotate': ['/js/rotate-runtime.js', '/js/rotate-pdf-app.js', '/js/page-organizer.js'],
    'crop': ['/js/organize-runtime.js', '/js/crop-pdf-app.js', '/js/page-organizer.js'],
    'organize': ['/js/organize-runtime.js', '/js/organize-app.js', '/js/page-organizer.js'],
    'page-numbers': ['/js/page-numbers-runtime.js', '/js/page-numbers-app.js', '/js/page-organizer.js'],
    'redact': ['/js/redact-runtime.js', '/js/redact-pdf-app.js', '/js/page-organizer.js'],
    'compress': ['/js/compress-runtime.js', '/js/compress-pdf-app.js'],
    'pdf-to-word': ['/js/pdf-pipeline/font-mapper.js', '/js/pdf-pipeline/column-engine.js', '/js/pdf-pipeline/form-reconstruction.js', '/js/pdf-pipeline/fidelity-validator.js', '/js/pdf-pipeline/visual-reconstruction.js', '/js/pdf-pipeline/ocr-zoning.js', '/js/pdf-pipeline/image-anchor-engine.js', '/js/pdf-pipeline/layout-graph.js', '/js/pdf-pipeline/docx-coordinate-engine.js', '/js/pdf-pipeline/fidelity-debug.js', '/js/live-preview.js', '/js/pdf-word-app.js'],
    'pdf-to-excel': ['/js/live-preview.js', '/js/pdf-excel-app.js'],
    'pdf-to-powerpoint': ['/js/live-preview.js', '/js/pdf-ppt-app.js'],
    'word-to-pdf': ['/js/live-preview.js', '/js/pdf-word-app.js'],
    'excel-to-pdf': ['/js/live-preview.js', '/js/pdf-excel-app.js'],
    'powerpoint-to-pdf': ['/js/live-preview.js', '/js/pdf-ppt-app.js'],
    'word-to-excel': ['/js/live-preview.js', '/js/pdf-excel-app.js'],
    'pdf-to-jpg': ['/js/image-pdf-app.js'],
    'jpg-to-pdf': ['/js/image-pdf-app.js'],
    'html-to-pdf': ['/js/live-preview.js', '/js/html-pdf-app.js'],
    'scan-to-pdf': ['/js/live-preview.js', '/js/scan-pdf-app.js'],
    'edit': ['/js/live-preview.js', '/js/edit-runtime.js', '/js/edit-pdf-app.js', '/js/edit-pdf-pro.js', '/js/page-organizer.js'],
    'watermark': ['/js/watermark-runtime.js', '/js/watermark-pdf-app.js', '/js/page-organizer.js'],
    'sign': ['/js/sign-runtime.js', '/js/sign-app.js', '/js/page-organizer.js'],
    'protect': ['/js/protect-runtime.js', '/js/protect-pdf-app.js'],
    'unlock': ['/js/unlock-runtime.js', '/js/unlock-pdf-app.js'],
    'repair': ['/js/live-preview.js', '/js/repair-runtime.js', '/js/repair-pdf-app.js', '/js/page-organizer.js'],
    'repair-pdf': ['/js/live-preview.js', '/js/repair-runtime.js', '/js/repair-pdf-app.js', '/js/page-organizer.js'],
    'compare': ['/js/compare-runtime.js', '/js/compare-pdf-app.js'],
    'ocr': ['/js/live-preview.js', '/js/ocr-runtime.js', '/js/ocr-tool-app.js', '/js/page-organizer.js'],
    'ocr-pdf': ['/js/live-preview.js', '/js/ocr-runtime.js', '/js/ocr-tool-app.js', '/js/page-organizer.js'],
    'ai-summarize': ['/js/live-preview.js', '/js/advanced-engine.js', '/js/ai-summarizer-app.js', '/js/page-organizer.js'],
    'ai-summarizer': ['/js/live-preview.js', '/js/advanced-engine.js', '/js/ai-summarizer-app.js', '/js/page-organizer.js'],
    'translate': ['/js/live-preview.js', '/js/translate-runtime.js', '/js/translate-pdf-app.js', '/js/page-organizer.js'],
    'translate-pdf': ['/js/live-preview.js', '/js/translate-runtime.js', '/js/translate-pdf-app.js', '/js/page-organizer.js'],
    'workflow': ['/js/workflow-runtime.js'],
    'background-remover': ['/js/live-preview.js', '/js/remove-background-app.js', '/js/bg-remover-pro.js'],
    'remove-background': ['/js/live-preview.js', '/js/remove-background-app.js', '/js/bg-remover-pro.js'],
    'crop-image': ['/js/crop-image-app.js'],
    'resize-image': ['/js/resize-image-app.js'],
    'image-filters': ['/js/image-filters-app.js'],
    'image-compressor': ['/js/image-pdf-app.js'],
    'image-converter': ['/js/image-pdf-app.js'],
    'qr-code-generator': [],
    'barcode-generator': [],
    'zip-builder': [],
  };

  // Expensive AI/OCR/translation engines are opt-in by tool family.
  var TOOL_ENHANCEMENT_SCRIPTS = {
    'ai-summarize': ['/js/onnx-runtime-manager.js', '/js/webgpu-ai-pipelines.js', '/js/p2p-compute-mesh.js', '/js/runtime-ai-upgrade.js', '/js/runtime-gpu-engine.js', '/js/webgpu-phase23.js', '/js/runtime-local-ai.js', '/js/bg-ai-engine.js', '/core/ai-runtime.js', '/js/runtime-ai-scheduler.js', '/js/runtime-adaptive-ai.js'],
    'ai-summarizer': ['/js/onnx-runtime-manager.js', '/js/webgpu-ai-pipelines.js', '/js/p2p-compute-mesh.js', '/js/runtime-ai-upgrade.js', '/js/runtime-gpu-engine.js', '/js/webgpu-phase23.js', '/js/runtime-local-ai.js', '/js/bg-ai-engine.js', '/core/ai-runtime.js', '/js/runtime-ai-scheduler.js', '/js/runtime-adaptive-ai.js'],
    'ocr': ['/js/phase34-table-ocr.js', '/js/universal-ocr-cleanup.js', '/js/runtime-tesseract-cleaner.js', '/js/gpu-fallback-validator.js'],
    'ocr-pdf': ['/js/phase34-table-ocr.js', '/js/universal-ocr-cleanup.js', '/js/runtime-tesseract-cleaner.js', '/js/gpu-fallback-validator.js'],
    'pdf-to-word': ['/js/universal-encoding-repair.js', '/js/universal-ocr-cleanup.js', '/js/phase34-table-ocr.js'],
    'translate': ['/js/universal-translation-chunker.js', '/js/universal-translation-validator.js', '/js/universal-translation-pipeline.js'],
    'translate-pdf': ['/js/universal-translation-chunker.js', '/js/universal-translation-validator.js', '/js/universal-translation-pipeline.js'],
    'background-remover': ['/js/bg-ai-engine.js', '/js/gpu-fallback-validator.js'],
    'crop-image': ['/js/gpu-fallback-validator.js'],
    'resize-image': ['/js/gpu-fallback-validator.js'],
    'image-filters': ['/js/gpu-fallback-validator.js'],
  };

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
  };

  // ── Load state ────────────────────────────────────────────────────────────
  var _loaded   = {};   // scriptSrc → true (already in DOM)
  var _loading  = {};   // scriptSrc → Promise
  var _toolLoads = {};  // toolId → { ts, resolved }
  var _familyActivity = {}; // family → lastActiveAt

  // ── Detect already-loaded scripts ────────────────────────────────────────
  function _isLoaded(src) {
    if (_loaded[src]) return true;
    var scripts = document.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var normalized = s.src.replace(/^https?:\/\/[^/]+/, '');
      if (normalized === src) { _loaded[src] = true; return true; }
    }
    return false;
  }

  // ── Inject a script (idempotent) ──────────────────────────────────────────
  function _injectScript(src) {
    // An injected tag exists in the DOM before its load event; prefer the
    // in-flight promise so concurrent callers never mistake it for loaded.
    if (_loading[src]) return _loading[src];
    if (_isLoaded(src)) return Promise.resolve();

    _loading[src] = new Promise(function (resolve) {
      var el   = document.createElement('script');
      el.src   = src;
      el.defer = true;
      el.onload  = function () { _loaded[src] = true; delete _loading[src]; resolve(); };
      el.onerror = function () {
        delete _loading[src];
        // Remove failed tags so a later file/process interaction can retry;
        // otherwise _isLoaded() would mistake the failed tag for a loaded module.
        try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
        console.debug(LOG, 'inject failed (non-fatal):', src);
        resolve(); // non-fatal: worker may already be loaded inline
      };
      document.head.appendChild(el);
    });
    return _loading[src];
  }

  // ── Load all dependencies for a tool ─────────────────────────────────────
  function load(toolId) {
    var family  = TOOL_FAMILY[toolId] || 'organize';
    _familyActivity[family] = Date.now();

    // Activate processor family
    try {
      var pr = G.RuntimeProcessorRegistry;
      if (pr) pr.activateForTool(toolId);
    } catch (_) {}

    // Activate tool worker mesh node
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh) mesh.activate(toolId);
    } catch (_) {}

    // Load only the active tool's processor entry point, then its worker dependency.
    // Registration dependencies first, then adapter bridges, UI/runtime modules,
    // and finally the selected worker entry point.
    var scripts = (TOOL_PROCESSOR_SCRIPTS[toolId] || [])
      .concat(TOOL_ENHANCEMENT_SCRIPTS[toolId] || [])
      .concat(TOOL_ADAPTER_SCRIPTS[toolId] || [])
      .concat(TOOL_FEATURE_SCRIPTS[toolId] || [])
      .concat(TOOL_SCRIPTS[toolId] || []);
    var orderedUniqueScripts = [];
    scripts.forEach(function (src) { if (orderedUniqueScripts.indexOf(src) === -1) orderedUniqueScripts.push(src); });
    // Crucially: tools in one family NEVER load scripts for another family.
    var chain = Promise.resolve();
    orderedUniqueScripts.forEach(function (src) {
      chain = chain.then(function () { return _injectScript(src); });
    });

    _toolLoads[toolId] = { ts: Date.now(), resolved: false };
    return chain.then(function () {
      // This processor script can arrive after tool:runtime-ready has fired.
      // Activate its family now so lazy registration is not left dormant.
      try {
        var pl = G.RuntimeProcessorLoader;
        if (pl && typeof pl.activateForTool === 'function') pl.activateForTool(toolId);
      } catch (_) {}
      try {
        var pr = G.RuntimeProcessorRegistry;
        if (pr && typeof pr.activateForTool === 'function') pr.activateForTool(toolId);
      } catch (_) {}
      // Prewarm only the worker for this selected tool; never fan out to all workers.
      try {
        var wp = G.RuntimeWorkerPrewarm;
        if (wp && typeof wp.prewarmForTool === 'function') wp.prewarmForTool(toolId);
      } catch (_) {}
      _toolLoads[toolId].resolved = true;
      console.debug(LOG, 'loaded deps for:', toolId, '— family:', family, '— scripts:', scripts.length);
      try {
        G.dispatchEvent(new CustomEvent('code-loader:loaded', {
          detail: { toolId: toolId, family: family, scripts: scripts.length },
        }));
      } catch (_) {}
    });
  }

  // Load only the small shared selected-file renderer after a user has
  // selected a file. This is intentionally separate from processor bundles so
  // the preview can appear without waiting for heavy tool-specific scripts.
  function loadPreview() {
    return _injectScript('/js/live-preview.js').then(function () {
      return !!G.LivePreview;
    });
  }

  // ── Dormant family detection ──────────────────────────────────────────────
  function getDormantFamilies() {
    var now = Date.now();
    var out = [];
    Object.keys(_familyActivity).forEach(function (f) {
      var idleMs = now - _familyActivity[f];
      if (idleMs > DORMANT_MS) out.push({ family: f, idleMs: idleMs });
    });
    return out;
  }

  // Tool bundles are requested by file selection and guarded processing,
  // not by the shared runtime-ready event; this keeps untouched tools unloaded.

  G.RuntimeToolCodeLoader = Object.freeze({
    VERSION:          VERSION,
    load:             load,
    loadPreview:      loadPreview,
    getDormantFamilies: getDormantFamilies,
    getLoadStats:     function () {
      return {
        loaded:    Object.keys(_loaded).length,
        toolLoads: Object.assign({}, _toolLoads),
        dormant:   getDormantFamilies(),
      };
    },
    isLoaded:         function (toolId) { return !!(_toolLoads[toolId] && _toolLoads[toolId].resolved); },
    getDependencyGraph: function () { return Object.assign({}, TOOL_SCRIPTS); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool dependency graph active');

}(window));
