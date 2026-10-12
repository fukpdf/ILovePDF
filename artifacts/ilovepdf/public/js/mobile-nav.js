/* mobile-nav.js — Sticky bottom nav for <1024px viewports.
 *
 * Three actions: Home, Search, Tools.
 *   • Home   → navigate to "/"
 *   • Search → open a full-screen overlay with a live tool search
 *              (reuses the same TOOL_GROUPS index as the desktop header).
 *   • Tools  → open a full-screen overlay listing every category & tool.
 *
 * Overlays lock body scroll while open. The bar itself is hidden above
 * 1024px so it never competes with the desktop header.
 */
(function () {
  if (window.__MOBILE_NAV_INIT) return;
  window.__MOBILE_NAV_INIT = true;

  function go(href) { window.location.href = href; }

  /* Translation helper — mirrors the guard in home.js / tools-page.js.
     Returns `fallback` whenever window.t hasn't loaded or the result is a
     _humaniseKey placeholder ('Title', 'Desc', …).                          */
  function _tMob(tid, field, fallback) {
    if (!tid || typeof window.t !== 'function') return fallback;
    var key = 'tools.' + tid + '.' + field;
    var v = window.t(key);
    if (!v || v === key) return fallback;
    var humanised = field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, ' ');
    if (v === humanised) return fallback;
    return v;
  }

  // Build the flat tool index used by the search overlay. Lazy because
  // TOOL_GROUPS may not be defined yet at script-load.
  // tid is preserved so we can translate names on render.
  function buildIndex() {
    const out = [];
    (window.TOOL_GROUPS || []).forEach(g => {
      (g.items || []).forEach(t => {
        const slug = t.slug || (t.id || t.name).toLowerCase().replace(/\s+/g, '-');
        const tid  = t.tid || (t.url ? t.url.replace(/^\/+/, '') : '');
        out.push({
          tid:  tid,
          name: t.name,
          desc: t.desc || '',
          icon: t.icon || 'wrench',
          url:  t.url || ('/' + slug),
          cat:  g.title,
          prio: t.prio || 'instant',
          hay:  (t.name + ' ' + (t.desc || '') + ' ' + g.title).toLowerCase(),
        });
      });
    });
    return out;
  }

  // ── DOM scaffolding ─────────────────────────────────────────────────────
  function injectScaffold() {
    if (document.getElementById('mobile-bottom-nav')) return;

    const bar = document.createElement('nav');
    bar.id = 'mobile-bottom-nav';
    bar.className = 'mobile-bottom-nav';
    bar.setAttribute('aria-label', 'Mobile navigation');
    bar.innerHTML = `
      <a class="mbn-btn" href="/" data-action="home" aria-label="Home">
        <i data-lucide="home"></i><span>Home</span>
      </a>
      <button class="mbn-btn" type="button" data-action="tools" aria-label="All tools">
        <i data-lucide="layout-grid"></i><span>Tools</span>
      </button>`;
    document.body.appendChild(bar);

    // Tools overlay
    const tools = document.createElement('div');
    tools.id = 'mobile-tools-overlay';
    tools.className = 'mobile-overlay';
    tools.setAttribute('aria-hidden', 'true');
    tools.setAttribute('role', 'dialog');
    tools.setAttribute('aria-label', 'All tools');
    tools.innerHTML = `
      <div class="mo-head">
        <button type="button" class="mo-close" data-close aria-label="Close">
          <i data-lucide="x"></i>
        </button>
        <div class="mo-title"><i data-lucide="layout-grid"></i> All Tools</div>
      </div>
      <div class="mo-body" id="mo-tools-body"></div>`;
    document.body.appendChild(tools);

    if (window.lucide) lucide.createIcons();
  }

  // ── Open / close mechanics ──────────────────────────────────────────────
  function lockScroll() { document.body.classList.add('mo-lock'); }
  function unlockScroll() { document.body.classList.remove('mo-lock'); }

  function openOverlay(id, onOpen) {
    const ov = document.getElementById(id);
    if (!ov) return;
    ov.classList.add('is-open');
    ov.setAttribute('aria-hidden', 'false');
    lockScroll();
    if (typeof onOpen === 'function') onOpen(ov);
  }
  function closeOverlay(id) {
    const ov = document.getElementById(id);
    if (!ov) return;
    ov.classList.remove('is-open');
    ov.setAttribute('aria-hidden', 'true');
    // Only unlock if no overlay is open.
    if (!document.querySelector('.mobile-overlay.is-open')) unlockScroll();
  }

  // ── Search overlay logic ────────────────────────────────────────────────
  function renderSearch(q) {
    const out = document.getElementById('mo-search-results');
    if (!out) return;
    const idx   = buildIndex();
    const query = (q || '').trim().toLowerCase();

    let list;
    if (!query) {
      // Empty state: show the first 12 tools as suggestions so the panel
      // never looks blank when a user opens it.
      list = idx.slice(0, 12);
    } else {
      list = idx.filter(t =>
        query.split(/\s+/).every(tok => t.hay.includes(tok))
      ).slice(0, 30);
    }

    if (!list.length) {
      out.innerHTML = `<div class="mo-empty">No tools match "<strong>${escapeHtml(query)}</strong>".</div>`;
      return;
    }

    out.innerHTML = list.map(t => {
      const name = escapeHtml(_tMob(t.tid, 'title', t.name));
      const tidAttr = t.tid ? ` data-tid="${t.tid}"` : '';
      const i18nAttr = t.tid ? ` data-i18n="tools.${t.tid}.title"` : '';
      return `
      <a class="mo-row" href="${t.url}" role="option" data-prio="${t.prio||'instant'}"${tidAttr}>
        <span class="mo-row-icon"><i data-lucide="${t.icon}"></i></span>
        <span class="mo-row-text">
          <span class="mo-row-name"${i18nAttr}>${name}</span>
          <span class="mo-row-cat">${escapeHtml(t.cat)}</span>
        </span>
        ${(window.toolBadgeHtml ? window.toolBadgeHtml(t.prio) : '')}
        <i class="mo-row-arrow" data-lucide="chevron-right"></i>
      </a>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
  }

  // ── Tools overlay logic ─────────────────────────────────────────────────
  function renderTools() {
    const out = document.getElementById('mo-tools-body');
    if (!out) return;
    const groups = window.TOOL_GROUPS || [];
    out.innerHTML = groups.map(g => {
      const items = (g.items || []).map(t => {
        const slug = t.slug || (t.id || t.name).toLowerCase().replace(/\s+/g, '-');
        const href = t.url || ('/' + slug);
        const tid  = t.tid || (t.url ? t.url.replace(/^\/+/, '') : '');
        const name = escapeHtml(_tMob(tid, 'title', t.name));
        const desc = t.desc ? escapeHtml(_tMob(tid, 'desc', t.desc)) : '';
        const tidAttr   = tid ? ` data-tid="${tid}"` : '';
        const i18nName  = tid ? ` data-i18n="tools.${tid}.title"` : '';
        const i18nDesc  = tid ? ` data-i18n="tools.${tid}.desc"`  : '';
        return `
          <a class="mo-row" href="${href}" data-prio="${t.prio||'instant'}"${tidAttr}>
            <span class="mo-row-icon"><i data-lucide="${t.icon || 'wrench'}"></i></span>
            <span class="mo-row-text">
              <span class="mo-row-name"${i18nName}>${name}</span>
              ${desc ? `<span class="mo-row-cat"${i18nDesc}>${desc}</span>` : ''}
            </span>
            ${(window.toolBadgeHtml ? window.toolBadgeHtml(t.prio) : '')}
            <i class="mo-row-arrow" data-lucide="chevron-right"></i>
          </a>`;
      }).join('');
      return `
        <section class="mo-group">
          <h3 class="mo-group-title">${escapeHtml(g.title)}</h3>
          <div class="mo-group-list">${items}</div>
        </section>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Wire up ─────────────────────────────────────────────────────────────
  function wire() {
    document.body.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn) {
        const ov = closeBtn.closest('.mobile-overlay');
        if (ov) closeOverlay(ov.id);
        return;
      }

      const btn = e.target.closest('.mbn-btn');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'tools') {
        e.preventDefault();
        openOverlay('mobile-tools-overlay', renderTools);
      }
      // 'home' is a regular anchor — no special handling needed.
    });

    // Esc closes any open overlay
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.mobile-overlay.is-open')
          .forEach(ov => closeOverlay(ov.id));
      }
    });
  }

  function init() {
    injectScaffold();
    wire();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Re-render open overlays when locale changes so tool names update immediately.
     Closed overlays self-correct on next open (renderTools/renderSearch called
     fresh each time). This covers the edge case of switching locale while an
     overlay is already open.                                                    */
  window.addEventListener('i18n:change', function () {
    const toolsOv  = document.getElementById('mobile-tools-overlay');
    const searchOv = document.getElementById('mobile-search-overlay');
    if (toolsOv  && toolsOv.classList.contains('is-open'))  renderTools();
  });
})();
