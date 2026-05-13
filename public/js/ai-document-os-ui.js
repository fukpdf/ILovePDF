/**
 * PHASE 52 — AI DOCUMENT OS UI
 * window.AiDocumentOSUI
 *
 * Transforms UX into an operating system experience.
 * Disables all preview system logic (LivePreview, PdfPreview).
 * Provides dockable panels: AI sidebar, workflow timeline, semantic search,
 * document graph, memory explorer, GPU/distributed monitors.
 * Purely additive. No changes to existing tool processing.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[AOSU]';

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  // HTML-escape any user-controlled string before injecting into innerHTML
  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  PREVIEW SYSTEM DISABLER
  // Replaces LivePreview and PdfPreview mounts with no-ops.
  // Original modules remain loaded and technically intact — we shadow their
  // public mount API so no preview DOM is injected. Processing is unaffected.
  // ═══════════════════════════════════════════════════════════════════════════
  var PreviewDisabler = (function () {
    var _disabled = false;

    function disable() {
      if (_disabled) return;

      // LivePreview — shadow mount() to a no-op
      var LP = window.LivePreview;
      if (LP) {
        var _origMount     = LP.mount;
        var _origSupported = LP.supported;
        LP.mount     = function () { return Promise.resolve(); };
        LP.supported = function () { return false; };
        LP.__aosDisabled = true;
        LP.__aosOrigMount = _origMount;
        log('LivePreview.mount disabled');
      }

      // PdfPreview is the core PDF rendering engine (page thumbnails, organizer,
      // merge-tool previews). It must NOT be patched — patching renderPage
      // causes all tile thumbnails to silently return undefined, producing the
      // "Page X striped placeholder never replaced" bug.

      // Also hide any lingering preview DOM elements
      var selectors = ['.lp-panel','.pdf-preview-panel','#pdf-preview-root','#live-preview-root','.preview-queue-container','.preview-virtualization','.preview-pipeline-root'];
      selectors.forEach(function (s) {
        document.querySelectorAll(s).forEach(function (el) { el.style.display = 'none'; el.setAttribute('data-aos-hidden', '1'); });
      });

      _disabled = true;
      log('All preview systems disabled');
    }

    // REMOVED: watchAndSuppress MutationObserver — re-firing disable() on every DOM
    // mutation was a vector for silently re-patching production engines on navigation.
    // RuntimeProtection.js handles method immutability via writable:false instead.
    function watchAndSuppress() { /* disabled — see runtime-protection.js */ }

    function restore() {
      var LP = window.LivePreview;
      if (LP && LP.__aosOrigMount) { LP.mount = LP.__aosOrigMount; LP.supported = LP.__aosOrigSupported || LP.supported; LP.__aosDisabled = false; }
      _disabled = false;
      log('Preview systems restored');
    }

    return { disable: disable, watchAndSuppress: watchAndSuppress, restore: restore, isDisabled: function () { return _disabled; } };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  CSS INJECTION
  // ═══════════════════════════════════════════════════════════════════════════
  function _injectCSS() {
    if (document.getElementById('aosu-styles')) return;
    var s = document.createElement('style');
    s.id  = 'aosu-styles';
    s.textContent = [
      // Workspace layout
      '.aosu-workspace{position:fixed;bottom:0;left:0;right:0;z-index:8990;pointer-events:none;}',
      '.aosu-workspace.active{pointer-events:all;}',

      // Status bar (bottom)
      '#aosu-statusbar{position:fixed;bottom:0;left:0;right:0;height:24px;background:linear-gradient(90deg,#1e1b4b,#312e81);color:#c7d2fe;font-size:11px;display:flex;align-items:center;padding:0 12px;gap:16px;z-index:9001;font-family:monospace;user-select:none;}',
      '#aosu-statusbar .sb-sep{opacity:.3;margin:0 2px;}',
      '#aosu-statusbar .sb-item{display:flex;align-items:center;gap:4px;opacity:.8;transition:opacity .2s;}',
      '#aosu-statusbar .sb-item.active{opacity:1;color:#a5f3fc;}',
      '#aosu-statusbar .sb-item.warn{color:#fbbf24;}',
      '#aosu-statusbar .sb-item.error{color:#f87171;}',
      '#aosu-statusbar .sb-right{margin-left:auto;display:flex;gap:12px;align-items:center;}',

      // Panel base
      '.aosu-panel{position:fixed;background:#fff;border-radius:12px 12px 0 0;box-shadow:0 -4px 30px rgba(0,0,0,.14);z-index:9000;display:flex;flex-direction:column;overflow:hidden;transition:transform .25s cubic-bezier(.4,0,.2,1);border:1px solid #e5e7eb;border-bottom:none;}',
      '.aosu-panel.collapsed{transform:translateY(calc(100% - 32px));}',
      '.aosu-panel-header{background:#f8f7ff;border-bottom:1px solid #e5e7eb;padding:6px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;flex-shrink:0;min-height:32px;}',
      '.aosu-panel-title{font-size:12px;font-weight:600;color:#4f46e5;flex:1;}',
      '.aosu-panel-badge{background:#4f46e5;color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700;}',
      '.aosu-panel-body{flex:1;overflow-y:auto;padding:10px;scrollbar-width:thin;}',

      // Workflow panel
      '#aosu-workflow-panel{right:24px;bottom:24px;width:300px;height:200px;}',

      // Search panel
      '#aosu-search-panel{left:50%;transform:translateX(-50%);bottom:24px;width:480px;height:220px;}',
      '#aosu-search-panel.collapsed{transform:translateX(-50%) translateY(calc(100% - 32px));}',

      // GPU panel
      '#aosu-gpu-panel{right:340px;bottom:24px;width:200px;height:180px;}',

      // Memory panel
      '#aosu-memory-panel{right:556px;bottom:24px;width:200px;height:180px;}',

      // Workflow timeline
      '.aosu-timeline{display:flex;flex-direction:column;gap:6px;}',
      '.aosu-step{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:11px;}',
      '.aosu-step.done{background:#f0fdf4;color:#166534;}',
      '.aosu-step.running{background:#eff6ff;color:#1e40af;animation:aosu-pulse .8s infinite;}',
      '.aosu-step.pending{background:#f9fafb;color:#6b7280;}',
      '.aosu-step.failed{background:#fef2f2;color:#991b1b;}',
      '.aosu-step-icon{width:16px;text-align:center;}',
      '.aosu-step-label{flex:1;}',
      '.aosu-step-time{opacity:.6;}',
      '@keyframes aosu-pulse{0%,100%{opacity:1}50%{opacity:.6}}',

      // Search
      '.aosu-search-input{width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit;outline:none;}',
      '.aosu-search-input:focus{border-color:#4f46e5;}',
      '.aosu-search-results{margin-top:8px;display:flex;flex-direction:column;gap:4px;max-height:120px;overflow-y:auto;}',
      '.aosu-search-result{padding:5px 8px;background:#f8f7ff;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid transparent;transition:border .15s;}',
      '.aosu-search-result:hover{border-color:#4f46e5;}',
      '.aosu-search-result .asr-score{float:right;opacity:.5;font-size:10px;}',

      // GPU monitor
      '.aosu-gpu-stat{display:flex;justify-content:space-between;font-size:11px;padding:2px 0;}',
      '.aosu-gpu-stat .val{font-weight:600;color:#4f46e5;}',
      '.aosu-meter{height:4px;background:#e5e7eb;border-radius:2px;margin:3px 0;}',
      '.aosu-meter-fill{height:100%;background:#4f46e5;border-radius:2px;transition:width .5s;}',

      // Task monitor
      '#aosu-task-panel{left:24px;bottom:24px;width:240px;height:180px;}',
      '.aosu-task-row{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;border-bottom:1px solid #f3f4f6;}',
      '.aosu-task-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}',
      '.aosu-task-dot.active{background:#22c55e;}',
      '.aosu-task-dot.idle{background:#d1d5db;}',
      '.aosu-task-dot.error{background:#ef4444;}',

      // Panels hidden on mobile to not block UI
      '@media(max-width:640px){.aosu-panel{display:none !important;}#aosu-statusbar{font-size:9px;gap:8px;}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  WORKSPACE MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkspaceManager = (function () {
    var _panels = new Map(); // panelId → { el, collapsed }

    function register(panelId, el) {
      _panels.set(panelId, { el: el, collapsed: false });
      var hdr = el.querySelector('.aosu-panel-header');
      if (hdr) {
        hdr.addEventListener('click', function () { toggle(panelId); });
      }
    }

    function toggle(panelId) {
      var p = _panels.get(panelId);
      if (!p) return;
      p.collapsed = !p.collapsed;
      p.el.classList.toggle('collapsed', p.collapsed);
    }

    function collapse(panelId) { var p = _panels.get(panelId); if (p) { p.collapsed = true; p.el.classList.add('collapsed'); } }
    function expand(panelId)   { var p = _panels.get(panelId); if (p) { p.collapsed = false; p.el.classList.remove('collapsed'); } }

    function collapseAll() { _panels.forEach(function (p, id) { collapse(id); }); }
    function expandAll()   { _panels.forEach(function (p, id) { expand(id); }); }

    return { register: register, toggle: toggle, collapse: collapse, expand: expand, collapseAll: collapseAll, expandAll: expandAll };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  STATUS BAR
  // ═══════════════════════════════════════════════════════════════════════════
  var StatusBar = (function () {
    var _el      = null;
    var _items   = {};

    function _build() {
      _el = document.createElement('div');
      _el.id = 'aosu-statusbar';
      _el.innerHTML = [
        '<span class="sb-item" id="sb-ai">✦ AI OS</span>',
        '<span class="sb-sep">|</span>',
        '<span class="sb-item" id="sb-gpu">GPU: —</span>',
        '<span class="sb-sep">|</span>',
        '<span class="sb-item" id="sb-mem">MEM: —</span>',
        '<span class="sb-sep">|</span>',
        '<span class="sb-item" id="sb-vec">VEC: 0</span>',
        '<span class="sb-sep">|</span>',
        '<span class="sb-item" id="sb-agents">Agents: idle</span>',
        '<div class="sb-right">',
          '<span class="sb-item" id="sb-p2p">P2P: off</span>',
          '<span class="sb-sep">|</span>',
          '<span class="sb-item" id="sb-time"></span>',
        '</div>',
      ].join('');
      document.body.appendChild(_el);
      // Capture refs
      ['sb-ai','sb-gpu','sb-mem','sb-vec','sb-agents','sb-p2p','sb-time'].forEach(function (id) {
        _items[id] = document.getElementById(id);
      });
    }

    function update(id, text, cls) {
      var el = _items[id] || document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className   = 'sb-item' + (cls ? ' ' + cls : '');
    }

    function _tick() {
      update('sb-time', new Date().toLocaleTimeString());

      var WGAE = sys('WebGpuAiExpansion');
      if (WGAE) update('sb-gpu', 'GPU: ' + (WGAE.isReady() ? '✓' : '—'), WGAE.isReady() ? 'active' : '');

      var mp = sys('MemPressure') || sys('MemoryPressureMonitor');
      if (mp && typeof mp.tier === 'function') {
        var tier = mp.tier();
        update('sb-mem', 'MEM: ' + tier, tier === 'danger' || tier === 'critical' ? 'error' : tier === 'warning' ? 'warn' : '');
      }

      var VME = sys('VectorMemoryEngine');
      if (VME) { var st = VME.stats(); update('sb-vec', 'VEC: ' + st.chunks); }

      var AAS = sys('AiAgentSystem');
      if (AAS) { var active = AAS.active(); update('sb-agents', 'Agents: ' + (active.length ? active.length + ' running' : 'idle'), active.length ? 'active' : ''); }

      var P2P = sys('P2PDistributedMeshV2');
      if (P2P) update('sb-p2p', 'P2P: ' + (P2P.enabled() ? 'on' : 'off'), P2P.enabled() ? 'active' : '');
    }

    function init() { _build(); setInterval(_tick, 1000); _tick(); }
    return { init: init, update: update };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  SEMANTIC SEARCH PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  var SemanticSearchPanel = (function () {
    var _el     = null;
    var _timer  = null;

    function build() {
      _el = document.createElement('div');
      _el.className = 'aosu-panel collapsed';
      _el.id = 'aosu-search-panel';
      _el.innerHTML = [
        '<div class="aosu-panel-header">',
          '<span class="aosu-panel-title">🔍 Semantic Search</span>',
          '<span class="aosu-panel-badge" id="sp-badge">0</span>',
        '</div>',
        '<div class="aosu-panel-body">',
          '<input class="aosu-search-input" id="aosu-search-input" placeholder="Search across all documents…" autocomplete="off">',
          '<div class="aosu-search-results" id="aosu-search-results"></div>',
        '</div>',
      ].join('');
      document.body.appendChild(_el);
      WorkspaceManager.register('search-panel', _el);

      var input = _el.querySelector('#aosu-search-input');
      input.addEventListener('input', function () {
        clearTimeout(_timer);
        _timer = setTimeout(function () { _doSearch(input.value.trim()); }, 400);
      });
    }

    function _doSearch(query) {
      if (!query) { document.getElementById('aosu-search-results').innerHTML = ''; return; }
      var VME = sys('VectorMemoryEngine');
      var results = VME ? VME.search(query, null, 8) : [];
      var badge   = document.getElementById('sp-badge');
      if (badge) badge.textContent = results.length;

      var container = document.getElementById('aosu-search-results');
      if (!container) return;
      if (!results.length) { container.innerHTML = '<div style="color:#9ca3af;font-size:11px;padding:4px">No results</div>'; return; }
      container.innerHTML = results.map(function (r) {
        return '<div class="aosu-search-result" title="' + _esc(r.docId || '') + '"><span class="asr-score">' + (r.score * 100).toFixed(0) + '%</span>' + _esc((r.chunk || '').slice(0, 90)) + '…</div>';
      }).join('');

      // Click handler — open Laba AI chat with the result
      container.querySelectorAll('.aosu-search-result').forEach(function (el, i) {
        el.addEventListener('click', function () {
          var LAC = sys('LabaAiChat');
          if (LAC) { LAC.send('Tell me more about: ' + results[i].chunk.slice(0, 80)); }
        });
      });
    }

    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  WORKFLOW TIMELINE PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowTimeline = (function () {
    var _el = null;

    function build() {
      _el = document.createElement('div');
      _el.className = 'aosu-panel collapsed';
      _el.id = 'aosu-workflow-panel';
      _el.innerHTML = [
        '<div class="aosu-panel-header">',
          '<span class="aosu-panel-title">⚡ Workflow Timeline</span>',
          '<span class="aosu-panel-badge" id="wt-badge">0</span>',
        '</div>',
        '<div class="aosu-panel-body">',
          '<div class="aosu-timeline" id="aosu-timeline"><div style="color:#9ca3af;font-size:11px">No active workflows</div></div>',
        '</div>',
      ].join('');
      document.body.appendChild(_el);
      WorkspaceManager.register('workflow-panel', _el);
      setInterval(_refresh, 1500);
    }

    function _refresh() {
      var AAS  = sys('AiAgentSystem');
      if (!AAS) return;
      var workflows = AAS.active();
      var badge     = document.getElementById('wt-badge');
      if (badge) badge.textContent = workflows.length;

      var tl = document.getElementById('aosu-timeline');
      if (!tl) return;
      if (!workflows.length) { tl.innerHTML = '<div style="color:#9ca3af;font-size:11px">No active workflows</div>'; return; }

      tl.innerHTML = workflows.map(function (wf) {
        return (wf.steps || []).map(function (s) {
          var icon  = { pending:'○', running:'▶', done:'✓', failed:'✗', retrying:'↺' }[s.status] || '○';
          var elapsed = s.result ? '' : '';
          return '<div class="aosu-step ' + s.status + '"><span class="aosu-step-icon">' + icon + '</span><span class="aosu-step-label">' + s.label + '</span><span class="aosu-step-time">' + elapsed + '</span></div>';
        }).join('');
      }).join('<hr style="margin:4px 0;border-color:#f3f4f6">');
    }

    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  GPU STATUS PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuStatusPanel = (function () {
    var _el = null;

    function build() {
      _el = document.createElement('div');
      _el.className = 'aosu-panel collapsed';
      _el.id = 'aosu-gpu-panel';
      _el.innerHTML = [
        '<div class="aosu-panel-header"><span class="aosu-panel-title">⚡ GPU</span></div>',
        '<div class="aosu-panel-body" id="aosu-gpu-body">Loading…</div>',
      ].join('');
      document.body.appendChild(_el);
      WorkspaceManager.register('gpu-panel', _el);
      setInterval(_refresh, 2000);
    }

    function _refresh() {
      var body = document.getElementById('aosu-gpu-body');
      if (!body) return;
      var WGAE = sys('WebGpuAiExpansion');
      if (!WGAE) { body.innerHTML = '<div style="font-size:11px;color:#9ca3af">WebGPU unavailable</div>'; return; }
      var info = WGAE.audit();
      body.innerHTML = [
        _stat('Status', info.gpuReady ? 'Ready ✓' : 'CPU mode'),
        _stat('Lost', info.lostCount + 'x'),
        _stat('Pressure', info.pressure),
        _stat('Pending', info.pending + ' tasks'),
        '<div class="aosu-meter"><div class="aosu-meter-fill" style="width:' + (info.gpuReady ? '80' : '10') + '%"></div></div>',
        _stat('Compat', (info.compat.safari ? 'Safari' : 'Chrome') + (info.compat.mobile ? '/Mobile' : '')),
      ].join('');
    }

    function _stat(label, value) { return '<div class="aosu-gpu-stat"><span>' + label + '</span><span class="val">' + value + '</span></div>'; }
    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  LIVE TASK MONITOR PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  var LiveTaskMonitor = (function () {
    var _el = null;

    function build() {
      _el = document.createElement('div');
      _el.className = 'aosu-panel collapsed';
      _el.id = 'aosu-task-panel';
      _el.innerHTML = [
        '<div class="aosu-panel-header"><span class="aosu-panel-title">📊 Live Tasks</span><span class="aosu-panel-badge" id="lt-badge">0</span></div>',
        '<div class="aosu-panel-body" id="aosu-task-body"><div style="font-size:11px;color:#9ca3af">No active tasks</div></div>',
      ].join('');
      document.body.appendChild(_el);
      WorkspaceManager.register('task-panel', _el);
      setInterval(_refresh, 1500);
    }

    function _refresh() {
      var body  = document.getElementById('aosu-task-body');
      var badge = document.getElementById('lt-badge');
      if (!body) return;

      var rows = [];

      var GAE = sys('GenerativeAiEngine');
      if (GAE) { var p = GAE.audit().pendingInfer; if (p) rows.push({ label:'AI Inference', status: p > 0 ? 'active' : 'idle', detail: p + ' queued' }); }

      var VME = sys('VectorMemoryEngine');
      if (VME) { var st = VME.stats(); if (st.pending) rows.push({ label:'Vector Index', status:'active', detail: st.pending + ' pending' }); }

      var WGAE = sys('WebGpuAiExpansion');
      if (WGAE) { var pending = WGAE.audit().pending; if (pending) rows.push({ label:'GPU Tasks', status:'active', detail: pending + ' queued' }); }

      var AAS = sys('AiAgentSystem');
      if (AAS) { var active = AAS.active(); active.forEach(function (wf) { rows.push({ label: 'Agent: ' + (wf.query||'').slice(0,20), status:'active', detail: String(wf.status||'') }); }); }

      if (badge) badge.textContent = rows.length;
      if (!rows.length) { body.innerHTML = '<div style="font-size:11px;color:#9ca3af">No active tasks</div>'; return; }

      body.innerHTML = rows.map(function (r) {
        return '<div class="aosu-task-row"><div class="aosu-task-dot ' + _esc(r.status) + '"></div><span style="flex:1">' + _esc(r.label) + '</span><span style="opacity:.6;font-size:10px">' + _esc(r.detail) + '</span></div>';
      }).join('');
    }

    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  AI MEMORY EXPLORER PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  var AiMemoryExplorer = (function () {
    var _el = null;

    function build() {
      _el = document.createElement('div');
      _el.className = 'aosu-panel collapsed';
      _el.id = 'aosu-memory-panel';
      _el.innerHTML = [
        '<div class="aosu-panel-header"><span class="aosu-panel-title">🧠 AI Memory</span></div>',
        '<div class="aosu-panel-body" id="aosu-memory-body">—</div>',
      ].join('');
      document.body.appendChild(_el);
      WorkspaceManager.register('memory-panel', _el);
      setInterval(_refresh, 3000);
    }

    function _refresh() {
      var body = document.getElementById('aosu-memory-body');
      if (!body) return;
      var VME = sys('VectorMemoryEngine');
      var EMF = sys('EnterpriseMemoryFabric');
      var mp  = sys('MemPressure') || sys('MemoryPressureMonitor');

      var lines = [];
      if (VME) { var vs = VME.stats(); lines.push(_row('Chunks', vs.chunks), _row('Shards', vs.shardCache + ' cached'), _row('Pending', vs.pending), _row('OPFS', vs.opfs ? '✓' : '—')); }
      if (EMF) { var ms = EMF.stats(); lines.push(_row('Cache', ms.cacheEntries), _row('Pressure', ms.memTier)); }
      if (!lines.length) lines.push('<div style="font-size:11px;color:#9ca3af">Memory systems loading…</div>');
      body.innerHTML = lines.join('');
    }

    function _row(label, value) { return '<div class="aosu-gpu-stat"><span>' + label + '</span><span class="val">' + value + '</span></div>'; }
    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  DOCUMENT NAVIGATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var DocumentNavigator = (function () {
    function getActiveDoc() {
      // Try to find from LabaAiFoundation context
      var LAF = sys('LabaAiFoundation');
      if (LAF && LAF.UnifiedDocumentContext) {
        var ids = LAF.UnifiedDocumentContext.list();
        return ids.length ? ids[ids.length - 1] : null;
      }
      return null;
    }
    return { getActiveDoc: getActiveDoc };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 11  KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════════════════
  function _bindShortcuts() {
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      switch (e.key) {
        case '/':  // Ctrl+/ → focus semantic search
          WorkspaceManager.expand('search-panel');
          setTimeout(function () { var inp = document.getElementById('aosu-search-input'); if (inp) inp.focus(); }, 100);
          e.preventDefault();
          break;
        case "'":  // Ctrl+' → open AI chat
          var LAC = sys('LabaAiChat');
          if (LAC) { LAC.toggle(); e.preventDefault(); }
          break;
        case 'w':  // Ctrl+W → toggle workflow panel
          WorkspaceManager.toggle('workflow-panel');
          e.preventDefault();
          break;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 12  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  function _init() {
    _injectCSS();

    // Disable preview systems first (essential — keeps tool processing intact)
    PreviewDisabler.disable();
    PreviewDisabler.watchAndSuppress();

    // ── Visual debug panels DISABLED for production ──────────────────
    // All backend telemetry objects (StatusBar, LiveTaskMonitor, etc.)
    // remain fully functional and accessible via window.AiDocumentOSUI.
    // Only the DOM mounts are skipped so no debug HUD appears in the UI.
    //
    // StatusBar.init();           — bottom debug HUD removed
    // SemanticSearchPanel.build();— developer search panel removed
    // WorkflowTimeline.build();   — developer timeline panel removed
    // GpuStatusPanel.build();     — developer GPU panel removed
    // LiveTaskMonitor.build();    — developer task panel removed
    // AiMemoryExplorer.build();   — developer memory panel removed
    // ─────────────────────────────────────────────────────────────────

    // Keyboard shortcuts (Ctrl+' still opens Laba AI chat)
    _bindShortcuts();

    // No body padding offset needed (status bar not mounted)

    log('AiDocumentOSUI v' + VERSION + ' ready — Ctrl+/ for search, Ctrl+\' for AI chat, Ctrl+W for workflow');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 50); // slight delay to let existing scripts initialize
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.AiDocumentOSUI = {
    version:  VERSION,

    // Preview control
    disablePreviews: function ()  { PreviewDisabler.disable(); },
    restorePreviews: function ()  { PreviewDisabler.restore(); },
    previewsDisabled: function () { return PreviewDisabler.isDisabled(); },

    // Panel control
    workspace:  WorkspaceManager,
    statusBar:  StatusBar,

    // Focus search
    openSearch: function () { WorkspaceManager.expand('search-panel'); setTimeout(function () { var el = document.getElementById('aosu-search-input'); if (el) el.focus(); }, 100); },

    // Active document
    getActiveDoc: function () { return DocumentNavigator.getActiveDoc(); },

    audit: function () {
      return { version: VERSION, previewsDisabled: PreviewDisabler.isDisabled(), panels: ['search','workflow','gpu','task','memory'] };
    },
    cleanup: function () { log('cleanup called'); },

    // Sub-systems
    PreviewDisabler:    PreviewDisabler,
    SemanticSearch:     SemanticSearchPanel,
    WorkflowTimeline:   WorkflowTimeline,
    GpuStatus:          GpuStatusPanel,
    TaskMonitor:        LiveTaskMonitor,
    MemoryExplorer:     AiMemoryExplorer,
    DocNavigator:       DocumentNavigator,
  };
}());
