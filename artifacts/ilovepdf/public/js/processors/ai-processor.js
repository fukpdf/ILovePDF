// AiProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// AI family processor: ai-summarize, ai-summarizer, translate,
// translate-pdf, workflow. Independently loadable / unloadable.
// No cross-family imports.
//
// The AI processor is deliberately separated from OCR because:
// 1. AI summarize + translate have no WASM requirements (network API)
// 2. They should not force-load the 40 MB Tesseract model
// 3. Their idle eviction window is different (faster — text, not WASM)
// Budget: 256 MB for text buffers + MyMemory API response caching.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAiProcessor) return;

  var LOG     = '[AiProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'ai-nlp'; // distinct from 'ocr' family
  var TOOLS   = [
    'ai-summarize', 'ai-summarizer',
    'translate', 'translate-pdf',
    'workflow',
  ];
  var WORKER_URL = '/workers/summary-worker.js';
  var TRANS_WORKER = '/workers/translation-worker.js';
  var MEMORY_MB  = 256;

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _docsProcessed = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  var TOOL_WORKER = {
    'translate':     TRANS_WORKER,
    'translate-pdf': TRANS_WORKER,
  };

  function _workerFor(id) {
    return TOOL_WORKER[id] || WORKER_URL;
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
        TOOLS.forEach(function (id) { mesh.register(id, _workerFor(id)); });
      }
    } catch (_) {}

    try {
      var hd = G.RuntimeHydrationDomains;
      if (hd && hd.createDomain) {
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P2'); }); // deferred — network API, not instant
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, {
          budgetMb: MEMORY_MB,
          tools: TOOLS,
          reclaimOnIdle: true,
          idleTrimMs: 5 * 60 * 1000, // 5 min idle trim
        });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, {
          workerUrl: WORKER_URL,
          maxWorkers: 1,
          auxWorkerUrls: [TRANS_WORKER],
        });
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

  G.addEventListener('ai:doc-complete', function (evt) {
    try {
      if (evt) { _docsProcessed++; _tel('doc-done', { total: _docsProcessed }); }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeAiProcessor = Object.freeze({
    VERSION:          VERSION,
    FAMILY:           FAMILY,
    TOOLS:            Object.freeze(TOOLS.slice()),
    isInitialized:    function () { return _initialized; },
    getStartupMs:     function () { return _startupMs; },
    getCrashCount:    function () { return _crashCount; },
    getDocsProcessed: function () { return _docsProcessed; },
    getLastActive:    function () { return _lastActiveAt; },
    getTelemetry:     function () { return _telemetry.slice(); },
    workerFor:        _workerFor,
    init:             _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));
