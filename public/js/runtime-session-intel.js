// RuntimeSessionIntel v1.0 — Analytics + Session Intelligence
// =====================================================================
// Lightweight browser-side session intelligence layer.
//
// Modules:
//   A) Session Flow Funnel — tracks homepage→tool→process→download
//   B) Tool Popularity     — localStorage per-tool hit counter; top-N API
//   C) Rage Click Detector — ≥3 taps in 50 px radius within 1.5 s
//   D) Anonymous Heatmap   — 32×24 click-density grid; 7-day rolling
//   E) Device Analytics    — screen, browser, connection, pixel ratio
//   F) Slow Processing Log — detects tasks > 8 s, emits analytics event
//
// Privacy guarantees:
//   • ZERO personal data collected
//   • NO file names or file contents ever stored
//   • All heatmap / popularity data stays in localStorage (never sent raw)
//   • Only aggregated, anonymised summaries sent via RuntimeAnalytics.track()
//   • Crawler UA is auto-suppressed
//
// Integrates with:
//   RuntimeAnalytics  — sends summary events
//   RuntimeTelemetry  — listens for task lifecycle
//   RuntimeEventBus   — publishes rage-click / funnel events
//
// Exposed as: window.RuntimeSessionIntel
//   .getFunnel()        → FunnelStep[]
//   .getTopTools(n?)    → [{slug, count}]
//   .getHeatmap()       → { grid: Uint16Array, cols: 32, rows: 24 }
//   .getDeviceProfile() → DeviceProfile
//   .resetSession()     — clear in-memory state (not localStorage)
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionIntel) return;

  var LOG         = '[RSI]';
  var CRAWLER_RE  = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|bot|crawler|spider/i;
  if (CRAWLER_RE.test((navigator.userAgent) || '')) return;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── A) SESSION FLOW FUNNEL ───────────────────────────────────────────────
  var FUNNEL_STEPS = ['page_view', 'tool_enter', 'process_start', 'process_success', 'process_fail', 'download'];
  var _funnel = [];   // [{ step, ts, slug? }]

  function _recordFunnel(step, meta) {
    meta = meta || {};
    _funnel.push({ step: step, ts: Date.now(), slug: meta.slug || null });
    if (_funnel.length > 50) _funnel.shift();

    // Emit to analytics
    if (G.RuntimeAnalytics) {
      try {
        G.RuntimeAnalytics.track('funnel:' + step, {
          tool_id: meta.slug || null,
          extra:   { funnelLen: _funnel.length },
        });
      } catch (_) {}
    }
    if (G.RuntimeEventBus) {
      try { G.RuntimeEventBus.emit('session:funnel', { step: step, meta: meta }); } catch (_) {}
    }
  }

  // Auto-detect step from URL on load
  function _detectInitialStep() {
    var path = (G.location && G.location.pathname) || '/';
    if (path === '/' || path === '/index.html') {
      _recordFunnel('page_view', {});
    } else {
      var slug = path.replace(/^\//, '').split('/')[0];
      if (slug) {
        _recordFunnel('page_view', {});
        _recordFunnel('tool_enter', { slug: slug });
      }
    }
  }

  // Hook RuntimeTelemetry to track processing lifecycle
  function _hookTelemetry() {
    if (!G.RuntimeTelemetry || !G.RuntimeTelemetry.onEvent) return;
    G.RuntimeTelemetry.onEvent(function (ev) {
      var n = ev.name || '';
      var slug = _s(function () { return ev.data && ev.data.toolId || ev.data && ev.data.slug; });
      if (n === 'task:started')   _recordFunnel('process_start',   { slug: slug });
      if (n === 'task:completed') _recordFunnel('process_success', { slug: slug });
      if (n === 'task:failed')    _recordFunnel('process_fail',    { slug: slug });
      if (n === 'queue:task-done') _recordFunnel('process_success', { slug: slug });
    });
  }

  // Hook download events
  function _hookDownload() {
    document.addEventListener('download:triggered', function (e) {
      var slug = _s(function () { return e.detail && e.detail.slug; });
      _recordFunnel('download', { slug: slug });
    }, { passive: true });
    // Also hook DownloadManager if available
    if (G.DownloadManager && G.DownloadManager.onDownload) {
      try {
        G.DownloadManager.onDownload(function (d) {
          _recordFunnel('download', { slug: d && d.toolId });
        });
      } catch (_) {}
    }
  }

  // ── B) TOOL POPULARITY ────────────────────────────────────────────────────
  var LS_POP_KEY  = 'iplv_tool_pop_v2';
  var POP_MAX     = 60; // max tools tracked

  function _loadPop() {
    try { return JSON.parse(localStorage.getItem(LS_POP_KEY) || '{}'); } catch (_) { return {}; }
  }
  function _savePop(data) {
    try { localStorage.setItem(LS_POP_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function _recordToolVisit(slug) {
    if (!slug) return;
    var pop = _loadPop();
    pop[slug] = (pop[slug] || 0) + 1;
    // Cap total entries
    var keys = Object.keys(pop);
    if (keys.length > POP_MAX) {
      var sorted = keys.sort(function (a, b) { return pop[a] - pop[b]; });
      delete pop[sorted[0]]; // remove least popular
    }
    _savePop(pop);

    // Periodically push summary to analytics (every 10 visits)
    var total = keys.reduce(function (s, k) { return s + (pop[k] || 0); }, 0);
    if (total % 10 === 0 && G.RuntimeAnalytics) {
      try {
        var top = getTopTools(5);
        G.RuntimeAnalytics.track('tool:popularity_snapshot', {
          extra: { top5: top.map(function (t) { return t.slug + ':' + t.count; }).join(',') },
        });
      } catch (_) {}
    }
  }

  function getTopTools(n) {
    n = n || 10;
    var pop  = _loadPop();
    var list = Object.keys(pop).map(function (slug) { return { slug: slug, count: pop[slug] }; });
    list.sort(function (a, b) { return b.count - a.count; });
    return list.slice(0, n);
  }

  // ── C) RAGE CLICK DETECTOR ────────────────────────────────────────────────
  var RAGE_RADIUS   = 50;   // px
  var RAGE_COUNT    = 3;    // taps
  var RAGE_WINDOW   = 1500; // ms

  var _clicks = [];  // [{x, y, ts}]
  var _lastRage = 0;

  function _handleClick(e) {
    var x = e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
    var y = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 0;
    var now = Date.now();

    _clicks.push({ x: x, y: y, ts: now });

    // Prune old
    _clicks = _clicks.filter(function (c) { return now - c.ts < RAGE_WINDOW; });

    if (_clicks.length < RAGE_COUNT) return;

    // Check if recent clicks are within radius
    var recent = _clicks.slice(-RAGE_COUNT);
    var cx = recent.reduce(function (s, c) { return s + c.x; }, 0) / recent.length;
    var cy = recent.reduce(function (s, c) { return s + c.y; }, 0) / recent.length;
    var allClose = recent.every(function (c) {
      return Math.sqrt(Math.pow(c.x - cx, 2) + Math.pow(c.y - cy, 2)) <= RAGE_RADIUS;
    });

    if (allClose && now - _lastRage > 2000) {
      _lastRage = now;
      var target = e.target || {};
      var label  = (target.id || target.className || target.tagName || 'unknown').toString().slice(0, 40);

      console.debug(LOG, 'rage-click detected on:', label);

      if (G.RuntimeAnalytics) {
        try {
          G.RuntimeAnalytics.track('ux:rage_click', {
            extra: { element: label, x: Math.round(cx), y: Math.round(cy), count: _clicks.length },
          });
        } catch (_) {}
      }
      if (G.RuntimeEventBus) {
        try { G.RuntimeEventBus.emit('ux:rage_click', { label: label, x: cx, y: cy }); } catch (_) {}
      }
      if (G.RuntimeTelemetry) {
        try { G.RuntimeTelemetry.record('ux:rage_click', { element: label, count: _clicks.length }); } catch (_) {}
      }
    }
  }

  // ── D) ANONYMOUS HEATMAP ──────────────────────────────────────────────────
  var HM_COLS     = 32;
  var HM_ROWS     = 24;
  var HM_TOTAL    = HM_COLS * HM_ROWS;
  var HM_LS_KEY   = 'iplv_heatmap_v1';
  var HM_MAX_AGE  = 7 * 24 * 3600 * 1000; // 7 days

  var _hmGrid  = new Uint16Array(HM_TOTAL); // live session grid
  var _hmDirty = false;

  function _loadHm() {
    try {
      var raw = JSON.parse(localStorage.getItem(HM_LS_KEY) || 'null');
      if (!raw || !raw.grid || raw.grid.length !== HM_TOTAL) return;
      if (Date.now() - (raw.ts || 0) > HM_MAX_AGE) return; // expired
      for (var i = 0; i < HM_TOTAL; i++) {
        _hmGrid[i] = raw.grid[i] || 0;
      }
    } catch (_) {}
  }

  function _saveHm() {
    if (!_hmDirty) return;
    try {
      var arr = [];
      for (var i = 0; i < HM_TOTAL; i++) arr.push(_hmGrid[i]);
      localStorage.setItem(HM_LS_KEY, JSON.stringify({ grid: arr, ts: Date.now(), cols: HM_COLS, rows: HM_ROWS }));
      _hmDirty = false;
    } catch (_) {}
  }

  function _recordHmClick(e) {
    var vw = G.innerWidth  || 1;
    var vh = G.innerHeight || 1;
    var x  = e.clientX || 0;
    var y  = e.clientY || 0;
    var col = Math.min(HM_COLS - 1, Math.floor((x / vw) * HM_COLS));
    var row = Math.min(HM_ROWS - 1, Math.floor((y / vh) * HM_ROWS));
    var idx = row * HM_COLS + col;
    if (_hmGrid[idx] < 65535) { _hmGrid[idx]++; _hmDirty = true; }
  }

  // Persist heatmap periodically and on hide
  setInterval(function () { if (_hmDirty) _saveHm(); }, 10000);
  G.addEventListener('pagehide', _saveHm, { passive: true });

  // ── E) DEVICE ANALYTICS ───────────────────────────────────────────────────
  var _deviceProfile = null;

  function _buildDeviceProfile() {
    var ua    = navigator.userAgent || '';
    var conn  = _s(function () { return navigator.connection || navigator.mozConnection || navigator.webkitConnection; });
    var w     = G.screen && G.screen.width  || 0;
    var h     = G.screen && G.screen.height || 0;
    var dpr   = G.devicePixelRatio || 1;

    var browser = 'unknown';
    if (/Chrome/.test(ua) && !/Chromium|Edge|OPR/.test(ua)) browser = 'chrome';
    else if (/Firefox/.test(ua)) browser = 'firefox';
    else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'safari';
    else if (/Edge/.test(ua) || /Edg\//.test(ua)) browser = 'edge';
    else if (/OPR/.test(ua)) browser = 'opera';

    var deviceType = 'desktop';
    if (/iPhone|iPad/.test(ua)) deviceType = 'ios';
    else if (/Android/.test(ua)) deviceType = 'android';
    else if (/Mobile|Tablet/.test(ua)) deviceType = 'mobile';

    var tz = _s(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }, '');
    // Extract continent/region from tz for approximate geo (NO city-level data)
    var region = _s(function () {
      var part = tz.split('/')[0] || '';
      return part.toLowerCase();
    }, '');

    return {
      browser:     browser,
      deviceType:  deviceType,
      screenW:     w,
      screenH:     h,
      dpr:         Math.round(dpr * 10) / 10,
      touchPoints: navigator.maxTouchPoints || 0,
      connType:    _s(function () { return conn && conn.effectiveType; }, 'unknown'),
      memory:      _s(function () { return navigator.deviceMemory || 0; }, 0),
      cores:       _s(function () { return navigator.hardwareConcurrency || 0; }, 0),
      region:      region, // continent-level only, e.g. 'america', 'europe', 'asia'
    };
  }

  function _sendDeviceProfile() {
    if (!G.RuntimeAnalytics) return;
    var dp = _deviceProfile || (_deviceProfile = _buildDeviceProfile());
    try {
      G.RuntimeAnalytics.track('session:device_profile', {
        extra: {
          browser:   dp.browser,
          device:    dp.deviceType,
          screen:    dp.screenW + 'x' + dp.screenH,
          dpr:       dp.dpr,
          conn:      dp.connType,
          mem:       dp.memory,
          cores:     dp.cores,
          region:    dp.region,
        },
      });
    } catch (_) {}
  }

  // ── F) SLOW PROCESSING DETECTOR ───────────────────────────────────────────
  var SLOW_THRESHOLD_MS = 8000; // tasks > 8 s are "slow"
  var _taskStartMap = {};       // spanId → { slug, ts }

  function _hookSlowDetect() {
    if (!G.RuntimeTelemetry || !G.RuntimeTelemetry.onEvent) return;
    G.RuntimeTelemetry.onEvent(function (ev) {
      var n   = ev.name || '';
      var d   = ev.data || {};

      if (n === 'task:started') {
        var sid = d.spanId || d.taskId || (Date.now() + Math.random());
        _taskStartMap[sid] = { slug: d.toolId || d.slug, ts: Date.now() };
        return;
      }
      if (n === 'task:completed' || n === 'task:failed') {
        var keys = Object.keys(_taskStartMap);
        if (!keys.length) return;
        // Match by slug or use oldest pending
        var match = null;
        var targetSlug = d.toolId || d.slug;
        for (var i = 0; i < keys.length; i++) {
          if (!targetSlug || _taskStartMap[keys[i]].slug === targetSlug) {
            match = _taskStartMap[keys[i]];
            delete _taskStartMap[keys[i]];
            break;
          }
        }
        if (!match) return;
        var dur = Date.now() - match.ts;
        if (dur > SLOW_THRESHOLD_MS && G.RuntimeAnalytics) {
          try {
            G.RuntimeAnalytics.track('perf:slow_processing', {
              tool_id: match.slug,
              extra:   { durationMs: dur, outcome: n === 'task:failed' ? 'fail' : 'ok' },
            });
          } catch (_) {}
        }
      }
    });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function _init() {
    _loadHm();
    _hookTelemetry();
    _hookDownload();
    _hookSlowDetect();
    _detectInitialStep();

    // Record popularity for current tool slug
    var slug = (G.location && G.location.pathname || '/').replace(/^\//, '').split('/')[0];
    if (slug && slug !== 'index.html' && slug !== '') {
      _recordToolVisit(slug);
    }

    // Device profile after 2 s (avoids extra work during critical path)
    setTimeout(_sendDeviceProfile, 2000);

    // Rage click + heatmap listeners
    document.addEventListener('click',     _handleClick,   { passive: true });
    document.addEventListener('click',     _recordHmClick, { passive: true });
    document.addEventListener('touchstart',_handleClick,   { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  G.RuntimeSessionIntel = {
    getFunnel:        function () { return _funnel.slice(); },
    getTopTools:      getTopTools,
    getHeatmap:       function () { return { grid: _hmGrid, cols: HM_COLS, rows: HM_ROWS }; },
    getDeviceProfile: function () { return _deviceProfile || (_deviceProfile = _buildDeviceProfile()); },
    resetSession:     function () { _funnel.length = 0; _clicks.length = 0; },
    recordFunnel:     _recordFunnel, // allow external callers to emit funnel steps
  };

  console.debug(LOG, 'RuntimeSessionIntel v1.0 ready');

}(window));
