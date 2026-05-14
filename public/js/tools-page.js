/* Tools Directory Page — /tools
   Renders all 33+ tools grouped by category with search, filter, and badges.
   Depends on chrome.js being loaded first (provides window.TOOL_GROUPS). */

(function () {
  'use strict';

  // ── Badge definitions ────────────────────────────────────────────────────
  const POPULAR = new Set(['merge','split','compress','pdf-to-word','pdf-to-jpg',
                           'jpg-to-pdf','protect','unlock','ocr','organize']);
  const NEW_TOOLS = new Set(['ai-summarize','translate','workflow','scan-to-pdf']);
  const AI_TOOLS  = new Set(['ai-summarize','translate','ocr']);

  function getBadges(tool) {
    const badges = [];
    if (AI_TOOLS.has(tool.tid))     badges.push({ cls:'tp-badge--ai',       label:'AI' });
    if (NEW_TOOLS.has(tool.tid))    badges.push({ cls:'tp-badge--new',      label:'New' });
    if (POPULAR.has(tool.tid))      badges.push({ cls:'tp-badge--popular',  label:'Popular' });
    if ((tool.prio||'instant') === 'advanced' && !AI_TOOLS.has(tool.tid))
                                    badges.push({ cls:'tp-badge--advanced', label:'Advanced' });
    return badges;
  }

  // ── SVG icon helper (lucide icons via data-lucide, rendered after) ────────
  function iconSvg(name) {
    return `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%"><i data-lucide="${name}"></i></span>`;
  }

  function toolUrl(t) {
    return t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);
  }

  // ── Category metadata ────────────────────────────────────────────────────
  const CAT_META = {
    organize:  { icon:'list-ordered', label:'Organize' },
    security:  { icon:'shield',       label:'Security' },
    image:     { icon:'image',        label:'Image' },
    edit:      { icon:'edit-3',       label:'Edit' },
    utilities: { icon:'calculator',   label:'Utilities' },
    convert:   { icon:'refresh-cw',   label:'Convert' },
    advanced:  { icon:'sparkles',     label:'Advanced & AI' },
  };

  // ── State ────────────────────────────────────────────────────────────────
  let _activeCat  = 'all';
  let _query      = '';

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    const container = document.getElementById('tp-main');
    if (!container) return;

    const groups = window.TOOL_GROUPS || [];
    if (!groups.length) {
      container.innerHTML = '<div class="tp-empty"><p>Tool data not loaded yet. Please refresh.</p></div>';
      return;
    }

    const q = _query.trim().toLowerCase();
    let totalVisible = 0;
    let html = '';

    for (const group of groups) {
      const cat = group.key || '';
      const meta = CAT_META[cat] || { icon:'wrench', label: group.title };

      if (_activeCat !== 'all' && cat !== _activeCat) continue;

      const items = (group.items || []).filter(t => {
        if (!q) return true;
        const hay = ((t.name||'') + ' ' + (t.desc||'') + ' ' + (group.title||'')).toLowerCase();
        return q.split(/\s+/).every(tok => hay.includes(tok));
      });

      if (!items.length) continue;
      totalVisible += items.length;

      const toolCards = items.map(t => {
        const badges = getBadges(t);
        const badgeHtml = badges.map(b =>
          `<span class="tp-badge ${b.cls}">${b.label}</span>`
        ).join('');
        return `
          <a class="tp-tool" href="${toolUrl(t)}" title="${(t.desc||'').replace(/"/g,'&quot;')}">
            <div class="tp-tool-top">
              <div class="tp-tool-ico">${iconSvg(t.icon||'file')}</div>
              ${badgeHtml ? `<div class="tp-tool-badges">${badgeHtml}</div>` : ''}
            </div>
            <div class="tp-tool-name">${escHtml(t.name)}</div>
            <div class="tp-tool-desc">${escHtml(t.desc||'')}</div>
          </a>`;
      }).join('');

      html += `
        <div class="tp-section" id="cat-section-${cat}" data-cat="${cat}">
          <div class="tp-section-head">
            <div class="tp-section-icon"><i data-lucide="${meta.icon}"></i></div>
            <span class="tp-section-title">${escHtml(meta.label || group.title)}</span>
            <span class="tp-section-count">${items.length}</span>
          </div>
          <div class="tp-grid">${toolCards}</div>
        </div>`;
    }

    if (!totalVisible) {
      container.innerHTML = `
        <div class="tp-empty">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <h3>No tools found</h3>
          <p>Try a different search or select a different category.</p>
        </div>`;
    } else {
      container.innerHTML = html;
    }

    // Re-render lucide icons
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch {}
  }

  function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Filter tabs ──────────────────────────────────────────────────────────
  function wireTabs() {
    const bar = document.getElementById('tp-filter-bar');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const btn = e.target.closest('.tp-tab');
      if (!btn) return;
      _activeCat = btn.dataset.cat || 'all';
      bar.querySelectorAll('.tp-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      render();
    });
  }

  // ── Search ───────────────────────────────────────────────────────────────
  function wireSearch() {
    const input = document.getElementById('tp-search');
    if (!input) return;
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        _query = input.value;
        render();
      }, 150);
    });
  }

  // ── URL hash — open directly to a category ───────────────────────────────
  function handleHash() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return;
    const btn = document.querySelector(`.tp-tab[data-cat="${hash}"]`);
    if (btn) {
      btn.click();
      setTimeout(() => {
        const sec = document.getElementById(`cat-section-${hash}`);
        if (sec) sec.scrollIntoView({ behavior:'smooth', block:'start' });
      }, 100);
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    // Ensure chrome.js renderHeader is called
    if (typeof renderHeader === 'function') renderHeader();

    wireTabs();
    wireSearch();
    render();
    handleHash();

    // Lucide icons retry (CDN may be slow)
    setTimeout(() => { try { if (window.lucide) window.lucide.createIcons(); } catch {} }, 300);
    setTimeout(() => { try { if (window.lucide) window.lucide.createIcons(); } catch {} }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
