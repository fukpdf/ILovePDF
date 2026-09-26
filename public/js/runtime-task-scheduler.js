
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
    var tsPromise = window.TaskScheduler
      ? window.TaskScheduler.acquireSlot(tier, token)
      : Promise.resolve();
    await tsPromise;

    // If type cap is also at limit, wait in our priority queue.
    // The tier slot is already held while waiting, so cancellation must release
    // it exactly once.
    var tierSlotHeld = true;
    var typeWaitCancelled = false;
    var typeWaitDetach = null;
    if (!_canStart(type)) {
      await new Promise(function (resolve, reject) {
        var entry = { resolve: resolve, reject: reject, type: type, priority: priority, label: label, ts: Date.now(), settled: false };
        _waitQueue.push(entry);

        if (token && typeof token.onCancel === 'function') {
          typeWaitDetach = token.onCancel(function (reason) {
            var idx = _waitQueue.indexOf(entry);
            if (idx !== -1) _waitQueue.splice(idx, 1);
            if (!entry.settled) {
              entry.settled = true;
              typeWaitCancelled = true;
              if (window.TaskScheduler && tierSlotHeld) {
                tierSlotHeld = false;
                window.TaskScheduler.releaseSlot(tier);
              }
              reject(new Error('cancelled:' + (reason || 'cancelled')));
            }
          });
        }
      });
    }
    if (typeWaitDetach) typeWaitDetach();

    function releaseTierSlotOnce() {
      if (tierSlotHeld && window.TaskScheduler) {
        tierSlotHeld = false;
        window.TaskScheduler.releaseSlot(tier);
      }
    }

    // Resources are created only after both queue layers can start.
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan(label, { type: type, priority: priority });
    }
    var progressTask = null;
    if (window.RuntimeProgress && opts.label) {
      progressTask = window.RuntimeProgress.createSimpleTask(label, token);
    }

    // Check cancellation again after waiting
    if (token && token.cancelled) {
      releaseTierSlotOnce();
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
      releaseTierSlotOnce();
      _drain();
    }