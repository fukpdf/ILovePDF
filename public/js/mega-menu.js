// v2 Mega menu — slim header nav (Organize / Convert / Edit / Security / ALL TOOLS)
// + Login / Sign Up + a full-width ALL TOOLS dropdown with category grid.

const TOOL_TIPS = {
  'merge':'Merge multiple PDFs into one file',
  'split':'Split a PDF into separate documents',
  'rotate':'Rotate PDF pages to the correct orientation',
  'crop':'Trim or crop PDF page margins',
  'organize':'Reorder, add, or remove PDF pages',
  'compress':'Reduce PDF file size while keeping quality',
  'pdf-to-word':'Convert a PDF into an editable Word document',
  'pdf-to-powerpoint':'Convert a PDF into a PowerPoint deck',
  'pdf-to-excel':'Extract tables from a PDF into Excel',
  'pdf-to-jpg':'Convert PDF pages into JPG images',
  'word-to-pdf':'Convert a Word document to PDF',
  'powerpoint-to-pdf':'Convert a PowerPoint deck to PDF',
  'excel-to-pdf':'Convert an Excel file to PDF',
  'jpg-to-pdf':'Combine images into a single PDF',
  'html-to-pdf':'Capture an HTML page as a PDF',
  'edit':'Edit text, images, and shapes in a PDF',
  'watermark':'Add a watermark image or text to a PDF',
  'sign':'Sign a PDF electronically',
  'page-numbers':'Add page numbers to your PDF',
  'redact':'Permanently hide sensitive content',
  'protect':'Password-protect a PDF',
  'unlock':'Remove the password from a PDF',
  'repair':'Repair a corrupted PDF file',
  'scan':'Scan and convert physical pages to PDF',
  'ocr':'Extract searchable text from scanned PDFs',
  'compare':'Compare two PDFs side by side',
  'ai-summarize':'Summarize a long PDF with AI',
  'translate':'Translate the text in a PDF',
  'workflow':'Chain multiple PDF tools together',
  'numbers-to-words':'Convert numbers, currency, or check amounts into words',
  'background-remover':'Remove the background from any image',
  'crop-image':'Crop an image to a custom size',
  'resize-image':'Resize images for web or print',
  'image-filters':'Apply filters and effects to your image',
};

// Map category → header nav button it belongs under
const NAV_GROUPS = [
  { label:'Organize', categories:['Organize PDFs', 'Compress & Optimize'] },
  { label:'Convert',  categories:['Convert From PDF', 'Convert To PDF'] },
  { label:'Edit',     categories:['Edit & Annotate'] },
  { label:'Security', categories:['Security'] },
];

const CAT_DOTS = {
  'Organize PDFs': '#5b3df5',
  'Compress & Optimize': '#10b981',
  'Convert From PDF': '#f59e0b',
  'Convert To PDF': '#8b5cf6',
  'Edit & Annotate': '#ec4899',
  'Security': '#ef4444',
  'Advanced Tools': '#6366f1',
  'Image Tools': '#a855f7',
};

function toolHref(t){ return t.url || `/tool.html?id=${t.id}`; }
function tip(t){ return TOOL_TIPS[t.id] || t.description || ''; }

