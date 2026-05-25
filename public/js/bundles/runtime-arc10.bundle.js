// ── Arc 10D Admin Observability Dashboard — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-25T11:40:36.817Z  BUILD_ID: mpl4xfqy
// Files: 14

// ── SOURCE: public/js/runtime-debug-security.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugSecurity) return;

  var VERSION = '10.0.0';
  var LOG = '[DebugSecurity]';

  // ── Access gate ───────────────────────────────────────────────────────────────
  // Allowed if ANY of: ?debug=1 | sessionStorage.ilpdf_dash=1 | localStorage.ilpdf_admin=1
  function _isAllowed() {
    try {
      var qs  = window.location.search;
      if (qs.indexOf('debug=1') !== -1) return true;
      if (sessionStorage && sessionStorage.getItem('ilpdf_dash') === '1') return true;
      if (localStorage  && localStorage.getItem('ilpdf_admin')  === '1') return true;
    } catch (_) {}
    return false;
  }

  // ── Sensitive field redaction ─────────────────────────────────────────────────
  var REDACT_KEYS = [
    'token', 'jwt', 'secret', 'password', 'passwd', 'apikey', 'api_key',
    'cookie', 'session', 'auth', 'credential', 'private', 'key',
  ];

  function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var out = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach(function (k) {
      var lk = k.toLowerCase();
      var sensitive = REDACT_KEYS.some(function (r) { return lk.indexOf(r) !== -1; });
      if (sensitive) {
        out[k] = '[REDACTED]';
      } else if (obj[k] && typeof obj[k] === 'object') {
        out[k] = redact(obj[k]);
      } else {
        out[k] = obj[k];
      }
    });
    return out;
  }

  // ── Rate limiter (for export/command actions) ─────────────────────────────────
  var _rateBuckets = {};
  function checkRate(key, maxPerMin) {
    var now = Date.now();
    if (!_rateBuckets[key]) _rateBuckets[key] = [];
    _rateBuckets[key] = _rateBuckets[key].filter(function (t) { return now - t < 60000; });
    if (_rateBuckets[key].length >= maxPerMin) return false;
    _rateBuckets[key].push(now);
    return true;
  }

  // ── Command allow-list (ControlPlane commands safe to execute from debug page) ─
  var SAFE_COMMANDS = [
    'gc:hint', 'cache:clear', 'hydration:flush',
    'healing:start', 'healing:stop',
    'governance:sweep', 'workload:stop', 'workload:start',
    'session-stability:assess', 'blackbox:export',
  ];

  function isSafeCommand(cmd) {
    return SAFE_COMMANDS.indexOf(cmd) !== -1;
  }

  G.RuntimeDebugSecurity = Object.freeze({
    VERSION:      VERSION,
    isAllowed:    _isAllowed,
    redact:       redact,
    checkRate:    checkRate,
    isSafeCommand: isSafeCommand,
    SAFE_COMMANDS: SAFE_COMMANDS,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — gate active');

}(window));

// ── SOURCE: public/js/runtime-debug-state.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugState) return;

  var VERSION = '10.0.0';
  var LOG = '[DebugState]';

  // ── Panel registry ────────────────────────────────────────────────────────────
  var _panels  = {};   // id → { id, label, active, element, refresh, destroy }
  var _active  = {};   // id → bool

  function registerPanel(id, spec) {
    _panels[id] = Object.assign({ id: id, active: false }, spec);
  }

  function activatePanel(id) {
    if (_panels[id]) { _panels[id].active = true; _active[id] = true; }
  }

  function deactivatePanel(id) {
    if (_panels[id]) { _panels[id].active = false; _active[id] = false; }
  }

  function getPanel(id)       { return _panels[id] || null; }
  function getPanels()        { return Object.assign({}, _panels); }
  function getActivePanels()  { return Object.keys(_active).filter(function (id) { return _active[id]; }); }

  // ── Global debug state (shared across panels) ─────────────────────────────────
  var _state = {
    tabHidden:   false,
    mobileLow:   false,
    refreshMs:   500,
    version:     VERSION,
    buildId:     (typeof window.__BUILD_ID__ !== 'undefined') ? window.__BUILD_ID__ : '—',
    startTs:     Date.now(),
  };

  function get(key)        { return _state[key]; }
  function set(key, val)   { _state[key] = val; }
  function getAll()        { return Object.assign({}, _state); }

  // ── Cross-panel event bus ─────────────────────────────────────────────────────
  var _bus = {};

  function on(event, fn) {
    if (!_bus[event]) _bus[event] = [];
    _bus[event].push(fn);
  }

  function off(event, fn) {
    if (!_bus[event]) return;
    _bus[event] = _bus[event].filter(function (f) { return f !== fn; });
  }

  function emit(event, data) {
    if (!_bus[event]) return;
    _bus[event].forEach(function (fn) {
      try { fn(data); } catch (_) {}
    });
  }

  G.RuntimeDebugState = Object.freeze({
    VERSION:         VERSION,
    registerPanel:   registerPanel,
    activatePanel:   activatePanel,
    deactivatePanel: deactivatePanel,
    getPanel:        getPanel,
    getPanels:       getPanels,
    getActivePanels: getActivePanels,
    get:             get,
    set:             set,
    getAll:          getAll,
    on:              on,
    off:             off,
    emit:            emit,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — panel registry + event bus active');

}(window));

