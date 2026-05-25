(function (G) {
  'use strict';
  if (G.RuntimeDebugMobile) return;

  var VERSION = '10.0.0';
  var LOG     = '[DebugMobile]';

  // ── Device detection ──────────────────────────────────────────────────────────
  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches || navigator.maxTouchPoints > 0;
  }

  function isLowEnd() {
    // Heuristic: ≤4 CPU cores OR device memory ≤2 GB OR mobile UA
    var cores = navigator.hardwareConcurrency || 4;
    var mem   = navigator.deviceMemory        || 4;
    return cores <= 2 || mem <= 1;
  }

  function getRefreshMs() {
    if (isLowEnd())  return 1500;
    if (isMobile())  return 800;
    return 500;
  }

  // ── Layout mode ───────────────────────────────────────────────────────────────
  var _compact = false;

  function applyLayout(root) {
    if (!root) return;
    _compact = isMobile();
    if (_compact) {
      root.classList.add('dbg-compact');
      root.classList.remove('dbg-desktop');
    } else {
      root.classList.add('dbg-desktop');
      root.classList.remove('dbg-compact');
    }
  }

  // ── Responsive breakpoint watcher ─────────────────────────────────────────────
  var _listeners = [];

  function onLayoutChange(fn) { _listeners.push(fn); }

  if (window.matchMedia) {
    window.matchMedia('(max-width: 768px)').addEventListener('change', function (e) {
      _listeners.forEach(function (fn) {
        try { fn(e.matches); } catch (_) {}
      });
    });
  }

  // ── Panel stacking (mobile: single column accordion) ─────────────────────────
  function stackPanels(container) {
    if (!container) return;
    if (!isMobile()) return;
    var panels = container.querySelectorAll('.dbg-panel');
    panels.forEach(function (p) {
      p.style.width    = '100%';
      p.style.minWidth = '0';
    });
  }

  // ── Touch-safe scrollable region ──────────────────────────────────────────────
  function makeTouchScrollable(el) {
    if (!el) return;
    el.style.webkitOverflowScrolling = 'touch';
    el.style.overflowY = 'auto';
  }

  G.RuntimeDebugMobile = Object.freeze({
    VERSION:          VERSION,
    isMobile:         isMobile,
    isLowEnd:         isLowEnd,
    getRefreshMs:     getRefreshMs,
    applyLayout:      applyLayout,
    onLayoutChange:   onLayoutChange,
    stackPanels:      stackPanels,
    makeTouchScrollable: makeTouchScrollable,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — mobile=' + isMobile() + ' lowEnd=' + isLowEnd());

}(window));
