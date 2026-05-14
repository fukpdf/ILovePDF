// Runtime Tool Adapters v1.0 — Phase 2 (T029)
// Factory that creates runtime-aware adapter layers for tool execution.
// Tools BEGIN routing through the runtime WITHOUT being fully rewritten.
//
// This is the safe bridge: existing tool code calls the adapter surface;
// the adapter routes through RuntimeScheduler, RuntimeCancellation,
// RuntimeProgress, RuntimeQueue, and RuntimeTelemetry automatically.
//
// DESIGN: Each tool gets an adapter with:
//   - Scoped cancellation token (auto-cancels on navigation)
//   - Progress lifecycle tracking
//   - Memory tier awareness before starting
//   - Retry safety via RetryOrchestrator
//   - Telemetry span around the entire tool run
//   - Cleanup hooks on completion/failure
//
// HOW TO USE (in tool code):
//   const adapter = RuntimeAdapters.forTool('merge', { priority: 'normal' });
//   const result  = await adapter.run(async (progress) => { ... });
//   // adapter.cancel() to abort
//
// Integrates: RuntimeScheduler, RuntimeCancellation, RuntimeProgress,
//             RuntimeMemory, RuntimeTelemetry, RuntimeEventBus, RetryOrchestrator
//
// [FUTURE: ToolRegistry] Each adapter will register itself in a ToolRegistry
// so the runtime can enumerate, pause, or prioritize specific tools centrally.
//
// Exposed as: window.RuntimeAdapters
(function () {
  'use strict';

  if (window.RuntimeAdapters) return;

  var LOG = '[RTA]';

  // ── Active adapters ───────────────────────────────────────────────────────
  var _active = new Map(); // toolId → adapter

  // ── Adapter factory ───────────────────────────────────────────────────────
  // opts:
  //   priority?  'high'|'normal'|'low'  (default 'normal')
  //   type?      task type for scheduler (default 'render')
  //   retries?   max retry attempts (default 2)
  //   timeoutMs? per-run timeout (default 120 000 ms)
  //   scope?     cancellation scope (default toolId)
  function forTool(toolId, opts) {
    opts = opts || {};
    var priority  = opts.priority  || 'normal';
    var taskType  = opts.type      || 'render';
    var maxRetries = typeof opts.retries === 'number' ? opts.retries : 2;
    var timeoutMs  = opts.timeoutMs || 120000;
    var scope      = opts.scope    || toolId;

    // Create a scoped cancellation token
    var token = window.RuntimeCancellation
      ? window.RuntimeCancellation.createScopedToken(scope, {
          label:     toolId + '-adapter',
          timeoutMs: timeoutMs,
        })
      : null;

    var _spanId   = null;
    var _taskId   = null;
    var _running  = false;
    var _cancelled = false;

    // ── run(fn) ───────────────────────────────────────────────────────────
    // fn receives a progressReporter: fn(pct, message?)
    // Returns the result of fn, or throws on error/cancel.
    async function run(fn, runOpts) {
      runOpts = runOpts || {};

      if (_cancelled || (token && token.cancelled)) {
        return Promise.reject(new Error('adapter-cancelled'));
      }

      // Memory safety gate
      if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) {
        return Promise.reject(new Error('runtime-emergency-block'));
      }

      _running = true;

      // Telemetry span
      if (window.RuntimeTelemetry) {
        _spanId = window.RuntimeTelemetry.startSpan(toolId, { type: taskType });
      }

      // Warn if adapter already active for this tool
      if (_active.has(toolId)) {
        console.warn(LOG, 'concurrent adapter for same tool:', toolId, '— possible race condition');
      }
      _active.set(toolId, adapter);

      // Retry-wrapped execution through RuntimeScheduler
      var label = toolId + ':' + taskType;

      var wrapped = window.RetryOrchestrator
        ? window.RetryOrchestrator.wrap(function (attempt, signal) {
            if (token && token.cancelled) return Promise.reject(new Error('cancelled'));
            return _executeOnce(fn, signal, runOpts.stages);
          }, {
            label:       label,
            maxAttempts: maxRetries + 1,
            baseDelayMs: 800,
            maxDelayMs:  8000,
            timeoutMs:   timeoutMs,
            signal:      token ? token.signal : null,
            noRetryOn: function (err) {
              var m = err && err.message || '';
              return m.includes('cancel') || m.includes('emergency') || m.includes('abort');
            },
          })
        : function () { return _executeOnce(fn, null, runOpts.stages); };

      try {
        var result = await wrapped();
        _onComplete('ok');
        return result;
      } catch (err) {
        _onComplete(err && err.message || 'error');
        throw err;
      }
    }

    async function _executeOnce(fn, abortSignal, stages) {
      // RuntimeScheduler: acquire slot
      if (window.RuntimeScheduler) {
        return window.RuntimeScheduler.run(function (progressFn) {
          // Wrap progressFn so it also advances RuntimeProgress
          var reporter = function (pct, msg) {
            if (_taskId !== null && window.RuntimeProgress) {
              try { window.RuntimeProgress.report(_taskId, 0, pct, msg); } catch (_) {}
            }
            progressFn(pct, msg);
          };
          return fn(reporter);
        }, { type: taskType, priority: priority, label: toolId, token: token });
      }
      // Fallback: no scheduler
      var progress = window.RuntimeProgress
        ? window.RuntimeProgress.createSimpleTask(toolId, token)
        : null;
      _taskId = progress ? progress.taskId : null;
      try {
        var res = await fn(function (pct, msg) { if (progress) progress.report(pct, msg); });
        if (progress) progress.complete();
        return res;
      } catch (e) {
        if (progress) progress.fail(e && e.message);
        throw e;
      }
    }

    function _onComplete(outcome) {
      _running = false;
      _active.delete(toolId);

      if (_spanId !== null && window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.endSpan(_spanId, outcome); } catch (_) {}
        _spanId = null;
      }

      // Notify AdaptiveDegradation of tool completion (for mobile run-count tracking)
      if (outcome === 'ok' && window.AdaptiveDegradation && window.AdaptiveDegradation.recordToolRun) {
        try { window.AdaptiveDegradation.recordToolRun(); } catch (_) {}
      }
    }

    // ── cancel() ─────────────────────────────────────────────────────────
    function cancel(reason) {
      _cancelled = true;
      _running   = false;
      _active.delete(toolId);
      if (token && !token.cancelled) token.cancel(reason || 'user-cancel');
      if (_spanId !== null && window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.endSpan(_spanId, 'cancelled'); } catch (_) {}
        _spanId = null;
      }
    }

    // ── isReady() ─────────────────────────────────────────────────────────
    function isReady() {
      if (_cancelled || (token && token.cancelled)) return false;
      if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) return false;
      if (window.LifecycleManager && window.LifecycleManager.isPaused()) return false;
      return true;
    }

    // ── Bridge helpers ────────────────────────────────────────────────────
    // Queue path: route to RuntimeQueue instead of RuntimeScheduler
    async function runQueued(tool, files, options, uiAdaptor) {
      if (!isReady()) return Promise.reject(new Error('adapter-not-ready'));
      return window.RuntimeQueue
        ? window.RuntimeQueue.submit(tool, files, options, uiAdaptor, {
            label:     toolId,
            token:     token,
            priority:  priority,
          })
        : (window.QueueClient
            ? window.QueueClient.tryProcess(tool, files, options, uiAdaptor)
            : Promise.resolve(false));
    }

    var adapter = {
      toolId:    toolId,
      token:     token,
      run:       run,
      runQueued: runQueued,
      cancel:    cancel,
      isReady:   isReady,
      isRunning: function () { return _running; },
      isCancelled: function () { return _cancelled || (token && token.cancelled); },
    };

    return adapter;
  }

  // ── Cancel all active tool adapters ───────────────────────────────────────
  function cancelAll(reason) {
    _active.forEach(function (adapter) {
      try { adapter.cancel(reason || 'global-cancel'); } catch (_) {}
    });
    _active.clear();
  }

  // ── Batch UI adaptor builder ───────────────────────────────────────────────
  // Creates a standard UI adaptor object from the existing tool-page.js globals.
  // This is the bridge between the runtime and the legacy UI surface.
  function buildUiAdaptor() {
    return {
      showProcessing: function (title, msg) {
        if (window.showProcessing) try { window.showProcessing(title, msg); } catch (_) {}
      },
      hideProcessing: function () {
        if (window.hideProcessing) try { window.hideProcessing(); } catch (_) {}
      },
      showStatus: function (type, title, message, url, filename) {
        if (window.showStatus) try { window.showStatus(type, title, message, url, filename); } catch (_) {}
      },
      triggerDownload: function (blob, filename) {
        if (window.DownloadManager) {
          try { window.DownloadManager.trigger(blob, filename); return; } catch (_) {}
        }
        if (window.triggerDownload) try { window.triggerDownload(blob, filename); } catch (_) {}
      },
    };
  }

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
  }, { passive: true });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var active = [];
    _active.forEach(function (a, id) { active.push({ toolId: id, running: a.isRunning() }); });
    return { activeAdapters: active.length, adapters: active };
  }

  window.RuntimeAdapters = {
    forTool:        forTool,
    cancelAll:      cancelAll,
    buildUiAdaptor: buildUiAdaptor,
    getStats:       getStats,
  };

  console.debug('[RuntimeAdapters] ready — T029 tool adapters active');
}());