// ── SOURCE: public/js/runtime-debug-storage.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugStorage) return;

  var VERSION  = '10.0.0';
  var LOG      = '[DebugStorage]';
  var MAX_KEYS = 50;
  var PREFIX   = 'ilpdf_debug_';

  // ── In-memory ring store (panel state, history) ───────────────────────────────
  var _store   = {};   // key → { value, ts }
  var _keys    = [];   // ordered insertion keys

  function _evict() {
    while (_keys.length > MAX_KEYS) {
      var oldest = _keys.shift();
      delete _store[oldest];
    }
  }

  function put(key, value) {
    if (!_store[key]) _keys.push(key);
    _store[key] = { value: value, ts: Date.now() };
    _evict();
  }

  function fetch(key) {
    return _store[key] ? _store[key].value : undefined;
  }

  function remove(key) {
    delete _store[key];
    _keys = _keys.filter(function (k) { return k !== key; });
  }

  function clear() {
    _store = {};
    _keys  = [];
  }

  // ── sessionStorage helpers (graceful) ─────────────────────────────────────────
  function persist(key, value) {
    try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (_) {}
  }

  function load(key) {
    try {
      var raw = sessionStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (_) { return undefined; }
  }

  function forget(key) {
    try { sessionStorage.removeItem(PREFIX + key); } catch (_) {}
  }

  // ── 20 MB soft cap estimation ─────────────────────────────────────────────────
  function estimateBytes() {
    var total = 0;
    Object.keys(_store).forEach(function (k) {
      try { total += JSON.stringify(_store[k]).length * 2; } catch (_) {}
    });
    return total;
  }

  function isOverCap() { return estimateBytes() > 20 * 1024 * 1024; }

  function trimToFit() {
    while (isOverCap() && _keys.length > 0) {
      var oldest = _keys.shift();
      delete _store[oldest];
    }
  }

  G.RuntimeDebugStorage = Object.freeze({
    VERSION:       VERSION,
    put:           put,
    fetch:         fetch,
    remove:        remove,
    clear:         clear,
    persist:       persist,
    load:          load,
    forget:        forget,
    estimateBytes: estimateBytes,
    isOverCap:     isOverCap,
    trimToFit:     trimToFit,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — in-memory ring store active');

}(window));

// ── SOURCE: public/js/runtime-debug-renderer.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugRenderer) return;

  var VERSION = '10.0.0';
  var LOG     = '[DebugRenderer]';

  // ── Incremental DOM helpers ───────────────────────────────────────────────────

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'cls') { e.className = attrs[k]; }
        else if (k === 'style') { e.style.cssText = attrs[k]; }
        else if (k === 'html') { e.innerHTML = attrs[k]; }
        else if (k === 'text') { e.textContent = attrs[k]; }
        else { e.setAttribute(k, attrs[k]); }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      });
    }
    return e;
  }

  function text(str) { return document.createTextNode(String(str)); }

  // ── Incremental update: only patch changed fields ─────────────────────────────
  function patchText(selector, newVal, container) {
    var scope = container || document;
    var node  = scope.querySelector(selector);
    if (node && node.textContent !== String(newVal)) {
      node.textContent = String(newVal);
    }
  }

  function patchHtml(selector, newHtml, container) {
    var scope = container || document;
    var node  = scope.querySelector(selector);
    if (node && node.innerHTML !== newHtml) {
      node.innerHTML = newHtml;
    }
  }

  // ── Virtual list (render only visible rows) ───────────────────────────────────
  function VirtualList(container, rowHeight, renderRow) {
    this._c        = container;
    this._rh       = rowHeight;
    this._render   = renderRow;
    this._items    = [];
    this._startIdx = 0;
    this._endIdx   = 0;
    container.style.overflowY   = 'auto';
    container.style.position    = 'relative';
    var self = this;
    container.addEventListener('scroll', function () { self._paint(); });
  }

  VirtualList.prototype.setItems = function (items) {
    this._items = items;
    this._c.style.height = (items.length * this._rh) + 'px';
    this._paint();
  };

  VirtualList.prototype._paint = function () {
    var scrollTop  = this._c.scrollTop;
    var viewHeight = this._c.clientHeight || 400;
    var start = Math.max(0, Math.floor(scrollTop / this._rh) - 5);
    var end   = Math.min(this._items.length, Math.ceil((scrollTop + viewHeight) / this._rh) + 5);
    if (start === this._startIdx && end === this._endIdx) return;
    this._startIdx = start;
    this._endIdx   = end;
    var frag = document.createDocumentFragment();
    var spacer = document.createElement('div');
    spacer.style.height = (start * this._rh) + 'px';
    frag.appendChild(spacer);
    for (var i = start; i < end; i++) {
      frag.appendChild(this._render(this._items[i], i));
    }
    this._c.innerHTML = '';
    this._c.appendChild(frag);
  };

  // ── Severity badge ────────────────────────────────────────────────────────────
  var SEV_COLORS = { 0: '#f44', 1: '#f84', 2: '#fa0', 3: '#8af' };
  var SEV_LABELS = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };

  function badge(sev) {
    return el('span', {
      cls:   'sev-badge',
      style: 'background:' + (SEV_COLORS[sev] || '#aaa') + ';color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;',
      text:  SEV_LABELS[sev] !== undefined ? SEV_LABELS[sev] : String(sev),
    });
  }

  // ── Sparkline (canvas mini-chart) ─────────────────────────────────────────────
  function sparkline(values, width, height, color) {
    var c = document.createElement('canvas');
    c.width  = width  || 120;
    c.height = height || 32;
    var ctx = c.getContext('2d');
    if (!ctx || !values.length) return c;
    var max = Math.max.apply(null, values) || 1;
    var min = Math.min.apply(null, values);
    var range = max - min || 1;
    var w = c.width / (values.length - 1 || 1);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = color || '#4af';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    values.forEach(function (v, i) {
      var x = i * w;
      var y = c.height - ((v - min) / range) * c.height;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    return c;
  }

  // ── Timestamp formatter ───────────────────────────────────────────────────────
  function fmtTs(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function fmtAge(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  G.RuntimeDebugRenderer = Object.freeze({
    VERSION:     VERSION,
    el:          el,
    text:        text,
    patchText:   patchText,
    patchHtml:   patchHtml,
    VirtualList: VirtualList,
    badge:       badge,
    sparkline:   sparkline,
    fmtTs:       fmtTs,
    fmtAge:      fmtAge,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — incremental DOM + virtual list ready');

}(window));

// ── SOURCE: public/js/runtime-debug-mobile.js ──
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

// ── SOURCE: public/js/runtime-debug-export.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugExport) return;

  var VERSION     = '10.0.0';
  var LOG         = '[DebugExport]';
  var RATE_LIMIT  = 10; // max exports per minute

  // ── JSON export ───────────────────────────────────────────────────────────────
  function exportJson(data, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('json-export', RATE_LIMIT)) {
      console.warn(LOG, 'export rate limit exceeded');
      return null;
    }
    try {
      var cleaned = sec ? sec.redact(data) : data;
      var json    = JSON.stringify(cleaned, null, 2);
      var blob    = new Blob([json], { type: 'application/json' });
      var url     = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-export') + '.json');
      return url;
    } catch (e) {
      console.warn(LOG, 'export failed:', e.message);
      return null;
    }
  }

  // ── Text/log export ───────────────────────────────────────────────────────────
  function exportText(lines, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('text-export', RATE_LIMIT)) return null;
    try {
      var content = Array.isArray(lines) ? lines.join('\n') : String(lines);
      var blob    = new Blob([content], { type: 'text/plain' });
      var url     = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-log') + '.txt');
      return url;
    } catch (e) {
      console.warn(LOG, 'text export failed:', e.message);
      return null;
    }
  }

  // ── CSV export ────────────────────────────────────────────────────────────────
  function exportCsv(rows, headers, filename) {
    var sec = G.RuntimeDebugSecurity;
    if (sec && !sec.checkRate('csv-export', RATE_LIMIT)) return null;
    try {
      var lines = [];
      if (headers) lines.push(headers.join(','));
      rows.forEach(function (row) {
        lines.push(row.map(function (c) {
          var s = String(c === null || c === undefined ? '' : c);
          return s.indexOf(',') !== -1 || s.indexOf('"') !== -1
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
        }).join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var url  = URL.createObjectURL(blob);
      _trigger(url, (filename || 'debug-data') + '.csv');
      return url;
    } catch (e) {
      console.warn(LOG, 'csv export failed:', e.message);
      return null;
    }
  }

  // ── Full dashboard snapshot ───────────────────────────────────────────────────
  function exportDashboardSnapshot() {
    var snap = {
      ts:         Date.now(),
      buildId:    (G.RuntimeDebugState && G.RuntimeDebugState.get('buildId')) || '—',
      incidents:  G.RuntimeIncidentCenter  ? G.RuntimeIncidentCenter.query({}) : [],
      timeline:   G.RuntimeEventTimeline   ? G.RuntimeEventTimeline.search({})  : [],
      blackbox:   G.RuntimeBlackbox        ? G.RuntimeBlackbox.getMetrics()      : {},
      healing:    G.RuntimeAutonomousHealing ? G.RuntimeAutonomousHealing.getState() : {},
      governance: G.RuntimeGovernance      ? G.RuntimeGovernance.getViolations()  : [],
      recovery:   G.RuntimeRecoveryOrchestrator ? G.RuntimeRecoveryOrchestrator.getHistory() : [],
      profiler:   G.RuntimePerformanceProfiler  ? G.RuntimePerformanceProfiler.getMetrics()  : {},
      stability:  G.RuntimeSessionStability     ? G.RuntimeSessionStability.getState()       : {},
    };
    return exportJson(snap, 'dashboard-snapshot-' + Date.now().toString(36));
  }

  // ── Download trigger ──────────────────────────────────────────────────────────
  function _trigger(url, name) {
    var a = document.createElement('a');
    a.href     = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  G.RuntimeDebugExport = Object.freeze({
    VERSION:                VERSION,
    exportJson:             exportJson,
    exportText:             exportText,
    exportCsv:              exportCsv,
    exportDashboardSnapshot: exportDashboardSnapshot,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — export rate-limited at', RATE_LIMIT, 'ops/min');

}(window));

// ── SOURCE: public/js/runtime-debug-shell.js ──
(function (G) {
  'use strict';
  if (G.RuntimeDebugShell) return;

  var VERSION = '10.0.0';
  var LOG     = '[DebugShell]';

  // ── Dependency check ──────────────────────────────────────────────────────────
  var DEPS = [
    'RuntimeDebugSecurity', 'RuntimeDebugState', 'RuntimeDebugStorage',
    'RuntimeDebugRenderer',  'RuntimeDebugMobile', 'RuntimeDebugExport',
  ];

  var _missing = DEPS.filter(function (d) { return !G[d]; });
  if (_missing.length) {
    console.warn(LOG, 'missing deps:', _missing.join(', '));
    return;
  }

  var Sec  = G.RuntimeDebugSecurity;
  var St   = G.RuntimeDebugState;
  var Sto  = G.RuntimeDebugStorage;
  var Ren  = G.RuntimeDebugRenderer;
  var Mob  = G.RuntimeDebugMobile;

  // ── Production gate ───────────────────────────────────────────────────────────
  if (!Sec.isAllowed()) {
    console.warn(LOG, 'access denied — redirect');
    if (window.location.pathname.indexOf('debug') !== -1) {
      window.location.href = '/';
    }
    return;
  }

  // ── Panel definitions (lazy-loaded) ──────────────────────────────────────────
  var PANEL_DEFS = [
    { id: 'incidents',   label: 'Incidents',         icon: '🚨', ctor: 'PanelIncidents'  },
    { id: 'timeline',    label: 'Event Timeline',     icon: '📊', ctor: 'PanelTimeline'   },
    { id: 'blackbox',    label: 'Blackbox',           icon: '⚫', ctor: 'PanelBlackbox'   },
    { id: 'recovery',    label: 'Recovery & Healing', icon: '🔄', ctor: 'PanelRecovery'   },
    { id: 'performance', label: 'Performance',        icon: '⚡', ctor: 'PanelPerformance'},
    { id: 'control',     label: 'Control Plane',      icon: '🎛️', ctor: 'PanelControl'    },
    { id: 'traces',      label: 'Traces & Snapshots', icon: '🔍', ctor: 'PanelTraces'     },
  ];

  // ── DOM root ──────────────────────────────────────────────────────────────────
  var _root   = null;
  var _nav    = null;
  var _body   = null;
  var _panels = {};         // id → { instance, el }
  var _active = null;       // currently visible panel id
  var _timers = {};         // panel id → interval id
  var _paused = false;

  // ── Polling scheduler ─────────────────────────────────────────────────────────
  var _refreshMs = Mob.getRefreshMs();

  function _startPoller(id) {
    _stopPoller(id);
    var spec = _panels[id];
    if (!spec || !spec.instance || typeof spec.instance.refresh !== 'function') return;
    _timers[id] = setInterval(function () {
      if (_paused || St.get('tabHidden')) return;
      if (Sto.isOverCap()) { Sto.trimToFit(); }
      try { spec.instance.refresh(); } catch (e) { console.warn(LOG, 'panel refresh error:', e.message); }
    }, _refreshMs);
  }

  function _stopPoller(id) {
    if (_timers[id]) { clearInterval(_timers[id]); delete _timers[id]; }
  }

  // ── Page visibility ───────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    var hidden = document.hidden;
    St.set('tabHidden', hidden);
    _paused = hidden;
    if (!hidden && _active) {
      var spec = _panels[_active];
      if (spec && spec.instance && typeof spec.instance.refresh === 'function') {
        try { spec.instance.refresh(); } catch (_) {}
      }
    }
  });

  // ── Panel activation ─────────────────────────────────────────────────────────
  function _activatePanel(id) {
    if (_active === id) return;

    // Deactivate current
    if (_active && _panels[_active]) {
      _panels[_active].el.style.display = 'none';
      _stopPoller(_active);
      St.deactivatePanel(_active);
    }

    _active = id;
    var spec = _panels[id];
    if (!spec) return;
    spec.el.style.display = '';
    St.activatePanel(id);

    // Initialize if first time
    if (!spec.instance) {
      var Ctor = G[PANEL_DEFS.find(function (p) { return p.id === id; }).ctor];
      if (Ctor && typeof Ctor === 'function') {
        try {
          spec.instance = new Ctor(spec.el);
          if (typeof spec.instance.init === 'function') spec.instance.init();
        } catch (e) { console.warn(LOG, 'panel init error', id, e.message); }
      }
    }

    if (spec.instance && typeof spec.instance.refresh === 'function') {
      try { spec.instance.refresh(); } catch (_) {}
    }

    _startPoller(id);
    _updateNav(id);

    // Persist active tab
    Sto.persist('activePanel', id);
  }

  // ── Nav render ────────────────────────────────────────────────────────────────
  function _updateNav(activeId) {
    if (!_nav) return;
    _nav.querySelectorAll('.dbg-nav-tab').forEach(function (tab) {
      var isActive = tab.dataset.panel === activeId;
      tab.classList.toggle('dbg-nav-active', isActive);
    });
  }

  // ── Shell layout ──────────────────────────────────────────────────────────────
  function _buildLayout() {
    _root = document.getElementById('dbg-root');
    if (!_root) {
      _root = Ren.el('div', { id: 'dbg-root', cls: 'dbg-root' });
      document.body.appendChild(_root);
    }

    Mob.applyLayout(_root);

    // Header
    var buildId = (typeof window.__BUILD_ID__ !== 'undefined') ? window.__BUILD_ID__ : '—';
    var header  = Ren.el('div', { cls: 'dbg-header' }, [
      Ren.el('span', { cls: 'dbg-logo', text: '🛠 ILovePDF Debug Console' }),
      Ren.el('span', { cls: 'dbg-build', text: 'build: ' + buildId }),
      Ren.el('span', { cls: 'dbg-arc',   text: 'Arc 8–9 coverage: 14 systems' }),
      Ren.el('button', { cls: 'dbg-btn dbg-export-all', text: 'Export Snapshot' }),
    ]);

    header.querySelector('.dbg-export-all').addEventListener('click', function () {
      if (G.RuntimeDebugExport) G.RuntimeDebugExport.exportDashboardSnapshot();
    });

    // Nav tabs
    _nav = Ren.el('nav', { cls: 'dbg-nav' });
    PANEL_DEFS.forEach(function (def) {
      var tab = Ren.el('button', {
        cls:          'dbg-nav-tab',
        text:         def.icon + ' ' + def.label,
        'data-panel': def.id,
      });
      tab.addEventListener('click', function () { _activatePanel(def.id); });
      _nav.appendChild(tab);
    });

    // Panel body
    _body = Ren.el('div', { cls: 'dbg-body' });

    PANEL_DEFS.forEach(function (def) {
      var pane = Ren.el('div', { cls: 'dbg-panel', id: 'panel-' + def.id, style: 'display:none' });
      _body.appendChild(pane);
      _panels[def.id] = { el: pane, instance: null };
      St.registerPanel(def.id, { label: def.label });
    });

    _root.appendChild(header);
    _root.appendChild(_nav);
    _root.appendChild(_body);

    Mob.stackPanels(_body);
    Mob.onLayoutChange(function () {
      Mob.applyLayout(_root);
      Mob.stackPanels(_body);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    _buildLayout();

    // Restore last active panel or default to incidents
    var last = Sto.load('activePanel') || 'incidents';
    _activatePanel(last);

    // Runtime health summary in console
    var systems = [
      'RuntimeIncidentCenter', 'RuntimeEventTimeline', 'RuntimeBlackbox',
      'RuntimeRecoveryOrchestrator', 'RuntimeAutonomousHealing', 'RuntimeGovernance',
      'RuntimePerformanceProfiler', 'RuntimeWorkloadIntelligence', 'RuntimeSessionStability',
    ];
    var loaded = systems.filter(function (s) { return !!G[s]; });
    console.debug(LOG, 'runtime coverage:', loaded.length + '/' + systems.length, 'Arc8–9 systems available');

    St.emit('shell:ready', { panels: PANEL_DEFS.length });
  }

  // ── Pause/resume for external callers ─────────────────────────────────────────
  function pause()  { _paused = true;  Object.keys(_timers).forEach(_stopPoller); }
  function resume() { _paused = false; if (_active) _startPoller(_active); }

  G.RuntimeDebugShell = Object.freeze({
    VERSION:       VERSION,
    init:          init,
    activatePanel: _activatePanel,
    pause:         pause,
    resume:        resume,
    getActive:     function () { return _active; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — gated dashboard shell');

}(window));

// ── SOURCE: public/js/debug-panels/panel-incidents.js ──
(function (G) {
  'use strict';
  if (G.PanelIncidents) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelIncidents]';

  function PanelIncidents(container) {
    this._c        = container;
    this._filter   = { sev: -1, search: '' };
    this._paused   = false;
    this._built    = false;
  }

  PanelIncidents.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    // Toolbar
    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🚨 Incident Center' }),
      Ren.el('select', { cls: 'dbg-sel', id: 'inc-sev-sel' }, [
        Ren.el('option', { value: '-1', text: 'All severities' }),
        Ren.el('option', { value: '0',  text: 'P0 Critical' }),
        Ren.el('option', { value: '1',  text: 'P1 High' }),
        Ren.el('option', { value: '2',  text: 'P2 Medium' }),
        Ren.el('option', { value: '3',  text: 'P3 Low' }),
      ]),
      Ren.el('input', { cls: 'dbg-input', id: 'inc-search', placeholder: 'Search…', type: 'text' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'inc-export', text: 'Export JSON' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'inc-clear', text: 'Clear Resolved' }),
    ]);

    // Metrics strip
    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'inc-metrics' });

    // Incident list
    var listWrap = Ren.el('div', { cls: 'panel-list-wrap', id: 'inc-list-wrap', style: 'height:420px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metrics);
    this._c.appendChild(listWrap);

    // Wire controls
    toolbar.querySelector('#inc-sev-sel').addEventListener('change', function (e) {
      self._filter.sev = parseInt(e.target.value, 10);
      self.refresh();
    });
    toolbar.querySelector('#inc-search').addEventListener('input', function (e) {
      self._filter.search = e.target.value.toLowerCase();
      self.refresh();
    });
    toolbar.querySelector('#inc-export').addEventListener('click', function () {
      var Ex = G.RuntimeDebugExport;
      var IC = G.RuntimeIncidentCenter;
      if (Ex && IC) Ex.exportJson(IC.query({}), 'incidents');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(listWrap);
  };

  PanelIncidents.prototype.refresh = function () {
    if (!this._built) return;
    var IC  = G.RuntimeIncidentCenter;
    var AH  = G.RuntimeAutonomousHealing;
    var RO  = G.RuntimeRecoveryOrchestrator;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#inc-metrics');
    if (metricsEl && IC) {
      var m = IC.getMetrics();
      metricsEl.innerHTML = '';
      [
        ['Total', m.total || 0],
        ['P0',    m.bySev && m.bySev[0] || 0],
        ['P1',    m.bySev && m.bySev[1] || 0],
        ['P2',    m.bySev && m.bySev[2] || 0],
        ['P3',    m.bySev && m.bySev[3] || 0],
        ['Resolved', m.resolved || 0],
      ].forEach(function (pair) {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      if (AH) {
        var as = AH.getState();
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Heals: ' + (as.stats && as.stats.total || 0) }));
      }
    }

    // Incidents list
    var listWrap = this._c.querySelector('#inc-list-wrap');
    if (!listWrap || !IC) return;

    var filter  = this._filter;
    var allIncs = IC.query({});
    var items   = allIncs.filter(function (inc) {
      if (filter.sev >= 0 && inc.severity !== filter.sev) return false;
      if (filter.search) {
        var haystack = ((inc.category || '') + ' ' + (inc.msg || '')).toLowerCase();
        if (haystack.indexOf(filter.search) === -1) return false;
      }
      return true;
    });

    listWrap.innerHTML = '';

    if (!items.length) {
      listWrap.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No incidents match current filter.' }));
      return;
    }

    items.slice().reverse().forEach(function (inc) {
      var row = Ren.el('div', { cls: 'inc-row' + (inc.resolved ? ' inc-resolved' : '') });

      // Badge + category
      row.appendChild(Ren.badge(inc.severity));
      row.appendChild(Ren.el('span', { cls: 'inc-cat', text: ' ' + (inc.category || '—') }));

      // Message
      row.appendChild(Ren.el('div', { cls: 'inc-msg', text: inc.msg || '' }));

      // Meta row: ts + age + count
      var meta = Ren.el('div', { cls: 'inc-meta' }, [
        Ren.el('span', { text: Ren.fmtTs(inc.ts) + ' · ' + Ren.fmtAge(inc.ts) }),
      ]);
      if (inc.count > 1) {
        meta.appendChild(Ren.el('span', { cls: 'inc-count', text: ' ×' + inc.count }));
      }
      row.appendChild(meta);

      // Recovery suggestion (from AH patterns)
      if (AH && inc.severity <= 1) {
        var state = AH.getState();
        var pat   = state.patterns && state.patterns[inc.category];
        if (pat && pat.count >= 2) {
          row.appendChild(Ren.el('div', { cls: 'inc-suggest', text: '💡 Auto-heal attempted ' + pat.count + 'x for this category' }));
        }
      }

      // Resolve button
      if (!inc.resolved && inc.id && IC.resolve) {
        var btn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Resolve' });
        btn.addEventListener('click', function () { IC.resolve(inc.id); });
        row.appendChild(btn);
      }

      // Recovery suggestion
      if (RO && inc.severity === 0) {
        var simBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm dbg-btn-warn', text: 'Simulate Recovery' });
        simBtn.addEventListener('click', function () {
          var result = RO.simulate({ reason: 'debug-panel-p0' });
          alert('Simulation: ' + JSON.stringify(result && result.steps ? result.steps.length + ' steps' : result, null, 2).slice(0, 300));
        });
        row.appendChild(simBtn);
      }

      listWrap.appendChild(row);
    });
  };

  G.PanelIncidents = PanelIncidents;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-timeline.js ──
(function (G) {
  'use strict';
  if (G.PanelTimeline) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelTimeline]';

  var FAMILY_COLORS = {
    pdf: '#4af', image: '#fa4', convert: '#a4f', security: '#f44',
    edit: '#4fa', merge: '#4af', organize: '#8af', ai: '#f4a',
  };

  function PanelTimeline(container) {
    this._c      = container;
    this._paused = false;
    this._filter = { search: '', type: '' };
    this._built  = false;
    this._vlist  = null;
    this._items  = [];
  }

  PanelTimeline.prototype.init = function () {
    var Ren  = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '📊 Event Timeline' }),
      Ren.el('input', { cls: 'dbg-input', id: 'tl-search', placeholder: 'Search events…', type: 'text' }),
      Ren.el('input', { cls: 'dbg-input', id: 'tl-type',   placeholder: 'Event type filter…', type: 'text' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-pause',   text: 'Pause' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-snapshot', text: 'Snapshot' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tl-export',  text: 'Export' }),
    ]);

    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'tl-metrics' });
    var listEl  = Ren.el('div', { id: 'tl-list', style: 'height:440px;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(metrics);
    this._c.appendChild(listEl);

    // VirtualList — 28px row height
    var Ren2 = Ren;
    this._vlist = new Ren.VirtualList(listEl, 28, function (ev, i) {
      var family = (ev.type || '').split(':')[0];
      var color  = FAMILY_COLORS[family] || '#aaa';
      var row = Ren2.el('div', { cls: 'tl-row', style: 'border-left:3px solid ' + color });
      row.appendChild(Ren2.el('span', { cls: 'tl-ts',   text: Ren2.fmtTs(ev.ts) }));
      row.appendChild(Ren2.el('span', { cls: 'tl-type', text: ev.type || '—' }));
      if (ev.toolId) row.appendChild(Ren2.el('span', { cls: 'tl-tool', text: '[' + ev.toolId + ']' }));
      return row;
    });

    // Controls
    toolbar.querySelector('#tl-pause').addEventListener('click', function (e) {
      self._paused = !self._paused;
      e.target.textContent = self._paused ? 'Resume' : 'Pause';
      e.target.classList.toggle('dbg-btn-active', self._paused);
    });

    toolbar.querySelector('#tl-search').addEventListener('input', function (e) {
      self._filter.search = e.target.value.toLowerCase();
      self._applyFilter();
    });

    toolbar.querySelector('#tl-type').addEventListener('input', function (e) {
      self._filter.type = e.target.value.toLowerCase();
      self._applyFilter();
    });

    toolbar.querySelector('#tl-snapshot').addEventListener('click', function () {
      var ET = G.RuntimeEventTimeline;
      if (!ET) return;
      var snap = ET.snapshot();
      alert('Snapshot taken: ' + (snap && snap.id ? snap.id : 'ok'));
    });

    toolbar.querySelector('#tl-export').addEventListener('click', function () {
      var ET = G.RuntimeEventTimeline;
      var Ex = G.RuntimeDebugExport;
      if (ET && Ex) Ex.exportJson(ET.search({}), 'timeline');
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(listEl);
  };

  PanelTimeline.prototype._applyFilter = function () {
    var search = this._filter.search;
    var type   = this._filter.type;
    var items  = this._items.filter(function (ev) {
      if (type   && (ev.type   || '').toLowerCase().indexOf(type)   === -1) return false;
      if (search && (ev.type   || '').toLowerCase().indexOf(search) === -1 &&
                    (ev.toolId || '').toLowerCase().indexOf(search) === -1) return false;
      return true;
    });
    if (this._vlist) this._vlist.setItems(items.slice().reverse());
  };

  PanelTimeline.prototype.refresh = function () {
    if (!this._built || this._paused) return;
    var ET  = G.RuntimeEventTimeline;
    var TE  = G.RuntimeTraceEngine;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Metrics
    var metricsEl = this._c.querySelector('#tl-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      if (ET) {
        var m = ET.getMetrics();
        [
          ['Events', ET.getCount()],
          ['Captured', m.captured || 0],
          ['Bursts',   m.bursts   || 0],
          ['Groups',   m.groups   || 0],
        ].forEach(function (pair) {
          metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
        });
      }
      if (TE) {
        var ts = TE.getStats();
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Traces: ' + (ts.total || 0) }));
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Slow: '   + (ts.slowPaths || 0) }));
      }
    }

    // Items
    if (ET) {
      this._items = ET.search({}) || [];
      this._applyFilter();
    }
  };

  G.PanelTimeline = PanelTimeline;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-blackbox.js ──
(function (G) {
  'use strict';
  if (G.PanelBlackbox) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelBlackbox]';

  function PanelBlackbox(container) {
    this._c     = container;
    this._built = false;
  }

  PanelBlackbox.prototype.init = function () {
    var Ren  = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '⚫ Blackbox Recorder' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-pause',   text: 'Pause Recording' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-export',  text: 'Export Buffer' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-replay',  text: 'Send to Replay' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'bb-session', text: 'Save Session' }),
    ]);

    // Buffer gauge
    var gaugeWrap = Ren.el('div', { cls: 'panel-metrics', id: 'bb-gauge-wrap' });

    // Metrics strip
    var metrics = Ren.el('div', { cls: 'panel-metrics', id: 'bb-metrics' });

    // Sessions list
    var sessTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Saved Sessions' });
    var sessList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-sessions', style: 'max-height:120px;overflow-y:auto;' });

    // Recent exports
    var expTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Exports' });
    var expList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-exports', style: 'max-height:120px;overflow-y:auto;' });

    // Event preview
    var evTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Buffer Preview (last 20 events)' });
    var evList   = Ren.el('div', { cls: 'panel-list-wrap', id: 'bb-evlist', style: 'height:240px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(gaugeWrap);
    this._c.appendChild(metrics);
    this._c.appendChild(sessTitle);
    this._c.appendChild(sessList);
    this._c.appendChild(expTitle);
    this._c.appendChild(expList);
    this._c.appendChild(evTitle);
    this._c.appendChild(evList);

    // Controls
    var _paused = false;
    toolbar.querySelector('#bb-pause').addEventListener('click', function (e) {
      var BB = G.RuntimeBlackbox;
      if (!BB) return;
      _paused = !_paused;
      _paused ? BB.pause() : BB.resume();
      e.target.textContent = _paused ? 'Resume Recording' : 'Pause Recording';
    });

    toolbar.querySelector('#bb-export').addEventListener('click', function () {
      var BB = G.RuntimeBlackbox;
      var Ex = G.RuntimeDebugExport;
      if (!BB || !Ex) return;
      var result = BB.export('manual-' + Date.now().toString(36));
      if (result && result.url) {
        var a = document.createElement('a');
        a.href = result.url; a.download = 'blackbox-' + Date.now().toString(36) + '.json';
        a.click();
      }
    });

    toolbar.querySelector('#bb-replay').addEventListener('click', function () {
      var BB = G.RuntimeBlackbox;
      if (!BB) return;
      var count = BB.handoffToReplay({ lastMinutes: 5 });
      alert('Sent ' + count + ' events to RuntimeReplayEngine.');
    });

    toolbar.querySelector('#bb-session').addEventListener('click', function () {
      var BB    = G.RuntimeBlackbox;
      if (!BB) return;
      var label = 'session-' + Date.now().toString(36);
      BB.saveSession(label);
      alert('Session saved: ' + label);
      self.refresh();
    });

    this._built = true;
    if (G.RuntimeDebugMobile) G.RuntimeDebugMobile.makeTouchScrollable(evList);
  };

  PanelBlackbox.prototype.refresh = function () {
    if (!this._built) return;
    var BB  = G.RuntimeBlackbox;
    var RE  = G.RuntimeReplayEngine;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren || !BB) return;

    var m       = BB.getMetrics();
    var count   = BB.getCount();
    var CAP     = 10000;

    // Gauge
    var gaugeEl = this._c.querySelector('#bb-gauge-wrap');
    if (gaugeEl) {
      var pct = Math.round(count / CAP * 100);
      gaugeEl.innerHTML = '';
      var bar = Ren.el('div', { cls: 'bb-gauge-bar', style: 'width:' + pct + '%;background:' + (pct > 80 ? '#f44' : pct > 50 ? '#fa0' : '#4af') + ';height:8px;border-radius:4px;' });
      var wrap = Ren.el('div', { style: 'background:#333;border-radius:4px;overflow:hidden;flex:1;margin:0 8px;' }, [bar]);
      gaugeEl.appendChild(Ren.el('span', { text: 'Buffer: ' }));
      gaugeEl.appendChild(wrap);
      gaugeEl.appendChild(Ren.el('span', { text: count + '/' + CAP + ' (' + pct + '%)' }));
    }

    // Metrics
    var metricsEl = this._c.querySelector('#bb-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = '';
      [
        ['Events',    count],
        ['Recorded',  m.recorded  || 0],
        ['Evicted',   m.evicted   || 0],
        ['Exported',  m.exported  || 0],
        ['Sessions',  BB.getSessions().length],
        ['Panics',    m.panics    || 0],
        ['P0 Exports', m.p0exports || 0],
      ].forEach(function (pair) {
        metricsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Sessions
    var sessEl = this._c.querySelector('#bb-sessions');
    if (sessEl) {
      sessEl.innerHTML = '';
      BB.getSessions().forEach(function (sess) {
        var row = Ren.el('div', { cls: 'bb-sess-row' }, [
          Ren.el('span', { text: sess.label || sess.id }),
          Ren.el('span', { cls: 'metric-chip', text: (sess.count || 0) + ' events' }),
          Ren.el('span', { text: Ren.fmtTs(sess.ts) }),
        ]);
        sessEl.appendChild(row);
      });
      if (!BB.getSessions().length) {
        sessEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No saved sessions.' }));
      }
    }

    // Event preview
    var evEl = this._c.querySelector('#bb-evlist');
    if (evEl) {
      evEl.innerHTML = '';
      var events = BB.query({}) || [];
      events.slice(-20).reverse().forEach(function (ev) {
        var row = Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(ev.ts) }),
          Ren.el('span', { cls: 'tl-type', text: ev.type || '—' }),
        ]);
        evEl.appendChild(row);
      });
    }
  };

  G.PanelBlackbox = PanelBlackbox;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-recovery.js ──
(function (G) {
  'use strict';
  if (G.PanelRecovery) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelRecovery]';

  function PanelRecovery(container) {
    this._c     = container;
    this._built = false;
  }

  PanelRecovery.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🔄 Recovery & Healing' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-simulate', text: 'Simulate Recovery' }),
      Ren.el('button', { cls: 'dbg-btn dbg-btn-warn', id: 'rec-safemode', text: 'Enter Safe Mode' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-exit-safe', text: 'Exit Safe Mode' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'rec-export', text: 'Export History' }),
    ]);

    // Status strip
    var status   = Ren.el('div', { cls: 'panel-metrics', id: 'rec-status' });

    // Dep graph
    var graphTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Subsystem Recovery Order' });
    var graphEl    = Ren.el('div', { cls: 'rec-graph', id: 'rec-graph', style: 'overflow-x:auto;padding:8px 0;' });

    // Healing actions
    var healTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Healing Actions' });
    var healList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-heals', style: 'max-height:160px;overflow-y:auto;' });

    // Recovery history
    var histTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recovery History' });
    var histList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-history', style: 'max-height:160px;overflow-y:auto;' });

    // Governance quarantine
    var govTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Governance Violations' });
    var govList   = Ren.el('div', { cls: 'panel-list-wrap', id: 'rec-gov', style: 'max-height:120px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(status);
    this._c.appendChild(graphTitle);
    this._c.appendChild(graphEl);
    this._c.appendChild(healTitle);
    this._c.appendChild(healList);
    this._c.appendChild(histTitle);
    this._c.appendChild(histList);
    this._c.appendChild(govTitle);
    this._c.appendChild(govList);

    // Controls
    toolbar.querySelector('#rec-simulate').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('RuntimeRecoveryOrchestrator not available'); return; }
      var result = RO.simulate({ reason: 'debug-panel-simulate' });
      var steps  = result && result.steps ? result.steps.length : 'N/A';
      alert('Simulation complete: ' + steps + ' recovery steps planned.');
    });

    toolbar.querySelector('#rec-safemode').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('Not available'); return; }
      if (confirm('Enter safe mode? This disables optimizer + predictive loader.')) {
        RO.enterSafeMode();
      }
    });

    toolbar.querySelector('#rec-exit-safe').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      if (!RO) { alert('Not available'); return; }
      RO.exitSafeMode();
    });

    toolbar.querySelector('#rec-export').addEventListener('click', function () {
      var RO = G.RuntimeRecoveryOrchestrator;
      var Ex = G.RuntimeDebugExport;
      if (RO && Ex) Ex.exportJson(RO.getHistory(), 'recovery-history');
    });

    this._built = true;
  };

  PanelRecovery.prototype.refresh = function () {
    if (!this._built) return;
    var RO  = G.RuntimeRecoveryOrchestrator;
    var AH  = G.RuntimeAutonomousHealing;
    var Gov = G.RuntimeGovernance;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Status
    var statusEl = this._c.querySelector('#rec-status');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (RO) {
        var stats    = RO.getStats();
        var safeMode = RO.isSafeMode();
        var active   = RO.getActive();
        [
          ['Safe Mode', safeMode ? '🔴 YES' : '🟢 No'],
          ['Active Recovery', active ? '⚡ Running' : 'Idle'],
          ['Total Recoveries', stats.total || 0],
          ['Subsystems', RO.getRecoveryOrder().length],
        ].forEach(function (pair) {
          statusEl.appendChild(Ren.el('span', { cls: 'metric-chip' + (pair[1] === '🔴 YES' ? ' chip-warn' : ''), text: pair[0] + ': ' + pair[1] }));
        });
      }
      if (AH) {
        var ahState = AH.getState();
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Heals: ' + (ahState.stats && ahState.stats.total || 0) }));
        statusEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: 'Rollbacks: ' + (ahState.stats && ahState.stats.rollbacks || 0) }));
      }
    }

    // Dep graph (compact chip row)
    var graphEl = this._c.querySelector('#rec-graph');
    if (graphEl && RO) {
      graphEl.innerHTML = '';
      var order = RO.getRecoveryOrder();
      order.forEach(function (id, i) {
        var chip = Ren.el('span', { cls: 'rec-chip', text: (i + 1) + '. ' + id, style: 'margin:2px;display:inline-block;' });
        graphEl.appendChild(chip);
        if (i < order.length - 1) graphEl.appendChild(Ren.el('span', { text: '→', style: 'color:#888;margin:0 2px;' }));
      });
    }

    // Healing actions
    var healEl = this._c.querySelector('#rec-heals');
    if (healEl && AH) {
      healEl.innerHTML = '';
      var heals = AH.getTelemetry().slice(-20).reverse();
      if (!heals.length) {
        healEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No healing actions recorded.' }));
      } else {
        heals.forEach(function (h) {
          healEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(h.ts) }),
            Ren.el('span', { cls: 'tl-type', text: h.phase + ' · ' + (h.category || '—') }),
            Ren.el('span', { cls: h.ok === false ? 'chip-warn' : 'metric-chip', text: h.ok === false ? '✗ fail' : '✓ ok' }),
          ]));
        });
      }
    }

    // Recovery history
    var histEl = this._c.querySelector('#rec-history');
    if (histEl && RO) {
      histEl.innerHTML = '';
      var history = RO.getHistory().slice(-10).reverse();
      if (!history.length) {
        histEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No recoveries recorded.' }));
      } else {
        history.forEach(function (h) {
          histEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(h.ts) }),
            Ren.el('span', { cls: 'tl-type', text: h.reason || '—' }),
            Ren.el('span', { cls: 'metric-chip', text: (h.steps || []).length + ' steps' }),
            Ren.el('span', { cls: h.ok ? 'metric-chip' : 'chip-warn', text: h.ok ? '✓' : '✗' }),
          ]));
        });
      }
    }

    // Governance
    var govEl = this._c.querySelector('#rec-gov');
    if (govEl && Gov) {
      govEl.innerHTML = '';
      var violations = Gov.getViolations().slice(-10).reverse();
      if (!violations.length) {
        govEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No governance violations.' }));
      } else {
        violations.forEach(function (v) {
          govEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(v.ts) }),
            Ren.el('span', { cls: 'tl-type', text: v.policy + ': ' + (v.msg || '') }),
          ]));
        });
      }
    }
  };

  G.PanelRecovery = PanelRecovery;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-performance.js ──
