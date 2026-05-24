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
