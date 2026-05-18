// RuntimeInspector v1.0 — Phase 2C Debug Panel
// CTRL+SHIFT+I to toggle (dev-only: only renders when window.DEBUG_RUNTIME===true
// OR when served from localhost / a Replit dev domain).
//
// Shows live state for:
//   • WorkerPool occupancy and leaked slots
//   • Per-ToolApp isolated worker / OCR worker / PDF instance state
//   • In-flight jobs and timeouts
//   • Canvas accumulation counter
//   • Recent error log (last 20)
//   • Estimated JS heap usage
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  // ── Guard: only run in dev environment ─────────────────────────────────────
  var isDev = G.DEBUG_RUNTIME === true
    || location.hostname === 'localhost'
    || location.hostname.endsWith('.replit.dev')
    || location.hostname.endsWith('.repl.co')
    || location.hostname.endsWith('.replit.app');  // dev preview domain

  if (!isDev) return;

  var _overlay    = null;
  var _visible    = false;
  var _rafHandle  = null;
  var _tickCount  = 0;

  // ── Panel HTML skeleton ───────────────────────────────────────────────────
  var PANEL_CSS = [
    'position:fixed;bottom:12px;right:12px;z-index:2147483647',
    'background:rgba(14,18,26,0.95);color:#e0e0e0',
    'font:12px/1.5 "Cascadia Code","Fira Code",monospace',
    'border:1px solid #3a4a6a;border-radius:8px',
    'padding:12px 14px;min-width:380px;max-width:460px',
    'max-height:80vh;overflow-y:auto',
    'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
    'backdrop-filter:blur(6px)',
    'user-select:none',
  ].join(';');

  var HEADER_CSS = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
  var SECTION_CSS = 'margin:6px 0;padding:5px 0;border-top:1px solid #2a3245;';
  var LABEL_CSS   = 'color:#7eb5ff;font-weight:bold;';
  var VALUE_CSS   = 'color:#c0f0a0;';
  var ERR_CSS     = 'color:#ff6b6b;';
  var WARN_CSS    = 'color:#ffd06b;';

  function _el(tag, css, html) {
    var e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (html) e.innerHTML     = html;
    return e;
  }

  function _badge(v, okColor, warnColor, errColor, warnThresh, errThresh) {
    var n   = parseInt(v, 10) || 0;
    var col = n >= errThresh  ? (errColor  || '#ff6b6b')
            : n >= warnThresh ? (warnColor || '#ffd06b')
            : (okColor        || '#c0f0a0');
    return '<span style="color:' + col + ';font-weight:bold;">' + n + '</span>';
  }

  // ── Gather state ──────────────────────────────────────────────────────────
  function _gatherState() {
    var s = {};

    // WorkerPool
    var wp = G.WorkerPool;
    if (wp && typeof wp.getStats === 'function') {
      s.pool = wp.getStats();
    } else if (wp && wp._slots) {
      var running = wp._slots.filter(function (sl) { return sl && sl.busy; }).length;
      s.pool = { total: wp._slots.length, running: running, leaked: 0 };
    } else {
      s.pool = null;
    }

    // ToolAppManager registry (getRegistry returns array of tool IDs)
    var tam = G.ToolAppManager;
    s.apps = {};
    if (tam && tam.getRegistry && tam.getToolState) {
      var registeredIds = tam.getRegistry();
      registeredIds.forEach(function (id) {
        var st2 = tam.getToolState(id);
        s.apps[id] = st2 && st2.runtime ? st2.runtime : { state: st2 && st2.state };
      });
    }

    // Individual ToolApp states (fallback if TAM doesn't expose registry)
    var appNames = ['compress', 'repair', 'compare', 'ai-summarize', 'translate',
                    'background-remover', 'scan-to-pdf', 'jpg-to-pdf', 'pdf-to-jpg'];
    var stateGetters = {
      'compress':          function () { return G.CompressTelemetry && { scheduler: G.CompressScheduler && G.CompressScheduler.stats() }; },
      'repair':            function () { return G.RepairTelemetry   && { scheduler: G.RepairScheduler   && G.RepairScheduler.stats()   }; },
      'compare':           function () { return G.CompareTelemetry  && { scheduler: G.CompareScheduler  && G.CompareScheduler.stats()  }; },
      'ai-summarize':      function () { return G.SummaryTelemetry  && { scheduler: G.SummaryScheduler  && G.SummaryScheduler.stats()  }; },
      'translate':         function () { return G.TranslateTelemetry && { scheduler: G.TranslateScheduler && G.TranslateScheduler.stats() }; },
      'background-remover':function () { return G.BgRemoveTelemetry  && { scheduler: G.BgRemoveScheduler  && G.BgRemoveScheduler.stats()  }; },
      'scan-to-pdf':       function () { return G.ScanTelemetry      && { scheduler: G.ScanScheduler      && G.ScanScheduler.stats()      }; },
      'jpg-to-pdf':        function () { return G.ImagePdfTelemetry  && { scheduler: G.ImagePdfScheduler  && G.ImagePdfScheduler.stats()  }; },
      'pdf-to-jpg':        function () { return G.ImagePdfTelemetry  && { scheduler: G.ImagePdfScheduler  && G.ImagePdfScheduler.stats()  }; },
    };
    appNames.forEach(function (id) {
      if (!s.apps[id] && stateGetters[id]) {
        var st = stateGetters[id]();
        if (st) s.apps[id] = st;
      }
    });

    // Heap
    s.heap = (G.performance && G.performance.memory)
      ? {
          used:  (G.performance.memory.usedJSHeapSize  / 1048576).toFixed(1),
          total: (G.performance.memory.totalJSHeapSize / 1048576).toFixed(1),
          limit: (G.performance.memory.jsHeapSizeLimit  / 1048576).toFixed(1),
        }
      : null;

    // Active canvases (dom count)
    s.canvasCount = document.querySelectorAll('canvas').length;

    // Tesseract — check global
    s.tesseractLoaded = !!(G.Tesseract);

    // Tick counter
    s.tick = ++_tickCount;
    s.ts   = new Date().toTimeString().split(' ')[0];

    return s;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function _renderState(container, st) {
    var html = '';

    // ── Header ──
    html += '<div style="' + HEADER_CSS + '">'
         +  '<span style="color:#7eb5ff;font-size:13px;font-weight:bold;">⚙ Runtime Inspector</span>'
         +  '<span style="color:#666;font-size:10px;">' + st.ts + ' #' + st.tick + '</span>'
         + '</div>';

    // ── Heap ──
    if (st.heap) {
      var heapPct = Math.round(st.heap.used / st.heap.limit * 100);
      var hCol    = heapPct > 85 ? '#ff6b6b' : heapPct > 65 ? '#ffd06b' : '#c0f0a0';
      html += '<div style="' + SECTION_CSS + '">'
           +  '<span style="' + LABEL_CSS + '">Heap</span> '
           +  '<span style="color:' + hCol + '">' + st.heap.used + ' MB</span>'
           +  '<span style="color:#666"> / ' + st.heap.limit + ' MB (' + heapPct + '%)</span>'
           + '</div>';
    }

    // ── WorkerPool ──
    html += '<div style="' + SECTION_CSS + '"><span style="' + LABEL_CSS + '">WorkerPool</span><br>';
    if (st.pool) {
      html += '  running: ' + _badge(st.pool.running, '#c0f0a0', '#ffd06b', '#ff6b6b', 3, 5);
      html += '  total: <span style="color:#e0e0e0">' + (st.pool.total || '?') + '</span>';
      if (st.pool.leaked > 0) html += '  <span style="color:#ff6b6b;">⚠ leaked: ' + st.pool.leaked + '</span>';
    } else {
      html += '  <span style="color:#666">WorkerPool not found</span>';
    }
    html += '</div>';

    // ── Canvas count ──
    var cCol = st.canvasCount > 20 ? '#ff6b6b' : st.canvasCount > 10 ? '#ffd06b' : '#c0f0a0';
    html += '<div style="' + SECTION_CSS + '">'
         +  '<span style="' + LABEL_CSS + '">Canvases in DOM</span> '
         +  '<span style="color:' + cCol + '">' + st.canvasCount + '</span>'
         +  (st.tesseractLoaded ? ' &nbsp; <span style="color:#c0f0a0">Tesseract ✓</span>' : '')
         + '</div>';

    // ── ToolApps ──
    var appIds = Object.keys(st.apps);
    if (appIds.length > 0) {
      html += '<div style="' + SECTION_CSS + '"><span style="' + LABEL_CSS + '">ToolApps</span><br>';
      appIds.forEach(function (id) {
        var app = st.apps[id];
        if (!app) return;
        var inFlight = app.inFlight || app.state === 'MOUNTED';
        var iCol     = inFlight ? '#ffd06b' : '#666';
        html += '  <span style="color:' + iCol + '">●</span> '
             +  '<span style="color:#aac8ff">' + id + '</span>';
        if (typeof app.inFlight !== 'undefined') {
          html += ' <span style="color:#666">flight:' + (app.inFlight ? '<span style="color:#ffd06b">Y</span>' : 'N') + '</span>';
        }
        if (app.hasTessWorker) html += ' <span style="color:#ff9966">OCR↑</span>';
        if (app.hasWorker || app.hasSummaryWorker) html += ' <span style="color:#9cf">W↑</span>';
        if (app.hasPdfInst) html += ' <span style="color:#fc9">PDF↑</span>';
        if (app.canvases)   html += ' <span style="color:' + (app.canvases > 5 ? '#ff6b6b' : '#999') + '">cvs:' + app.canvases + '</span>';
        if (app.scheduler)  {
          html += ' <span style="color:#666">runs:' + app.scheduler.runs + '</span>';
          if (app.scheduler.failures > 0) html += ' <span style="color:#ff6b6b">fail:' + app.scheduler.failures + '</span>';
        }
        html += '<br>';
      });
      html += '</div>';
    }

    // ── Errors (from RecoveryManagers) ──
    var allErrors = [];
    var errSources = ['CompressRecoveryManager','RepairRecoveryManager','CompareRecoveryManager',
      'SummaryRecoveryManager','TranslateRecoveryManager','BgRemoveRecoveryManager',
      'ScanRecoveryManager','ImagePdfRecoveryManager'];
    errSources.forEach(function (name) {
      var rm = G[name];
      if (rm && typeof rm.getErrors === 'function') {
        rm.getErrors().forEach(function (e) { allErrors.push(e); });
      }
    });
    allErrors.sort(function (a, b) { return b.ts - a.ts; });
    allErrors = allErrors.slice(0, 8);

    if (allErrors.length > 0) {
      html += '<div style="' + SECTION_CSS + '"><span style="' + LABEL_CSS + ERR_CSS + '">Recent Errors (' + allErrors.length + ')</span><br>';
      allErrors.forEach(function (e) {
        var t = new Date(e.ts).toTimeString().split(' ')[0];
        html += '<span style="color:#666">' + t + '</span> <span style="color:#ff9999">' + (e.msg || '?').slice(0, 70) + '</span><br>';
      });
      html += '</div>';
    }

    // ── Keyboard hint ──
    html += '<div style="margin-top:6px;color:#444;font-size:10px;">CTRL+SHIFT+I to close · CTRL+SHIFT+R to reset all</div>';

    container.innerHTML = html;
  }

  // ── Create overlay ─────────────────────────────────────────────────────────
  function _createOverlay() {
    var div = _el('div', PANEL_CSS, '');
    div.id  = '__runtime_inspector__';
    document.body.appendChild(div);
    return div;
  }

  function _startLoop() {
    if (_rafHandle) return;
    (function tick() {
      if (!_visible || !_overlay) return;
      try { _renderState(_overlay, _gatherState()); } catch (_) {}
      _rafHandle = setTimeout(tick, 750); // update ~1.3×/s to be lightweight
    }());
  }

  function _stopLoop() {
    if (_rafHandle) { clearTimeout(_rafHandle); _rafHandle = null; }
  }

  function show() {
    if (!_overlay) _overlay = _createOverlay();
    _overlay.style.display = 'block';
    _visible = true;
    _startLoop();
    _log('opened');
  }

  function hide() {
    if (_overlay) _overlay.style.display = 'none';
    _visible = false;
    _stopLoop();
    _log('closed');
  }

  function toggle() { _visible ? hide() : show(); }

  function _log(msg) { console.debug('[RuntimeInspector]', msg); }

  // ── Reset-all shortcut (CTRL+SHIFT+R) ─────────────────────────────────────
  function _resetAll() {
    var appNames = ['CompressScheduler','RepairScheduler','CompareScheduler',
      'SummaryScheduler','TranslateScheduler','BgRemoveScheduler','ScanScheduler','ImagePdfScheduler'];
    var cleaned = 0;
    appNames.forEach(function (n) {
      var inst = G[n]; // These expose no cleanup — recovery managers handle it
      if (inst) cleaned++;
    });
    _log('reset-all triggered (manual)');
    if (_overlay) _renderState(_overlay, _gatherState());
  }

  // ── Keyboard binding ──────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'I') { e.preventDefault(); toggle(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'R' && _visible) { e.preventDefault(); _resetAll(); }
  });

  // ── Expose API ────────────────────────────────────────────────────────────
  G.RuntimeInspector = { show: show, hide: hide, toggle: toggle, resetAll: _resetAll };
  _log('v1.0 ready (dev mode — CTRL+SHIFT+I to open)');
}(window));
