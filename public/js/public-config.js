/* public-config.js — Phase 1 admin-config → public-config foundation.
 *
 * Fetches GET /api/config/public (server.js) and exposes:
 *   window.PublicConfigReady        — a Promise that ALWAYS resolves (never
 *                                      rejects) with a valid config object,
 *                                      even on network failure/timeout/
 *                                      malformed JSON — safe static defaults
 *                                      are used in that case.
 *   window.applyPublicToolOverrides(cfg) — mutates window.TOOL_GROUPS in
 *                                      place (visible/featured/beta/sort
 *                                      order/description/badge). Must be
 *                                      called after chrome.js has defined
 *                                      TOOL_GROUPS and before any code reads
 *                                      it for rendering.
 *
 * This file does NOT duplicate or replace the existing tools-config.js /
 * chrome.js tool registry — it only applies validated overrides on top of it.
 * If the config API is unavailable for any reason, TOOL_GROUPS is left
 * completely untouched and the site behaves exactly as it did before this
 * file existed.
 */
(function (G) {
  'use strict';

  var CONFIG_URL = '/api/config/public';
  var FETCH_TIMEOUT_MS = 2500; // never let a slow/dead API delay first paint meaningfully

  var SAFE_DEFAULTS = {
    featureFlags: {}, toolOverrides: {}, announcement: null, siteConfig: {}, _fallback: true,
  };

  function timeoutNull(ms) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); });
  }

  function isValidConfig(c) {
    return !!(c && typeof c === 'object' &&
      c.featureFlags && typeof c.featureFlags === 'object' &&
      c.toolOverrides && typeof c.toolOverrides === 'object' &&
      c.siteConfig && typeof c.siteConfig === 'object');
  }

  function fetchConfig() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var fetchPromise = fetch(CONFIG_URL, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('bad status ' + r.status); return r.json(); })
      .catch(function () { return null; });
    return Promise.race([fetchPromise, timeoutNull(FETCH_TIMEOUT_MS)]).catch(function () { return null; });
  }

  G.PublicConfigReady = fetchConfig().then(function (cfg) {
    return isValidConfig(cfg) ? cfg : SAFE_DEFAULTS;
  }).catch(function () {
    return SAFE_DEFAULTS; // belt-and-braces — this promise must never reject
  });

  G.PublicConfigResolved = SAFE_DEFAULTS;
  G.PublicConfigReady.then(function (cfg) { G.PublicConfigResolved = cfg; });

  function stripTags(s) {
    return (typeof s === 'string') ? s.replace(/[<>]/g, '') : s;
  }

  G.applyPublicToolOverrides = function (cfg) {
    if (!cfg || !cfg.toolOverrides || !Array.isArray(G.TOOL_GROUPS)) return;
    var overrides = cfg.toolOverrides;

    G.TOOL_GROUPS.forEach(function (group) {
      if (!Array.isArray(group.items)) return;

      group.items.forEach(function (tool) {
        var id = tool.tid || (tool.url ? tool.url.replace(/^\/+/, '') : null);
        if (!id) return;
        var ov = overrides[id];
        if (!ov) return;

        tool._visible          = ov.visible !== false;
        tool._featured         = !!ov.featured;
        tool._beta              = !!ov.beta;
        if (typeof ov.sortOrder === 'number') tool._sortOrder = ov.sortOrder;
        if (ov.description) tool._customDescription = stripTags(ov.description);
        if (ov.badge)        tool._customBadge       = stripTags(ov.badge);
      });

      group.items = group.items
        .filter(function (t) { return t._visible !== false; })
        .sort(function (a, b) {
          var ao = typeof a._sortOrder === 'number' ? a._sortOrder : 0;
          var bo = typeof b._sortOrder === 'number' ? b._sortOrder : 0;
          return ao - bo;
        });
    });
  };
})(window);
