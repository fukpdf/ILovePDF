// Page Numbers ToolApp v2.0 — canonical isolated runtime boundary
(function (G) {
  'use strict';
  if (G.PageNumbersApp) return;
  var TOOL_ID = 'page-numbers';
  function runtime() {
    if (!G.PageNumbersRuntime || typeof G.PageNumbersRuntime.execute !== 'function') throw new Error('PageNumbersRuntime is unavailable');
    return G.PageNumbersRuntime;
  }
  function cancel() { try { if (runtime().cancelActive) runtime().cancelActive('lifecycle-cancel'); } catch (_) {} }
  function process(files, opts) { if (!files || !files[0]) throw new Error('No file provided'); return runtime().execute(files[0], opts || {}); }
  function mount() {}
  function unmount() { cancel(); }
  function reset() { cancel(); }
  function recover() { cancel(); }
  function destroy() { cancel(); }
  function getState() { try { return runtime().getDiagnostics ? runtime().getDiagnostics() : {}; } catch (_) { return {}; } }
  function register() {
    if (!G.ToolAppManager || typeof G.ToolAppManager.registerTool !== 'function') return;
    G.ToolAppManager.registerTool(TOOL_ID, function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register);
  else register();
  G.PageNumbersApp = { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
}(window));