(function (G) {
  'use strict';
  if (G.PanelPerformance) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelPerformance]';

  function PanelPerformance(container) {
    this._c         = container;
    this._built     = false;
    this._heapHist  = [];
    this._fpsHist   = [];
    this._qHist     = {};
  }

  PanelPerformance.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '⚡ Performance & Workload' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'perf-export', text: 'Export Profile' }),
    ]);

    // Perf metrics
    var perfMetrics = Ren.el('div', { cls: 'panel-metrics', id: 'perf-metrics' });

    // Heap sparkline
    var heapSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Heap Usage (MB)' }),
      Ren.el('div', { id: 'perf-heap-spark' }),
    ]);

    // Session stability
    var stabSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Session Stability' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-stability' }),
    ]);

    // Workload section
    var wlSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Workload Intelligence' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-workload' }),
    ]);

    // AI section
    var aiSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Adaptive AI Predictions' }),
      Ren.el('div', { cls: 'panel-metrics', id: 'perf-ai' }),
    ]);

    // Bundle dormancy
    var bundSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Bundle Usage' }),
      Ren.el('div', { cls: 'panel-list-wrap', id: 'perf-bundles', style: 'max-height:120px;overflow-y:auto;' }),
    ]);

    // Top tools
    var toolSection = Ren.el('div', { cls: 'panel-section' }, [
      Ren.el('div', { cls: 'panel-subtitle', text: 'Top Tools (AI Model)' }),
      Ren.el('div', { cls: 'panel-list-wrap', id: 'perf-tools', style: 'max-height:120px;overflow-y:auto;' }),
    ]);

    this._c.appendChild(toolbar);
    this._c.appendChild(perfMetrics);
    this._c.appendChild(heapSection);
    this._c.appendChild(stabSection);
    this._c.appendChild(wlSection);
    this._c.appendChild(aiSection);
    this._c.appendChild(bundSection);
    this._c.appendChild(toolSection);

    toolbar.querySelector('#perf-export').addEventListener('click', function () {
      var PP = G.RuntimePerformanceProfiler;
      var Ex = G.RuntimeDebugExport;
      if (PP && Ex) Ex.exportJson(PP.getProfile(), 'performance-profile');
    });

    this._built = true;
  };

  PanelPerformance.prototype.refresh = function () {
    if (!this._built) return;
    var PP  = G.RuntimePerformanceProfiler;
    var WI  = G.RuntimeWorkloadIntelligence;
    var SS  = G.RuntimeSessionStability;
    var AI  = G.RuntimeAdaptiveAI;
    var AB  = G.RuntimeAdaptiveBundles;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Perf metrics
    var pmEl = this._c.querySelector('#perf-metrics');
    if (pmEl && PP) {
      pmEl.innerHTML = '';
      var m = PP.getMetrics();
      [
        ['FPS',          m.fps        || '—'],
        ['Frame Drops',  m.frameDrops || 0],
        ['LongTasks',    m.longTasks  || 0],
        ['Heap MB',      m.heapMb     ? m.heapMb.toFixed(1) : '—'],
        ['Heap Limit MB',m.heapLimitMb ? m.heapLimitMb.toFixed(1) : '—'],
        ['Samples',      m.samples    || 0],
      ].forEach(function (pair) {
        pmEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });

      // Track sparkline history
      if (m.heapMb) { this._heapHist.push(m.heapMb); if (this._heapHist.length > 60) this._heapHist.shift(); }
      if (m.fps)    { this._fpsHist.push(m.fps);      if (this._fpsHist.length  > 60) this._fpsHist.shift(); }
    }

    // Heap sparkline
    var sparkEl = this._c.querySelector('#perf-heap-spark');
    if (sparkEl && this._heapHist.length > 1) {
      sparkEl.innerHTML = '';
      sparkEl.appendChild(Ren.sparkline(this._heapHist, 280, 40, '#4af'));
      sparkEl.appendChild(Ren.el('span', { style: 'margin-left:8px;font-size:11px;color:#aaa;', text: 'Last ' + this._heapHist.length + ' samples' }));
    }

    // Session stability
    var stabEl = this._c.querySelector('#perf-stability');
    if (stabEl && SS) {
      stabEl.innerHTML = '';
      var st = SS.getState();
      var LEVEL_COLORS = ['#4af', '#4fa', '#fa0', '#f84', '#f44'];
      [
        ['Age',         Math.floor(st.ageMin || 0) + ' min'],
        ['Tier',        st.ageTier || '—'],
        ['Level',       st.levelName || '—'],
        ['Heap Rate',   st.heapRate  ? st.heapRate.toFixed(2) + ' MB/min'    : '—'],
        ['Event Rate',  st.eventRate ? st.eventRate.toFixed(1) + ' ev/min'   : '—'],
        ['Incident Rate', st.incidentRate ? st.incidentRate.toFixed(2) + '/min' : '—'],
        ['Sweeps',      st.sweeps || 0],
      ].forEach(function (pair) {
        var extra = (pair[0] === 'Level') ? ';background:' + (LEVEL_COLORS[st.level] || '#aaa') : '';
        stabEl.appendChild(Ren.el('span', { cls: 'metric-chip', style: extra, text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Workload
    var wlEl = this._c.querySelector('#perf-workload');
    if (wlEl && WI) {
      wlEl.innerHTML = '';
      var ws = WI.getState();
      var families = WI.getFamilies();
      [
        ['Running',   ws.running   || 0],
        ['Throttled', ws.throttled || 0],
        ['Starved',   ws.starved   || 0],
      ].forEach(function (pair) {
        wlEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      Object.keys(families).forEach(function (fam) {
        var f = families[fam];
        wlEl.appendChild(Ren.el('span', {
          cls:  'metric-chip',
          text: fam + ': Q=' + (f.queue || 0) + ' R=' + (f.running || 0) + ' T=' + (f.thermal || 0),
        }));
      });
    }

    // Adaptive AI
    var aiEl = this._c.querySelector('#perf-ai');
    if (aiEl && AI) {
      aiEl.innerHTML = '';
      var tier    = AI.getDeviceTier();
      var thermal = AI.predictThermal();
      [
        ['Device Tier', tier],
        ['Predicted Thermal', thermal],
        ['Should Throttle', AI.shouldThrottle ? AI.shouldThrottle('?') : '—'],
      ].forEach(function (pair) {
        aiEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
      // Top 5 tools
      var tops = AI.getTopTools ? AI.getTopTools(5) : [];
      if (tops.length) {
        aiEl.appendChild(Ren.el('span', { text: '  Top tools: ' }));
        tops.forEach(function (t) {
          aiEl.appendChild(Ren.el('span', { cls: 'rec-chip', text: t.id + ' ×' + t.count }));
        });
      }
    }

    // Bundle dormancy
    var bundEl = this._c.querySelector('#perf-bundles');
    if (bundEl && AB) {
      bundEl.innerHTML = '';
      var dormant = AB.getDormantBundles ? AB.getDormantBundles() : [];
      var plan    = AB.getBundlePlan ? AB.getBundlePlan() : null;
      if (plan) {
        bundEl.appendChild(Ren.el('div', { cls: 'tl-row', text: 'Device plan: ' + plan.tier }));
      }
      if (!dormant.length) {
        bundEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No dormant bundles.' }));
      } else {
        dormant.forEach(function (b) {
          bundEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'chip-warn', text: '💤 Dormant: ' + b }),
          ]));
        });
      }
    }

    // Top tools AI model
    var toolEl = this._c.querySelector('#perf-tools');
    if (toolEl && AI && AI.getTopTools) {
      toolEl.innerHTML = '';
      var tools = AI.getTopTools(10);
      if (!tools.length) {
        toolEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No tool usage data yet.' }));
      } else {
        tools.forEach(function (t) {
          toolEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: t.id }),
            Ren.el('span', { cls: 'metric-chip', text: 'session ×' + t.sessionCount }),
            Ren.el('span', { cls: 'metric-chip', text: 'lifetime ×' + t.lifetimeCount }),
          ]));
        });
      }
    }
  };

  G.PanelPerformance = PanelPerformance;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-control.js ──
