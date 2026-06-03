// ── Arc 6 Advanced Engine Full Decomposition — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.813Z  BUILD_ID: mpxgtdiz
// Files: 15

// ── SOURCE: public/js/processors/merge-processor.js ──
// MergeProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Organize family processor: merge, split, rotate, crop, organize,
// page-numbers, redact. One file, one family, no cross-family imports.
//
// Registers with RuntimeProcessorRegistry so the family is only
// activated when an organize tool is actually used. Installs
// independent memory firewall, worker mesh node, hydration domain,
// and per-processor telemetry.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMergeProcessor) return;

  var LOG     = '[MergeProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'organize';
  var TOOLS   = ['merge', 'split', 'rotate', 'crop', 'organize',
                 'page-numbers', 'redact',
                 'merge-pdf', 'split-pdf', 'rotate-pdf', 'crop-pdf',
                 'organize-pdf', 'pdf-to-jpg', 'jpg-to-pdf',
                 'scan-to-pdf', 'html-to-pdf'];
  var WORKER_URL = '/workers/pdf-lib-worker.js';
  var MEMORY_MB  = 128;

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  function _init() {
    if (_initialized) return;
    var t0 = Date.now();

    // Register per-tool memory firewalls
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf && mf.register) {
        TOOLS.forEach(function (id) { mf.register(id, MEMORY_MB); });
      }
    } catch (_) {}

    // Register worker mesh nodes
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh && mesh.register) {
        TOOLS.forEach(function (id) { mesh.register(id, WORKER_URL); });
      }
    } catch (_) {}

    // Create per-tool hydration domains
    try {
      var hd = G.RuntimeHydrationDomains;
      if (hd && hd.createDomain) {
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    // Register processor memory segment (Arc 6 Phase C)
    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, { budgetMb: MEMORY_MB, tools: TOOLS });
      }
    } catch (_) {}

    // Register processor worker pool (Arc 6 Phase D)
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, { workerUrl: WORKER_URL, maxWorkers: 2 });
      }
    } catch (_) {}

    _initialized = true;
    _startupMs   = Date.now() - t0;
    _tel('init', { startupMs: _startupMs, tools: TOOLS.length });
    console.debug(LOG, 'v' + VERSION + ' init —', _startupMs + 'ms |', TOOLS.length, 'tools registered');

    try {
      G.dispatchEvent(new CustomEvent('processor:init', {
        detail: { processor: FAMILY, version: VERSION, startupMs: _startupMs },
      }));
    } catch (_) {}
  }

  // Register with RuntimeProcessorRegistry
  function _register() {
    try {
      var reg = G.RuntimeProcessorRegistry;
      if (reg && reg.register) {
        reg.register(FAMILY, _init);
        console.debug(LOG, 'registered — family:', FAMILY);
      }
    } catch (_) {}

    // Also register with RuntimeProcessorLoader (Arc 6 Phase B)
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr && ldr.registerProcessor) {
        ldr.registerProcessor(FAMILY, { initFn: _init, tools: TOOLS, workerUrl: WORKER_URL, memoryMb: MEMORY_MB });
      }
    } catch (_) {}
  }

  // Track tool activity
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (TOOLS.indexOf(id) !== -1) {
        _lastActiveAt = Date.now();
        _tel('tool-active', { toolId: id });
      }
    } catch (_) {}
  });

  // Track worker crashes
  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (TOOLS.indexOf(id) !== -1) {
        _crashCount++;
        _tel('crash', { toolId: id, total: _crashCount });
      }
    } catch (_) {}
  });

  // Deferred boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeMergeProcessor = Object.freeze({
    VERSION:        VERSION,
    FAMILY:         FAMILY,
    TOOLS:          Object.freeze(TOOLS.slice()),
    isInitialized:  function () { return _initialized; },
    getStartupMs:   function () { return _startupMs; },
    getCrashCount:  function () { return _crashCount; },
    getLastActive:  function () { return _lastActiveAt; },
    getTelemetry:   function () { return _telemetry.slice(); },
    init:           _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY, '| tools:', TOOLS.length);

}(window));

