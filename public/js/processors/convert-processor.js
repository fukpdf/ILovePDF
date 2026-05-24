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
