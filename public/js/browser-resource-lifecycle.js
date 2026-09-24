// Phase 3 Unit 4 — Browser Resource Lifecycle
// Central, idempotent cleanup scope for temporary browser resources:
// Object URLs, transferable buffers, and workers.
// This layer is additive and bridges the existing ObjectURLRegistry and
// WorkerLifecycle APIs without replacing them.
(function () {
  'use strict';
  if (window.BrowserResourceLifecycle) return;

  var _scopes = new Map();
  var _buffers = new Map();
  var _next = 0;

  function id(prefix) {
    _next = (_next + 1) % 1000000000;
    return prefix + '-' + Date.now().toString(36) + '-' + _next.toString(36);
  }

  function scope(owner) {
    var key = owner || id('scope');
    if (!_scopes.has(key)) {
      _scopes.set(key, { owner: key, urls: new Set(), workers: new Set(), buffers: new Set(), created: Date.now() });
    }
    return key;
  }

  function get(key) { return _scopes.get(key); }

  function trackUrl(url, owner) {
    if (!url) return url;
    var s = get(scope(owner));
    s.urls.add(url);
    return url;
  }

  function createUrl(blob, owner) {
    var key = scope(owner);
    var url = window.ObjectURLRegistry
      ? window.ObjectURLRegistry.create(blob, key)
      : URL.createObjectURL(blob);
    trackUrl(url, key);
    return url;
  }

  function revokeUrl(url) {
    if (!url) return;
    if (window.ObjectURLRegistry) window.ObjectURLRegistry.revoke(url);
    else try { URL.revokeObjectURL(url); } catch (_) {}
    _scopes.forEach(function (s) { s.urls.delete(url); });
  }

  function trackBuffer(buffer, owner) {
    if (!buffer || (typeof buffer !== 'object' && typeof buffer !== 'function')) return buffer;
    var key = scope(owner);
    var token = id('buffer');
    _buffers.set(token, { owner: key, buffer: buffer, created: Date.now() });
    get(key).buffers.add(token);
    return buffer;
  }

  function releaseBuffer(buffer) {
    _buffers.forEach(function (meta, token) {
      if (meta.buffer === buffer) {
        _buffers.delete(token);
        var s = get(meta.owner);
        if (s) s.buffers.delete(token);
      }
    });
  }

  function trackWorker(worker, owner) {
    if (!worker) return worker;
    var s = get(owner);
    s.workers.add(worker);
    return worker;
  }

  function releaseWorker(worker) {
    if (!worker) return;
    if (window.WorkerLifecycle) window.WorkerLifecycle.release(worker);
    else try { worker.terminate(); } catch (_) {}
    _scopes.forEach(function (s) { s.workers.delete(worker); });
  }

  function release(owner) {
    var s = get(owner);
    if (!s) return;
    Array.from(s.urls).forEach(revokeUrl);
    Array.from(s.workers).forEach(releaseWorker);
    Array.from(s.buffers).forEach(function (token) {
      _buffers.delete(token);
      s.buffers.delete(token);
    });
    _scopes.delete(owner);
  }

  function releaseAll() {
    Array.from(_scopes.keys()).forEach(release);
    _buffers.clear();
  }

  function stats() {
    var workers = 0, urls = 0, buffers = _buffers.size;
    _scopes.forEach(function (s) {
      workers += s.workers.size;
      urls += s.urls.size;
    });
    return { scopes: _scopes.size, workers: workers, urls: urls, buffers: buffers };
  }

  // Memory pressure: release only explicitly anonymous/ephemeral resources.
  // Active tool scopes stay intact so an in-progress preview is not broken.
  function onMemoryPressure() {
    if (window.ObjectURLRegistry) {
      try { window.ObjectURLRegistry.revokeOwner('anonymous'); } catch (_) {}
    }
    _buffers.forEach(function (meta, token) {
      if (meta.owner === 'anonymous' || meta.owner.indexOf('ephemeral-') === 0) {
        _buffers.delete(token);
        var s = get(meta.owner);
        if (s) s.buffers.delete(token);
      }
    });
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('p3-browser-resource-pressure-release'); } catch (_) {}
    }
  }

  if (window.MemPressure && window.MemPressure.onPressure) {
    window.MemPressure.onPressure(onMemoryPressure);
  }
  window.addEventListener('pagehide', releaseAll, { passive: true });

  window.BrowserResourceLifecycle = Object.freeze({
    scope: scope,
    createUrl: createUrl,
    revokeUrl: revokeUrl,
    trackBuffer: trackBuffer,
    releaseBuffer: releaseBuffer,
    trackWorker: trackWorker,
    releaseWorker: releaseWorker,
    release: release,
    releaseAll: releaseAll,
    stats: stats,
  });

  console.debug('[BrowserResourceLifecycle] ready — Phase 3 Unit 4');
}());
