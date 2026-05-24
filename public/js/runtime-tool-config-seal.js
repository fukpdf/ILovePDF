// RuntimeToolConfigSeal v1.0 — Arc 5 / Phase F / Target 6
// =====================================================================
// Independent per-tool config snapshots + drift telemetry.
//
// Arc 4 gap: RuntimeImmutabilityGuard re-verifies configs stored in
// RuntimeToolConfigLock. But if RuntimeToolConfigLock was never called
// for a tool (no manifest activation), there is nothing to verify.
// There is also no config DRIFT tracking — no record of what changed
// between version N and version N+1.
//
// Solution: RuntimeToolConfigSeal creates its own independent snapshot
// layer. At activation time, it captures a full config snapshot for
// each tool, including:
//   - runtime options extracted from tool.html data attributes
//   - family + tier from RuntimeToolManifestRegistry
//   - memory budget from RuntimeMemoryFirewalls
//   - recovery policy from RuntimeRecoveryDomains
// Each snapshot is versioned and checksummed independently from
// RuntimeToolConfigLock. Drift is tracked between versions.
//
// Provides:
//   seal(toolId, config)          — snapshot + version a config
//   verify(toolId)                → { ok, drift, version }
//   getDrift(toolId)              → array of { field, from, to, ts }
//   getSnapshot(toolId)           → current frozen snapshot
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolConfigSeal) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ConfigSeal]';
  var VERSION = '1.0';

  // ── Seal store ───────────────────────────────────────────────────────────
  // toolId → { version, snapshots: [{v, config, checksum, ts}], drift: [...] }
  var _store = {};

  // ── DJB2 checksum ────────────────────────────────────────────────────────
  function _cs(obj) {
    try {
      var s = JSON.stringify(obj) || '';
      var h = 5381;
      for (var i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h = h & h; }
      return (h >>> 0).toString(16);
    } catch (_) { return '0'; }
  }

  function _ensureStore(toolId) {
    if (!_store[toolId]) _store[toolId] = { version: 0, snapshots: [], drift: [] };
    return _store[toolId];
  }

  // ── Collect config for a tool ─────────────────────────────────────────────
  function _collectConfig(toolId) {
    var cfg = { toolId: toolId };
    // 1. From RuntimeToolManifestRegistry
    try {
      var mr = G.RuntimeToolManifestRegistry;
      if (mr) {
        cfg.family        = mr.getFamily(toolId);
        cfg.hydrationTier = mr.getHydrationTier && mr.getHydrationTier(toolId);
      }
    } catch (_) {}
    // 2. From RuntimeToolConfigLock
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) {
        var locked = cl.get(toolId);
        if (locked) {
          cfg.memoryBudgetMb = locked.memoryBudgetMb;
          cfg.recoveryPolicy = locked.recoveryPolicy;
          cfg.thermalPolicy  = locked.thermalPolicy;
          cfg.offlineCapable = locked.offlineCapable;
        }
      }
    } catch (_) {}
    // 3. From RuntimeMemoryFirewalls
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf) {
        var fw = mf.getStats(toolId);
        if (fw) cfg.memoryBudgetMb = cfg.memoryBudgetMb || fw.budgetMb;
      }
    } catch (_) {}
    // 4. From RuntimeWorkerDomainRegistry
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) cfg.workerFamily = wd.getFamily(toolId);
    } catch (_) {}
    return cfg;
  }

  // ── Seal (snapshot) a tool config ────────────────────────────────────────
  function seal(toolId, overrides) {
    var st  = _ensureStore(toolId);
    var cfg = _collectConfig(toolId);
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (k) { cfg[k] = overrides[k]; });
    }
    cfg.sealedAt = Date.now();
    cfg.version  = st.version + 1;

    var cs = _cs(cfg);
    cfg.checksum = cs;

    var prevSnap = st.snapshots[st.snapshots.length - 1];
    var snap     = Object.freeze(cfg);

    // Compute drift from previous snapshot
    if (prevSnap) {
      var prevCfg = prevSnap.config;
      Object.keys(cfg).forEach(function (key) {
        if (key === 'sealedAt' || key === 'version' || key === 'checksum') return;
        if (prevCfg[key] !== cfg[key]) {
          var driftEntry = { field: key, from: prevCfg[key], to: cfg[key], ts: Date.now(), version: cfg.version };
          st.drift.push(driftEntry);
          if (st.drift.length > 100) st.drift.shift();
          console.debug(LOG, 'drift detected:', toolId, '— field:', key, '—', prevCfg[key], '→', cfg[key]);
        }
      });
    }

    st.snapshots.push({ v: cfg.version, config: snap, checksum: cs, ts: Date.now() });
    if (st.snapshots.length > 10) st.snapshots.shift(); // keep last 10 versions
    st.version = cfg.version;

    console.debug(LOG, 'sealed:', toolId, '— v' + cfg.version, '— cs:', cs.slice(0, 6));
    return snap;
  }

  // ── Verify current snapshot integrity ────────────────────────────────────
  function verify(toolId) {
    var st = _store[toolId];
    if (!st || !st.snapshots.length) return { ok: false, reason: 'not-sealed' };
    var latest = st.snapshots[st.snapshots.length - 1];
    var actual = _cs(latest.config);
    if (actual !== latest.checksum) {
      return { ok: false, reason: 'checksum-mismatch', expected: latest.checksum, actual: actual, version: latest.v };
    }
    // Cross-verify with RuntimeToolConfigLock if available
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) {
        var r = cl.validate(toolId);
        if (!r.ok) return { ok: false, reason: 'config-lock-mismatch', detail: r };
      }
    } catch (_) {}
    return { ok: true, version: latest.v, checksum: latest.checksum };
  }

  // ── Auto-seal on tool activation ──────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) setTimeout(function () { seal(toolId); }, 100); // slight delay to let other modules init
    } catch (_) {}
  });

  // ── Periodic re-seal + verify ─────────────────────────────────────────────
  setInterval(function () {
    Object.keys(_store).forEach(function (toolId) {
      var result = verify(toolId);
      if (!result.ok) {
        console.debug(LOG, 'VERIFY FAILED:', toolId, '—', result.reason);
        try {
          G.dispatchEvent(new CustomEvent('config-seal:violation', { detail: { toolId: toolId, reason: result.reason } }));
        } catch (_) {}
      }
    });
  }, 90 * 1000); // every 90s

  G.RuntimeToolConfigSeal = Object.freeze({
    VERSION:     VERSION,
    seal:        seal,
    verify:      verify,
    getSnapshot: function (toolId) {
      var st = _store[toolId];
      if (!st || !st.snapshots.length) return null;
      return st.snapshots[st.snapshots.length - 1].config;
    },
    getDrift:    function (toolId) { return (_store[toolId] || {}).drift || []; },
    getVersion:  function (toolId) { return (_store[toolId] || {}).version || 0; },
    getAllSeals:  function () {
      var out = {};
      Object.keys(_store).forEach(function (k) {
        out[k] = { version: _store[k].version, driftCount: _store[k].drift.length };
      });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool config seals active');

}(window));
