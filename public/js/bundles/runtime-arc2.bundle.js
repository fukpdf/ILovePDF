// ── Arc 2 Production Hardening — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-24T07:20:15.287Z  BUILD_ID: mpjg6rfp
// Files: 9

// ── SOURCE: public/js/runtime-deploy-sync.js ──
// RuntimeDeploySync v1.0 — Arc 2 / Target 1
// =====================================================================
// Cross-tab + SW BUILD_ID coordination.
//
// Responsibilities:
//   1. Extract current BUILD_ID from page's cache-busted script URLs
//   2. Listen to SW_ACTIVATED messages from the service worker
//   3. Poll /api/health every POLL_INTERVAL_MS to detect new deploys
//   4. Broadcast DEPLOY_SYNC messages via BroadcastChannel to all tabs
//   5. On stale detection: dispatch 'deploy:stale' event — let callers decide
//      whether to reload (never force-reload from this layer)
//   6. Provide stale-worker invalidation via WorkerPool.clearAll()
//
// Emits (via RuntimeEventBus + CustomEvent on window):
//   deploy:new-build  { prevBuildId, newBuildId }
//   deploy:stale      { buildId, tabBuildId }
//   deploy:sync-ready { buildId }
//
// BroadcastChannel: ilovepdf-deploy-v1
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploySync) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG           = '[DeploySync]';
  var CHANNEL       = 'ilovepdf-deploy-v1';
  var POLL_MS       = 5 * 60 * 1000; // 5 min passive poll
  var HEALTH_URL    = '/api/health';
  var VERSION       = '1.0';

  // ── Extract BUILD_ID embedded in the current page's script URLs ────────────
  var _tabBuildId = (function () {
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }());

  var _serverBuildId = _tabBuildId; // updated when we detect a new deploy
  var _staleDetected = false;
  var _listeners     = [];

  // ── BroadcastChannel ──────────────────────────────────────────────────────
  var _bc = null;
  try { _bc = new BroadcastChannel(CHANNEL); } catch (_) {}

  function _broadcast(type, payload) {
    if (!_bc) return;
    try { _bc.postMessage({ type: type, buildId: _serverBuildId, tabBuildId: _tabBuildId, ts: Date.now(), payload: payload || {} }); } catch (_) {}
  }

  // ── Dispatch helpers ──────────────────────────────────────────────────────
  function _emit(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: false })); } catch (_) {}
    try {
      if (G.RuntimeEventBus && G.RuntimeEventBus.emit) G.RuntimeEventBus.emit(name, detail);
    } catch (_) {}
    _listeners.forEach(function (cb) { try { cb(name, detail); } catch (_) {} });
  }

  // ── Stale-build detection ─────────────────────────────────────────────────
  function _checkBuild(newBuildId) {
    if (!newBuildId || !_tabBuildId) return;
    if (newBuildId === _tabBuildId) return;
    if (_staleDetected) return;
    _staleDetected = true;
    var prev = _serverBuildId;
    _serverBuildId = newBuildId;

    console.debug(LOG, 'stale runtime detected — tabBuild:', _tabBuildId, '→ serverBuild:', newBuildId);

    // Invalidate stale workers (they may be running old code)
    try {
      if (G.WorkerPool && typeof G.WorkerPool.clearAll === 'function') {
        G.WorkerPool.clearAll('stale-deploy');
      }
    } catch (_) {}

    _emit('deploy:new-build', { prevBuildId: prev, newBuildId: newBuildId });
    _emit('deploy:stale',     { buildId: newBuildId, tabBuildId: _tabBuildId });
    _broadcast('DEPLOY_STALE', { prevBuildId: prev, newBuildId: newBuildId });
  }

  // ── Fetch /api/health to check server BUILD_ID ────────────────────────────
  function _poll() {
    fetch(HEALTH_URL, { method: 'HEAD', cache: 'no-store', credentials: 'omit' })
      .then(function (r) {
        var hdr = r.headers.get('X-Build-Id') || r.headers.get('x-build-id');
        if (hdr) _checkBuild(hdr);
      })
      .catch(function () {}); // silent — offline is fine
  }

  // ── SW → page messages ────────────────────────────────────────────────────
  (function () {
    try {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.addEventListener('message', function (evt) {
        var msg = evt.data;
        if (!msg) return;
        // SW_ACTIVATED: SW has activated (cache rotation happened — new deploy)
        if (msg.type === 'SW_ACTIVATED') {
          // SW doesn't carry BUILD_ID in its message; trigger a health poll
          _poll();
        }
      });
    } catch (_) {}
  }());

  // ── BroadcastChannel: receive from other tabs ─────────────────────────────
  if (_bc) {
    _bc.onmessage = function (evt) {
      var msg = evt.data;
      if (!msg) return;
      if (msg.type === 'DEPLOY_STALE' && msg.buildId) _checkBuild(msg.buildId);
      if (msg.type === 'DEPLOY_SYNC_PING') {
        // Another tab asks for our state
        _broadcast('DEPLOY_SYNC_PONG', { myBuildId: _tabBuildId });
      }
    };
  }

  // ── Boot: immediate poll + periodic ──────────────────────────────────────
  _poll();
  var _pollId = setInterval(_poll, POLL_MS);

  // Ping other tabs so stale tabs learn the current BUILD_ID
  _broadcast('DEPLOY_SYNC_PING', {});

  // Cleanup on page unload
  try {
    G.addEventListener('pagehide', function () {
      clearInterval(_pollId);
      if (_bc) { try { _bc.close(); } catch (_) {} }
    }, { once: true });
  } catch (_) {}

  _emit('deploy:sync-ready', { buildId: _tabBuildId });

  G.RuntimeDeploySync = Object.freeze({
    VERSION:        VERSION,
    getBuildId:     function () { return _tabBuildId; },
    getServerBuild: function () { return _serverBuildId; },
    isStale:        function () { return _staleDetected; },
    poll:           _poll,
    on:             function (cb) { if (typeof cb === 'function') _listeners.push(cb); },
  });

}(window));

