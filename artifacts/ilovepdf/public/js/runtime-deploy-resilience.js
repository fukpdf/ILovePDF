// RuntimeDeployResilience v1.0 — Arc 11 / Phase H
// =============================================================================
// Safe deploy transition management.
//
// Features:
//   - Build migration tracking: monitor active → stale → refreshed state
//   - Pre-deploy snapshots: capture state before a new deploy is applied
//   - Rollback markers: record rollback points in RuntimeBlackboxStorage
//   - Stale tab detection: identify tabs still running old code
//   - Deploy health scoring: assess runtime integrity post-deploy
//
// Integrates with:
//   RuntimeDeploySync — listens to deploy:stale, deploy:new-build events
//   RuntimeStateSnapshots — captures pre-deploy state snapshot
//   RuntimeBlackboxStorage — persists rollback markers and deploy records
//
// Deploy lifecycle states:
//   FRESH    — tab is running the current build
//   STALE    — server has a newer build; this tab is behind
//   UPDATING — user has acknowledged stale; reload in progress
//   ROLLBACK — deploy caused errors; rolling back to known-good state
//
// window.RuntimeDeployResilience
//   .getState()                → { buildState, currentBuild, serverBuild, ts }
//   .capturePreDeploySnapshot() → Promise<snapshotId|null>
//   .markRollback(reason)      → void
//   .getDeployHistory()        → DeployRecord[]
//   .getStaleTabs()            → string[]  (from TabMesh)
//   .getHealthScore()          → number 0-100
//   .getMetrics()              → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeployResilience) return;

  var VERSION = '1.0';
  var LOG     = '[DeployResilience]';

  var HEALTH_WINDOW_MS = 5 * 60 * 1000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _buildState   = 'FRESH';   // FRESH | STALE | UPDATING | ROLLBACK
  var _currentBuild = '';
  var _serverBuild  = '';
  var _stateTs      = Date.now();
  var _history      = [];        // DeployRecord[]
  var _rollbacks    = [];        // { reason, ts, buildId }
  var _metrics      = { deployDetected: 0, snapshots: 0, rollbacks: 0, staleTabs: 0, errors: 0 };
  var _healthEvents = [];        // { ts, ok }

  // ── Build state management ─────────────────────────────────────────────────
  function _setState(newState, extra) {
    if (_buildState !== newState) {
      console.debug(LOG, 'deploy state:', _buildState, '→', newState, extra ? JSON.stringify(extra) : '');
      _buildState = newState;
      _stateTs    = Date.now();
      _s(function () {
        G.dispatchEvent(new CustomEvent('deploy-resilience:state-change', {
          detail: { state: newState, currentBuild: _currentBuild, serverBuild: _serverBuild, ts: _stateTs },
        }));
      });
    }
  }

  // ── Pre-deploy snapshot ────────────────────────────────────────────────────
  function capturePreDeploySnapshot() {
    _metrics.snapshots++;
    return Promise.resolve()
      .then(function () {
        // Take a state snapshot via RuntimeStateSnapshots
        var ss = _s(function () { return G.RuntimeStateSnapshots; }, null);
        if (ss && typeof ss.take === 'function') {
          return ss.take('pre-deploy:' + _serverBuild);
        }
        return null;
      })
      .then(function (snap) {
        if (snap) {
          _s(function () {
            var bbs = G.RuntimeBlackboxStorage;
            if (bbs && bbs.isAvailable()) {
              bbs.store('snapshots', { type: 'pre-deploy', build: _serverBuild, snap: snap, ts: Date.now() });
            }
          });
          console.debug(LOG, 'pre-deploy snapshot captured for build:', _serverBuild);
          return snap.id || 'snap-' + Date.now().toString(36);
        }
        return null;
      })
      .catch(function (e) {
        _metrics.errors++;
        console.warn(LOG, 'pre-deploy snapshot failed:', e.message);
        return null;
      });
  }

  // ── Rollback marker ────────────────────────────────────────────────────────
  function markRollback(reason) {
    _metrics.rollbacks++;
    var rb = { reason: reason || 'manual', ts: Date.now(), buildId: _currentBuild };
    _rollbacks.push(rb);
    _setState('ROLLBACK', rb);
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) {
        bbs.store('recovery_history', { type: 'deploy-rollback', buildId: _currentBuild,
                                        reason: reason, ts: Date.now() });
      }
    });
    console.warn(LOG, 'rollback marker set | reason:', reason, '| build:', _currentBuild);
  }

  // ── Stale tab detection ────────────────────────────────────────────────────
  function getStaleTabs() {
    return _s(function () {
      var tm = G.RuntimeTabMesh;
      if (!tm) return [];
      var tabs = tm.getTabs();
      return tabs
        .filter(function (t) { return !t.self; })
        .map(function (t) { return t.id; });
    }, []);
  }

  // ── Health scoring ─────────────────────────────────────────────────────────
  function _recordHealthEvent(ok) {
    _healthEvents.push({ ts: Date.now(), ok: ok });
    var cutoff = Date.now() - HEALTH_WINDOW_MS;
    _healthEvents = _healthEvents.filter(function (e) { return e.ts >= cutoff; });
  }

  function getHealthScore() {
    if (!_healthEvents.length) return 100;
    var ok = _healthEvents.filter(function (e) { return e.ok; }).length;
    return Math.round((ok / _healthEvents.length) * 100);
  }

  // ── Build deploy record ────────────────────────────────────────────────────
  function _recordDeploy(prevBuild, newBuild) {
    var rec = { prevBuild: prevBuild, newBuild: newBuild, ts: Date.now(),
                state: _buildState, tabStale: getStaleTabs().length };
    _history.push(rec);
    if (_history.length > 50) _history.shift();
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) {
        bbs.store('blackbox_events', { type: 'deploy', detail: rec });
      }
    });
  }

  // ── Bind to RuntimeDeploySync ──────────────────────────────────────────────
  function _bindDeploySync() {
    _s(function () {
      var ds = G.RuntimeDeploySync;
      if (ds) {
        _currentBuild = ds.getBuildId()     || '';
        _serverBuild  = ds.getServerBuild() || _currentBuild;
        if (ds.isStale()) _setState('STALE');
      }
    });

    window.addEventListener('deploy:new-build', function (evt) {
      if (!evt || !evt.detail) return;
      _metrics.deployDetected++;
      var prev = evt.detail.prevBuildId || _currentBuild;
      _serverBuild  = evt.detail.newBuildId || '';
      _setState('STALE', { prevBuild: prev, newBuild: _serverBuild });

      // Capture pre-deploy snapshot before we go stale
      capturePreDeploySnapshot();
      _recordDeploy(prev, _serverBuild);
      _recordHealthEvent(true);
    });

    window.addEventListener('deploy:stale', function () {
      _setState('STALE');
      _recordHealthEvent(false);
      var staleTabs = getStaleTabs();
      _metrics.staleTabs += staleTabs.length;
    });

    window.addEventListener('deploy:sync-ready', function (evt) {
      if (evt && evt.detail) {
        _currentBuild = evt.detail.buildId || _currentBuild;
        if (_buildState === 'FRESH') _recordHealthEvent(true);
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_bindDeploySync, 2000); }, { once: true });
  } else {
    setTimeout(_bindDeploySync, 2000);
  }

  G.RuntimeDeployResilience = Object.freeze({
    VERSION:                  VERSION,
    getState:                 function () {
      return { buildState: _buildState, currentBuild: _currentBuild,
               serverBuild: _serverBuild, ts: _stateTs };
    },
    capturePreDeploySnapshot: capturePreDeploySnapshot,
    markRollback:             markRollback,
    getDeployHistory:         function () { return _history.slice(); },
    getRollbacks:             function () { return _rollbacks.slice(); },
    getStaleTabs:             getStaleTabs,
    getHealthScore:           getHealthScore,
    getMetrics:               function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