(function (G) {
  'use strict';
  if (G.PanelControl) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelControl]';

  function PanelControl(container) {
    this._c     = container;
    this._built = false;
  }

  PanelControl.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🎛️ Control Plane & Governance' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ctrl-sweep',  text: 'Run Governance Sweep' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ctrl-export', text: 'Export Flags & Audit' }),
    ]);

    // Flags
    var flagsTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Runtime Flags' });
    var flagsList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-flags', style: 'max-height:200px;overflow-y:auto;' });

    // Protected flags
    var protTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Protected Flags (Governance)' });
    var protList  = Ren.el('div', { cls: 'panel-metrics', id: 'ctrl-protected' });

    // Quarantine
    var quarTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Quarantine Registry' });
    var quarList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-quarantine', style: 'max-height:120px;overflow-y:auto;' });

    // Command audit trail
    var auditTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Command Audit Trail (last 20)' });
    var auditList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-audit', style: 'max-height:200px;overflow-y:auto;' });

    // Safe command executor
    var execTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Execute Safe Command' });
    var execSec    = G.RuntimeDebugSecurity;
    var execRow    = Ren.el('div', { cls: 'panel-metrics', style: 'flex-wrap:wrap;gap:6px;' });
    if (execSec) {
      execSec.SAFE_COMMANDS.forEach(function (cmd) {
        var btn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: cmd });
        btn.addEventListener('click', function () {
          var CP = G.RuntimeControlPlane;
          if (!CP) { alert('RuntimeControlPlane not available'); return; }
          if (!execSec.checkRate('command', 20)) { alert('Rate limit: max 20 commands/min'); return; }
          var result = CP.execute(cmd, {});
          alert(cmd + ': ' + JSON.stringify(result && result.ok !== undefined ? { ok: result.ok } : result));
        });
        execRow.appendChild(btn);
      });
    }

    // Governance policies
    var policiesTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Governance Policies' });
    var policiesList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-policies', style: 'max-height:160px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(flagsTitle);
    this._c.appendChild(flagsList);
    this._c.appendChild(protTitle);
    this._c.appendChild(protList);
    this._c.appendChild(quarTitle);
    this._c.appendChild(quarList);
    this._c.appendChild(auditTitle);
    this._c.appendChild(auditList);
    this._c.appendChild(execTitle);
    this._c.appendChild(execRow);
    this._c.appendChild(policiesTitle);
    this._c.appendChild(policiesList);

    toolbar.querySelector('#ctrl-sweep').addEventListener('click', function () {
      var Gov = G.RuntimeGovernance;
      if (!Gov) { alert('RuntimeGovernance not available'); return; }
      Gov.sweep();
      self.refresh();
    });

    toolbar.querySelector('#ctrl-export').addEventListener('click', function () {
      var CP  = G.RuntimeControlPlane;
      var Gov = G.RuntimeGovernance;
      var Ex  = G.RuntimeDebugExport;
      if (!Ex) return;
      Ex.exportJson({
        flags:      CP  ? CP.getFlags()     : {},
        audit:      CP  ? CP.getAudit()     : [],
        violations: Gov ? Gov.getViolations() : [],
        quarantine: Gov ? Gov.getQuarantined() : {},
      }, 'control-plane-snapshot');
    });

    this._built = true;
  };

  PanelControl.prototype.refresh = function () {
    if (!this._built) return;
    var CP  = G.RuntimeControlPlane;
    var Gov = G.RuntimeGovernance;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Flags
    var flagsEl = this._c.querySelector('#ctrl-flags');
    if (flagsEl && CP) {
      flagsEl.innerHTML = '';
      var flags = CP.getFlags();
      var keys  = Object.keys(flags);
      if (!keys.length) {
        flagsEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No flags registered.' }));
      } else {
        keys.forEach(function (k) {
          var val = flags[k];
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: k }),
            Ren.el('span', { cls: val ? 'metric-chip' : 'chip-warn', text: String(val) }),
          ]);
          // Toggle button (only for non-protected flags)
          var prot = Gov ? Gov.getProtectedFlags() : [];
          var isProtected = prot.some(function (p) {
            return typeof p === 'object' ? k.indexOf(p.flag || '') !== -1 : false;
          });
          if (!isProtected) {
            var tBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Toggle' });
            tBtn.addEventListener('click', function () {
              CP.setFlag(k, !CP.getFlag(k));
            });
            row.appendChild(tBtn);
          } else {
            row.appendChild(Ren.el('span', { cls: 'chip-warn', text: '🔒 Protected' }));
          }
          flagsEl.appendChild(row);
        });
      }
    }

    // Protected flags
    var protEl = this._c.querySelector('#ctrl-protected');
    if (protEl && Gov) {
      protEl.innerHTML = '';
      Gov.getProtectedFlags().forEach(function (p) {
        var label = typeof p === 'object' ? (p.flag || JSON.stringify(p)) : String(p);
        protEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: '🔒 ' + label }));
      });
    }

    // Quarantine
    var quarEl = this._c.querySelector('#ctrl-quarantine');
    if (quarEl && Gov) {
      quarEl.innerHTML = '';
      var q = Gov.getQuarantined();
      var qKeys = Object.keys(q);
      if (!qKeys.length) {
        quarEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No quarantined subsystems.' }));
      } else {
        qKeys.forEach(function (id) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'chip-warn', text: '🚫 ' + id }),
            Ren.el('span', { text: ' — ' + (q[id] || '') }),
          ]);
          var liftBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Lift' });
          liftBtn.addEventListener('click', function () { Gov.lift(id); });
          row.appendChild(liftBtn);
          quarEl.appendChild(row);
        });
      }
    }

    // Audit trail
    var auditEl = this._c.querySelector('#ctrl-audit');
    if (auditEl && CP) {
      auditEl.innerHTML = '';
      var audits = CP.getAudit().slice(-20).reverse();
      if (!audits.length) {
        auditEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No commands executed yet.' }));
      } else {
        audits.forEach(function (a) {
          auditEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(a.ts) }),
            Ren.el('span', { cls: 'tl-type', text: a.cmd || '—' }),
            Ren.el('span', { cls: a.ok ? 'metric-chip' : 'chip-warn', text: a.ok ? '✓' : '✗' }),
          ]));
        });
      }
    }

    // Governance policies
    var polEl = this._c.querySelector('#ctrl-policies');
    if (polEl && Gov) {
      polEl.innerHTML = '';
      Gov.getPolicies().forEach(function (p) {
        polEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: p.id }),
          Ren.el('span', { text: ' — ' + p.desc }),
        ]));
      });
    }
  };

  G.PanelControl = PanelControl;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// ── SOURCE: public/js/debug-panels/panel-traces.js ──