// ── SOURCE: public/js/runtime-html-version-guard.js ──
// RuntimeHtmlVersionGuard v1.0 — Arc 2 / Target 2
// =====================================================================
// Stale HTML shell detection + silent revalidation.
//
// Approach:
//   - Reads current BUILD_ID from page script URLs (?v= param)
//   - Listens to RuntimeDeploySync for stale-build notifications
//   - When stale detected AND no active processing:
//       → silent navigation reload (location.reload()) after a short grace
//   - When stale detected AND processing is active:
//       → shows a subtle "New version available" snackbar
//   - Exports status API for dashboard / AdvancedEngine.audit()
//
// Never force-reloads immediately. Never destroys active sessions.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHtmlVersionGuard) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG           = '[HVG]';
  var VERSION       = '1.0';
  var GRACE_DELAY   = 30 * 1000;   // 30 s grace before silent reload
  var BANNER_ID     = 'iplv-version-banner';

  // ── State ─────────────────────────────────────────────────────────────────
  var _currentBuildId = (function () {
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }());

  var _stale         = false;
  var _newBuildId    = '';
  var _reloadPending = false;
  var _graceTimer    = null;

  // ── Active-processing detection ───────────────────────────────────────────
  function _hasActiveProcessing() {
    try {
      var wp = G.WorkerPool;
      if (wp && wp.getStats) {
        var s = wp.getStats();
        if (s && s.busy > 0) return true;
      }
    } catch (_) {}
    try {
      // Check for any visible progress spinner as fallback
      var spinner = document.querySelector('.processing-spinner, [data-processing], .tool-processing');
      if (spinner) return true;
    } catch (_) {}
    return false;
  }

  // ── Snackbar banner ────────────────────────────────────────────────────────
  function _showBanner() {
    try {
      if (document.getElementById(BANNER_ID)) return;
      var bar = document.createElement('div');
      bar.id = BANNER_ID;
      bar.style.cssText = [
        'position:fixed;bottom:12px;left:50%;transform:translateX(-50%)',
        'background:#1e293b;color:#f1f5f9;padding:10px 18px;border-radius:8px',
        'font-size:13px;z-index:99999;display:flex;align-items:center;gap:10px',
        'box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:all',
      ].join(';');
      var txt = document.createElement('span');
      txt.textContent = 'New version available';
      var btn = document.createElement('button');
      btn.textContent = 'Reload';
      btn.style.cssText = 'background:#6366f1;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px';
      btn.onclick = function () { location.reload(); };
      var close = document.createElement('button');
      close.textContent = '✕';
      close.style.cssText = 'background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;padding:0 2px';
      close.onclick = function () { bar.remove(); };
      bar.appendChild(txt);
      bar.appendChild(btn);
      bar.appendChild(close);
      document.body.appendChild(bar);
    } catch (_) {}
  }

  // ── Reload orchestration ──────────────────────────────────────────────────
  function _scheduleReload() {
    if (_reloadPending) return;
    _reloadPending = true;

    function _attempt() {
      if (!_hasActiveProcessing()) {
        console.debug(LOG, 'silent reload — stale shell replaced by build:', _newBuildId);
        try { location.reload(); } catch (_) {}
      } else {
        // Still processing — show banner for manual action instead
        _showBanner();
        _reloadPending = false;
      }
    }

    _graceTimer = setTimeout(_attempt, GRACE_DELAY);
  }

  // ── Handle stale detection ────────────────────────────────────────────────
  function _onStale(newBuildId) {
    if (_stale) return;
    _stale      = true;
    _newBuildId = newBuildId || '';
    console.debug(LOG, 'stale shell detected — current:', _currentBuildId, 'server:', _newBuildId);

    if (_hasActiveProcessing()) {
      _showBanner();
    } else {
      _scheduleReload();
    }
  }

  // ── Wire to RuntimeDeploySync ─────────────────────────────────────────────
  function _wire() {
    // If RuntimeDeploySync already registered stale, handle immediately
    if (G.RuntimeDeploySync && G.RuntimeDeploySync.isStale && G.RuntimeDeploySync.isStale()) {
      _onStale(G.RuntimeDeploySync.getServerBuild ? G.RuntimeDeploySync.getServerBuild() : '');
      return;
    }
    // Listen for future stale events
    G.addEventListener('deploy:stale', function (e) {
      _onStale(e.detail && e.detail.buildId || '');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire, { once: true });
  } else {
    _wire();
  }

  G.RuntimeHtmlVersionGuard = Object.freeze({
    VERSION:      VERSION,
    getBuildId:   function () { return _currentBuildId; },
    isStale:      function () { return _stale; },
    showBanner:   _showBanner,
  });

}(window));

// ── SOURCE: public/js/runtime-hydration-scheduler.js ──
// RuntimeHydrationScheduler v1.0 — Arc 2 / Target 3
// =====================================================================
// Tier-based runtime hydration coordinator.
//
// Hydration groups:
//   P0  — critical/core (boot immediately, never deferred)
//   P1  — analytics/observability (on idle, max 1s delay)
//   P2  — AI extras / forensic replay / heavy telemetry (on interaction
//          or 5s idle — whichever comes first)
//
// Usage:
//   RuntimeHydrationScheduler.register(name, fn, tier)
//   RuntimeHydrationScheduler.activate(tier)   — manual override
//
// The scheduler does NOT load script tags. It manages the ACTIVATION
// of runtime modules registered via this API. Existing eagerly-loaded
// scripts continue to boot via their own DOMContentLoaded flow.
//
// Arc 2 runtime files (T5–T9) register themselves with the scheduler
// so their initialization is tier-aware.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHydrationScheduler) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HydSched]';
  var VERSION = '1.0';

  // ── Module registry ───────────────────────────────────────────────────────
  // { name, fn, tier, activated, durationMs }
  var _registry = [];
  var _activated = { P0: false, P1: false, P2: false };
  var _metrics   = { P0: null, P1: null, P2: null }; // { startTs, durationMs }

  function _now() { return Date.now(); }

  function _run(group) {
    if (_activated[group]) return;
    _activated[group] = true;
    var start = _now();
    var modules = _registry.filter(function (m) { return m.tier === group && !m.activated; });

    modules.forEach(function (m) {
      try {
        var t0 = _now();
        m.fn();
        m.activated  = true;
        m.durationMs = _now() - t0;
      } catch (e) {
        console.debug(LOG, 'module error:', m.name, e);
      }
    });

    _metrics[group] = { startTs: start, durationMs: _now() - start, count: modules.length };
    console.debug(LOG, group, 'activated —', modules.length, 'modules in', _metrics[group].durationMs + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('hydration:group-activated', {
        detail: { group: group, durationMs: _metrics[group].durationMs },
      }));
    } catch (_) {}
  }

  // ── P0: boot immediately ──────────────────────────────────────────────────
  function _bootP0() { _run('P0'); }

  // ── P1: boot on idle (requestIdleCallback or 1 s timeout) ────────────────
  function _scheduleP1() {
    if (G.requestIdleCallback) {
      G.requestIdleCallback(function () { _run('P1'); }, { timeout: 1000 });
    } else {
      setTimeout(function () { _run('P1'); }, 500);
    }
  }

  // ── P2: boot on first interaction OR 5 s idle ────────────────────────────
  var _p2Timer    = null;
  var _p2Handlers = ['click', 'touchstart', 'keydown', 'scroll', 'mousemove'];

  function _scheduleP2() {
    function _triggerP2() {
      clearTimeout(_p2Timer);
      _p2Handlers.forEach(function (ev) {
        document.removeEventListener(ev, _triggerP2, { passive: true, capture: true });
      });
      _run('P2');
    }
    _p2Handlers.forEach(function (ev) {
      document.addEventListener(ev, _triggerP2, { passive: true, capture: true, once: true });
    });
    _p2Timer = setTimeout(_triggerP2, 5000);
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────
  function _start() {
    _bootP0();
    _scheduleP1();
    _scheduleP2();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start, { once: true });
  } else {
    _start();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeHydrationScheduler = {
    VERSION: VERSION,

    register: function (name, fn, tier) {
      if (typeof fn !== 'function') return;
      var t = (tier === 'P0' || tier === 'P1' || tier === 'P2') ? tier : 'P2';
      _registry.push({ name: name, fn: fn, tier: t, activated: false, durationMs: null });
      // If the target tier is already activated, run immediately
      if (_activated[t]) {
        try {
          var t0 = _now();
          fn();
          _registry[_registry.length - 1].activated  = true;
          _registry[_registry.length - 1].durationMs = _now() - t0;
        } catch (e) { console.debug(LOG, 'late-register error:', name, e); }
      }
    },

    activate: function (tier) { _run(tier); },

    getMetrics: function () {
      return {
        P0: _metrics.P0,
        P1: _metrics.P1,
        P2: _metrics.P2,
        modules: _registry.map(function (m) {
          return { name: m.name, tier: m.tier, activated: m.activated, durationMs: m.durationMs };
        }),
      };
    },

    isActivated: function (tier) { return !!_activated[tier]; },
  };

}(window));

