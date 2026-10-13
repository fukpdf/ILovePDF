/* ToolEngineLoader v2 — split preview and processing boot.
 * The upload shell is intentionally kept independent from processing bundles.
 * File selection starts preview + engine downloads; Process waits for the engine
 * promise if it is still in flight. All classic scripts load sequentially so
 * existing global-script dependencies keep their expected order.
 */
(function (G) {
  'use strict';
  if (G.ToolEngineLoader) return;

  var _loaded = new Set();
  var _scriptPromises = new Map();
  var _enginePromises = new Map();
  var _previewPromises = new Map();
  var _engineReady = new Set();
  var _previewReady = new Set();

  // Shared processing foundation. Optional diagnostics, dashboards, ads,
  // marketing widgets, unrelated tool-apps, and unused AI runtimes are omitted.
  var CORE = [
    '/workers/workerPool.js',
    '/js/stream-helpers.js',
    '/js/memory-pressure-monitor.js',
    '/js/adaptive-runtime.js',
    '/js/task-scheduler.js',
    '/js/object-url-registry.js',
    '/js/browser-resource-lifecycle.js',
    '/js/lifecycle-manager.js',
    '/js/worker-lifecycle.js',
    '/js/download-manager.js',
    '/js/retry-orchestrator.js',
    '/js/navigation-cancel.js',
    '/js/adaptive-degradation.js',
    '/js/cleanup-contracts.js',
    '/js/runtime-event-bus.js',
    '/js/runtime-state.js',
    '/js/runtime-telemetry.js',
    '/js/runtime-cancellation.js',
    '/js/runtime-memory-controller.js',
    '/js/runtime-progress.js',
    '/js/runtime-task-scheduler.js',
    '/js/runtime-worker-orchestrator.js',
    '/js/runtime-queue-engine.js',
    '/js/runtime-cleanup.js',
    '/js/runtime-health.js',
    '/js/runtime-tool-adapters.js',
    '/js/runtime-streaming-hooks.js',
    '/js/runtime-phase5.js',
    '/js/runtime-idb.js',
    '/js/runtime-adaptive-pipeline.js',
    '/js/runtime-stream-bridge.js',
    '/js/pdf-byte-range-index.js',
    '/js/runtime-idb-coalescer.js',
    '/js/runtime-security.js',
    '/js/runtime-memory-defense.js',
    '/js/runtime-result-cache.js',
    '/js/runtime-worker-factory.js',
    '/js/runtime-core.js',
    '/js/browser-tools.js',
    '/js/browser-tool-runtime.js'
  ];

  var PREVIEW = [
    '/js/pdf-preview.js',
    '/js/live-preview.js',
    '/js/page-organizer.js',
    '/js/app-router.js'
  ];

  var ADVANCED_TOOLS = new Set([
    'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
    'word-to-pdf', 'powerpoint-to-pdf', 'excel-to-pdf', 'word-to-excel',
    'html-to-pdf', 'ocr', 'scan-to-pdf', 'translate', 'ai-summarize',
    'crop-image', 'resize-image', 'image-filters', 'image-compressor',
    'image-converter'
  ]);

  var TOOL_PREVIEW_MODULES = {
    'background-remover': ['/js/bg-ai-engine.js', '/js/bg-remover-pro.js'],
    'edit': ['/js/edit-pdf-pro.js']
  };

  var TRANSLATION_TOOLS = new Set(['translate', 'ocr', 'scan-to-pdf']);

  function loadOne(src) {
    if (_loaded.has(src) || document.querySelector('script[src="' + src + '"]')) {
      _loaded.add(src);
      return Promise.resolve();
    }
    if (_scriptPromises.has(src)) return _scriptPromises.get(src);

    var promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.toolEngineSrc = src;
      script.onload = function () {
        _loaded.add(src);
        resolve();
      };
      script.onerror = function () {
        script.remove();
        _scriptPromises.delete(src);
        reject(new Error('Could not load processing module: ' + src));
      };
      document.head.appendChild(script);
    });
    _scriptPromises.set(src, promise);
    return promise;
  }

  async function loadOrdered(sources) {
    for (var i = 0; i < sources.length; i++) await loadOne(sources[i]);
  }

  function engineModulesFor(toolId) {
    var sources = CORE.slice();
    if (ADVANCED_TOOLS.has(toolId)) sources.push('/js/advanced-engine.js');
    if (TRANSLATION_TOOLS.has(toolId)) {
      sources.push(
        '/js/universal-encoding-repair.js',
        '/js/universal-translation-chunker.js',
        '/js/universal-ocr-cleanup.js',
        '/js/global-multilingual-renderer.js',
        '/js/universal-translation-validator.js',
        '/js/universal-translation-pipeline.js'
      );
    }
    return Array.from(new Set(sources));
  }

  function previewModulesFor(toolId) {
    return Array.from(new Set(PREVIEW.concat(TOOL_PREVIEW_MODULES[toolId] || [])));
  }

  function preparePreview(toolId) {
    if (!toolId) return Promise.reject(new Error('A tool ID is required to prepare preview.'));
    var key = String(toolId);
    if (_previewReady.has(key)) return Promise.resolve({ toolId: key, ready: true });
    if (_previewPromises.has(key)) return _previewPromises.get(key);
    var promise = loadOrdered(previewModulesFor(key)).then(function () {
      _previewReady.add(key);
      return { toolId: key, ready: true };
    }).catch(function (error) {
      _previewPromises.delete(key);
      _previewReady.delete(key);
      throw error;
    });
    _previewPromises.set(key, promise);
    return promise;
  }

  function prepareEngine(toolId) {
    if (!toolId) return Promise.reject(new Error('A tool ID is required to prepare the engine.'));
    var key = String(toolId);
    if (_engineReady.has(key)) return Promise.resolve({ toolId: key, ready: true });
    if (_enginePromises.has(key)) return _enginePromises.get(key);
    var promise = loadOrdered(engineModulesFor(key)).then(async function () {
      // Prewarm only dependencies explicitly declared by BrowserTools for this
      // tool. Other tools do not download each other's CDN libraries.
      if (G.BrowserTools && typeof G.BrowserTools.prewarm === 'function') {
        await G.BrowserTools.prewarm(key);
      }
      _engineReady.add(key);
      return { toolId: key, ready: true };
    }).catch(function (error) {
      _enginePromises.delete(key);
      _engineReady.delete(key);
      throw error;
    });
    _enginePromises.set(key, promise);
    return promise;
  }

  function prepare(toolId) {
    return Promise.all([preparePreview(toolId), prepareEngine(toolId)]).then(function () {
      return { toolId: String(toolId), ready: true };
    });
  }

  G.ToolEngineLoader = Object.freeze({
    prepare: prepare,
    preparePreview: preparePreview,
    prepareEngine: prepareEngine,
    isPreviewReady: function (toolId) { return !!toolId && _previewReady.has(String(toolId)); },
    isEngineReady: function (toolId) { return !!toolId && _engineReady.has(String(toolId)); },
    getLoadedScripts: function () { return Array.from(_loaded); }
  });
}(window));
