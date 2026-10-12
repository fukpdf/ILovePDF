// ── Arc 8 Enterprise Observability + Live Control Plane — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.828Z  BUILD_ID: mpxgtdiz
// Files: 8

// ── SOURCE: public/js/runtime-control-plane.js ──
// RuntimeControlPlane v1.0 — Arc 8 / Phase A
// =====================================================================
// Centralized runtime command bus. Enables live runtime control without
// page reload: toggle hydration domains, pause/resume worker domains,
// enable/disable predictive loading, self-optimizer, mobile extreme.
//
// All commands:
//   - are runtime-safe (try/catch, no crash propagation)
//   - emit arc8:command events after execution
//   - are recorded in a bounded audit trail (ring buffer)
//   - produce immutable snapshots for inspection
//
// Distinct from RuntimeTaskOrchestrator (execution scheduling) and
// RuntimeSelfOptimizer (auto-tuning) — this is the MANUAL control layer.
//
// window.RuntimeControlPlane.execute(cmd, args)
// window.RuntimeControlPlane.getState()
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeControlPlane) return;

  var LOG     = '[ControlPlane]';
  var VERSION = '1.0';

  // ── Feature flags ─────────────────────────────────────────────────
  var _flags = {
    'hydration.streaming':   true,
    'hydration.viewport':    true,
    'hydration.interaction': true,
    'predictive.hover':      true,
    'predictive.navigation': true,
    'predictive.frequency':  true,
    'workers.preload':       true,
    'optimizer.auto':        true,
    'extreme.auto':          true,
    'telemetry.fps':         true,
    'cache.sweep':           true,
    'trace.enabled':         true,
    'timeline.capture':      true,
    'profiler.sampling':     false,  // off by default (CPU cost)
    'dashboard.visible':     false,
  };

  // ── Command registry ──────────────────────────────────────────────
  var _commands = {};

  function register(name, fn) {
    _commands[name] = fn;
  }

  // ── Audit trail ───────────────────────────────────────────────────
  var _audit = [];
  var AUDIT_MAX = 200;

  function _recordAudit(cmd, args, result, err) {
    _audit.push(Object.freeze({
      ts: Date.now(), cmd: cmd,
      args: args ? JSON.parse(JSON.stringify(args)) : null,
      result: result || null,
      error: err ? String(err.message) : null,
    }));
    if (_audit.length > AUDIT_MAX) _audit.shift();
  }

  // ── Execute ───────────────────────────────────────────────────────
  function execute(cmd, args) {
    var fn = _commands[cmd];
    if (!fn) {
      _recordAudit(cmd, args, null, new Error('Unknown command: ' + cmd));
      console.warn(LOG, 'unknown command:', cmd);
      return { ok: false, error: 'unknown command: ' + cmd };
    }
    var result = null;
    try {
      result = fn(args || {});
      _recordAudit(cmd, args, result, null);
      try {
        G.dispatchEvent(new CustomEvent('arc8:command', {
          detail: { cmd: cmd, args: args, result: result, ts: Date.now() },
        }));
      } catch (_) {}
      console.debug(LOG, 'exec:', cmd, '→', result);
      return { ok: true, result: result };
    } catch (e) {
      _recordAudit(cmd, args, null, e);
      console.warn(LOG, 'command error:', cmd, e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── Flag control ──────────────────────────────────────────────────
  function setFlag(name, value) {
    if (!_flags.hasOwnProperty(name)) return false;
    _flags[name] = !!value;
    return true;
  }

  function getFlag(name) { return _flags[name]; }

  // ── Built-in commands ─────────────────────────────────────────────

  register('flag.set', function (a) {
    var ok = setFlag(a.name, a.value);
    return { flag: a.name, value: a.value, ok: ok };
  });

  register('flag.get', function (a) {
    return { flag: a.name, value: _flags[a.name] };
  });

  register('flags.list', function () {
    return Object.assign({}, _flags);
  });

  // Hydration domain controls
  register('hydration.pause', function (a) {
    var hs = G.RuntimeHydrationScheduler;
    if (hs && hs.suspend) hs.suspend(a.tier || 'P2');
    return { tier: a.tier };
  });

  register('hydration.resume', function (a) {
    var hs = G.RuntimeHydrationScheduler;
    if (hs && hs.resume) hs.resume(a.tier || 'P2');
    return { tier: a.tier };
  });

  register('hydration.flush', function () {
    var sh = G.RuntimeStreamingHydration;
    if (sh && sh.flush) sh.flush();
    return { flushed: true };
  });

  // Predictive loader controls
  register('predictive.disable', function () {
    setFlag('predictive.hover', false);
    setFlag('predictive.navigation', false);
    setFlag('predictive.frequency', false);
    return { disabled: true };
  });

  register('predictive.enable', function () {
    setFlag('predictive.hover', true);
    setFlag('predictive.navigation', true);
    setFlag('predictive.frequency', true);
    return { enabled: true };
  });

  // Self-optimizer controls
  register('optimizer.disable', function () {
    setFlag('optimizer.auto', false);
    return { disabled: true };
  });

  register('optimizer.enable', function () {
    setFlag('optimizer.auto', true);
    return { enabled: true };
  });

  register('optimizer.force-adapt', function () {
    var so = G.RuntimeSelfOptimizer;
    if (so && so.forceAdapt) so.forceAdapt();
    return { adapted: true };
  });

  // Worker domain controls
  register('workers.pause-family', function (a) {
    var pw = G.RuntimeProcessorWorkers;
    if (pw && pw.setThermalLimit) pw.setThermalLimit(a.family, 0);
    return { family: a.family, paused: true };
  });

  register('workers.resume-family', function (a) {
    var pw = G.RuntimeProcessorWorkers;
    if (pw && pw.setThermalLimit) pw.setThermalLimit(a.family, a.limit || 2);
    return { family: a.family, limit: a.limit || 2 };
  });

  // Extreme mode controls
  register('extreme.trigger', function (a) {
    if (G.triggerExtremeMode) G.triggerExtremeMode(a.mode, 'control-plane');
    return { mode: a.mode };
  });

  register('extreme.lift', function (a) {
    if (G.liftExtremeMode) G.liftExtremeMode(a.mode);
    return { mode: a.mode };
  });

  // Cache controls
  register('cache.clear', function () {
    var sc = G.RuntimeSmartCache;
    if (sc && sc.clear) sc.clear();
    return { cleared: true };
  });

  // Dashboard controls
  register('dashboard.show', function () {
    setFlag('dashboard.visible', true);
    G.dispatchEvent(new CustomEvent('arc8:dashboard-show', {}));
    return { visible: true };
  });

  register('dashboard.hide', function () {
    setFlag('dashboard.visible', false);
    G.dispatchEvent(new CustomEvent('arc8:dashboard-hide', {}));
    return { visible: false };
  });

  // ── State snapshot ────────────────────────────────────────────────
  function getState() {
    return Object.freeze({
      version:    VERSION,
      ts:         Date.now(),
      flags:      Object.assign({}, _flags),
      commands:   Object.keys(_commands),
      auditCount: _audit.length,
      lastCmd:    _audit.length ? _audit[_audit.length - 1] : null,
    });
  }

  G.RuntimeControlPlane = Object.freeze({
    VERSION:    VERSION,
    execute:    execute,
    register:   register,
    setFlag:    setFlag,
    getFlag:    getFlag,
    getState:   getState,
    getAudit:   function () { return _audit.slice(); },
    getFlags:   function () { return Object.assign({}, _flags); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready —', Object.keys(_commands).length, 'commands | window.RuntimeControlPlane.execute()');

}(window));

// ── SOURCE: public/js/runtime-live-dashboard.js ──
// RuntimeLiveDashboard v1.0 — Arc 8 / Phase B
// =====================================================================
// Live floating observability overlay. Toggle: Ctrl+Shift+R.
//
// Integrates: RuntimeStreamTelemetry, RuntimeHealthOrchestrator,
//   RuntimeProcessorHealth, RuntimeMemoryFirewalls,
//   RuntimeTaskOrchestrator, RuntimeControlPlane.
//
// Production: auto-hidden unless flag 'dashboard.visible' is true or
//   URL has ?debug=1 or sessionStorage has ilpdf_dash=1.
// Isolation: absolutely positioned overlay, pointer-events:none when
//   hidden, never touches tool DOM, all state in closure.
// Performance: no timers when hidden (requestAnimationFrame loop only
//   active while visible). Zero overhead idle.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeLiveDashboard) return;

  var LOG     = '[LiveDashboard]';
  var VERSION = '1.0';

  // ── Visibility gate ───────────────────────────────────────────────
  var _isProd = !G.location.hostname.includes('localhost') &&
                !G.location.hostname.includes('replit.dev') &&
                !G.location.search.includes('debug=1');
  var _enabled = !_isProd ||
    (function () {
      try { return sessionStorage.getItem('ilpdf_dash') === '1'; } catch (_) { return false; }
    }());

  var _visible = false;
  var _rafId   = null;
  var _el      = null;
  var _built   = false;

  // ── Metrics ring buffers ──────────────────────────────────────────
  var RING = 30;

  function Ring(n) {
    var b = [];
    return {
      push: function (v) { b.push(v); if (b.length > n) b.shift(); return this; },
      last: function () { return b.length ? b[b.length - 1] : 0; },
      avg:  function () { return b.length ? b.reduce(function (s, x) { return s + x; }, 0) / b.length : 0; },
      arr:  function () { return b.slice(); },
    };
  }

  var _rings = {
    fps:     Ring(RING),
    heapPct: Ring(RING),
    queued:  Ring(RING),
    running: Ring(RING),
    p0ms:    Ring(RING),
    p1ms:    Ring(RING),
  };

  // ── Styles ────────────────────────────────────────────────────────
  var CSS = [
    '#ilpdf-dash{position:fixed;top:8px;right:8px;z-index:2147483647;',
    'width:280px;background:rgba(0,0,0,0.88);color:#e0e0e0;font:11px/1.4 monospace;',
    'border:1px solid #444;border-radius:6px;padding:8px 10px;pointer-events:auto;',
    'box-shadow:0 4px 24px rgba(0,0,0,0.5);user-select:none}',
    '#ilpdf-dash h1{font-size:11px;margin:0 0 6px;color:#7ec8e3;letter-spacing:.5px}',
    '#ilpdf-dash .row{display:flex;justify-content:space-between;margin:1px 0}',
    '#ilpdf-dash .lbl{color:#999}',
    '#ilpdf-dash .val{color:#ffe}',
    '#ilpdf-dash .ok{color:#8f8}',
    '#ilpdf-dash .warn{color:#fa8}',
    '#ilpdf-dash .bad{color:#f66}',
    '#ilpdf-dash .sep{border-top:1px solid #333;margin:4px 0}',
    '#ilpdf-dash .bar{display:inline-block;height:6px;background:#3b8;border-radius:2px;vertical-align:middle}',
    '#ilpdf-dash .close-btn{float:right;cursor:pointer;color:#888;font-size:13px;line-height:1}',
  ].join('');

  // ── DOM build ─────────────────────────────────────────────────────
  function _build() {
    if (_built) return;
    _built = true;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    _el = document.createElement('div');
    _el.id = 'ilpdf-dash';
    _el.innerHTML = '<h1>ILPDF RUNTIME <span class="close-btn" title="Ctrl+Shift+R">✕</span></h1><div id="ilpdf-dash-body"></div>';
    document.body.appendChild(_el);

    _el.querySelector('.close-btn').addEventListener('click', hide);

    // Make draggable
    var dragging = false, ox = 0, oy = 0;
    _el.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('close-btn')) return;
      dragging = true;
      ox = e.clientX - _el.getBoundingClientRect().left;
      oy = e.clientY - _el.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      _el.style.left  = (e.clientX - ox) + 'px';
      _el.style.top   = (e.clientY - oy) + 'px';
      _el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  // ── Render ────────────────────────────────────────────────────────
  function _row(label, value, cls) {
    return '<div class="row"><span class="lbl">' + label + '</span><span class="val ' + (cls || '') + '">' + value + '</span></div>';
  }

  function _bar(pct) {
    var w = Math.round(Math.min(100, Math.max(0, pct)));
    var cls = w > 85 ? 'bad' : w > 65 ? 'warn' : 'ok';
    return '<span class="bar ' + cls + '" style="width:' + Math.round(w * 0.8) + 'px"></span> ' + w + '%';
  }

  function _collect() {
    var fps = 0, heapPct = 0, queued = 0, running = 0, p0ms = 0, p1ms = 0;

    try { fps = G.RuntimeStreamTelemetry.getFps(); } catch (_) {}
    try {
      var pm = performance.memory;
      heapPct = pm ? Math.round(pm.usedJSHeapSize / pm.jsHeapSizeLimit * 100) : 0;
    } catch (_) {}
    try {
      var ts = G.RuntimeTaskOrchestrator.getStats();
      queued = ts.queued; running = ts.running;
    } catch (_) {}
    try {
      var snap = G.RuntimeStreamTelemetry.getSnapshot();
      p0ms = snap.hydration.P0 ? snap.hydration.P0.avg : 0;
      p1ms = snap.hydration.P1 ? snap.hydration.P1.avg : 0;
    } catch (_) {}

    _rings.fps.push(fps); _rings.heapPct.push(heapPct);
    _rings.queued.push(queued); _rings.running.push(running);
    _rings.p0ms.push(p0ms); _rings.p1ms.push(p1ms);
  }

  function _render() {
    if (!_el || !_visible) return;
    _collect();

    var fps     = _rings.fps.last();
    var heap    = _rings.heapPct.last();
    var queued  = _rings.queued.last();
    var running = _rings.running.last();
    var p0ms    = Math.round(_rings.p0ms.last());
    var p1ms    = Math.round(_rings.p1ms.last());

    var buildId = '—';
    try { buildId = G.RuntimeDeploySync ? G.RuntimeDeploySync.getBuildId() : '—'; } catch (_) {}

    var procHealth = '—';
    try {
      var ph = G.getProcessorHealth && G.getProcessorHealth();
      if (ph) {
        var low = Object.keys(ph).filter(function (k) { return ph[k] < 70; });
        procHealth = low.length ? low.join(',') + ' ⚠' : 'all ok';
      }
    } catch (_) {}

    var thermalTier = '—';
    try { thermalTier = G.RuntimeTaskOrchestrator.getThermalTier(); } catch (_) {}

    var incidents = 0;
    try { incidents = (G.getRuntimeIncidents && G.getRuntimeIncidents().length) || 0; } catch (_) {}

    var extreme = '—';
    try {
      var em = G.RuntimeMobileExtremeMode;
      var modes = em.getActiveModes();
      extreme = modes.length ? modes.join(',') : 'none';
    } catch (_) {}

    var fpsColor = fps < 25 ? 'bad' : fps < 50 ? 'warn' : 'ok';
    var body = [
      _row('BUILD', buildId, 'ok'),
      '<div class="sep"></div>',
      _row('FPS', fps, fpsColor),
      _row('HEAP', _bar(heap)),
      _row('THERMAL', thermalTier, thermalTier === 'critical' ? 'bad' : thermalTier === 'hot' ? 'warn' : 'ok'),
      '<div class="sep"></div>',
      _row('TASKS queued', queued),
      _row('TASKS running', running),
      '<div class="sep"></div>',
      _row('HYD P0', p0ms + 'ms', p0ms > 100 ? 'warn' : 'ok'),
      _row('HYD P1', p1ms + 'ms', p1ms > 200 ? 'warn' : 'ok'),
      '<div class="sep"></div>',
      _row('PROCESSORS', procHealth, procHealth === 'all ok' ? 'ok' : 'warn'),
      _row('INCIDENTS', incidents, incidents > 0 ? 'warn' : 'ok'),
      _row('EXTREME', extreme, extreme === 'none' ? 'ok' : 'bad'),
      '<div class="sep"></div>',
      '<div class="row" style="font-size:9px;color:#555">Ctrl+Shift+R to hide</div>',
    ].join('');

    var bodyEl = document.getElementById('ilpdf-dash-body');
    if (bodyEl) bodyEl.innerHTML = body;
  }

  // ── RAF loop ──────────────────────────────────────────────────────
  var _lastRender = 0;
  function _loop(ts) {
    if (!_visible) { _rafId = null; return; }
    if (ts - _lastRender >= 500) { _render(); _lastRender = ts; }
    _rafId = G.requestAnimationFrame(_loop);
  }

  // ── Show/hide ─────────────────────────────────────────────────────
  function show() {
    if (!_enabled && !G.location.search.includes('debug=1')) {
      try { sessionStorage.setItem('ilpdf_dash', '1'); } catch (_) {}
      _enabled = true;
    }
    _build();
    _visible = true;
    if (_el) _el.style.display = 'block';
    if (!_rafId) _rafId = G.requestAnimationFrame(_loop);
    try { G.RuntimeControlPlane && G.RuntimeControlPlane.setFlag('dashboard.visible', true); } catch (_) {}
    console.debug(LOG, 'dashboard shown');
  }

  function hide() {
    _visible = false;
    if (_el) _el.style.display = 'none';
    if (_rafId) { G.cancelAnimationFrame(_rafId); _rafId = null; }
    try { G.RuntimeControlPlane && G.RuntimeControlPlane.setFlag('dashboard.visible', false); } catch (_) {}
  }

  function toggle() { _visible ? hide() : show(); }

  // ── Keyboard shortcut: Ctrl+Shift+R ──────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      toggle();
    }
  });

  // ── Control plane integration ─────────────────────────────────────
  G.addEventListener('arc8:dashboard-show', show);
  G.addEventListener('arc8:dashboard-hide', hide);

  G.RuntimeLiveDashboard = Object.freeze({
    VERSION: VERSION,
    show:    show,
    hide:    hide,
    toggle:  toggle,
    isVisible: function () { return _visible; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — Ctrl+Shift+R to toggle | production gate:', _isProd);

}(window));

// ── SOURCE: public/js/runtime-trace-engine.js ──
// RuntimeTraceEngine v1.0 — Arc 8 / Phase C
// =====================================================================
// Distributed runtime trace system with hierarchical span trees.
//
// A TRACE = one user operation (tool activation, large file process).
// A SPAN  = one unit of work within that trace (hydrate P0, start worker,
//           chunk batch, etc.) with parent–child relationships.
//
// Features:
//   - Unique trace IDs + span IDs
//   - Parent-child span tree (call hierarchy)
//   - Worker/processor/hydration/recovery trace propagation via events
//   - Ring-buffer storage (500 completed traces)
//   - Automatic slow-path detection: p99 > threshold → mark as slow
//   - p50/p90/p99 latency computation across trace populations
//   - Export: window.getRuntimeTraces()
//
// Distinct from RuntimeSessionRecorder (security replay) and
// RuntimeForensicsReplay (attack forensics).
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeTraceEngine) return;

  var LOG     = '[TraceEngine]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_TRACES    = 500;   // completed trace ring buffer
  var MAX_ACTIVE    = 50;    // max concurrent active traces
  var SLOW_PATH_MS  = 500;   // mark trace slow if duration > this
  var P99_SLOW_MS   = 1000;

  // ── Storage ───────────────────────────────────────────────────────
  var _active    = {};  // traceId → trace
  var _completed = [];  // ring buffer of completed traces
  var _metrics   = { started: 0, completed: 0, slow: 0, errors: 0 };
  var _telemetry = [];

  function _tel(ev, d) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: d || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── ID generation ─────────────────────────────────────────────────
  var _seq = 0;
  function _tid() { return 'tr_' + Date.now().toString(36) + '_' + (++_seq).toString(36); }
  function _sid() { return 'sp_' + Date.now().toString(36) + '_' + (++_seq).toString(36); }

  // ── Start a trace ─────────────────────────────────────────────────
  // Returns: { traceId, rootSpanId }
  function startTrace(name, meta) {
    if (Object.keys(_active).length >= MAX_ACTIVE) {
      // Evict oldest
      var oldest = Object.keys(_active).sort(function (a, b) {
        return _active[a].startedAt - _active[b].startedAt;
      })[0];
      _completeTrace(oldest, 'evicted');
    }
    var traceId    = _tid();
    var rootSpanId = _sid();
    var now        = Date.now();
    _active[traceId] = {
      traceId:    traceId,
      name:       name || 'unnamed',
      meta:       meta || {},
      startedAt:  now,
      spans:      {},
      rootSpanId: rootSpanId,
      slow:       false,
    };
    // Create root span
    _active[traceId].spans[rootSpanId] = {
      spanId:    rootSpanId,
      parentId:  null,
      name:      name || 'root',
      startedAt: now,
      endedAt:   null,
      durationMs: null,
      meta:      meta || {},
      error:     null,
      children:  [],
    };
    _metrics.started++;
    _tel('start', { traceId: traceId, name: name });
    return { traceId: traceId, rootSpanId: rootSpanId };
  }

  // ── Start a child span ────────────────────────────────────────────
  function startSpan(traceId, parentSpanId, name, meta) {
    var trace = _active[traceId];
    if (!trace) return null;
    var spanId = _sid();
    var now    = Date.now();
    trace.spans[spanId] = {
      spanId:    spanId,
      parentId:  parentSpanId || trace.rootSpanId,
      name:      name || 'span',
      startedAt: now,
      endedAt:   null,
      durationMs: null,
      meta:      meta || {},
      error:     null,
      children:  [],
    };
    // Register as child of parent
    var parent = trace.spans[parentSpanId || trace.rootSpanId];
    if (parent) parent.children.push(spanId);
    return spanId;
  }

  // ── End a span ────────────────────────────────────────────────────
  function endSpan(traceId, spanId, error) {
    var trace = _active[traceId];
    if (!trace) return;
    var span  = trace.spans[spanId];
    if (!span || span.endedAt) return;
    span.endedAt    = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    if (error) { span.error = String(error); _metrics.errors++; }
  }

  // ── Complete a trace ──────────────────────────────────────────────
  function endTrace(traceId, error) {
    _completeTrace(traceId, error ? 'error' : 'ok');
  }

  function _completeTrace(traceId, reason) {
    var trace = _active[traceId];
    if (!trace) return;
    delete _active[traceId];

    var now = Date.now();
    // Close any still-open spans
    Object.keys(trace.spans).forEach(function (sid) {
      var span = trace.spans[sid];
      if (!span.endedAt) { span.endedAt = now; span.durationMs = now - span.startedAt; }
    });

    trace.endedAt    = now;
    trace.durationMs = now - trace.startedAt;
    trace.reason     = reason;
    trace.slow       = trace.durationMs > SLOW_PATH_MS;
    if (trace.slow) { _metrics.slow++; _tel('slow', { traceId: traceId, ms: trace.durationMs }); }

    _metrics.completed++;
    _completed.push(Object.freeze(trace));
    if (_completed.length > MAX_TRACES) _completed.shift();
  }

  // ── Percentile computation ────────────────────────────────────────
  function _pct(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  }

  function getStats() {
    var durations = _completed.map(function (t) { return t.durationMs || 0; });
    return {
      completed: _completed.length,
      active:    Object.keys(_active).length,
      slow:      _metrics.slow,
      errors:    _metrics.errors,
      p50:       _pct(durations, 50),
      p90:       _pct(durations, 90),
      p99:       _pct(durations, 99),
      slowPct:   durations.length
        ? Math.round((_metrics.slow / durations.length) * 100) : 0,
    };
  }

  // ── Event hooks — auto-trace Arc 7 operations ────────────────────
  G.addEventListener('streaming-hydration:viewport', function (evt) {
    try {
      var id   = evt && evt.detail && evt.detail.toolId;
      var ref  = startTrace('hydration:viewport:' + (id || 'unknown'));
      setTimeout(function () { endTrace(ref.traceId); }, 1000);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    var d = evt && evt.detail;
    if (!d || d.pct !== 100) return;
    try { endTrace(d.token); } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var ref = startTrace('memory:panic');
      endTrace(ref.traceId, 'panic');
    } catch (_) {}
  });

  G.addEventListener('arc8:command', function (evt) {
    try {
      var d   = evt && evt.detail;
      var ref = startTrace('control-plane:' + (d && d.cmd));
      endTrace(ref.traceId);
    } catch (_) {}
  });

  // ── Export ────────────────────────────────────────────────────────
  G.getRuntimeTraces = function (opts) {
    opts = opts || {};
    var result = _completed.slice();
    if (opts.slowOnly) result = result.filter(function (t) { return t.slow; });
    if (opts.name)     result = result.filter(function (t) { return t.name.includes(opts.name); });
    if (opts.limit)    result = result.slice(-opts.limit);
    return result;
  };

  G.RuntimeTraceEngine = Object.freeze({
    VERSION:    VERSION,
    startTrace: startTrace,
    startSpan:  startSpan,
    endSpan:    endSpan,
    endTrace:   endTrace,
    getStats:   getStats,
    getActive:  function () { return Object.assign({}, _active); },
    getTelemetry: function () { return _telemetry.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — ring:', MAX_TRACES, 'traces | slowPath:', SLOW_PATH_MS + 'ms | window.getRuntimeTraces()');

}(window));

// ── SOURCE: public/js/runtime-event-timeline.js ──
// RuntimeEventTimeline v1.0 — Arc 8 / Phase D
// =====================================================================
// Centralized runtime event timeline. Captures ALL runtime CustomEvents
// into a searchable, bounded ring buffer with compression and grouping.
//
// Coverage: worker, hydration, bundle, recovery, panic, predictive,
//   deploy, offline, task, control plane, extreme mode events.
//
// Features:
//   - Searchable by keyword, family, processor, workerDomain
//   - Grouped views by tool family / processor / worker domain
//   - Bounded ring buffer (2000 events, configurable)
//   - Burst compression: identical events within 50ms collapsed to count
//   - Timeline snapshots (frozen copy at a moment in time)
//   - window.getEventTimeline() for console/dashboard access
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeEventTimeline) return;

  var LOG     = '[EventTimeline]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_EVENTS   = 2000;
  var COMPRESS_MS  = 50;   // collapse duplicate events within this window

  // ── Storage ───────────────────────────────────────────────────────
  var _events  = [];  // { id, ts, type, family, processor, workerDomain, data, count }
  var _seq     = 0;
  var _metrics = { captured: 0, compressed: 0, dropped: 0 };

  function _genId() { return ++_seq; }

  // ── Capture an event ──────────────────────────────────────────────
  function capture(type, data, tags) {
    tags = tags || {};
    var now = Date.now();

    // Burst compression: check last event
    if (_events.length > 0) {
      var last = _events[_events.length - 1];
      if (last.type === type && (now - last.ts) <= COMPRESS_MS &&
          last.family === (tags.family || null) &&
          last.processor === (tags.processor || null)) {
        last.count = (last.count || 1) + 1;
        last.tsLast = now;
        _metrics.compressed++;
        return last.id;
      }
    }

    var ev = {
      id:          _genId(),
      ts:          now,
      type:        type,
      family:      tags.family       || null,
      processor:   tags.processor    || null,
      workerDomain: tags.workerDomain || null,
      data:        data  ? Object.assign({}, data) : null,
      count:       1,
      tsLast:      now,
    };

    _events.push(ev);
    _metrics.captured++;
    if (_events.length > MAX_EVENTS) {
      _events.shift();
      _metrics.dropped++;
    }
    return ev.id;
  }

  // ── Listen to all runtime events ──────────────────────────────────
  var CAPTURE_MAP = [
    // Arc 7 streaming
    { ev: 'streaming-hydration:viewport',      family: null,      tags: function (d) { return { family: null, processor: null, workerDomain: null }; } },
    { ev: 'predictive-loader:preload',         family: 'predict', tags: function (d) { return { family: d && d.family }; } },
    { ev: 'stream-workers:progress',           family: null,      tags: function (d) { return { workerDomain: d && d.token }; } },
    { ev: 'self-optimizer:adapt',              family: null,      tags: function () { return {}; } },
    { ev: 'extreme-mode:activate',             family: null,      tags: function () { return {}; } },
    { ev: 'extreme-mode:deactivate',           family: null,      tags: function () { return {}; } },
    // Arc 8
    { ev: 'arc8:command',                      family: null,      tags: function (d) { return { processor: d && d.cmd }; } },
    { ev: 'arc8:incident',                     family: null,      tags: function (d) { return { family: d && d.category }; } },
    { ev: 'arc8:snapshot',                     family: null,      tags: function () { return {}; } },
    // Memory
    { ev: 'processor-memory:panic',            family: null,      tags: function (d) { return { family: d && d.family }; } },
    { ev: 'memory-firewall:budget-exceeded',   family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    // Workers
    { ev: 'processor-workers:isolated',        family: null,      tags: function (d) { return { family: d && d.family }; } },
    { ev: 'tool:worker-crash',                 family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    // Hydration
    { ev: 'processor-hydration:activated',     family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    { ev: 'arc7:streaming-hydration-ready',    family: null,      tags: function () { return {}; } },
    // Deploy
    { ev: 'deploy:sync-ready',                 family: 'deploy',  tags: function (d) { return { workerDomain: d && d.buildId }; } },
    // Mobile
    { ev: 'mobile:battery-save',               family: 'mobile',  tags: function () { return {}; } },
    // Offline
    { ev: 'offline:queued',                    family: 'offline', tags: function (d) { return { processor: d && d.toolId }; } },
    { ev: 'offline:replayed',                  family: 'offline', tags: function (d) { return { processor: d && d.toolId }; } },
    // Recovery
    { ev: 'recovery:escalated',                family: 'recovery', tags: function (d) { return { processor: d && d.toolId }; } },
    // Task
    { ev: 'task-orchestrator:throttled',       family: 'task',    tags: function () { return {}; } },
  ];

  CAPTURE_MAP.forEach(function (spec) {
    G.addEventListener(spec.ev, function (evt) {
      try {
        var d    = evt && evt.detail;
        var tags = spec.tags(d);
        capture(spec.ev, d, tags);
      } catch (_) {}
    });
  });

  // ── Query / search ────────────────────────────────────────────────
  function search(opts) {
    opts = opts || {};
    var result = _events.slice();
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      result = result.filter(function (e) {
        return e.type.toLowerCase().includes(kw) ||
          (e.family && e.family.toLowerCase().includes(kw)) ||
          (e.processor && String(e.processor).toLowerCase().includes(kw));
      });
    }
    if (opts.family)      result = result.filter(function (e) { return e.family === opts.family; });
    if (opts.processor)   result = result.filter(function (e) { return e.processor === opts.processor; });
    if (opts.workerDomain) result = result.filter(function (e) { return e.workerDomain === opts.workerDomain; });
    if (opts.since)       result = result.filter(function (e) { return e.ts >= opts.since; });
    if (opts.limit)       result = result.slice(-opts.limit);
    return result;
  }

  // ── Grouped view ──────────────────────────────────────────────────
  function groupBy(field) {
    var groups = {};
    _events.forEach(function (e) {
      var key = e[field] || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });
    return groups;
  }

  // ── Snapshot ──────────────────────────────────────────────────────
  function snapshot() {
    var snap = Object.freeze({
      ts:     Date.now(),
      count:  _events.length,
      events: _events.slice().map(Object.freeze),
      metrics: Object.assign({}, _metrics),
    });
    try {
      G.dispatchEvent(new CustomEvent('arc8:snapshot', { detail: { type: 'timeline', count: snap.count } }));
    } catch (_) {}
    return snap;
  }

  // ── Export ────────────────────────────────────────────────────────
  G.getEventTimeline = function (opts) { return search(opts || {}); };

  G.RuntimeEventTimeline = Object.freeze({
    VERSION:  VERSION,
    capture:  capture,
    search:   search,
    groupBy:  groupBy,
    snapshot: snapshot,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getCount:   function () { return _events.length; },
    clear:      function () { _events = []; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — listening to', CAPTURE_MAP.length, 'event types | window.getEventTimeline()');

}(window));

// ── SOURCE: public/js/runtime-performance-profiler.js ──
// RuntimePerformanceProfiler v1.0 — Arc 8 / Phase E
// =====================================================================
// Runtime sampling profiler + bottleneck analyzer.
// Distinct from RuntimePerformanceMonitor (LCP/FID/CLS web vitals) —
// this targets RUNTIME-INTERNAL execution costs.
//
// Techniques:
//   - Adaptive interval sampling (50ms nominal, 200ms battery-save)
//   - PerformanceObserver longtask detection
//   - Per-tool / per-family execution cost accumulation
//   - Hydration bottleneck: captures P0/P1/P2 timing outliers
//   - Worker bottleneck: tracks per-family crash/stall rates
//   - CPU budget tracking: ms-per-tool-category over 30s windows
//   - Frame-drop analysis: counts frames > 33ms (< 30fps)
//   - window.getRuntimeProfile() for full snapshot
//
// Zero overhead when profiler.sampling flag is false.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimePerformanceProfiler) return;

  var LOG     = '[PerfProfiler]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SAMPLE_MS    = 50;
  var WINDOW_MS    = 30 * 1000;
  var MAX_SAMPLES  = 600;  // 30s at 50ms
  var LONGTASK_MS  = 50;   // PerformanceObserver threshold

  // ── State ─────────────────────────────────────────────────────────
  var _sampling  = false;
  var _sampler   = null;
  var _samples   = [];   // { ts, heapMb, fps, thermalTier }
  var _costs     = {};   // toolId → { totalMs, count, p99Ms, samples[] }
  var _families  = {};   // family → { totalMs, count, workerCrashes, longtasks }
  var _longTasks = [];   // { ts, durationMs, attribution }
  var _frameDrops = 0;
  var _lastFrameTs = 0;
  var _metrics   = { samples: 0, longTasks: 0, frameDrops: 0 };
  var _observer  = null;
  var _rafFrame  = null;

  // ── Adaptive sample rate ──────────────────────────────────────────
  function _sampleRate() {
    try {
      var cp = G.RuntimeControlPlane;
      if (cp && !cp.getFlag('profiler.sampling')) return 0;
    } catch (_) {}
    return SAMPLE_MS;
  }

  // ── Per-sample snapshot ───────────────────────────────────────────
  function _takeSample() {
    var now  = Date.now();
    var heap = 0;
    try {
      var pm = performance.memory;
      heap = pm ? Math.round(pm.usedJSHeapSize / 1024 / 1024) : 0;
    } catch (_) {}

    var fps = 0;
    try { fps = G.RuntimeStreamTelemetry ? G.RuntimeStreamTelemetry.getFps() : 0; } catch (_) {}

    var thermalTier = 'nominal';
    try { thermalTier = G.RuntimeTaskOrchestrator ? G.RuntimeTaskOrchestrator.getThermalTier() : 'nominal'; } catch (_) {}

    _samples.push({ ts: now, heapMb: heap, fps: fps, thermalTier: thermalTier });
    if (_samples.length > MAX_SAMPLES) _samples.shift();
    _metrics.samples++;
  }

  // ── PerformanceObserver for long tasks ────────────────────────────
  function _installLongTaskObserver() {
    if (!G.PerformanceObserver) return;
    try {
      _observer = new G.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          var ms   = Math.round(entry.duration);
          var attr = (entry.attribution && entry.attribution[0])
            ? entry.attribution[0].name : 'unknown';
          _longTasks.push({ ts: Date.now(), durationMs: ms, attribution: attr });
          if (_longTasks.length > 200) _longTasks.shift();
          _metrics.longTasks++;
          _metrics.frameDrops += Math.floor(ms / 33);

          // Route to family if attributable
          var family = _guessFamily(attr);
          if (family) _ensureFamily(family).longtasks++;

          try {
            G.dispatchEvent(new CustomEvent('profiler:longtask', {
              detail: { ms: ms, attr: attr, family: family },
            }));
          } catch (_) {}
        });
      });
      _observer.observe({ type: 'longtask', buffered: true });
    } catch (_) {}
  }

  function _guessFamily(attr) {
    if (!attr) return null;
    if (attr.includes('worker'))   return 'worker';
    if (attr.includes('pdf'))      return 'organize';
    if (attr.includes('compress')) return 'compress';
    if (attr.includes('ocr'))      return 'ocr';
    if (attr.includes('convert'))  return 'convert';
    if (attr.includes('image'))    return 'image';
    return null;
  }

  // ── rAF frame-drop monitor ────────────────────────────────────────
  function _rafLoop(ts) {
    if (!_sampling) { _rafFrame = null; return; }
    if (_lastFrameTs > 0) {
      var gap = ts - _lastFrameTs;
      if (gap > 33) { _frameDrops++; _metrics.frameDrops++; }
    }
    _lastFrameTs = ts;
    _rafFrame = G.requestAnimationFrame(_rafLoop);
  }

  // ── Record tool execution cost ────────────────────────────────────
  function recordCost(toolId, family, durationMs) {
    if (!_costs[toolId]) _costs[toolId] = { totalMs: 0, count: 0, samples: [] };
    var c = _costs[toolId];
    c.totalMs += durationMs;
    c.count++;
    c.samples.push(durationMs);
    if (c.samples.length > 50) c.samples.shift();
    c.p99Ms = _pct(c.samples, 99);

    if (family) {
      _ensureFamily(family).totalMs += durationMs;
      _ensureFamily(family).count++;
    }
  }

  function _ensureFamily(family) {
    if (!_families[family]) _families[family] = { totalMs: 0, count: 0, workerCrashes: 0, longtasks: 0 };
    return _families[family];
  }

  function _pct(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  }

  // ── Hook Arc 7 events for cost attribution ────────────────────────
  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var f = evt && evt.detail && evt.detail.family;
      if (f) _ensureFamily(f).workerCrashes++;
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.pct === 100 && d.token) {
        // Best-effort attribution — token as toolId proxy
        recordCost(d.token, null, 0);
      }
    } catch (_) {}
  });

  // ── Start / stop profiler ─────────────────────────────────────────
  function start() {
    if (_sampling) return;
    _sampling = true;
    var rate = _sampleRate() || SAMPLE_MS;
    _sampler = setInterval(_takeSample, rate);
    _rafFrame = G.requestAnimationFrame(_rafLoop);
    console.debug(LOG, 'profiler started — sample rate:', rate + 'ms');
  }

  function stop() {
    _sampling = false;
    clearInterval(_sampler);
    _sampler = null;
    console.debug(LOG, 'profiler stopped | samples:', _metrics.samples);
  }

  // ── Full profile snapshot ─────────────────────────────────────────
  function getProfile() {
    var now = Date.now();
    var window30s = _samples.filter(function (s) { return now - s.ts < WINDOW_MS; });
    var heapVals  = window30s.map(function (s) { return s.heapMb; });
    var fpsVals   = window30s.map(function (s) { return s.fps; });

    var familySummary = {};
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      familySummary[f] = {
        avgMs:        fm.count > 0 ? Math.round(fm.totalMs / fm.count) : 0,
        totalMs:      Math.round(fm.totalMs),
        count:        fm.count,
        workerCrashes: fm.workerCrashes,
        longtasks:    fm.longtasks,
      };
    });

    var toolSummary = {};
    Object.keys(_costs).slice(-20).forEach(function (id) {
      var c = _costs[id];
      toolSummary[id] = {
        avgMs: c.count ? Math.round(c.totalMs / c.count) : 0,
        p99Ms: c.p99Ms,
        count: c.count,
      };
    });

    return {
      ts:         now,
      sampling:   _sampling,
      samples30s: window30s.length,
      heap: {
        min: Math.min.apply(null, heapVals.concat([0])),
        max: Math.max.apply(null, heapVals.concat([0])),
        avg: heapVals.length ? Math.round(heapVals.reduce(function (a, b) { return a + b; }, 0) / heapVals.length) : 0,
      },
      fps: {
        avg: fpsVals.length ? Math.round(fpsVals.reduce(function (a, b) { return a + b; }, 0) / fpsVals.length) : 0,
        min: Math.min.apply(null, fpsVals.concat([0])),
      },
      longTasks:  { count: _metrics.longTasks, recent: _longTasks.slice(-10) },
      frameDrops: _metrics.frameDrops,
      families:   familySummary,
      tools:      toolSummary,
    };
  }

  G.getRuntimeProfile = function () { return getProfile(); };

  // ── Boot: install LongTask observer always; start sampling if flag set ─
  function _boot() {
    _installLongTaskObserver();
    try {
      var cp = G.RuntimeControlPlane;
      if (cp && cp.getFlag('profiler.sampling')) start();
    } catch (_) {}
    // Listen for flag changes
    G.addEventListener('arc8:command', function (evt) {
      try {
        var d = evt && evt.detail;
        if (d && d.cmd === 'flag.set' && d.args && d.args.name === 'profiler.sampling') {
          d.args.value ? start() : stop();
        }
      } catch (_) {}
    });
    console.debug(LOG, 'v' + VERSION + ' ready — longtask observer active | window.getRuntimeProfile()');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimePerformanceProfiler = Object.freeze({
    VERSION:    VERSION,
    start:      start,
    stop:       stop,
    recordCost: recordCost,
    getProfile: getProfile,
    isRunning:  function () { return _sampling; },
    getMetrics: function () { return Object.assign({}, _metrics); },
  });

}(window));