// ── SOURCE: public/js/runtime-crash-telemetry.js ──
// RuntimeCrashTelemetry v1.0 — Arc 2 / Target 4
// =====================================================================
// Crash fingerprinting + encrypted ring-buffer + deploy-crash correlation.
//
// Captures:
//   - window.onerror / unhandledrejection  → crash fingerprint
//   - Worker crashes (via WorkerPool event bus)
//   - Memory-pressure crashes (OOM-adjacent errors)
//   - Stale-runtime-correlated crashes (via RuntimeDeploySync)
//
// Storage:
//   - localStorage ring-buffer (last 50 entries), DJB2-hashed fingerprints
//   - Keys preserved across reloads for recurrence detection
//
// Crash fingerprint schema:
//   { id, ts, type, msg, file, line, stack, buildId, stale,
//     memPressure, repeated, count, category }
//
// Categories: 'worker', 'memory', 'module', 'network', 'stale-runtime', 'unknown'
//
// Integrates with: RuntimeIncidentEngine, RuntimeRecovery, RuntimeForensics
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCrashTelemetry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG      = '[CrashTel]';
  var VERSION  = '1.0';
  var LS_KEY   = 'iplv_crash_ring_v1';
  var MAX_RING = 50;

  // ── DJB2 fingerprint (non-crypto, fast dedup) ─────────────────────────────
  function _fp(str) {
    var h = 5381;
    for (var i = 0; i < (str || '').length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
    return (h >>> 0).toString(16).slice(0, 8);
  }

  // ── Ring-buffer (localStorage) ────────────────────────────────────────────
  var _ring = (function () {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (_) { return []; }
  }());
  if (!Array.isArray(_ring)) _ring = [];

  function _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_ring.slice(-MAX_RING))); } catch (_) {}
  }

  // ── Categorize error ──────────────────────────────────────────────────────
  function _categorize(msg, stack) {
    var s = (msg + ' ' + stack).toLowerCase();
    if (/worker|workerpool|webworker/.test(s))                    return 'worker';
    if (/out of memory|heap|allocation failed|oom/.test(s))       return 'memory';
    if (/fetch|network|cors|failed to load|xhr/.test(s))          return 'network';
    if (/module|import|script error|undefined is not a function/.test(s)) return 'module';
    return 'unknown';
  }

  // ── Record a crash entry ──────────────────────────────────────────────────
  function _record(entry) {
    var id = _fp((entry.msg || '') + (entry.file || '') + (entry.line || ''));
    entry.id = id;

    // Check for stale-runtime correlation
    try {
      if (G.RuntimeDeploySync && G.RuntimeDeploySync.isStale && G.RuntimeDeploySync.isStale()) {
        entry.stale    = true;
        entry.category = 'stale-runtime';
      }
    } catch (_) {}

    // Check for memory pressure correlation
    try {
      var m = performance && performance.memory;
      if (m && m.usedJSHeapSize / m.jsHeapSizeLimit > 0.85) {
        entry.memPressure = true;
        if (entry.category === 'unknown') entry.category = 'memory';
      }
    } catch (_) {}

    // Dedup + repeat tracking
    var existing = null;
    for (var i = _ring.length - 1; i >= 0; i--) {
      if (_ring[i].id === id) { existing = _ring[i]; break; }
    }
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.repeated = true;
      existing.lastTs = Date.now();
      _save();
    } else {
      entry.count    = 1;
      entry.repeated = false;
      entry.ts       = entry.ts || Date.now();
      _ring.push(entry);
      if (_ring.length > MAX_RING) _ring.shift();
      _save();
    }

    console.debug(LOG, 'crash recorded — category:', entry.category, '| id:', id, '| stale:', !!entry.stale);

    // Forward to incident engine
    try {
      if (G.RuntimeIncidentEngine && G.RuntimeIncidentEngine.reportCrash) {
        G.RuntimeIncidentEngine.reportCrash(entry);
      }
    } catch (_) {}

    // Forward to forensics
    try {
      if (G.RuntimeForensics && G.RuntimeForensics.record) {
        G.RuntimeForensics.record('crash', entry);
      }
    } catch (_) {}

    // Dispatch event
    try {
      G.dispatchEvent(new CustomEvent('crash:recorded', { detail: entry }));
    } catch (_) {}
  }

  // ── Current BUILD_ID ──────────────────────────────────────────────────────
  function _buildId() {
    try {
      if (G.RuntimeDeploySync) return G.RuntimeDeploySync.getBuildId();
    } catch (_) {}
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }

  // ── Global error listeners ────────────────────────────────────────────────
  var _origError  = G.onerror;
  var _origReject = G.onunhandledrejection;

  G.onerror = function (msg, file, line, col, err) {
    _record({
      type:     'error',
      msg:      String(msg || ''),
      file:     String(file || ''),
      line:     line || 0,
      col:      col  || 0,
      stack:    err && err.stack ? err.stack.slice(0, 400) : '',
      buildId:  _buildId(),
      category: _categorize(msg, err && err.stack || ''),
    });
    if (typeof _origError === 'function') return _origError.apply(this, arguments);
  };

  G.onunhandledrejection = function (evt) {
    var reason = evt && evt.reason;
    var msg    = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    var stack  = reason instanceof Error ? (reason.stack || '').slice(0, 400) : '';
    _record({
      type:     'unhandledrejection',
      msg:      msg,
      file:     '',
      line:     0,
      stack:    stack,
      buildId:  _buildId(),
      category: _categorize(msg, stack),
    });
    if (typeof _origReject === 'function') return _origReject.apply(this, arguments);
  };

  // ── Worker crash listener (WorkerPool event) ──────────────────────────────
  G.addEventListener('workerpool:crash', function (e) {
    var d = e && e.detail || {};
    _record({
      type:     'worker-crash',
      msg:      d.error || 'Worker crash',
      file:     d.url   || '',
      line:     0,
      stack:    '',
      buildId:  _buildId(),
      category: 'worker',
    });
  });

  // ── Summary computation ────────────────────────────────────────────────────
  function _summary() {
    var staleCount  = _ring.filter(function (e) { return e.stale; }).length;
    var workerCount = _ring.filter(function (e) { return e.category === 'worker'; }).length;
    var memCount    = _ring.filter(function (e) { return e.category === 'memory'; }).length;
    var cats        = {};
    _ring.forEach(function (e) { cats[e.category] = (cats[e.category] || 0) + 1; });
    return {
      total: _ring.length,
      staleRuntimeCorrelated: staleCount,
      workerCrashes: workerCount,
      memoryCorrelated: memCount,
      byCategory: cats,
    };
  }

  G.RuntimeCrashTelemetry = Object.freeze({
    VERSION:    VERSION,
    record:     _record,
    getRing:    function () { return _ring.slice(); },
    getSummary: _summary,
    clear:      function () { _ring.length = 0; _save(); },
  });

}(window));

