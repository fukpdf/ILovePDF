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
