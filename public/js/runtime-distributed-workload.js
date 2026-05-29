// RuntimeDistributedWorkload v1.0 — Arc 11 / Phase E
// =============================================================================
// Cross-tab workload balancing and lease management.
//
// Responsibilities:
//   - Workload leasing: claim work units distributed by the mesh leader
//   - Ownership tracking: one tab owns each workload unit at a time
//   - Duplicate prevention: singleton guard via leaseId
//   - Thermal-aware distribution: hotter tabs reject new leases
//   - Idle tab detection: tabs with no active workloads can absorb more
//   - Overload detection: tabs at capacity signal back-pressure
//
// Integrates with:
//   RuntimeTabMesh  — receives WORKLOAD_OFFER, sends WORKLOAD_ACK / WORKLOAD_DONE
//
// window.RuntimeDistributedWorkload
//   .submitWorkload(type, data)   → leaseId (leader distributes; peers claim)
//   .getActiveLeases()            → Lease[]
//   .getCapacity()                → { active, max, thermal, canAccept }
//   .releaseAll()                 → void
//   .getMetrics()                 → MetricsObject
//   ._onWorkloadOffer(offer, tid) — internal hook called by RuntimeTabMesh
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDistributedWorkload) return;

  var VERSION = '1.0';
  var LOG     = '[DistributedWorkload]';

  var MAX_LEASES_DEFAULT   = 3;
  var THERMAL_HOT_SKIP     = true;   // hot/critical thermal → skip new work
  var LEASE_TIMEOUT_MS     = 30000;  // auto-expire claimed but un-completed leases
  var METRICS_WINDOW_MS    = 60000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _leases   = {};   // leaseId → { leaseId, type, ts, status, tabId, data }
  var _metrics  = { offered: 0, claimed: 0, completed: 0, rejected: 0, expired: 0, errors: 0 };
  var _maxLeases = MAX_LEASES_DEFAULT;

  // ── Capacity ───────────────────────────────────────────────────────────────
  function getCapacity() {
    var active  = Object.keys(_leases).filter(function (id) { return _leases[id].status === 'active'; }).length;
    var thermal = _s(function () {
      var tm = G.RuntimeTabMesh;
      return tm ? tm.getThermalState().level : 'nominal';
    }, 'nominal');
    var canAccept = active < _maxLeases && (!THERMAL_HOT_SKIP || (thermal !== 'hot' && thermal !== 'critical'));
    return { active: active, max: _maxLeases, thermal: thermal, canAccept: canAccept };
  }

  // ── Claim a workload offer from another tab ────────────────────────────────
  function _onWorkloadOffer(offer, fromTab) {
    if (!offer || !offer.leaseId) return;
    // Prevent duplicate claims
    if (_leases[offer.leaseId]) return;

    var cap = getCapacity();
    if (!cap.canAccept) {
      _metrics.rejected++;
      return;
    }

    // Claim the lease
    var leaseId = offer.leaseId;
    _leases[leaseId] = {
      leaseId:  leaseId,
      type:     offer.type || 'generic',
      ts:       Date.now(),
      status:   'active',
      tabId:    _tabId(),
      fromTab:  fromTab,
      data:     offer.data || null,
    };
    _metrics.claimed++;

    // Acknowledge back through TabMesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.broadcast === 'function') {
        tm.broadcast('WORKLOAD_ACK', { leaseId: leaseId });
      }
    });

    // Auto-expire after LEASE_TIMEOUT_MS
    setTimeout(function () {
      if (_leases[leaseId] && _leases[leaseId].status === 'active') {
        _leases[leaseId].status = 'expired';
        _metrics.expired++;
        console.debug(LOG, 'lease expired:', leaseId);
      }
    }, LEASE_TIMEOUT_MS);

    console.debug(LOG, 'lease claimed:', leaseId, 'type:', offer.type);
  }

  // ── Submit workload (leader distributes, or self-executes if solo) ─────────
  function submitWorkload(type, data) {
    var tm = _s(function () { return G.RuntimeTabMesh; }, null);
    if (tm && typeof tm.broadcastWorkload === 'function' && tm.isLeader()) {
      var leaseId = tm.broadcastWorkload({ type: type, data: data });
      _metrics.offered++;
      return leaseId;
    }
    // Single-tab or non-leader: self-execute
    var selfId = 'local_' + Date.now().toString(36);
    _leases[selfId] = { leaseId: selfId, type: type, ts: Date.now(), status: 'active', tabId: _tabId(), data: data };
    _metrics.claimed++;
    return selfId;
  }

  // ── Complete a lease ───────────────────────────────────────────────────────
  function completeLease(leaseId) {
    if (!_leases[leaseId]) return false;
    _leases[leaseId].status = 'done';
    _leases[leaseId].doneTs = Date.now();
    _metrics.completed++;
    // Notify mesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.broadcast === 'function') tm.broadcast('WORKLOAD_DONE', { leaseId: leaseId });
    });
    return true;
  }

  function releaseAll() {
    Object.keys(_leases).forEach(function (id) { _leases[id].status = 'released'; });
  }

  function getActiveLeases() {
    return Object.keys(_leases)
      .filter(function (id) { return _leases[id].status === 'active'; })
      .map(function (id) { return Object.assign({}, _leases[id]); });
  }

  function _tabId() {
    return _s(function () { var tm = G.RuntimeTabMesh; return tm ? tm.status().tabId : 'local'; }, 'local');
  }

  // ── Periodic expired lease cleanup ─────────────────────────────────────────
  setInterval(function () {
    var cutoff = Date.now() - METRICS_WINDOW_MS * 2;
    Object.keys(_leases).forEach(function (id) {
      var w = _leases[id];
      if ((w.status === 'done' || w.status === 'expired' || w.status === 'released') && w.ts < cutoff) {
        delete _leases[id];
      }
    });
  }, METRICS_WINDOW_MS);

  // ── Boot ───────────────────────────────────────────────────────────────────
  console.debug(LOG, 'v' + VERSION + ' ready | maxLeases:', _maxLeases);

  G.RuntimeDistributedWorkload = Object.freeze({
    VERSION:          VERSION,
    submitWorkload:   submitWorkload,
    completeLease:    completeLease,
    releaseAll:       releaseAll,
    getActiveLeases:  getActiveLeases,
    getCapacity:      getCapacity,
    getMetrics:       function () { return Object.assign({}, _metrics); },
    _onWorkloadOffer: _onWorkloadOffer,
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
