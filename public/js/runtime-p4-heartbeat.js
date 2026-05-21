// RuntimeP4Heartbeat v1.0 — Phase 4 / Task 4 (Worker Heartbeat Protocol)
// ============================================================================
// Phase 4 upgrade of the worker liveness monitor.
// Extends the Phase 3 __p3_ping/__p3_pong protocol with richer telemetry:
//
//   __p4_ping  → { type: '__p4_ping', id: N, ts: epoch }
//   __p4_pong  → { type: '__p4_pong', id: N, ts: epoch,
//                   memUsedMB: number|null,   ← worker memory estimate
//                   queueLen:  number|null,   ← pending tasks in worker queue
//                   idle:      boolean,       ← worker idle flag
//                   version:   string|null }  ← worker self-reported version
//
// Backward-compatible:
//   • Workers that respond with __p3_pong still counted as healthy
//   • Workers that don't respond at all are restarted (same as Phase 3)
//   • Workers that send __p4_pong get their memory/queue stats recorded
//
// Adaptive timing (prevents restart storms and mobile instability):
//   EXTREME (score≥90) — ping every 20s, timeout 8s
//   HIGH    (score≥70) — ping every 40s, timeout 12s
//   MEDIUM  (score≥40) — ping every 90s, timeout 20s
//   LOW     (<40)      — disabled
//
// Anti-storm guards:
//   • Max 3 restarts per worker per hour
//   • 60s backoff after each restart
//   • Page-hidden: heartbeat paused (mobile battery safety)
//   • Only restarts when worker is truly idle (not processing)
//
// window.RuntimeP4Heartbeat
//   .track(worker, workerId)     → void
//   .untrack(workerId)           → void
//   .pingAll()                   → void
//   .getWorkerStats(workerId)    → object|null
//   .status()                    → StatusObject
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeP4Heartbeat) return;

  var VERSION = '1.0';
  var LOG     = '[P4Heartbeat]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device score ─────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  // ── Adaptive timing ───────────────────────────────────────────────────────
  var PING_MS    = _score >= 90 ? 20000 : (_score >= 70 ? 40000 : 90000);
  var TIMEOUT_MS = _score >= 90 ? 8000  : (_score >= 70 ? 12000 : 20000);
  var MAX_MISSED = 3;
  var SPAWN_GRACE_MS   = 35000;   // new workers immune for 35s
  var MAX_RESTARTS_HR  = 3;       // anti-storm: max 3 restarts per worker/hr
  var RESTART_BACKOFF  = 60000;   // 60s minimum between restarts

  // ── Tracked workers: Map<workerId, WorkerEntry> ───────────────────────────
  // WorkerEntry: { worker, spawnTs, lastPong, missed, restarts, restartTs[],
  //               lastRestartTs, memUsedMB, queueLen, idle, version, pongType }
  var _workers      = typeof Map !== 'undefined' ? new Map() : null;
  var _pendingPings = typeof Map !== 'undefined' ? new Map() : null;
  var _pingSeq      = 0;
  var _paused       = false;

  var _stats = {
    tracked:    0,
    healthy:    0,
    restarts:   0,
    p4Pongs:    0,
    p3Pongs:    0,
    lastCheck:  0,
  };

  // ── Page visibility: pause on hidden (mobile battery safety) ─────────────
  _s(function () {
    document.addEventListener('visibilitychange', function () {
      _paused = document.visibilityState === 'hidden';
      if (!_paused) console.debug(LOG, 'page visible — heartbeat resumed');
    });
  });

  // ── Track a worker ────────────────────────────────────────────────────────
  function track(worker, workerId) {
    if (_lite || !_workers || typeof workerId !== 'string' || !workerId) return;
    if (_workers.has(workerId)) return; // already tracked

    var entry = {
      worker:        worker,
      spawnTs:       Date.now(),
      lastPong:      Date.now(),
      missed:        0,
      restarts:      0,
      restartTs:     [],
      lastRestartTs: 0,
      memUsedMB:     null,
      queueLen:      null,
      idle:          true,
      version:       null,
      pongType:      null,
    };
    _workers.set(workerId, entry);
    _stats.tracked = _workers.size;

    // Attach pong listener
    _s(function () {
      worker.addEventListener('message', function (ev) {
        _onMessage(workerId, ev.data);
      });
    });

    console.debug(LOG, 'tracking:', workerId, '| ping:', PING_MS + 'ms');
  }

  // ── Untrack ───────────────────────────────────────────────────────────────
  function untrack(workerId) {
    if (!_workers) return;
    _workers.delete(workerId);
    _stats.tracked = _workers.size;
  }

  // ── Handle inbound pong (p4 and p3 both accepted) ─────────────────────────
  function _onMessage(workerId, data) {
    if (!data) return;

    var isP4 = data.type === '__p4_pong';
    var isP3 = data.type === '__p3_pong';
    if (!isP4 && !isP3) return;

    var pingId = data.id;
    if (_pendingPings && _pendingPings.has(pingId)) {
      var pending = _pendingPings.get(pingId);
      _pendingPings.delete(pingId);
      clearTimeout(pending.timer);
      pending.resolve(true);
    }

    var entry = _workers && _workers.get(workerId);
    if (!entry) return;

    entry.lastPong = Date.now();
    entry.missed   = 0;

    if (isP4) {
      // Absorb rich telemetry
      _stats.p4Pongs++;
      entry.pongType = 'p4';
      if (typeof data.memUsedMB === 'number') entry.memUsedMB = data.memUsedMB;
      if (typeof data.queueLen  === 'number') entry.queueLen  = data.queueLen;
      if (typeof data.idle      === 'boolean') entry.idle     = data.idle;
      if (typeof data.version   === 'string')  entry.version  = data.version;

      // Record high memory to telemetry
      if (entry.memUsedMB !== null && entry.memUsedMB > 300) {
        _s(function () {
          if (G.SecurityTelemetry) {
            G.SecurityTelemetry.record('perf-pressure', {
              workerId: workerId, memMB: entry.memUsedMB,
            });
          }
        });
      }
    } else {
      _stats.p3Pongs++;
      entry.pongType = 'p3';
    }
  }

  // ── Send a ping ───────────────────────────────────────────────────────────
  function _pingWorker(workerId) {
    var entry = _workers && _workers.get(workerId);
    if (!entry || !entry.worker) return Promise.resolve(false);

    // Grace period
    if ((Date.now() - entry.spawnTs) < SPAWN_GRACE_MS) return Promise.resolve(true);

    // Don't ping if worker is actively processing (anti-false-kill)
    if (entry.queueLen !== null && entry.queueLen > 0) return Promise.resolve(true);

    return new Promise(function (resolve) {
      var pingId = ++_pingSeq;
      var timer  = setTimeout(function () {
        if (_pendingPings) _pendingPings.delete(pingId);
        resolve(false);
      }, TIMEOUT_MS);

      if (_pendingPings) {
        _pendingPings.set(pingId, { workerId: workerId, resolve: resolve, timer: timer });
      }

      // Send p4 ping with server-side ts for skew detection
      _s(function () {
        entry.worker.postMessage({ type: '__p4_ping', id: pingId, ts: Date.now() });
      });
    });
  }

  // ── Ping all workers ──────────────────────────────────────────────────────
  function pingAll() {
    if (!_workers || _workers.size === 0 || _paused) return;
    _stats.lastCheck = Date.now();
    _stats.healthy   = 0;

    _workers.forEach(function (entry, workerId) {
      _pingWorker(workerId).then(function (alive) {
        if (alive) {
          _stats.healthy++;
          entry.missed = 0;
        } else {
          entry.missed++;
          console.debug(LOG, workerId, 'missed ping', entry.missed + '/' + MAX_MISSED);
          if (entry.missed >= MAX_MISSED) {
            _maybeRestart(workerId, entry);
          }
        }
      });
    });
  }

  // ── Anti-storm restart guard ──────────────────────────────────────────────
  function _maybeRestart(workerId, entry) {
    var now  = Date.now();
    var HOUR = 3600000;

    // Backoff: too soon after last restart
    if (now - entry.lastRestartTs < RESTART_BACKOFF) {
      console.debug(LOG, workerId, 'restart backoff active — skipping');
      return;
    }

    // Rate limit: max restarts per hour
    entry.restartTs = (entry.restartTs || []).filter(function (ts) { return now - ts < HOUR; });
    if (entry.restartTs.length >= MAX_RESTARTS_HR) {
      console.warn(LOG, workerId, 'restart rate-limited (', MAX_RESTARTS_HR, '/hr)');
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('worker-restart', { workerId: workerId, reason: 'rate-limited' });
        }
      });
      return;
    }

    // Don't restart while worker still has queue items (stale ping ≠ dead)
    if (entry.queueLen !== null && entry.queueLen > 0) {
      console.debug(LOG, workerId, 'has queued tasks — not restarting');
      entry.missed = 0;
      return;
    }

    console.info(LOG, 'restarting unresponsive worker:', workerId, '| restarts:', entry.restarts + 1);
    entry.restartTs.push(now);
    entry.lastRestartTs = now;
    entry.restarts++;
    entry.missed       = 0;
    _stats.restarts++;

    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('worker-restart', { workerId: workerId, retries: entry.restarts });
      }
    });

    _s(function () {
      var factory = G.RuntimeWorkerFactory;
      if (!factory || typeof factory.spawn !== 'function') return;
      var path = workerId.startsWith('/workers/') ? workerId : '/workers/' + workerId;
      var newWorker = factory.spawn(path);
      if (!newWorker) return;
      entry.worker   = newWorker;
      entry.spawnTs  = Date.now();
      entry.lastPong = Date.now();
      entry.memUsedMB = null;
      entry.queueLen  = null;
      entry.idle       = true;
      newWorker.addEventListener('message', function (ev) {
        _onMessage(workerId, ev.data);
      });
      console.info(LOG, workerId, 'restarted OK');
    });
  }

  // ── Get per-worker stats ──────────────────────────────────────────────────
  function getWorkerStats(workerId) {
    if (!_workers) return null;
    var e = _workers.get(workerId);
    if (!e) return null;
    return {
      workerId:     workerId,
      missed:       e.missed,
      restarts:     e.restarts,
      lastPong:     e.lastPong,
      memUsedMB:    e.memUsedMB,
      queueLen:     e.queueLen,
      idle:         e.idle,
      version:      e.version,
      pongType:     e.pongType,
    };
  }

  // ── Start heartbeat interval ──────────────────────────────────────────────
  function _startHeartbeat() {
    if (_lite) return;
    setInterval(pingAll, PING_MS);
    console.info(LOG, 'heartbeat active | ping:', PING_MS + 'ms | timeout:', TIMEOUT_MS + 'ms');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (_lite) {
      console.info(LOG, 'v' + VERSION + ' loaded | lite mode — disabled');
      return;
    }
    _startHeartbeat();
    // Auto-hook into RuntimeWorkerBootstrap if present (co-exist)
    _s(function () {
      var rwb = G.RuntimeWorkerBootstrap;
      if (rwb && typeof rwb.track === 'function') {
        console.debug(LOG, 'co-existing with RuntimeWorkerBootstrap (p3)');
      }
    });
    console.info(LOG, 'v' + VERSION + ' ready | score:', _score,
      '| ping:', PING_MS + 'ms | timeout:', TIMEOUT_MS + 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeP4Heartbeat = Object.freeze({
    VERSION:        VERSION,
    track:          track,
    untrack:        untrack,
    pingAll:        pingAll,
    getWorkerStats: getWorkerStats,
    status: function () {
      var workers = [];
      if (_workers) {
        _workers.forEach(function (e, id) {
          workers.push({
            workerId:  id,
            missed:    e.missed,
            restarts:  e.restarts,
            idle:      e.idle,
            pongType:  e.pongType,
            queueLen:  e.queueLen,
            memUsedMB: e.memUsedMB,
          });
        });
      }
      return {
        tracked:   _workers ? _workers.size : 0,
        healthy:   _stats.healthy,
        restarts:  _stats.restarts,
        p4Pongs:   _stats.p4Pongs,
        p3Pongs:   _stats.p3Pongs,
        lastCheck: _stats.lastCheck,
        paused:    _paused,
        workers:   workers,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