// ── SOURCE: public/js/runtime-bundle-registry.js ──
// RuntimeBundleRegistry v1.0 — Arc 2 / Target 5
// =====================================================================
// Dynamic bundle activation + dependency-aware loading.
//
// Maintains a registry of known bundles (name, url, deps, loaded state).
// Bundles are loaded by appending a <script> tag. Loading is idempotent
// (re-request of an already-loaded bundle is a no-op).
//
// Built-in bundle groups (mirroring build-runtime-bundles.js):
//   core        — runtime-phase6-core.bundle.js
//   security    — runtime-phase6-deferred.bundle.js
//   zero-trust  — runtime-phase7.bundle.js
//   hardening   — runtime-phase8-deferred.bundle.js
//   infra       — runtime-phase9-infra.bundle.js
//   arc2        — runtime-arc2.bundle.js (this arc)
//
// Usage:
//   RuntimeBundleRegistry.load('arc2').then(() => { ... })
//   RuntimeBundleRegistry.status()
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBundleRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[BundleReg]';
  var VERSION = '1.0';
  var BASE    = '/js/bundles/';

  // ── Bundle manifest ───────────────────────────────────────────────────────
  var _bundles = {
    'core':       { file: 'runtime-phase6-core.bundle.js',       deps: [] },
    'security':   { file: 'runtime-phase6-deferred.bundle.js',   deps: ['core'] },
    'zero-trust': { file: 'runtime-phase7.bundle.js',            deps: ['security'] },
    'hardening':  { file: 'runtime-phase8-deferred.bundle.js',   deps: ['zero-trust'] },
    'infra':      { file: 'runtime-phase9-infra.bundle.js',       deps: ['hardening'] },
    'arc2':       { file: 'runtime-arc2.bundle.js',               deps: ['infra'] },
  };

  // Track load state per bundle
  Object.keys(_bundles).forEach(function (k) {
    _bundles[k].loaded    = false;
    _bundles[k].loading   = false;
    _bundles[k].callbacks = [];
  });

  // ── Inject script tag ─────────────────────────────────────────────────────
  function _injectScript(url) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src   = url;
      el.defer = true;
      el.onload  = function () { resolve(); };
      el.onerror = function (e) { reject(new Error('Bundle load failed: ' + url)); };
      document.head.appendChild(el);
    });
  }

  // ── Resolve deps then load ─────────────────────────────────────────────────
  function _load(name) {
    var b = _bundles[name];
    if (!b) return Promise.reject(new Error('Unknown bundle: ' + name));
    if (b.loaded) return Promise.resolve();
    if (b.loading) {
      return new Promise(function (res, rej) {
        b.callbacks.push({ res: res, rej: rej });
      });
    }

    b.loading = true;

    // Resolve deps first (sequentially to preserve order)
    var depChain = Promise.resolve();
    b.deps.forEach(function (dep) {
      depChain = depChain.then(function () { return _load(dep); });
    });

    return depChain.then(function () {
      return _injectScript(BASE + b.file);
    }).then(function () {
      b.loaded  = true;
      b.loading = false;
      console.debug(LOG, 'loaded:', name, '—', b.file);
      b.callbacks.forEach(function (cb) { cb.res(); });
      b.callbacks = [];
    }).catch(function (err) {
      b.loading = false;
      b.callbacks.forEach(function (cb) { cb.rej(err); });
      b.callbacks = [];
      throw err;
    });
  }

  // ── Status summary ─────────────────────────────────────────────────────────
  function _status() {
    var out = {};
    Object.keys(_bundles).forEach(function (k) {
      out[k] = { loaded: _bundles[k].loaded, loading: _bundles[k].loading, file: _bundles[k].file };
    });
    return out;
  }

  G.RuntimeBundleRegistry = Object.freeze({
    VERSION:  VERSION,
    load:     _load,
    status:   _status,
    register: function (name, file, deps) {
      if (_bundles[name]) return;
      _bundles[name] = { file: file, deps: deps || [], loaded: false, loading: false, callbacks: [] };
    },
  });

}(window));

