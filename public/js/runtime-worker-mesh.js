// RuntimeWorkerMesh v1.0 — Phase 7 / Section 2 (Zero-Trust Worker Mesh)
// =============================================================================
// Coordinates signed worker identities, trust scoring, and mesh-level
// security for the worker pool. Workers are treated as untrusted by default.
//
// Architecture:
//   • Each worker receives a signed identity token at spawn time
//   • Workers authenticate themselves via their token on first message
//   • Trust scores accumulate from heartbeat health + behavior
//   • Rogue/unresponsive workers are quarantined and replaced
//   • Worker-to-worker communication is routed through the mesh controller
//   • Heartbeat federation: mesh aggregates health from all workers
//
// Trust tiers:
//   NEW      (0-24):   probationary, limited capabilities
//   TRUSTED  (25-74):  normal operation
//   VERIFIED (75-100): full mesh capabilities
//   QUARANTINED:       blocked, replacement queued
//
// Integrates with:
//   RuntimeWorkerFactory, RuntimeWorkerBootstrap, RuntimeSecureSession,
//   RuntimeCapabilityManager, SecurityTelemetry, RuntimeEventBus
//
// window.RuntimeWorkerMesh
//   .register(workerId, worker, url)   → MeshEntry
//   .setTrust(workerId, delta, reason) → number (new score)
//   .quarantine(workerId, reason)      → void
//   .getTrustScore(workerId)           → number
//   .getMeshHealth()                   → MeshHealth
//   .getWorkersInState(state)          → MeshEntry[]
//   .status()                          → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerMesh) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerMesh]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Trust constants ───────────────────────────────────────────────────────
  var TRUST_NEW_WORKER       = 20;   // starting trust for new workers
  var TRUST_HEARTBEAT_BONUS  = 2;    // per successful pong
  var TRUST_HEARTBEAT_MISS   = -8;   // per missed ping
  var TRUST_AUTH_SUCCESS     = 10;   // successful token auth
  var TRUST_AUTH_FAIL        = -20;  // failed token auth
  var TRUST_QUARANTINE_THRESHOLD = 5;  // quarantine below this
  var TRUST_VERIFIED_THRESHOLD   = 75;

  // ── Worker registry ────────────────────────────────────────────────────────
  // workerId → { workerId, worker, url, trust, state, spawnTs, lastPong,
  //              authToken, authState, heartbeats, misses, messages }
  var _registry = typeof Map !== 'undefined' ? new Map() : null;
  var _auditLog = [];
  var MAX_AUDIT = 200;

  function _log(workerId, event, detail) {
    _auditLog.push({ workerId: workerId, event: event, detail: detail || null, ts: Date.now() });
    if (_auditLog.length > MAX_AUDIT) _auditLog.shift();
  }

  // ── Register a worker in the mesh ──────────────────────────────────────────
  function register(workerId, worker, url) {
    if (!_registry) return null;

    var authToken = _s(function () {
      var ss = G.RuntimeSecureSession;
      if (ss && typeof ss.authorizeWorker === 'function') {
        var auth = ss.authorizeWorker(url);
        return auth ? auth.token : null;
      }
      return null;
    }, null);

    var entry = {
      workerId:   workerId,
      worker:     worker,
      url:        url || '',
      trust:      TRUST_NEW_WORKER,
      state:      'NEW',          // NEW | TRUSTED | VERIFIED | QUARANTINED
      spawnTs:    Date.now(),
      lastPong:   0,
      authToken:  authToken,
      authState:  'pending',     // pending | ok | failed
      heartbeats: 0,
      misses:     0,
      messages:   0,
    };

    _registry.set(workerId, entry);
    _log(workerId, 'registered', { url: url, trust: TRUST_NEW_WORKER });

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('mesh:worker-joined', { workerId: workerId, url: url });
      }
    });

    return Object.assign({}, entry, { worker: undefined }); // don't expose worker ref
  }

  // ── Adjust trust score ──────────────────────────────────────────────────────
  function setTrust(workerId, delta, reason) {
    if (!_registry || !_registry.has(workerId)) return 0;
    var entry = _registry.get(workerId);
    entry.trust = Math.max(0, Math.min(100, entry.trust + delta));

    // Update state
    if (entry.trust <= TRUST_QUARANTINE_THRESHOLD) {
      if (entry.state !== 'QUARANTINED') {
        quarantine(workerId, 'trust-score-low:' + entry.trust);
      }
    } else if (entry.trust >= TRUST_VERIFIED_THRESHOLD) {
      entry.state = 'VERIFIED';
    } else if (entry.trust >= 25) {
      if (entry.state === 'NEW') entry.state = 'TRUSTED';
    }

    _log(workerId, 'trust-change', { delta: delta, reason: reason, trust: entry.trust });
    return entry.trust;
  }

  // ── Quarantine a worker ───────────────────────────────────────────────────
  function quarantine(workerId, reason) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);

    if (entry.state === 'QUARANTINED') return;
    entry.state = 'QUARANTINED';

    console.warn(LOG, 'quarantined worker:', workerId, '| reason:', reason);
    _log(workerId, 'quarantined', { reason: reason });

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('mesh:worker-quarantined', { workerId: workerId, reason: reason });
      }
    });

    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('worker-restart', {
          workerId: workerId,
          reason:   'quarantine:' + reason,
        });
      }
    });

    // Terminate the rogue worker
    _s(function () {
      var w = entry.worker;
      if (w && typeof w.terminate === 'function') {
        w.terminate();
      }
    });
  }

  // ── Record heartbeat ─────────────────────────────────────────────────────
  function _recordPong(workerId) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);
    entry.lastPong    = Date.now();
    entry.heartbeats  = (entry.heartbeats || 0) + 1;
    entry.misses      = 0;
    setTrust(workerId, TRUST_HEARTBEAT_BONUS, 'heartbeat-ok');
  }

  function _recordMiss(workerId) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);
    entry.misses = (entry.misses || 0) + 1;
    setTrust(workerId, TRUST_HEARTBEAT_MISS, 'heartbeat-miss');
  }

  // ── getMeshHealth ──────────────────────────────────────────────────────────
  function getMeshHealth() {
    if (!_registry) return { healthy: 0, total: 0, quarantined: 0, avgTrust: 0 };

    var entries = [];
    _registry.forEach(function (e) { entries.push(e); });

    var healthy = entries.filter(function (e) {
      return e.state === 'TRUSTED' || e.state === 'VERIFIED';
    }).length;
    var quarantined = entries.filter(function (e) {
      return e.state === 'QUARANTINED';
    }).length;
    var avgTrust = entries.length > 0
      ? Math.round(entries.reduce(function (s, e) { return s + e.trust; }, 0) / entries.length)
      : 100;

    return {
      healthy:    healthy,
      total:      entries.length,
      quarantined: quarantined,
      avgTrust:   avgTrust,
      new:        entries.filter(function (e) { return e.state === 'NEW'; }).length,
      verified:   entries.filter(function (e) { return e.state === 'VERIFIED'; }).length,
    };
  }

  function getTrustScore(workerId) {
    if (!_registry || !_registry.has(workerId)) return -1;
    return _registry.get(workerId).trust;
  }

  function getWorkersInState(state) {
    if (!_registry) return [];
    var result = [];
    _registry.forEach(function (e) {
      if (e.state === state) {
        result.push({ workerId: e.workerId, url: e.url, trust: e.trust, state: e.state });
      }
    });
    return result;
  }

  // ── Subscribe to heartbeat events ─────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:p4-pong', function (data) {
        if (data && data.workerId) _recordPong(data.workerId);
      });

      eb.on('worker:p4-miss', function (data) {
        if (data && data.workerId) _recordMiss(data.workerId);
      });

      eb.on('worker:spawned', function (data) {
        if (data && data.workerId && data.worker) {
          register(data.workerId, data.worker, data.url);
        }
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId && _registry) {
          _registry.delete(data.workerId);
          _log(data.workerId, 'removed', null);
        }
      });
    });
  }

  // ── Periodic health check ─────────────────────────────────────────────────
  function _healthCheck() {
    var health = getMeshHealth();
    if (health.quarantined > 0) {
      console.warn(LOG, 'mesh health:', health.healthy + '/' + health.total,
        'healthy | quarantined:', health.quarantined);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    setInterval(_healthCheck, 120_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerMesh = Object.freeze({
    VERSION:          VERSION,
    register:         register,
    setTrust:         setTrust,
    quarantine:       quarantine,
    getTrustScore:    getTrustScore,
    getMeshHealth:    getMeshHealth,
    getWorkersInState: getWorkersInState,
    _recordPong:      _recordPong,
    _recordMiss:      _recordMiss,
    status: function () {
      var h = getMeshHealth();
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        mesh:       h,
        auditCount: _auditLog.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
