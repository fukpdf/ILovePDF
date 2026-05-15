// RuntimeDevtoolsDashboard v1.0 — Phase 8B
// =====================================================================
// Live floating DevTools overlay. Zero-overhead idle mode (no timers
// when hidden). Draggable, collapsible, mobile-safe.
//
// Shows:
//   Health score, Memory tier, Active workers, Active tasks,
//   Stream throughput, Queue depth, Chunk size, Worker utilization,
//   IDB flush rate, AI task queue, Cross-tab cluster state
//
// Expose: window.RuntimeDashboard + RT.dashboard
//   .show()    — open the overlay
//   .hide()    — close the overlay
//   .toggle()  — toggle visibility
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeDashboard) return;

  var LOG = '[DB8B]';
  var UPDATE_INTERVAL_MS = 2000;

  // ── State ─────────────────────────────────────────────────────────────────
  var _visible  = false;
  var _timer    = null;
  var _el       = null;     // root overlay element
  var _body     = null;     // scrollable content container
  var _dragging = false;
  var _dragOX   = 0, _dragOY = 0;

  // ── CSS injection ─────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('rt-dashboard-styles')) return;
    var s = document.createElement('style');
    s.id  = 'rt-dashboard-styles';
    s.textContent = [
      '#rt-dash{',
        'position:fixed;top:12px;right:12px;z-index:2147483647;',
        'width:290px;max-height:90vh;',
        'background:#0f172a;color:#e2e8f0;',
        'border:1px solid #334155;border-radius:10px;',
        'font:12px/1.5 "JetBrains Mono","Fira Code",monospace;',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6);',
        'overflow:hidden;user-select:none;',
        'transform:translateZ(0);',
        'transition:opacity .2s,transform .2s;',
      '}',
      '#rt-dash.rt-hidden{opacity:0;pointer-events:none;transform:scale(.96) translateZ(0);}',
      '#rt-dash-header{',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:8px 10px;cursor:move;',
        'background:#1e293b;border-bottom:1px solid #334155;',
        'border-radius:10px 10px 0 0;',
      '}',
      '#rt-dash-title{font-size:11px;font-weight:700;color:#7dd3fc;letter-spacing:.05em;}',
      '#rt-dash-controls{display:flex;gap:6px;}',
      '.rt-dash-btn{',
        'width:14px;height:14px;border-radius:50%;border:none;cursor:pointer;',
        'display:flex;align-items:center;justify-content:center;font-size:8px;',
      '}',
      '.rt-dash-btn-min{background:#f59e0b;color:#78350f;}',
      '.rt-dash-btn-cls{background:#ef4444;color:#fff;}',
      '#rt-dash-body{',
        'padding:8px 10px;overflow-y:auto;max-height:calc(90vh - 48px);',
      '}',
      '#rt-dash.rt-collapsed #rt-dash-body{display:none;}',
      '.rt-section{margin-bottom:8px;}',
      '.rt-section-title{',
        'font-size:9px;text-transform:uppercase;letter-spacing:.1em;',
        'color:#64748b;margin-bottom:4px;border-bottom:1px solid #1e293b;padding-bottom:2px;',
      '}',
      '.rt-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;}',
      '.rt-label{color:#94a3b8;font-size:11px;}',
      '.rt-val{font-size:11px;font-weight:700;text-align:right;}',
      '.rt-val.ok{color:#4ade80;}',
      '.rt-val.warn{color:#fbbf24;}',
      '.rt-val.crit{color:#f87171;}',
      '.rt-val.info{color:#7dd3fc;}',
      '.rt-bar{',
        'height:3px;background:#1e293b;border-radius:2px;margin-bottom:4px;overflow:hidden;',
      '}',
      '.rt-bar-fill{height:100%;border-radius:2px;transition:width .5s;}',
      '.rt-bar-fill.ok{background:#4ade80;}',
      '.rt-bar-fill.warn{background:#fbbf24;}',
      '.rt-bar-fill.crit{background:#f87171;}',
      '.rt-score{font-size:22px;font-weight:900;text-align:center;padding:4px 0;}',
      '.rt-updated{font-size:9px;color:#475569;text-align:right;margin-top:4px;}',
      '@media(max-width:400px){#rt-dash{width:calc(100vw - 24px);right:12px;}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── DOM construction ──────────────────────────────────────────────────────
  function _buildDom() {
    if (_el) return;
    _injectStyles();

    _el = document.createElement('div');
    _el.id = 'rt-dash';
    _el.className = 'rt-hidden';

    _el.innerHTML = [
      '<div id="rt-dash-header">',
        '<span id="rt-dash-title">⚡ RT Dashboard</span>',
        '<div id="rt-dash-controls">',
          '<button class="rt-dash-btn rt-dash-btn-min" title="Collapse" id="rt-btn-min">−</button>',
          '<button class="rt-dash-btn rt-dash-btn-cls" title="Close" id="rt-btn-cls">✕</button>',
        '</div>',
      '</div>',
      '<div id="rt-dash-body">',
        '<div class="rt-section" id="rt-sec-health"></div>',
        '<div class="rt-section" id="rt-sec-memory"></div>',
        '<div class="rt-section" id="rt-sec-workers"></div>',
        '<div class="rt-section" id="rt-sec-tasks"></div>',
        '<div class="rt-section" id="rt-sec-stream"></div>',
        '<div class="rt-section" id="rt-sec-ai"></div>',
        '<div class="rt-section" id="rt-sec-idb"></div>',
        '<div class="rt-section" id="rt-sec-xtab"></div>',
        '<div class="rt-updated" id="rt-updated"></div>',
      '</div>',
    ].join('');

    document.body.appendChild(_el);
    _body = _el.querySelector('#rt-dash-body');

    // Controls
    _el.querySelector('#rt-btn-cls').addEventListener('click', function () { hide(); });
    _el.querySelector('#rt-btn-min').addEventListener('click', function () {
      _el.classList.toggle('rt-collapsed');
      this.textContent = _el.classList.contains('rt-collapsed') ? '+' : '−';
    });

    // Drag (mouse)
    var header = _el.querySelector('#rt-dash-header');
    header.addEventListener('mousedown', _startDrag);
    document.addEventListener('mousemove', _onDrag, { passive: true });
    document.addEventListener('mouseup', _stopDrag);

    // Drag (touch)
    header.addEventListener('touchstart', _startDragT, { passive: true });
    document.addEventListener('touchmove', _onDragT, { passive: true });
    document.addEventListener('touchend', _stopDrag);
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function _startDrag(e) {
    _dragging = true;
    var rect = _el.getBoundingClientRect();
    _dragOX = e.clientX - rect.left;
    _dragOY = e.clientY - rect.top;
    _el.style.right  = 'auto';
    _el.style.bottom = 'auto';
  }
  function _startDragT(e) {
    if (e.touches.length !== 1) return;
    _dragging = true;
    var rect = _el.getBoundingClientRect();
    _dragOX = e.touches[0].clientX - rect.left;
    _dragOY = e.touches[0].clientY - rect.top;
    _el.style.right  = 'auto';
    _el.style.bottom = 'auto';
  }
  function _onDrag(e) {
    if (!_dragging) return;
    var x = e.clientX - _dragOX;
    var y = e.clientY - _dragOY;
    _el.style.left = Math.max(0, Math.min(x, window.innerWidth  - _el.offsetWidth))  + 'px';
    _el.style.top  = Math.max(0, Math.min(y, window.innerHeight - _el.offsetHeight)) + 'px';
  }
  function _onDragT(e) {
    if (!_dragging || e.touches.length !== 1) return;
    var x = e.touches[0].clientX - _dragOX;
    var y = e.touches[0].clientY - _dragOY;
    _el.style.left = Math.max(0, Math.min(x, window.innerWidth  - _el.offsetWidth))  + 'px';
    _el.style.top  = Math.max(0, Math.min(y, window.innerHeight - _el.offsetHeight)) + 'px';
  }
  function _stopDrag() { _dragging = false; }

  // ── Data gathering ────────────────────────────────────────────────────────
  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }

  function _gather() {
    var d = {
      ts: Date.now(),

      // Health
      healthScore:    _safe(function () { return global.RuntimeHealth && global.RuntimeHealth.getScore ? global.RuntimeHealth.getScore() : 100; }, 100),

      // Memory
      memTier:        _safe(function () { return global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL'; }, 'NORMAL'),
      memUsedMB:      _safe(function () { return global.RuntimeMemory ? global.RuntimeMemory.memUsedMB() : 0; }, 0),
      memAvailMB:     _safe(function () { return global.RuntimeMemory ? global.RuntimeMemory.memAvailMB() : 9999; }, 9999),
      heapPct:        _safe(function () { var m = performance.memory; return m ? Math.round(m.usedJSHeapSize / m.jsHeapSizeLimit * 100) : 0; }, 0),

      // Workers
      activeWorkers:  _safe(function () { return global.RuntimeState ? (global.RuntimeState.get('activeWorkers') || 0) : 0; }, 0),
      maxWorkers:     _safe(function () { return global.RuntimeMemory ? global.RuntimeMemory.maxWorkers() : 4; }, 4),
      workerStats:    _safe(function () { return global.RuntimeWorkers && global.RuntimeWorkers.getStats ? global.RuntimeWorkers.getStats() : {}; }, {}),

      // Tasks
      activeTasks:    _safe(function () { return global.RuntimeState ? (global.RuntimeState.get('activeTasks') || 0) : 0; }, 0),
      queueDepth:     _safe(function () { return global.RuntimeState ? (global.RuntimeState.get('queueDepth') || 0) : 0; }, 0),

      // Adaptive pipeline
      chunkSzMB:      _safe(function () { return global.RuntimeAdaptivePipeline ? Math.round(global.RuntimeAdaptivePipeline.chunkSize() / 1024 / 1024 * 10) / 10 : 0; }, 0),
      throttle:       _safe(function () { return global.RuntimeAdaptivePipeline ? global.RuntimeAdaptivePipeline.shouldThrottle() : false; }, false),

      // Stream (from enterprise telemetry)
      streamSessions: _safe(function () { return global.RuntimeTelemetryEnterprise ? global.RuntimeTelemetryEnterprise.getStreamSessions().slice(-1)[0] : null; }, null),

      // AI
      aiStats:        _safe(function () { return global.RuntimeAIOrchestrator ? global.RuntimeAIOrchestrator.getStats() : {}; }, {}),
      aiUpgradeStats: _safe(function () { return global.RuntimeAIUpgrade ? global.RuntimeAIUpgrade.analytics() : null; }, null),

      // IDB coalescer
      idbStats:       _safe(function () { return global.RuntimeIDBCoalescer ? global.RuntimeIDBCoalescer.getStats() : {}; }, {}),

      // Cross-tab
      xtabStats:      _safe(function () { return global.RuntimeCrossTab && global.RuntimeCrossTab.getStats ? global.RuntimeCrossTab.getStats() : { available: false }; }, { available: false }),

      // Distributed scheduler
      distStats:      _safe(function () { return global.RuntimeDistributedScheduler ? global.RuntimeDistributedScheduler.getStats() : null; }, null),

      // Benchmark
      bmReport:       _safe(function () { return global.RuntimeBenchmark ? global.RuntimeBenchmark.report() : null; }, null),

      // Memory defense
      defenseStatus:  _safe(function () { return global.RuntimeMemoryDefense ? global.RuntimeMemoryDefense.getStatus() : null; }, null),
    };
    return d;
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function _cls(val, warn, crit) {
    if (val >= crit) return 'crit';
    if (val >= warn) return 'warn';
    return 'ok';
  }

  function _clsInv(val, warn, crit) {
    // Lower is better (health score)
    if (val <= crit) return 'crit';
    if (val <= warn) return 'warn';
    return 'ok';
  }

  function _tierCls(tier) {
    return tier === 'EMERGENCY' ? 'crit' : tier === 'CRITICAL' ? 'crit' : tier === 'WARNING' ? 'warn' : 'ok';
  }

  function _row(label, val, cls) {
    return '<div class="rt-row"><span class="rt-label">' + label + '</span>' +
           '<span class="rt-val ' + (cls || 'info') + '">' + val + '</span></div>';
  }

  function _bar(pct, cls) {
    pct = Math.max(0, Math.min(100, pct || 0));
    return '<div class="rt-bar"><div class="rt-bar-fill ' + (cls || 'ok') + '" style="width:' + pct + '%"></div></div>';
  }

  function _section(title, html) {
    return '<div class="rt-section-title">' + title + '</div>' + html;
  }

  // ── Full render ───────────────────────────────────────────────────────────
  function _render(d) {
    if (!_el || _el.classList.contains('rt-hidden')) return;

    // Health
    var hCls = _clsInv(d.healthScore, 70, 40);
    var secHealth = _section('HEALTH',
      '<div class="rt-score ' + hCls + '">' + d.healthScore + '</div>' +
      _bar(d.healthScore, hCls)
    );

    // Memory
    var mCls = _tierCls(d.memTier);
    var heapCls = _cls(d.heapPct, 65, 80);
    var secMem = _section('MEMORY',
      _row('Tier',   d.memTier,       mCls)   +
      _row('Used',   d.memUsedMB + ' MB', mCls) +
      _row('Heap%',  d.heapPct + '%',  heapCls) +
      _bar(d.heapPct, heapCls)
    );

    // Workers
    var wPct    = d.maxWorkers > 0 ? Math.round(d.activeWorkers / d.maxWorkers * 100) : 0;
    var wCls    = _cls(wPct, 70, 90);
    var cooldowns = (d.workerStats && d.workerStats.cooldowns) || 0;
    var secWork = _section('WORKERS',
      _row('Active / Max', d.activeWorkers + ' / ' + d.maxWorkers, wCls) +
      _row('Utilization',  wPct + '%', wCls) +
      _bar(wPct, wCls) +
      (cooldowns > 0 ? _row('Cooldowns', cooldowns, 'warn') : '')
    );

    // Tasks
    var tCls  = _cls(d.activeTasks, 3, 6);
    var qCls  = _cls(d.queueDepth,  4, 8);
    var secTask = _section('TASKS',
      _row('Active',       d.activeTasks, tCls) +
      _row('Queue',        d.queueDepth,  qCls) +
      _row('Chunk',        d.chunkSzMB + ' MB', 'info') +
      (d.throttle ? _row('Throttle', 'ACTIVE', 'warn') : '')
    );

    // Stream
    var ss = d.streamSessions;
    var secStream = _section('STREAM',
      ss ? (
        _row('Throughput', ss.throughputMbps + ' MB/s', 'info') +
        _row('Chunks', ss.chunks || 0, 'info') +
        _row('p50 ACK', (ss.p50Ack || 0) + ' ms', 'info')
      ) : _row('Status', 'idle', 'ok')
    );

    // AI
    var ai = d.aiStats || {};
    var aiUp = d.aiUpgradeStats;
    var topProvider = aiUp && aiUp.providers && aiUp.providers[0];
    var secAi = _section('AI ORCHESTRATION',
      _row('Active',   ai.activeTasks  || 0, (ai.activeTasks || 0) > 0 ? 'warn' : 'ok') +
      _row('Queued',   ai.queuedTasks  || 0, (ai.queuedTasks || 0) > 0 ? 'warn' : 'ok') +
      (topProvider ? _row('Provider', topProvider.name.replace('Engine','').replace('Runtime',''), 'info') : '') +
      (aiUp ? _row('Online', navigator.onLine ? 'yes' : 'offline', navigator.onLine ? 'ok' : 'warn') : '')
    );

    // IDB
    var idb = d.idbStats || {};
    var secIdb = _section('IDB COALESCER',
      _row('Pending', idb.pending || 0, (idb.pending || 0) > 20 ? 'warn' : 'ok') +
      _row('Flushed', idb.flushed || 0, 'info') +
      _row('Collapsed', idb.collapsed || 0, 'info')
    );

    // Cross-tab
    var xt = d.xtabStats || {};
    var ds = d.distStats;
    var secXtab = _section('CLUSTER',
      _row('Tabs',    (xt.peerCount || 0) + 1 + ' (this+peers)', 'info') +
      _row('Workers', xt.clusterWorkers || 0, 'info') +
      (ds ? _row('Leases', ds.localLeases + '/' + ds.maxLocal, ds.localLeases >= ds.maxLocal ? 'warn' : 'ok') : '')
    );

    // Set sections
    document.getElementById('rt-sec-health').innerHTML  = secHealth;
    document.getElementById('rt-sec-memory').innerHTML  = secMem;
    document.getElementById('rt-sec-workers').innerHTML = secWork;
    document.getElementById('rt-sec-tasks').innerHTML   = secTask;
    document.getElementById('rt-sec-stream').innerHTML  = secStream;
    document.getElementById('rt-sec-ai').innerHTML      = secAi;
    document.getElementById('rt-sec-idb').innerHTML     = secIdb;
    document.getElementById('rt-sec-xtab').innerHTML    = secXtab;
    document.getElementById('rt-updated').textContent   = 'Updated ' + new Date().toLocaleTimeString();
  }

  // ── Update loop ───────────────────────────────────────────────────────────
  function _tick() {
    if (!_visible) return;
    try { _render(_gather()); } catch (_) {}
  }

  function _startTick() {
    if (_timer) return;
    _tick(); // immediate render
    _timer = setInterval(_tick, UPDATE_INTERVAL_MS);
  }

  function _stopTick() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // ── Show / hide ───────────────────────────────────────────────────────────
  function show() {
    _buildDom();
    _visible = true;
    _el.classList.remove('rt-hidden');
    _startTick();
    console.info(LOG, 'Dashboard visible');
  }

  function hide() {
    _visible = false;
    if (_el) _el.classList.add('rt-hidden');
    _stopTick();
  }

  function toggle() {
    _visible ? hide() : show();
  }

  // ── Keyboard shortcut: Alt+Shift+D ────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggle();
    }
  });

  // ── Wire into RT ──────────────────────────────────────────────────────────
  function _wireCentralRuntime() {
    var RT = global.CentralRuntime || global.RT;
    if (!RT) return;
    if (RT.register) {
      try { RT.register('dashboard', global.RuntimeDashboard); } catch (_) {}
    }
    RT.dashboard = global.RuntimeDashboard;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_wireCentralRuntime, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_wireCentralRuntime, 300); }, { once: true });
  }

  global.RuntimeDashboard = { show: show, hide: hide, toggle: toggle };

  console.info(LOG, 'RuntimeDashboard v1.0 ready — press Alt+Shift+D or call RT.dashboard.show()');
}(window));
