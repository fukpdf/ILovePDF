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
