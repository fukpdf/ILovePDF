// Phase 1 Stabilization Bridge — v1.0
// Centralizes cross-cutting concerns: ObjectURL normalization, ResizeObserver
// lifecycle, streaming preparation markers, and future runtime integration hooks.
//
// DESIGN PRINCIPLE: This file wraps and bridges existing systems — it never
// replaces them. All existing code continues to work unchanged. This layer
// makes the platform's resource lifecycle auditable, reversible, and testable.
//
// Exposed as: window.P1 (Phase1 bridge)
//
// Future centralized runtime integration points are marked with:
//   // [FUTURE: <SystemName>] <description>
(function () {
  'use strict';

  if (window.P1) return; // idempotent

  // ── 1. Normalized ObjectURL helper ─────────────────────────────────────────
  // All new code should use P1.createUrl / P1.revokeUrl instead of calling
  // URL.createObjectURL directly. Routes through ObjectURLRegistry when present
  // so bulk revocation (memory pressure, pagehide) works automatically.
  //
  // [FUTURE: StreamEngine] Replace blob creation with OPFS byte-range streaming
  // to avoid loading entire output files into JS heap.

  function createUrl(blob, owner) {
    if (window.ObjectURLRegistry) return window.ObjectURLRegistry.create(blob, owner || 'p1');
    return URL.createObjectURL(blob);
  }

  function revokeUrl(url) {
    if (!url) return;
    if (window.ObjectURLRegistry) { window.ObjectURLRegistry.revoke(url); return; }
    try { URL.revokeObjectURL(url); } catch (_) {}
  }

  function revokeOwner(owner) {
    if (window.ObjectURLRegistry) window.ObjectURLRegistry.revokeOwner(owner);
  }

  // ── 2. Safe ResizeObserver wrapper ─────────────────────────────────────────
  // Prevents observer-loop DOMExceptions ("ResizeObserver loop limit exceeded")
  // by debouncing callbacks and catching the loop error silently.
  //
  // Usage: const ro = P1.createResizeObserver(callback, { debounce: 50 });
  //        ro.observe(el);  ro.disconnect();
  //
  // [FUTURE: ResponsiveRuntime] Centralise all resize handlers here so a single
  // RAF loop serves every component, eliminating per-component observer instances.

  function createResizeObserver(callback, opts) {
    if (typeof ResizeObserver === 'undefined') {
      return { observe: function() {}, unobserve: function() {}, disconnect: function() {} };
    }
    opts = opts || {};
    var debounceMs = opts.debounce != null ? opts.debounce : 50;
    var _timer = null;

    var ro = new ResizeObserver(function (entries) {
      if (debounceMs > 0) {
        clearTimeout(_timer);
        _timer = setTimeout(function () {
          try { callback(entries); } catch (e) { console.warn('[P1.ResizeObserver]', e); }
        }, debounceMs);
      } else {
        try { callback(entries); } catch (e) { console.warn('[P1.ResizeObserver]', e); }
      }
    });

    // Intercept disconnect to also clear any pending debounce timer.
    var _origDisconnect = ro.disconnect.bind(ro);
    ro.disconnect = function () {
      clearTimeout(_timer);
      _origDisconnect();
    };

    return ro;
  }

  // ── 3. Timer registration helper ───────────────────────────────────────────
  // Thin wrapper that creates a timer AND registers it with TimerRegistry
  // in one call, so callers cannot accidentally forget to register.
  //
  // [FUTURE: CentralRuntime] CentralRuntime will manage all async tasks;
  // these timers are the migration surface — replace calls gradually.

  function setTrackedInterval(owner, fn, ms) {
    var id = setInterval(fn, ms);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval(owner, id);
    return id;
  }

  function setTrackedTimeout(owner, fn, ms) {
    var id = setTimeout(fn, ms);
    if (window.TimerRegistry) window.TimerRegistry.registerTimeout(owner, id);
    return id;
  }

  function clearTrackedInterval(owner, id) {
    clearInterval(id);
    // TimerRegistry will clean up on pagehide; no explicit remove API needed.
  }

  // ── 4. Streaming preparation markers ──────────────────────────────────────
  // Documents all current full-file-load patterns for future StreamEngine migration.
  // Call P1.streamMarker(label) at each site to make them discoverable.
  //
  // [FUTURE: StreamEngine] Replace each marked site with byte-range OPFS streaming:
  //   - OPFS byte-range parser (phase32)
  //   - RollingWindow page streaming (giant-file-routing)
  //   - SurvivalMode for huge files (phase32)

  var _streamMarkers = [];

  function streamMarker(label, opts) {
    _streamMarkers.push({ label: label, opts: opts || {}, ts: Date.now() });
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('stream-marker:' + label); } catch (_) {}
    }
  }

  function getStreamMarkers() { return _streamMarkers.slice(); }

  // ── 5. Worker integration point ────────────────────────────────────────────
  // [FUTURE: WorkerOrchestrator] Replace direct WorkerPool.run() calls with
  // WorkerOrchestrator.dispatch() which adds: priority routing, cross-tab
  // coordination, telemetry, and graceful degradation to main-thread fallback.
  //
  // For now, expose a no-op shim so future code can call P1.dispatchWorker()
  // and the orchestrator can be wired in without touching call sites.

  function dispatchWorker(workerUrl, task, opts) {
    // [FUTURE: WorkerOrchestrator] replace body with orchestrator call
    if (window.WorkerPool) return window.WorkerPool.run(workerUrl, task, opts && opts.priority);
    return Promise.reject(new Error('WorkerPool not available'));
  }

  // ── 6. IndexedDB / OPFS readiness probe ───────────────────────────────────
  // [FUTURE: IndexedDB/OPFS] These checks will gate the StreamEngine:
  //   - IndexedDB available → use IDB-backed result caching (idb-cache.js)
  //   - OPFS available → use OPFS byte-range streaming for >50 MB files

  var _caps = null;
  function capabilities() {
    if (_caps) return _caps;
    _caps = {
      idb:  typeof indexedDB !== 'undefined',
      opfs: typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function',
      serviceWorker: 'serviceWorker' in navigator,
      broadcastChannel: typeof BroadcastChannel !== 'undefined',
      webGpu: !!(navigator && navigator.gpu),
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    };
    return _caps;
  }

  // ── 7. Memory pressure bridge ──────────────────────────────────────────────
  // Subscribes to MemPressure events and coordinates ObjectURLRegistry cleanup.
  // [FUTURE: TelemetryEngine] Forward pressure events to telemetry pipeline.

  function _onMemoryPressure() {
    // Revoke anonymous URLs first (lowest business value, highest count)
    if (window.ObjectURLRegistry) {
      try { window.ObjectURLRegistry.revokeOwner('anonymous'); } catch (_) {}
      try { window.ObjectURLRegistry.revokeOwner('status-download'); } catch (_) {}
    }
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('p1-memory-pressure-cleanup'); } catch (_) {}
    }
  }

  if (window.MemPressure && window.MemPressure.onPressure) {
    window.MemPressure.onPressure(_onMemoryPressure);
  }

  // Hook into LifecycleManager hide events for additional cleanup.
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      // On pagehide/freeze: revoke result URLs since user is navigating away.
      if (reason === 'pagehide' || reason === 'pagehide-bfcache') {
        if (window.ObjectURLRegistry) {
          try { window.ObjectURLRegistry.revokeOwner('status-download'); } catch (_) {}
          try { window.ObjectURLRegistry.revokeOwner('trigger-download'); } catch (_) {}
          try { window.ObjectURLRegistry.revokeOwner('hydrated-result'); } catch (_) {}
          try { window.ObjectURLRegistry.revokeOwner('pro-editor-result'); } catch (_) {}
          try { window.ObjectURLRegistry.revokeOwner('bg-remover-result'); } catch (_) {}
        }
      }
    });
  }

  // ── 8. Diagnostics ────────────────────────────────────────────────────────

  function diagnostics() {
    return {
      urlRegistry: window.ObjectURLRegistry ? window.ObjectURLRegistry.stats() : null,
      timerRegistry: window.TimerRegistry ? window.TimerRegistry.stats() : null,
      streamMarkers: _streamMarkers.length,
      capabilities: capabilities(),
      workerPool: window.WorkerPool ? window.WorkerPool.getStats() : null,
      memPressure: window.MemPressure ? window.MemPressure.tier() : null,
    };
  }

  // ── Expose public API ─────────────────────────────────────────────────────

  window.P1 = {
    // ObjectURL lifecycle
    createUrl: createUrl,
    revokeUrl: revokeUrl,
    revokeOwner: revokeOwner,

    // Safe ResizeObserver
    createResizeObserver: createResizeObserver,

    // Tracked timers
    setTrackedInterval: setTrackedInterval,
    setTrackedTimeout: setTrackedTimeout,
    clearTrackedInterval: clearTrackedInterval,

    // Streaming preparation
    streamMarker: streamMarker,
    getStreamMarkers: getStreamMarkers,

    // Worker dispatch (future migration surface)
    dispatchWorker: dispatchWorker,

    // Environment
    capabilities: capabilities,

    // Diagnostics
    diagnostics: diagnostics,
  };

  console.debug('[P1] Phase 1 stabilization bridge ready');
}());