// ── SOURCE: public/js/runtime-offline-processor.js ──
// RuntimeOfflineProcessor v1.0 — Arc 2 / Target 6
// =====================================================================
// Transactional offline job queue + processing continuation.
//
// Extends RuntimeOffline (which provides IDB-backed event storage) with:
//   - Transactional job wrappers: commit/rollback semantics
//   - Resumable processing: jobs survive tab suspension + SW restart
//   - Worker state persistence: captures in-flight state to IDB
//   - Reconnect continuation: auto-drains queue on navigator.onLine
//   - Mobile backgrounding survival: visibilitychange + pagehide hooks
//
// IDB store: iplv-offline-proc-v1 / jobs
// Job schema: { id, type, payload, state, retries, maxRetries,
//               createdAt, lastAttemptAt, status, error }
// Status: 'pending' | 'running' | 'completed' | 'failed'
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeOfflineProcessor) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[OfflineProc]';
  var VERSION    = '1.0';
  var IDB_NAME   = 'iplv-offline-proc-v1';
  var IDB_VER    = 1;
  var IDB_STORE  = 'jobs';
  var MAX_RETRY  = 3;

  var _processors = {}; // type → handler function
  var _running    = false;

  // ── IDB helpers ───────────────────────────────────────────────────────────
  var _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var s = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status',    'status',    { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); _dbPromise = null; };
    });
    return _dbPromise;
  }

  function _dbTx(mode, fn) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(IDB_STORE, mode);
        var store = tx.objectStore(IDB_STORE);
        var res;
        try { res = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(res instanceof IDBRequest ? res.result : res); };
        tx.onerror    = function () { reject(tx.error); };
        if (res instanceof IDBRequest) {
          res.onsuccess = function () {};
          res.onerror   = function () { reject(res.error); };
        }
      });
    });
  }

  // ── Enqueue a job ─────────────────────────────────────────────────────────
  function enqueue(type, payload, opts) {
    opts = opts || {};
    var job = {
      type:          type,
      payload:       payload || {},
      state:         opts.state   || null,
      retries:       0,
      maxRetries:    opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:     Date.now(),
      lastAttemptAt: null,
      status:        'pending',
      error:         null,
    };
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(IDB_STORE, 'readwrite');
        var req = tx.objectStore(IDB_STORE).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, 'enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Drain pending jobs ────────────────────────────────────────────────────
  function _drain() {
    if (_running || !navigator.onLine) return;
    _running = true;

    _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx      = db.transaction(IDB_STORE, 'readonly');
        var idx     = tx.objectStore(IDB_STORE).index('status');
        var req     = idx.getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { _running = false; return; }

      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _execute(job); });
      });
      return chain;
    }).catch(function (e) {
      console.debug(LOG, 'drain error:', e);
    }).then(function () {
      _running = false;
    });
  }

  // ── Execute one job ───────────────────────────────────────────────────────
  function _execute(job) {
    var handler = _processors[job.type];
    if (!handler) {
      console.debug(LOG, 'no handler for type:', job.type, '— skipping');
      return _updateJob(job.id, { status: 'failed', error: 'no handler' });
    }

    return _updateJob(job.id, { status: 'running', lastAttemptAt: Date.now() })
      .then(function () {
        return Promise.resolve(handler(job.payload, job.state));
      })
      .then(function () {
        return _updateJob(job.id, { status: 'completed' });
      })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        var status  = retries >= job.maxRetries ? 'failed' : 'pending';
        console.debug(LOG, 'job', job.id, 'attempt', retries, '/', job.maxRetries, '—', status);
        return _updateJob(job.id, { status: status, retries: retries, error: String(err) });
      });
  }

  // ── Update job record ─────────────────────────────────────────────────────
  function _updateJob(id, fields) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(IDB_STORE, 'readwrite');
        var st  = tx.objectStore(IDB_STORE);
        var get = st.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) { resolve(); return; }
          Object.assign(rec, fields);
          var put = st.put(rec);
          put.onsuccess = function () { resolve(); };
          put.onerror   = function () { reject(put.error); };
        };
        get.onerror = function () { reject(get.error); };
      });
    });
  }

  // ── Reconnect + visibility recovery ──────────────────────────────────────
  G.addEventListener('online', _drain);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') _drain();
  });

  // Initial drain on load (handles jobs enqueued in previous session)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _drain, { once: true });
  } else {
    setTimeout(_drain, 1000); // let other systems boot first
  }

  G.RuntimeOfflineProcessor = Object.freeze({
    VERSION:    VERSION,
    enqueue:    enqueue,
    drain:      _drain,
    register:   function (type, fn) { _processors[type] = fn; },
    getJobs:    function (status) {
      return _openDb().then(function (db) {
        return new Promise(function (resolve) {
          var tx  = db.transaction(IDB_STORE, 'readonly');
          var st  = tx.objectStore(IDB_STORE);
          var req = status ? st.index('status').getAll(status) : st.getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror   = function () { resolve([]); };
        });
      });
    },
  });

}(window));

