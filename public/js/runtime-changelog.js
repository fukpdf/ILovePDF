// RuntimeChangelog v1.0 — Phase 23E
// Version changelog panel — shown automatically after an app update,
// or on demand. Persists "dismissed" state per version.
// Integrates with RuntimeUpdater (subscribe to update-available state).
//
// Exposed as: window.RuntimeChangelog

(function (G) {
  'use strict';

  if (G.RuntimeChangelog) return;

  var VERSION  = '1.0';
  var LOG      = '[RCL23]';
  var LS_KEY   = 'iplv_cl_seen_';   // + version → '1'

  // ── Changelog data ─────────────────────────────────────────────────────────
  // Newest first. 'type': 'new' | 'improved' | 'fixed' | 'perf'
  var CHANGELOG = [
    {
      version: 'v1.4',
      date:    '2026-05',
      title:   'Phase 22–26: PWA, Offline & Performance',
      items: [
        { type: 'new',      text: 'Full PWA support — install as app on iOS & Android' },
        { type: 'new',      text: 'Offline mode — cached pages work without internet' },
        { type: 'new',      text: 'RTL language support for Arabic, Urdu, Persian, Hebrew' },
        { type: 'new',      text: 'Runtime update notifications with safe idle-wait strategy' },
        { type: 'new',      text: 'Runtime recovery watchdog — auto-heals crashed workers' },
        { type: 'new',      text: 'AI task scheduler with GPU/CPU tier adaptation' },
        { type: 'perf',     text: 'Core Web Vitals monitoring (CLS, LCP, FCP, INP)' },
        { type: 'perf',     text: 'Layout stability engine — reduced CLS on dynamic cards' },
        { type: 'improved', text: 'Service worker now caches visited pages for offline use' },
        { type: 'improved', text: 'Manifest: web share target + file handler for .pdf files' },
        { type: 'fixed',    text: 'iOS Safari PWA meta tags for correct app display' },
      ],
    },
    {
      version: 'v1.3',
      date:    '2026-04',
      title:   'Phase 17–21: AI & Multilingual',
      items: [
        { type: 'new',      text: '20-language UI with live language switching' },
        { type: 'new',      text: 'WebGPU AI acceleration for background removal & OCR' },
        { type: 'new',      text: 'AI Summarizer — summarize any PDF in seconds' },
        { type: 'new',      text: 'Economy system: credits, savings tracker, donations' },
        { type: 'improved', text: 'RuntimeGovernor: production-safe resource management' },
        { type: 'perf',     text: 'Giant file routing — 150+ MB PDFs via OPFS staging' },
      ],
    },
    {
      version: 'v1.2',
      date:    '2026-03',
      title:   'Phase 11–16: Worker & Memory',
      items: [
        { type: 'new',      text: 'Parallel PDF processing via SharedArrayBuffer workers' },
        { type: 'new',      text: 'Adaptive memory tier system (normal/low/critical/abort)' },
        { type: 'perf',     text: 'Zero-copy stream bridge for large file transfers' },
        { type: 'improved', text: 'RuntimeKernel: unified resource scheduling kernel' },
      ],
    },
  ];

  var TYPE_BADGE = {
    new:      { label: 'New',      bg: '#d1fae5', color: '#065f46' },
    improved: { label: 'Better',   bg: '#dbeafe', color: '#1e40af' },
    fixed:    { label: 'Fixed',    bg: '#fef3c7', color: '#92400e' },
    perf:     { label: 'Faster',   bg: '#f3e8ff', color: '#6b21a8' },
  };

  // ── Panel styles ───────────────────────────────────────────────────────────
  function _injectCSS() {
    if (document.getElementById('iplv-cl-css')) return;
    var s = document.createElement('style');
    s.id = 'iplv-cl-css';
    s.textContent = [
      '#iplv-cl-overlay{position:fixed;inset:0;z-index:2147483641;',
        'background:rgba(0,0,0,0.55);display:flex;align-items:center;',
        'justify-content:center;padding:16px;opacity:0;transition:opacity 0.25s;}',
      '#iplv-cl-panel{background:#0d1117;border:1px solid rgba(255,255,255,0.1);',
        'border-radius:16px;width:100%;max-width:540px;max-height:80vh;overflow:hidden;',
        'display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.5);',
        'transform:scale(0.97);transition:transform 0.25s;}',
      '#iplv-cl-panel.open{transform:scale(1);}',
      '#iplv-cl-header{display:flex;align-items:center;gap:12px;padding:20px 24px 16px;',
        'border-bottom:1px solid rgba(255,255,255,0.08);}',
      '#iplv-cl-header h2{margin:0;font-size:17px;font-weight:700;color:#f0f6fc;flex:1;}',
      '#iplv-cl-header .cl-tag{font-size:11px;background:#7c3aed;color:#ede9fe;',
        'padding:3px 8px;border-radius:20px;font-weight:600;}',
      '#iplv-cl-close{background:transparent;border:none;color:#6e7681;font-size:22px;',
        'cursor:pointer;padding:0;line-height:1;flex-shrink:0;}',
      '#iplv-cl-close:hover{color:#f0f6fc;}',
      '#iplv-cl-body{overflow-y:auto;padding:20px 24px;flex:1;}',
      '#iplv-cl-body::-webkit-scrollbar{width:4px;}',
      '#iplv-cl-body::-webkit-scrollbar-track{background:transparent;}',
      '#iplv-cl-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;}',
      '.cl-version{margin-bottom:24px;}',
      '.cl-version:last-child{margin-bottom:0;}',
      '.cl-ver-header{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;}',
      '.cl-ver-title{font-size:13px;font-weight:700;color:#c9d1d9;}',
      '.cl-ver-date{font-size:11px;color:#6e7681;}',
      '.cl-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.cl-item{display:flex;align-items:flex-start;gap:10px;}',
      '.cl-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;',
        'flex-shrink:0;margin-top:1px;letter-spacing:0.02em;}',
      '.cl-item-text{font-size:13px;color:#8b949e;line-height:1.5;}',
      '#iplv-cl-footer{padding:16px 24px;border-top:1px solid rgba(255,255,255,0.08);',
        'display:flex;justify-content:flex-end;gap:10px;}',
      '#iplv-cl-footer button{padding:9px 18px;border-radius:8px;font-size:13px;',
        'font-weight:600;cursor:pointer;border:none;}',
      '.cl-btn-dismiss{background:#21262d;color:#c9d1d9;}',
      '.cl-btn-dismiss:hover{background:#30363d;}',
      '.cl-btn-reload{background:#7c3aed;color:#fff;}',
      '.cl-btn-reload:hover{background:#6d28d9;}',
    ].join('');
    document.head.appendChild(s);
  }

  var _overlay = null;

  function _buildPanel(version) {
    _injectCSS();
    if (_overlay) return;

    var overlay = document.createElement('div');
    overlay.id = 'iplv-cl-overlay';

    var panel = document.createElement('div');
    panel.id = 'iplv-cl-panel';

    // Header
    var header = document.createElement('div');
    header.id = 'iplv-cl-header';
    var h2 = document.createElement('h2');
    h2.textContent = (G.t && G.t('changelog.title')) || "What's New";
    var tag = document.createElement('span');
    tag.className = 'cl-tag';
    tag.textContent = version || CHANGELOG[0].version;
    var closeBtn = document.createElement('button');
    closeBtn.id = 'iplv-cl-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function () { RuntimeChangelog.dismiss(version); });
    header.appendChild(h2);
    header.appendChild(tag);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.id = 'iplv-cl-body';
    CHANGELOG.forEach(function (entry) {
      var section = document.createElement('div');
      section.className = 'cl-version';
      var verHeader = document.createElement('div');
      verHeader.className = 'cl-ver-header';
      var verTitle = document.createElement('span');
      verTitle.className = 'cl-ver-title';
      verTitle.textContent = entry.version + ' — ' + entry.title;
      var verDate = document.createElement('span');
      verDate.className = 'cl-ver-date';
      verDate.textContent = entry.date;
      verHeader.appendChild(verTitle);
      verHeader.appendChild(verDate);
      section.appendChild(verHeader);

      var list = document.createElement('ul');
      list.className = 'cl-items';
      entry.items.forEach(function (item) {
        var li = document.createElement('li');
        li.className = 'cl-item';
        var badge = document.createElement('span');
        badge.className = 'cl-badge';
        var bStyle = TYPE_BADGE[item.type] || { label: item.type, bg: '#21262d', color: '#8b949e' };
        badge.style.background = bStyle.bg;
        badge.style.color = bStyle.color;
        badge.textContent = bStyle.label;
        var text = document.createElement('span');
        text.className = 'cl-item-text';
        text.textContent = item.text;
        li.appendChild(badge);
        li.appendChild(text);
        list.appendChild(li);
      });
      section.appendChild(list);
      body.appendChild(section);
    });
    panel.appendChild(body);

    // Footer
    var footer = document.createElement('div');
    footer.id = 'iplv-cl-footer';
    var btnDismiss = document.createElement('button');
    btnDismiss.className = 'cl-btn-dismiss';
    btnDismiss.textContent = (G.t && G.t('changelog.dismiss')) || 'Got it';
    btnDismiss.addEventListener('click', function () { RuntimeChangelog.dismiss(version); });
    var btnReload = document.createElement('button');
    btnReload.className = 'cl-btn-reload';
    btnReload.textContent = (G.t && G.t('update.refresh')) || 'Reload Now';
    btnReload.addEventListener('click', function () {
      RuntimeChangelog.dismiss(version);
      if (G.RuntimeUpdater) G.RuntimeUpdater.apply();
      else window.location.reload();
    });
    footer.appendChild(btnDismiss);
    footer.appendChild(btnReload);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _overlay = overlay;

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) RuntimeChangelog.dismiss(version);
    });

    // Animate in
    requestAnimationFrame(function () {
      overlay.style.opacity = '1';
      requestAnimationFrame(function () { panel.classList.add('open'); });
    });
  }

  function _removePanel() {
    if (!_overlay) return;
    _overlay.style.opacity = '0';
    var el = _overlay;
    _overlay = null;
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  // ── Auto-hook into RuntimeUpdater ──────────────────────────────────────────
  function _hookUpdater() {
    var RU = G.RuntimeUpdater;
    if (!RU || !RU.subscribe) return;
    RU.subscribe(function (state, version) {
      if (state === 'update-available' && version) {
        // Show changelog if not seen for this version
        if (RuntimeChangelog.shouldShow(version)) {
          // Delay so update toast renders first
          setTimeout(function () { RuntimeChangelog.show(version); }, 1200);
        }
      }
    });
  }

  // Hook after DOM ready (RuntimeUpdater may load before us)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(_hookUpdater, 100);
    }, { once: true });
  } else {
    setTimeout(_hookUpdater, 100);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeChangelog = {
    VERSION: VERSION,

    /** Show changelog panel for a version */
    show: function (version) {
      if (document.body) _buildPanel(version);
      else document.addEventListener('DOMContentLoaded', function () { _buildPanel(version); }, { once: true });
    },

    /** Dismiss panel and mark version as seen */
    dismiss: function (version) {
      _removePanel();
      if (version) {
        try { localStorage.setItem(LS_KEY + version, '1'); } catch (_) {}
      }
    },

    /** Returns true if changelog should be shown for this version */
    shouldShow: function (version) {
      if (!version) return false;
      try { return !localStorage.getItem(LS_KEY + version); } catch (_) { return false; }
    },

    /** Force-show for testing */
    _forceShow: function () { _buildPanel(CHANGELOG[0].version); },

    /** Get full changelog data */
    getData: function () { return CHANGELOG.slice(); },
  };

  G.RuntimeChangelog = RuntimeChangelog;
  console.debug(LOG, 'RuntimeChangelog v' + VERSION + ' ready');

}(window));