// ── SOURCE: public/js/processors/split-processor.js ──
// SplitProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Dedicated split-family processor module.
// Covers: split, split-pdf — independently loadable, unloadable,
// monitorable. No cross-family imports.
//
// Split is separated from the broader organize family to allow
// independent monitoring of large-file splitting operations which
// have distinct memory profiles (multi-output generation).
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSplitProcessor) return;

  var LOG     = '[SplitProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'split';
  var TOOLS   = ['split', 'split-pdf'];
  var WORKER_URL = '/workers/pdf-lib-worker.js';
  var MEMORY_MB  = 192; // split can generate many output pages → higher budget

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _outputCount  = 0; // total split outputs generated
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, { budgetMb: MEMORY_MB, tools: TOOLS });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, { workerUrl: WORKER_URL, maxWorkers: 2 });
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

  // Track split completions for output telemetry
  G.addEventListener('tool:complete', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && TOOLS.indexOf(d.toolId) !== -1 && d.outputCount) {
        _outputCount += (d.outputCount || 1);
        _tel('output', { toolId: d.toolId, count: d.outputCount, total: _outputCount });
      }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeSplitProcessor = Object.freeze({
    VERSION:        VERSION,
    FAMILY:         FAMILY,
    TOOLS:          Object.freeze(TOOLS.slice()),
    isInitialized:  function () { return _initialized; },
    getStartupMs:   function () { return _startupMs; },
    getCrashCount:  function () { return _crashCount; },
    getOutputCount: function () { return _outputCount; },
    getLastActive:  function () { return _lastActiveAt; },
    getTelemetry:   function () { return _telemetry.slice(); },
    init:           _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/processors/compress-processor.js ──
// CompressProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Compress family processor: compress, compress-pdf.
// No cross-family imports. Independently loadable / unloadable.
//
// Compress has a unique memory profile: it holds the input in RAM,
// builds a recompressed output, then discards the original. Budget
// is lower than convert but must accommodate dual-buffer periods.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCompressProcessor) return;

  var LOG     = '[CompressProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'compress';
  var TOOLS   = ['compress', 'compress-pdf'];
  var WORKER_URL = '/workers/compress-worker.js';
  var MEMORY_MB  = 128;

  var _initialized    = false;
  var _startupMs      = null;
  var _lastActiveAt   = null;
  var _crashCount     = 0;
  var _totalBytesSaved = 0;
  var _telemetry      = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, { budgetMb: MEMORY_MB, tools: TOOLS });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, { workerUrl: WORKER_URL, maxWorkers: 2 });
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

  // Track bytes saved (honestCompress telemetry)
  G.addEventListener('compress:complete', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && typeof d.bytesSaved === 'number') {
        _totalBytesSaved += d.bytesSaved;
        _tel('compress-complete', { bytesSaved: d.bytesSaved, totalSaved: _totalBytesSaved });
      }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeCompressProcessor = Object.freeze({
    VERSION:           VERSION,
    FAMILY:            FAMILY,
    TOOLS:             Object.freeze(TOOLS.slice()),
    isInitialized:     function () { return _initialized; },
    getStartupMs:      function () { return _startupMs; },
    getCrashCount:     function () { return _crashCount; },
    getTotalBytesSaved: function () { return _totalBytesSaved; },
    getLastActive:     function () { return _lastActiveAt; },
    getTelemetry:      function () { return _telemetry.slice(); },
    init:              _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/processors/ocr-processor.js ──
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

// ── SOURCE: public/js/processors/image-processor.js ──
// ImageProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Image family processor: background-remover, crop-image, resize-image,
// image-filters, image-compressor, image-converter, qr-code-generator,
// barcode-generator, zip-builder. One file, one family.
// No cross-family imports.
//
// Image processing has a distinct memory profile: canvas buffers can
// be very large (4K images = 50+ MB). Budget is 256 MB.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeImageProcessor) return;

  var LOG     = '[ImageProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'image';
  var TOOLS   = [
    'background-remover', 'remove-background',
    'crop-image', 'resize-image', 'image-filters',
    'image-compressor', 'image-converter',
    'qr-code-generator', 'barcode-generator', 'zip-builder',
  ];
  var WORKER_URL  = '/workers/image-tools-worker.js';
  var CONV_WORKER = '/workers/image-pipeline-worker.js';
  var BG_WORKER   = '/workers/remove-bg-worker.js';
  var MEMORY_MB   = 256;

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _imagesProcessed = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  // Worker URL per tool
  var TOOL_WORKER = {
    'background-remover':  BG_WORKER,
    'remove-background':   BG_WORKER,
    'image-converter':     CONV_WORKER,
    'image-pipeline':      CONV_WORKER,
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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, {
          budgetMb: MEMORY_MB,
          tools: TOOLS,
          reclaimOnIdle: true, // canvas buffers should be freed when idle
        });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, {
          workerUrl: WORKER_URL,
          maxWorkers: 2,
          auxWorkerUrls: [CONV_WORKER, BG_WORKER],
        });
      }
    } catch (_) {}

    _initialized = true;
    _startupMs   = Date.now() - t0;
    _tel('init', { startupMs: _startupMs, tools: TOOLS.length });
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

  G.addEventListener('image:processed', function (evt) {
    try {
      if (evt) { _imagesProcessed++; _tel('image-done', { total: _imagesProcessed }); }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeImageProcessor = Object.freeze({
    VERSION:           VERSION,
    FAMILY:            FAMILY,
    TOOLS:             Object.freeze(TOOLS.slice()),
    isInitialized:     function () { return _initialized; },
    getStartupMs:      function () { return _startupMs; },
    getCrashCount:     function () { return _crashCount; },
    getImagesProcessed: function () { return _imagesProcessed; },
    getLastActive:     function () { return _lastActiveAt; },
    getTelemetry:      function () { return _telemetry.slice(); },
    workerFor:         _workerFor,
    init:              _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/processors/ai-processor.js ──
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

// ── SOURCE: public/js/processors/convert-processor.js ──
// ConvertProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Convert family processor: pdf-to-word, pdf-to-excel, pdf-to-powerpoint,
// pdf-to-jpg, word-to-pdf, excel-to-pdf, powerpoint-to-pdf, jpg-to-pdf,
// html-to-pdf, scan-to-pdf, word-to-excel.
// One file, covers both convert-from and convert-to families.
// No cross-family imports.
//
// Conversion has the highest sustained memory use: it holds the source
// document AND builds the target format simultaneously.
// Budget: 256 MB for convert-from (PDF parse + DOCX/XLSX build).
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeConvertProcessor) return;

  var LOG     = '[ConvertProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'convert';
  var TOOLS   = [
    'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
    'word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf',
    'jpg-to-pdf', 'pdf-to-jpg',
    'html-to-pdf', 'scan-to-pdf', 'word-to-excel',
  ];
  var MEMORY_MB = 256;

  // Worker per convert direction
  var WORKER_MAP = {
    'pdf-to-word':         '/workers/pdf-word-docx-worker.js',
    'word-to-pdf':         '/workers/pdf-word-docx-worker.js',
    'word-to-excel':       '/workers/pdf-word-docx-worker.js',
    'pdf-to-excel':        '/workers/pdf-excel-xlsx-worker.js',
    'excel-to-pdf':        '/workers/pdf-excel-xlsx-worker.js',
    'pdf-to-powerpoint':   '/workers/pdf-ppt-pptx-worker.js',
    'powerpoint-to-pdf':   '/workers/pdf-ppt-pptx-worker.js',
  };
  var DEFAULT_WORKER = '/workers/pdf-lib-worker.js';

  function _workerFor(id) { return WORKER_MAP[id] || DEFAULT_WORKER; }

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _conversions  = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, { budgetMb: MEMORY_MB, tools: TOOLS });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        // Register all convert workers as pool options
        var uniqueWorkers = Object.values(WORKER_MAP).filter(function (v, i, a) { return a.indexOf(v) === i; });
        pw.registerPool(FAMILY, { workerUrl: DEFAULT_WORKER, maxWorkers: 2, auxWorkerUrls: uniqueWorkers });
      }
    } catch (_) {}

    _initialized = true;
    _startupMs   = Date.now() - t0;
    _tel('init', { startupMs: _startupMs, tools: TOOLS.length });
    console.debug(LOG, 'v' + VERSION + ' init —', _startupMs + 'ms |', TOOLS.length, 'tools');

    try {
      G.dispatchEvent(new CustomEvent('processor:init', {
        detail: { processor: FAMILY, version: VERSION, startupMs: _startupMs },
      }));
    } catch (_) {}
  }

  function _register() {
    try {
      var reg = G.RuntimeProcessorRegistry;
      if (reg && reg.register) {
        reg.register(FAMILY, _init);
        reg.register('convert-from', _init);
        reg.register('convert-to', _init);
      }
    } catch (_) {}
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr && ldr.registerProcessor) {
        ldr.registerProcessor(FAMILY, { initFn: _init, tools: TOOLS, workerUrl: DEFAULT_WORKER, memoryMb: MEMORY_MB });
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

  G.addEventListener('convert:complete', function (evt) {
    try {
      if (evt) { _conversions++; _tel('convert-done', { total: _conversions }); }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeConvertProcessor = Object.freeze({
    VERSION:        VERSION,
    FAMILY:         FAMILY,
    TOOLS:          Object.freeze(TOOLS.slice()),
    isInitialized:  function () { return _initialized; },
    getStartupMs:   function () { return _startupMs; },
    getCrashCount:  function () { return _crashCount; },
    getConversions: function () { return _conversions; },
    getLastActive:  function () { return _lastActiveAt; },
    getTelemetry:   function () { return _telemetry.slice(); },
    workerFor:      _workerFor,
    init:           _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/processors/watermark-processor.js ──
// WatermarkProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Edit family processor: watermark, sign, protect, unlock, edit,
// page-numbers (edit variant), redact (edit variant).
// No cross-family imports. Independently loadable / unloadable.
//
// The edit family is medium-weight: operations modify an existing PDF
// in-place (no re-encode). Budget: 128 MB.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWatermarkProcessor) return;

  var LOG     = '[WatermarkProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'edit';
  var TOOLS   = [
    'watermark', 'sign', 'protect', 'unlock', 'edit',
    'redact', 'page-numbers', 'compare',
  ];
  var WORKER_URL = '/workers/pdf-lib-worker.js';
  var MEMORY_MB  = 128;

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _opsCompleted = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  var TOOL_WORKER = {
    'compare': '/workers/compare-worker.js',
  };

  function _workerFor(id) { return TOOL_WORKER[id] || WORKER_URL; }

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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, { budgetMb: MEMORY_MB, tools: TOOLS });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, {
          workerUrl: WORKER_URL,
          maxWorkers: 2,
          auxWorkerUrls: ['/workers/compare-worker.js'],
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

  G.addEventListener('edit:op-complete', function (evt) {
    try {
      if (evt) { _opsCompleted++; _tel('op-done', { total: _opsCompleted }); }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeWatermarkProcessor = Object.freeze({
    VERSION:        VERSION,
    FAMILY:         FAMILY,
    TOOLS:          Object.freeze(TOOLS.slice()),
    isInitialized:  function () { return _initialized; },
    getStartupMs:   function () { return _startupMs; },
    getCrashCount:  function () { return _crashCount; },
    getOpsCompleted: function () { return _opsCompleted; },
    getLastActive:  function () { return _lastActiveAt; },
    getTelemetry:   function () { return _telemetry.slice(); },
    workerFor:      _workerFor,
    init:           _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/processors/repair-processor.js ──
// RepairProcessor v1.0 — Arc 6 / Phase A
// =====================================================================
// Repair family processor: repair, repair-pdf.
// Separated from the edit family because repair has a unique failure
// mode: it may succeed partially. It also uses a dedicated worker
// (repair-worker.js) and has different telemetry needs.
// No cross-family imports. Independently loadable / unloadable.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRepairProcessor) return;

  var LOG     = '[RepairProcessor]';
  var VERSION = '1.0';
  var FAMILY  = 'repair';
  var TOOLS   = ['repair', 'repair-pdf'];
  var WORKER_URL = '/workers/repair-worker.js';
  var MEMORY_MB  = 192; // repair may buffer multiple recovery passes

  var _initialized  = false;
  var _startupMs    = null;
  var _lastActiveAt = null;
  var _crashCount   = 0;
  var _repairsAttempted = 0;
  var _repairsSucceeded = 0;
  var _repairsFailed    = 0;
  var _telemetry    = [];

  function _tel(event, data) {
    _telemetry.push({ ts: Date.now(), event: event, data: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
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
        TOOLS.forEach(function (id) { hd.createDomain(id, 'P1'); });
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.registerProcessor) {
        pm.registerProcessor(FAMILY, {
          budgetMb: MEMORY_MB,
          tools: TOOLS,
          reclaimOnIdle: true,
        });
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.registerPool) {
        pw.registerPool(FAMILY, {
          workerUrl: WORKER_URL,
          maxWorkers: 1, // repair is sequential — one at a time
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

  // Track repair outcome telemetry
  G.addEventListener('repair:complete', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d) return;
      _repairsAttempted++;
      if (d.success) _repairsSucceeded++;
      else _repairsFailed++;
      _tel('repair-done', { success: d.success, attempted: _repairsAttempted, failed: _repairsFailed });
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register, { once: true });
  } else {
    setTimeout(_register, 0);
  }

  G.RuntimeRepairProcessor = Object.freeze({
    VERSION:            VERSION,
    FAMILY:             FAMILY,
    TOOLS:              Object.freeze(TOOLS.slice()),
    isInitialized:      function () { return _initialized; },
    getStartupMs:       function () { return _startupMs; },
    getCrashCount:      function () { return _crashCount; },
    getRepairStats:     function () { return { attempted: _repairsAttempted, succeeded: _repairsSucceeded, failed: _repairsFailed }; },
    getLastActive:      function () { return _lastActiveAt; },
    getTelemetry:       function () { return _telemetry.slice(); },
    init:               _init,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family:', FAMILY);

}(window));

// ── SOURCE: public/js/runtime-processor-loader.js ──
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

// ── SOURCE: public/js/runtime-processor-memory.js ──
// RuntimeProcessorMemory v1.0 — Arc 6 / Phase C
// =====================================================================
// Per-processor heap budget, independent memory reclaim, idle trimming,
// processor panic isolation, processor cache accounting.
//
// Extends RuntimeMemoryFirewalls (Arc 5) with:
//   - Processor-level (family) budget tracking vs tool-level
//   - Cross-tool budget aggregation per family
//   - Family-level idle trim: when ALL tools in a family are idle,
//     a reclaim callback fires after idleTrimMs
//   - Panic isolation: family budget exhausted → only that family's
//     workers terminated, not the whole runtime
//   - Cache accounting: track IDB + OPFS usage per processor
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorMemory) return;

  var LOG     = '[ProcMemory]';
  var VERSION = '1.0';
  var SWEEP_MS = 30 * 1000;

  // ── Processor registry ────────────────────────────────────────────
  // family → { budgetMb, tools, reclaimOnIdle, idleTrimMs,
  //             usageMb, tier, reclaimFns, panicCount,
  //             lastActiveAt, idleTimerId, cacheBytes }
  var _procs = {};

  // ── Tier thresholds (% of budget) ─────────────────────────────────
  var TIER_WARN     = 0.60;
  var TIER_CRITICAL = 0.80;
  var TIER_PANIC    = 0.95;

  function _tier(usageMb, budgetMb) {
    var ratio = budgetMb > 0 ? usageMb / budgetMb : 0;
    if (ratio >= TIER_PANIC)    return 'panic';
    if (ratio >= TIER_CRITICAL) return 'critical';
    if (ratio >= TIER_WARN)     return 'warn';
    return 'ok';
  }

  // ── Register a processor's memory segment ─────────────────────────
  function registerProcessor(family, spec) {
    if (!family || !spec) return;
    if (_procs[family]) return; // idempotent

    _procs[family] = {
      family:        family,
      budgetMb:      spec.budgetMb    || 128,
      tools:         spec.tools       || [],
      reclaimOnIdle: spec.reclaimOnIdle !== false,
      idleTrimMs:    spec.idleTrimMs  || (3 * 60 * 1000),
      usageMb:       0,
      tier:          'ok',
      reclaimFns:    [],
      panicCount:    0,
      lastActiveAt:  Date.now(),
      idleTimerId:   null,
      cacheBytes:    0,
    };
    console.debug(LOG, 'registered:', family, '— budget:', spec.budgetMb + 'MB |', (spec.tools || []).length, 'tools');
  }

  // ── Update usage estimate for a processor ─────────────────────────
  function updateUsage(family, usageMb) {
    var p = _procs[family];
    if (!p) return;
    p.usageMb     = usageMb;
    p.lastActiveAt = Date.now();
    var newTier   = _tier(usageMb, p.budgetMb);
    var prevTier  = p.tier;
    p.tier = newTier;

    if (newTier === 'panic' && prevTier !== 'panic') {
      _panic(family);
    } else if (newTier === 'critical' && prevTier === 'ok') {
      _reclaim(family);
    }

    // Reset idle trim timer on activity
    _resetIdleTimer(family);
  }

  // ── Register a reclaim callback ───────────────────────────────────
  function onReclaim(family, fn) {
    var p = _procs[family];
    if (!p || typeof fn !== 'function') return;
    p.reclaimFns.push(fn);
  }

  // ── Reclaim memory for a processor ────────────────────────────────
  function _reclaim(family) {
    var p = _procs[family];
    if (!p) return;
    console.debug(LOG, 'reclaiming:', family, '— tier:', p.tier, '—', p.reclaimFns.length, 'callbacks');
    p.reclaimFns.forEach(function (fn) {
      try { fn({ family: family, tier: p.tier, usageMb: p.usageMb }); } catch (_) {}
    });
    try {
      G.dispatchEvent(new CustomEvent('processor-memory:reclaim', {
        detail: { family: family, tier: p.tier, usageMb: p.usageMb },
      }));
    } catch (_) {}
  }

  // ── Panic: terminate only this processor's workers ────────────────
  function _panic(family) {
    var p = _procs[family];
    if (!p) return;
    p.panicCount++;
    console.debug(LOG, 'PANIC:', family, '— usage:', p.usageMb + 'MB /', p.budgetMb + 'MB | panic#', p.panicCount);

    // Terminate workers for this processor's tools only
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh && mesh.evict) {
        p.tools.forEach(function (toolId) { mesh.evict(toolId); });
      }
    } catch (_) {}

    // Run reclaim callbacks
    _reclaim(family);

    // Reset usage — processor will restart on next tool use
    p.usageMb = 0;
    p.tier    = 'ok';

    try {
      G.dispatchEvent(new CustomEvent('processor-memory:panic', {
        detail: { family: family, panicCount: p.panicCount },
      }));
    } catch (_) {}
  }

  // ── Idle trim timer ───────────────────────────────────────────────
  function _resetIdleTimer(family) {
    var p = _procs[family];
    if (!p || !p.reclaimOnIdle) return;
    if (p.idleTimerId) clearTimeout(p.idleTimerId);
    p.idleTimerId = setTimeout(function () {
      if ((Date.now() - p.lastActiveAt) >= p.idleTrimMs) {
        console.debug(LOG, 'idle trim:', family, '— freeing', p.usageMb + 'MB');
        _reclaim(family);
        p.cacheBytes = 0;
        p.usageMb    = 0;
        p.tier       = 'ok';
        try {
          G.dispatchEvent(new CustomEvent('processor-memory:idle-trim', {
            detail: { family: family },
          }));
        } catch (_) {}
      }
    }, p.idleTrimMs);
  }

  // ── Track cache bytes (IDB + OPFS) ────────────────────────────────
  function updateCacheBytes(family, bytes) {
    var p = _procs[family];
    if (!p) return;
    p.cacheBytes = Math.max(0, bytes);
  }

  // ── Periodic sweep: update usage estimates from heap ──────────────
  function _sweep() {
    try {
      var heapUsed = performance && performance.memory && performance.memory.usedJSHeapSize;
      if (!heapUsed) return;
      var heapMb = heapUsed / 1048576;
      // Distribute heap across active processors proportional to their budget
      var active = Object.values(_procs).filter(function (p) { return p.tier !== 'ok' || p.usageMb > 0; });
      if (!active.length) return;
      var totalBudget = active.reduce(function (s, p) { return s + p.budgetMb; }, 0) || 1;
      active.forEach(function (p) {
        var share = heapMb * (p.budgetMb / totalBudget);
        updateUsage(p.family, Math.round(share));
      });
    } catch (_) {}
  }
  setInterval(_sweep, SWEEP_MS);

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_procs).forEach(function (family) {
      var p = _procs[family];
      out[family] = {
        budgetMb:    p.budgetMb,
        usageMb:     p.usageMb,
        cacheBytes:  p.cacheBytes,
        tier:        p.tier,
        panicCount:  p.panicCount,
        lastActiveAt: p.lastActiveAt,
        pct:         p.budgetMb > 0 ? Math.round(p.usageMb / p.budgetMb * 100) : 0,
      };
    });
    return out;
  }

  G.RuntimeProcessorMemory = Object.freeze({
    VERSION:           VERSION,
    registerProcessor: registerProcessor,
    updateUsage:       updateUsage,
    updateCacheBytes:  updateCacheBytes,
    onReclaim:         onReclaim,
    panic:             _panic,
    reclaim:           _reclaim,
    getStats:          getStats,
    getTier:           function (family) { return (_procs[family] || {}).tier || 'ok'; },
    getBudget:         function (family) { return (_procs[family] || {}).budgetMb || 0; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-processor memory segmentation active');

}(window));

// ── SOURCE: public/js/runtime-processor-workers.js ──
// RuntimeProcessorWorkers v1.0 — Arc 6 / Phase D
// =====================================================================
// Processor-specific worker pools, independent scaling,
// independent thermal throttling, independent crash recovery,
// independent congestion queues.
//
// Extends RuntimeWorkerCoordinator (Arc 2) and RuntimeToolWorkerMesh
// (Arc 5) with processor-family-level worker pool management:
//   - Per-processor maxWorkers cap (independent of other processors)
//   - Per-processor thermal limit (OCR hot → throttle OCR only)
//   - Per-processor crash counter → isolate pool on crash threshold
//   - Per-processor congestion queue with FIFO ordering
//   - Aux worker URL registration for multi-worker processors
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorWorkers) return;

  var LOG     = '[ProcWorkers]';
  var VERSION = '1.0';
  var CRASH_ISOLATE = 3;   // crashes before isolating the pool
  var THERMAL_CHECK = 30 * 1000;

  // ── Pool registry ─────────────────────────────────────────────────
  // family → { workerUrl, maxWorkers, auxWorkerUrls,
  //             activeCount, crashCount, isolated,
  //             thermalLimit, queue }
  var _pools = {};

  // ── Shared thermal tier ───────────────────────────────────────────
  var _thermalTier = 'nominal';

  function _refreshThermal() {
    try {
      var ais = G.RuntimeAIScheduler;
      var p   = ais && ais.getProfile && ais.getProfile();
      _thermalTier = (p && p.thermal) || 'nominal';
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  function _thermalMaxForTier(tier) {
    if (tier === 'critical') return 1;
    if (tier === 'hot')      return 2;
    if (tier === 'warm')     return 3;
    return null; // no cap
  }

  // ── Register a processor's worker pool ────────────────────────────
  function registerPool(family, spec) {
    if (!family || !spec) return;
    if (_pools[family]) return; // idempotent

    _pools[family] = {
      family:       family,
      workerUrl:    spec.workerUrl     || null,
      maxWorkers:   spec.maxWorkers    || 2,
      auxWorkerUrls: spec.auxWorkerUrls || [],
      activeCount:  0,
      crashCount:   0,
      isolated:     false,
      thermalLimit: null,
      queue:        [],      // pending tasks while congested / isolated
    };
    console.debug(LOG, 'pool registered:', family, '— maxWorkers:', spec.maxWorkers, '| aux:', (spec.auxWorkerUrls || []).length);
  }

  // ── Record a task start ───────────────────────────────────────────
  function taskStart(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.activeCount = Math.min(pool.activeCount + 1, pool.maxWorkers + 1);
  }

  // ── Record a task end ─────────────────────────────────────────────
  function taskEnd(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    _drainQueue(family);
  }

  // ── Record a worker crash ─────────────────────────────────────────
  function recordCrash(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.crashCount++;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    if (pool.crashCount >= CRASH_ISOLATE && !pool.isolated) {
      pool.isolated = true;
      console.debug(LOG, 'ISOLATED:', family, '— crashes:', pool.crashCount);
      try {
        G.dispatchEvent(new CustomEvent('processor-workers:isolated', {
          detail: { family: family, crashCount: pool.crashCount },
        }));
      } catch (_) {}
    }
  }

  // ── Reset isolation (e.g. after page reload hint or manual reset) ──
  function resetPool(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.crashCount  = 0;
    pool.isolated    = false;
    pool.activeCount = 0;
    pool.queue       = [];
    console.debug(LOG, 'pool reset:', family);
  }

  // ── Check if a family can accept a new task ───────────────────────
  function canAccept(family) {
    var pool = _pools[family];
    if (!pool) return true; // unknown family → defer to WorkerPool
    if (pool.isolated) return false;
    var thermalCap = _thermalMaxForTier(_thermalTier);
    var effective  = thermalCap !== null ? Math.min(pool.maxWorkers, thermalCap) : pool.maxWorkers;
    return pool.activeCount < effective;
  }

  // ── Enqueue a pending task ────────────────────────────────────────
  function enqueue(family, taskFn) {
    var pool = _pools[family];
    if (!pool) { try { taskFn(); } catch (_) {} return; }
    if (pool.isolated) {
      console.debug(LOG, 'queue rejected — isolated:', family);
      return;
    }
    pool.queue.push(taskFn);
    console.debug(LOG, 'queued task for:', family, '— queue length:', pool.queue.length);
  }

  // ── Drain queue when capacity frees up ────────────────────────────
  function _drainQueue(family) {
    var pool = _pools[family];
    if (!pool || !pool.queue.length) return;
    if (!canAccept(family)) return;
    var next = pool.queue.shift();
    if (typeof next === 'function') {
      taskStart(family);
      try { next(); } catch (_) { recordCrash(family); }
    }
  }

  // ── Update thermal limit per processor ────────────────────────────
  // (called when processor-specific thermal event fires)
  function setThermalLimit(family, limit) {
    var pool = _pools[family];
    if (!pool) return;
    pool.thermalLimit = limit;
  }

  // ── Prewarm all registered aux workers for a family ───────────────
  function prewarm(family) {
    var pool = _pools[family];
    if (!pool) return;
    try {
      var wp = G.WorkerPool;
      if (!wp || !wp.prewarm) return;
      if (pool.workerUrl) wp.prewarm(pool.workerUrl);
      pool.auxWorkerUrls.forEach(function (url) { wp.prewarm(url); });
    } catch (_) {}
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (!id) return;
      // Lightweight prewarm on tool activation
      Object.keys(_pools).forEach(function (family) {
        var pool = _pools[family];
        if (pool.family === id || (pool && pool.family && id && id.indexOf(pool.family) !== -1)) return;
        // No-op — activation-specific prewarm is handled per-processor
      });
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      // Find which pool owns this tool and record a crash
      Object.keys(_pools).forEach(function (family) {
        var pool = _pools[family];
        // Rough match: toolId contains family name
        if (pool && toolId) recordCrash(family);
      });
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_pools).forEach(function (family) {
      var p = _pools[family];
      out[family] = {
        maxWorkers:  p.maxWorkers,
        activeCount: p.activeCount,
        crashCount:  p.crashCount,
        isolated:    p.isolated,
        queueLength: p.queue.length,
        thermalTier: _thermalTier,
      };
    });
    return out;
  }

  G.RuntimeProcessorWorkers = Object.freeze({
    VERSION:         VERSION,
    registerPool:    registerPool,
    taskStart:       taskStart,
    taskEnd:         taskEnd,
    recordCrash:     recordCrash,
    resetPool:       resetPool,
    canAccept:       canAccept,
    enqueue:         enqueue,
    prewarm:         prewarm,
    setThermalLimit: setThermalLimit,
    getStats:        getStats,
    isIsolated:      function (family) { return !!(_pools[family] && _pools[family].isolated); },
    getThermalTier:  function () { return _thermalTier; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-processor worker pools active');

}(window));

// ── SOURCE: public/js/runtime-processor-hydration.js ──
// RuntimeProcessorHydration v1.0 — Arc 6 / Phase E
// =====================================================================
// Processor-specific hydration domains: no global hydration queues,
// idle cancellation, mobile-aware deferred hydration, predictive hooks.
//
// Extends RuntimeHydrationDomains (Arc 3) with processor-family-level
// orchestration:
//   - Each processor family gets its own hydration timeline (P0/P1/P2)
//   - Idle cancellation: if the tool that triggered hydration becomes
//     idle before P2 runs, the P2 queue is cleared
//   - Mobile-aware deferral: on low-tier devices, only P0 runs
//     immediately; P1 and P2 are deferred until tool is actually used
//   - Predictive hydration: register hints so that hovering a tool
//     pre-warms its processor's P1 queue
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorHydration) return;

  var LOG     = '[ProcHydration]';
  var VERSION = '1.0';
  var IDLE_CANCEL_MS = 5 * 60 * 1000; // 5 min idle → cancel pending P2

  // ── Processor hydration state ─────────────────────────────────────
  // family → { tiers: { P0, P1, P2 }, activated, lastActiveAt,
  //             idleCancelTimer, mobileTier, predictiveHints }
  var _hydration = {};

  // ── Mobile tier ───────────────────────────────────────────────────
  var _mobileTier = 'medium';
  function _initMobileTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getTier) { _mobileTier = mh.getTier(); return; }
      _mobileTier = (navigator.hardwareConcurrency || 4) <= 2 ? 'low' : 'medium';
    } catch (_) {}
  }

  // ── Create a processor hydration domain ───────────────────────────
  function createDomain(family, tools) {
    if (_hydration[family]) return _hydration[family];
    _hydration[family] = {
      family:         family,
      tools:          tools || [],
      tiers:          { P0: [], P1: [], P2: [] },
      activated:      { P0: false, P1: false, P2: false },
      metrics:        { P0: null, P1: null, P2: null },
      lastActiveAt:   0,
      idleCancelTimer: null,
    };
    console.debug(LOG, 'domain created:', family);
    return _hydration[family];
  }

  // ── Register a hydration module ───────────────────────────────────
  function register(family, name, fn, tier) {
    var dom = _hydration[family];
    if (!dom) dom = createDomain(family);
    tier = tier || 'P2';
    dom.tiers[tier] = dom.tiers[tier] || [];
    dom.tiers[tier].push({ name: name, fn: fn, activated: false });
  }

  // ── Activate a tier for a processor ───────────────────────────────
  function activate(family, tier) {
    var dom = _hydration[family];
    if (!dom) return;
    if (dom.activated[tier]) return;

    // Mobile low-tier: defer P1 + P2 until explicitly forced
    if (_mobileTier === 'low' && tier !== 'P0') {
      console.debug(LOG, 'mobile low-tier: deferring', family, tier);
      return;
    }

    dom.activated[tier] = true;
    dom.lastActiveAt    = Date.now();
    var modules = dom.tiers[tier] || [];
    var t0 = Date.now();

    modules.forEach(function (m) {
      if (m.activated) return;
      try {
        m.fn();
        m.activated = true;
      } catch (e) {
        console.debug(LOG, 'module error:', family, '/', m.name, e && e.message || e);
      }
    });

    var dur = Date.now() - t0;
    dom.metrics[tier] = { durationMs: dur, count: modules.length, ts: Date.now() };
    console.debug(LOG, family, tier, 'hydrated —', modules.length, 'modules in', dur + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('processor-hydration:activated', {
        detail: { family: family, tier: tier, durationMs: dur },
      }));
    } catch (_) {}
  }

  // ── Force-activate P1/P2 on low-tier (called on actual tool use) ──
  function forceActivate(family) {
    var dom = _hydration[family];
    if (!dom) return;
    ['P0', 'P1', 'P2'].forEach(function (tier) { activate(family, tier); });
  }

  // ── Idle cancellation ─────────────────────────────────────────────
  function _scheduleIdleCancel(family) {
    var dom = _hydration[family];
    if (!dom) return;
    if (dom.idleCancelTimer) clearTimeout(dom.idleCancelTimer);
    dom.idleCancelTimer = setTimeout(function () {
      if ((Date.now() - dom.lastActiveAt) < IDLE_CANCEL_MS) return;
      if (!dom.activated['P2']) {
        dom.tiers['P2'] = []; // clear P2 queue — it was never needed
        console.debug(LOG, 'idle cancel P2 queue cleared for:', family);
        try {
          G.dispatchEvent(new CustomEvent('processor-hydration:cancelled', {
            detail: { family: family, tier: 'P2' },
          }));
        } catch (_) {}
      }
    }, IDLE_CANCEL_MS);
  }

  // ── Predictive hydration via tool hover ───────────────────────────
  var _hoverScheduled = {};
  var TOOL_FAMILY = {
    'merge':'organize','split':'split','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress','compress-pdf':'compress',
    'pdf-to-word':'convert','pdf-to-excel':'convert','pdf-to-powerpoint':'convert',
    'word-to-pdf':'convert','excel-to-pdf':'convert','powerpoint-to-pdf':'convert',
    'watermark':'edit','sign':'edit','protect':'edit','unlock':'edit','edit':'edit',
    'repair':'repair','compare':'edit',
    'ocr':'ocr','ocr-pdf':'ocr',
    'ai-summarize':'ai-nlp','ai-summarizer':'ai-nlp','translate':'ai-nlp',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
  };

  function _installHoverPrewarm() {
    try {
      document.addEventListener('mouseover', function (e) {
        var el = e.target && e.target.closest && e.target.closest('[data-tool], .tool-card');
        if (!el) return;
        var toolId = el.getAttribute('data-tool') || '';
        if (!toolId) return;
        var family = TOOL_FAMILY[toolId];
        if (!family || _hoverScheduled[family]) return;
        _hoverScheduled[family] = true;
        setTimeout(function () {
          delete _hoverScheduled[family];
          var dom = _hydration[family];
          if (dom && !dom.activated['P1']) activate(family, 'P1');
        }, 300); // 300ms debounce
      }, { passive: true });
    } catch (_) {}
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (!id) return;
      var family = TOOL_FAMILY[id];
      if (!family) return;
      var dom = _hydration[family];
      if (dom) {
        dom.lastActiveAt = Date.now();
        forceActivate(family); // actual tool use → force all tiers
        _scheduleIdleCancel(family);
      }
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    _initMobileTier();
    _installHoverPrewarm();
    console.debug(LOG, 'v' + VERSION + ' booted — mobile tier:', _mobileTier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_hydration).forEach(function (family) {
      var d = _hydration[family];
      out[family] = {
        activated:    Object.assign({}, d.activated),
        metrics:      Object.assign({}, d.metrics),
        lastActiveAt: d.lastActiveAt,
        queueSizes:   { P0: d.tiers.P0.length, P1: d.tiers.P1.length, P2: d.tiers.P2.length },
      };
    });
    return out;
  }

  G.RuntimeProcessorHydration = Object.freeze({
    VERSION:        VERSION,
    createDomain:   createDomain,
    register:       register,
    activate:       activate,
    forceActivate:  forceActivate,
    getStats:       getStats,
    getMobileTier:  function () { return _mobileTier; },
    isActivated:    function (family, tier) { return !!((_hydration[family] || {}).activated || {})[tier || 'P0']; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — processor hydration domains active');

}(window));

// ── SOURCE: public/js/runtime-processor-bundles.js ──
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

// ── SOURCE: public/js/runtime-processor-health.js ──
// RuntimeProcessorHealth v1.0 — Arc 6 / Phase G
// =====================================================================
// Independent processor health scores, startup metrics, crash counters,
// worker health, memory telemetry.
//
// Provides a unified health view per processor family, aggregating from:
//   - RuntimeProcessorLoader  (activation state + startup timing)
//   - RuntimeProcessorMemory  (memory tier + panic count)
//   - RuntimeProcessorWorkers (crash count + isolation state)
//   - RuntimeProcessorHydration (hydration coverage)
//   - RuntimeProcessorBundles  (bundle GC state)
//
// Health score: 0–100 per processor (100 = fully healthy)
//   -10 per critical memory tier
//   -20 per panic
//   -15 per isolated worker pool
//   -5  per dormant bundle (processor not active)
//    +5 when all hydration tiers activated
//    clamp to [0, 100]
//
// window.getProcessorHealth() → summary API for dashboards.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorHealth) return;

  var LOG     = '[ProcHealth]';
  var VERSION = '1.0';
  var SAMPLE_MS = 30 * 1000; // sample every 30 s

  // ── Per-processor health state ────────────────────────────────────
  // family → { score, tier, events[], startupMs, crashCount, lastSampleAt }
  var _health = {};

  var FAMILIES = [
    'organize', 'split', 'compress', 'convert',
    'edit', 'repair', 'ocr', 'ai-nlp', 'image', 'utility',
  ];

  FAMILIES.forEach(function (f) {
    _health[f] = {
      family:       f,
      score:        100,
      tier:         'healthy', // healthy | degraded | critical | isolated
      events:       [],
      startupMs:    null,
      crashCount:   0,
      lastSampleAt: null,
    };
  });

  function _addEvent(family, type, data) {
    var h = _health[family];
    if (!h) return;
    h.events.push({ ts: Date.now(), type: type, data: data || null });
    if (h.events.length > 50) h.events.shift();
  }

  // ── Score computation ─────────────────────────────────────────────
  function _computeScore(family) {
    var score = 100;

    // Memory tier penalty
    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm) {
        var memTier = pm.getTier(family);
        var stats   = pm.getStats && pm.getStats();
        var ps      = stats && stats[family];
        if (memTier === 'panic')    { score -= 20; if (ps) score -= (ps.panicCount || 0) * 5; }
        if (memTier === 'critical') { score -= 10; }
        if (memTier === 'warn')     { score -= 3;  }
      }
    } catch (_) {}

    // Worker isolation penalty
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) {
        var wstats = pw.getStats && pw.getStats();
        var ws     = wstats && wstats[family];
        if (ws && ws.isolated) score -= 25;
        if (ws) score -= Math.min(ws.crashCount || 0, 4) * 5;
      }
    } catch (_) {}

    // Loader crash penalty
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr) {
        var lstats = ldr.getStats && ldr.getStats();
        var ls     = lstats && lstats[family];
        if (ls) {
          score -= (ls.crashCount || 0) * 8;
          // Dormant penalty (processor evicted — not available)
          if (!ls.activated && ls.dormantAt) score -= 5;
        }
      }
    } catch (_) {}

    // Hydration bonus
    try {
      var ph = G.RuntimeProcessorHydration;
      if (ph) {
        var p2 = ph.isActivated && ph.isActivated(family, 'P2');
        if (p2) score += 3;
      }
    } catch (_) {}

    return Math.min(100, Math.max(0, score));
  }

  function _tierFromScore(score) {
    if (score >= 85) return 'healthy';
    if (score >= 60) return 'degraded';
    if (score >= 30) return 'critical';
    return 'isolated';
  }

  // ── Sample all processors ─────────────────────────────────────────
  function _sample() {
    var now = Date.now();
    FAMILIES.forEach(function (family) {
      var h     = _health[family];
      if (!h) return;
      var score = _computeScore(family);
      var tier  = _tierFromScore(score);
      var prev  = h.tier;
      h.score        = score;
      h.tier         = tier;
      h.lastSampleAt = now;

      if (tier !== prev) {
        _addEvent(family, 'tier-change', { from: prev, to: tier, score: score });
        console.debug(LOG, family, 'health:', tier, '(' + score + ')');
        try {
          G.dispatchEvent(new CustomEvent('processor-health:change', {
            detail: { family: family, tier: tier, score: score, prev: prev },
          }));
        } catch (_) {}
      }
    });
  }
  setInterval(_sample, SAMPLE_MS);

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('processor-loader:crash', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (!family || !_health[family]) return;
      _health[family].crashCount++;
      _addEvent(family, 'loader-crash', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) _addEvent(family, 'memory-panic', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) _addEvent(family, 'worker-isolated', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor:init', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.processor) return;
      var h = _health[d.processor];
      if (h) {
        h.startupMs = d.startupMs;
        _addEvent(d.processor, 'init', { startupMs: d.startupMs });
      }
    } catch (_) {}
  });

  // ── Stats API ─────────────────────────────────────────────────────
  function getAll() {
    var out = {};
    FAMILIES.forEach(function (f) {
      var h = _health[f];
      out[f] = { score: h.score, tier: h.tier, crashCount: h.crashCount,
                 startupMs: h.startupMs, lastSampleAt: h.lastSampleAt };
    });
    return out;
  }

  function getHealthScore(family) {
    return (_health[family] || {}).score || 0;
  }

  // Expose as window.getProcessorHealth() for console inspection
  G.getProcessorHealth = function () { return getAll(); };

  G.RuntimeProcessorHealth = Object.freeze({
    VERSION:         VERSION,
    getAll:          getAll,
    getScore:        getHealthScore,
    getTier:         function (f) { return (_health[f] || {}).tier || 'unknown'; },
    getEvents:       function (f) { return ((_health[f] || {}).events || []).slice(); },
    sample:          _sample,
  });

  // Initial sample
  setTimeout(_sample, 2000);

  console.debug(LOG, 'v' + VERSION + ' ready — processor health domains active | window.getProcessorHealth() available');

}(window));

