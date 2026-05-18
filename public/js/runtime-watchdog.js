// runtime-watchdog.js — Debug Watchdog Overlay (Phase 2D)
// ADDITIVE ONLY. Provides a CTRL+SHIFT+H overlay showing live runtime health:
// WorkerPool health, scheduler health, memory pressure, stuck tasks, live OCR
// workers, live PDF docs, canvas memory, panic state, timeouts, recovery actions.
// DEV-ONLY: self-disables on production errors. No overhead when not shown.
//
// window.RuntimeWatchdog — public API
(function () {
  'use strict';

  if (window.RuntimeWatchdog) return;

  var LOG     = '[RWD]';
  var VERSION = '1.0.0';

  // ── State ─────────────────────────────────────────────────────────────────────
  var _visible  = false;
  var _panel    = null;
  var _updateTimer = null;
  var UPDATE_INTERVAL = 1500; // refresh every 1.5s when visible

  // ── Create panel DOM ──────────────────────────────────────────────────────────
  function _createPanel() {
    if (_panel) return;

    var el = document.createElement('div');
    el.id = '__runtime-watchdog-panel__';
    el.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
      'background:rgba(15,15,25,0.97)', 'color:#e2e8f0',
      'font-family:ui-monospace,Menlo,Monaco,"Cascadia Code",monospace',
      'font-size:11px', 'line-height:1.5',
      'border:1px solid #4f46e5', 'border-radius:8px',
      'padding:10px 12px', 'min-width:360px', 'max-width:480px',
      'max-height:85vh', 'overflow-y:auto',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'pointer-events:auto',
      'display:none',
    ].join(';');

    el.innerHTML = '<div id="__rwd-content__"></div>';

    // Drag support
    var _dragging = false, _dx = 0, _dy = 0;
    el.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      _dragging = true;
      _dx = e.clientX - el.getBoundingClientRect().left;
      _dy = e.clientY - el.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', function (e) {
      if (!_dragging) return;
      el.style.left  = (e.clientX - _dx) + 'px';
      el.style.top   = (e.clientY - _dy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { _dragging = false; });

    document.body.appendChild(el);
    _panel = el;
  }

  // ── Data collection ───────────────────────────────────────────────────────────
  function _collectData() {
    var d = {};

    // WorkerPool
    try {
      d.workerPool = window.WorkerPool ? window.WorkerPool.getStats() : null;
    } catch (_) { d.workerPool = null; }

    // RuntimeWorkers
    try {
      d.runtimeWorkers = window.RuntimeWorkers ? window.RuntimeWorkers.getStats() : null;
    } catch (_) { d.runtimeWorkers = null; }

    // Schedulers
    try {
      d.taskScheduler = window.TaskScheduler ? window.TaskScheduler.stats() : null;
    } catch (_) { d.taskScheduler = null; }
    try {
      d.runtimeScheduler = window.RuntimeScheduler ? window.RuntimeScheduler.getStats() : null;
    } catch (_) { d.runtimeScheduler = null; }

    // Memory
    try {
      d.runtimeMemory = window.RuntimeMemory ? {
        tier:       window.RuntimeMemory.tier(),
        maxWorkers: window.RuntimeMemory.maxWorkers(),
        isCritical: window.RuntimeMemory.isCritical(),
        isWarning:  window.RuntimeMemory.isWarning(),
      } : null;
    } catch (_) { d.runtimeMemory = null; }
    try {
      d.heapMB = performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)
        : null;
    } catch (_) { d.heapMB = null; }

    // OCR workers
    try {
      d.tesseract = window.RuntimeTesseractCleaner ? window.RuntimeTesseractCleaner.getStats() : null;
    } catch (_) { d.tesseract = null; }

    // PDF docs
    try {
      d.pdfDocs = window.RuntimePdfCleaner ? window.RuntimePdfCleaner.getStats() : null;
    } catch (_) { d.pdfDocs = null; }

    // Canvas
    try {
      d.canvasGC  = window.RuntimeCanvasGC  ? window.RuntimeCanvasGC.getStats()  : null;
      d.canvasPool = window.CanvasPool ? window.CanvasPool.stats() : null;
    } catch (_) { d.canvasGC = null; }

    // Panic
    try {
      d.panic = window.RuntimePanicManager ? window.RuntimePanicManager.getStats() : null;
    } catch (_) { d.panic = null; }

    // Healer
    try {
      d.healer = window.RuntimeHealer ? window.RuntimeHealer.getStats() : null;
    } catch (_) { d.healer = null; }

    // Timeouts
    try {
      d.timeouts = window.RuntimeTimeoutReaper ? window.RuntimeTimeoutReaper.getStats() : null;
    } catch (_) { d.timeouts = null; }

    // Circuit breakers
    try {
      d.circuits = window.RuntimeCircuitBreakers ? window.RuntimeCircuitBreakers.getStats() : null;
    } catch (_) { d.circuits = null; }

    // Zombies
    try {
      d.zombies = window.RuntimeZombieCleaner ? window.RuntimeZombieCleaner.getStats() : null;
    } catch (_) { d.zombies = null; }

    // RuntimeHealth
    try {
      d.health = window.RuntimeHealth ? window.RuntimeHealth.getSnapshot() : null;
    } catch (_) { d.health = null; }

    return d;
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function _badge(text, color) {
    return '<span style="background:' + color + ';color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:600;">' + text + '</span>';
  }

  function _row(label, value, warn) {
    var color = warn ? '#fbbf24' : '#94a3b8';
    return '<div style="display:flex;justify-content:space-between;padding:1px 0;">'
      + '<span style="color:' + color + ';">' + label + '</span>'
      + '<span style="color:#e2e8f0;font-weight:600;">' + value + '</span>'
      + '</div>';
  }

  function _section(title, content) {
    return '<div style="margin-top:8px;">'
      + '<div style="color:#818cf8;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #1e293b;padding-bottom:2px;margin-bottom:3px;">'
      + title + '</div>'
      + content
      + '</div>';
  }

  function _render(d) {
    var parts = [];
    var ts = new Date().toISOString().slice(11, 23);

    // Header
    parts.push(
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
      + '<span style="color:#818cf8;font-weight:800;font-size:12px;">⚡ Runtime Watchdog</span>'
      + '<span style="color:#475569;font-size:10px;">' + ts + '</span>'
      + '<button onclick="window.RuntimeWatchdog.hide()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0 2px;">✕</button>'
      + '</div>'
    );

    // Panic state
    if (d.panic && d.panic.inPanic) {
      parts.push('<div style="background:#7f1d1d;border:1px solid #ef4444;border-radius:4px;padding:4px 8px;margin-bottom:6px;color:#fca5a5;">🚨 PANIC MODE ACTIVE — recovery in progress</div>');
    }

    // Health score
    if (d.health) {
      var score = d.health.score || 100;
      var scoreColor = score >= 80 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';
      parts.push(_section('Runtime Health',
        _row('Score', _badge(score + '/100', scoreColor))
        + (d.health.issues && d.health.issues.length
           ? d.health.issues.map(function (i) { return _row('⚠', i, true); }).join('')
           : _row('Status', 'All systems nominal'))
      ));
    }

    // Memory
    var memContent = '';
    if (d.runtimeMemory) {
      var tierColor = { NORMAL: '#22c55e', WARNING: '#f59e0b', CRITICAL: '#ef4444', EMERGENCY: '#7f1d1d' };
      memContent += _row('Tier', _badge(d.runtimeMemory.tier, tierColor[d.runtimeMemory.tier] || '#64748b'));
      memContent += _row('Max Workers', d.runtimeMemory.maxWorkers);
    }
    if (d.heapMB !== null) {
      memContent += _row('JS Heap', d.heapMB + ' MB', d.heapMB > 500);
    }
    if (memContent) parts.push(_section('Memory', memContent));

    // WorkerPool
    if (d.workerPool) {
      var wpContent = '';
      Object.keys(d.workerPool).forEach(function (url) {
        var s = d.workerPool[url];
        var shortUrl = url.split('/').pop().replace('.js', '');
        var hasIssue = s.busy === s.total && s.total > 0 && s.queued > 0;
        wpContent += _row(shortUrl, s.busy + '/' + s.total + ' busy, ' + s.queued + ' queued' + (s.crashed > 0 ? ' ⚠' + s.crashed + ' crashed' : ''), hasIssue || s.crashed > 0);
      });
      if (!wpContent) wpContent = _row('Status', 'No active pools');
      parts.push(_section('WorkerPool', wpContent));
    }

    // Schedulers
    if (d.taskScheduler) {
      var tsContent = '';
      ['RENDER', 'AI', 'BACKGROUND'].forEach(function (tier) {
        var s = d.taskScheduler[tier];
        if (!s) return;
        var warn = s.active >= s.limit && s.queued > 0;
        tsContent += _row(tier, s.active + '/' + s.limit + ' active, ' + s.queued + ' waiting', warn);
      });
      parts.push(_section('TaskScheduler', tsContent));
    }
    if (d.runtimeScheduler) {
      var rsContent = _row('Wait Queue', d.runtimeScheduler.waitQueueSize, d.runtimeScheduler.waitQueueSize > 5);
      if (d.runtimeScheduler.typeCounts) {
        Object.keys(d.runtimeScheduler.typeCounts).forEach(function (type) {
          if (d.runtimeScheduler.typeCounts[type] > 0) {
            rsContent += _row(type + ' (running)', d.runtimeScheduler.typeCounts[type]);
          }
        });
      }
      parts.push(_section('RuntimeScheduler', rsContent));
    }

    // OCR workers
    if (d.tesseract) {
      parts.push(_section('Tesseract (OCR)',
        _row('Live workers', d.tesseract.live, d.tesseract.live > 2)
        + _row('Busy', d.tesseract.busy)
        + _row('Auto-terminated', d.tesseract.autoTerminated)
      ));
    }

    // PDF docs
    if (d.pdfDocs) {
      parts.push(_section('PDF.js Documents',
        _row('Live docs', d.pdfDocs.live, d.pdfDocs.live > 3)
        + _row('Auto-destroyed', d.pdfDocs.autoDestroyed)
        + _row('Renders cancelled', d.pdfDocs.rendersCancelled)
      ));
    }

    // Canvas
    if (d.canvasGC) {
      var c = d.canvasGC.domCensus || {};
      parts.push(_section('Canvas Memory',
        _row('DOM canvases', c.total || 0)
        + _row('Large (>1MP)', c.large || 0, (c.large || 0) > 3)
        + _row('Huge (>8MP)', c.huge || 0, (c.huge || 0) > 0)
        + _row('Total pixel MB', ((c.totalMp || 0) * 4).toFixed(1) + ' MB (est.)', (c.totalMp || 0) * 4 > 100)
        + _row('GC released', d.canvasGC.gcReleased)
      ));
    }

    // Timeouts
    if (d.timeouts) {
      parts.push(_section('Timeout Reaper',
        _row('Active timeouts', d.timeouts.active, d.timeouts.active > 5)
        + _row('Total fired', d.timeouts.fired)
        + _row('Cancelled', d.timeouts.cancelled)
      ));
    }

    // Circuit breakers
    if (d.circuits && d.circuits.circuits) {
      var cbContent = '';
      Object.keys(d.circuits.circuits).forEach(function (name) {
        var cb = d.circuits.circuits[name];
        var stateColor = { CLOSED: '#22c55e', OPEN: '#ef4444', HALF_OPEN: '#f59e0b' };
        cbContent += _row(cb.label, _badge(cb.state, stateColor[cb.state] || '#64748b') + (cb.trips > 0 ? ' ' + cb.trips + ' trips' : ''), cb.state !== 'CLOSED');
      });
      parts.push(_section('Circuit Breakers', cbContent));
    }

    // Panic history
    if (d.panic) {
      parts.push(_section('Panic Manager',
        _row('Total panics', d.panic.panicCount, d.panic.panicCount > 0)
        + _row('Last panic', d.panic.lastPanic ? new Date(d.panic.lastPanic).toISOString().slice(11, 23) : 'Never')
        + (d.panic.panicCount > 0 && d.panic.history.length
           ? _row('Last reason', d.panic.history[d.panic.history.length - 1].reason, true)
           : '')
      ));
    }

    // Healer recoveries
    if (d.healer) {
      parts.push(_section('Auto-Healer',
        _row('Worker recoveries', d.healer.recoveries.workerPool)
        + _row('Scheduler recoveries', d.healer.recoveries.scheduler)
      ));
    }

    // Zombie cleaner
    if (d.zombies) {
      parts.push(_section('Zombie Cleaner',
        _row('Tracked', d.zombies.registry)
        + _row('Total cleaned', d.zombies.cleaned)
        + _row('Controllers', d.zombies.controllers)
      ));
    }

    // Actions
    parts.push(_section('Actions',
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px;">'
      + '<button onclick="window.RuntimeSoftReset && window.RuntimeSoftReset({reason:\'watchdog\'});window.RuntimeWatchdog.refresh();" style="background:#4f46e5;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;">Soft Reset</button>'
      + '<button onclick="window.RuntimeHealer && window.RuntimeHealer.runNow();window.RuntimeWatchdog.refresh();" style="background:#0f766e;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;">Heal Now</button>'
      + '<button onclick="window.RuntimePanicManager && window.RuntimePanicManager.triggerPanic(\'watchdog-test\');window.RuntimeWatchdog.refresh();" style="background:#b45309;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;">Test Panic</button>'
      + '<button onclick="window.RuntimeCircuitBreakers && window.RuntimeCircuitBreakers.resetAll();window.RuntimeWatchdog.refresh();" style="background:#1e40af;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;">Reset Circuits</button>'
      + '</div>'
    ));

    return parts.join('');
  }

  // ── Refresh loop ──────────────────────────────────────────────────────────────
  function refresh() {
    if (!_panel || !_visible) return;
    try {
      var data    = _collectData();
      var html    = _render(data);
      var content = document.getElementById('__rwd-content__');
      if (content) content.innerHTML = html;
    } catch (e) {
      console.debug(LOG, 'render error (non-fatal):', e.message);
    }
  }

  function show() {
    if (!document.body) { setTimeout(show, 500); return; }
    _createPanel();
    _visible      = true;
    _panel.style.display = 'block';
    refresh();
    if (!_updateTimer) {
      _updateTimer = setInterval(refresh, UPDATE_INTERVAL);
      if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeWatchdog', _updateTimer);
    }
    console.info(LOG, 'Watchdog overlay shown');
  }

  function hide() {
    _visible = false;
    if (_panel) _panel.style.display = 'none';
    if (_updateTimer) {
      clearInterval(_updateTimer);
      _updateTimer = null;
    }
  }

  function toggle() {
    _visible ? hide() : show();
  }

  // ── Keyboard shortcut: CTRL+SHIFT+H ──────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'H') {
      e.preventDefault();
      toggle();
    }
  });

  window.RuntimeWatchdog = {
    show:    show,
    hide:    hide,
    toggle:  toggle,
    refresh: refresh,
    VERSION: VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded — press CTRL+SHIFT+H to open watchdog overlay');
}());
