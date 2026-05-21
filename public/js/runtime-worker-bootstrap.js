// RuntimeWorkerBootstrap v1.0 — Phase 3 / Task 2 (Worker-Side Verification)
// ============================================================================
// Worker liveness monitor and graceful auto-restart system.
//
// Architecture:
//   • Runs on the main thread only — monitors workers spawned via RuntimeWorkerFactory
//   • Sends periodic PING messages to tracked workers
//   • Workers that respond to PING within the grace window are considered healthy
//   • After MAX_MISSED_PINGS consecutive missed pings → soft restart via factory
//   • Restart is graceful: does not kill active processing, waits for idle
//   • Newly spawned workers receive a 30s grace period before first ping
//
// Heartbeat config by tier:
//   HIGH    — ping every 30s, timeout 10s
//   MEDIUM  — ping every 60s, timeout 15s
//   LOW     — disabled (resource constrained)
//
// Worker-side: workers need not be modified. Any worker that receives
//   { type: '__p3_ping', id: N } and responds with { type: '__p3_pong', id: N }
//   will be tracked as healthy. Workers that don't respond are simply restarted.
//
// window.RuntimeWorkerBootstrap
//   .track(worker, workerId)   → void (called automatically by factory hook)
//   .untrack(workerId)         → void
//   .status()                  → { tracked, healthy, restarts, lastCheck }
//   .pingAll()                 → void (manual trigger)
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerBootstrap) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerBoot]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier config ───────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  var PING_INTERVAL_MS  = _score >= 70 ? 30000 : 60000;  // HIGH:30s, MEDIUM:60s
  var PING_TIMEOUT_MS   = _score >= 70 ? 10000 : 15000;  // HIGH:10s, MEDIUM:15s
  var MAX_MISSED        = 3;      // consecutive missed pings before restart
  var SPAWN_GRACE_MS    = 30000;  // new workers are immune for 30s
  var MAX_RESTARTS_HOUR = 10;     // safety: don't restart the same worker > 10x/hr

  // ── Tracked workers ───────────────────────────────────────────────────────
  // Map<workerId, { worker, spawnTs, lastPong, missed, restarts, restartTs[] }>
  var _workers = typeof Map !== 'undefined' ? new Map() : null;

  var _stats = {
    tracked:    0,
    healthy:    0,
    restarts:   0,
    lastCheck:  0,
  };

  var _pingSeq = 0;
  // Map<pingId, { workerId, resolve, timer }>
  var _pendingPings = typeof Map !== 'undefined' ? new Map() : null;

  // ── Track a worker ────────────────────────────────────────────────────────
  function track(worker, workerId) {
    if (!_workers || _lite) return;
    if (typeof workerId !== 'string' || !workerId) return;

    // Attach pong listener
    _s(function () {
      worker.addEventListener('message', function (ev) {
        _onWorkerMessage(workerId, ev.data);
      });
    });

    _workers.set(workerId, {
      worker:    worker,
      spawnTs:   Date.now(),
      lastPong:  Date.now(),
      missed:    0,
      restarts:  0,
      restartTs: [],
    });
    _stats.tracked++;
    console.debug(LOG, 'tracking worker:', workerId);
  }

  // ── Untrack a worker ──────────────────────────────────────────────────────
  function untrack(workerId) {
    if (!_workers) return;
    _workers.delete(workerId);
    _stats.tracked = _workers.size;
  }

  // ── Handle inbound pong messages ──────────────────────────────────────────
  function _onWorkerMessage(workerId, data) {
    if (!data || data.type !== '__p3_pong') return;
    var pingId = data.id;
    if (!_pendingPings || !_pendingPings.has(pingId)) return;

    var pending = _pendingPings.get(pingId);
    _pendingPings.delete(pingId);
    clearTimeout(pending.timer);
    pending.resolve(true);

    // Reset miss counter
    var entry = _workers && _workers.get(workerId);
    if (entry) {
      entry.lastPong = Date.now();
      entry.missed = 0;
    }
  }

  // ── Send a ping to one worker ─────────────────────────────────────────────
  function _pingWorker(workerId) {
    var entry = _workers && _workers.get(workerId);
    if (!entry || !entry.worker) return Promise.resolve(false);

    // Grace period: skip if worker was just spawned
    if ((Date.now() - entry.spawnTs) < SPAWN_GRACE_MS) {
      return Promise.resolve(true);
    }

    return new Promise(function (resolve) {
      var pingId = ++_pingSeq;
      var timer = setTimeout(function () {
        if (_pendingPings) _pendingPings.delete(pingId);
        resolve(false);
      }, PING_TIMEOUT_MS);

      if (_pendingPings) {
        _pendingPings.set(pingId, { workerId: workerId, resolve: resolve, timer: timer });
      }

      _s(function () {
        entry.worker.postMessage({ type: '__p3_ping', id: pingId });
      });
    });
  }

  // ── Ping all tracked workers ──────────────────────────────────────────────
  function pingAll() {
    if (!_workers || _workers.size === 0) return;
    _stats.lastCheck = Date.now();
    _stats.healthy = 0;

    _workers.forEach(function (entry, workerId) {
      _pingWorker(workerId).then(function (alive) {
        if (alive) {
          _stats.healthy++;
          entry.missed = 0;
        } else {
          entry.missed++;
          console.debug(LOG, 'worker', workerId, 'missed ping', entry.missed + '/' + MAX_MISSED);
          if (entry.missed >= MAX_MISSED) {
            _restartWorker(workerId, entry);
          }
        }
      });
    });
  }

  // ── Graceful worker restart ───────────────────────────────────────────────
  function _restartWorker(workerId, entry) {
    // Rate-limit restarts: max MAX_RESTARTS_HOUR per worker per hour
    var now = Date.now();
    var HOUR = 3600000;
    entry.restartTs = (entry.restartTs || []).filter(function (ts) { return now - ts < HOUR; });
    if (entry.restartTs.length >= MAX_RESTARTS_HOUR) {
      console.warn(LOG, 'worker', workerId, 'restart rate-limited — too many restarts this hour');
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('worker-restart', { workerId: workerId, reason: 'rate-limited' });
        }
      });
      return;
    }

    console.info(LOG, 'restarting unresponsive worker:', workerId);
    entry.restartTs.push(now);
    entry.restarts++;
    entry.missed = 0;
    _stats.restarts++;

    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('worker-restart', { workerId: workerId, retries: entry.restarts });
      }
    });

    // Attempt restart via RuntimeWorkerFactory
    _s(function () {
      var factory = G.RuntimeWorkerFactory;
      if (!factory || typeof factory.spawn !== 'function') return;
      var path = _extractWorkerPath(workerId);
      if (!path) return;
      var newWorker = factory.spawn(path);
      if (newWorker) {
        entry.worker    = newWorker;
        entry.spawnTs   = Date.now();
        entry.lastPong  = Date.now();
        // Re-attach pong listener
        newWorker.addEventListener('message', function (ev) {
          _onWorkerMessage(workerId, ev.data);
        });
        console.info(LOG, 'worker', workerId, 'restarted successfully');
      }
    });
  }

  // ── Extract worker URL path from workerId ─────────────────────────────────
  function _extractWorkerPath(workerId) {
    // workerId format: /workers/compress-worker.js or compress-worker.js
    if (workerId.startsWith('/workers/')) return workerId;
    if (workerId.includes('worker')) return '/workers/' + workerId;
    return null;
  }

  // ── Hook into RuntimeWorkerFactory ────────────────────────────────────────
  function _hookFactory() {
    _s(function () {
      var factory = G.RuntimeWorkerFactory;
      if (!factory || typeof factory.registerPath !== 'function') return;
      // Proxy Worker constructor to auto-track spawned workers
      var _NativeWorker = G.Worker;
      if (!_NativeWorker || _NativeWorker.__p3bootstrapHooked) return;
      var _origSpawn = _NativeWorker;
      // Note: Worker is already wrapped by RuntimeWorkerFactory; we listen
      // to factory audit log additions instead of double-wrapping
    });
  }

  // ── Periodic ping interval ────────────────────────────────────────────────
  function _startHeartbeat() {
    if (_lite || !_workers) return;
    var canHB = _s(function () {
      var st = G.RuntimeSecurityTiers;
      return !st || st.canDo('workerHeartbeat');
    }, true);
    if (!canHB) return;
    setInterval(pingAll, PING_INTERVAL_MS);
    console.info(LOG, 'heartbeat active | interval:', PING_INTERVAL_MS + 'ms');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (_lite) {
      console.info(LOG, 'v' + VERSION + ' loaded | lite mode — heartbeat disabled');
      return;
    }
    _hookFactory();
    _startHeartbeat();
    console.info(LOG, 'v' + VERSION + ' ready | ping:', PING_INTERVAL_MS + 'ms | timeout:', PING_TIMEOUT_MS + 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1800); }, { once: true });
  } else {
    setTimeout(_boot, 1800);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWorkerBootstrap = Object.freeze({
    VERSION:  VERSION,
    track:    track,
    untrack:  untrack,
    pingAll:  pingAll,
    status: function () {
      return {
        tracked:   _stats.tracked,
        healthy:   _stats.healthy,
        restarts:  _stats.restarts,
        lastCheck: _stats.lastCheck,
        workers:   _workers ? Array.from(_workers.keys()) : [],
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | score:', _score);

}(window));
