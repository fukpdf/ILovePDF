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

    // Only create telemetry/progress resources once both queue layers can start.
    // This avoids orphaned spans/tasks when cancellation rejects a queued task.
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