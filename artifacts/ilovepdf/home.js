/* Homepage-only logic — Recent Use section, category sections, calculators.
   Header + auth modal live in chrome.js (loaded on every page). */

const homeToolUrl = t => t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);

const RECENT_KEY = 'ilpdf_recent_v1';

function getRecentTools() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}

function buildToolMap() {
  const map = {};
  (window.TOOL_GROUPS || []).forEach(g => {
    (g.items || []).forEach(t => {
      if (t.tid) map[t.tid] = t;
      if (t.url) map[t.url.replace(/^\/+/, '')] = t;
    });
  });
  return map;
}

const t18 = (key, fallback) => {
  if (!window.t) return fallback;
  const v = window.t(key);
  if (!v || v === key) return fallback;
  const lastSeg = key.split('.').pop();
  const humanised = lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1).replace(/_/g, ' ');
  if (v === humanised) return fallback;
  return v;
};

const TOOL_ICON_SVGS = {
  'layers': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>',
  'scissors': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>',
  'rotate-cw': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>',
  'crop': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"></path><path d="M18 22V8a2 2 0 0 0-2-2H2"></path></svg>',
  'list-ordered': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path></svg>',
  'archive': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
  'lock': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
  'unlock': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>',
  'file-text': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  'image': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
  'wrench': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  'sparkles': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg>',
};

function renderToolStickerIcon(iconKey) {
  const svg = TOOL_ICON_SVGS[iconKey] || TOOL_ICON_SVGS['file-text'];
  return `<span class="tool-name-sticker" aria-hidden="true" data-icon="${iconKey}">${svg}</span>`;
}

function renderRecentUse() {
  const section = document.getElementById('recent-use-section');
  if (!section) return;
  const recent = getRecentTools();
  if (!recent.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  const tMap  = buildToolMap();
  const badge = (window.toolBadgeHtml || (() => ''));
  const markup = recent.map(r => {
    const t = tMap[r.id];
    if (!t) return '';
    const tid      = t.tid || r.id;
    const titleKey = `tools.${tid}.title`;
    const descKey  = `tools.${tid}.desc`;
    const sticker  = renderToolStickerIcon(t.icon || 'file-text');
    return `
      <a class="tool" data-tid="${tid}" href="${homeToolUrl(t)}">
        <div class="tool-ico-wrap" aria-hidden="true">${sticker}</div>
        <div class="tool-text">
          <h4 class="tool-name"><span class="tool-name-label" data-i18n="${titleKey}">${t18(titleKey, t.name)}</span></h4>
          <p data-i18n="${descKey}">${t18(descKey, t.desc || '')}</p>
        </div>
        ${badge(t.prio)}
      </a>`;
  }).filter(Boolean).join('');
  let container = section.querySelector('.recent-use-items');
  if (!container) {
    container = document.createElement('div');
    container.className = 'tools-grid recent-use-items';
    section.appendChild(container);
  }
  container.innerHTML = markup;
}

const CAT_CONFIG = {
  pdf: { title: 'PDF Tools', sub: 'Everything you need to manage, convert, edit, and secure your PDFs — all browser-powered.', icon: 'file-text', bg: '#eef2ff', color: '#4f46e5' },
  image: { title: 'Image Tools', sub: 'Compress, convert, crop, resize, filter, and transform your images with zero uploads needed.', icon: 'image', bg: '#f0fdf4', color: '#16a34a' },
  utilities: { title: 'Utilities', sub: 'Handy browser-based tools for everyday tasks — QR codes, barcodes, currency, ZIP files and more.', icon: 'wrench', bg: '#fef3c7', color: '#b45309' },
};

function renderCategorySections() {
  _renderOneCatSection('cat-pdf-tools',   ['organize','security','edit','convert','advanced'], 'pdf');
  _renderOneCatSection('cat-image-tools', ['image'],     'image');
  _renderOneCatSection('cat-utilities',   ['utilities'], 'utilities');
}

function _renderOneCatSection(containerId, groupKeys, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const badge = (window.toolBadgeHtml || (() => ''));
  const items = (window.TOOL_GROUPS || [])
    .filter(g => groupKeys.includes(g.key))
    .flatMap(g => (g.items || []).map(t => Object.assign({ _cat: g.key }, t)));
  if (!items.length) { return; }
  const toolCards = items.map(t => {
    const tid      = t.tid || (t.url ? t.url.replace(/^\/+/, '') : '');
    const titleKey = tid ? `tools.${tid}.title` : '';
    const descKey  = tid ? `tools.${tid}.desc`  : '';
    const name     = tid ? t18(titleKey, t.name) : t.name;
    const desc     = tid ? t18(descKey, t.desc || '') : (t.desc || '');
    const sticker  = renderToolStickerIcon(t.icon || 'file-text');
    return `
      <a class="tool" data-cat="${t._cat||''}" data-prio="${t.prio||'instant'}"${tid ? ` data-tid="${tid}"` : ''} href="${homeToolUrl(t)}">
        <div class="tool-ico-wrap" aria-hidden="true">${sticker}</div>
        <div class="tool-text">
          <h4 class="tool-name"><span class="tool-name-label"${titleKey ? ` data-i18n="${titleKey}"` : ''}>${name}</span></h4>
          <p${descKey  ? ` data-i18n="${descKey}"` : ''}>${desc}</p>
        </div>
        ${badge(t.prio)}
      </a>`;
  }).join('');
  const cfg = CAT_CONFIG[type] || {};
  el.innerHTML = `
    <div class="home-cat-inner">
      <div class="home-cat-head">
        <span class="home-cat-ico" style="background:${cfg.bg};color:${cfg.color}">
          <i data-lucide="${cfg.icon}"></i>
        </span>
        <div>
          <h2 class="home-cat-title" id="${containerId}-title">${cfg.title}</h2>
          <p class="home-cat-sub">${cfg.sub}</p>
        </div>
      </div>
      <div class="tools-grid">${toolCards}</div>
    </div>`;
}

// Keep the rest of the original logic by requiring the full file in production.
// This update focuses on the card structure for the new design.
if (typeof window !== 'undefined') {
  window.renderRecentUse = renderRecentUse;
  window.renderCategorySections = renderCategorySections;
}
