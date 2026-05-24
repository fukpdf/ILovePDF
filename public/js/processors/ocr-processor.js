// OcrProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// OCR processor: ocr, ocr-pdf. Independently loadable / unloadable.
// No cross-family imports.
//
// OCR has the highest memory requirements of any processor: Tesseract
// WASM model (~40 MB), per-page canvas buffers, and optional
// ocr-preprocessor-worker for high-accuracy multi-pass mode.
// Budget is set at 512 MB — same as the full AI family budget.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeOcrProcessor) return;

  var LOG     = '[OcrProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'ocr';
  var TOOLS   = ['ocr', 'ocr-pdf'];
  var WORKER_URL     = '/workers/advanced-worker.js';
  var PREP_WORKER    = '/workers/ocr-preprocessor-worker.js';
  var MEMORY_MB      = 512;

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _pagesProcessed = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 150) _telemetry.shift();
  }

  function _init() {
    if (_initialized) return;
    var t0 = Date.now();

    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf && mf.register) {
        TOOLS.forEach(function (id) { mf.register(id, MEMORY_MB); });
      }
    } catch (_) {}

    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh && mesh.register) {
        TOOLS.forEach(function (id) { mesh.register(id, WORKER_URL); });
      }
    } catch (_) {}

    try {
      var hd = G.RuntimeHydrationDomains;
      if (hd && hd.createDomain) {
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P0'); }); // P0: OCR must be ready immediately
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, {
          budgetMb: MEMORY_MB,
          tools: TOOLS,
          reclaimOnIdle: true,
          idleTrimMs: 2 * 60 * 1000, // trim after 2 min idle (Tesseract model is large)
        });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        // OCR needs two pools: main + preprocessor
        pw.registerPool(FAMILY, {
          workerUrl: WORKER_URL,
          maxWorkers: 1, // OCR is CPU-intensive — one at a time
          auxWorkerUrls: [PREP_WORKER],
        });
      }
    } catch (_) {}

    // Predictive prewarm of preprocessor worker on low-end devices
    try {
      var ais = G.RuntimeAIScheduler;
      if (ais) {
        var profile = ais.getProfile && ais.getProfile();
        if (profile && profile.gpuTier !== 'none') {
          // Prewarm preprocessor only on capable devices
          try {
            G.WorkerPool && G.WorkerPool.prewarm && G.WorkerPool.prewarm(PREP_WORKER);
          } catch (_) {}
        }
      }
    } catch (_) {}

    _initialized = true;
    _startupMs   = Date.now() - t0;
    _tel('init', { startupMs: _startupMs });
    console.debug(LOG, 'v' + VERSION + ' init —', _startupMs + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('processor:init', {
        detail: { processor: FAMILY, version: VERSION, startupMs: _startupMs },
      }));
    } catch (_) {}
  }

  function _register() {
    try {
      var reg = G.RuntimeProcessorRegistry;
      if (reg && reg.register) reg.register(FAMILY, _init);
      // Also register under 'ai' family alias used by RuntimeProcessorRegistry TOOL_FAMILY
      if (reg && reg.register) reg.register('ai', _init);
    } catch (_) {}
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr && ldr.registerProcessor) {
        ldr.registerProcessor(FAMILY, { initFn: _init, tools: TOOLS, workerUrl: WORKER_URL, memoryMb: MEMORY_MB });
      }
    } catch (_) {}
  }

  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (TOOLS.indexOf(id) !== -1) { _lastActiveAt = Date.now(); _tel('tool-active', { toolId: id }); }
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (TOOLS.indexOf(id) !== -1) { _crashCount++; _tel('crash', { toolId: id, total: _crashCount }); }
    } catch (_) {}
  });

  // Track OCR page telemetry
  G.addEventListener('ocr:page-complete', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d) {
        _pagesProcessed++;
        _tel('page-complete', { page: d.page, method: d.method, conf: d.confidence });
      }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeOcrProcessor = Object.freeze({
    VERSION:          VERSION,
    FAMILY:           FAMILY,
    TOOLS:            Object.freeze(TOOLS.slice()),
    isInitialized:    function () { return _initialized; },
    getStartupMs:     function () { return _startupMs; },
    getCrashCount:    function () { return _crashCount; },
    getPagesProcessed: function () { return _pagesProcessed; },
    getLastActive:    function () { return _lastActiveAt; },
    getTelemetry:     function () { return _telemetry.slice(); },
    init:             _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));
