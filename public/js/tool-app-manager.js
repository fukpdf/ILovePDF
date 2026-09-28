// ToolAppManager v1.1 — Phase 5 lifecycle/isolation hardening
// Manages isolated ToolApp lifecycle. Each registered app:
//   — gets its own mount/unmount/reset/recover lifecycle
//   — owns processing only for its toolId
//   — other tools always continue through the preserved base processor
//
// The interceptor layer is deliberately centralized so tools can be mounted
// or removed in any order without leaving stale wrappers behind.
(function (G) {
  'use strict';
  if (G.ToolAppManager) return;

  var LOG = '[TAM]';
  function _log(msg, d)  { console.debug(LOG, msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn(LOG, msg, d !== undefined ? d : ''); }
  function _safe(fn) { try { return fn(); } catch (_) { return null; } }

  var STATE = {
    REGISTERED: 'REGISTERED',
    MOUNTING: 'MOUNTING',
    MOUNTED: 'MOUNTED',
    UNMOUNTING: 'UNMOUNTING',
    ERROR: 'ERROR'
  };

  // Map<toolId, Entry>
  var _registry = {};

  // Map<toolId, instance> for mounted ToolApps.
  var _interceptors = {};

  // The processor that existed before ToolAppManager installed its dispatcher.
  // It may already be wrapped by AdvancedEngine or another approved platform
  // layer, so it is never replaced by a tool-specific wrapper.
  var _baseProcess = null;
  var _dispatcherInstalled = false;

  // ── Register ───────────────────────────────────────────────────────────────
  function registerTool(toolId, factory) {
    if (!toolId || typeof factory !== 'function') {
      _warn('registerTool: invalid args', { toolId: toolId });
      return;
    }
    if (_registry[toolId]) _warn('registerTool: replacing existing entry for', toolId);
    _registry[toolId] = {
      factory: factory,
      instance: null,
      state: STATE.REGISTERED,
      error: null
    };
    _log('registered', toolId);
    _safe(function () {
      if (G.SharedCore) G.SharedCore.events.emit('tool:registered', { toolId: toolId });
    });
  }

  // ── Shared processing dispatcher ─────────────────────────────────────────
  function _dispatch(id, files, opts) {
    var instance = _interceptors[id];
    if (instance && typeof instance.process === 'function') {
      return instance.process(files, opts);
    }
    if (typeof _baseProcess === 'function') {
      return _baseProcess(id, files, opts);
    }
    throw new Error('BrowserTools.process is unavailable');
  }

  function _installDispatcher() {
    if (_dispatcherInstalled || !G.BrowserTools || typeof G.BrowserTools.process !== 'function') {
      return;
    }

    _baseProcess = G.BrowserTools.process;
    G.BrowserTools.process = _dispatch;

    // Preserve the AdvancedEngine sentinel so the existing platform wrapper
    // does not attempt to wrap this dispatcher a second time.
    if (_baseProcess.__advEngineV30) {
      G.BrowserTools.process.__advEngineV30 = _baseProcess.__advEngineV30;
    }

    _dispatcherInstalled = true;
    _log('shared process dispatcher installed');
  }

  function _removeDispatcherIfIdle() {
    if (Object.keys(_interceptors).length !== 0) return;
    if (G.BrowserTools && _dispatcherInstalled && _baseProcess) {
      G.BrowserTools.process = _baseProcess;
    }
    _baseProcess = null;
    _dispatcherInstalled = false;
    _log('shared process dispatcher removed');
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  function mountTool(toolId) {
    var e = _registry[toolId];
    if (!e) { _warn('mountTool: not registered', toolId); return; }
    if (e.state === STATE.MOUNTED) {
      _log('mountTool: already mounted', toolId);
      return;
    }

    e.state = STATE.MOUNTING;
    e.error = null;
    try {
      _installDispatcher();
      e.instance = e.factory();

      if (!e.instance || typeof e.instance.process !== 'function') {
        throw new Error('ToolApp must expose process(files, opts)');
      }

      if (typeof e.instance.mount === 'function') e.instance.mount();
      _interceptors[toolId] = e.instance;
      e.state = STATE.MOUNTED;

      _log('mounted', toolId);
      _safe(function () {
        if (G.SharedCore) G.SharedCore.events.emit('tool:mounted', { toolId: toolId });
      });
    } catch (err) {
      e.state = STATE.ERROR;
      e.error = err;
      e.instance = null;
      delete _interceptors[toolId];
      _removeDispatcherIfIdle();
      _warn('mountTool error', { toolId: toolId, err: err && err.message });
    }
  }

  // ── Unmount ────────────────────────────────────────────────────────────────
  function unmountTool(toolId) {
    var e = _registry[toolId];
    if (!e || e.state !== STATE.MOUNTED) return;

    e.state = STATE.UNMOUNTING;

    // Keep the instance alive until its unmount hook completes. Tool-specific
    // cleanup (workers, listeners, object URLs, tokens) therefore has access
    // to the same instance that was mounted.
    _safe(function () {
      if (e.instance && typeof e.instance.unmount === 'function') e.instance.unmount();
    });

    delete _interceptors[toolId];
    e.instance = null;
    e.state = STATE.REGISTERED;
    _removeDispatcherIfIdle();

    _log('unmounted', toolId);
    _safe(function () {
      if (G.SharedCore) G.SharedCore.events.emit('tool:unmounted', { toolId: toolId });
    });
  }

  // ── Destroy ────────────────────────────────────────────────────────────────
  function destroyTool(toolId) {
    var e = _registry[toolId];
    if (!e) return;

    var instance = e.instance;

    // Destroy must run even though unmount clears the registry reference.
    // Capture the instance first so destroy is never silently skipped.
    if (e.state === STATE.MOUNTED) {
      e.state = STATE.UNMOUNTING;
      _safe(function () {
        if (instance && typeof instance.unmount === 'function') instance.unmount();
      });
      delete _interceptors[toolId];
      e.instance = null;
      e.state = STATE.REGISTERED;
      _removeDispatcherIfIdle();
      _safe(function () {
        if (instance && typeof instance.destroy === 'function') instance.destroy();
      });
    } else {
      _safe(function () {
        if (instance && typeof instance.destroy === 'function') instance.destroy();
      });
    }

    delete _registry[toolId];
    _log('destroyed', toolId);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  function resetTool(toolId) {
    var e = _registry[toolId];
    if (!e || !e.instance) return;
    _safe(function () {
      if (typeof e.instance.reset === 'function') e.instance.reset();
    });
    _log('reset', toolId);
  }

  // ── Recover ────────────────────────────────────────────────────────────────
  function recoverTool(toolId, level) {
    var e = _registry[toolId];
    if (!e) {
      mountTool(toolId);
      return;
    }
    if (e.state !== STATE.MOUNTED) {
      if (e.state === STATE.ERROR) {
        e.instance = null;
        e.state = STATE.REGISTERED;
      }
      mountTool(toolId);
      return;
    }
    _safe(function () {
      if (e.instance && typeof e.instance.recover === 'function') {
        e.instance.recover(level || 1);
      }
    });
    _log('recover', { toolId: toolId, level: level || 1 });
  }

  // ── Get state ──────────────────────────────────────────────────────────────
  function getToolState(toolId) {
    var e = _registry[toolId];
    if (!e) return { state: 'UNREGISTERED' };
    return {
      state: e.state,
      hasInstance: !!e.instance,
      error: e.error ? (e.error.message || String(e.error)) : null,
      runtime: _safe(function () {
        return e.instance && typeof e.instance.getState === 'function'
          ? e.instance.getState()
          : null;
      }),
    };
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
    mountTool: mountTool,
    unmountTool: unmountTool,
    destroyTool: destroyTool,
    resetTool: resetTool,
    recoverTool: recoverTool,
    getToolState: getToolState,
    getRegistry: function () { return Object.keys(_registry); },
  };

  _log('v1.1 ready');
}(window));
