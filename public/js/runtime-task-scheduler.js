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

    // Acquire the global tier slot with cancellation wired from the start.
    // This prevents cancelled tasks from remaining stuck in TaskScheduler.queue.
    var tsPromise = window.TaskScheduler
      ? window.TaskScheduler.acquireSlot(tier, token)
      : Promise.resolve();
    await tsPromise;

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

    // Wait for the type-specific cap after the global tier slot is held.
    // The slot is released if this task is cancelled while waiting here.

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