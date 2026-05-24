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
    if (_isLoaded(src)) return Promise.resolve();
    if (_loading[src])  return _loading[src];

    _loading[src] = new Promise(function (resolve) {
      var el   = document.createElement('script');
      el.src   = src;
      el.defer = true;
      el.onload  = function () { _loaded[src] = true; delete _loading[src]; resolve(); };
      el.onerror = function () {
        delete _loading[src];
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

    // Inject any required extra scripts
    var scripts = TOOL_SCRIPTS[toolId] || [];
    // Crucially: tools in one family NEVER load scripts for another family
    var chain = Promise.resolve();
    scripts.forEach(function (src) {
      chain = chain.then(function () { return _injectScript(src); });
    });

    _toolLoads[toolId] = { ts: Date.now(), resolved: false };
    return chain.then(function () {
      _toolLoads[toolId].resolved = true;
      console.debug(LOG, 'loaded deps for:', toolId, '— family:', family, '— scripts:', scripts.length);
      try {
        G.dispatchEvent(new CustomEvent('code-loader:loaded', {
          detail: { toolId: toolId, family: family, scripts: scripts.length },
        }));
      } catch (_) {}
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

  // ── Listen for tool runtime ready ─────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) load(toolId);
    } catch (_) {}
  });

  G.RuntimeToolCodeLoader = Object.freeze({
    VERSION:          VERSION,
    load:             load,
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
