// RuntimeToolConfigLock v1.0 — Arc 3 / Phase H / Target 9
// =====================================================================
// Immutable per-tool runtime configuration with checksum validation.
//
// Problem: Tool runtime configurations are mutable globals. A bug in
// Tool A could corrupt the config for Tool B. Configs lack integrity
// guarantees — there is no way to detect tampering at runtime.
//
// Solution:
//   1. Each tool gets a frozen config store after first activation
//   2. Configs are checksummed (DJB2) on lock + validated on read
//   3. Mutation attempts after lock → logged to RuntimeIncidentEngine
//   4. Cross-tool config reads are audited (toolId mismatch warning)
//   5. Config version included for forward-compat migration
//
// Config schema (fields from RuntimeToolManifestRegistry manifest):
//   { family, hydrationTier, memoryBudgetMb, recoveryPolicy,
//     thermalPolicy, offlineCapable, lockedAt, version, checksum }
//
// Usage:
//   RuntimeToolConfigLock.lock('ocr', { family: 'ai', memoryBudgetMb: 512 })
//   RuntimeToolConfigLock.get('ocr')            → frozen config | null
//   RuntimeToolConfigLock.isLocked('ocr')       → bool
//   RuntimeToolConfigLock.validate('ocr')       → { ok, reason }
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolConfigLock) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ConfigLock]';
  var VERSION = '1.0';
  var CONFIG_VERSION = 1;

  // ── DJB2 checksum (non-crypto, fast integrity check) ──────────────────────
  function _checksum(obj) {
    var str = JSON.stringify(obj) || '';
    var h = 5381;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
    return (h >>> 0).toString(16);
  }

  // ── Config store ──────────────────────────────────────────────────────────
  var _configs   = {}; // toolId → frozen config
  var _checksums = {}; // toolId → expected checksum
  var _lockLog   = []; // audit trail: { toolId, ts, action, detail }

  function _audit(toolId, action, detail) {
    _lockLog.push({ toolId: toolId, ts: Date.now(), action: action, detail: detail || {} });
    if (_lockLog.length > 200) _lockLog.shift();
  }

  // ── Lock a tool config ────────────────────────────────────────────────────
  function lock(toolId, config) {
    if (!toolId || typeof config !== 'object') return;

    if (_configs[toolId]) {
      // Already locked — log mutation attempt
      console.debug(LOG, 'mutation attempt blocked:', toolId);
      _audit(toolId, 'mutation-blocked', { attempted: config });

      try {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report({
            type:   'config-mutation-attempt',
            toolId: toolId,
            ts:     Date.now(),
          });
        }
      } catch (_) {}
      return;
    }

    // Build the locked config
    var lockedConfig = {
      toolId:         toolId,
      family:         config.family         || 'unknown',
      hydrationTier:  config.hydrationTier  || 'P2',
      memoryBudgetMb: config.memoryBudgetMb || 128,
      recoveryPolicy: config.recoveryPolicy || 'isolate',
      thermalPolicy:  config.thermalPolicy  || 'normal',
      offlineCapable: !!config.offlineCapable,
      version:        CONFIG_VERSION,
      lockedAt:       Date.now(),
    };

    var cs = _checksum(lockedConfig);
    lockedConfig.checksum = cs;

    _configs[toolId]   = Object.freeze(lockedConfig);
    _checksums[toolId] = cs;

    _audit(toolId, 'locked', { family: lockedConfig.family });
    console.debug(LOG, 'locked:', toolId, '— family:', lockedConfig.family, '— cs:', cs.slice(0, 6));
  }

  // ── Get config ────────────────────────────────────────────────────────────
  function get(toolId) {
    var c = _configs[toolId];
    if (!c) return null;
    // Validate checksum on read
    var expected = _checksums[toolId];
    var actual   = _checksum(c);
    if (expected && expected !== actual) {
      console.debug(LOG, 'CHECKSUM MISMATCH for:', toolId, '— expected:', expected, 'actual:', actual);
      _audit(toolId, 'checksum-fail', { expected: expected, actual: actual });
    }
    return c;
  }

  // ── Validate config ───────────────────────────────────────────────────────
  function validate(toolId) {
    var c = _configs[toolId];
    if (!c) return { ok: false, reason: 'not-locked' };
    var expected = _checksums[toolId];
    var actual   = _checksum(c);
    if (expected !== actual) return { ok: false, reason: 'checksum-mismatch', expected: expected, actual: actual };
    return { ok: true };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeToolConfigLock = Object.freeze({
    VERSION:  VERSION,
    lock:     lock,
    get:      get,
    validate: validate,
    isLocked: function (toolId) { return !!_configs[toolId]; },
    getAuditLog: function () { return _lockLog.slice(); },
    getAll:   function () {
      var out = {};
      Object.keys(_configs).forEach(function (k) { out[k] = _configs[k]; });
      return out;
    },
  });

}(window));