// ── SOURCE: public/js/runtime-incident-center.js ──
// RuntimeIncidentCenter v1.0 — Arc 8 / Phase F
// =====================================================================
// Unified incident registry for ALL runtime failure modes.
// Distinct from RuntimeIncidentEngine (Phase 7 — security anomaly
// classification) — this covers ALL operational runtime incidents.
//
// Severity levels:
//   P0 — Critical: platform unusable, data loss risk
//   P1 — High: tool family down, recovery required
//   P2 — Medium: degraded performance, partial failure
//   P3 — Low: warning-level anomaly, auto-recovered
//
// Incident categories:
//   memory-panic | worker-crash | event-leakage | mutation |
//   deploy-mismatch | hydration-failure | thermal-emergency |
//   offline-queue-overflow | trace-slow-path | control-plane-error
//
// Features:
//   - Deduplication: hash by (category + context) within 5-min window
//   - Escalation: P3→P2 after 5 occurrences; P2→P1 after 3; P1→P0 after 2
//   - Auto-recommendations: quarantine / recovery advice per category
//   - Timeline correlation with RuntimeEventTimeline
//   - window.getRuntimeIncidents()
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeIncidentCenter) return;

  var LOG     = '[IncidentCenter]';
  var VERSION = '1.0';

  // ── Severity ──────────────────────────────────────────────────────
  var P0 = 0, P1 = 1, P2 = 2, P3 = 3;
  var SEV_NAMES = ['P0-CRITICAL', 'P1-HIGH', 'P2-MEDIUM', 'P3-LOW'];

  // ── Escalation thresholds ─────────────────────────────────────────
  var ESCALATE_COUNTS = { 3: 5, 2: 3, 1: 2 };  // sev → count-before-escalate
  var DEDUP_WINDOW_MS = 5 * 60 * 1000;  // 5 min

  // ── Recommendations ───────────────────────────────────────────────
  var RECOMMENDATIONS = {
    'memory-panic':         'Reduce active processor count; trigger extreme-mode ULTRA_LOW_MEMORY.',
    'worker-crash':         'Isolate crashed family; use RuntimeProcessorWorkers.setThermalLimit().',
    'event-leakage':        'Audit event listener registration in tool activation path.',
    'mutation':             'Check runtime immutability guard; review recent flag changes.',
    'deploy-mismatch':      'Force page reload or clear service worker cache.',
    'hydration-failure':    'Retry with RuntimeStreamingHydration.flush(); check P0 modules.',
    'thermal-emergency':    'Trigger THERMAL_EMERGENCY extreme mode; reduce worker concurrency.',
    'offline-queue-overflow': 'Clear offline queue; check network recovery path.',
    'trace-slow-path':      'Profile with RuntimePerformanceProfiler; check long-task attribution.',
    'control-plane-error':  'Review command audit trail via RuntimeControlPlane.getAudit().',
  };

  // ── Storage ───────────────────────────────────────────────────────
  var _incidents = {};  // key → incident record
  var _list      = [];  // ordered list (reference into _incidents)
  var MAX_LIST   = 500;
  var _metrics   = { total: 0, escalations: 0, deduplications: 0, P0: 0, P1: 0, P2: 0, P3: 0 };

  function _hash(category, context) {
    return category + ':' + (context || '');
  }

  // ── Record an incident ────────────────────────────────────────────
  function record(category, severity, context, data) {
    severity = Math.max(P0, Math.min(P3, severity || P3));
    var key  = _hash(category, context);
    var now  = Date.now();

    // Deduplication: reuse if same category+context within window
    var existing = _incidents[key];
    if (existing && (now - existing.lastTs) < DEDUP_WINDOW_MS) {
      existing.count++;
      existing.lastTs = now;
      existing.data   = data || existing.data;
      _metrics.deduplications++;

      // Escalation check
      var threshold = ESCALATE_COUNTS[existing.severity];
      if (threshold && existing.count >= threshold && existing.severity > P0) {
        existing.severity--;
        existing.escalated = true;
        _metrics.escalations++;
        _metrics[SEV_NAMES[existing.severity].split('-')[0]]++;
        _tel('escalated', { key: key, sev: SEV_NAMES[existing.severity], count: existing.count });
        console.warn(LOG, 'ESCALATED:', key, '→', SEV_NAMES[existing.severity]);
        try {
          G.dispatchEvent(new CustomEvent('arc8:incident', {
            detail: { key: key, category: category, severity: existing.severity, escalated: true },
          }));
        } catch (_) {}
      }
      return existing.id;
    }

    // New incident
    var id = 'inc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    var inc = {
      id:          id,
      category:    category,
      severity:    severity,
      context:     context  || null,
      data:        data     || null,
      firstTs:     now,
      lastTs:      now,
      count:       1,
      escalated:   false,
      resolved:    false,
      recommendation: RECOMMENDATIONS[category] || 'Inspect runtime telemetry for context.',
    };

    _incidents[key] = inc;
    _list.push(inc);
    if (_list.length > MAX_LIST) { var old = _list.shift(); delete _incidents[_hash(old.category, old.context)]; }

    _metrics.total++;
    var sevKey = SEV_NAMES[severity].split('-')[0];
    _metrics[sevKey] = (_metrics[sevKey] || 0) + 1;
    _tel('record', { id: id, category: category, sev: SEV_NAMES[severity] });

    if (severity <= P1) {
      console.warn(LOG, SEV_NAMES[severity] + ':', category, context || '');
    } else {
      console.debug(LOG, SEV_NAMES[severity] + ':', category, context || '');
    }

    try {
      G.dispatchEvent(new CustomEvent('arc8:incident', {
        detail: { id: id, category: category, severity: severity, context: context },
      }));
    } catch (_) {}

    return id;
  }

  function resolve(id) {
    var inc = Object.keys(_incidents).map(function (k) { return _incidents[k]; })
              .find(function (i) { return i.id === id; });
    if (inc) { inc.resolved = true; }
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _tel_buf = [];
  function _tel(ev, d) {
    _tel_buf.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel_buf.length > 100) _tel_buf.shift();
  }

  // ── Auto-capture from runtime events ──────────────────────────────
  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var d = evt && evt.detail;
      record('memory-panic', P1, d && d.family, d);
    } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var d = evt && evt.detail;
      record('worker-crash', P1, d && d.family, d);
    } catch (_) {}
  });

  G.addEventListener('extreme-mode:activate', function (evt) {
    try {
      var d = evt && evt.detail;
      var sev = d && d.mode === 'THERMAL_EMERGENCY' ? P1 : P2;
      record('thermal-emergency', sev, d && d.mode, d);
    } catch (_) {}
  });

  G.addEventListener('memory-firewall:budget-exceeded', function (evt) {
    try {
      var d = evt && evt.detail;
      record('memory-panic', P2, d && d.toolId, d);
    } catch (_) {}
  });

  G.addEventListener('deploy:sync-ready', function (evt) {
    try {
      var d = evt && evt.detail;
      // Only flag if buildId mismatch (deploy sync fires on new deploy)
      if (d && d.mismatch) record('deploy-mismatch', P2, d.buildId, d);
    } catch (_) {}
  });

  G.addEventListener('profiler:longtask', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.ms > 500) record('trace-slow-path', P3, d.attr, d);
    } catch (_) {}
  });

  G.addEventListener('arc8:command', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.result && d.result.ok === false) {
        record('control-plane-error', P3, d.cmd, d);
      }
    } catch (_) {}
  });

  // ── Query ─────────────────────────────────────────────────────────
  function query(opts) {
    opts = opts || {};
    var result = _list.filter(function (i) { return !i.resolved; });
    if (opts.severity !== undefined) result = result.filter(function (i) { return i.severity <= opts.severity; });
    if (opts.category) result = result.filter(function (i) { return i.category === opts.category; });
    if (opts.since)    result = result.filter(function (i) { return i.lastTs >= opts.since; });
    if (opts.limit)    result = result.slice(-opts.limit);
    return result;
  }

  G.getRuntimeIncidents = function (opts) { return query(opts || {}); };

  G.RuntimeIncidentCenter = Object.freeze({
    VERSION:  VERSION,
    P0: P0, P1: P1, P2: P2, P3: P3,
    record:   record,
    resolve:  resolve,
    query:    query,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _tel_buf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — incident registry active | window.getRuntimeIncidents()');

}(window));

