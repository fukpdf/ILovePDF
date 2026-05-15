// Runtime Worker Orchestrator v1.0 — Phase 2 (T022)
// Centralizes ALL worker management: pooling, reuse, retirement, cooldowns,
// memory-aware concurrency, priority routing, duplicate prevention,
// idle accumulation guard, and runaway spawn prevention.
//
// DESIGN: Wraps WorkerPool + WorkerLifecycle — does NOT replace them.
// Existing WorkerPool.run() calls continue to work unchanged.
// New code uses RuntimeWorkers.dispatch() for full lifecycle management.
//
// Integrates: WorkerPool, WorkerLifecycle, RuntimeMemory, RuntimeTelemetry,
//             RuntimeCancellation, RuntimeEventBus, RuntimeState
//
// [FUTURE: CrossTabWorkers] RuntimeWorkers.dispatch() will first check the
// MultiTabCluster for an idle worker in another tab before spawning a new one,
// enabling cross-tab compute sharing without P2P mesh overhead.
//
// Exposed as: window.RuntimeWorkers
(function () {
  'use strict';

  if (window.RuntimeWorkers) return;

  var LOG = '[RWO]';

  // ── Worker cooldown registry ───────────────────────────────────────────────
  // After a worker encounters an error, it enters a cooldown period
  // during which it won't be reused (prevents error amplification).
  // Map<workerUrl, { errorCount, coolUntil }>
  var _cooldowns = new Map();
  var COOLDOWN_MS = 5000; // per error — up to 3 errors = 15 s max

  function _inCooldown(url) {
    var cd = _cooldowns.get(url);
    return cd && Date.now() < cd.coolUntil;
  }

  function _recordError(url) {
    var cd = _cooldowns.get(url) || { errorCount: 0, coolUntil: 0 };
    cd.errorCount++;
    cd.coolUntil = Date.now() + (COOLDOWN_MS * Math.min(cd.errorCount, 3));
    _cooldowns.set(url, cd);
    console.warn(LOG, 'worker error #' + cd.errorCount + ' for', url,
      '— cooldown until', new Date(cd.coolUntil).toISOString());
  }

  function _clearCooldown(url) {
    _cooldowns.delete(url);
  }

  // ── Spawn guard ───────────────────────────────────────────────────────────
  // Map<workerUrl, spawnCount> — reset every SPAWN_WINDOW_MS
  var _spawnCounts = new Map();
  var SPAWN_WINDOW_MS  = 10000;  // 10 s window
  var MAX_SPAWNS_WINDOW = 6;     // max spawns per URL per 10 s

  var _spawnResetTimer = null;
  function _resetSpawnCounts() {
    _spawnCounts.clear();
    _spawnResetTimer = null;
  }

  function _canSpawn(url) {
    var count = _spawnCounts.get(url) || 0;
    if (count >= MAX_SPAWNS_WINDOW) {
      console.warn(LOG, 'spawn guard blocked runaway spawning for:', url,
        '(' + count + '/' + MAX_SPAWNS_WINDOW + ' in window)');
      return false;
    }
    return true;
  }

  function _bumpSpawn(url) {
    _spawnCounts.set(url, (_spawnCounts.get(url) || 0) + 1);
    if (!_spawnResetTimer) {
      _spawnResetTimer = setTimeout(_resetSpawnCounts, SPAWN_WINDOW_MS);
      if (window.TimerRegistry) window.TimerRegistry.registerTimeout('rwo-spawn-reset', _spawnResetTimer);
    }
  }

  // ── In-flight deduplication ───────────────────────────────────────────────
  // Map<dedupeKey, Promise> — if the same idempotent task is already running,
  // return the existing promise rather than spawning a duplicate worker.
  var _inflight = new Map();

  // ── Core dispatch ─────────────────────────────────────────────────────────
  // dispatch(workerUrl, message, transferables?, opts?) → Promise<result>
  //
  // opts:
  //   priority?   'high'|'normal'|'low'|'background' (WorkerPool tier)
  //   token?      RuntimeCancellation token
  //   dedupeKey?  string — if set, deduplicate concurrent identical tasks
  //   label?      human-readable name for telemetry
  //   timeoutMs?  per-task timeout (default: 120 000 ms = 2 min)
  //
  // [FUTURE: CrossTabWorkers] Insert cross-tab worker lookup here before
  // calling WorkerPool.run(). If a tab has an idle worker for this URL,
  // forward the message via BroadcastChannel instead of spawning locally.
  async function dispatch(workerUrl, message, transferables, opts) {
    opts = opts || {};
    var label    = opts.label    || (workerUrl.split('/').pop() + '-task');
    var priority = opts.priority || 'normal';
    var token    = opts.token    || null;
    var dedupeKey = opts.dedupeKey || null;
    var timeoutMs = opts.timeoutMs || 120000;

    // Deduplication
    if (dedupeKey) {
      var existing = _inflight.get(dedupeKey);
      if (existing) {
        console.debug(LOG, 'dedup hit for:', dedupeKey);
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('worker:dedup', { key: dedupeKey }); } catch (_) {}
        }
        return existing;
      }
    }

    // Cancellation check
    if (token && token.cancelled) return Promise.reject(new Error('cancelled-before-dispatch'));

    // Cooldown check
    if (_inCooldown(workerUrl)) {
      console.warn(LOG, 'worker in cooldown, rejecting dispatch:', workerUrl);
      return Promise.reject(new Error('worker-cooldown:' + workerUrl));
    }

    // Spawn guard
    if (!_canSpawn(workerUrl)) {
      return Promise.reject(new Error('worker-spawn-guard:' + workerUrl));
    }

    // Memory concurrency check
    var maxW = window.RuntimeMemory ? window.RuntimeMemory.maxWorkers() : 4;
    var wstats = window.WorkerPool ? window.WorkerPool.getStats() : null;
    if (wstats) {
      var totalBusy = 0;
      Object.values(wstats).forEach(function (p) { totalBusy += (p.busy || 0); });
      if (totalBusy >= maxW) {
        console.debug(LOG, 'memory concurrency cap (' + totalBusy + '/' + maxW + ') — queuing');
      }
    }

    // Build WorkerPool cancel token from RuntimeCancellation token
    var wpToken = null;
    if (window.WorkerPool && window.WorkerPool.CancelToken) {
      wpToken = window.WorkerPool.CancelToken();
      if (token) {
        token.onCancel(function () {
          try { wpToken.cancel(); } catch (_) {}
        });
      }
    }

    _bumpSpawn(workerUrl);

    // Telemetry span
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan('worker:' + label, { url: workerUrl });
    }

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('worker:spawned', { url: workerUrl, label: label }); } catch (_) {}
    }

    // Timeout wrapper
    var p = _runWithTimeout(workerUrl, message, transferables, priority, wpToken, timeoutMs)
      .then(function (result) {
        _clearCooldown(workerUrl);
        if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'ok');
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('worker:released', { url: workerUrl, label: label }); } catch (_) {}
        }
        if (window.RuntimeEventBus) {
          try { window.RuntimeEventBus.emit('worker:released', { url: workerUrl, label: label }); } catch (_) {}
        }
        return result;
      })
      .catch(function (err) {
        _recordError(workerUrl);
        if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'error');
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('worker:error', { url: workerUrl, error: err && err.message }); } catch (_) {}
        }
        if (window.RuntimeEventBus) {
          try { window.RuntimeEventBus.emit('worker:error', { url: workerUrl, error: err && err.message }); } catch (_) {}
        }
        throw err;
      })
      .finally(function () {
        if (dedupeKey) _inflight.delete(dedupeKey);
      });

    if (dedupeKey) _inflight.set(dedupeKey, p);
    return p;
  }

  function _runWithTimeout(url, message, transferables, priority, wpToken, timeoutMs) {
    if (!window.WorkerPool) return Promise.reject(new Error('WorkerPool not available'));

    var workerOpts = { priority: priority };
    if (wpToken) workerOpts.token = wpToken;

    var taskP = window.WorkerPool.run(url, message, transferables || [], workerOpts);

    // Timeout race — tid is cleared when taskP wins so no dangling fire
    var _tid = null;
    var timeoutP = new Promise(function (_, reject) {
      _tid = setTimeout(function () {
        _tid = null;
        if (wpToken) try { wpToken.cancel(); } catch (_) {}
        reject(new Error('worker-timeout:' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
      if (window.TimerRegistry) window.TimerRegistry.registerTimeout('rwo-timeout', _tid);
    });

    return Promise.race([
      taskP.then(function (result) {
        // Clear timeout so it never fires on an already-complete task
        if (_tid !== null) { clearTimeout(_tid); _tid = null; }
        // Auto-pulse WorkerLeakDetector: marks this worker as alive
        if (window.WorkerLeakDetector && window.WorkerLeakDetector.pulse) {
          try { window.WorkerLeakDetector.pulse(url); } catch (_) {}
        }
        return result;
      }),
      timeoutP,
    ]);
  }

  // ── Terminate all workers for a URL ───────────────────────────────────────
  function terminateUrl(workerUrl) {
    if (window.WorkerPool && window.WorkerPool.terminatePool) {
      try { window.WorkerPool.terminatePool(workerUrl); } catch (_) {}
    }
    _inflight.forEach(function (p, key) {
      if (key.startsWith(workerUrl)) _inflight.delete(key);
    });
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('worker:terminate', { url: workerUrl }); } catch (_) {}
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var poolStats = window.WorkerPool ? window.WorkerPool.getStats() : null;
    var wlStats   = window.WorkerLifecycle ? window.WorkerLifecycle.getStats() : null;
    return {
      cooldowns:   _cooldowns.size,
      inflight:    _inflight.size,
      spawnCounts: Object.fromEntries ? Object.fromEntries(_spawnCounts) : {},
      poolStats:   poolStats,
      wlStats:     wlStats,
    };
  }

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    _inflight.clear();
    _cooldowns.clear();
    if (window.WorkerLeakDetector && window.WorkerLeakDetector.terminateZombies) {
      try { window.WorkerLeakDetector.terminateZombies(); } catch (_) {}
    }
  }, { passive: true });

  // ── Update P1.dispatchWorker to route through RuntimeWorkers ─────────────
  // [FUTURE: WorkerOrchestrator] This is the final migration point:
  // P1.dispatchWorker → RuntimeWorkers.dispatch → WorkerPool.run
  if (window.P1) {
    window.P1.dispatchWorker = function (workerUrl, task, opts) {
      return dispatch(workerUrl, task, [], {
        priority: (opts && opts.priority) || 'normal',
        label:    (opts && opts.label),
      });
    };
  }

  window.RuntimeWorkers = {
    dispatch:     dispatch,
    terminateUrl: terminateUrl,
    getStats:     getStats,
  };

  console.debug('[RuntimeWorkers] ready — T022 worker orchestrator active');
}());
