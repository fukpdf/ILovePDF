// SharedCore v1.0 — Phase 2 Microfrontend Architecture
// Declarative namespace that bridges existing platform services to isolated ToolApps.
// ToolApps communicate ONLY via SharedCore.events — never touching platform globals directly.
// MUST NOT contain: OCR, PDF conversion, DOCX generation, worker orchestration,
// scheduler queues, processing state, memory cleanup, or runtime locks.
(function (G) {
  'use strict';
  if (G.SharedCore) return;

  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return (fallback !== undefined ? fallback : null); }
  }

  // ── Local event bus (with RuntimeEventBus bridge when available) ───────────
  var _handlers = {};

  var events = {
    emit: function (name, data) {
      _safe(function () { if (G.RuntimeEventBus && G.RuntimeEventBus.emit) G.RuntimeEventBus.emit(name, data); });
      var arr = _handlers[name];
      if (arr) arr.slice().forEach(function (h) { _safe(function () { h(data); }); });
    },
    on: function (name, handler) {
      if (!_handlers[name]) _handlers[name] = [];
      _handlers[name].push(handler);
    },
    off: function (name, handler) {
      var arr = _handlers[name];
      if (!arr) return;
      var i = arr.indexOf(handler);
      if (i !== -1) arr.splice(i, 1);
    },
    offAll: function (prefix) {
      Object.keys(_handlers).forEach(function (k) {
        if (k === prefix || k.indexOf(prefix + ':') === 0) delete _handlers[k];
      });
    },
  };

  // ── Auth bridge ────────────────────────────────────────────────────────────
  var auth = {
    getUser:    function () { return _safe(function () { return G.AuthUI && G.AuthUI.getUser && G.AuthUI.getUser(); }); },
    isLoggedIn: function () { return _safe(function () { return !!(G.AuthUI && G.AuthUI.isLoggedIn && G.AuthUI.isLoggedIn()); }, false); },
  };

  // ── Analytics bridge ───────────────────────────────────────────────────────
  var analytics = {
    track: function (event, data) {
      _safe(function () { if (G.RuntimeTelemetry && G.RuntimeTelemetry.record) G.RuntimeTelemetry.record(event, data); });
    },
  };

  // ── Navigation bridge ──────────────────────────────────────────────────────
  var navigation = {
    getToolId: function () {
      var path = (G.location && G.location.pathname) || '';
      return path.replace(/^\/+/, '').split('/')[0] || '';
    },
  };

  // ── Translation bridge ─────────────────────────────────────────────────────
  var i18n = {
    t: function (key, fallback) {
      return _safe(function () { return (G.t && G.t(key)) || fallback; }) || fallback || key;
    },
  };

  G.SharedCore = Object.freeze({
    version:    '1.0',
    events:     events,
    auth:       auth,
    analytics:  analytics,
    navigation: navigation,
    i18n:       i18n,
  });

  console.debug('[SharedCore v1.0] ready');
}(window));
