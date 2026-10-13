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
  var _preloadPromises = new Map();
  var _enginePromises = new Map();
  var _previewPromises = new Map();
  var _dependencyPromises = new Map();
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

  var PDF_PREVIEW_TOOLS = new Set([
    'merge', 'split', 'rotate', 'organize', 'crop', 'compress', 'page-numbers',
    'watermark', 'sign', 'redact', 'protect', 'unlock', 'repair', 'ocr',
    'ai-summarize', 'translate', 'edit', 'compare', 'pdf-to-word',
    'pdf-to-excel', 'pdf-to-powerpoint', 'pdf-to-jpg'
  ]);
  var LIVE_PREVIEW_TOOLS = new Set([
    'pdf-to-word', 'pdf-to-excel', 'background-remover', 'translate',
    'ai-summarize', 'edit', 'pdf-to-powerpoint', 'powerpoint-to-pdf',
    'html-to-pdf', 'ocr', 'scan-to-pdf', 'repair', 'word-to-excel'
  ]);
  var PAGE_ORGANIZER_TOOLS = new Set([
    'split', 'rotate', 'organize', 'crop', 'page-numbers', 'watermark',
    'sign', 'redact', 'ocr', 'ai-summarize', 'translate', 'repair', 'edit'
  ]);

  // Match AdvancedEngine's TOOL_STEPS manifest, excluding compress because
  // the shared tool page uses its dedicated runAdvancedCompress() pipeline.
  var ADVANCED_TOOLS = new Set([
    'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint', 'word-to-pdf',
    'excel-to-pdf', 'html-to-pdf', 'ocr', 'scan-to-pdf', 'background-remover',
    'repair', 'compare', 'ai-summarize', 'translate', 'workflow', 'merge',
    'split', 'rotate', 'organize', 'page-numbers', 'watermark', 'crop',
    'jpg-to-pdf', 'protect', 'unlock', 'pdf-to-jpg', 'crop-image',
    'resize-image', 'image-filters', 'edit', 'sign', 'redact',
    'powerpoint-to-pdf', 'word-to-excel'
  ]);

  var TOOL_PREVIEW_MODULES = {
    'background-remover': ['/js/bg-ai-engine.js', '/js/bg-remover-pro.js'],
    'edit': ['/js/edit-pdf-pro.js']
  };

  var TRANSLATION_TOOLS = new Set(['translate', 'ocr', 'scan-to-pdf']);
  var DEDICATED_EDITOR_TOOLS = new Set(['edit', 'background-remover']);
  var PDF_WORD_PIPELINE = [
    '/js/pdf-pipeline/font-mapper.js',
    '/js/pdf-pipeline/column-engine.js',
    '/js/pdf-pipeline/form-reconstruction.js',
    '/js/pdf-pipeline/fidelity-validator.js',
    '/js/pdf-pipeline/visual-reconstruction.js',
    '/js/pdf-pipeline/ocr-zoning.js',
    '/js/pdf-pipeline/image-anchor-engine.js',
    '/js/pdf-pipeline/layout-graph.js',
    '/js/pdf-pipeline/docx-coordinate-engine.js',
    '/js/pdf-pipeline/fidelity-debug.js'
  ];

  function loadOne(src) {
    if (_loaded.has(src)) return Promise.resolve();
    // Check the in-flight promise before looking for a script tag: another
    // tool may already have inserted this dependency but not executed it yet.
    if (_scriptPromises.has(src)) return _scriptPromises.get(src);
    if (document.querySelector('script[src="' + src + '"]')) {
      _loaded.add(src);
      return Promise.resolve();
    }

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

  function preloadOne(src) {
    if (_loaded.has(src)) return Promise.resolve();
    if (_scriptPromises.has(src)) return _scriptPromises.get(src);
    if (document.querySelector('script[src="' + src + '"]')) return Promise.resolve();
    if (_preloadPromises.has(src)) return _preloadPromises.get(src);
    var promise = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'script';
      link.href = src;
      link.fetchPriority = 'low';
      link.dataset.toolEnginePreload = src;
      link.onload = resolve;
      // Preload is only an optimization. The ordered script request below is
      // authoritative and will report a real failure if the script cannot load.
      link.onerror = resolve;
      document.head.appendChild(link);
    });
    _preloadPromises.set(src, promise);
    return promise;
  }

  async function loadOrdered(sources) {
    // Download the selected tool's resources concurrently, then execute them
    // one at a time in manifest order. This avoids a serial network waterfall
    // without allowing a dependent classic script to execute before its parent.
    await Promise.all(sources.map(preloadOne));
    for (var i = 0; i < sources.length; i++) await loadOne(sources[i]);
  }

  function engineModulesFor(toolId) {
    var sources = CORE.slice();
    if (ADVANCED_TOOLS.has(toolId)) sources.push('/js/advanced-engine.js');
    if (toolId === 'pdf-to-word') sources = sources.concat(PDF_WORD_PIPELINE);
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
    var sources = [];
    if (PDF_PREVIEW_TOOLS.has(toolId)) sources.push('/js/pdf-preview.js');
    if (LIVE_PREVIEW_TOOLS.has(toolId)) sources.push('/js/live-preview.js');
    if (PAGE_ORGANIZER_TOOLS.has(toolId)) sources.push('/js/page-organizer.js');
    if (TOOL_PREVIEW_MODULES[toolId]) sources = sources.concat(TOOL_PREVIEW_MODULES[toolId]);
    return Array.from(new Set(sources));
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
    var engineWork;
    if (DEDICATED_EDITOR_TOOLS.has(key)) {
      // Edit PDF and Background Remover have their own editor engines. Load
      // those first and avoid the generic BrowserTools/runtime bundle unless
      // the dedicated editor failed to register and the generic fallback is
      // needed by the standard preview UI.
      engineWork = preparePreview(key).catch(function () { return null; }).then(function () {
        var dedicatedReady = key === 'edit'
          ? !!(G.EditPdfPro && typeof G.EditPdfPro.mount === 'function')
          : !!(G.BgRemoverPro && typeof G.BgRemoverPro.mount === 'function');
        if (dedicatedReady) return { dedicated: true };
        return loadOrdered(engineModulesFor(key)).then(async function () {
          if (G.BrowserTools && typeof G.BrowserTools.prewarm === 'function') await G.BrowserTools.prewarm(key);
          return { dedicated: false };
        });
      });
    } else {
      engineWork = loadOrdered(engineModulesFor(key)).then(async function () {
        // Prewarm only dependencies explicitly declared by BrowserTools for
        // this tool. Other tools do not download each other's CDN libraries.
        if (G.BrowserTools && typeof G.BrowserTools.prewarm === 'function') {
          await G.BrowserTools.prewarm(key);
        }
        return { dedicated: false };
      });
    }
    var promise = engineWork.then(function (mode) {
      _engineReady.add(key);
      return { toolId: key, ready: true, dedicated: !!(mode && mode.dedicated) };
    }).catch(function (error) {
      _enginePromises.delete(key);
      _engineReady.delete(key);
      throw error;
    });
    _enginePromises.set(key, promise);
    return promise;
  }

  function shareDependency(key, globalName, factory) {
    if (globalName && G[globalName]) return Promise.resolve(G[globalName]);
    if (_dependencyPromises.has(key)) return _dependencyPromises.get(key);
    if (typeof factory !== 'function') return Promise.reject(new Error('A dependency loader is required for ' + key));

    var promise = Promise.resolve().then(factory).then(function (value) {
      var resolved = globalName ? (G[globalName] || value) : value;
      if (globalName && !resolved) throw new Error('Dependency did not expose ' + globalName + ': ' + key);
      return resolved;
    }).catch(function (error) {
      _dependencyPromises.delete(key);
      throw error;
    });
    _dependencyPromises.set(key, promise);
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
    getLoadedScripts: function () { return Array.from(_loaded); },
    shareDependency: shareDependency
  });
}(window));
