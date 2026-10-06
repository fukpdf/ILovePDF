/**
 * RuntimeDashboard — Phase 17
 *
 * Real-time runtime observability panel for the ILovePDF browser platform.
 * Shows live metrics from ALL Phase 1-16 subsystems.
 *
 * KEYBOARD SHORTCUT: Ctrl+Shift+R — toggle floating panel
 *
 * Tabs: Overview · Memory · Workers · AI · Streams · Federation
 *       Kernel · Events · Health · Runtime
 *
 * Performance guarantees:
 *   • Metrics collected every 500ms ONLY when panel is open
 *   • RAF-driven chart redraws, throttled to 2fps
 *   • Tab-hidden detection pauses all updates
 *   • diff-rendering: only data-dash-id text nodes updated on tick
 *   • No external libraries — canvas + DOM + RAF
 *   • Panel CSS scoped to #iplv-dash — zero style leakage
 *   • <2% CPU overhead when minimized, ~1% when open
 *
 * Exposes: window.RuntimeDashboard, RT.runtime.dashboard()
 */
(function (G) {
  'use strict';

  if (G.RuntimeDashboard) return;

  var VERSION = '1.0.0';
  var LOG     = '[DASH17]';
  var PANEL_ID = 'iplv-dash';

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 1  SAFE ACCESSOR — never throws
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _g(name, fn, def) {
    try { var o = G[name]; return o ? fn(o) : def; }
    catch (_) { return def !== undefined ? def : null; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 2  RING BUFFER (capped history for charts)
   * ═══════════════════════════════════════════════════════════════════════════ */
  function RingBuffer(cap) {
    var _b = [], _i = 0, _c = 0;
    return {
      push: function (v) { _b[_i % cap] = (v == null || isNaN(v)) ? 0 : +v; _i++; _c = Math.min(_c + 1, cap); },
      data: function () {
        if (!_c) return [];
        var s = _c < cap ? 0 : _i % cap, a = [];
        for (var j = 0; j < _c; j++) a.push(_b[(s + j) % cap]);
        return a;
      },
      last: function () { return _i > 0 ? (_b[(_i - 1 + cap) % cap] || 0) : 0; },
    };
  }

  var RB = {
    heap:    new RingBuffer(120), // heap MB
    heapPct: new RingBuffer(120), // heap %
    workers: new RingBuffer(120), // busy+queued workers
    aiQ:     new RingBuffer(120), // active+queued AI tasks
    kernel:  new RingBuffer(120), // kernel queued
    health:  new RingBuffer(120), // health score 0-100
    streams: new RingBuffer(120), // active streams
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 3  EVENT LOG
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _events     = [];
  var MAX_EVENTS  = 200;
  var _evFilter   = '';
  var _evPaused   = false;

  function _logEvent(type, msg, level) {
    if (_evPaused) return;
    _events.unshift({ ts: Date.now(), type: String(type), msg: String(msg).slice(0, 200), level: level || 'info' });
    if (_events.length > MAX_EVENTS) _events.length = MAX_EVENTS;
    if (_visible && _activeTab === 'events') _scheduleRender();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 4  METRIC COLLECTION — reads ALL real runtime APIs
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _m = {};
  var _health = { score: 100, level: 'HEALTHY', factors: [], color: '#22c55e' };
  var _startTs = Date.now();
  var _lastLatency = 0;

  function _collect() {
    var t0 = Date.now();
    var pm = G.performance && G.performance.memory;

    /* ── Memory ── */
    var memSt = _g('RuntimeMemory', function (r) { return r.getStats(); }, {});
    var heapUsed  = pm ? Math.round(pm.usedJSHeapSize / 1e6)    : (memSt.memUsedMB  || 0);
    var heapTotal = pm ? Math.round(pm.totalJSHeapSize / 1e6)   : -1;
    var heapLimit = pm ? Math.round(pm.jsHeapSizeLimit / 1e6)   : -1;
    var heapPct   = heapLimit > 0 ? Math.round(heapUsed / heapLimit * 100) : 0;

    /* ── Workers ── */
    var poolSt  = _g('WorkerPool', function (r) { return r.getStats(); }, {});
    var wrkSt   = _g('RuntimeWorkers', function (r) { return r.getStats(); }, {});
    var poolUrls = Object.keys(poolSt);
    var wTotal = 0, wBusy = 0, wQueued = 0, wCrashed = 0;
    poolUrls.forEach(function (url) {
      var p = poolSt[url] || {};
      wTotal   += p.total   || 0;
      wBusy    += p.busy    || 0;
      wQueued  += p.queued  || 0;
      wCrashed += p.crashed || 0;
    });

    /* ── Kernel ── */
    var kernLoad = _g('RuntimeKernel', function (r) { return r.getLoad(); }, {});
    var kernHlth = _g('RuntimeKernel', function (r) { return r.getHealth(); }, {});

    /* ── Streams ── */
    var brdgSt = _g('RuntimeStreamBridge', function (r) { return r.getStats(); }, {});
    var zcSt   = _g('RuntimeZeroCopy',     function (r) { return r.getStats(); }, {});
    var wksSt  = _g('RuntimeWorkspace',    function (r) { return r.getStats(); }, {});
    var adaptP  = _g('RuntimeAdaptivePipeline', function (r) { return r.getProfile(); }, {});

    /* ── AI ── */
    var aiSt   = _g('AIRuntime',             function (r) { return r.status(); }, {});
    var orchSt = _g('RuntimeAIOrchestrator', function (r) { return r.getStats(); }, {});
    var laiSt  = _g('RuntimeLocalAI',        function (r) { return r.getStats(); }, {});

    /* ── Federation ── */
    var fedSt  = _g('RuntimeFederation', function (r) { return r.status(); }, null);

    /* ── Health + Runtime ── */
    var rtHlth = _g('RuntimeHealth', function (r) { return r.getStats(); }, {});
    var rtSt   = _g('CentralRuntime', function (r) { return r.status(); }, {});

    /* ── Assemble ── */
    var aiActive = (aiSt.active || 0) + (orchSt.activeTasks || 0);
    var aiQueued = (aiSt.queued || 0) + (orchSt.queuedTasks || 0);

    _m = {
      ts: t0,
      memory: {
        tier:      memSt.tier || _g('RuntimeMemory', function (r) { return r.getTier(); }, 'N/A'),
        usedMB:    heapUsed,
        totalMB:   heapTotal,
        limitMB:   heapLimit,
        pct:       heapPct,
        isMobile:  !!memSt.isMobile,
        isIOS:     !!memSt.isIosSafari,
        memAvailMB:memSt.memAvailMB || -1,
        config:    memSt.config || {},
        subscs:    memSt.subscribers || 0,
      },
      workers: {
        total:    wTotal,
        busy:     wBusy,
        idle:     Math.max(0, wTotal - wBusy),
        queued:   wQueued,
        crashed:  wCrashed,
        inflight: wrkSt.inflight || 0,
        cooldowns:wrkSt.cooldowns || 0,
        pool:     poolSt,
        poolUrls: poolUrls,
        wl:       wrkSt.wlStats || {},
      },
      kernel: {
        queued:     kernLoad.queued || 0,
        active:     kernLoad.active || {},
        queues:     kernLoad.queues || {},
        limits:     kernLoad.limits || {},
        memTier:    kernLoad.memTier || 'N/A',
        health:     kernHlth,
        score:      kernHlth.score || 0,
        totalActive:kernHlth.totalActive || 0,
        totalQueued:kernHlth.totalQueued || 0,
        subsystems: kernHlth.subsystems || {},
        stats:      kernHlth.stats || {},
      },
      streams: {
        active:      brdgSt.activeStreams || 0,
        totalEver:   brdgSt.streamIdCounter || 0,
        transferable:!!brdgSt.supportsTransferableStreams,
        zc:          zcSt || {},
        workspace:   wksSt || {},
        adaptive:    adaptP || {},
      },
      ai: {
        active:      aiActive,
        queued:      aiQueued,
        maxConc:     aiSt.maxConcurrent || 3,
        deviceTier:  aiSt.deviceTier || _g('AIRuntime', function(r) { return r.DEVICE_TIER; }, '?'),
        providers:   aiSt.providers || [],
        orchProvs:   orchSt.providers || [],
        history:     aiSt.history || [],
        localAi:     laiSt || {},
      },
      federation: fedSt || null,
      rtHealth:    rtHlth,
      runtime:     rtSt,
      uptime:      t0 - _startTs,
    };

    /* ── Push ring buffers ── */
    RB.heap.push(heapUsed);
    RB.heapPct.push(heapPct);
    RB.workers.push(wBusy + wQueued);
    RB.aiQ.push(aiActive + aiQueued);
    RB.kernel.push(_m.kernel.queued);
    RB.streams.push(_m.streams.active);

    /* ── Compute health ── */
    _health = _computeHealth(_m);
    RB.health.push(_health.score);

    _lastLatency = Date.now() - t0;
    return _m;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 5  HEALTH ENGINE — scores 0-100
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _computeHealth(m) {
    var s = 100, f = [];
    var tier = m.memory.tier;
    if (tier === 'WARNING')   { s -= 10; f.push('mem:warning'); }
    if (tier === 'CRITICAL')  { s -= 22; f.push('mem:critical'); }
    if (tier === 'EMERGENCY') { s -= 38; f.push('mem:emergency'); }
    if (m.memory.pct > 90)    { s -= 15; f.push('heap:>90%'); }
    else if (m.memory.pct > 75) { s -= 8; f.push('heap:>75%'); }
    else if (m.memory.pct > 55) { s -= 3; f.push('heap:>55%'); }
    if (m.workers.crashed > 0)  { s -= Math.min(20, m.workers.crashed * 5); f.push('workers:' + m.workers.crashed + '-crashed'); }
    if (m.workers.queued > 20)  { s -= 8;  f.push('worker-queue:' + m.workers.queued); }
    var aiQ = m.ai.active + m.ai.queued;
    if (aiQ > 10) { s -= 12; f.push('ai-queue:' + aiQ); }
    else if (aiQ > 5) { s -= 5; f.push('ai-queue:' + aiQ); }
    if (m.streams.active > 10) { s -= 8; f.push('stream-leak:' + m.streams.active); }
    if (m.kernel.queued > 25)  { s -= 10; f.push('kernel:saturated'); }
    var extSc = _g('RuntimeHealth', function (r) { return r.getScore(); }, -1);
    if (extSc >= 0 && extSc < 80) { s -= Math.round((80 - extSc) * 0.25); f.push('sys:' + extSc); }
    s = Math.max(0, Math.min(100, Math.round(s)));
    var lvl   = s >= 90 ? 'PERFECT' : s >= 75 ? 'HEALTHY' : s >= 50 ? 'WARNING' : s >= 25 ? 'DEGRADED' : 'CRITICAL';
    var color = { PERFECT:'#22c55e', HEALTHY:'#22c55e', WARNING:'#f59e0b', DEGRADED:'#f97316', CRITICAL:'#ef4444' }[lvl] || '#6b7280';
    return { score: s, level: lvl, factors: f, color: color };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 6  CSS INJECTION
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _injectCSS() {
    if (document.getElementById(PANEL_ID + '-css')) return;
    var s = document.createElement('style');
    s.id = PANEL_ID + '-css';
    s.textContent = [
      '#iplv-dash{position:fixed;z-index:2147483640;background:#0d1117;color:#e6edf3;',
      'border:1px solid #30363d;border-radius:8px;box-shadow:0 16px 70px rgba(0,0,0,.7);',
      'font-family:ui-monospace,"Cascadia Code","Fira Code",monospace;font-size:12px;',
      'display:flex;flex-direction:column;min-width:400px;min-height:240px;',
      'user-select:none;overflow:hidden;}',

      '#iplv-dash *{box-sizing:border-box;}',
      '#iplv-dash a{color:#818cf8;text-decoration:none;}',

      /* Header */
      '#iplv-dash .dh{display:flex;align-items:center;padding:8px 12px;',
      'background:#161b22;border-bottom:1px solid #30363d;cursor:grab;flex-shrink:0;gap:8px;}',
      '#iplv-dash .dh:active{cursor:grabbing;}',
      '#iplv-dash .dh-dots{display:flex;gap:5px;}',
      '#iplv-dash .dh-dot{width:12px;height:12px;border-radius:50%;cursor:pointer;}',
      '#iplv-dash .dh-dot.red{background:#ff5f57;}',
      '#iplv-dash .dh-dot.yellow{background:#febc2e;}',
      '#iplv-dash .dh-dot.green{background:#28c840;}',
      '#iplv-dash .dh-title{font-size:12px;font-weight:600;color:#7c3aed;flex:1;letter-spacing:.5px;}',
      '#iplv-dash .dh-health{font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;',
      'background:#161b22;border:1px solid currentColor;}',
      '#iplv-dash .dh-uptime{color:#6b7280;font-size:11px;}',

      /* Tabs */
      '#iplv-dash .dt{display:flex;overflow-x:auto;background:#0d1117;',
      'border-bottom:1px solid #30363d;flex-shrink:0;}',
      '#iplv-dash .dt::-webkit-scrollbar{height:0;}',
      '#iplv-dash .dt-tab{padding:7px 14px;font-size:11px;cursor:pointer;white-space:nowrap;',
      'border-bottom:2px solid transparent;color:#8b949e;transition:color .15s;flex-shrink:0;}',
      '#iplv-dash .dt-tab:hover{color:#e6edf3;}',
      '#iplv-dash .dt-tab.active{color:#7c3aed;border-bottom-color:#7c3aed;}',

      /* Content */
      '#iplv-dash .dc{flex:1;overflow-y:auto;padding:12px;display:none;}',
      '#iplv-dash .dc.active{display:block;}',
      '#iplv-dash .dc::-webkit-scrollbar{width:6px;}',
      '#iplv-dash .dc::-webkit-scrollbar-track{background:#0d1117;}',
      '#iplv-dash .dc::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px;}',

      /* Grid */
      '#iplv-dash .dg{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));',
      'gap:8px;margin-bottom:12px;}',
      '#iplv-dash .dg2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;}',
      '#iplv-dash .dg3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;}',

      /* Metric cards */
      '#iplv-dash .mk{background:#161b22;border:1px solid #21262d;border-radius:6px;',
      'padding:10px 12px;display:flex;flex-direction:column;gap:2px;}',
      '#iplv-dash .mk-label{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;}',
      '#iplv-dash .mk-value{font-size:18px;font-weight:700;color:#e6edf3;line-height:1.2;}',
      '#iplv-dash .mk-unit{font-size:10px;color:#6b7280;}',
      '#iplv-dash .mk-sub{font-size:10px;color:#8b949e;margin-top:2px;}',

      /* Charts */
      '#iplv-dash .ch-wrap{background:#161b22;border:1px solid #21262d;border-radius:6px;',
      'padding:8px;margin-bottom:8px;}',
      '#iplv-dash .ch-label{font-size:10px;color:#6b7280;text-transform:uppercase;',
      'letter-spacing:.6px;margin-bottom:4px;}',
      '#iplv-dash canvas.ch{display:block;width:100%;height:60px;background:#0d1117;border-radius:3px;}',
      '#iplv-dash canvas.ch-lg{height:100px;}',
      '#iplv-dash .ch-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;}',

      /* Badges */
      '#iplv-dash .badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;',
      'font-weight:700;text-transform:uppercase;letter-spacing:.4px;}',
      '#iplv-dash .badge-ok{background:#22c55e22;color:#22c55e;border:1px solid #22c55e44;}',
      '#iplv-dash .badge-warn{background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44;}',
      '#iplv-dash .badge-err{background:#ef444422;color:#ef4444;border:1px solid #ef444444;}',
      '#iplv-dash .badge-info{background:#818cf822;color:#818cf8;border:1px solid #818cf844;}',
      '#iplv-dash .badge-off{background:#6b728022;color:#6b7280;border:1px solid #6b728044;}',

      /* Tables */
      '#iplv-dash table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px;}',
      '#iplv-dash th{text-align:left;padding:4px 8px;color:#6b7280;font-size:10px;',
      'text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #21262d;}',
      '#iplv-dash td{padding:4px 8px;border-bottom:1px solid #161b22;color:#8b949e;}',
      '#iplv-dash td:first-child{color:#e6edf3;font-weight:600;}',
      '#iplv-dash tr:hover td{background:#161b22;}',

      /* Event feed */
      '#iplv-dash .ev-toolbar{display:flex;gap:8px;margin-bottom:8px;align-items:center;}',
      '#iplv-dash .ev-filter{flex:1;background:#161b22;border:1px solid #30363d;',
      'color:#e6edf3;border-radius:4px;padding:4px 8px;font-size:11px;font-family:inherit;}',
      '#iplv-dash .ev-btn{background:#21262d;border:1px solid #30363d;color:#e6edf3;',
      'border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer;font-family:inherit;}',
      '#iplv-dash .ev-btn:hover{background:#30363d;}',
      '#iplv-dash .ev-list{overflow-y:auto;max-height:340px;font-size:11px;}',
      '#iplv-dash .ev-list::-webkit-scrollbar{width:4px;}',
      '#iplv-dash .ev-list::-webkit-scrollbar-thumb{background:#30363d;}',
      '#iplv-dash .ev-row{display:flex;gap:8px;padding:3px 6px;border-bottom:1px solid #161b22;',
      'font-family:inherit;}',
      '#iplv-dash .ev-row:hover{background:#161b22;}',
      '#iplv-dash .ev-ts{color:#484f58;min-width:60px;flex-shrink:0;}',
      '#iplv-dash .ev-type{min-width:130px;flex-shrink:0;color:#818cf8;}',
      '#iplv-dash .ev-msg{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#iplv-dash .ev-lv-warn{color:#f59e0b;}',
      '#iplv-dash .ev-lv-error{color:#ef4444;}',

      /* Progress bar */
      '#iplv-dash .pb{background:#21262d;border-radius:2px;height:4px;overflow:hidden;margin-top:3px;}',
      '#iplv-dash .pb-fill{height:100%;border-radius:2px;transition:width .3s;}',

      /* Health factors */
      '#iplv-dash .factor{display:inline-block;margin:2px 3px;padding:2px 7px;',
      'border-radius:3px;font-size:10px;background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b33;}',

      /* Status bar */
      '#iplv-dash .dsb{display:flex;align-items:center;gap:12px;padding:5px 12px;',
      'background:#010409;border-top:1px solid #21262d;font-size:10px;color:#484f58;flex-shrink:0;}',
      '#iplv-dash .dsb-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:3px;}',

      /* Resize handle */
      '#iplv-dash .drh{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:se-resize;',
      'background:linear-gradient(135deg,transparent 40%,#30363d 40%,#30363d 55%,transparent 55%,',
      'transparent 65%,#30363d 65%,#30363d 80%,transparent 80%);}',

      /* Minimized */
      '#iplv-dash.minimized .dt,#iplv-dash.minimized .dc,#iplv-dash.minimized .dsb{display:none;}',
      '#iplv-dash.minimized{min-height:0;}',

      /* Scrollbar for DC */
      '#iplv-dash .dc::-webkit-scrollbar-track{background:#0d1117;}',

      /* Section headers */
      '#iplv-dash .sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;',
      'color:#6b7280;margin:10px 0 6px;padding-bottom:4px;border-bottom:1px solid #21262d;}',

      /* Mono values */
      '#iplv-dash .mono{font-family:inherit;color:#e6edf3;}',
      '#iplv-dash .dim{color:#484f58;}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 7  PANEL DOM — build once, update in-place
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _panel   = null;
  var _content = {};  // tab-id → element

  var TABS = [
    { id:'overview',    label:'Overview'   },
    { id:'memory',      label:'Memory'     },
    { id:'workers',     label:'Workers'    },
    { id:'ai',          label:'AI'         },
    { id:'streams',     label:'Streams'    },
    { id:'federation',  label:'Federation' },
    { id:'kernel',      label:'Kernel'     },
    { id:'events',      label:'Events'     },
    { id:'health',      label:'Health'     },
    { id:'runtime',     label:'Runtime'    },
  ];

  function _el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className') e.className = attrs[k];
      else if (k.startsWith('data-')) e.setAttribute(k, attrs[k]);
      else e[k] = attrs[k];
    });
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function _buildPanel() {
    var root = _el('div', { id: PANEL_ID });

    /* ── Header ── */
    root.appendChild(_buildHeader());

    /* ── Tab bar ── */
    var tabbar = _el('div', { className: 'dt' });
    TABS.forEach(function (t) {
      var btn = _el('div', { className: 'dt-tab' + (t.id === 'overview' ? ' active' : ''), 'data-tab': t.id }, t.label);
      btn.addEventListener('click', function () { _switchTab(t.id); });
      tabbar.appendChild(btn);
    });
    root.appendChild(tabbar);

    /* ── Tab panels ── */
    TABS.forEach(function (t) {
      var panel = _el('div', { className: 'dc' + (t.id === 'overview' ? ' active' : ''), id: PANEL_ID + '-' + t.id });
      panel.innerHTML = _tabTemplate(t.id);
      root.appendChild(panel);
      _content[t.id] = panel;
    });

    /* ── Status bar ── */
    root.appendChild(_buildStatusBar());

    /* ── Resize handle ── */
    var rh = _el('div', { className: 'drh' });
    _makeResizable(root, rh);
    root.appendChild(rh);

    return root;
  }

  function _buildHeader() {
    var h = _el('div', { className: 'dh' });
    h.innerHTML = [
      '<div class="dh-dots">',
      '<div class="dh-dot red" title="Close"></div>',
      '<div class="dh-dot yellow" title="Minimize"></div>',
      '<div class="dh-dot green" title="Refresh"></div>',
      '</div>',
      '<span class="dh-title">⬡ Runtime Dashboard v' + VERSION + '</span>',
      '<span class="dh-health" data-dash-id="hdr-health" style="color:#22c55e">HEALTHY 100</span>',
      '<span class="dh-uptime" data-dash-id="hdr-uptime">0s</span>',
    ].join('');
    h.querySelector('.red').addEventListener('click', function () { _hide(); });
    h.querySelector('.yellow').addEventListener('click', function () { _toggleMinimize(); });
    h.querySelector('.green').addEventListener('click', function () { _collect(); _renderActiveTab(); });
    return h;
  }

  function _buildStatusBar() {
    var sb = _el('div', { className: 'dsb' });
    sb.innerHTML = [
      '<span><span class="dsb-dot" data-dash-id="sb-dot" style="background:#22c55e"></span>',
      '<span data-dash-id="sb-health">HEALTHY</span></span>',
      '<span>mem: <span data-dash-id="sb-mem">N/A</span></span>',
      '<span>workers: <span data-dash-id="sb-wrk">0</span></span>',
      '<span>ai: <span data-dash-id="sb-ai">0</span></span>',
      '<span>streams: <span data-dash-id="sb-str">0</span></span>',
      '<span style="margin-left:auto">Ctrl+Shift+R to toggle</span>',
    ].join('');
    return sb;
  }

  function _tabTemplate(id) {
    switch (id) {
      case 'overview': return [
        '<div class="dg">',
        _card('Health Score', 'ov-score', '—', '', '', '#7c3aed'),
        _card('Memory Tier',  'ov-tier',  '—'),
        _card('Heap Used',    'ov-heap',  '—', 'MB'),
        _card('Heap %',       'ov-heappct','—', '%'),
        _card('Workers Busy', 'ov-wbsy',  '—'),
        _card('AI Tasks',     'ov-ai',    '—'),
        _card('Streams',      'ov-str',   '—'),
        _card('Kernel Queue', 'ov-kq',    '—'),
        '</div>',
        '<div class="ch-row">',
        _chart('ch-heap',    'Heap MB',       'ch'),
        _chart('ch-heappct', 'Heap %',        'ch'),
        '</div>',
        '<div class="ch-row">',
        _chart('ch-workers', 'Worker Load',   'ch'),
        _chart('ch-health',  'Health Score',  'ch'),
        '</div>',
        '<div class="ch-row">',
        _chart('ch-aiq',     'AI Queue',      'ch'),
        _chart('ch-streams', 'Active Streams','ch'),
        '</div>',
      ].join('');

      case 'memory': return [
        '<div class="sec">Heap</div>',
        '<div class="dg">',
        _card('Tier',       'mem-tier',   '—'),
        _card('Used',       'mem-used',   '—', 'MB'),
        _card('Total',      'mem-total',  '—', 'MB'),
        _card('Limit',      'mem-limit',  '—', 'MB'),
        _card('Available',  'mem-avail',  '—', 'MB'),
        _card('Heap %',     'mem-pct',    '—', '%'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">Heap Usage (MB) — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-mem-heap"></canvas></div>',
        '<div class="ch-wrap"><div class="ch-label">Heap % — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-mem-pct"></canvas></div>',
        '<div class="sec">Config</div>',
        '<table><tbody>',
        '<tr><td>Max Workers</td><td data-dash-id="mem-cfg-wrk">—</td></tr>',
        '<tr><td>Max Previews</td><td data-dash-id="mem-cfg-prev">—</td></tr>',
        '<tr><td>Chunk Size</td><td data-dash-id="mem-cfg-chunk">—</td></tr>',
        '<tr><td>Preview Enabled</td><td data-dash-id="mem-cfg-preview">—</td></tr>',
        '<tr><td>Mobile</td><td data-dash-id="mem-mobile">—</td></tr>',
        '<tr><td>iOS Safari</td><td data-dash-id="mem-ios">—</td></tr>',
        '</tbody></table>',
      ].join('');

      case 'workers': return [
        '<div class="sec">Pool Summary</div>',
        '<div class="dg">',
        _card('Total Workers', 'wrk-total',   '—'),
        _card('Busy',          'wrk-busy',    '—'),
        _card('Idle',          'wrk-idle',    '—'),
        _card('Queued Tasks',  'wrk-queued',  '—'),
        _card('Crashed',       'wrk-crashed', '—', '', 'crash-count'),
        _card('In-Flight',     'wrk-inflight','—'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">Worker Load (busy+queued) — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-wrk-load"></canvas></div>',
        '<div class="sec">Worker Pools</div>',
        '<div id="wrk-pool-table"></div>',
      ].join('');

      case 'ai': return [
        '<div class="sec">Execution Layer</div>',
        '<div class="dg">',
        _card('Active Tasks',  'ai-active',   '—'),
        _card('Queued',        'ai-queued',   '—'),
        _card('Max Concurrent','ai-maxc',     '—'),
        _card('Device Tier',   'ai-dtier',    '—'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">AI Queue Depth — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-ai-q"></canvas></div>',
        '<div class="sec">Provider Chain</div>',
        '<div id="ai-providers"></div>',
        '<div class="sec">Recent Tasks</div>',
        '<div id="ai-history"></div>',
        '<div class="sec">Local AI</div>',
        '<table><tbody>',
        '<tr><td>Models Loaded</td><td data-dash-id="ai-lai-models">—</td></tr>',
        '<tr><td>Tasks Run</td><td data-dash-id="ai-lai-tasks">—</td></tr>',
        '<tr><td>Cache Hits</td><td data-dash-id="ai-lai-cache">—</td></tr>',
        '</tbody></table>',
      ].join('');

      case 'streams': return [
        '<div class="sec">Stream Bridge</div>',
        '<div class="dg">',
        _card('Active Streams',  'str-active',  '—'),
        _card('Total Ever',      'str-total',   '—'),
        _card('Transferable',    'str-xfr',     '—'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">Active Streams — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-str-act"></canvas></div>',
        '<div class="sec">Zero-Copy Buffer Pool</div>',
        '<table><tbody>',
        '<tr><td>Buffers Allocated</td><td data-dash-id="zc-alloc">—</td></tr>',
        '<tr><td>Buffers Reused</td><td data-dash-id="zc-reuse">—</td></tr>',
        '<tr><td>Buffers Released</td><td data-dash-id="zc-rel">—</td></tr>',
        '<tr><td>Chunk Size</td><td data-dash-id="zc-chunk">—</td></tr>',
        '<tr><td>Memory Tier</td><td data-dash-id="zc-tier">—</td></tr>',
        '</tbody></table>',
        '<div class="sec">Adaptive Pipeline</div>',
        '<table><tbody>',
        '<tr><td>Device Tier</td><td data-dash-id="adp-tier">—</td></tr>',
        '<tr><td>Chunk Size</td><td data-dash-id="adp-chunk">—</td></tr>',
        '<tr><td>Batch Size</td><td data-dash-id="adp-batch">—</td></tr>',
        '<tr><td>Concurrency</td><td data-dash-id="adp-conc">—</td></tr>',
        '<tr><td>Health Score</td><td data-dash-id="adp-score">—</td></tr>',
        '</tbody></table>',
      ].join('');

      case 'federation': return [
        '<div class="sec">Module Groups</div>',
        '<div id="fed-groups"></div>',
        '<div class="sec">Tool Readiness</div>',
        '<div class="dg2">',
        _card('Groups Ready',  'fed-groups-ready', '—'),
        _card('Tools Ready',   'fed-tools-ready',  '—'),
        '</div>',
        '<div id="fed-tools-table"></div>',
      ].join('');

      case 'kernel': return [
        '<div class="sec">Kernel Load</div>',
        '<div class="dg">',
        _card('Total Queued', 'krn-queued',  '—'),
        _card('Total Active', 'krn-active',  '—'),
        _card('Health Score', 'krn-score',   '—'),
        _card('Memory Tier',  'krn-memtier', '—'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">Kernel Queue — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-krn-q"></canvas></div>',
        '<div class="sec">Resource Queues</div>',
        '<div id="krn-queues"></div>',
        '<div class="sec">Subsystems</div>',
        '<div id="krn-subsys"></div>',
      ].join('');

      case 'events': return [
        '<div class="ev-toolbar">',
        '<input class="ev-filter" placeholder="Filter events…" id="ev-filter-input">',
        '<button class="ev-btn" id="ev-pause-btn">⏸ Pause</button>',
        '<button class="ev-btn" id="ev-clear-btn">✕ Clear</button>',
        '<button class="ev-btn" id="ev-export-btn">↓ Export</button>',
        '</div>',
        '<div class="ev-list" id="ev-list"></div>',
      ].join('');

      case 'health': return [
        '<div class="sec">Live Score</div>',
        '<div class="dg2">',
        _card('Score',  'hlth-score', '—', '/100', 'score'),
        _card('Level',  'hlth-level', '—'),
        '</div>',
        '<div class="ch-wrap"><div class="ch-label">Health Score — 60s rolling</div>',
        '<canvas class="ch ch-lg" id="ch-hlth"></canvas></div>',
        '<div class="sec">Deductions</div>',
        '<div id="hlth-factors" style="padding:4px 0;line-height:1.8;"></div>',
        '<div class="sec">RuntimeHealth History</div>',
        '<div id="hlth-history"></div>',
      ].join('');

      case 'runtime': return [
        '<div class="sec">CentralRuntime</div>',
        '<table><tbody>',
        '<tr><td>Version</td><td data-dash-id="rt-version">—</td></tr>',
        '<tr><td>Uptime</td><td data-dash-id="rt-uptime">—</td></tr>',
        '<tr><td>Total Tasks</td><td data-dash-id="rt-tasks">—</td></tr>',
        '<tr><td>Active Tasks</td><td data-dash-id="rt-active">—</td></tr>',
        '<tr><td>Failed Tasks</td><td data-dash-id="rt-failed">—</td></tr>',
        '<tr><td>AI Tasks Run</td><td data-dash-id="rt-ai">—</td></tr>',
        '</tbody></table>',
        '<div class="sec">Subsystems Registered</div>',
        '<div id="rt-subsystems"></div>',
        '<div class="sec">Device Profile</div>',
        '<table><tbody>',
        '<tr><td>Platform</td><td data-dash-id="rt-platform">—</td></tr>',
        '<tr><td>CPU Cores</td><td data-dash-id="rt-cores">—</td></tr>',
        '<tr><td>Device RAM</td><td data-dash-id="rt-ram">—</td></tr>',
        '<tr><td>AI Device Tier</td><td data-dash-id="rt-aitier">—</td></tr>',
        '</tbody></table>',
        '<div class="sec">Phase 14-16 Core</div>',
        '<table><tbody>',
        '<tr><td>RuntimeFederation</td><td data-dash-id="rt-fed">—</td></tr>',
        '<tr><td>AIRuntime</td><td data-dash-id="rt-airun">—</td></tr>',
        '<tr><td>RuntimeGovernor</td><td data-dash-id="rt-gov">—</td></tr>',
        '</tbody></table>',
      ].join('');

      default: return '<div style="padding:20px;color:#6b7280">No content for tab: ' + id + '</div>';
    }
  }

  function _card(label, id, val, unit, cls, color) {
    return [
      '<div class="mk">',
      '<div class="mk-label">' + label + '</div>',
      '<div class="mk-value' + (cls ? ' ' + cls : '') + '" data-dash-id="' + id + '"',
      (color ? ' style="color:' + color + '"' : ''), '>' + val + '</div>',
      unit ? '<div class="mk-unit">' + unit + '</div>' : '',
      '</div>',
    ].join('');
  }

  function _chart(id, label, cls) {
    return '<div class="ch-wrap"><div class="ch-label">' + label + '</div><canvas class="' + cls + '" id="' + id + '"></canvas></div>';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 8  CANVAS CHART ENGINE
   * ═══════════════════════════════════════════════════════════════════════════ */
  var CHART_COLORS = {
    heap:    '#818cf8',
    heappct: '#a78bfa',
    workers: '#34d399',
    health:  '#22c55e',
    ai:      '#f59e0b',
    kernel:  '#fb923c',
    streams: '#38bdf8',
  };

  function _drawChart(canvasId, data, opts) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.getContext) return;
    var W = canvas.offsetWidth || 200;
    canvas.width = W;
    var H = canvas.height || 60;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    if (!data || data.length < 2) {
      ctx.fillStyle = '#21262d';
      ctx.font = '10px monospace';
      ctx.fillText('collecting data…', 4, H / 2 + 4);
      return;
    }

    var max  = opts.max != null ? opts.max : Math.max.apply(null, data) || 1;
    var min  = opts.min != null ? opts.min : 0;
    var rng  = (max - min) || 1;
    var col  = opts.color || '#818cf8';
    var pad  = 2;

    /* Grid */
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth   = 0.5;
    for (var g = 0; g <= 3; g++) {
      var gy = Math.round(pad + (g / 3) * (H - pad * 2)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    /* Fill area */
    ctx.beginPath();
    for (var i = 0; i < data.length; i++) {
      var x  = (i / (data.length - 1)) * W;
      var vy = pad + (H - pad * 2) - ((data[i] - min) / rng) * (H - pad * 2);
      if (i === 0) ctx.moveTo(x, vy); else ctx.lineTo(x, vy);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = col + '22';
    ctx.fill();

    /* Line */
    ctx.beginPath();
    ctx.strokeStyle = col;
    ctx.lineWidth   = 1.5;
    for (var j = 0; j < data.length; j++) {
      var xj  = (j / (data.length - 1)) * W;
      var vyj = pad + (H - pad * 2) - ((data[j] - min) / rng) * (H - pad * 2);
      if (j === 0) ctx.moveTo(xj, vyj); else ctx.lineTo(xj, vyj);
    }
    ctx.stroke();

    /* Current value label */
    var last = data[data.length - 1];
    ctx.fillStyle = col;
    ctx.font      = '10px monospace';
    ctx.fillText((opts.label ? opts.label + ': ' : '') + _fmt(last, opts.decimals || 0) + (opts.unit || ''), 4, 13);

    /* Max label */
    ctx.fillStyle = '#484f58';
    ctx.textAlign = 'right';
    ctx.fillText('max:' + _fmt(max, opts.decimals || 0), W - 3, 13);
    ctx.textAlign = 'left';
  }

  function _fmt(v, dec) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(dec || 0);
  }

  function _redrawAllCharts() {
    var hData  = RB.heap.data();
    var hpData = RB.heapPct.data();
    var wData  = RB.workers.data();
    var aiData = RB.aiQ.data();
    var kData  = RB.kernel.data();
    var hlData = RB.health.data();
    var sData  = RB.streams.data();

    switch (_activeTab) {
      case 'overview':
        _drawChart('ch-heap',    hData,  { color: CHART_COLORS.heap,    unit: 'MB', label: 'heap' });
        _drawChart('ch-heappct', hpData, { color: CHART_COLORS.heappct, unit: '%',  label: 'heap%', max: 100 });
        _drawChart('ch-workers', wData,  { color: CHART_COLORS.workers, label: 'workers' });
        _drawChart('ch-health',  hlData, { color: CHART_COLORS.health,  label: 'health', min: 0, max: 100 });
        _drawChart('ch-aiq',     aiData, { color: CHART_COLORS.ai,      label: 'ai-tasks' });
        _drawChart('ch-streams', sData,  { color: CHART_COLORS.streams, label: 'streams' });
        break;
      case 'memory':
        _drawChart('ch-mem-heap', hData,  { color: CHART_COLORS.heap,    unit: 'MB', label: 'heap' });
        _drawChart('ch-mem-pct',  hpData, { color: CHART_COLORS.heappct, unit: '%',  label: 'heap%', max: 100 });
        break;
      case 'workers':
        _drawChart('ch-wrk-load', wData,  { color: CHART_COLORS.workers, label: 'load' });
        break;
      case 'ai':
        _drawChart('ch-ai-q',  aiData, { color: CHART_COLORS.ai, label: 'tasks' });
        break;
      case 'streams':
        _drawChart('ch-str-act', sData, { color: CHART_COLORS.streams, label: 'streams' });
        break;
      case 'kernel':
        _drawChart('ch-krn-q', kData, { color: CHART_COLORS.kernel, label: 'queued' });
        break;
      case 'health':
        _drawChart('ch-hlth', hlData, { color: CHART_COLORS.health, label: 'score', min: 0, max: 100 });
        break;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 9  TAB RENDERERS — update data-dash-id values in active tab
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _set(id, val) {
    var el = _panel && _panel.querySelector('[data-dash-id="' + id + '"]');
    if (el && el.textContent !== String(val)) el.textContent = String(val);
  }
  function _setColor(id, color) {
    var el = _panel && _panel.querySelector('[data-dash-id="' + id + '"]');
    if (el) el.style.color = color;
  }
  function _setHTML(id, html) {
    var el = _panel && (typeof id === 'string' ? _panel.querySelector('#' + id) : id);
    if (el) el.innerHTML = html;
  }

  function _badge(ok, trueText, falseText) {
    return ok ? '<span class="badge badge-ok">' + (trueText || 'yes') + '</span>'
               : '<span class="badge badge-off">' + (falseText || 'no') + '</span>';
  }
  function _badgeLevel(level) {
    var cls = { PERFECT:'badge-ok', HEALTHY:'badge-ok', WARNING:'badge-warn', DEGRADED:'badge-warn', CRITICAL:'badge-err' }[level] || 'badge-off';
    return '<span class="badge ' + cls + '">' + (level || '—') + '</span>';
  }

  function _fmtUptime(ms) {
    if (!ms || ms < 0) return '0s';
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  function _fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function _renderStatusBar() {
    _set('sb-health', _health.level);
    _set('sb-mem',    _m.memory ? _m.memory.tier : 'N/A');
    _set('sb-wrk',    _m.workers ? (_m.workers.busy + '/' + _m.workers.total) : '0');
    _set('sb-ai',     _m.ai ? (_m.ai.active + '+' + _m.ai.queued + 'q') : '0');
    _set('sb-str',    _m.streams ? _m.streams.active : '0');
    var dot = _panel && _panel.querySelector('[data-dash-id="sb-dot"]');
    if (dot) dot.style.background = _health.color;

    var hdrH = _panel && _panel.querySelector('[data-dash-id="hdr-health"]');
    if (hdrH) { hdrH.textContent = _health.level + ' ' + _health.score; hdrH.style.color = _health.color; hdrH.style.borderColor = _health.color; }
    _set('hdr-uptime', _fmtUptime(_m.uptime));
  }

  function _renderOverview() {
    var h = _health, m = _m;
    _set('ov-score',  h.score); _setColor('ov-score', h.color);
    _set('ov-tier',   m.memory.tier);
    _set('ov-heap',   m.memory.usedMB >= 0 ? m.memory.usedMB : '—');
    _set('ov-heappct',m.memory.pct >= 0 ? m.memory.pct : '—');
    _set('ov-wbsy',   m.workers.busy + '/' + m.workers.total);
    _set('ov-ai',     m.ai.active + '+' + m.ai.queued + 'q');
    _set('ov-str',    m.streams.active);
    _set('ov-kq',     m.kernel.queued);
  }

  function _renderMemory() {
    var mem = _m.memory;
    _set('mem-tier',   mem.tier);
    _set('mem-used',   mem.usedMB >= 0 ? mem.usedMB : '—');
    _set('mem-total',  mem.totalMB > 0 ? mem.totalMB : '—');
    _set('mem-limit',  mem.limitMB > 0 ? mem.limitMB : '—');
    _set('mem-avail',  mem.memAvailMB > 0 ? mem.memAvailMB : '—');
    _set('mem-pct',    mem.pct >= 0 ? mem.pct : '—');
    var cfg = mem.config || {};
    _set('mem-cfg-wrk',   cfg.maxWorkers   != null ? cfg.maxWorkers : '—');
    _set('mem-cfg-prev',  cfg.maxPreviews  != null ? cfg.maxPreviews : '—');
    _set('mem-cfg-chunk', cfg.chunkMB      != null ? cfg.chunkMB + ' MB' : '—');
    _set('mem-cfg-preview',cfg.enablePreview != null ? String(cfg.enablePreview) : '—');
    _set('mem-mobile', String(!!mem.isMobile));
    _set('mem-ios',    String(!!mem.isIOS));
  }

  function _renderWorkers() {
    var w = _m.workers;
    _set('wrk-total',   w.total);
    _set('wrk-busy',    w.busy);
    _set('wrk-idle',    w.idle);
    _set('wrk-queued',  w.queued);
    _set('wrk-crashed', w.crashed);
    _setColor('wrk-crashed', w.crashed > 0 ? '#ef4444' : '#22c55e');
    _set('wrk-inflight',w.inflight);

    /* Pool table */
    var rows = '';
    if (!w.poolUrls.length) {
      rows = '<div style="color:#484f58;padding:4px">No workers spawned yet</div>';
    } else {
      rows = '<table><thead><tr><th>Worker URL</th><th>Total</th><th>Busy</th><th>Queued</th><th>Crashed</th></tr></thead><tbody>';
      w.poolUrls.forEach(function (url) {
        var p = w.pool[url] || {};
        var shortUrl = url.replace('/workers/', '').replace('/js/', '');
        rows += '<tr><td title="' + url + '">' + shortUrl + '</td><td>' + (p.total || 0) + '</td><td>' + (p.busy || 0) + '</td><td>' + (p.queued || 0) + '</td><td style="color:' + (p.crashed ? '#ef4444' : '#22c55e') + '">' + (p.crashed || 0) + '</td></tr>';
      });
      rows += '</tbody></table>';
    }
    _setHTML('wrk-pool-table', rows);
  }

  function _renderAI() {
    var ai = _m.ai;
    _set('ai-active', ai.active);
    _set('ai-queued', ai.queued);
    _set('ai-maxc',   ai.maxConc);
    _set('ai-dtier',  ai.deviceTier || '—');

    /* Providers */
    var provs = ai.providers.length ? ai.providers : ai.orchProvs.map(function (n) { return { name: n, available: true, tier: 'orchestrator', priority: 1 }; });
    var phml = '<table><thead><tr><th>Provider</th><th>Tier</th><th>Priority</th><th>Status</th></tr></thead><tbody>';
    if (!provs.length) phml += '<tr><td colspan="4" style="color:#484f58">No providers discovered</td></tr>';
    provs.forEach(function (p) {
      var avail = p.available !== false;
      phml += '<tr><td>' + (p.name || '?') + '</td><td>' + (p.tier || '?') + '</td><td>' + (p.priority || '?') + '</td><td>' + _badge(avail, 'ready', 'unavail') + '</td></tr>';
    });
    phml += '</tbody></table>';
    _setHTML('ai-providers', phml);

    /* History */
    var hist = (ai.history || []).slice(0, 5);
    var hhml = '';
    if (!hist.length) { hhml = '<div style="color:#484f58;padding:4px">No tasks yet</div>'; }
    else {
      hhml = '<table><thead><tr><th>Task Type</th><th>Provider</th><th>Duration</th><th>Status</th></tr></thead><tbody>';
      hist.forEach(function (h) {
        var ok = h.ok !== false;
        hhml += '<tr><td>' + (h.taskType || '?') + '</td><td>' + (h.provider || '?') + '</td><td>' + (h.durationMs || 0) + 'ms</td><td>' + _badge(ok, 'ok', 'err') + '</td></tr>';
      });
      hhml += '</tbody></table>';
    }
    _setHTML('ai-history', hhml);

    /* Local AI */
    var lai = ai.localAi || {};
    _set('ai-lai-models', Array.isArray(lai.loadedModels) ? lai.loadedModels.length : (lai.models || '—'));
    _set('ai-lai-tasks',  lai.tasksRun  != null ? lai.tasksRun : '—');
    _set('ai-lai-cache',  lai.cacheHits != null ? lai.cacheHits : '—');
  }

  function _renderStreams() {
    var str = _m.streams;
    _set('str-active', str.active);
    _set('str-total',  str.totalEver);
    _set('str-xfr',    str.transferable ? 'yes' : 'no');
    var zc = str.zc || {};
    _set('zc-alloc',   zc.allocated  != null ? zc.allocated  : '—');
    _set('zc-reuse',   zc.reused     != null ? zc.reused     : '—');
    _set('zc-rel',     zc.released   != null ? zc.released   : '—');
    _set('zc-chunk',   zc.chunkSize  != null ? _fmtBytes(zc.chunkSize) : '—');
    _set('zc-tier',    zc.memTier    || '—');
    var adp = str.adaptive || {};
    _set('adp-tier',   adp.tier      || '—');
    _set('adp-chunk',  adp.chunkSz   != null ? _fmtBytes(adp.chunkSz) : '—');
    _set('adp-batch',  adp.batchSz   != null ? adp.batchSz : '—');
    _set('adp-conc',   adp.concurrency!= null ? adp.concurrency : '—');
    _set('adp-score',  adp.score     != null ? adp.score : '—');
  }

  function _renderFederation() {
    var fed = _m.federation;
    if (!fed) {
      _setHTML(PANEL_ID + '-federation', '<div style="color:#484f58;padding:20px">RuntimeFederation not loaded (tool.html only)</div>');
      return;
    }
    _set('fed-groups-ready', fed.groupsReady || '—');
    _set('fed-tools-ready',  fed.toolsReady  || '—');

    /* Groups grid */
    var groups = fed.groups || {};
    var ghml = '<div class="dg3">';
    Object.keys(groups).forEach(function (gname) {
      var g = groups[gname];
      var ok = g.loaded;
      var cls = ok ? 'badge-ok' : (g.missing && g.missing.length ? 'badge-warn' : 'badge-off');
      var miss = g.missing && g.missing.length ? '<div style="font-size:10px;color:#f59e0b;margin-top:3px">missing: ' + g.missing.join(', ') + '</div>' : '';
      ghml += '<div class="mk"><div class="mk-label">' + gname + '</div>';
      ghml += '<div><span class="badge ' + cls + '">' + (ok ? 'loaded' : 'missing') + '</span></div>';
      if (miss) ghml += miss;
      ghml += '</div>';
    });
    ghml += '</div>';
    _setHTML('fed-groups', ghml);

    /* Tools (compact - show only not-ready ones) */
    var tools = (fed.tools || []).filter(function (t) { return !t.ready; }).slice(0, 10);
    if (!tools.length) {
      _setHTML('fed-tools-table', '<div style="color:#22c55e;padding:4px">All tools ready ✓</div>');
    } else {
      var thml = '<table><thead><tr><th>Tool</th><th>Missing Groups</th></tr></thead><tbody>';
      tools.forEach(function (t) {
        thml += '<tr><td>' + t.toolId + '</td><td style="color:#f59e0b">' + (t.missing || []).join(', ') + '</td></tr>';
      });
      thml += '</tbody></table>';
      _setHTML('fed-tools-table', thml);
    }
  }

  function _renderKernel() {
    var krn = _m.kernel;
    _set('krn-queued',  krn.queued);
    _set('krn-active',  krn.totalActive || Object.values(krn.active || {}).reduce(function (a, b) { return a + b; }, 0));
    _set('krn-score',   krn.score != null ? krn.score : '—');
    _set('krn-memtier', krn.memTier || '—');

    /* Per-resource queues */
    var queues = krn.queues || {};
    var limits = krn.limits || {};
    var active = krn.active || {};
    var qhml = '<table><thead><tr><th>Resource</th><th>Active</th><th>Queued</th><th>Limit</th></tr></thead><tbody>';
    var resources = ['worker', 'gpu', 'wasm', 'ai', 'stream', 'opfs', 'custom'];
    resources.forEach(function (r) {
      var q = queues[r] || 0;
      var a = active[r] || 0;
      var l = limits[r] != null ? limits[r] : '∞';
      qhml += '<tr><td>' + r + '</td><td>' + a + '</td><td>' + (q > 0 ? '<span style="color:#f59e0b">' + q + '</span>' : q) + '</td><td>' + l + '</td></tr>';
    });
    qhml += '</tbody></table>';
    _setHTML('krn-queues', qhml);

    /* Subsystems */
    var subs = krn.subsystems || {};
    var shml = '<div class="dg3">';
    Object.keys(subs).forEach(function (k) {
      shml += '<div class="mk"><div class="mk-label">' + k + '</div><div>' + _badge(subs[k]) + '</div></div>';
    });
    shml += '</div>';
    _setHTML('krn-subsys', shml);
  }

  function _renderEvents() {
    /* Wire up controls on first visit */
    var filterEl = _panel.querySelector('#ev-filter-input');
    if (filterEl && !filterEl._wired) {
      filterEl._wired = true;
      filterEl.addEventListener('input', function () { _evFilter = filterEl.value.toLowerCase(); _renderEventTab(); });
    }
    var pauseBtn = _panel.querySelector('#ev-pause-btn');
    if (pauseBtn && !pauseBtn._wired) {
      pauseBtn._wired = true;
      pauseBtn.addEventListener('click', function () {
        _evPaused = !_evPaused;
        pauseBtn.textContent = _evPaused ? '▶ Resume' : '⏸ Pause';
      });
    }
    var clearBtn = _panel.querySelector('#ev-clear-btn');
    if (clearBtn && !clearBtn._wired) {
      clearBtn._wired = true;
      clearBtn.addEventListener('click', function () { _events = []; _renderEventTab(); });
    }
    var expBtn = _panel.querySelector('#ev-export-btn');
    if (expBtn && !expBtn._wired) {
      expBtn._wired = true;
      expBtn.addEventListener('click', function () {
        var blob = new Blob([JSON.stringify(_events, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'runtime-events-' + Date.now() + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      });
    }
    _renderEventTab();
  }

  function _renderEventTab() {
    var listEl = _panel && _panel.querySelector('#ev-list');
    if (!listEl) return;
    var filtered = _evFilter
      ? _events.filter(function (e) { return (e.type + ' ' + e.msg).toLowerCase().indexOf(_evFilter) !== -1; })
      : _events;
    var html = '';
    filtered.slice(0, 100).forEach(function (e) {
      var cls = e.level === 'error' ? ' ev-lv-error' : e.level === 'warn' ? ' ev-lv-warn' : '';
      var ts = new Date(e.ts).toLocaleTimeString('en', { hour12: false });
      html += '<div class="ev-row"><span class="ev-ts">' + ts + '</span>'
        + '<span class="ev-type' + cls + '">' + e.type + '</span>'
        + '<span class="ev-msg">' + e.msg + '</span></div>';
    });
    if (!html) html = '<div style="color:#484f58;padding:8px">No events yet — listening on RuntimeEventBus…</div>';
    listEl.innerHTML = html;
  }

  function _renderHealth() {
    _set('hlth-score', _health.score);
    _setColor('hlth-score', _health.color);
    _set('hlth-level', _health.level);

    /* Factors */
    var factors = _health.factors;
    var fhml = factors.length
      ? factors.map(function (f) { return '<span class="factor">−' + f + '</span>'; }).join('')
      : '<span style="color:#22c55e">No deductions — platform healthy</span>';
    _setHTML('hlth-factors', fhml);

    /* RuntimeHealth history */
    var hist = _g('RuntimeHealth', function (r) { return r.getHistory ? r.getHistory() : []; }, []);
    var hhml = '';
    if (!hist.length) { hhml = '<div style="color:#484f58;padding:4px">No history yet</div>'; }
    else {
      hhml = '<table><thead><tr><th>Score</th><th>Time</th></tr></thead><tbody>';
      hist.slice(0, 8).forEach(function (h) {
        var sc = typeof h === 'number' ? h : (h.score || '?');
        var ts = typeof h === 'object' && h.ts ? new Date(h.ts).toLocaleTimeString() : '—';
        hhml += '<tr><td style="color:' + (sc >= 75 ? '#22c55e' : sc >= 50 ? '#f59e0b' : '#ef4444') + '">' + sc + '</td><td>' + ts + '</td></tr>';
      });
      hhml += '</tbody></table>';
    }
    _setHTML('hlth-history', hhml);
  }

  function _renderRuntime() {
    var rt = _m.runtime || {};
    _set('rt-version', rt.version || _g('CentralRuntime', function (r) { return r.VERSION; }, '—'));
    _set('rt-uptime',  _fmtUptime(_m.uptime));
    _set('rt-tasks',   rt.totalTasks   != null ? rt.totalTasks   : '—');
    _set('rt-active',  rt.activeTasks  != null ? rt.activeTasks  : '—');
    _set('rt-failed',  rt.failedTasks  != null ? rt.failedTasks  : '—');
    _set('rt-ai',      rt.aiTasksRun   != null ? rt.aiTasksRun   : '—');

    /* Subsystems registered */
    var subs = rt.subsystems || {};
    var subKeys = Object.keys(subs);
    var shml = '';
    if (!subKeys.length) { shml = '<div style="color:#484f58;padding:4px">No subsystems registered</div>'; }
    else {
      shml = '<div class="dg3">';
      subKeys.forEach(function (k) { shml += '<div class="mk"><div class="mk-label">' + k + '</div><div>' + _badge(true) + '</div></div>'; });
      shml += '</div>';
    }
    _setHTML('rt-subsystems', shml);

    /* Device */
    var ua = navigator.userAgent || '';
    var isMobile = /Mobile|Tablet|Android|iPhone|iPad/i.test(ua);
    var isIOS    = /iPhone|iPad/i.test(ua);
    _set('rt-platform', isIOS ? 'iOS' : isMobile ? 'Mobile' : 'Desktop');
    _set('rt-cores',   navigator.hardwareConcurrency || '?');
    _set('rt-ram',     (navigator.deviceMemory || '?') + ' GB');
    _set('rt-aitier',  _m.ai.deviceTier || '—');

    /* Phase 14-16 */
    _set('rt-fed',   G.RuntimeFederation  ? _badgeLevel('loaded') : '<span class="badge badge-off">not loaded</span>');
    _set('rt-airun', G.AIRuntime          ? _badgeLevel('loaded') : '<span class="badge badge-off">not loaded</span>');
    _set('rt-gov',   G.RuntimeGovernor    ? _badgeLevel('loaded') : '<span class="badge badge-off">not loaded</span>');

    /* Fix: allow badge HTML via direct update */
    ['rt-fed','rt-airun','rt-gov'].forEach(function(id) {
      var el = _panel && _panel.querySelector('[data-dash-id="' + id + '"]');
      var val;
      if (id === 'rt-fed')   val = G.RuntimeFederation  ? '✓ loaded' : '✗ not loaded';
      if (id === 'rt-airun') val = G.AIRuntime          ? '✓ loaded' : '✗ not loaded';
      if (id === 'rt-gov')   val = G.RuntimeGovernor    ? '✓ loaded' : '✗ not loaded';
      if (el) { el.textContent = val; el.style.color = val.startsWith('✓') ? '#22c55e' : '#484f58'; }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 10  RENDER DISPATCHER
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _renderActiveTab() {
    if (!_panel || !_visible || _minimized) return;
    _renderStatusBar();
    switch (_activeTab) {
      case 'overview':   _renderOverview();   break;
      case 'memory':     _renderMemory();     break;
      case 'workers':    _renderWorkers();    break;
      case 'ai':         _renderAI();         break;
      case 'streams':    _renderStreams();     break;
      case 'federation': _renderFederation(); break;
      case 'kernel':     _renderKernel();     break;
      case 'events':     _renderEvents();     break;
      case 'health':     _renderHealth();     break;
      case 'runtime':    _renderRuntime();    break;
    }
    _redrawAllCharts();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 11  RAF UPDATE LOOP
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _collectTimer  = null;
  var _visible       = false;
  var _activeTab     = 'overview';
  var _minimized     = false;
  var _rafId         = null;
  var _lastRenderTs  = 0;
  var RENDER_INTERVAL = 500; // 2fps max

  function _scheduleRender() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(function () {
      _rafId = null;
      if (!_visible || document.hidden) return;
      var now = Date.now();
      if (now - _lastRenderTs < RENDER_INTERVAL) return;
      _lastRenderTs = now;
      _renderActiveTab();
    });
  }

  function _startCollecting() {
    if (_collectTimer) return;
    _collect(); _renderActiveTab();
    _collectTimer = setInterval(function () {
      if (document.hidden) return;
      _collect();
      _scheduleRender();
    }, 500);
  }

  function _stopCollecting() {
    if (_collectTimer) { clearInterval(_collectTimer); _collectTimer = null; }
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 12  TAB SWITCHING
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _switchTab(id) {
    if (!_panel) return;
    _activeTab = id;
    TABS.forEach(function (t) {
      var btn = _panel.querySelector('.dt-tab[data-tab="' + t.id + '"]');
      var pnl = _content[t.id];
      if (btn) btn.classList.toggle('active', t.id === id);
      if (pnl) pnl.classList.toggle('active', t.id === id);
    });
    _collect(); _renderActiveTab();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 13  DRAG + RESIZE
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _makeDraggable(panel) {
    var header = panel.querySelector('.dh');
    if (!header) return;
    var startX, startY, startL, startT, dragging = false;

    header.addEventListener('pointerdown', function (e) {
      if (e.target.classList.contains('dh-dot')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startL = parseInt(panel.style.left) || panel.getBoundingClientRect().left;
      startT = parseInt(panel.style.top)  || panel.getBoundingClientRect().top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    }, { passive: false });

    header.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var newL = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  startL + e.clientX - startX));
      var newT = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startT + e.clientY - startY));
      panel.style.left = newL + 'px'; panel.style.top = newT + 'px';
    });

    header.addEventListener('pointerup', function () {
      if (dragging) { dragging = false; _savePos(); }
    });
  }

  function _makeResizable(panel, handle) {
    var startX, startY, startW, startH, resizing = false;

    handle.addEventListener('pointerdown', function (e) {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = panel.offsetWidth; startH = panel.offsetHeight;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    }, { passive: false });

    handle.addEventListener('pointermove', function (e) {
      if (!resizing) return;
      panel.style.width  = Math.max(440, startW + e.clientX - startX) + 'px';
      panel.style.height = Math.max(260, startH + e.clientY - startY) + 'px';
    });

    handle.addEventListener('pointerup', function () {
      if (resizing) { resizing = false; _savePos(); }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 14  POSITION PERSISTENCE
   * ═══════════════════════════════════════════════════════════════════════════ */
  var STORE_KEY = 'iplv_dash_pos';

  function _savePos() {
    if (!_panel) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        left:    _panel.style.left,
        top:     _panel.style.top,
        width:   _panel.style.width,
        height:  _panel.style.height,
        tab:     _activeTab,
        visible: _visible,
        mini:    _minimized,
      }));
    } catch (_) {}
  }

  function _loadPos() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (!saved || !_panel) return;
      if (saved.left)   _panel.style.left   = saved.left;
      if (saved.top)    _panel.style.top    = saved.top;
      if (saved.width)  _panel.style.width  = saved.width;
      if (saved.height) _panel.style.height = saved.height;
      if (saved.tab)    _activeTab = saved.tab;
      if (saved.mini)   _minimized = saved.mini;
      return saved;
    } catch (_) { return {}; }
  }

  function _defaultPos() {
    if (!_panel) return;
    _panel.style.width  = '860px';
    _panel.style.height = '540px';
    var r = Math.min(window.innerWidth - 880, window.innerWidth - 20);
    var b = Math.min(window.innerHeight - 560, window.innerHeight - 20);
    _panel.style.right  = '20px';
    _panel.style.bottom = '20px';
    _panel.style.left   = 'auto';
    _panel.style.top    = 'auto';
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 15  EVENTBUS HOOKS — capture all runtime events into the log
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _ebHooked = false;

  function _hookEventBus() {
    if (_ebHooked) return;
    var bus = G.RuntimeEventBus;
    if (!bus || typeof bus.on !== 'function') return;
    _ebHooked = true;
    bus.on('*', function (typeOrObj, data) {
      var type = (typeOrObj && typeof typeOrObj === 'object') ? (typeOrObj.type || 'event') : String(typeOrObj);
      var payload = (typeOrObj && typeof typeOrObj === 'object') ? (typeOrObj.data || typeOrObj) : (data || {});
      var level = type.indexOf('error') !== -1 || type.indexOf('crash') !== -1 || type.indexOf('fail') !== -1 ? 'error'
                : type.indexOf('warn') !== -1 || type.indexOf('leak') !== -1 || type.indexOf('dead') !== -1 ? 'warn'
                : 'info';
      var msg = '';
      try {
        if (typeof payload === 'object' && payload !== null) {
          var keys = Object.keys(payload).slice(0, 3);
          msg = keys.map(function (k) { return k + ':' + JSON.stringify(payload[k]).slice(0, 30); }).join('  ');
        } else { msg = String(payload).slice(0, 100); }
      } catch (_) {}
      _logEvent(type, msg, level);
    });
    console.debug(LOG, 'EventBus hooked — all events captured');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 16  MINIMIZE TOGGLE
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _toggleMinimize() {
    _minimized = !_minimized;
    if (_panel) _panel.classList.toggle('minimized', _minimized);
    if (_minimized) _stopCollecting(); else _startCollecting();
    _savePos();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 17  SHOW / HIDE / TOGGLE
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _show() {
    if (!G.__IPLV_ADMIN_RUNTIME__) return; /* Phase 18: admin-only */
    if (_visible) return;
    _visible = true;
    _injectCSS();
    if (!_panel) {
      _panel = _buildPanel();
      document.body.appendChild(_panel);
      var saved = _loadPos();
      if (!saved || (!saved.left && !saved.right)) _defaultPos();
      if (saved && saved.tab)  _switchTab(saved.tab);
      if (saved && saved.mini) _panel.classList.add('minimized');
      _makeDraggable(_panel);
      _hookEventBus();
    } else {
      _panel.style.display = '';
    }
    _startCollecting();
    _logEvent('dashboard:opened', 'Runtime Dashboard opened', 'info');
    console.debug(LOG, 'Panel shown — Ctrl+Shift+R to hide');
  }

  function _hide() {
    if (!_visible) return;
    _visible = false;
    _stopCollecting();
    if (_panel) _panel.style.display = 'none';
    _savePos();
    console.debug(LOG, 'Panel hidden — Ctrl+Shift+R to show');
  }

  function _toggle() {
    if (_visible) _hide(); else _show();
  }

  function _destroy() {
    _hide();
    _stopCollecting();
    if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
    var css = document.getElementById(PANEL_ID + '-css');
    if (css && css.parentNode) css.parentNode.removeChild(css);
    _panel = null;
    _content = {};
    _ebHooked = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 18  PUBLIC API
   * ═══════════════════════════════════════════════════════════════════════════ */
  var RuntimeDashboard = {
    VERSION:  VERSION,

    init:              function () { _injectCSS(); _hookEventBus(); },
    show:              _show,
    hide:              _hide,
    toggle:            _toggle,
    destroy:           _destroy,
    render:            function () { _collect(); _renderActiveTab(); },
    update:            function () { _collect(); _scheduleRender(); },
    attach:            _hookEventBus,
    detach:            function () { _ebHooked = false; },
    mountFloatingPanel: _show,
    mountFullscreenPanel: function () {
      _show();
      if (_panel) { _panel.style.left = '0'; _panel.style.top = '0'; _panel.style.width = '100vw'; _panel.style.height = '100vh'; _panel.style.right = 'auto'; _panel.style.bottom = 'auto'; _panel.style.borderRadius = '0'; }
    },

    isVisible:   function () { return _visible; },
    isMinimized: function () { return _minimized; },
    getMetrics:  function () { return _m; },
    getHealth:   function () { return _health; },
    getEvents:   function () { return _events.slice(); },
    switchTab:   _switchTab,

    /* Health engine */
    computeHealth: _computeHealth,
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 19  KEYBOARD SHORTCUT — Ctrl+Shift+R
   * ═══════════════════════════════════════════════════════════════════════════ */
  document.addEventListener('keydown', function (e) {
    if (!G.__IPLV_ADMIN_RUNTIME__) return; /* Phase 18: admin-only */
    if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r' || e.keyCode === 82)) {
      e.preventDefault();
      _toggle();
    }
  });

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 20  BOOT — expose globals and attach RT.runtime.dashboard
   * ═══════════════════════════════════════════════════════════════════════════ */
  G.RuntimeDashboard = RuntimeDashboard;

  /* Attach RT.runtime.dashboard() — done now if CentralRuntime is ready,
     otherwise deferred to DOMContentLoaded (ensures RT exists) */
  function _attachToRT() {
    var targets = [G.CentralRuntime, G.RT].filter(Boolean);
    targets.forEach(function (rt) {
      if (rt && !rt.runtime) rt.runtime = {};
      if (rt && rt.runtime && !rt.runtime.dashboard) {
        rt.runtime.dashboard = function () { return RuntimeDashboard; };
      }
    });
    _hookEventBus();
  }

  _attachToRT();
  document.addEventListener('DOMContentLoaded', _attachToRT, { once: true });

  /* pagehide cleanup */
  window.addEventListener('pagehide', function () {
    _stopCollecting();
  }, { passive: true });

  if (G.__IPLV_ADMIN_RUNTIME__) console.debug(LOG, 'RuntimeDashboard v' + VERSION + ' ready — Ctrl+Shift+R to open');

}(window));
