// RotatePdfApp v1.1 — Isolated Rotate PDF Tool boundary
// The ToolApp boundary remains independent, while RotateRuntime owns the
// actual processing path. This prevents the ToolApp interceptor from
// accidentally bypassing the shared RotateRuntime/WorkerPool architecture.
//
// Processing path:
//   ToolAppManager → RotatePdfApp.process()
//   → RotateRuntime.execute()
//   → RotateWorkerAdapter
//   → RuntimeWorkers / WorkerPool
//   → /workers/pdf-worker.js (OPS.rotate)
//
// No dedicated pdf-lib-worker is spawned here. There is no artificial
// file-size/page-count/time limit in this boundary; device/runtime pressure
// may reduce concurrency and therefore make processing slower.
(function (G) {
  'use strict';

  var TAG     = '[RotatePdfApp]';
  var TOOL_ID = 'rotate';

  function _log(message, data) {
    console.debug(TAG, message, data !== undefined ? data : '');
  }

  function _warn(message, data) {
    console.warn(TAG, message, data !== undefined ? data : '');
  }

  function _runtime() {
    if (!G.RotateRuntime || typeof G.RotateRuntime.execute !== 'function') {
      throw new Error('RotateRuntime is not available');
    }
    return G.RotateRuntime;
  }

  async function process(files, opts) {
    if (!files || !files[0]) throw new Error('No file provided');

    var file = files[0];
    var options = opts || {};
    _log('dispatching to RotateRuntime', {
      file: file.name,
      size: file.size,
      degrees: options.degrees || '0',
      pages: options.pages || 'all'
    });

    return _runtime().execute(file, options);
  }

  function mount() {
    _log('mounted — RotateRuntime is canonical');
  }

  function unmount() {
    if (G.RotateRuntime && typeof G.RotateRuntime.disable === 'function') {
      // Do not disable the runtime on unmount; the feature flag is global and
      // must not be changed merely because a tool page was navigated away from.
    }
    _log('unmounted');
  }

  function reset() {
    if (G.RotateRuntime && typeof G.RotateRuntime.recover === 'function') {
      try { G.RotateRuntime.recover(1); } catch (_) {}
    }
    _log('reset');
  }

  function recover(level) {
    if (G.RotateRuntime && typeof G.RotateRuntime.recover === 'function') {
      try { G.RotateRuntime.recover(level || 1); } catch (_) {}
    }
    _log('recover', level || 1);
  }

  function destroy() {
    if (G.RotateRuntime && typeof G.RotateRuntime.recover === 'function') {
      try { G.RotateRuntime.recover(1); } catch (_) {}
    }
    _log('destroy');
  }

  function getState() {
    if (G.RotateRuntime && typeof G.RotateRuntime.getState === 'function') {
      try { return G.RotateRuntime.getState(); } catch (_) {}
    }
    return { runtime: 'unavailable' };
  }

  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available');
      return;
    }

    G.ToolAppManager.registerTool(TOOL_ID, function () {
      return {
        process: process,
        mount: mount,
        unmount: unmount,
        reset: reset,
        recover: recover,
        destroy: destroy,
        getState: getState
      };
    });

    _log('registered');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register);
  } else {
    _register();
  }

  _log('v1.1 ready');
}(window));
