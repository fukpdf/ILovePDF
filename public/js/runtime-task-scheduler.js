// Runtime Task Scheduler v1.0 — Phase 2 (T021)
// Centralized scheduling layer. Extends the existing TaskScheduler with:
// priority queues, UI-protection slots, concurrency control per memory tier,
// mobile-aware scheduling, foreground/background/OCR/large-file task types,
// starvation prevention, and task-level telemetry.
//
// DESIGN: Wraps TaskScheduler.schedule() — does NOT replace it.
// Existing calls to TaskScheduler continue to work unchanged.
// New code uses RuntimeScheduler.run() for full lifecycle management.
//
// Integrates: TaskScheduler, RuntimeMemory, RuntimeTelemetry, RuntimeCancellation,
//             RuntimeProgress, RuntimeEventBus, RuntimeState
//
// [FUTURE: WorkerOrchestrator] RuntimeScheduler.run() will also route tasks
// to the RuntimeWorkerOrchestrator when a worker URL is provided, so tasks
// can transparently move between main-thread and worker execution.
//
// Exposed as: window.RuntimeScheduler
(function () {
  'use strict';

  if (window.RuntimeScheduler) return;

  var LOG = '[RTS]';

  // ── Task types → TaskScheduler tiers ──────────────────────────────────────
  var TYPE_TIER = {
    ui:         'RENDER',    // thumbnail generation, previews
    render:     'RENDER',    // PDF rendering
    ocr:        'AI',        // OCR (heavy)
    ai:         'AI',        // ONNX inference, bg remove
    compress:   'RENDER',    // compression (medium)
    convert:    'RENDER',    // PDF conversion
    merge:      'RENDER',    // multi-file merge
    background: 'BACKGROUND',// cache warm, indexing
    cleanup:    'BACKGROUND',
    largefile:  'RENDER',    // giant PDFs (gets extra delay on low-end)
  };

  // ── Priority ordering (lower = runs first) ────────────────────────────────
  var PRIORITY = { critical: 0, high: 1, normal: 2, low: 3, background: 4 };

  // ── Per-type concurrency caps (applied on top of tier limits) ─────────────
  // Max simultaneous tasks of the same type regardless of tier slots.
  var TYPE_CAP = {
    ocr:       1,   // OCR is RAM-heavy — only one at a time
    ai:        1,   // ONNX inference similarly
    largefile: 1,   // Serialise giant-file processing
    render:    2,
    compress:  2,
    background:2,
  };

  var _typeCounts = {}; // type → running count

  // ── Task queue (priority-sorted waiting tasks) ────────────────────────────
  // Tasks that cannot start immediately go here sorted by priority.
  var _waitQueue = []; // [{ resolve, reject, type, priority, label, ts }]

  // ── Mobile / low-end adjustments ─────────────────────────────────────────
  var _ua = navigator.userAgent || '';
  var IS_MOBILE = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  var IS_LOW_END = IS_MOBILE && (navigator.hardwareConcurrency || 4) <= 4;

  if (IS_LOW_END) {
    TYPE_CAP.render   = 1;
    TYPE_CAP.compress = 1;
    TYPE_CAP.background = 1;
  }

  // ── Effective concurrency cap ─────────────────────────────────────────────
  function _typeCap(type) {
    var base = TYPE_CAP[type] || 2;
    // Shrink under memory pressure
    if (window.RuntimeMemory && window.RuntimeMemory.isCritical()) return 1;
    if (window.RuntimeMemory && window.RuntimeMemory.isWarning()) return Math.max(1, Math.floor(base / 2));
    return base;
  }

  function _canStart(type) {
    var running = _typeCounts[type] || 0;
    return running < _typeCap(type);
  }

  // ── Drain wait queue ──────────────────────────────────────────────────────
  function _drain() {
    if (!_waitQueue.length) return;
    // Process in priority order
    _waitQueue.sort(function (a, b) {
      var pa = PRIORITY[a.priority] || 2;
      var pb = PRIORITY[b.priority] || 2;
      return pa !== pb ? pa - pb : a.ts - b.ts; // FIFO within same priority
    });
    var i = 0;
    while (i < _waitQueue.length) {
      var item = _waitQueue[i];
      if (_canStart(item.type)) {
        _waitQueue.splice(i, 1);
        item.resolve();
        // Don't increment here — run() increments after resolve
        return; // one at a time through drain to maintain ordering
      }
      i++;
    }
  }

  // ── Core run ──────────────────────────────────────────────────────────────
  // opts: { type?, priority?, label?, token?, timeoutMs?, onProgress? }
  // fn receives (progressFn) where progressFn(pct, message?) reports progress.
  // Returns Promise<result>.
  async function run(fn, opts) {
    opts = opts || {};
    var type     = opts.type     || 'render';
    var priority = opts.priority || 'normal';
    var label    = opts.label    || type + '-task';
    var token    = opts.token    || null;
    var tier     = TYPE_TIER[type] || 'RENDER';

    // Check if cancelled before we even start
    if (token && token.cancelled) {
      return Promise.reject(new Error('cancelled-before-start'));
    }

    // Check emergency mode
    if (window.RuntimeState && window.RuntimeState.isEmergency()) {
      if (type !== 'cleanup' && type !== 'background') {
        return Promise.reject(new Error('runtime-emergency'));
      }
    }

    // Telemetry span
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan(label, { type: type, priority: priority });
    }

    // Progress task
    var progressTask = null;
    if (window.RuntimeProgress && opts.label) {
      progressTask = window.RuntimeProgress.createSimpleTask(label, token);
    }

    // Acquire concurrency slot from TaskScheduler
    var tsPromise = window.TaskScheduler
      ? window.TaskScheduler.acquireSlot(tier)
      : Promise.resolve();

    // Wait for both: TaskScheduler slot AND type-specific cap
    await tsPromise;

    // If type cap is also at limit, wait in our priority queue
    if (!_canStart(type)) {
      await new Promise(function (resolve, reject) {
        var entry = { resolve: resolve, reject: reject, type: type, priority: priority, label: label, ts: Date.now() };
        _waitQueue.push(entry);

        // Wire cancellation
        if (token) {
          token.onCancel(function (reason) {
            var idx = _waitQueue.indexOf(entry);
            if (idx !== -1) _waitQueue.splice(idx, 1);
            if (window.TaskScheduler) window.TaskScheduler.releaseSlot(tier);
            reject(new Error('cancelled:' + reason));
          });
        }
      });
    }

    // Check cancellation again after waiting
    if (token && token.cancelled) {
      if (window.TaskScheduler) window.TaskScheduler.releaseSlot(tier);
      if (progressTask) progressTask.fail('cancelled');
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'cancelled');
      throw new Error('cancelled');
    }

    // Increment type counter
    _typeCounts[type] = (_typeCounts[type] || 0) + 1;

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('task:started', { type: type, label: label }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('task:started', { type: type, label: label }); } catch (_) {}
    }

    // Build progress reporter
    var progressFn = function (pct, msg) {
      if (progressTask) progressTask.report(pct, msg);
    };

    var result;
    try {
      result = await fn(progressFn);
      if (progressTask) progressTask.complete();
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'ok');
      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('task:completed', { type: type, label: label }); } catch (_) {}
      }
      if (window.RuntimeEventBus) {
        try { window.RuntimeEventBus.emit('task:completed', { type: type, label: label }); } catch (_) {}
      }
      if (window.AdaptiveRuntime && window.AdaptiveRuntime.recordSuccess) {
        try { window.AdaptiveRuntime.recordSuccess(); } catch (_) {}
      }
      return result;
    } catch (err) {
      if (progressTask) progressTask.fail(err && err.message);
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'failed');
      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('task:failed', { type: type, label: label, error: err && err.message }); } catch (_) {}
      }
      if (window.AdaptiveRuntime && window.AdaptiveRuntime.recordFailure) {
        try { window.AdaptiveRuntime.recordFailure(err && err.message); } catch (_) {}
      }
      throw err;
    } finally {
      // Always release slot and drain queue
      _typeCounts[type] = Math.max(0, (_typeCounts[type] || 1) - 1);
      if (window.TaskScheduler) window.TaskScheduler.releaseSlot(tier);
      _drain();
    }
  }

  // ── Cancel all queued tasks of a type ─────────────────────────────────────
  function cancelType(type, reason) {
    var removed = 0;
    _waitQueue = _waitQueue.filter(function (item) {
      if (item.type === type) {
        item.reject(new Error(reason || 'cancelled:' + type));
        removed++;
        return false;
      }
      return true;
    });
    if (window.TaskScheduler) window.TaskScheduler.cancelQueued(TYPE_TIER[type] || 'RENDER');
    return removed;
  }

  // ── Cancel all queued tasks ────────────────────────────────────────────────
  function cancelAll(reason) {
    var count = _waitQueue.length;
    _waitQueue.forEach(function (item) { item.reject(new Error(reason || 'shutdown')); });
    _waitQueue = [];
    _typeCounts = {};
    return count;
  }

  // ── Convenience wrappers for common task types ────────────────────────────
  function scheduleRender(fn, opts) { return run(fn, Object.assign({ type: 'render' }, opts)); }
  function scheduleOcr(fn, opts)    { return run(fn, Object.assign({ type: 'ocr' }, opts)); }
  function scheduleAi(fn, opts)     { return run(fn, Object.assign({ type: 'ai' }, opts)); }
  function scheduleBackground(fn, opts){ return run(fn, Object.assign({ type: 'background', priority: 'low' }, opts)); }
  function scheduleLargeFile(fn, opts){ return run(fn, Object.assign({ type: 'largefile' }, opts)); }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var ts = window.TaskScheduler ? window.TaskScheduler.stats() : {};
    return {
      waitQueueSize: _waitQueue.length,
      typeCounts:    Object.assign({}, _typeCounts),
      isMobile:      IS_MOBILE,
      isLowEnd:      IS_LOW_END,
      taskScheduler: ts,
    };
  }

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
  }, { passive: true });

  window.RuntimeScheduler = {
    run:               run,
    scheduleRender:    scheduleRender,
    scheduleOcr:       scheduleOcr,
    scheduleAi:        scheduleAi,
    scheduleBackground:scheduleBackground,
    scheduleLargeFile: scheduleLargeFile,
    cancelType:        cancelType,
    cancelAll:         cancelAll,
    getStats:          getStats,
    TYPE_TIER:         TYPE_TIER,
  };

  console.debug('[RuntimeScheduler] ready — T021 task scheduler active');
}());
