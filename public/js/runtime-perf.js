// RuntimePerf v1.0 — Phase 26E-F
// Core Web Vitals monitoring + FPS + JS heap + long tasks + worker latency.
// Admin floating widget (Ctrl+Shift+P, admin-only).
// Exposes perf data to RuntimeDashboard when available.
//
// Tracks:
//   LCP  — Largest Contentful Paint (good < 2500ms)
//   FCP  — First Contentful Paint   (good < 1800ms)
//   CLS  — Cumulative Layout Shift  (good < 0.1)
//   INP  — Interaction to Next Paint (good < 200ms)
//   FID  — First Input Delay         (good < 100ms)
//   TTFB — Time to First Byte        (good < 800ms)
//   LT   — Long tasks (>50ms)
//   FPS  — estimated frames per second
//   Heap — JS heap usage (Chrome only)
//   WL   — estimated worker round-trip latency
//
// Exposed as: window.RuntimePerf

(function (G) {
  'use strict';

  if (G.RuntimePerf) return;

  var VERSION = '1.0';
  var LOG     = '[RP26]';

  // ── Thresholds (Core Web Vitals) ──────────────────────────────────────────
  var THRESHOLDS = {
    lcp:  { good: 2500,  poor: 4000  },   // ms
    fcp:  { good: 1800,  poor: 3000  },   // ms
    cls:  { good: 0.1,   poor: 0.25  },   // unitless
    inp:  { good: 200,   poor: 500   },   // ms
    fid:  { good: 100,   poor: 300   },   // ms
    ttfb: { good: 800,   poor: 1800  },   // ms
  };

  function _rating(metric, value) {
    if (value === null || value === undefined) return 'unknown';
    var t = THRESHOLDS[metric];
    if (!t) return 'unknown';
    if (value <= t.good) return 'good';
    if (value <= t.poor) return 'needs-improvement';
    return 'poor';
  }

  // ── Vitals storage ─────────────────────────────────────────────────────────
  var _vitals = {
    lcp:  null,
    fcp:  null,
    cls:  0,        // cumulative
    inp:  null,
    fid:  null,
    ttfb: null,
  };

  var _longTasks    = [];  // [{ start, duration }]
  var _MAX_LT_LOG   = 50;
  var _fps          = 0;
  var _heap         = null; // { used, total, limit } in MB
  var _workerLatency= null; // ms
  var _subs         = new Set();

  function _emit() {
    _subs.forEach(function (fn) { try { fn(_vitals, _fps, _heap); } catch (_) {} });
  }

  // ── PerformanceObserver — LCP ──────────────────────────────────────────────
  function _observeLCP() {
    if (!('PerformanceObserver' in window)) return;
    try {
      var obs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        if (entries.length) {
          _vitals.lcp = entries[entries.length - 1].startTime;
          _emit();
        }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
  }

  // ── PerformanceObserver — CLS ──────────────────────────────────────────────
  function _observeCLS() {
    if (!('PerformanceObserver' in window)) return;
    try {
      var obs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (!e.hadRecentInput) { _vitals.cls += e.value; }
        });
        _vitals.cls = Math.round(_vitals.cls * 1000) / 1000;
        _emit();
      });
      obs.observe({ type: 'layout-shift', buffered: true });
    } catch (_) {}
  }

  // ── PerformanceObserver — FID / INP ───────────────────────────────────────
  function _observeInteraction() {
    if (!('PerformanceObserver' in window)) return;
    // INP via long-animation-frame (Chrome 116+)
    try {
      var obs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.processingStart) {
            var delay = e.processingStart - e.startTime;
            if (_vitals.inp === null || delay > _vitals.inp) {
              _vitals.inp = Math.round(delay);
            }
          }
        });
        _emit();
      });
      obs.observe({ type: 'event', buffered: true, durationThreshold: 40 });
    } catch (_) {}
    // FID via first-input
    try {
      var obs2 = new PerformanceObserver(function (list) {
        var e = list.getEntries()[0];
        if (e && _vitals.fid === null) {
          _vitals.fid = Math.round(e.processingStart - e.startTime);
          _emit();
        }
      });
      obs2.observe({ type: 'first-input', buffered: true });
    } catch (_) {}
  }

  // ── PerformanceObserver — long tasks ──────────────────────────────────────
  function _observeLongTasks() {
    if (!('PerformanceObserver' in window)) return;
    try {
      var obs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          _longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
          if (_longTasks.length > _MAX_LT_LOG) _longTasks.shift();
        });
      });
      obs.observe({ type: 'longtask', buffered: true });
    } catch (_) {}
  }

  // ── FCP from paint entries ─────────────────────────────────────────────────
  function _measureFCP() {
    try {
      var paints = performance.getEntriesByType('paint');
      for (var i = 0; i < paints.length; i++) {
        if (paints[i].name === 'first-contentful-paint') {
          _vitals.fcp = Math.round(paints[i].startTime);
          return;
        }
      }
      // Fallback: PerformanceObserver
      if ('PerformanceObserver' in window) {
        var obs = new PerformanceObserver(function (list) {
          var entries = list.getEntriesByName('first-contentful-paint');
          if (entries.length) { _vitals.fcp = Math.round(entries[0].startTime); _emit(); }
        });
        obs.observe({ type: 'paint', buffered: true });
      }
    } catch (_) {}
  }

  // ── TTFB from navigation timing ───────────────────────────────────────────
  function _measureTTFB() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) { _vitals.ttfb = Math.round(nav.responseStart - nav.requestStart); }
    } catch (_) {}
  }

  // ── FPS estimation (RAF-based) ─────────────────────────────────────────────
  var _frameCount = 0;
  var _fpsT0      = performance.now();
  var _rafHandle  = null;
  var _fpsRunning = false;

  function _rafLoop(now) {
    _frameCount++;
    var elapsed = now - _fpsT0;
    if (elapsed >= 1000) {
      _fps = Math.round((_frameCount / elapsed) * 1000);
      _frameCount = 0;
      _fpsT0 = now;
    }
    if (_fpsRunning) _rafHandle = requestAnimationFrame(_rafLoop);
  }

  function _startFPS() {
    if (_fpsRunning) return;
    _fpsRunning = true;
    _rafHandle  = requestAnimationFrame(_rafLoop);
  }

  function _stopFPS() {
    _fpsRunning = false;
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
  }

  // ── Heap polling (Chrome only) ─────────────────────────────────────────────
  function _measureHeap() {
    try {
      var pm = performance.memory;
      if (!pm) return;
      var MB = 1024 * 1024;
      _heap = {
        used:  Math.round(pm.usedJSHeapSize  / MB),
        total: Math.round(pm.totalJSHeapSize / MB),
        limit: Math.round(pm.jsHeapSizeLimit / MB),
        pct:   Math.round((pm.usedJSHeapSize / pm.jsHeapSizeLimit) * 100),
      };
    } catch (_) {}
  }

  setInterval(function () { _measureHeap(); _emit(); }, 5000);

  // ── Worker latency ping ────────────────────────────────────────────────────
  function _measureWorkerLatency() {
    try {
      var blob = new Blob([
        'self.onmessage=function(e){if(e.data==="ping")postMessage("pong");}',
      ], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      var w   = new Worker(url);
      var t0  = performance.now();
      w.onmessage = function () {
        _workerLatency = Math.round(performance.now() - t0);
        w.terminate();
        URL.revokeObjectURL(url);
        _emit();
      };
      w.postMessage('ping');
    } catch (_) {}
  }

  // ── Layout Stability Engine ────────────────────────────────────────────────
  // Injects CSS to reduce CLS: reserve dimensions on common dynamic elements.
  function _injectLayoutStability() {
    if (document.getElementById('iplv-layout-stable')) return;
    var s = document.createElement('style');
    s.id = 'iplv-layout-stable';
    s.textContent = [
      /* Reserve space for tool cards during lazy load */
      'a.tool:not([data-loaded]){min-height:80px;}',
      /* Skeleton shimmer for card loading states */
      '.tool-card-loading{',
        'background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);',
        'background-size:200% 100%;',
        'animation:iplv-shimmer 1.5s infinite;}',
      '@keyframes iplv-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      /* Font stabilization — prevent FOUT shifts */
      '@font-face{font-family:Inter;font-display:swap;}',
      /* Image dimension reservation — prevent CLS from images without dimensions */
      'img[loading="lazy"]:not([width]):not([height]){aspect-ratio:16/9;width:100%;}',
      /* Dynamic card min-heights to prevent collapse during load */
      '.blog-card:empty,.tool-card:empty{min-height:120px;}',
      /* Prevent animation-caused CLS */
      '@media(prefers-reduced-motion:reduce){',
        '.iplv-cl-panel,#iplv-update-toast,#iplv-offline-bar{transition:none!important;animation:none!important;}',
      '}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Admin widget ───────────────────────────────────────────────────────────
  var _widgetEl = null;
  var _widgetVisible = false;

  var RATING_COLOR = { good: '#10b981', 'needs-improvement': '#f59e0b', poor: '#ef4444', unknown: '#6b7280' };

  function _fmt(v, unit, decimals) {
    if (v === null || v === undefined) return 'n/a';
    return (decimals !== undefined ? v.toFixed(decimals) : v) + (unit || '');
  }

  function _buildWidgetContent() {
    var v = _vitals;
    var rows = [
      { label: 'LCP',  val: _fmt(v.lcp,  'ms'), rating: _rating('lcp',  v.lcp)  },
      { label: 'FCP',  val: _fmt(v.fcp,  'ms'), rating: _rating('fcp',  v.fcp)  },
      { label: 'CLS',  val: _fmt(v.cls,  '',  3), rating: _rating('cls',  v.cls)  },
      { label: 'INP',  val: _fmt(v.inp,  'ms'), rating: _rating('inp',  v.inp)  },
      { label: 'FID',  val: _fmt(v.fid,  'ms'), rating: _rating('fid',  v.fid)  },
      { label: 'TTFB', val: _fmt(v.ttfb, 'ms'), rating: _rating('ttfb', v.ttfb) },
      { label: 'FPS',  val: _fps + ' fps',       rating: _fps >= 50 ? 'good' : _fps >= 30 ? 'needs-improvement' : 'poor' },
      { label: 'Heap', val: _heap ? _heap.used + '/' + _heap.total + ' MB' : 'n/a', rating: _heap && _heap.pct < 70 ? 'good' : _heap && _heap.pct < 90 ? 'needs-improvement' : 'poor' },
      { label: 'WL',   val: _fmt(_workerLatency, 'ms'), rating: _workerLatency !== null ? (_workerLatency < 5 ? 'good' : _workerLatency < 20 ? 'needs-improvement' : 'poor') : 'unknown' },
      { label: 'LT',   val: _longTasks.length + ' tasks', rating: _longTasks.length < 5 ? 'good' : _longTasks.length < 15 ? 'needs-improvement' : 'poor' },
    ];
    return rows;
  }

  function _renderWidget() {
    if (!_widgetEl) return;
    var rows = _buildWidgetContent();
    var html = '<div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;letter-spacing:.05em;">CORE WEB VITALS</div>';
    rows.forEach(function (r) {
      var dot = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + RATING_COLOR[r.rating] + ';margin-right:6px;flex-shrink:0;"></span>';
      html += '<div style="display:flex;align-items:center;gap:0;margin-bottom:5px;">' +
        dot +
        '<span style="width:38px;font-size:11px;color:#8b949e;">' + r.label + '</span>' +
        '<span style="font-size:11px;color:#e2e8f0;font-weight:500;">' + r.val + '</span>' +
        '</div>';
    });
    // AI scheduler stats if available
    var ais = G.RuntimeAIScheduler;
    if (ais) {
      var qt = ais.getTelemetry();
      html += '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:8px 0;">' +
        '<div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;">AI SCHEDULER</div>' +
        '<div style="font-size:11px;color:#8b949e;">GPU ratio: <b style="color:#e2e8f0">' + Math.round(qt.gpuRatio * 100) + '%</b></div>' +
        '<div style="font-size:11px;color:#8b949e;">Avg inf: <b style="color:#e2e8f0">' + qt.avgInferenceMs + 'ms</b></div>' +
        '<div style="font-size:11px;color:#8b949e;">Total tasks: <b style="color:#e2e8f0">' + qt.total + '</b></div>';
    }
    // Recovery stats if available
    var rr = G.RuntimeRecovery;
    if (rr) {
      var rs = rr.getStats();
      html += '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:8px 0;">' +
        '<div style="font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;">RECOVERY</div>' +
        '<div style="font-size:11px;color:#8b949e;">Errors: <b style="color:#e2e8f0">' + rs.errorCount + '</b></div>' +
        '<div style="font-size:11px;color:#8b949e;">Watchdog: <b style="color:' + (rs.watchdog ? '#10b981' : '#ef4444') + '">' + (rs.watchdog ? 'active' : 'off') + '</b></div>';
    }
    _widgetEl.querySelector('#iplv-perf-body').innerHTML = html;
  }

  function _buildWidget() {
    if (_widgetEl) return;
    var el = document.createElement('div');
    el.id = 'iplv-perf-widget';
    el.style.cssText = [
      'position:fixed',
      'top:60px',
      'right:16px',
      'z-index:2147483630',
      'background:#0d1117',
      'border:1px solid rgba(255,255,255,0.1)',
      'border-radius:12px',
      'padding:14px 16px',
      'width:210px',
      'font-family:Inter,-apple-system,sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
      'display:' + (_widgetVisible ? 'block' : 'none'),
    ].join(';');

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    var title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:700;color:#f0f6fc;';
    title.textContent = 'Runtime Perf';
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:transparent;border:none;color:#6e7681;font-size:16px;cursor:pointer;padding:0;line-height:1;';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { RuntimePerf.hideWidget(); });
    header.appendChild(title);
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.id = 'iplv-perf-body';

    el.appendChild(header);
    el.appendChild(body);
    document.body.appendChild(el);
    _widgetEl = el;
    _renderWidget();

    // Auto-update every 2s
    setInterval(function () {
      if (_widgetVisible) _renderWidget();
    }, 2000);
  }

  // ── Keyboard shortcut Ctrl+Shift+P (admin only) ────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (!G.__IPLV_ADMIN_RUNTIME__) return;
    if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p' || e.keyCode === 80)) {
      e.preventDefault();
      RuntimePerf.toggleWidget();
    }
  });

  // ── Feed metrics into RuntimeDashboard ────────────────────────────────────
  function _feedDashboard() {
    try {
      var dash = G.RuntimeDashboard;
      if (!dash || !dash.getMetrics) return;
      var m = dash.getMetrics();
      if (m) {
        m._perf = {
          lcp:  _vitals.lcp,
          fcp:  _vitals.fcp,
          cls:  _vitals.cls,
          fps:  _fps,
          heap: _heap,
          longTasks: _longTasks.length,
        };
      }
    } catch (_) {}
  }

  setInterval(_feedDashboard, 5000);

  // ── Init ────────────────────────────────────────────────────────────────────
  function _init() {
    _measureFCP();
    _measureTTFB();
    _observeLCP();
    _observeCLS();
    _observeInteraction();
    _observeLongTasks();
    _startFPS();
    _measureHeap();
    _injectLayoutStability();
    setTimeout(_measureWorkerLatency, 2000);
    // Pause FPS tracking when tab is hidden
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) _stopFPS();
      else _startFPS();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimePerf = {
    VERSION: VERSION,

    getVitals:        function () { return Object.assign({}, _vitals); },
    getFPS:           function () { return _fps; },
    getHeap:          function () { return _heap ? Object.assign({}, _heap) : null; },
    getLongTasks:     function () { return _longTasks.slice(-20); },
    getWorkerLatency: function () { return _workerLatency; },

    getRatings: function () {
      var out = {};
      Object.keys(_vitals).forEach(function (k) { out[k] = _rating(k, _vitals[k]); });
      return out;
    },

    subscribe: function (fn) { _subs.add(fn); return function () { _subs.delete(fn); }; },

    showWidget: function () {
      _widgetVisible = true;
      if (!_widgetEl) _buildWidget();
      else _widgetEl.style.display = 'block';
      _renderWidget();
    },

    hideWidget: function () {
      _widgetVisible = false;
      if (_widgetEl) _widgetEl.style.display = 'none';
    },

    toggleWidget: function () {
      if (_widgetVisible) this.hideWidget();
      else this.showWidget();
    },

    audit: function () {
      var report = {
        version:    VERSION,
        vitals:     this.getVitals(),
        ratings:    this.getRatings(),
        fps:        _fps,
        heap:       _heap,
        longTasks:  _longTasks.slice(-10),
        workerLatency: _workerLatency,
      };
      console.group(LOG + ' RuntimePerf v' + VERSION + ' audit');
      console.table(
        Object.keys(report.vitals).map(function (k) {
          return { metric: k.toUpperCase(), value: report.vitals[k], rating: report.ratings[k] };
        })
      );
      console.log('FPS:', _fps, '| Heap:', _heap, '| Worker Latency:', _workerLatency + 'ms');
      console.log('Long tasks:', _longTasks.length, '(last 10):', _longTasks.slice(-10));
      console.groupEnd();
      return report;
    },
  };

  G.RuntimePerf = RuntimePerf;
  console.debug(LOG, 'RuntimePerf v' + VERSION + ' ready — Ctrl+Shift+P for widget (admin)');

}(window));
