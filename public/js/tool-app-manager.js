// ToolAppManager v1.0 — Phase 2 Microfrontend Architecture
// Manages isolated ToolApp lifecycle. Each registered app:
//   — gets its own mount/unmount/reset/recover lifecycle
//   — installs a BrowserTools.process interceptor for its toolId ONLY
//   — all other tools continue through the unmodified chain
//
// ADDITIVE ONLY — does not modify any existing file.
// window.ToolAppManager exposed globally.
(function (G) {
  'use strict';
  if (G.ToolAppManager) return;

  var LOG = '[TAM]';
  function _log(msg, d)  { console.debug(LOG, msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn(LOG, msg, d !== undefined ? d : ''); }
  function _safe(fn) { try { return fn(); } catch (_) { return null; } }

  var STATE = { REGISTERED: 'REGISTERED', MOUNTING: 'MOUNTING', MOUNTED: 'MOUNTED', UNMOUNTING: 'UNMOUNTING', ERROR: 'ERROR' };

  // Map<toolId, Entry>
  var _registry = {};

  // Map<toolId, prevProcessFn> — used to unwind interceptors cleanly
  var _interceptors = {};

  // ── Register ───────────────────────────────────────────────────────────────
  function registerTool(toolId, factory) {
    if (!toolId || typeof factory !== 'function') {
      _warn('registerTool: invalid args', { toolId: toolId });
      return;
    }
    if (_registry[toolId]) _warn('registerTool: replacing existing entry for', toolId);
    _registry[toolId] = { factory: factory, instance: null, state: STATE.REGISTERED, error: null };
    _log('registered', toolId);
    _safe(function () { if (G.SharedCore) G.SharedCore.events.emit('tool:registered', { toolId: toolId }); });
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  function mountTool(toolId) {
    var e = _registry[toolId];
    if (!e) { _warn('mountTool: not registered', toolId); return; }
    if (e.state === STATE.MOUNTED) { _log('mountTool: already mounted', toolId); return; }

    e.state = STATE.MOUNTING;
    try {
      e.instance = e.factory();
      if (e.instance && typeof e.instance.mount === 'function') e.instance.mount();
      _installInterceptor(toolId, e.instance);
      e.state = STATE.MOUNTED;
      _log('mounted', toolId);
      _safe(function () { if (G.SharedCore) G.SharedCore.events.emit('tool:mounted', { toolId: toolId }); });
    } catch (err) {
      e.state = STATE.ERROR;
      e.error = err;
      _warn('mountTool error', { toolId: toolId, err: err && err.message });
    }
  }

  // ── Unmount ────────────────────────────────────────────────────────────────
  function unmountTool(toolId) {
    var e = _registry[toolId];
    if (!e || e.state !== STATE.MOUNTED) return;
    e.state = STATE.UNMOUNTING;
    _safe(function () { if (e.instance && typeof e.instance.unmount === 'function') e.instance.unmount(); });
    _removeInterceptor(toolId);
    e.instance = null;
    e.state = STATE.REGISTERED;
    _log('unmounted', toolId);
    _safe(function () { if (G.SharedCore) G.SharedCore.events.emit('tool:unmounted', { toolId: toolId }); });
  }

  // ── Destroy ────────────────────────────────────────────────────────────────
  function destroyTool(toolId) {
    unmountTool(toolId);
    _safe(function () {
      var e = _registry[toolId];
      if (e && e.instance && typeof e.instance.destroy === 'function') e.instance.destroy();
    });
    delete _registry[toolId];
    _log('destroyed', toolId);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  function resetTool(toolId) {
    var e = _registry[toolId];
    if (!e || !e.instance) return;
    _safe(function () { if (typeof e.instance.reset === 'function') e.instance.reset(); });
    _log('reset', toolId);
  }

  // ── Recover ────────────────────────────────────────────────────────────────
  function recoverTool(toolId, level) {
    var e = _registry[toolId];
    if (!e) { mountTool(toolId); return; }
    if (e.state !== STATE.MOUNTED) { unmountTool(toolId); mountTool(toolId); return; }
    _safe(function () { if (e.instance && typeof e.instance.recover === 'function') e.instance.recover(level || 1); });
    _log('recover', { toolId: toolId, level: level || 1 });
  }

  // ── Get state ──────────────────────────────────────────────────────────────
  function getToolState(toolId) {
    var e = _registry[toolId];
    if (!e) return { state: 'UNREGISTERED' };
    return {
      state:       e.state,
      hasInstance: !!e.instance,
      error:       e.error ? (e.error.message || String(e.error)) : null,
      runtime:     _safe(function () { return e.instance && typeof e.instance.getState === 'function' ? e.instance.getState() : null; }),
    };
  }

  // ── BrowserTools.process interception ─────────────────────────────────────
  // Wraps window.BrowserTools.process so that calls for 'toolId' are handled
  // by the ToolApp's process() method. All other toolIds pass through unmodified.
  // The chain after mounting for toolId='pdf-to-word':
  //   callers → PdfToWordApp.process (our wrapper)
  //             — if toolId != 'pdf-to-word' → prev wrapper (AdvancedEngine or original)
  function _installInterceptor(toolId, instance) {
    if (!G.BrowserTools || !instance || typeof instance.process !== 'function') {
      _warn('_installInterceptor: BrowserTools or instance.process missing for', toolId);
      return;
    }

    var prevProcess = G.BrowserTools.process;
    _interceptors[toolId] = prevProcess;

    G.BrowserTools.process = function (id, files, opts) {
      if (id === toolId) {
        return instance.process(files, opts);
      }
      return prevProcess(id, files, opts);
    };

    // Preserve AdvancedEngine sentinel so it doesn't re-wrap
    if (prevProcess && prevProcess.__advEngineV30) {
      G.BrowserTools.process.__advEngineV30 = prevProcess.__advEngineV30;
    }

    _log('interceptor installed for', toolId);
  }

  function _removeInterceptor(toolId) {
    var prev = _interceptors[toolId];
    if (!prev) return;
    if (G.BrowserTools) G.BrowserTools.process = prev;
    delete _interceptors[toolId];
    _log('interceptor removed for', toolId);
  }

  // ── Auto-mount on the current page's tool ─────────────────────────────────
  function _autoMount() {
    var toolId = G.SharedCore ? G.SharedCore.navigation.getToolId() : '';
    if (toolId && _registry[toolId]) {
      _log('auto-mounting', toolId);
      mountTool(toolId);
    }
  }

  // Runs after all deferred scripts have loaded (same DOMContentLoaded queue,
  // but ToolAppManager is loaded before tool-page.js so our listener fires first).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoMount);
  } else {
    _autoMount();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  G.ToolAppManager = {
    registerTool: registerTool,
    mountTool:    mountTool,
    unmountTool:  unmountTool,
    destroyTool:  destroyTool,
    resetTool:    resetTool,
    recoverTool:  recoverTool,
    getToolState: getToolState,
    getRegistry:  function () { return Object.keys(_registry); },
  };

  _log('v1.0 ready');
}(window));