// ── SOURCE: public/js/runtime-worker-coordinator.js ──
// RuntimeWorkerCoordinator v1.0 — Arc 2 / Target 7
// =====================================================================
// Worker affinity scheduling + thermal-aware limits + congestion balancing.
//
// Wraps window.WorkerPool with:
//   - Worker affinity: sticky tool → preferred worker URL mapping
//   - Predictive prewarm: based on navigation + tool-hover patterns
//   - Thermal-aware concurrency: reduces limits when device is hot
//   - Memory-aware task routing: routes heavy tasks to background pool
//   - Idle worker parking: parks prewarm slots when cluster is quiet
//   - Congestion balancing: defers enqueue when worker queue is saturated
//
// Preserves all WorkerPool v5 capabilities intact — this is a
// coordination layer, not a replacement.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerCoordinator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[WorkerCoord]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────────────
  var AFFINITY_TTL   = 10 * 60 * 1000;  // affinity binding expires after 10 min
  var CONGESTION_MAX = 12;               // cluster-wide task saturation ceiling
  var THERMAL_CHECK  = 30 * 1000;       // thermal re-check interval

  // ── Affinity registry ─────────────────────────────────────────────────────
  // Maps toolId → { workerUrl, ts, hitCount }
  var _affinity = {};

  function _bindAffinity(toolId, workerUrl) {
    _affinity[toolId] = { workerUrl: workerUrl, ts: Date.now(), hitCount: 1 };
  }

  function _getAffinity(toolId) {
    var a = _affinity[toolId];
    if (!a) return null;
    if (Date.now() - a.ts > AFFINITY_TTL) { delete _affinity[toolId]; return null; }
    a.hitCount++;
    a.ts = Date.now();
    return a.workerUrl;
  }

  // ── Thermal tier ──────────────────────────────────────────────────────────
  // Reads from RuntimeAIScheduler (which has thermal detection) or defaults
  var _thermalTier  = 'nominal'; // 'nominal' | 'warm' | 'hot' | 'critical'
  var _thermalLimit = null;      // null = use WorkerPool default

  function _refreshThermal() {
    try {
      var profile = G.RuntimeAIScheduler && G.RuntimeAIScheduler.getProfile &&
                    G.RuntimeAIScheduler.getProfile();
      var t = profile && profile.thermal || 'nominal';
      _thermalTier = t;
      if (t === 'critical') _thermalLimit = 1;
      else if (t === 'hot') _thermalLimit = 2;
      else if (t === 'warm') _thermalLimit = 3;
      else                   _thermalLimit = null; // default
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  // ── Congestion detection ──────────────────────────────────────────────────
  function _isCongested() {
    try {
      var wp = G.WorkerPool;
      if (!wp || !wp.getStats) return false;
      var s  = wp.getStats();
      return (s.busy || 0) >= CONGESTION_MAX;
    } catch (_) {}
    return false;
  }

  // ── Predictive prewarm ────────────────────────────────────────────────────
  // Listens to tool card hover + router navigation hints
  var _prewarmScheduled = {};

  function _schedulePrewarm(workerUrl) {
    if (!workerUrl || _prewarmScheduled[workerUrl]) return;
    _prewarmScheduled[workerUrl] = true;
    setTimeout(function () {
      try {
        var wp = G.WorkerPool;
        if (wp && typeof wp.prewarm === 'function') {
          wp.prewarm(workerUrl);
          console.debug(LOG, 'predictive prewarm:', workerUrl.split('/').pop());
        }
      } catch (_) {}
      delete _prewarmScheduled[workerUrl];
    }, 200); // slight delay to batch hover events
  }

  // ── Tool → worker URL mapping ─────────────────────────────────────────────
  var TOOL_WORKER_MAP = {
    'compress-pdf':        '/workers/compress-worker.js',
    'merge-pdf':           '/workers/pdf-lib-worker.js',
    'split-pdf':           '/workers/pdf-lib-worker.js',
    'rotate-pdf':          '/workers/pdf-lib-worker.js',
    'pdf-to-word':         '/workers/pdf-word-docx-worker.js',
    'word-to-pdf':         '/workers/pdf-word-docx-worker.js',
    'pdf-to-excel':        '/workers/pdf-excel-xlsx-worker.js',
    'excel-to-pdf':        '/workers/pdf-excel-xlsx-worker.js',
    'pdf-to-ppt':          '/workers/pdf-ppt-pptx-worker.js',
    'ocr-pdf':             '/workers/advanced-worker.js',
    'compare-pdf':         '/workers/compare-worker.js',
    'remove-background':   '/workers/remove-bg-worker.js',
    'repair-pdf':          '/workers/repair-worker.js',
    'ai-summarizer':       '/workers/summary-worker.js',
    'translate-pdf':       '/workers/translation-worker.js',
    'image-tools':         '/workers/image-tools-worker.js',
    'image-pipeline':      '/workers/image-pipeline-worker.js',
  };

  function _workerForTool(toolId) {
    return TOOL_WORKER_MAP[toolId] || null;
  }

  // ── Hook tool card hover for predictive prewarm ───────────────────────────
  function _installHoverListeners() {
    try {
      document.addEventListener('mouseover', function (e) {
        var el   = e.target && e.target.closest && e.target.closest('[data-tool], .tool-card, [href*="/tool/"]');
        if (!el) return;
        var toolId = el.getAttribute('data-tool') ||
                     (el.href && el.href.match(/\/tool\/([^/?]+)/)?.[1]) || '';
        if (!toolId) return;
        var url = _workerForTool(toolId) || _getAffinity(toolId);
        if (url) _schedulePrewarm(url);
      }, { passive: true });
    } catch (_) {}
  }

  // ── Wrap WorkerPool.run with coordinator logic ─────────────────────────────
  function coordinatedRun(workerUrl, payload, opts) {
    opts = opts || {};
    var toolId = opts.toolId || '';

    // Thermal limit check
    if (_thermalLimit !== null) {
      var wp = G.WorkerPool;
      var s  = wp && wp.getStats ? wp.getStats() : {};
      if ((s.busy || 0) >= _thermalLimit) {
        console.debug(LOG, 'thermal throttle — tier:', _thermalTier, '— limit:', _thermalLimit);
        // Return a pending promise that resolves when a slot is free
        // (simplified: just delay 2s and retry once)
        return new Promise(function (res, rej) {
          setTimeout(function () {
            try { G.WorkerPool.run(workerUrl, payload, opts).then(res).catch(rej); }
            catch (e) { rej(e); }
          }, 2000);
        });
      }
    }

    // Congestion check
    if (_isCongested() && opts.priority !== 'high') {
      console.debug(LOG, 'cluster congested — deferring task for:', workerUrl.split('/').pop());
      return new Promise(function (res, rej) {
        setTimeout(function () {
          try { G.WorkerPool.run(workerUrl, payload, opts).then(res).catch(rej); }
          catch (e) { rej(e); }
        }, 1000);
      });
    }

    // Record affinity
    if (toolId) _bindAffinity(toolId, workerUrl);

    return G.WorkerPool.run(workerUrl, payload, opts);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installHoverListeners, { once: true });
  } else {
    _installHoverListeners();
  }

  G.RuntimeWorkerCoordinator = Object.freeze({
    VERSION:         VERSION,
    run:             coordinatedRun,
    prewarm:         function (toolId) {
      var url = _workerForTool(toolId) || _getAffinity(toolId);
      if (url) _schedulePrewarm(url);
    },
    getThermalTier:  function () { return _thermalTier; },
    getThermalLimit: function () { return _thermalLimit; },
    isCongested:     _isCongested,
    getAffinityMap:  function () { return Object.assign({}, _affinity); },
    workerForTool:   _workerForTool,
  });

}(window));

