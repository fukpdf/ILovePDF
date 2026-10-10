/* Homepage-only logic — Recent Use section, category sections, calculators.
   Header + auth modal live in chrome.js (loaded on every page). */

const homeToolUrl = t => t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);

/* ─── RECENT USE — localStorage helpers ────────────────────────────────── */
const RECENT_KEY = 'ilpdf_recent_v1';

function getRecentTools() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}

/* Build a flat map: id/url-slug → tool object from TOOL_GROUPS */
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

/* Safe i18n with humanised-key guard (prevents blank cards on cold cache) */
const t18 = (key, fallback) => {
  if (!window.t) return fallback;
  const v = window.t(key);
  if (!v || v === key) return fallback;
  const lastSeg = key.split('.').pop();
  const humanised = lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1).replace(/_/g, ' ');
  if (v === humanised) return fallback;
  return v;
};

/* Instant inline SVG icons dictionary for zero layout shifts and offline resilience */
const TOOL_ICON_SVGS = {
  'layers': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>',
  'scissors': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>',
  'rotate-cw': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>',
  'crop': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"></path><path d="M18 22V8a2 2 0 0 0-2-2H2"></path></svg>',
  'list-ordered': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path></svg>',
  'archive': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
  'lock': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
  'unlock': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>',
  'maximize': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>',
  'sliders': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
  'minimize-2': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>',
  'refresh-cw': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
  'image-off': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"></path><line x1="13.5" y1="13.5" x2="6 21"></line><line x1="18" y1="12" x2="21" y2="15"></line><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59"></path><path d="M21 15V5a2 2 0 0 0-2-2H9"></path></svg>',
  'droplet': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>',
  'hash': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>',
  'edit-3': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
  'pen-tool': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>',
  'eye-off': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
  'dollar-sign': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>',
  'calculator': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="6" x2="16" y2="6"></line><line x1="16" y1="14" x2="16" y2="18"></line><path d="M8 10h.01"></path><path d="M12 10h.01"></path><path d="M16 10h.01"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M8 18h.01"></path><path d="M12 18h.01"></path></svg>',
  'qr-code': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
  'bar-chart-2': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
  'package': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
  'image': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
  'file-text': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  'presentation': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h20"></path><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"></path><path d="m7 21 5-5 5 5"></path></svg>',
  'sheet': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>',
  'table': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="12" y1="3" x2="12" y2="21"></line></svg>',
  'code': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
  'type': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>',
  'scan-line': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><line x1="7" y1="12" x2="17" y2="12"></line></svg>',
  'wrench': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  'git-compare': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><path d="M11 18H8a2 2 0 0 1-2-2V9"></path></svg>',
  'sparkles': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path></svg>',
  'languages': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>',
  'workflow': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"></rect><rect x="15" y="3" width="6" height="6" rx="1"></rect><rect x="9" y="15" width="6" height="6" rx="1"></rect><path d="M6 9v3a1 1 0 0 0 1 1h4"></path><path d="M18 9v3a1 1 0 0 1-1 1h-4"></path><path d="M12 13v2"></path></svg>',
};

function renderToolStickerIcon(iconKey) {
  const svg = TOOL_ICON_SVGS[iconKey] || TOOL_ICON_SVGS['file-text'];
  return `<span class="tool-name-sticker" aria-hidden="true" data-icon="${iconKey}">${svg}</span>`;
}

