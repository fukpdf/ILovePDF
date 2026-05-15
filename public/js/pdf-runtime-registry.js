// PdfRuntimeRegistry v1.0 — Unified routing layer for factory-generated PDF runtimes.
//
// DESIGN:
//   Previous approach (merge + rotate): each runtime patched BrowserTools.process in a
//   chain. Every new tool added another link. Fragile ordering, growing boilerplate.
//
//   This approach: ONE additional patch installed AFTER all existing runtime patches.
//   Registry saves the current BrowserTools.process (already merge+rotate patched) as
//   _origProcess, then installs a single dispatch table.
//
//   - 'merge', 'rotate': NOT registered here. Falls through to _origProcess (the
//     existing chain handles them unchanged).
//   - New tools (split, organize, page-numbers, watermark, protect, unlock): registered
//     via register(). Each gets the full runtime path with auto-fallback to _origProcess.
//
// Load order requirement:
//   browser-tools.js → merge-worker-adapter.js → merge-runtime.js →
//   rotate-worker-adapter.js → rotate-runtime.js →
//   pdf-runtime-registry.js  ← (this file)
//   pdf-worker-runtime-factory.js → per-tool runtime files
//
// Feature flag per tool: window.RUNTIME_<TOOL>_ENABLED (managed by each tool runtime).
// Registry itself has no global flag — disabling per tool disables that tool's runtime.
//
// Exposed as: window.PdfRuntimeRegistry
(function () {
  'use strict';

  if (window.PdfRuntimeRegistry) return;

  var LOG = '[PRR]';

  // ── Route table: toolId → { execute: fn, isEnabled: fn } ──────────────────
  var _registry     = {};
  var _origProcess  = null;  // saved once, never overwritten
  var _patchApplied = false;

  // ── Hide callbacks — broadcast to all registered tool runtimes ─────────────
  // Each createPdfToolRuntime() registers one callback here. The registry
  // installs ONE LifecycleManager + pagehide listener that broadcasts to all.
  var _hideCallbacks = [];

  // ── Register a tool handler ────────────────────────────────────────────────
  // toolId:      BrowserTools.process toolId string (e.g. 'split')
  // executeFn:   async function(files[], opts) → { blob, filename }
  // isEnabledFn: optional function() → bool (default: always true)
  //              When false, registry skips the registered handler and falls
  //              through to _origProcess (legacy chain). This lets a feature
  //              flag short-circuit at the registry level without going into
  //              execute() at all.
  function register(toolId, executeFn, isEnabledFn) {
    _registry[toolId] = {
      execute:   executeFn,
      isEnabled: typeof isEnabledFn === 'function' ? isEnabledFn : function () { return true; },
    };
    console.debug(LOG, 'registered handler for toolId:', toolId);
  }

  // ── Unregister (testing / hot-swap) ───────────────────────────────────────
  function unregister(toolId) {
    delete _registry[toolId];
    console.debug(LOG, 'unregistered handler for toolId:', toolId);
  }

  // ── Expose the pre-registry origProcess ───────────────────────────────────
  // Tool runtimes use this for their legacy fallback path. It points to the
  // rotate-patched process (which chains down to merge-patched → original).
  function getOrigProcess() {
    return _origProcess;
  }

  // ── Single BrowserTools.process patch ─────────────────────────────────────
  // Idempotent — safe to call multiple times.
  function _patchBrowserTools() {
    if (!window.BrowserTools || _patchApplied) return;
    _patchApplied = true;

    // Save the current process (already patched by merge+rotate runtimes).
    _origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    // Expose on BrowserTools for emergency DevTools bypass. Use a distinct key
    // to avoid clobbering the _origProcess key that merge-runtime.js set.
    window.BrowserTools._origRegistryProcess = _origProcess;

    window.BrowserTools.process = function (toolId, files, options) {
      var entry = _registry[toolId];

      // Unregistered tool OR runtime disabled for this tool:
      // fall through to the existing chain (merge → rotate → original).
      if (!entry || !entry.isEnabled()) {
        return _origProcess(toolId, files, options);
      }

      // Normalise files to a real Array so adapters can use Array methods.
      var filesArr = Array.isArray(files)
        ? files
        : (files ? Array.from(files) : []);

      return entry.execute(filesArr, options || {});
    };

    console.debug(LOG, 'BrowserTools.process patched — unified registry routing active');
  }

  // ── Apply patch with safety retry ─────────────────────────────────────────
  // pdf-runtime-registry.js loads after browser-tools.js + merge/rotate runtimes,
  // so BrowserTools is available synchronously. The retry loop is a safety net.
  (function _applyPatch() {
    if (window.BrowserTools) {
      _patchBrowserTools();
    } else {
      var retries = 0;
      var tid = setInterval(function () {
        retries++;
        if (window.BrowserTools) {
          clearInterval(tid);
          _patchBrowserTools();
        } else if (retries > 20) {
          clearInterval(tid);
          console.warn(LOG, 'BrowserTools not found after 20 attempts — patch skipped');
        }
      }, 100);
      if (window.TimerRegistry) window.TimerRegistry.registerInterval('prr-patch-retry', tid);
    }
  })();

  // ── Lifecycle: single hide listener, broadcasts to all registered runtimes ─
  // Each tool runtime calls PdfRuntimeRegistry.onHide(cb) to register its
  // cancellation logic. The registry installs ONE listener that fans out.
  function onHide(cb) {
    if (typeof cb === 'function') _hideCallbacks.push(cb);
  }

  function _broadcastHide(reason) {
    _hideCallbacks.forEach(function (cb) { try { cb(reason); } catch (_) {} });
  }

  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      _broadcastHide(reason);
    });
  }

  window.addEventListener('pagehide', function () {
    _broadcastHide('pagehide');
  }, { passive: true });

  // ── Public API ─────────────────────────────────────────────────────────────
  window.PdfRuntimeRegistry = {
    register:        register,
    unregister:      unregister,
    getOrigProcess:  getOrigProcess,
    onHide:          onHide,
    isPatchApplied:  function () { return _patchApplied; },
    getRegistry:     function () {
      var out = {};
      Object.keys(_registry).forEach(function (k) { out[k] = { isEnabled: _registry[k].isEnabled() }; });
      return out;
    },
  };

  console.debug(LOG, 'PdfRuntimeRegistry ready — waiting for tool registrations');
}());