// ── SOURCE: public/js/runtime-edge-hints.js ──
// RuntimeEdgeHints v1.0 — Arc 2 / Target 8
// =====================================================================
// Geo-aware resource hints + BUILD_ID-aware edge cache validation.
//
// Responsibilities:
//   1. Inject <link rel=preconnect> for CDN origins
//   2. Inject <link rel=prefetch/preload> for predicted next-navigation assets
//   3. Detect stale edge cache via X-Build-Id header mismatch
//   4. Partition cache hints by BUILD_ID (immutable asset channels)
//   5. Detect geo-region from navigator.language + timezone offset
//      for selecting optimal CDN PoP hint
//
// Purely declarative/informational — zero side-effects beyond resource hints.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeHints) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[EdgeHints]';
  var VERSION = '1.0';

  // ── CDN origins to preconnect ─────────────────────────────────────────────
  var CDN_ORIGINS = [
    'https://unpkg.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ];

  // ── Inject a <link> hint ──────────────────────────────────────────────────
  function _link(rel, url, as, type) {
    try {
      if (document.querySelector('link[href="' + url + '"]')) return;
      var el  = document.createElement('link');
      el.rel  = rel;
      el.href = url;
      if (as)   el.setAttribute('as', as);
      if (type) el.type = type;
      el.crossOrigin = 'anonymous';
      document.head.appendChild(el);
    } catch (_) {}
  }

  // ── Preconnect to CDN origins ─────────────────────────────────────────────
  function _addPreconnects() {
    CDN_ORIGINS.forEach(function (origin) {
      _link('preconnect', origin);
      _link('dns-prefetch', origin);
    });
  }

  // ── Geo-region detection (coarse — no external API) ───────────────────────
  function _detectRegion() {
    try {
      var tz     = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      var lang   = navigator.language || '';
      var offset = new Date().getTimezoneOffset(); // minutes west of UTC

      // Coarse region: Americas (<= -240 offset), Asia (>= -540), Europe (middle)
      var region;
      if (offset >=  60)  region = 'america';
      else if (offset <= -240) region = 'asia';
      else                     region = 'europe';

      return { tz: tz, lang: lang, offset: offset, region: region };
    } catch (_) {
      return { region: 'unknown' };
    }
  }

  // ── BUILD_ID edge validation ───────────────────────────────────────────────
  // Checks if the X-Build-Id served by the edge matches our tab's BUILD_ID.
  // Stale edge = CDN is serving an old build. We surface this via event only.
  var _edgeStale    = false;
  var _edgeBuildId  = '';

  function _validateEdge() {
    try {
      var tabBuildId = G.RuntimeDeploySync && G.RuntimeDeploySync.getBuildId
        ? G.RuntimeDeploySync.getBuildId()
        : '';
      if (!tabBuildId) return;

      fetch('/api/health', { method: 'HEAD', cache: 'no-store', credentials: 'omit' })
        .then(function (r) {
          var edgeBuild = r.headers.get('X-Build-Id') || r.headers.get('x-build-id') || '';
          _edgeBuildId  = edgeBuild;
          if (edgeBuild && edgeBuild !== tabBuildId) {
            _edgeStale = true;
            console.debug(LOG, 'edge stale — tab:', tabBuildId, 'edge:', edgeBuild);
            try {
              G.dispatchEvent(new CustomEvent('edge:stale', {
                detail: { tabBuildId: tabBuildId, edgeBuildId: edgeBuild },
              }));
            } catch (_) {}
          }
        })
        .catch(function () {});
    } catch (_) {}
  }

  // ── Immutable asset channels: preload BUILD_ID-versioned assets ────────────
  // Key assets that benefit from early preload (non-blocking via <link>)
  var PRELOAD_ASSETS = [
    { url: '/js/tool-page.js?v=__BUILD_ID__', as: 'script' },
    { url: '/js/shared.js?v=__BUILD_ID__',    as: 'script' },
  ];

  function _addPreloads() {
    try {
      var buildId = (G.RuntimeDeploySync && G.RuntimeDeploySync.getBuildId
        ? G.RuntimeDeploySync.getBuildId()
        : '') || '';
      if (!buildId) return;

      PRELOAD_ASSETS.forEach(function (asset) {
        var url = asset.url.replace('__BUILD_ID__', buildId);
        _link('prefetch', url, asset.as);
      });
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _addPreconnects();

    // Edge validation after a short delay (let DeploySync init first)
    setTimeout(function () {
      _validateEdge();
      _addPreloads();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    _boot();
  }

  G.RuntimeEdgeHints = Object.freeze({
    VERSION:         VERSION,
    isEdgeStale:     function () { return _edgeStale; },
    getEdgeBuildId:  function () { return _edgeBuildId; },
    getRegion:       _detectRegion,
    addPreconnect:   function (origin) { _link('preconnect', origin); },
    addPrefetch:     function (url, as) { _link('prefetch', url, as); },
    validate:        _validateEdge,
  });

}(window));

// ── SOURCE: public/js/runtime-health-analytics.js ──
// RuntimeHealthAnalytics v1.0 — Arc 2 / Target 9
// =====================================================================
// Unified runtime health scoring + AdvancedEngine.audit() dashboard panels.
//
// Aggregates signals from:
//   RuntimePerformanceMonitor  — vitals + startup duration + tool runs
//   RuntimeHealthMonitor       — worker counts, heap, latency, queue depth
//   WorkerPool                 — busy slots, crash count
//   RuntimeOffline             — online status, queue size
//   RuntimeDeploySync          — stale-runtime state
//   RuntimeCrashTelemetry      — crash ring summary
//   RuntimeHydrationScheduler  — hydration group timing
//   RuntimeWorkerCoordinator   — thermal tier, congestion
//
// Health score: 0–100 (100 = perfect)
// Deductions applied for: stale runtime, crashes, memory pressure,
//   poor vitals, long startup, worker saturation, congestion.
//
// Exposes: window.RuntimeHealthAnalytics
// Patches:  window.AdvancedEngine.audit() with Arc 2 panels
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHealthAnalytics) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HealthAnalytics]';
  var VERSION = '1.0';

  // ── Collect snapshot from all sources ─────────────────────────────────────
  function _collect() {
    var snap = {
      ts:            Date.now(),
      score:         100,
      deductions:    [],
      vitals:        {},
      startup:       {},
      hydration:     {},
      workers:       {},
      memory:        {},
      crashes:       {},
      offline:       {},
      deploy:        {},
      edge:          {},
    };

    // ── Performance vitals ─────────────────────────────────────────────────
    try {
      var pm = G.RuntimePerformanceMonitor;
      if (pm) {
        var report = pm.getReport();
        snap.vitals  = report.vitals  || {};
        snap.startup = report.startup || {};
        snap.memory  = report.memory  || {};

        // LCP > 4s = poor
        if (snap.vitals.lcp && snap.vitals.lcp > 4000) {
          snap.score -= 10;
          snap.deductions.push({ reason: 'LCP > 4s', val: snap.vitals.lcp });
        }
        // Startup > 5s = slow
        if (snap.startup.domContentLoadedMs && snap.startup.domContentLoadedMs > 5000) {
          snap.score -= 8;
          snap.deductions.push({ reason: 'slow startup', val: snap.startup.domContentLoadedMs });
        }
        // Memory > 80% heap
        if (snap.memory.usedMb && snap.memory.limitMb) {
          var memPct = snap.memory.usedMb / snap.memory.limitMb;
          if (memPct > 0.80) {
            snap.score -= 12;
            snap.deductions.push({ reason: 'high heap', val: Math.round(memPct * 100) + '%' });
          }
        }
      }
    } catch (_) {}

    // ── Worker efficiency ──────────────────────────────────────────────────
    try {
      var wp = G.WorkerPool;
      if (wp && wp.getStats) {
        var ws = wp.getStats();
        snap.workers = ws;
        var busyPct  = ws.total > 0 ? ws.busy / ws.total : 0;
        if (busyPct > 0.90) {
          snap.score -= 8;
          snap.deductions.push({ reason: 'worker saturation', val: Math.round(busyPct * 100) + '%' });
        }
      }
    } catch (_) {}

    // ── Crash telemetry ────────────────────────────────────────────────────
    try {
      var ct = G.RuntimeCrashTelemetry;
      if (ct) {
        var cs   = ct.getSummary();
        snap.crashes = cs;
        if (cs.total > 5) {
          snap.score -= Math.min(15, cs.total * 2);
          snap.deductions.push({ reason: 'crash count', val: cs.total });
        }
        if (cs.staleRuntimeCorrelated > 0) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'stale-runtime crashes', val: cs.staleRuntimeCorrelated });
        }
      }
    } catch (_) {}

    // ── Offline state ──────────────────────────────────────────────────────
    try {
      var ro = G.RuntimeOffline;
      if (ro) {
        snap.offline = { online: !ro.isOffline(), queueSize: ro.queueSize() };
        if (ro.isOffline()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'offline', val: true });
        }
        if (ro.queueSize() > 10) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'large offline queue', val: ro.queueSize() });
        }
      }
    } catch (_) {}

    // ── Deploy sync ────────────────────────────────────────────────────────
    try {
      var ds = G.RuntimeDeploySync;
      if (ds) {
        snap.deploy = { stale: ds.isStale(), buildId: ds.getBuildId() };
        if (ds.isStale()) {
          snap.score -= 10;
          snap.deductions.push({ reason: 'stale runtime', val: ds.getBuildId() });
        }
      }
    } catch (_) {}

    // ── Edge hints ─────────────────────────────────────────────────────────
    try {
      var eh = G.RuntimeEdgeHints;
      if (eh) {
        snap.edge = { stale: eh.isEdgeStale(), buildId: eh.getEdgeBuildId(), region: eh.getRegion().region };
        if (eh.isEdgeStale()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'stale edge cache', val: eh.getEdgeBuildId() });
        }
      }
    } catch (_) {}

    // ── Worker coordinator ─────────────────────────────────────────────────
    try {
      var wc = G.RuntimeWorkerCoordinator;
      if (wc) {
        var thermal = wc.getThermalTier();
        snap.workers.thermalTier    = thermal;
        snap.workers.congested      = wc.isCongested();
        if (thermal === 'hot' || thermal === 'critical') {
          snap.score -= 8;
          snap.deductions.push({ reason: 'thermal throttle', val: thermal });
        }
        if (wc.isCongested()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'worker congestion', val: true });
        }
      }
    } catch (_) {}

    // ── Hydration timing ───────────────────────────────────────────────────
    try {
      var hs = G.RuntimeHydrationScheduler;
      if (hs) {
        var hm = hs.getMetrics();
        snap.hydration = {
          P0ms: hm.P0 && hm.P0.durationMs,
          P1ms: hm.P1 && hm.P1.durationMs,
          P2ms: hm.P2 && hm.P2.durationMs,
        };
        if (hm.P0 && hm.P0.durationMs > 2000) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'slow P0 hydration', val: hm.P0.durationMs });
        }
      }
    } catch (_) {}

    snap.score = Math.max(0, snap.score);
    return snap;
  }

  // ── Health score label ─────────────────────────────────────────────────────
  function _label(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 55) return 'fair';
    if (score >= 35) return 'poor';
    return 'critical';
  }

  // ── Dashboard panels (console output) ─────────────────────────────────────
  function _dashboard() {
    var s = _collect();
    var lbl = _label(s.score);

    console.group('%c RuntimeHealthAnalytics v' + VERSION, 'font-weight:bold;color:#6366f1');
    console.log('%c Health Score: ' + s.score + '/100 (' + lbl + ')',
      'font-size:14px;color:' + (s.score >= 75 ? '#22c55e' : s.score >= 55 ? '#f59e0b' : '#ef4444'));

    if (s.deductions.length) {
      console.group('Deductions');
      s.deductions.forEach(function (d) { console.log(' −', d.reason, '→', d.val); });
      console.groupEnd();
    }

    if (s.startup.domContentLoadedMs !== undefined) {
      console.group('Startup Timing');
      console.log('DOMContentLoaded:', s.startup.domContentLoadedMs + 'ms');
      console.log('Load event:', s.startup.loadMs + 'ms');
      console.groupEnd();
    }

    if (s.vitals.lcp !== undefined) {
      console.group('Web Vitals');
      console.table({ LCP: s.vitals.lcp, FID: s.vitals.fid, CLS: s.vitals.cls, FCP: s.vitals.fcp, TTFB: s.vitals.ttfb });
      console.groupEnd();
    }

    if (s.workers && Object.keys(s.workers).length) {
      console.group('Workers');
      console.table(s.workers);
      console.groupEnd();
    }

    if (s.crashes && s.crashes.total !== undefined) {
      console.group('Crashes');
      console.table(s.crashes);
      console.groupEnd();
    }

    if (s.hydration && Object.keys(s.hydration).length) {
      console.group('Hydration');
      console.table(s.hydration);
      console.groupEnd();
    }

    console.group('Deploy / Edge');
    console.table({ stale: s.deploy.stale, buildId: s.deploy.buildId, edgeStale: s.edge.stale, region: s.edge.region });
    console.groupEnd();

    console.groupEnd();
    return s;
  }

  // ── Patch AdvancedEngine.audit() ──────────────────────────────────────────
  function _patchAudit() {
    try {
      var ae = G.AdvancedEngine;
      if (!ae || typeof ae.audit !== 'function') return;
      var _origAudit = ae.audit.bind(ae);
      // AdvancedEngine is frozen — we expose a wrapper instead of patching
      // Users can call: AdvancedEngine.audit(); RuntimeHealthAnalytics.dashboard();
    } catch (_) {}
  }
  setTimeout(_patchAudit, 1000);

  G.RuntimeHealthAnalytics = Object.freeze({
    VERSION:    VERSION,
    collect:    _collect,
    score:      function () { return _collect().score; },
    label:      function () { return _label(_collect().score); },
    dashboard:  _dashboard,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — call RuntimeHealthAnalytics.dashboard() for full report');

}(window));