function buildHeaderNav() {
  const nav = document.getElementById('mega-nav');
  if (!nav) return;
  // Wrap in a fresh container; hide the old per-category nav via CSS.
  const wrap = document.createElement('div');
  wrap.className = 'v2-nav';
  wrap.innerHTML = NAV_GROUPS.map(g => `
    <button class="v2-nav-btn" data-group="${g.label}" type="button">
      ${g.label}
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  `).join('') + `
    <button class="v2-nav-btn is-primary" id="all-tools-btn" type="button" aria-expanded="false">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      ALL TOOLS
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  `;
  // Auth buttons on the right
  const auth = document.createElement('div');
  auth.className = 'v2-auth';
  auth.innerHTML = `
    <button class="btn-login" id="v2-login">Log In</button>
    <button class="btn-signup" id="v2-signup">Sign Up</button>
  `;
  nav.parentNode.insertBefore(wrap, nav);
  nav.parentNode.insertBefore(auth, nav.nextSibling);

  // Group buttons: open the ALL TOOLS panel scrolled to that section
  wrap.querySelectorAll('.v2-nav-btn[data-group]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openMega();
      const first = NAV_GROUPS.find(g => g.label === btn.dataset.group)?.categories?.[0];
      if (first) {
        const target = document.querySelector(`.v2-mega-cat[data-cat="${CSS.escape(first)}"]`);
        target?.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });
  });

  // Auth wiring → open the n2w-style auth modal if present, else navigate to n2w
  auth.querySelector('#v2-login').addEventListener('click', () => goAuth('login'));
  auth.querySelector('#v2-signup').addEventListener('click', () => goAuth('signup'));
}

function goAuth(mode){
  // Use the converter page (which has the full auth modal already wired)
  window.location.href = `/n2w.html#auth=${mode}`;
}

function buildAllToolsMega(){
  // Create overlay + panel once
  if (document.getElementById('v2-mega')) return;
  const overlay = document.createElement('div');
  overlay.className = 'v2-mega-overlay';
  overlay.id = 'v2-mega-overlay';
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.className = 'v2-mega';
  panel.id = 'v2-mega';
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-label','All Tools');

  // group tools by category in CATEGORIES order
  const grouped = {};
  TOOLS.forEach(t => { (grouped[t.category] = grouped[t.category] || []).push(t); });

  const catsHtml = CATEGORIES.map(cat => {
    const tools = grouped[cat.name] || [];
    if (!tools.length) return '';
    const dot = CAT_DOTS[cat.name] || '#64748b';
    const items = tools.map(t => `
      <a class="v2-tool" href="${toolHref(t)}" data-tip="${tip(t).replace(/"/g,'&quot;')}">
        <span class="ico"><i data-lucide="${t.icon}"></i></span>
        <span class="body">
          <span class="name">${t.name}</span>
          <span class="sub">${(t.description||'').replace(/</g,'&lt;')}</span>
        </span>
      </a>`).join('');
    return `
      <div class="v2-mega-cat" data-cat="${cat.name}">
        <h4><span class="dot" style="background:${dot}"></span>${cat.name}</h4>
        <div class="cat-tools">${items}</div>
      </div>`;
  }).join('');

  panel.innerHTML = `<div class="v2-mega-inner"><div class="v2-mega-grid">${catsHtml}</div></div>`;
  document.body.appendChild(panel);

  if (window.lucide) lucide.createIcons();

  overlay.addEventListener('click', closeMega);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMega(); });
}

function openMega(){
  buildAllToolsMega();
  document.getElementById('v2-mega').classList.add('open');
  document.getElementById('v2-mega-overlay').classList.add('open');
  const btn = document.getElementById('all-tools-btn');
  btn?.setAttribute('aria-expanded','true');
}
function closeMega(){
  document.getElementById('v2-mega')?.classList.remove('open');
  document.getElementById('v2-mega-overlay')?.classList.remove('open');
  document.getElementById('all-tools-btn')?.setAttribute('aria-expanded','false');
}
function toggleMega(){
  const open = document.getElementById('v2-mega')?.classList.contains('open');
  open ? closeMega() : openMega();
}

document.addEventListener('DOMContentLoaded', () => {
  buildHeaderNav();
  buildAllToolsMega();
  document.getElementById('all-tools-btn')?.addEventListener('click', e => {
    e.stopPropagation(); toggleMega();
  });
  // Click outside the panel closes it
  document.addEventListener('click', e => {
    const panel = document.getElementById('v2-mega');
    if (!panel?.classList.contains('open')) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest('#all-tools-btn')) return;
    closeMega();
  });
});
