// MergePdfApp v1.1 — canonical ToolApp boundary
// Processing path:
// ToolAppManager → MergeRuntime.execute()
// → MergeWorkerAdapter → RuntimeWorkers → /workers/pdf-worker.js (OPS.merge)
//
// This boundary contains no alternate processor and no artificial execution limit.
(function (G) {
  'use strict';

  var TAG = '[MergePdfApp]';
  var TOOL_ID = 'merge';

  function _runtime() {
    if (!G.MergeRuntime || typeof G.MergeRuntime.execute !== 'function') {
      throw new Error('MergeRuntime is not available');
    }
    return G.MergeRuntime;
  }

  async function process(files, opts) {
    if (!files || !files.length) throw new Error('No files provided');
    var list = Array.from(files);
    console.debug(TAG, 'dispatching to MergeRuntime', {
      files: list.length,
      totalBytes: list.reduce(function (sum, file) { return sum + (file.size || 0); }, 0)
    });
    return _runtime().execute(list, opts || {});
  }

  function mount() { console.debug(TAG, 'mounted — MergeRuntime is canonical'); }

  function _cancel(reason) {
    if (G.MergeRuntime && typeof G.MergeRuntime.cancelActive === 'function') {
      try { return G.MergeRuntime.cancelActive(reason); } catch (_) {}
    }
    return false;
  }

  function unmount() { _cancel('tool-unmount'); }
  function reset() { _cancel('tool-reset'); }
  function recover(level) { _cancel('tool-recover-' + (level || 1)); }
  function destroy() { _cancel('tool-destroy'); }

  function getState() {
    if (G.MergeRuntime && typeof G.MergeRuntime.getDiagnostics === 'function') {
      try { return G.MergeRuntime.getDiagnostics(); } catch (_) {}
    }
    return { runtime: 'unavailable' };
  }

  function _register() {
    if (!G.ToolAppManager) {
      console.warn(TAG, 'ToolAppManager not available');
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
    console.debug(TAG, 'registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();
}(window));