// ── SOURCE: public/js/runtime-state-snapshots.js ──
// RuntimeStateSnapshots v1.0 — Arc 8 / Phase G
// =====================================================================
// Full runtime state capture, diff, rollback, and export.
//
// Snapshot contents:
//   - Processor health scores (Arc 6)
//   - Worker pool states (Arc 6)
//   - Hydration domain activation states (Arc 3)
//   - Bundle activation graph (Arc 4)
//   - Memory segment usage per family (Arc 6)
//   - Smart cache stats (Arc 7)
//   - Task orchestrator queue depths (Arc 7)
//   - Stream telemetry counters (Arc 7)
//   - Active extreme modes (Arc 7)
//   - Control plane flags (Arc 8)
//   - Active incidents (Arc 8)
//   - Event timeline count (Arc 8)
//
// Features:
//   - Ring buffer of 10 snapshots (auto-rotate)
//   - Delta diff between any two snapshots
//   - Simple checksum (FNV-1a over JSON) for corruption detection
//   - Export as JSON blob (via URL.createObjectURL if available)
//   - Rollback checkpoint annotation
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStateSnapshots) return;

  var LOG     = '[StateSnapshots]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_SNAPSHOTS = 10;
  var AUTO_MS       = 5 * 60 * 1000;  // auto-snapshot every 5 min

  // ── Storage ───────────────────────────────────────────────────────
  var _snapshots  = [];  // ring buffer
  var _seq        = 0;
  var _metrics    = { taken: 0, diffs: 0, exports: 0, corrupted: 0 };

  // ── FNV-1a checksum (fast, 32-bit) ───────────────────────────────
  function _checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  // ── Collect runtime state ─────────────────────────────────────────
  function _collect(label) {
    var state = { label: label || 'auto', ts: Date.now(), id: ++_seq };

    // Processor health (Arc 6)
    try {
      state.processorHealth = G.getProcessorHealth ? G.getProcessorHealth() : {};
    } catch (_) { state.processorHealth = {}; }

    // Memory usage per family (Arc 6)
    try {
      var pm = G.RuntimeProcessorMemory;
      state.processorMemory = pm && pm.getStats ? pm.getStats() : {};
    } catch (_) { state.processorMemory = {}; }

    // Worker pool states (Arc 6)
    try {
      var pw = G.RuntimeProcessorWorkers;
      state.processorWorkers = pw && pw.getStats ? pw.getStats() : {};
    } catch (_) { state.processorWorkers = {}; }

    // Smart cache stats (Arc 7)
    try {
      var sc = G.RuntimeSmartCache;
      state.smartCache = sc && sc.getStats ? sc.getStats() : {};
    } catch (_) { state.smartCache = {}; }

    // Task orchestrator (Arc 7)
    try {
      var to = G.RuntimeTaskOrchestrator;
      state.taskOrchestrator = to && to.getStats ? to.getStats() : {};
    } catch (_) { state.taskOrchestrator = {}; }

    // Stream telemetry counters (Arc 7)
    try {
      var st = G.RuntimeStreamTelemetry;
      state.streamTelemetry = st && st.getCounters ? st.getCounters() : {};
    } catch (_) { state.streamTelemetry = {}; }

    // Self-optimizer (Arc 7)
    try {
      var so = G.RuntimeSelfOptimizer;
      state.selfOptimizer = so && so.getState ? so.getState() : {};
    } catch (_) { state.selfOptimizer = {}; }

    // Extreme mode (Arc 7)
    try {
      var em = G.RuntimeMobileExtremeMode;
      state.extremeModes = em ? em.getActiveModes() : [];
    } catch (_) { state.extremeModes = []; }

    // Control plane flags (Arc 8)
    try {
      var cp = G.RuntimeControlPlane;
      state.controlFlags = cp ? cp.getFlags() : {};
    } catch (_) { state.controlFlags = {}; }

    // Incidents summary (Arc 8)
    try {
      var inc = G.getRuntimeIncidents;
      var incidents = inc ? inc({ limit: 20 }) : [];
      state.incidentSummary = {
        count: incidents.length,
        P0: incidents.filter(function (i) { return i.severity === 0; }).length,
        P1: incidents.filter(function (i) { return i.severity === 1; }).length,
        P2: incidents.filter(function (i) { return i.severity === 2; }).length,
      };
    } catch (_) { state.incidentSummary = {}; }

    // Event timeline count (Arc 8)
    try {
      var et = G.RuntimeEventTimeline;
      state.eventCount = et ? et.getCount() : 0;
    } catch (_) { state.eventCount = 0; }

    // Heap
    try {
      var perf = performance.memory;
      state.heapMb = perf ? Math.round(perf.usedJSHeapSize / 1024 / 1024) : 0;
    } catch (_) { state.heapMb = 0; }

    return state;
  }

  // ── Take a snapshot ───────────────────────────────────────────────
  function take(label, isCheckpoint) {
    var state    = _collect(label);
    var json     = JSON.stringify(state);
    var checksum = _checksum(json);

    var snap = {
      id:           state.id,
      ts:           state.ts,
      label:        label || 'auto',
      isCheckpoint: !!isCheckpoint,
      checksum:     checksum,
      state:        state,
    };

    _snapshots.push(snap);
    if (_snapshots.length > MAX_SNAPSHOTS) _snapshots.shift();
    _metrics.taken++;

    _tel('take', { id: snap.id, label: snap.label, checkpoint: snap.isCheckpoint });
    try {
      G.dispatchEvent(new CustomEvent('arc8:snapshot', {
        detail: { id: snap.id, label: snap.label, type: 'state' },
      }));
    } catch (_) {}
    console.debug(LOG, 'snapshot #' + snap.id + ' taken:', snap.label, '| checksum:', checksum);
    return snap.id;
  }

  // ── Verify snapshot integrity ──────────────────────────────────────
  function verify(snapId) {
    var snap = _snapshots.find(function (s) { return s.id === snapId; });
    if (!snap) return null;
    var json     = JSON.stringify(snap.state);
    var computed = _checksum(json);
    var ok       = computed === snap.checksum;
    if (!ok) _metrics.corrupted++;
    return { id: snapId, ok: ok, expected: snap.checksum, computed: computed };
  }

  // ── Diff two snapshots ────────────────────────────────────────────
  function diff(idA, idB) {
    var a = _snapshots.find(function (s) { return s.id === idA; });
    var b = _snapshots.find(function (s) { return s.id === idB; });
    if (!a || !b) return null;
    _metrics.diffs++;

    function _diffObj(objA, objB, path) {
      var changes = [];
      var keys = Object.keys(Object.assign({}, objA, objB));
      keys.forEach(function (k) {
        var va = JSON.stringify(objA && objA[k]);
        var vb = JSON.stringify(objB && objB[k]);
        if (va !== vb) changes.push({ path: path + '.' + k, from: objA && objA[k], to: objB && objB[k] });
      });
      return changes;
    }

    return {
      from: { id: a.id, ts: a.ts, label: a.label },
      to:   { id: b.id, ts: b.ts, label: b.label },
      durationMs: b.ts - a.ts,
      changes: _diffObj(a.state, b.state, 'state'),
    };
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportSnap(snapId) {
    var snap = snapId
      ? _snapshots.find(function (s) { return s.id === snapId; })
      : _snapshots[_snapshots.length - 1];
    if (!snap) return null;
    _metrics.exports++;
    var json = JSON.stringify(snap, null, 2);
    // Return as blob URL if supported
    try {
      var blob = new Blob([json], { type: 'application/json' });
      return { url: URL.createObjectURL(blob), json: json };
    } catch (_) {
      return { url: null, json: json };
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _tel_buf = [];
  function _tel(ev, d) {
    _tel_buf.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel_buf.length > 50) _tel_buf.shift();
  }

  // ── Auto-snapshot on key events ───────────────────────────────────
  G.addEventListener('processor-memory:panic', function () {
    take('auto:memory-panic', false);
  });

  G.addEventListener('extreme-mode:activate', function (evt) {
    var d = evt && evt.detail;
    take('auto:extreme:' + (d && d.mode || 'unknown'), false);
  });

  // ── Auto-snapshot on interval ─────────────────────────────────────
  setInterval(function () { take('auto:interval'); }, AUTO_MS);

  G.RuntimeStateSnapshots = Object.freeze({
    VERSION:  VERSION,
    take:     take,
    verify:   verify,
    diff:     diff,
    export:   exportSnap,
    list:     function () {
      return _snapshots.map(function (s) {
        return { id: s.id, ts: s.ts, label: s.label, isCheckpoint: s.isCheckpoint, checksum: s.checksum };
      });
    },
    get:      function (id) { return _snapshots.find(function (s) { return s.id === id; }) || null; },
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _tel_buf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — max:', MAX_SNAPSHOTS, 'snapshots | auto-interval:', AUTO_MS / 60000 + 'min');

}(window));

// ── SOURCE: public/js/runtime-replay-engine.js ──
// RuntimeReplayEngine v1.0 — Arc 8 / Phase H
// =====================================================================
// Runtime event replay. Replays events from RuntimeEventTimeline for
// debugging, post-mortem analysis, and stepped execution review.
//
// Distinct from RuntimeForensicsReplay (security attack forensics) —
// this replays OPERATIONAL runtime events for performance debugging.
//
// Features:
//   - Load events from RuntimeEventTimeline or injected dataset
//   - Scrubber: position 0.0–1.0 across event timeline
//   - Playback controls: play / pause / step / setSpeed
//   - Event-by-event debug stepping
//   - Event filtering: by type, family, processor, severity
//   - Playback speed: 0.25x / 0.5x / 1x / 2x / 4x / 10x
//   - Replay export: returns filtered event list as JSON
//   - Emits replay:event on each replayed step for UI integration
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeReplayEngine) return;

  var LOG     = '[ReplayEngine]';
  var VERSION = '1.0';

  // ── State ─────────────────────────────────────────────────────────
  var _dataset   = [];    // loaded events
  var _position  = 0;    // current index
  var _playing   = false;
  var _speed     = 1.0;  // playback speed multiplier
  var _timer     = null;
  var _sessions  = {};   // sessionId → { dataset, position, created }
  var _sessionSeq = 0;
  var _metrics   = { played: 0, stepped: 0, loads: 0, exports: 0 };

  // ── Load events ───────────────────────────────────────────────────
  function load(events, opts) {
    opts    = opts || {};
    var src = events || [];

    // Filter if opts provided
    if (opts.type)    src = src.filter(function (e) { return e.type === opts.type; });
    if (opts.family)  src = src.filter(function (e) { return e.family === opts.family; });
    if (opts.since)   src = src.filter(function (e) { return e.ts >= opts.since; });
    if (opts.until)   src = src.filter(function (e) { return e.ts <= opts.until; });
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      src = src.filter(function (e) {
        return (e.type && e.type.includes(kw)) ||
               (e.family && e.family.includes(kw)) ||
               (e.processor && String(e.processor).includes(kw));
      });
    }

    // Sort by timestamp
    src = src.slice().sort(function (a, b) { return a.ts - b.ts; });
    _dataset  = src;
    _position = 0;
    _playing  = false;
    clearInterval(_timer);
    _timer = null;
    _metrics.loads++;

    console.debug(LOG, 'loaded', src.length, 'events');
    return src.length;
  }

  // ── Load from RuntimeEventTimeline (most common case) ─────────────
  function loadFromTimeline(opts) {
    try {
      var et = G.RuntimeEventTimeline;
      if (!et) { console.warn(LOG, 'RuntimeEventTimeline not available'); return 0; }
      var events = et.search(opts || {});
      return load(events, {});
    } catch (e) {
      console.warn(LOG, 'load-from-timeline error:', e.message);
      return 0;
    }
  }

  // ── Scrub to position ─────────────────────────────────────────────
  function seek(pct) {
    pct = Math.max(0, Math.min(1, pct));
    _position = Math.round(pct * Math.max(0, _dataset.length - 1));
    _emitCurrent();
  }

  function _emitCurrent() {
    var ev = _dataset[_position];
    if (!ev) return;
    try {
      G.dispatchEvent(new CustomEvent('replay:event', {
        detail: { index: _position, total: _dataset.length, event: ev,
                  pct: _dataset.length > 1 ? _position / (_dataset.length - 1) : 1 },
      }));
    } catch (_) {}
    return ev;
  }

  // ── Step forward one event ────────────────────────────────────────
  function step() {
    if (_position < _dataset.length - 1) {
      _position++;
      _metrics.stepped++;
      return _emitCurrent();
    }
    return null;
  }

  // ── Step backward one event ───────────────────────────────────────
  function stepBack() {
    if (_position > 0) {
      _position--;
      _metrics.stepped++;
      return _emitCurrent();
    }
    return null;
  }

  // ── Play ──────────────────────────────────────────────────────────
  function play() {
    if (!_dataset.length || _playing) return;
    _playing = true;

    // Compute interval between events scaled by speed
    function _scheduleNext() {
      if (!_playing || _position >= _dataset.length - 1) {
        _playing = false;
        try { G.dispatchEvent(new CustomEvent('replay:complete', { detail: { count: _dataset.length } })); } catch (_) {}
        console.debug(LOG, 'replay complete —', _dataset.length, 'events');
        return;
      }
      var curr = _dataset[_position];
      var next = _dataset[_position + 1];
      var gap  = next ? Math.max(0, next.ts - curr.ts) : 100;
      var delay = Math.round(gap / _speed);
      delay = Math.max(10, Math.min(delay, 5000)); // clamp 10ms–5s

      _timer = setTimeout(function () {
        if (!_playing) return;
        _position++;
        _metrics.played++;
        _emitCurrent();
        _scheduleNext();
      }, delay);
    }

    _emitCurrent();
    _scheduleNext();
    console.debug(LOG, 'play — speed:', _speed + 'x | events:', _dataset.length, '| from index:', _position);
  }

  // ── Pause ─────────────────────────────────────────────────────────
  function pause() {
    _playing = false;
    clearTimeout(_timer);
    _timer = null;
    console.debug(LOG, 'paused at index:', _position, '/', _dataset.length - 1);
  }

  // ── Speed ─────────────────────────────────────────────────────────
  function setSpeed(s) {
    _speed = Math.max(0.25, Math.min(10, s || 1));
    console.debug(LOG, 'speed set to', _speed + 'x');
  }

  // ── Named sessions ────────────────────────────────────────────────
  function saveSession(label) {
    var id = 'replay_' + (++_sessionSeq);
    _sessions[id] = { id: id, label: label || id, dataset: _dataset.slice(), position: _position, created: Date.now() };
    return id;
  }

  function restoreSession(id) {
    var s = _sessions[id];
    if (!s) return false;
    _dataset  = s.dataset.slice();
    _position = s.position;
    _playing  = false;
    clearTimeout(_timer);
    return true;
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportReplay(opts) {
    _metrics.exports++;
    var data = { version: VERSION, ts: Date.now(), events: _dataset, position: _position };
    var json = JSON.stringify(data, null, 2);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      return { url: URL.createObjectURL(blob), count: _dataset.length, json: json };
    } catch (_) {
      return { url: null, count: _dataset.length, json: json };
    }
  }

  // ── Current state ─────────────────────────────────────────────────
  function getState() {
    return {
      loaded:   _dataset.length,
      position: _position,
      pct:      _dataset.length > 1 ? _position / (_dataset.length - 1) : 0,
      playing:  _playing,
      speed:    _speed,
      current:  _dataset[_position] || null,
    };
  }

  G.RuntimeReplayEngine = Object.freeze({
    VERSION:          VERSION,
    load:             load,
    loadFromTimeline: loadFromTimeline,
    seek:             seek,
    step:             step,
    stepBack:         stepBack,
    play:             play,
    pause:            pause,
    setSpeed:         setSpeed,
    saveSession:      saveSession,
    restoreSession:   restoreSession,
    export:           exportReplay,
    getState:         getState,
    getMetrics:       function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — replay engine initialized');

}(window));