(function (G) {
  'use strict';
  if (G.PanelTraces) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelTraces]';

  function PanelTraces(container) {
    this._c     = container;
    this._built = false;
    this._diffA = null;
    this._diffB = null;
  }

  PanelTraces.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🔍 Traces & Snapshots' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tr-export-snaps', text: 'Export Snapshots' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'tr-take-snap',   text: 'Take Snapshot Now' }),
    ]);

    // Trace stats
    var statsSection = Ren.el('div', { cls: 'panel-metrics', id: 'tr-stats' });

    // Active traces
    var activeTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Active Traces' });
    var activeList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-active', style: 'max-height:100px;overflow-y:auto;' });

    // Trace telemetry — slow paths
    var slowTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Recent Traces (slow paths highlighted)' });
    var slowList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-slow', style: 'height:200px;overflow-y:auto;' });

    // Snapshots
    var snapTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Snapshots' });
    var snapList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'tr-snaps', style: 'max-height:200px;overflow-y:auto;' });

    // Diff area
    var diffTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Snapshot Diff (select two)' });
    var diffArea  = Ren.el('pre', { id: 'tr-diff', style: 'background:#1a1a2e;padding:8px;border-radius:4px;overflow:auto;max-height:200px;font-size:11px;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(statsSection);
    this._c.appendChild(activeTitle);
    this._c.appendChild(activeList);
    this._c.appendChild(slowTitle);
    this._c.appendChild(slowList);
    this._c.appendChild(snapTitle);
    this._c.appendChild(snapList);
    this._c.appendChild(diffTitle);
    this._c.appendChild(diffArea);

    toolbar.querySelector('#tr-export-snaps').addEventListener('click', function () {
      var SS = G.RuntimeStateSnapshots;
      var Ex = G.RuntimeDebugExport;
      if (SS && Ex) Ex.exportJson(SS.list(), 'snapshots-list');
    });

    toolbar.querySelector('#tr-take-snap').addEventListener('click', function () {
      var SS = G.RuntimeStateSnapshots;
      if (!SS) { alert('RuntimeStateSnapshots not available'); return; }
      var s = SS.take('manual-debug', false);
      alert('Snapshot taken: ' + (s && s.id ? s.id : 'ok'));
    });

    this._built = true;
  };

  PanelTraces.prototype.refresh = function () {
    if (!this._built) return;
    var TE  = G.RuntimeTraceEngine;
    var SS  = G.RuntimeStateSnapshots;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    // Stats
    var statsEl = this._c.querySelector('#tr-stats');
    if (statsEl && TE) {
      statsEl.innerHTML = '';
      var stats = TE.getStats();
      [
        ['Total Traces',  stats.total     || 0],
        ['Active',        Object.keys(TE.getActive()).length],
        ['Slow Paths',    stats.slowPaths  || 0],
        ['p50 ms',        stats.p50        ? stats.p50.toFixed(1) : '—'],
        ['p90 ms',        stats.p90        ? stats.p90.toFixed(1) : '—'],
        ['p99 ms',        stats.p99        ? stats.p99.toFixed(1) : '—'],
      ].forEach(function (pair) {
        statsEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: pair[0] + ': ' + pair[1] }));
      });
    }

    // Active traces
    var activeEl = this._c.querySelector('#tr-active');
    if (activeEl && TE) {
      activeEl.innerHTML = '';
      var active = TE.getActive();
      var ids    = Object.keys(active);
      if (!ids.length) {
        activeEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No active traces.' }));
      } else {
        ids.forEach(function (id) {
          var tr = active[id];
          activeEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: tr.name || id }),
            Ren.el('span', { cls: 'metric-chip', text: Math.round(Date.now() - (tr.startTs || Date.now())) + 'ms' }),
          ]));
        });
      }
    }

    // Slow traces from telemetry
    var slowEl = this._c.querySelector('#tr-slow');
    if (slowEl && TE) {
      slowEl.innerHTML = '';
      var tels = TE.getTelemetry().slice(-30).reverse();
      if (!tels.length) {
        slowEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No traces recorded.' }));
      } else {
        tels.forEach(function (tr) {
          var isSlow = tr.durationMs && tr.durationMs > 500;
          slowEl.appendChild(Ren.el('div', { cls: 'tl-row' + (isSlow ? ' tr-slow' : '') }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(tr.ts) }),
            Ren.el('span', { cls: 'tl-type', text: tr.name || '—' }),
            Ren.el('span', { cls: isSlow ? 'chip-warn' : 'metric-chip', text: (tr.durationMs || 0) + 'ms' }),
            isSlow ? Ren.el('span', { text: ' ⚠ SLOW' }) : null,
          ].filter(Boolean)));
        });
      }
    }

    // Snapshots
    var snapEl = this._c.querySelector('#tr-snaps');
    if (snapEl && SS) {
      snapEl.innerHTML = '';
      var snaps = SS.list().slice().reverse();
      if (!snaps.length) {
        snapEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No snapshots taken.' }));
      } else {
        snaps.forEach(function (s) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(s.ts) }),
            Ren.el('span', { cls: 'tl-type', text: s.label || s.id }),
            s.isCheckpoint ? Ren.el('span', { cls: 'metric-chip', text: '📌 checkpoint' }) : null,
            Ren.el('span', { cls: 'metric-chip', text: 'crc: ' + (s.checksum || '—').slice(0, 8) }),
          ].filter(Boolean));

          // Select for diff
          var selABtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'A' });
          var selBBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'B' });
          selABtn.addEventListener('click', function () { self._diffA = s.id; self._runDiff(); });
          selBBtn.addEventListener('click', function () { self._diffB = s.id; self._runDiff(); });

          // Export snapshot
          var expBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Export' });
          expBtn.addEventListener('click', function () {
            var Ex = G.RuntimeDebugExport;
            var full = SS.get(s.id);
            if (Ex && full) Ex.exportJson(full, 'snapshot-' + s.id);
          });

          row.appendChild(selABtn);
          row.appendChild(selBBtn);
          row.appendChild(expBtn);
          snapEl.appendChild(row);
        });
      }
    }
  };

  PanelTraces.prototype._runDiff = function () {
    var SS      = G.RuntimeStateSnapshots;
    var Ren     = G.RuntimeDebugRenderer;
    var diffEl  = this._c.querySelector('#tr-diff');
    if (!SS || !Ren || !diffEl || !this._diffA || !this._diffB) {
      if (diffEl) diffEl.textContent = 'Select snapshot A and B to diff.';
      return;
    }
    try {
      var result = SS.diff(this._diffA, this._diffB);
      diffEl.textContent = JSON.stringify(result, null, 2).slice(0, 3000);
    } catch (e) {
      diffEl.textContent = 'Diff error: ' + e.message;
    }
  };

  G.PanelTraces = PanelTraces;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

