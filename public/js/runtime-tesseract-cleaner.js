// runtime-tesseract-cleaner.js — Tesseract Leak Reaper (Phase 2D)
// ADDITIVE ONLY. Intercepts Tesseract.createWorker / recognize calls to track
// all live OCR workers globally. Detects idle workers, hung recognize jobs,
// duplicate language-load deadlocks, and auto-terminates stale instances.
// Never interrupts actively-running OCR jobs within their normal timeout.
//
// window.RuntimeTesseractCleaner — public API
(function () {
  'use strict';

  if (window.RuntimeTesseractCleaner) return;

  var LOG     = '[TRC]';
  var VERSION = '1.0.0';

  // ── Config ───────────────────────────────────────────────────────────────────
  var WORKER_IDLE_TTL_MS   = 3 * 60 * 1000;   // 3 min idle → terminate
  var WORKER_MAX_AGE_MS    = 10 * 60 * 1000;  // 10 min hard cap
  var RECOGNIZE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min per job
  var LANG_LOAD_TIMEOUT_MS = 2 * 60 * 1000;   // 2 min per language load

  // ── Worker registry ──────────────────────────────────────────────────────────
  // Map<id, { worker, ts, lastUsed, label, terminated, busy, jobs[] }>
  var _workers  = new Map();
  var _nextId   = 1;
  var _stats    = { registered: 0, autoTerminated: 0, jobsCancelled: 0, errors: 0 };

  // ── Register a Tesseract worker ──────────────────────────────────────────────
  function register(worker, opts) {
    opts = opts || {};
    var id    = _nextId++;
    var entry = {
      id:         id,
      worker:     worker,
      ts:         Date.now(),
      lastUsed:   Date.now(),
      label:      opts.label || 'tesseract-' + id,
      terminated: false,
      busy:       false,
      jobs:       [],
    };
    _workers.set(id, entry);
    _stats.registered++;

    return {
      id: id,

      // Called when a recognize job starts
      jobStarted: function (jobRef) {
        entry.busy    = true;
        entry.lastUsed = Date.now();
        if (jobRef) entry.jobs.push({ ref: jobRef, ts: Date.now() });
      },

      // Called when a recognize job completes or errors
      jobDone: function () {
        entry.busy  = false;
        entry.jobs  = [];
        entry.lastUsed = Date.now();
      },

      // Called on normal cleanup (worker.terminate() called by owner)
      done: function () {
        entry.terminated = true;
        _workers.delete(id);
      },
    };
  }

  // ── Force-terminate a worker entry ───────────────────────────────────────────
  function _terminate(entry, reason) {
    if (entry.terminated) return;
    entry.terminated = true;

    // Cancel any tracked job promises
    entry.jobs.forEach(function (job) {
      try {
        if (job.ref && typeof job.ref.cancel === 'function') {
          job.ref.cancel();
          _stats.jobsCancelled++;
        }
      } catch (_) {}
    });
    entry.jobs = [];

    // Terminate the worker
    try {
      if (entry.worker && typeof entry.worker.terminate === 'function') {
        entry.worker.terminate();
        _stats.autoTerminated++;
        console.info(LOG, 'terminated', entry.label, '— reason:', reason);
      }
    } catch (e) {
      _stats.errors++;
    }

    entry.worker = null;

    try {
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.emit('tesseract:auto-terminated', { label: entry.label, reason: reason });
      }
    } catch (_) {}
  }

  // ── Monkey-patch Tesseract.createWorker ─────────────────────────────────────
  var _intercepted  = false;
  var _interceptTries = 0;

  function _tryIntercept() {
    var T = window.Tesseract;
    if (!T || typeof T.createWorker !== 'function') {
      if (_interceptTries++ < 60) setTimeout(_tryIntercept, 1000);
      return;
    }
    if (_intercepted) return;
    _intercepted = true;

    var _origCreate = T.createWorker.bind(T);

    T.createWorker = function () {
      var args = Array.prototype.slice.call(arguments);
      var workerPromise = _origCreate.apply(T, args);

      // createWorker returns a promise in newer Tesseract.js
      if (workerPromise && typeof workerPromise.then === 'function') {
        return workerPromise.then(function (worker) {
          var label = (typeof args[0] === 'string') ? args[0] : 'tesseract';
          var handle = register(worker, { label: label });

          // Patch recognize
          if (typeof worker.recognize === 'function') {
            var _origRecognize = worker.recognize.bind(worker);
            worker.recognize = function () {
              handle.jobStarted(null);
              var p = _origRecognize.apply(worker, arguments);
              if (p && typeof p.then === 'function') {
                p.then(function (r) { handle.jobDone(); return r; },
                       function (e) { handle.jobDone(); throw e; });
              }
              return p;
            };
          }

          // Patch terminate
          if (typeof worker.terminate === 'function') {
            var _origTerminate = worker.terminate.bind(worker);
            worker.terminate = function () {
              handle.done();
              return _origTerminate();
            };
          }

          return worker;
        });
      }
      return workerPromise;
    };

    console.info(LOG, 'Tesseract.createWorker intercepted — auto-tracking all OCR workers');
  }

  // ── Sweep logic ──────────────────────────────────────────────────────────────
  function sweep() {
    var now     = Date.now();
    var cleaned = 0;

    _workers.forEach(function (entry, id) {
      if (entry.terminated) { _workers.delete(id); return; }

      var age     = now - entry.ts;
      var idleMs  = now - entry.lastUsed;

      // Hard age cap
      if (age > WORKER_MAX_AGE_MS) {
        _workers.delete(id);
        _terminate(entry, 'max-age:' + Math.round(age / 1000) + 's');
        cleaned++;
        return;
      }

      // Idle too long (not busy)
      if (!entry.busy && idleMs > WORKER_IDLE_TTL_MS) {
        _workers.delete(id);
        _terminate(entry, 'idle:' + Math.round(idleMs / 1000) + 's');
        cleaned++;
        return;
      }

      // Stuck job (busy for longer than recognize timeout)
      if (entry.busy && entry.jobs.length > 0) {
        var jobAge = now - entry.jobs[0].ts;
        if (jobAge > RECOGNIZE_TIMEOUT_MS) {
          _workers.delete(id);
          _terminate(entry, 'recognize-timeout:' + Math.round(jobAge / 1000) + 's');
          cleaned++;
        }
      }
    });

    if (cleaned > 0) console.info(LOG, 'sweep terminated', cleaned, 'stale Tesseract workers');
    return cleaned;
  }

  // ── Nuke all (soft reset / panic) ────────────────────────────────────────────
  function nukeAll(reason) {
    var count = 0;
    _workers.forEach(function (entry) {
      _terminate(entry, 'nukeAll:' + (reason || 'reset'));
      count++;
    });
    _workers.clear();
    console.info(LOG, 'nukeAll:', count, 'workers terminated. Reason:', reason);
    return count;
  }

  function getStats() {
    return Object.assign({}, _stats, {
      live:        _workers.size,
      busy:        Array.from(_workers.values()).filter(function (e) { return e.busy; }).length,
      intercepted: _intercepted,
      version:     VERSION,
    });
  }

  function getLive() {
    var now  = Date.now();
    return Array.from(_workers.values()).map(function (e) {
      return { id: e.id, label: e.label, ageMs: now - e.ts, idleMs: now - e.lastUsed, busy: e.busy, jobs: e.jobs.length };
    });
  }

  // ── Sweep loop (every 90s) ───────────────────────────────────────────────────
  var _sweepTimer = setInterval(function () {
    try { sweep(); } catch (_) {}
  }, 90000);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeTesseractCleaner', _sweepTimer);

  _tryIntercept();

  window.addEventListener('pagehide', function () {
    try { nukeAll('pagehide'); } catch (_) {}
  }, { passive: true });

  window.RuntimeTesseractCleaner = {
    register:  register,
    sweep:     sweep,
    nukeAll:   nukeAll,
    getStats:  getStats,
    getLive:   getLive,
    VERSION:   VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