/* ─── RENDER RECENT USE SECTION ─────────────────────────────────────────── */
function renderRecentUse() {
  const section = document.getElementById('recent-use-section');
  const root    = document.getElementById('tools-root');
  if (!section) return;

  const recent = getRecentTools();
  if (!recent.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  const tMap  = buildToolMap();
  const badge = (window.toolBadgeHtml || (() => ''));

  if (root) {
    root.innerHTML = recent.map(r => {
      const t = tMap[r.id];
      if (!t) return '';
      const tid      = t.tid || r.id;
      const titleKey = `tools.${tid}.title`;
      const descKey  = `tools.${tid}.desc`;
      const sticker  = renderToolStickerIcon(t.icon || 'file-text');
      return `
        <a class="tool" data-tid="${tid}" href="${homeToolUrl(t)}">
          <div class="tool-text">
            <h4 class="tool-name">${sticker}<span class="tool-name-label" data-i18n="${titleKey}">${t18(titleKey, t.name)}</span></h4>
            <p data-i18n="${descKey}">${t18(descKey, t.desc || '')}</p>
          </div>
          ${badge(t.prio)}
        </a>`;
    }).filter(Boolean).join('');
  }
}

/* ─── CATEGORY SECTION CONFIG ───────────────────────────────────────────── */
const CAT_CONFIG = {
  pdf: {
    title: 'PDF Tools',
    sub: 'Everything you need to manage, convert, edit, and secure your PDFs — all browser-powered.',
    icon: 'file-text', bg: '#eef2ff', color: '#4f46e5',
  },
  image: {
    title: 'Image Tools',
    sub: 'Compress, convert, crop, resize, filter, and transform your images with zero uploads needed.',
    icon: 'image', bg: '#f0fdf4', color: '#16a34a',
  },
  utilities: {
    title: 'Utilities',
    sub: 'Handy browser-based tools for everyday tasks — QR codes, barcodes, currency, ZIP files and more.',
    icon: 'wrench', bg: '#fef3c7', color: '#b45309',
  },
};


/* ─── RENDER CATEGORY SECTIONS ──────────────────────────────────────────── */
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

  if (!items.length) { el.style.display = 'none'; return; }

  const toolCards = items.map(t => {
    const tid      = t.tid || (t.url ? t.url.replace(/^\/+/, '') : '');
    const titleKey = tid ? `tools.${tid}.title` : '';
    const descKey  = tid ? `tools.${tid}.desc`  : '';
    const name     = tid ? t18(titleKey, t.name) : t.name;
    const desc     = tid ? t18(descKey, t.desc || '') : (t.desc || '');
    const sticker  = renderToolStickerIcon(t.icon || 'file-text');
    return `
      <a class="tool" data-cat="${t._cat||''}" data-prio="${t.prio||'instant'}"${tid ? ` data-tid="${tid}"` : ''} href="${homeToolUrl(t)}">
        <div class="tool-text">
          <h4 class="tool-name">${sticker}<span class="tool-name-label"${titleKey ? ` data-i18n="${titleKey}"` : ''}>${name}</span></h4>
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

/* ─── MOBILE CALCULATOR TOGGLE ──────────────────────────────────────────── */
function wireCalcToggle(){
  const btn = document.getElementById('calc-toggle');
  if (!btn) return;
  const cards = () => document.querySelectorAll('.rail-sticky .calc-card');
  const setOpen = (open) => {
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    cards().forEach(c => c.classList.toggle('mobile-open', open));
  };
  btn.addEventListener('click', () => setOpen(!btn.classList.contains('open')));
  const mq = window.matchMedia('(min-width: 1025px)');
  const onMqChange = (e) => { if (e.matches) setOpen(false); };
  if (mq.addEventListener) mq.addEventListener('change', onMqChange);
  else if (mq.addListener)  mq.addListener(onMqChange);
}

/* ─── NUMBERS-TO-WORDS CALCULATOR ──────────────────────────────────────── */
function wireCalc(){
  const input    = document.getElementById('calc-input');
  const btn      = document.getElementById('calc-go');
  const out      = document.getElementById('calc-out');
  const currency = document.getElementById('calc-currency');
  const modes    = document.querySelectorAll('.calc-mode');
  if (!input || !btn) return;

  const caseSel = document.getElementById('calc-case');
  const wrap    = document.getElementById('calc-out-wrap');
  const copyBtn = document.getElementById('calc-copy');

  let mode = 'words';
  let lastNumber = '';

  modes.forEach(m => {
    m.addEventListener('click', () => {
      modes.forEach(x => x.classList.remove('active'));
      m.classList.add('active');
      mode = m.dataset.mode;
      currency.classList.toggle('show', mode === 'currency');
    });
  });

  const run = () => {
    const val = (input.value || '').trim();
    out.classList.remove('err');
    if (wrap) wrap.hidden = false;
    if (!val) { out.textContent = (window.t ? window.t('errors.enter_number') : 'Please enter a number.'); out.classList.add('err'); return; }
    if (typeof window.convertNumberToWords !== 'function') {
      out.textContent = (window.t ? window.t('calc.converter_loading') : 'Converter is loading\u2026'); out.classList.add('err'); return;
    }
    lastNumber = val;
    const res = window.convertNumberToWords(val, {
      mode, currency: currency.value,
      letterCase: caseSel ? caseSel.value : 'lowercase',
    });
    if (res.error) { out.textContent = res.error; out.classList.add('err'); return; }
    out.textContent = res.text.replace(/\s+$/, '') + ' Only';
  };

  btn.addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if (caseSel) caseSel.addEventListener('change', () => { if (lastNumber) run(); });

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = out.textContent || '';
      if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      const span = copyBtn.querySelector('span');
      const orig = span.textContent;
      span.textContent = (window.t ? window.t('notifications.copied_short') : 'Copied!');
      copyBtn.classList.add('copied');
      setTimeout(() => { span.textContent = orig; copyBtn.classList.remove('copied'); }, 1400);
    });
  }
}

/* ─── LIVE CURRENCY CONVERTER (160+ currencies) ─────────────────────────── */
const FX_LIST = [
  ['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['JPY','Japanese Yen'],
  ['CNY','Chinese Yuan'],['INR','Indian Rupee'],['PKR','Pakistani Rupee'],
  ['AED','UAE Dirham'],['SAR','Saudi Riyal'],['QAR','Qatari Riyal'],
  ['KWD','Kuwaiti Dinar'],['BHD','Bahraini Dinar'],['OMR','Omani Rial'],
  ['JOD','Jordanian Dinar'],['LBP','Lebanese Pound'],['SYP','Syrian Pound'],
  ['IRR','Iranian Rial'],['IQD','Iraqi Dinar'],['YER','Yemeni Rial'],
  ['AFN','Afghan Afghani'],['CAD','Canadian Dollar'],['AUD','Australian Dollar'],
  ['NZD','New Zealand Dollar'],['CHF','Swiss Franc'],['SEK','Swedish Krona'],
  ['NOK','Norwegian Krone'],['DKK','Danish Krone'],['ISK','Icelandic Krona'],
  ['PLN','Polish Zloty'],['CZK','Czech Koruna'],['HUF','Hungarian Forint'],
  ['RON','Romanian Leu'],['BGN','Bulgarian Lev'],['HRK','Croatian Kuna'],
  ['RSD','Serbian Dinar'],['UAH','Ukrainian Hryvnia'],['BYN','Belarusian Ruble'],
  ['RUB','Russian Ruble'],['TRY','Turkish Lira'],['ILS','Israeli Shekel'],
  ['EGP','Egyptian Pound'],['MAD','Moroccan Dirham'],['DZD','Algerian Dinar'],
  ['TND','Tunisian Dinar'],['LYD','Libyan Dinar'],['SDG','Sudanese Pound'],
  ['ETB','Ethiopian Birr'],['KES','Kenyan Shilling'],['UGX','Ugandan Shilling'],
  ['TZS','Tanzanian Shilling'],['NGN','Nigerian Naira'],['GHS','Ghanaian Cedi'],
  ['ZAR','South African Rand'],['BWP','Botswana Pula'],['NAD','Namibian Dollar'],
  ['MUR','Mauritian Rupee'],['XOF','CFA Franc BCEAO'],['XAF','CFA Franc BEAC'],
  ['SGD','Singapore Dollar'],['MYR','Malaysian Ringgit'],['THB','Thai Baht'],
  ['IDR','Indonesian Rupiah'],['VND','Vietnamese Dong'],['PHP','Philippine Peso'],
  ['HKD','Hong Kong Dollar'],['TWD','Taiwan Dollar'],['KRW','South Korean Won'],
  ['MNT','Mongolian Tugrik'],['KZT','Kazakhstani Tenge'],['UZS','Uzbekistani Som'],
  ['AZN','Azerbaijani Manat'],['GEL','Georgian Lari'],['AMD','Armenian Dram'],
  ['BDT','Bangladeshi Taka'],['LKR','Sri Lankan Rupee'],['NPR','Nepalese Rupee'],
  ['MMK','Myanmar Kyat'],['KHR','Cambodian Riel'],['LAK','Lao Kip'],
  ['BND','Brunei Dollar'],['MOP','Macanese Pataca'],['MVR','Maldivian Rufiyaa'],
  ['BRL','Brazilian Real'],['MXN','Mexican Peso'],['ARS','Argentine Peso'],
  ['CLP','Chilean Peso'],['COP','Colombian Peso'],['PEN','Peruvian Sol'],
  ['UYU','Uruguayan Peso'],['VES','Venezuelan Bolivar'],['BOB','Bolivian Boliviano'],
  ['PYG','Paraguayan Guarani'],['CRC','Costa Rican Colon'],['GTQ','Guatemalan Quetzal'],
  ['HNL','Honduran Lempira'],['NIO','Nicaraguan Cordoba'],['PAB','Panamanian Balboa'],
  ['DOP','Dominican Peso'],['CUP','Cuban Peso'],['JMD','Jamaican Dollar'],
  ['TTD','Trinidad Dollar'],['BBD','Barbados Dollar'],['BSD','Bahamian Dollar'],
  ['XCD','East Caribbean Dollar'],['HTG','Haitian Gourde'],
  ['ALL','Albanian Lek'],['MKD','Macedonian Denar'],['BAM','Bosnia Mark'],
  ['MDL','Moldovan Leu'],['ZMW','Zambian Kwacha'],['MWK','Malawian Kwacha'],
  ['AOA','Angolan Kwanza'],['MZN','Mozambican Metical'],['MGA','Malagasy Ariary'],
  ['SCR','Seychellois Rupee'],['RWF','Rwandan Franc'],['BIF','Burundian Franc'],
  ['CDF','Congolese Franc'],['DJF','Djiboutian Franc'],['SOS','Somali Shilling'],
  ['SLL','Sierra Leone Leone'],['LRD','Liberian Dollar'],['GMD','Gambian Dalasi'],
  ['CVE','Cape Verde Escudo'],['STN','São Tomé Dobra'],['SZL','Swazi Lilangeni'],
  ['LSL','Lesotho Loti'],['ZWL','Zimbabwean Dollar'],
  ['FJD','Fijian Dollar'],['PGK','Papua New Guinea Kina'],['SBD','Solomon Islands Dollar'],
  ['VUV','Vanuatu Vatu'],['WST','Samoan Tala'],['TOP','Tongan Paʻanga'],
  ['XPF','CFP Franc'],['ANG','Netherlands Antillean Guilder'],['AWG','Aruban Florin'],
  ['SRD','Suriname Dollar'],['GYD','Guyanese Dollar'],['BZD','Belize Dollar'],
  ['KGS','Kyrgyzstani Som'],['TJS','Tajikistani Somoni'],['TMT','Turkmenistani Manat'],
  ['BTN','Bhutanese Ngultrum'],
  ['XAU','Gold (oz)'],['XAG','Silver (oz)'],['XDR','IMF SDR'],
  ['BTC','Bitcoin'],['ETH','Ethereum'],['USDT','Tether'],['BNB','BNB'],['XRP','XRP'],
];

const FX_STATIC = {
  usd:1, eur:0.92, gbp:0.79, jpy:155.0, chf:0.88, cad:1.36, aud:1.52, nzd:1.65,
  cny:7.25, hkd:7.82, twd:32.0, krw:1370, sgd:1.34, myr:4.7, thb:36.0, idr:15800,
  vnd:25400, php:57.0, inr:83.4, pkr:278.0, bdt:117, lkr:300.0, npr:133.0, mmk:2100,
  khr:4100, lak:21000, bnd:1.34, mop:8.06, mvr:15.4, btn:83.4,
  aed:3.67, sar:3.75, qar:3.64, kwd:0.307, bhd:0.376, omr:0.385, jod:0.709,
  lbp:89500, syp:13000, irr:42000, iqd:1310, yer:250, afn:71.0, ils:3.7, try:32.5,
  egp:48.5, mad:9.95, dzd:134.0, tnd:3.13, lyd:4.85, sdg:601, etb:57.0, kes:129,
  ugx:3760, tzs:2680, ngn:1480, ghs:14.5, zar:18.6, bwp:13.6, nad:18.6, mur:46.0,
  xof:603, xaf:603, sek:10.6, nok:10.8, dkk:6.85, isk:139, pln:3.95, czk:23.2,
  huf:362, ron:4.58, bgn:1.80, hrk:6.93, rsd:108, uah:39.5, byn:3.27, rub:92.0,
  mnt:3380, kzt:475, uzs:12700, azn:1.70, gel:2.70, amd:388, kgs:88.5, tjs:10.9, tmt:3.5,
  brl:5.05, mxn:17.1, ars:870, clp:945, cop:4080, pen:3.78, uyu:39.5, ves:36.5,
  bob:6.91, pyg:7300, crc:512, gtq:7.78, hnl:24.7, nio:36.7, pab:1, dop:58.5,
  cup:24, jmd:155, ttd:6.78, bbd:2, bsd:1, xcd:2.7, htg:132, ang:1.79, awg:1.8,
  srd:33.5, gyd:209, bzd:2.01,
  all:93.8, mkd:56.7, bam:1.80, mdl:17.5, zmw:25.8, mwk:1730, aoa:830, mzn:63.9,
  mga:4500, scr:13.6, rwf:1300, bif:2860, cdf:2780, djf:178, sos:571, sll:22000,
  lrd:188, gmd:67.5, cve:101, stn:22.6, szl:18.6, lsl:18.6, zwl:13.5,
  fjd:2.25, pgk:3.92, sbd:8.4, vuv:120, wst:2.74, top:2.36, xpf:109,
  xau:0.00043, xag:0.034, xdr:0.755,
  btc:0.0000156, eth:0.00033, usdt:1.0, bnb:0.0017, xrp:1.96
};

let FX_RATES = null;
let FX_FALLBACK_USED = false;

const fetchTimeout = (url, ms = 5000) => new Promise((resolve, reject) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, ms);
  fetch(url, { cache:'no-cache', signal: ctrl.signal })
    .then(r => { clearTimeout(timer); r.ok ? resolve(r) : reject(new Error(r.status)); })
    .catch(err => { clearTimeout(timer); reject(err); });
});

async function loadRates(){
  const sources = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    'https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/usd.json'
  ];
  for (const url of sources) {
    try {
      const r = await fetchTimeout(url, 5000);
      const data = await r.json();
      if (data && data.usd && typeof data.usd === 'object') return data.usd;
    } catch (e) { /* try next */ }
  }
  FX_FALLBACK_USED = true;
  return FX_STATIC;
}

function fxConvert(amount, from, to){
  if (!FX_RATES) return null;
  const fromR = from === 'USD' ? 1 : FX_RATES[from.toLowerCase()];
  const toR   = to   === 'USD' ? 1 : FX_RATES[to.toLowerCase()];
  if (!fromR || !toR) return null;
  return (amount / fromR) * toR;
}
function fmtMoney(v, code){
  try { return new Intl.NumberFormat(undefined, { style:'currency', currency:code, maximumFractionDigits:4 }).format(v); }
  catch { return v.toFixed(4) + ' ' + code; }
}

async function wireFx(){
  const amount = document.getElementById('fx-amount');
  const from   = document.getElementById('fx-from');
  const to     = document.getElementById('fx-to');
  const swap   = document.getElementById('fx-swap');
  const goBtn  = document.getElementById('fx-go');
  const result = document.getElementById('fx-result');
  const rate   = document.getElementById('fx-rate');
  if (!amount || !from || !to) return;

  const opts = FX_LIST.map(([c,n]) => `<option value="${c}">${c} — ${n}</option>`).join('');
  from.innerHTML = opts; to.innerHTML = opts;
  from.value = 'USD'; to.value = 'EUR';

  const update = () => {
    const a = parseFloat(amount.value);
    if (!isFinite(a) || a < 0) { result.textContent = '—'; rate.textContent = (window.t ? window.t('calc.invalid_amount') : 'Enter a valid amount.'); return; }
    if (!FX_RATES) { result.textContent = '—'; rate.textContent = (window.t ? window.t('calc.loading_rates') : 'Loading rates\u2026'); return; }
    const v = fxConvert(a, from.value, to.value);
    if (v === null) { result.textContent = '—'; rate.textContent = (window.t ? window.t('calc.rate_unavailable') : 'Rate unavailable for this pair.'); return; }
    result.textContent = fmtMoney(v, to.value);
    const one = fxConvert(1, from.value, to.value);
    const note = FX_FALLBACK_USED ? '  ' + (window.t ? window.t('calc.offline_rates') : '(offline rates)') : '';
    rate.textContent = `1 ${from.value} = ${one.toFixed(4)} ${to.value}${note}`;
  };

  [amount, from, to].forEach(el => el.addEventListener('input', update));
  [from, to].forEach(el => el.addEventListener('change', update));
  swap.addEventListener('click', () => { const t = from.value; from.value = to.value; to.value = t; update(); });
  goBtn && goBtn.addEventListener('click', update);

  rate.textContent = (window.t ? window.t('calc.loading_rates') : 'Loading rates\u2026');
  const timeout = new Promise(res => setTimeout(() => { FX_FALLBACK_USED = true; res(FX_STATIC); }, 6000));
  FX_RATES = await Promise.race([loadRates(), timeout]);
  update();
}

/* ─── PHASE 4: SESSION-LENGTH — Continue Where You Left Off ─────────────── */

function _timeAgo(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function renderSessionContinue() {
  const section = document.getElementById('session-continue-section');
  if (!section) return;

  const items = [];

  try {
    if (window.SessionPersist) {
      // 1. Resume a paused session (not yet at download / not upload step)
      const resume = window.SessionPersist.loadResume();
      if (resume && resume.slug && resume.step && resume.step !== 'upload') {
        const toolName = resume.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const stepLabel = resume.step === 'download' ? 'ready to download' : resume.step;
        items.push({
          icon:  'arrow-right-circle',
          label: 'Continue: ' + toolName,
          badge: stepLabel,
          href:  '/' + resume.slug,
        });
      }

      // 2. Recent downloads (up to 2 most recent)
      const downloads = window.SessionPersist.getDownloads();
      downloads.slice(0, 2).forEach(dl => {
        if (!dl || !dl.name) return;
        items.push({
          icon:  'download',
          label: dl.name,
          badge: _timeAgo(dl.ts),
          href:  dl.slug ? '/' + dl.slug : '/',
        });
      });
    }
  } catch (_) {}

  if (!items.length) { section.style.display = 'none'; return; }

  section.style.display = '';
  section.innerHTML = `
    <div class="session-continue-title">
      <i data-lucide="history"></i> Continue Where You Left Off
    </div>
    <div class="session-continue-items">
      ${items.map(item => `
        <a class="session-continue-item" href="${item.href}">
          <i data-lucide="${item.icon}"></i>
          <span class="session-continue-label">${item.label}</span>
          <span class="session-continue-badge">${item.badge}</span>
        </a>`).join('')}
    </div>`;

  const tryIcons = () => window.lucide && window.lucide.createIcons && window.lucide.createIcons({ nodes: [section] });
  tryIcons();
  setTimeout(tryIcons, 120);
}

/* ─── INIT ──────────────────────────────────────────────────────────────── */

/*
 * Home-card icon stability:
 * Do not rebuild the category/recent card DOM on every i18n event. Rebuilding
 * replaces already-created Lucide SVGs with fresh <i data-lucide> nodes; if
 * Lucide is between loads/renders, the sticker briefly appears and then
 * disappears. We render once, patch text in place, and centralize icon refresh.
 */
function refreshHomeIcons() {
  let tries = 0;
  const trigger = () => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try {
        window.lucide.createIcons();
      } catch (_) {}
      return true;
    }
    return false;
  };

  // Immediate attempt
  if (trigger()) {
    setTimeout(trigger, 100);
    setTimeout(trigger, 300);
    setTimeout(trigger, 800);
  }

  // Polling loop until Lucide script is loaded
  const interval = setInterval(() => {
    tries++;
    if (trigger() || tries > 40) {
      clearInterval(interval);
    }
  }, 100);

  window.addEventListener('load', trigger, { once: true });
}

function waitForToolGroupsAndRender(){
  let attempts = 0;
  const run = () => {
    const ready = Array.isArray(window.TOOL_GROUPS) && window.TOOL_GROUPS.length > 0;
    if (ready) {
      renderRecentUse();
      renderCategorySections();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { refreshHomeIcons(); });
      } else {
        setTimeout(refreshHomeIcons, 0);
      }
      return;
    }
    if (++attempts < 150) setTimeout(run, 16);
  };
  run();
}

window.renderCategorySections = renderCategorySections;
window.renderRecentUse = renderRecentUse;

function bootHomePage() {
  renderSessionContinue();
  waitForToolGroupsAndRender();
  wireCalc();
  wireCalcToggle();
  wireFx();

  window.addEventListener('i18n:change', () => {
    if (window.RuntimeI18n) {
      const root = document.getElementById('tools-root');
      if (root) window.RuntimeI18n.patch(root);
      ['cat-pdf-tools','cat-image-tools','cat-utilities'].forEach(id => {
        const el = document.getElementById(id);
        if (el) window.RuntimeI18n.patch(el);
      });
    }
    refreshHomeIcons();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootHomePage);
} else {
  bootHomePage();
}
