// RuntimeWorkerRouting v1.0 — Phase 7 / Section 2 (Worker Mesh Routing)
// =============================================================================
// Capability-scoped worker pool routing. Routes task requests to the
// appropriate worker pool based on required capabilities and worker health.
//
// Routing strategies:
//   • Capability matching — route to workers with required capability
//   • Load balancing — prefer least-loaded healthy worker
//   • Trust-aware routing — prefer VERIFIED workers over NEW
//   • Quarantine bypass — skip quarantined workers entirely
//   • Fallback routing — if no capable worker exists, queue or fail gracefully
//
// Worker capability declarations:
//   Workers declare their capabilities via their URL path pattern:
//   /workers/pdf-lib-worker.js   → ['pdf', 'wasm', 'compress']
//   /workers/ocr-*               → ['ocr', 'image', 'wasm']
//   /workers/summary-worker.js   → ['ai', 'text']
//   etc.
//
// window.RuntimeWorkerRouting
//   .route(capability, opts)          → workerId|null
//   .registerCapability(workerId, caps[])   → void
//   .getCapableWorkers(cap)           → workerId[]
//   .getRoutingTable()                → RoutingTable
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerRouting) return;

  var VERSION = '1.1';
  var LOG     = '[WorkerRouting]';

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

  // ── Capability inference from URL ──────────────────────────────────────────
  var URL_CAPABILITY_MAP = [
    { pattern: /pdf-lib/,          caps: ['pdf', 'wasm', 'compress', 'merge', 'split'] },
    { pattern: /pdf-worker/,       caps: ['pdf', 'render', 'extract', 'translate', 'repair', 'compare'] },
    { pattern: /compress/,         caps: ['compress', 'pdf', 'image'] },
    { pattern: /pdf-word|docx/,    caps: ['pdf', 'convert', 'word'] },
    { pattern: /pdf-excel|xlsx/,   caps: ['pdf', 'convert', 'excel'] },
    { pattern: /pdf-ppt|pptx/,     caps: ['pdf', 'convert', 'powerpoint'] },
    { pattern: /ocr/,              caps: ['ocr', 'image', 'text-extract'] },
    { pattern: /summary|ai-sum/,   caps: ['ai', 'text', 'summarize'] },
    { pattern: /image-tools|image-pipeline/, caps: ['image', 'resize', 'crop', 'filter'] },
    { pattern: /remove-bg/,        caps: ['image', 'ai', 'background-remove'] },
    { pattern: /advanced/,         caps: ['pdf', 'advanced', 'repair', 'compare'] },
    { pattern: /compare/,          caps: ['pdf', 'compare'] },
    { pattern: /repair/,           caps: ['pdf', 'repair'] },
    { pattern: /shared-cluster/,   caps: ['cluster', 'distribute'] },
  ];

  function _inferCaps(url) {
    if (!url) return ['generic'];
    var caps = [];
    for (var i = 0; i < URL_CAPABILITY_MAP.length; i++) {
      if (URL_CAPABILITY_MAP[i].pattern.test(url)) {
        caps = caps.concat(URL_CAPABILITY_MAP[i].caps);
        break;
      }
    }
    return caps.length > 0 ? caps : ['generic'];
  }

  // ── Routing table: capability → [workerId] ─────────────────────────────────
  var _table   = typeof Map !== 'undefined' ? new Map() : null;  // cap → Set<workerId>
  var _workerCaps = typeof Map !== 'undefined' ? new Map() : null; // workerId → caps[]
  var _workerUrls = typeof Map !== 'undefined' ? new Map() : null;
  var _rrCursor = typeof Map !== 'undefined' ? new Map() : null;
  var _routeCount = 0;

  function _normalizeWorkerId(workerId) {
    if (typeof workerId !== 'string') return null;
    var id = workerId.trim();
    return id && id.length <= 256 ? id : null;
  }

  function _normalizeCapabilities(caps) {
    if (!Array.isArray(caps)) return [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < caps.length; i++) {
      if (typeof caps[i] !== 'string') continue;
      var cap = caps[i].trim().toLowerCase();
      if (!cap || cap.length > 128 || seen[cap]) continue;
      seen[cap] = true;
      out.push(cap);
    }
    return out;
  }

  function _validCapability(capability) {
    return typeof capability === 'string' && capability.trim().length > 0 && capability.trim().length <= 128;
  }

  function registerCapability(workerId, caps) {
    if (!_table || !_workerCaps) return false;
    var id = _normalizeWorkerId(workerId);
    if (!id) return false;
    var normalized = _normalizeCapabilities(caps);
    if (_workerCaps.has(id)) _unregisterWorker(id);
    _workerCaps.set(id, normalized);
    for (var i = 0; i < normalized.length; i++) {
      var cap = normalized[i];
      if (!_table.has(cap)) _table.set(cap, new Set());
      _table.get(cap).add(id);
    }
    return true;
  }

  function _unregisterWorker(workerId) {
    if (!_table || !_workerCaps) return;
    var caps = _workerCaps.get(workerId) || [];
    caps.forEach(function (cap) {
      var workers = _table.get(cap);
      if (workers) workers.delete(workerId);
    });
    _workerCaps.delete(workerId);
    if (_workerUrls) _workerUrls.delete(workerId);
  }

  // ── Route a request ────────────────────────────────────────────────────────
  function route(capability, opts) {
    if (!_enabled || !_table || !_validCapability(capability)) return null;
    opts = opts || {};
    capability = capability.trim().toLowerCase();

    var candidates = _table.has(capability)
      ? Array.from(_table.get(capability))
      : [];

    if (candidates.length === 0) return null;

    // Filter by mesh trust state (skip quarantined)
    var mesh = _s(function () { return G.RuntimeWorkerMesh; }, null);
    if (mesh) {
      candidates = candidates.filter(function (id) {
        var trust = _s(function () { return Number(mesh.getTrustScore(id)); }, -1);
        return Number.isFinite(trust) && trust > 5;  // not quarantined
      });
    }

    if (candidates.length === 0) return null;

    var poolStats = _s(function () { return G.WorkerPool && G.WorkerPool.getStats ? G.WorkerPool.getStats() : null; }, null) || {};
    function loadOf(id) {
      var url = _workerUrls && _workerUrls.get(id);
      if (!url || !poolStats[url]) return 0;
      return (poolStats[url].busy || 0) + (poolStats[url].queued || 0);
    }
    var cursor = _rrCursor ? (_rrCursor.get(capability) || 0) : 0;
    candidates.sort(function (a, b) {
      var ta = mesh ? _s(function () { return Number(mesh.getTrustScore(a)); }, 0) : 0;
      var tb = mesh ? _s(function () { return Number(mesh.getTrustScore(b)); }, 0) : 0;
      if (ta !== tb) return tb - ta;
      return loadOf(a) - loadOf(b);
    });
    var bestLoad = loadOf(candidates[0]);
    var bestTrust = mesh ? _s(function () { return Number(mesh.getTrustScore(candidates[0])); }, 0) : 0;
    var ties = candidates.filter(function (id) {
      return loadOf(id) === bestLoad && (!mesh || _s(function () { return Number(mesh.getTrustScore(id)); }, 0) === bestTrust);
    });
    var picked = ties[cursor % ties.length] || candidates[0];
    if (_rrCursor) _rrCursor.set(capability, cursor + 1);
    _routeCount++;
    return picked;
  }

  function getCapableWorkers(cap) {
    if (!_table || !_validCapability(cap)) return [];
    cap = cap.trim().toLowerCase();
    if (!_table.has(cap)) return [];
    return Array.from(_table.get(cap));
  }

  function getRoutingTable() {
    var result = Object.create(null);
    if (!_table) return result;
    _table.forEach(function (workers, cap) {
      result[cap] = Array.from(workers);
    });
    return result;
  }

  // ── Subscribe to worker lifecycle events ────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:spawned', function (data) {
        if (!data || !data.workerId) return;
        var workerId = _normalizeWorkerId(data.workerId);
        if (!workerId) return;
        var caps = _inferCaps(data.url);
        if (!registerCapability(workerId, caps)) return;
        if (_workerUrls) _workerUrls.set(workerId, data.url || '');
        console.debug(LOG, 'worker registered:', data.workerId, '| caps:', caps.join(','));
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId) _unregisterWorker(data.workerId);
      });

      eb.on('mesh:worker-quarantined', function (data) {
        if (data && data.workerId) _unregisterWorker(data.workerId);
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerRouting = Object.freeze({
    VERSION:            VERSION,
    route:              route,
    registerCapability: registerCapability,
    getCapableWorkers:  getCapableWorkers,
    getRoutingTable:    getRoutingTable,
    status: function () {
      var capCount = _table ? _table.size : 0;
      var workerCount = _workerCaps ? _workerCaps.size : 0;
      return {
        version:     VERSION,
        enabled:     _enabled,
        tier:        _tier,
        capabilities: capCount,
        workers:     workerCount,
        routeCount:  _routeCount,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
