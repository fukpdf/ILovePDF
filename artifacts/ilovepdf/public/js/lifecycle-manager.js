// Lifecycle Manager — centralized event hub for tab visibility, page freeze,
// and GPU context loss.
//
// Teardown order on hide/pagehide/freeze:
//   1. TaskScheduler.pause()     — stop dispatching new work
//   2. BgAiEngine.cancel()       — set tiled-inference cancel flag
//   3. CanvasPool.flushPool()    — free GPU textures in pool
//   4. TimerRegistry.emergencyClearAll() — on pagehide only
//   5. Registered onHide handlers
//
// Restore order on resume/visible:
//   1. TaskScheduler.resume()    — re-enable slot dispatching
//   2. Registered onResume handlers
//
// GPU context loss (WebGL):
//   Pauses TaskScheduler on loss; resumes on restore.
//   pdf-preview.js has its own null-ctx guard for the canvas-level case.
//
// API (window.LifecycleManager):
//   onHide(fn)   — register hide handler fn(reason)
//   onResume(fn) — register resume handler fn()
//   isPaused()   — true while hidden/frozen
(function () {
  'use strict';

  var _hideHandlers   = [];
  var _resumeHandlers = [];
  var _paused         = false;

  function onHide(fn)   { if (typeof fn === 'function') _hideHandlers.push(fn); }
  function onResume(fn) { if (typeof fn === 'function') _resumeHandlers.push(fn); }
  function isPaused()   { return _paused; }

  function _doHide(reason) {
    if (_paused) return;
    _paused = true;

    // Ordered teardown
    if (window.TaskScheduler) { try { window.TaskScheduler.pause(); } catch (_) {} }
    if (window.BgAiEngine)    { try { window.BgAiEngine.cancel();   } catch (_) {} }
    if (window.CanvasPool)    { try { window.CanvasPool.flushPool(); } catch (_) {} }

    _hideHandlers.forEach(function (fn) { try { fn(reason); } catch (_) {} });
  }

  function _doResume() {
    if (!_paused) return;
    _paused = false;

    if (window.TaskScheduler) { try { window.TaskScheduler.resume(); } catch (_) {} }
    _resumeHandlers.forEach(function (fn) { try { fn(); } catch (_) {} });
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      _doHide('visibilitychange');
    } else if (document.visibilityState === 'visible') {
      _doResume();
    }
  }, { passive: true });

  // ── Page hide / freeze ────────────────────────────────────────────────────
  window.addEventListener('pagehide', function (e) {
    _doHide(e.persisted ? 'pagehide-bfcache' : 'pagehide');
    // Emergency-clear all registered timers on navigation / bfcache
    if (window.TimerRegistry) {
      try { window.TimerRegistry.emergencyClearAll(); } catch (_) {}
    }
  }, { passive: true });

  window.addEventListener('freeze', function () {
    _doHide('freeze');
  }, { passive: true });

  window.addEventListener('resume', function () {
    _doResume();
  }, { passive: true });

  // ── GPU context loss (WebGL) ──────────────────────────────────────────────
  // Capture phase so this fires before canvas-specific handlers.
  document.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); // allow context restoration
    console.warn('[LifecycleManager] WebGL context lost — render queue paused');
    if (window.TaskScheduler) { try { window.TaskScheduler.pause(); } catch (_) {} }
  }, true);

  document.addEventListener('webglcontextrestored', function () {
    console.info('[LifecycleManager] WebGL context restored — render queue resumed');
    if (window.TaskScheduler) { try { window.TaskScheduler.resume(); } catch (_) {} }
  }, true);

  window.LifecycleManager = { onHide, onResume, isPaused };
}());
