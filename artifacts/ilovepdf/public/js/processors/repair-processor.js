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
