// Object URL Registry v1.0 — Final Stabilization
// Central registry for all URL.createObjectURL() calls.
// Prevents blob URL leaks by tracking every URL and providing
// bulk revoke on memory pressure or route teardown.
//
// Usage:
//   const url = window.ObjectURLRegistry.create(blob, owner);
//   window.ObjectURLRegistry.revoke(url);
//   window.ObjectURLRegistry.revokeOwner(owner);
//   window.ObjectURLRegistry.revokeAll();
//   window.ObjectURLRegistry.stats();
//
// owner: any string identifier (e.g. tool slug, component name)
// If owner is omitted, defaults to 'anonymous'.
(function () {
  'use strict';

  if (window.ObjectURLRegistry) return;

  var MAX_URLS = 500;   // safety cap — emit warning and revoke oldest if exceeded

  // Map<url, { owner, created }>
  var _registry = new Map();
  // Map<owner, Set<url>>
  var _byOwner  = new Map();

  function _track(url, owner) {
    owner = owner || 'anonymous';
    _registry.set(url, { owner: owner, created: Date.now() });
    if (!_byOwner.has(owner)) _byOwner.set(owner, new Set());
    _byOwner.get(owner).add(url);

    if (_registry.size > MAX_URLS) {
      // Evict oldest anonymous entry to stay under cap
      var oldest = null;
      var oldestTs = Infinity;
      _registry.forEach(function (meta, u) {
        if (meta.owner === 'anonymous' && meta.created < oldestTs) {
          oldestTs = meta.created;
          oldest = u;
        }
      });
      if (oldest) {
        console.warn('[ObjectURLRegistry] cap exceeded (' + MAX_URLS + '), evicting oldest anonymous URL');
        _revoke(oldest);
      }
    }
  }

  function _revoke(url) {
    var meta = _registry.get(url);
    if (!meta) return;
    _registry.delete(url);
    var ownerSet = _byOwner.get(meta.owner);
    if (ownerSet) {
      ownerSet.delete(url);
      if (ownerSet.size === 0) _byOwner.delete(meta.owner);
    }
    try { URL.revokeObjectURL(url); } catch (_) {}
  }

  function create(blob, owner) {
    var url = URL.createObjectURL(blob);
    _track(url, owner);
    return url;
  }

  function revoke(url) {
    if (!url) return;
    _revoke(url);
  }

  function revokeOwner(owner) {
    if (!owner) return;
    var ownerSet = _byOwner.get(owner);
    if (!ownerSet) return;
    var urls = Array.from(ownerSet);
    urls.forEach(_revoke);
  }

  function revokeAll() {
    var urls = Array.from(_registry.keys());
    urls.forEach(_revoke);
  }

  function stats() {
    var owners = {};
    _byOwner.forEach(function (set, owner) {
      owners[owner] = set.size;
    });
    return {
      total:  _registry.size,
      byOwner: owners,
    };
  }

  // Auto-revoke on pagehide to prevent memory leaks after bfcache
  window.addEventListener('pagehide', function () {
    try { revokeAll(); } catch (_) {}
  }, { passive: true });

  // Hook into MemPressure emergency cleanup
  if (window.MemPressure && window.MemPressure.onPressure) {
    window.MemPressure.onPressure(function () {
      // Revoke anonymous URLs on memory pressure
      revokeOwner('anonymous');
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('object-url-pressure-revoke'); } catch (_) {}
      }
    });
  }

  window.ObjectURLRegistry = { create, revoke, revokeOwner, revokeAll, stats };
  console.debug('[ObjectURLRegistry] ready — tracks all Object URLs');
}());
