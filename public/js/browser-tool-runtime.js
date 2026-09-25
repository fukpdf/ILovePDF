// Browser Tool Runtime v1.0 — canonical boundary for registry tools declared "browser".
// Keeps existing browser processors intact while giving every non-worker tool the
// same RuntimeScheduler lifecycle, cancellation and dedupe boundary as worker tools.
(function (G) {
  'use strict';
  if (G.BrowserToolRuntime) return;

  var active = new Map();
  var TIMEOUT_MS = 0;

  function dedupeKey(toolId, files, opts) {
    var list = Array.isArray(files) ? files : [];
    var fileKey = list.map(function (file) {
      return [
        file && file.name || '',
        file && file.size || 0,
        file && file.lastModified || 0,
        file && file.type || ''
      ].join(':');
    }).join('|');
    var optionKey = '';
    try { optionKey = JSON.stringify(opts || {}); } catch (_) { optionKey = ''; }
    return ['browser', toolId || '', fileKey, optionKey].join(':');
  }

  async function dispatch(toolId, files, opts, onProgress, token) {
    if (!toolId) throw new Error('Browser tool id is required');
    if (!G.BrowserTools || typeof G.BrowserTools.process !== 'function') {
      throw new Error('BrowserTools processor is unavailable — canonical browser runtime cannot execute');
    }
    if (!G.RuntimeScheduler || typeof G.RuntimeScheduler.run !== 'function') {
      throw new Error('RuntimeScheduler is unavailable — canonical browser runtime cannot execute');
    }

    var key = dedupeKey(toolId, files, opts);
    if (active.has(toolId)) throw new Error('Tool is already processing');

    var runToken = token || null;
    active.set(toolId, { key: key, token: runToken });
    try {
      if (runToken && runToken.cancelled) throw new Error('Processing cancelled');
      return await G.RuntimeScheduler.run(
        'browser:' + toolId,
        function (schedulerToken, progress) {
          if (schedulerToken && schedulerToken.cancelled) throw new Error('Processing cancelled');
          if (typeof onProgress === 'function' && typeof progress === 'function') {
            onProgress(progress);
          }
          return G.BrowserTools.process(toolId, files, opts || {});
        },
        { token: runToken, timeoutMs: TIMEOUT_MS, label: 'browser:' + toolId }
      );
    } finally {
      active.delete(toolId);
    }
  }

  function cancel(toolId, reason) {
    var item = active.get(toolId);
    if (!item) return false;
    if (item.token && typeof item.token.cancel === 'function') {
      item.token.cancel(reason || 'cancelled');
    }
    return true;
  }

  function cancelAll(reason) {
    var count = 0;
    active.forEach(function (item) {
      if (item.token && typeof item.token.cancel === 'function') {
        item.token.cancel(reason || 'cancelled');
        count++;
      }
    });
    return count;
  }

  function isActive(toolId) {
    return active.has(toolId);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function (event) {
      if (event && event.persisted) return;
      cancelAll('pagehide');
    }, { passive: true });
  }

  G.BrowserToolRuntime = Object.freeze({
    dispatch: dispatch,
    execute: dispatch,
    cancel: cancel,
    cancelAll: cancelAll,
    isActive: isActive,
    dedupeKey: dedupeKey,
    TIMEOUT_MS: TIMEOUT_MS
  });
}(window));
