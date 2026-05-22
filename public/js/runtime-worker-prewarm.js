// runtime-worker-prewarm.js — Phase 9 worker pool prewarming
// Proactively warms WorkerPool slots for the top tools (pdf-lib, pdf-worker,
// compress) after the first file drop or during idle time, so the first
// real dispatch hits a warm slot instead of paying worker boot latency.
// Exposes window.RuntimeWorkerPrewarm.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeWorkerPrewarm) return;

  var _warmed   = new Set();
  var _started  = false;
  var _DROP_TRIGGERED = false;

  // Workers to prewarm in priority order (highest → lowest)
  var PREWARM_TARGETS = [
    { url: '/workers/pdf-lib-worker.js',  priority: 1 },
    { url: '/workers/pdf-worker.js',      priority: 2 },
    { url: '/workers/compress-worker.js', priority: 3 },
    { url: '/workers/advanced-worker.js', priority: 4 },
  ];

  // ── Single-slot prewarm via WorkerPool ────────────────────────────────────
  function _warmOne(target) {
    if (_warmed.has(target.url)) return;
    _warmed.add(target.url);
    try {
      var WP = G.WorkerPool;
      if (WP && typeof WP.prewarm === 'function') {
        WP.prewarm(target.url, 1).catch(function () {});
      } else if (WP && typeof WP.run === 'function') {
        // Fallback: send a no-op ping so the slot boots
        WP.run(target.url, { __ping: true }, 'background').catch(function () {});
      }
    } catch (_) {}
  }

  // ── Idle-time prewarm ─────────────────────────────────────────────────────
  function _idlePrewarm() {
    if (_started) return;
    _started = true;
    var idx = 0;
    function _next(deadline) {
      while (idx < PREWARM_TARGETS.length &&
             (!deadline || deadline.timeRemaining() > 10)) {
        _warmOne(PREWARM_TARGETS[idx++]);
      }
      if (idx < PREWARM_TARGETS.length) {
        if (G.requestIdleCallback) {
          G.requestIdleCallback(_next, { timeout: 8000 });
        } else {
          setTimeout(function () { _next(null); }, 1500);
        }
      }
    }
    if (G.requestIdleCallback) {
      G.requestIdleCallback(_next, { timeout: 5000 });
    } else {
      setTimeout(function () { _next(null); }, 4000);
    }
  }

  // ── File-drop triggered prewarm (warm top 2 immediately) ─────────────────
  function onFileDrop() {
    if (_DROP_TRIGGERED) return;
    _DROP_TRIGGERED = true;
    _warmOne(PREWARM_TARGETS[0]);
    _warmOne(PREWARM_TARGETS[1]);
    // Warm remaining on next idle
    _idlePrewarm();
  }

  // ── Tool-hint prewarm (warm the specific worker for a tool) ──────────────
  var _TOOL_WORKER = {
    'merge':         '/workers/pdf-lib-worker.js',
    'split':         '/workers/pdf-lib-worker.js',
    'rotate':        '/workers/pdf-lib-worker.js',
    'crop':          '/workers/pdf-lib-worker.js',
    'protect':       '/workers/pdf-lib-worker.js',
    'unlock':        '/workers/pdf-lib-worker.js',
    'watermark':     '/workers/pdf-lib-worker.js',
    'page-numbers':  '/workers/pdf-lib-worker.js',
    'compress':      '/workers/compress-worker.js',
    'ocr':           '/workers/pdf-worker.js',
    'pdf-to-word':   '/workers/pdf-worker.js',
    'ai-summarize':  '/workers/advanced-worker.js',
  };

  function prewarmForTool(toolId) {
    var url = _TOOL_WORKER[toolId];
    if (url) _warmOne({ url: url });
  }

  // ── Auto-attach to file drop zones on DOMContentLoaded ───────────────────
  function _attachDropListeners() {
    try {
      var zones = document.querySelectorAll('[data-drop-zone],[id="drop-zone"],[class*="upload"]');
      if (!zones.length) zones = [document];
      zones.forEach(function (el) {
        el.addEventListener('dragover', function () { onFileDrop(); }, { once: true, passive: true });
        el.addEventListener('drop',     function () { onFileDrop(); }, { once: true, passive: true });
      });
      var inputs = document.querySelectorAll('input[type="file"]');
      inputs.forEach(function (el) {
        el.addEventListener('change', function () { onFileDrop(); }, { once: true, passive: true });
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _attachDropListeners);
  } else {
    setTimeout(_attachDropListeners, 0);
  }

  // Start idle prewarm 6 s after page load (generous delay to avoid
  // contending with the main-thread during initial render).
  setTimeout(_idlePrewarm, 6000);

  G.RuntimeWorkerPrewarm = Object.freeze({
    onFileDrop:     onFileDrop,
    prewarmForTool: prewarmForTool,
    isWarmed: function (url) { return _warmed.has(url); },
    getStats: function () {
      return { warmed: Array.from(_warmed), dropTriggered: _DROP_TRIGGERED, started: _started };
    },
  });
}());
