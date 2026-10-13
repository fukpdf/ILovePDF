/* ToolEngineLoader v1 — on-demand processing/preview boot.
 * Only the lightweight shell is loaded at page open. After a valid file is
 * selected, load the shared processing foundation and the selected tool's
 * preview/engine modules in deterministic order.
 */
(function (G) {
  'use strict';
  if (G.ToolEngineLoader) return;

  var _loaded = new Set();
  var _inFlight = new Map();
  var _prepared = new Set();

  // Ordered shared runtime needed by the browser processor, streaming workers,
  // result lifecycle, and PDF preview. Diagnostics, dashboards, ads, AI graphs,
  // and unrelated tool-app bundles are deliberately not in this list.
  var CORE = [
    '/workers/workerPool.js',
    '/js/stream-helpers.js',
    '/js/memory-pressure-monitor.js',
    '/js/object-url-registry.js',
    '/js/browser-resource-lifecycle.js',
    '/js/worker-lifecycle.js',
    '/js/download-manager.js',
    '/js/retry-orchestrator.js',
    '/js/navigation-cancel.js',
    '/js/adaptive-degradation.js',
    '/js/cleanup-contracts.js',
    '/js/runtime-event-bus.js',
    '/js/runtime-state.js',
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
    '/js/runtime-core.js',
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
    'compress', 'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
    'word-to-pdf', 'powerpoint-to-pdf', 'excel-to-pdf', 'word-to-excel',
    'html-to-pdf', 'ocr', 'scan-to-pdf', 'translate', 'ai-summarize',
    'background-remover', 'crop-image', 'resize-image', 'image-filters',
    'image-compressor', 'image-converter'
  ]);

  var TOOL_MODULES = {
    'background-remover': ['/js/bg-ai-engine.js', '/js/bg-remover-pro.js'],
    'edit': ['/js/edit-pdf-pro.js']
  };

  var TRANSLATION_TOOLS = new Set(['translate', 'ocr', 'scan-to-pdf']);

  function scriptPresent(src) {
    return _loaded.has(src) || !!document.querySelector('script[data-tool-engine-src="' + src + '"]') ||
      !!document.querySelector('script[src="' + src + '"]');
  }

  function loadOne(src) {
    if (scriptPresent(src)) {
      _loaded.add(src);
      return Promise.resolve();
    }
    if (_inFlight.has(src)) return _inFlight.get(src);

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
        _inFlight.delete(src);
        reject(new Error('Could not load processing module: ' + src));
      };
      document.head.appendChild(script);
    });
    _inFlight.set(src, promise);
    return promise;
  }

  async function loadOrdered(sources) {
    for (var i = 0; i < sources.length; i++) {
      await loadOne(sources[i]);
    }
  }

  function modulesFor(toolId) {
    var sources = CORE.slice();
    if (ADVANCED_TOOLS.has(toolId)) sources.push('/js/advanced-engine.js');
    sources = sources.concat(PREVIEW);
    if (TOOL_MODULES[toolId]) sources = sources.concat(TOOL_MODULES[toolId]);
    if (TRANSLATION_TOOLS.has(toolId)) {
      sources = sources.concat([
        '/js/universal-encoding-repair.js',
        '/js/universal-translation-chunker.js',
        '/js/universal-ocr-cleanup.js',
        '/js/global-multilingual-renderer.js',
        '/js/universal-translation-validator.js',
        '/js/universal-translation-pipeline.js'
      ]);
    }
    return Array.from(new Set(sources));
  }

  function prepare(toolId) {
    if (!toolId) return Promise.reject(new Error('A tool ID is required to prepare the engine.'));
    var key = String(toolId);
    if (_inFlight.has('tool:' + key)) return _inFlight.get('tool:' + key);
    var promise = loadOrdered(modulesFor(key)).then(function () {
      _prepared.add(key);
      return { toolId: key, ready: true, loadedScripts: _loaded.size };
    }).catch(function (error) {
      _inFlight.delete('tool:' + key);
      _prepared.delete(key);
      throw error;
    });
    _inFlight.set('tool:' + key, promise);
    return promise;
  }

  G.ToolEngineLoader = Object.freeze({
    prepare: prepare,
    isReady: function (toolId) {
      return !!toolId && _prepared.has(String(toolId));
    },
    getLoadedScripts: function () { return Array.from(_loaded); }
  });
}(window));
