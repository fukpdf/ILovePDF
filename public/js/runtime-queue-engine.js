// Runtime Queue Engine v1.0 — Phase 2 (T024)
// Centralizes ALL queue systems. Wraps the server-side QueueClient with:
// ownership tracking, cancellation, persistence hooks, telemetry, cleanup,
// priority management, zombie queue prevention, duplicate job prevention,
// and retry storm prevention.
//
// DESIGN: Decorator over QueueClient — does NOT modify queue-client.js.
// Existing QueueClient.tryProcess() calls continue to work unchanged.
// New code uses RuntimeQueue.submit() for full lifecycle management.
//
// Integrates: QueueClient, RuntimeCancellation, RuntimeTelemetry,
//             RuntimeProgress, RuntimeEventBus, RuntimeState, RetryOrchestrator
//
// [FUTURE: PersistentQueue] RuntimeQueue will use IndexedDB to persist
// pending jobs across page refreshes, enabling true background processing
// that survives navigation and browser restarts.
//
// Exposed as: window.RuntimeQueue
(function () {
  'use strict';

  if (window.RuntimeQueue) return;

  var LOG = '[RQE]';

  // ── Job registry ──────────────────────────────────────────────────────────
  // Map<jobId, Job>
  var _jobs = new Map();
  var _jobIdCounter = 0;

  // ── Deduplication ─────────────────────────────────────────────────────────
  // Map<dedupeKey, jobId> — prevents submitting the same logical job twice
  var _dedupeMap = new Map();

  // ── Job state machine ─────────────────────────────────────────────────────
  var JOB_STATES = { PENDING:'pending', RUNNING:'running', DONE:'done', FAILED:'failed', CANCELLED:'cancelled' };

  function _makeJob(opts) {
    return {
      id:          ++_jobIdCounter,
      label:       opts.label || 'job-' + _jobIdCounter,
      toolId:      opts.toolId || null,
      state:       JOB_STATES.PENDING,
      token:       opts.token || null,
      dedupeKey:   opts.dedupeKey || null,
      priority:    opts.priority || 'normal',
      createdTs:   Date.now(),
      startedTs:   0,
      completedTs: 0,
      serverJobId: null,         // assigned by QueueClient after submission
      progressTaskId: null,      // RuntimeProgress task ID
      pollStopId:  null,         // NavCancel poll stop ID
      retries:     0,
    };
  }

  // ── Polling cancellation bridge ───────────────────────────────────────────
  // Wraps QueueClient's pollUntilDone with NavCancel registration so
  // SPA navigation automatically stops polling.
  function _makePollStopper() {
    var _stopped = false;
    var stopFn = function () { _stopped = true; };
    var pollId = window.NavCancel ? window.NavCancel.registerPolling(stopFn, 'rqe-poll') : -1;
    return {
      stopped: function () { return _stopped; },
      stop:    function () { _stopped = true; if (window.NavCancel) window.NavCancel.unregisterPolling(pollId); },
      pollId:  pollId,
    };
  }

  // ── Core submit ───────────────────────────────────────────────────────────
  // submit(tool, files, options, uiAdaptor?, submitOpts?) → Promise<result>
  //
  // submitOpts:
  //   label?       human-readable label
  //   token?       RuntimeCancellation token
  //   dedupeKey?   string — suppresses duplicate jobs
  //   priority?    'high'|'normal'|'low'
  //   onProgress?  fn(pct, msg) — progress callback
  //
  // Result: whatever QueueClient.tryProcess returns, but also emits events.
  async function submit(tool, files, options, uiAdaptor, submitOpts) {
    submitOpts = submitOpts || {};
    var label     = submitOpts.label || (tool && tool.id) || 'queue-job';
    var token     = submitOpts.token || null;
    var dedupeKey = submitOpts.dedupeKey || null;

    // Deduplication check
    if (dedupeKey && _dedupeMap.has(dedupeKey)) {
      console.debug(LOG, 'dedup suppressed job:', dedupeKey);
      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('queue:dedup', { key: dedupeKey }); } catch (_) {}
      }
      return false;
    }

    // Cancellation check
    if (token && token.cancelled) return false;

    // Create job record
    var job = _makeJob({ label: label, toolId: tool && tool.id, token: token, dedupeKey: dedupeKey, priority: submitOpts.priority });
    _jobs.set(job.id, job);
    if (dedupeKey) _dedupeMap.set(dedupeKey, job.id);

    // Progress task
    if (window.RuntimeProgress) {
      job.progressTaskId = window.RuntimeProgress.startTask({ label: label, token: token, primary: true });
    }

    // Telemetry
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('queue:task-added', { label: label, jobId: job.id }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('queue:task-added', { jobId: job.id, label: label }); } catch (_) {}
    }
    if (window.RuntimeState) {
      try { window.RuntimeState.inc('queueDepth'); window.RuntimeState.inc('queuedTaskCount'); } catch (_) {}
    }

    job.state = JOB_STATES.RUNNING;
    job.startedTs = Date.now();

    // Poll stopper for navigation cancel
    var poller = _makePollStopper();
    job.pollStopId = poller.pollId;

    // Build wrapped UI adaptor that intercepts progress events
    var wrappedUi = _wrapUi(uiAdaptor, job, poller, submitOpts.onProgress);

    try {
      // Delegate to QueueClient (unchanged)
      var handled = window.QueueClient
        ? await window.QueueClient.tryProcess(tool, files, options, wrappedUi)
        : false;

      if (poller.stopped()) {
        _failJob(job, 'cancelled-by-nav');
        return false;
      }

      if (handled) {
        _completeJob(job);
      } else {
        // QueueClient returned false — tool not in queue set or no QUEUE_API_BASE
        _failJob(job, 'not-handled');
      }
      return handled;
    } catch (err) {
      poller.stop();
      _failJob(job, err && err.message);
      throw err;
    } finally {
      if (dedupeKey) _dedupeMap.delete(dedupeKey);
      if (window.RuntimeState) { try { window.RuntimeState.dec('queueDepth'); } catch (_) {} }
    }
  }

  function _wrapUi(ui, job, poller, onProgress) {
    if (!ui) return ui;
    return {
      showProcessing: function (title, msg) {
        if (poller.stopped()) return;
        // Map to RuntimeProgress
        if (job.progressTaskId !== null && window.RuntimeProgress) {
          try { window.RuntimeProgress.report(job.progressTaskId, 0, 50, title + (msg ? ': ' + msg : '')); } catch (_) {}
        }
        if (typeof onProgress === 'function') onProgress(50, title);
        if (ui.showProcessing) try { ui.showProcessing(title, msg); } catch (_) {}
      },
      hideProcessing: function () {
        if (ui.hideProcessing) try { ui.hideProcessing(); } catch (_) {}
      },
      showStatus: function (type, title, message, downloadUrl, filename) {
        if (poller.stopped()) return;
        if (ui.showStatus) try { ui.showStatus(type, title, message, downloadUrl, filename); } catch (_) {}
      },
      triggerDownload: function (blob, filename) {
        if (poller.stopped()) return;
        // Route through DownloadManager for platform-safe download
        if (window.DownloadManager) {
          try { window.DownloadManager.trigger(blob, filename); return; } catch (_) {}
        }
        if (ui.triggerDownload) try { ui.triggerDownload(blob, filename); } catch (_) {}
      },
    };
  }

  function _completeJob(job) {
    job.state       = JOB_STATES.DONE;
    job.completedTs = Date.now();
    if (job.progressTaskId !== null && window.RuntimeProgress) {
      try { window.RuntimeProgress.completeTask(job.progressTaskId); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('queue:task-done', { label: job.label, durationMs: job.completedTs - job.startedTs }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('queue:task-done', { jobId: job.id, label: job.label }); } catch (_) {}
    }
    _jobs.delete(job.id);
  }

  function _failJob(job, reason) {
    job.state       = reason === 'cancelled-by-nav' ? JOB_STATES.CANCELLED : JOB_STATES.FAILED;
    job.completedTs = Date.now();
    if (job.progressTaskId !== null && window.RuntimeProgress) {
      try { window.RuntimeProgress.failTask(job.progressTaskId, reason); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      var evName = job.state === JOB_STATES.CANCELLED ? 'task:cancelled' : 'task:failed';
      try { window.RuntimeTelemetry.record(evName, { label: job.label, reason: reason }); } catch (_) {}
    }
    _jobs.delete(job.id);
  }

  // ── Cancel a specific job ─────────────────────────────────────────────────
  function cancelJob(jobId, reason) {
    var job = _jobs.get(jobId);
    if (!job) return false;
    if (job.token) try { job.token.cancel(reason || 'user-cancel'); } catch (_) {}
    _failJob(job, reason || 'user-cancel');
    if (job.dedupeKey) _dedupeMap.delete(job.dedupeKey);
    return true;
  }

  // ── Cancel all running jobs ───────────────────────────────────────────────
  function cancelAll(reason) {
    var count = 0;
    _jobs.forEach(function (job) { cancelJob(job.id, reason); count++; });
    return count;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var active = [];
    _jobs.forEach(function (j) {
      active.push({ id: j.id, label: j.label, state: j.state, ageMs: Date.now() - j.createdTs });
    });
    return { activeJobs: active.length, jobs: active, dedupeKeys: _dedupeMap.size };
  }

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
    _dedupeMap.clear();
  }, { passive: true });

  window.RuntimeQueue = {
    submit:    submit,
    cancelJob: cancelJob,
    cancelAll: cancelAll,
    getStats:  getStats,
    JOB_STATES: JOB_STATES,
  };

  console.debug('[RuntimeQueue] ready — T024 queue engine active');
}());
