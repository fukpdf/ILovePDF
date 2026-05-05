let currentTool = null;
let selectedFiles = [];   // array of { file, rotation, id }
let dragSrcIndex = null;
let pageOrganizer = null; // active PageOrganizer controller (single-PDF page-level UI)

// ── 3-STEP FLOW (Upload → Preview → Download) ─────────────────────────────
// Routes:
//   /<slug>            → upload  (canonical, indexed)
//   /<slug>/preview    → preview (noindex, requires file state)
//   /<slug>/download   → download (noindex, requires processed result)
//
// State lives in memory + history.pushState navigates between steps without
// reloading (so File objects survive). Direct deep-links to preview/download
// without state are redirected back to upload.
const Flow = {
  step: 'upload',
  result: null,            // { html, ts } — captured #result-area markup after success

  baseSlug() {
    if (window.__TOOL_SLUG) return window.__TOOL_SLUG;
    const p = (window.location.pathname || '/').replace(/\/+$/, '').replace(/^\/+/, '');
    return p.replace(/\/(preview|download)$/i, '');
  },

  navTo(step, opts = {}) {
    const slug = this.baseSlug();
    const target = step === 'upload' ? `/${slug}` : `/${slug}/${step}`;
    this.step = step;
    if (!opts.skipPush) {
      try {
        const fn = opts.replace ? 'replaceState' : 'pushState';
        history[fn]({ step }, '', target);
      } catch (_) {}
    }
    setMetaForStep(step);
    renderStep();
    try { window.scrollTo(0, 0); } catch (_) {}
  },

  // Capture the current #result-area HTML so it can be re-shown on the
  // download step. Called after every success path in processFile() (and the
  // queue path via the wrapped showStatus). Idempotent.
  commitResult() {
    const area = document.getElementById('result-area');
    if (!area) return;
    const html = area.innerHTML;
    if (!html || !html.trim()) return;
    this.result = { html, ts: Date.now() };

    // Persist for refresh-survival: store HTML in sessionStorage; if the
    // download anchor uses a blob: URL (client-side tools), also stash the
    // blob in IndexedDB so we can hand the user a fresh URL after reload.
    persistFlowState();
    captureResultBlob(area);
    this.navTo('download');
  },

  reset() {
    this.result = null;
    this.step = 'upload';
    if (window.ToolState) ToolState.clear(this.baseSlug());
  },
};

// ── PERSISTENCE BRIDGE ────────────────────────────────────────────────────
// Mirror the in-memory Flow state to sessionStorage + IndexedDB after every
// meaningful change so a refresh / direct nav doesn't lose work.

function persistFlowState() {
  if (!window.ToolState || !currentTool) return;
  const slug = Flow.baseSlug();
  ToolState.save(slug, {
    step: Flow.step,
    files: selectedFiles.map(w => ({
      id: w.id,
      name: w.file && w.file.name,
      size: w.file && w.file.size,
      type: w.file && w.file.type,
      rotation: w.rotation || 0,
    })),
    result: Flow.result ? {
      html: Flow.result.html,
      ts: Flow.result.ts,
    } : null,
  });
  // Also persist the actual file blobs (idempotent put, keyed by file.id).
  selectedFiles.forEach(w => {
    if (w.file && w.id) ToolState.putBlob(slug, 'file:' + w.id, w.file);
  });
}

// Find a download anchor with a blob: href in the result area, fetch the
// blob, and store it in IDB so we can re-issue a working URL after refresh.
async function captureResultBlob(scope) {
  if (!window.ToolState || !currentTool) return;
  const slug = Flow.baseSlug();
  const a = scope.querySelector('a[download][href^="blob:"]');
  if (!a) return;
  try {
    const res  = await fetch(a.getAttribute('href'));
    const blob = await res.blob();
    await ToolState.putBlob(slug, 'result', blob);
    // Also stash the original filename so we can rebuild the anchor on hydrate.
    const fname = a.getAttribute('download') || 'download';
    ToolState.save(slug, {
      ...(ToolState.load(slug) || {}),
      resultFilename: fname,
    });
  } catch (_) { /* non-fatal — user can re-process */ }
}

// Rebuild selectedFiles from saved state. Returns a promise that resolves
// once IndexedDB lookups complete (or fails fast if no blob is recoverable).
async function hydrateFlowState() {
  if (!window.ToolState || !currentTool) return false;
  const slug  = Flow.baseSlug();
  const state = ToolState.load(slug);
  if (!state) return false;

  // Re-attach files from IDB blobs.
  if (Array.isArray(state.files) && state.files.length) {
    const rebuilt = [];
    for (const meta of state.files) {
      const blob = await ToolState.getBlob(slug, 'file:' + meta.id);
      if (!blob) { rebuilt.length = 0; break; }            // can't recover → start over
      const f = new File([blob], meta.name || 'file', { type: meta.type || blob.type });
      rebuilt.push({ file: f, rotation: meta.rotation || 0, id: meta.id });
    }
    selectedFiles = rebuilt;
  }

  // Re-attach result HTML, swapping any stale blob: hrefs for a fresh URL
  // pointing at the IDB-stored result blob.
  if (state.result && state.result.html) {
    let html = state.result.html;
    const resultBlob = await ToolState.getBlob(slug, 'result');
    if (resultBlob) {
      const fresh = URL.createObjectURL(resultBlob);
      html = ToolState.rewriteBlobHrefs(html, fresh);
    }
    Flow.result = { html, ts: state.result.ts };
  }
  return true;
}

function setMetaForStep(step) {
  if (!currentTool) return;
  const name = currentTool.name;
  if (step === 'preview') {
    document.title = `Preview & Process — ${name} | ILovePDF`;
    setMeta('description', `Review your file and run ${name}. Free online tool by ILovePDF — no signup required.`);
  } else if (step === 'download') {
    document.title = `Your file is ready — ${name} | ILovePDF`;
    setMeta('description', `Your file is ready. Files are deleted automatically — free online ${name} by ILovePDF.`);
  } else {
    document.title = `${name} Online Free — ILovePDF`;
    setMeta('description', `Free online ${name} tool. ${currentTool.description}. No signup required — fast, secure, and free on ILovePDF.`);
  }
  // Canonical always points to the base tool URL (upload step) — not preview/download sub-paths.
  const slug = currentTool.slug || currentTool.id;
  if (slug) {
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = `${window.location.origin}/${slug}`;
  }
}

function stepFromPath() {
  const p = (window.location.pathname || '/').toLowerCase();
  if (/\/preview\/?$/.test(p))  return 'preview';
  if (/\/download\/?$/.test(p)) return 'download';
  return 'upload';
}

window.addEventListener('popstate', () => {
  const path    = window.location.pathname;
  const rawSlug = path.replace(/^\/+/, '').replace(/\/(preview|download)\/?$/i, '').toLowerCase().split('?')[0].split('#')[0];
  const meta    = window.SLUG_MAP && window.SLUG_MAP[rawSlug];
  const toolId  = (meta && meta.id) ? meta.id : rawSlug;

  if (currentTool && currentTool.id === toolId) {
    Flow.step = stepFromPath();
    setMetaForStep(Flow.step);
    renderStep();
    return;
  }

  if (typeof window.loadToolPage === 'function') {
    window.loadToolPage(path);
  } else if (currentTool) {
    Flow.step = stepFromPath();
    setMetaForStep(Flow.step);
    renderStep();
  }
});

window.Flow = Flow; // exposed for queue-client and any future hookups

document.addEventListener('DOMContentLoaded', () => {
  // Category hub pages (/pdf-tools, /convert-pdf, etc.) use the same shell but
  // have no tool to render — bail out so we don't show a "Tool not found" card.
  if (window.__CATEGORY_PAGE === true) return;

  // Resolution order:
  //   1. window.__TOOL_ID (Express SEO middleware injection — Node-served only)
  //   2. ?id=… legacy query param
  //   3. URL pathname slug → SLUG_MAP lookup (works on Firebase static hosting)
  const toolId = (typeof window.resolveToolIdFromUrl === 'function')
    ? window.resolveToolIdFromUrl()
    : (window.__TOOL_ID || new URLSearchParams(window.location.search).get('id'));

  // ── Loop-safe redirect helper ────────────────────────────────────────────
  // Firebase Hosting's catch-all rewrite (** → /index.html) plus pathname-only
  // comparisons made it possible for a redirect to fire on every page load.
  // We now (a) compare just the pathname (stripping query/hash/trailing slash)
  // and (b) guard with sessionStorage so the same target URL can never be
  // jumped to twice in a row from this script.
  function pathOnly(u) {
    try {
      const x = new URL(u, window.location.origin);
      return x.pathname.replace(/\/+$/, '') || '/';
    } catch { return String(u || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/'; }
  }
  function safeRedirect(target) {
    const here = pathOnly(window.location.pathname);
    const dest = pathOnly(target);
    if (!dest || here === dest) return false;             // already there
    const guardKey = '__tp_redir__';
    const last = sessionStorage.getItem(guardKey);
    if (last === dest) {                                   // already bounced once
      try { sessionStorage.removeItem(guardKey); } catch {}
      return false;
    }
    try { sessionStorage.setItem(guardKey, dest); } catch {}
    window.location.replace(target);
    return true;
  }

  // Honour SLUG_MAP "special" redirects (e.g. numbers-to-words → /n2w.html).
  // On Node this is handled server-side; on Firebase static we have to do it here.
  const slug = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const slugMeta = window.SLUG_MAP && window.SLUG_MAP[slug];
  if (slugMeta && slugMeta.special) {
    if (safeRedirect(slugMeta.special)) return;
  }

  currentTool = TOOLS.find(t => t.id === toolId);

  // Tool has a dedicated standalone page (e.g. numbers-to-words → /n2w.html)
  if (currentTool && currentTool.url) {
    if (safeRedirect(currentTool.url)) return;
  }

  // Made it to the right page — clear the loop guard so a future legit
  // navigation (e.g. user clicks back, then forward to a redirecting tool) works.
  try { sessionStorage.removeItem('__tp_redir__'); } catch {}

  if (!currentTool) {
    // Show a friendly 404 instead of silently bouncing to home (which looked
    // like the page was "refreshing" itself when SEO injection wasn't present).
    renderNotFound(toolId, slug);
    return;
  }

  buildSidebar(currentTool.id);

  // Initial step from server-injected window.__STEP (or URL on Firebase static)
  Flow.step = window.__STEP || stepFromPath();

  // Try to rehydrate persisted state for this tool (sessionStorage + IDB).
  // If hydration succeeds the user can refresh on /preview or /download
  // and keep their place; otherwise renderStep's guards send them back to
  // the upload step automatically.
  hydrateFlowState().finally(() => renderStep());
});

function renderNotFound(toolId, slug) {
  const c = document.getElementById('tool-content');
  if (!c) return;
  // BUG-1 FIX: auto-redirect to homepage after 3 s so users are never stranded
  // on a broken route (e.g. refreshing mid-session with no state).
  clearTimeout(window.__aeNotFoundTimer);
  window.__aeNotFoundTimer = setTimeout(function () {
    const p = window.location.pathname;
    if (p !== '/' && p !== '/index.html') window.location.href = '/';
  }, 3000);

  let countdown = 3;
  c.innerHTML = `
    <div class="tool-page">
      <div class="tool-header">
        <a href="/" class="back-link" onclick="clearTimeout(window.__aeNotFoundTimer)">
          <i data-lucide="arrow-left"></i> All Tools
        </a>
      </div>
      <div class="status-card status-error" style="margin-top:24px">
        <i data-lucide="home"></i>
        <div>
          <div class="status-card-title">Page not found</div>
          <div class="status-card-msg">
            Taking you back to all tools in
            <strong id="ae-nf-count">3</strong> second(s)…
            <br><a href="/" style="color:#E5322E;font-weight:600"
                  onclick="clearTimeout(window.__aeNotFoundTimer)">Go now →</a>
          </div>
        </div>
      </div>
    </div>`;

  const tick = setInterval(function () {
    countdown--;
    const el = document.getElementById('ae-nf-count');
    if (el) el.textContent = countdown;
    if (countdown <= 0) clearInterval(tick);
  }, 1000);

  if (window.lucide) lucide.createIcons();
}

// ── 3-STEP RENDER ORCHESTRATOR ────────────────────────────────────────────
// renderStep dispatches to the appropriate step renderer based on Flow.step,
// guarding against direct deep-links that lack the required state.

function renderStep() {
  if (!currentTool) return;
  setMeta('keywords', `${currentTool.name.toLowerCase()}, ${currentTool.name.toLowerCase()} online, ${currentTool.name.toLowerCase()} free, ilovepdf, pdf tools online`);

  // Guard: preview needs files; download needs a captured result.
  if (Flow.step === 'preview' && selectedFiles.length === 0) {
    return Flow.navTo('upload', { replace: true });
  }
  if (Flow.step === 'download' && !Flow.result) {
    return Flow.navTo('upload', { replace: true });
  }

  if (Flow.step === 'preview')  return renderPreviewStep(currentTool);
  if (Flow.step === 'download') return renderDownloadStep(currentTool);
  return renderUploadStep(currentTool);
}

// Reusable: tool icon + title + description + live/coming-soon badge.
function toolHeaderBlock(tool, opts = {}) {
  const catMeta = CATEGORIES.find(c => c.name === tool.category);
  const color = catMeta ? catMeta.color : '#E5322E';
  const bgAlpha = hexToRgba(color, 0.12);
  const statusHtml = !opts.hideStatus && tool.working
    ? `<span class="tool-status status-live"><span class="status-dot"></span>Live &amp; Ready</span>`
    : (!opts.hideStatus && !tool.working
        ? `<span class="tool-status status-soon"><span class="status-dot"></span>Coming Soon</span>`
        : '');
  const heading = opts.heading || tool.name;
  const desc    = opts.desc    || tool.description;
  const icon    = opts.icon    || tool.icon;
  const back    = opts.back    || { href: '/', label: 'All Tools' };
  const backHtml = back.href.startsWith('#step:')
    ? `<button type="button" class="back-link" data-go-step="${back.href.slice(6)}"><i data-lucide="arrow-left"></i> ${back.label}</button>`
    : `<a href="${back.href}" class="back-link"><i data-lucide="arrow-left"></i> ${back.label}</a>`;

  return `
    <div class="tool-header">
      ${backHtml}
      <div class="tool-header-top">
        <div class="tool-header-icon" style="background:${bgAlpha}; color:${color}">
          <i data-lucide="${icon}"></i>
        </div>
        <div class="tool-header-info">
          <h1 class="tool-header-name">${heading}</h1>
          <div class="tool-header-desc">${desc}</div>
          ${statusHtml}
        </div>
      </div>
    </div>`;
}

// Reusable: 1 → 2 → 3 step indicator. Past steps are buttons (clickable);
// current step is highlighted; future steps are dimmed and not interactive.
function stepIndicatorHtml(currentStep) {
  const steps = [
    { id: 'upload',   label: 'Upload',   icon: 'upload' },
    { id: 'preview',  label: 'Preview',  icon: 'eye' },
    { id: 'download', label: 'Download', icon: 'download' },
  ];
  const order = { upload: 0, preview: 1, download: 2 };
  const cur = order[currentStep] ?? 0;
  return `
    <nav class="step-indicator" aria-label="Progress">
      <ol>
        ${steps.map((s, i) => {
          const state = i < cur ? 'past' : (i === cur ? 'current' : 'future');
          const inner = `
            <span class="step-num"><i data-lucide="${s.icon}"></i></span>
            <span class="step-label">${s.label}</span>`;
          const node = state === 'past'
            ? `<button type="button" class="step is-past" data-go-step="${s.id}" aria-label="Back to ${s.label} step">${inner}</button>`
            : `<span class="step is-${state}"${state === 'current' ? ' aria-current="step"' : ''}>${inner}</span>`;
          const sep = i < steps.length - 1 ? `<span class="step-sep" aria-hidden="true"></span>` : '';
          return `<li class="step-item is-${state}">${node}${sep}</li>`;
        }).join('')}
      </ol>
    </nav>`;
}

// Wire data-go-step="upload|preview|download" buttons → Flow.navTo.
function wireStepNav() {
  document.querySelectorAll('[data-go-step]').forEach(el => {
    if (el.dataset.stepBound === '1') return;
    el.dataset.stepBound = '1';
    el.addEventListener('click', e => {
      e.preventDefault();
      const step = el.getAttribute('data-go-step');
      if (!step) return;
      if (step === 'upload') {
        // Going back to upload from preview/download = restart the flow.
        clearAll();
      }
      Flow.navTo(step);
    });
  });
}

// Build the standard form-options section used by tools that declare
// `tool.options`. Compress has its own custom UI handled separately.
function buildOptionsHtml(tool) {
  if (tool.id === 'compress') return renderCompressOptionsHtml();
  if (!tool.options || tool.options.length === 0) return '';
  const fields = tool.options.map(opt => {
    if (opt.type === 'select') {
      const opts = opt.options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
      return `
        <div class="form-group">
          <label class="form-label">${opt.label}</label>
          <select class="form-select" name="${opt.id}" id="opt-${opt.id}">${opts}</select>
        </div>`;
    }
    return `
      <div class="form-group">
        <label class="form-label">${opt.label}</label>
        <input class="form-input" type="${opt.type}" name="${opt.id}" id="opt-${opt.id}"
          placeholder="${opt.placeholder || ''}" ${opt.required ? 'required' : ''}>
      </div>`;
  }).join('');
  return `
    <div class="options-section">
      <div class="options-title"><i data-lucide="sliders-horizontal"></i> Options</div>
      <div class="options-grid">${fields}</div>
    </div>`;
}

// Reusable: trust strip shown on upload + preview steps so visitors see
// the safety/privacy commitments before they hand over a file. Required
// signals for AdSense reviewers.
function trustStripHtml() {
  return `
    <ul class="trust-strip" aria-label="Why you can trust this tool">
      <li><i data-lucide="shield-check"></i> Secure processing</li>
      <li><i data-lucide="trash-2"></i> Files auto-deleted after 10&nbsp;minutes</li>
      <li><i data-lucide="cloud-off"></i> No installation required</li>
    </ul>`;
}

// "Popular Tools" mini-grid for internal linking. Renders 6 hand-picked
// tools (skips whatever tool the user is currently on).
// Map tool.id (internal) → URL slug used for the per-tool blog guide
// (`/blog/<urlSlug>-guide.html`). One entry per tool, mirrors SLUG_MAP.
const TOOL_ID_TO_BLOG_SLUG = {
  'merge':              'merge-pdf',
  'split':              'split-pdf',
  'rotate':             'rotate-pdf',
  'crop':               'crop-pdf',
  'organize':           'organize-pdf',
  'compress':           'compress-pdf',
  'pdf-to-word':        'pdf-to-word',
  'pdf-to-powerpoint':  'pdf-to-powerpoint',
  'pdf-to-excel':       'pdf-to-excel',
  'pdf-to-jpg':         'pdf-to-jpg',
  'word-to-pdf':        'word-to-pdf',
  'powerpoint-to-pdf':  'powerpoint-to-pdf',
  'excel-to-pdf':       'excel-to-pdf',
  'jpg-to-pdf':         'jpg-to-pdf',
  'html-to-pdf':        'html-to-pdf',
  'edit':               'edit-pdf',
  'watermark':          'watermark-pdf',
  'sign':               'sign-pdf',
  'page-numbers':       'add-page-numbers',
  'redact':             'redact-pdf',
  'protect':            'protect-pdf',
  'unlock':             'unlock-pdf',
  'repair':             'repair-pdf',
  'scan-to-pdf':        'scan-pdf',
  'ocr':                'ocr-pdf',
  'compare':            'compare-pdf',
  'ai-summarize':       'ai-summarizer',
  'translate':          'translate-pdf',
  'workflow':           'workflow-builder',
  'numbers-to-words':   'numbers-to-words',
  'currency-converter': 'currency-converter',
  'background-remover': 'background-remover',
  'crop-image':         'crop-image',
  'resize-image':       'resize-image',
  'image-filters':      'image-filters',
};

// Renders a "Learn more" callout that links to the per-tool blog guide.
// Sits between the SEO content and the popular-tools grid on the upload step.
function learnMoreHtml(tool) {
  const slug = TOOL_ID_TO_BLOG_SLUG[tool.id];
  if (!slug) return '';
  return `
    <aside class="tool-learn-more" aria-label="Learn more about ${tool.name}">
      <div class="tool-learn-more-icon"><i data-lucide="book-open"></i></div>
      <div class="tool-learn-more-body">
        <span class="tool-learn-more-eyebrow">Guide</span>
        <h3>New to ${tool.name}? Read the full step-by-step guide</h3>
        <p>Pro tips, common pitfalls, FAQs and more — everything you need to get the best results from ${tool.name}.</p>
      </div>
      <a href="/blog/${slug}-guide.html" class="tool-learn-more-cta">
        Read guide <i data-lucide="arrow-right"></i>
      </a>
    </aside>`;
}

function popularToolsHtml(currentToolId) {
  const POPULAR = [
    { slug: 'merge-pdf',    name: 'Merge PDF',     icon: 'layers' },
    { slug: 'compress-pdf', name: 'Compress PDF',  icon: 'archive' },
    { slug: 'split-pdf',    name: 'Split PDF',     icon: 'scissors' },
    { slug: 'pdf-to-word',  name: 'PDF to Word',   icon: 'file-text' },
    { slug: 'pdf-to-jpg',   name: 'PDF to JPG',    icon: 'image' },
    { slug: 'word-to-pdf',  name: 'Word to PDF',   icon: 'file-text' },
    { slug: 'rotate-pdf',   name: 'Rotate PDF',    icon: 'rotate-cw' },
    { slug: 'organize-pdf', name: 'Organize PDF',  icon: 'list-ordered' },
  ];
  const list = POPULAR.filter(p => p.slug !== `${currentToolId}-pdf` && p.slug !== currentToolId).slice(0, 6);
  return `
    <section class="popular-tools" aria-label="Popular tools">
      <h2 class="popular-title">Popular tools</h2>
      <div class="popular-grid">
        ${list.map(t => `
          <a class="popular-card" href="/${t.slug}">
            <span class="popular-card-icon"><i data-lucide="${t.icon}"></i></span>
            <span class="popular-card-name">${t.name}</span>
          </a>`).join('')}
      </div>
    </section>`;
}

// ── STEP 1 — UPLOAD ───────────────────────────────────────────────────────
// Minimal hero: tool icon, name (H1), description, ONE big "Upload File"
// primary button. Drag-and-drop is still supported on the same area for
// power users. SEO content stays here on the canonical page.
function renderUploadStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;

  const fileLabel = tool.multipleFiles ? 'Upload Files' : 'Upload File';
  const multiAttr = tool.multipleFiles ? 'multiple' : '';
  const fileType  = tool.group === 'image' ? 'image' : 'PDF';

  container.innerHTML = `
    <div class="tool-page">
      ${toolHeaderBlock(tool)}
      ${stepIndicatorHtml('upload')}

      <section class="upload-step" aria-label="Upload your file">
        <div class="upload-area upload-area--hero" id="upload-area" tabindex="0" role="button" aria-label="${fileLabel}">
          <input type="file" id="file-input" accept="${tool.acceptedFiles}" ${multiAttr}>
          <div class="upload-icon"><i data-lucide="upload-cloud"></i></div>
          <button type="button" class="btn btn-primary btn-xl upload-cta" id="upload-cta-btn">
            <i data-lucide="upload"></i> ${fileLabel}
          </button>
          <div class="upload-step-or">or drag &amp; drop ${tool.multipleFiles ? `${fileType} files` : `your ${fileType}`} here</div>
          <div class="upload-step-meta">Accepted: ${tool.acceptedFiles} · Max 100&nbsp;MB${tool.multipleFiles ? ' · Multiple files allowed' : ''}</div>
        </div>

        ${trustStripHtml()}
      </section>

      ${renderSeoContent(tool)}

      ${learnMoreHtml(tool)}

      ${popularToolsHtml(tool.id)}
    </div>`;

  if (window.lucide) lucide.createIcons();
  setupFileInput();
  // The big CTA button just opens the same hidden file picker.
  const cta = document.getElementById('upload-cta-btn');
  if (cta) cta.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('file-input')?.click();
  });
  wireStepNav();
}

// ── STEP 2 — PREVIEW + PROCESS ────────────────────────────────────────────
// Shows the selected file(s), the tool's options, and a single Process CTA.
// Reuses every existing helper (renderFileList, maybeOpenPageOrganizer,
// processFile) — only the surrounding chrome changes.
function renderPreviewStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;

  const optionsHtml = buildOptionsHtml(tool);

  container.innerHTML = `
    <div class="tool-page">
      ${toolHeaderBlock(tool, {
        heading: `Preview & Process — ${tool.name}`,
        desc: `Review your ${tool.multipleFiles ? 'files' : 'file'} below, then click Process.`,
        icon: 'eye',
        hideStatus: true,
        back: { href: '#step:upload', label: 'Back to upload' },
      })}
      ${stepIndicatorHtml('preview')}

      <section class="preview-step upload-section" aria-label="Selected files">
        <span class="upload-label">
          <i data-lucide="file" style="display:inline-block;width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i>
          Selected ${tool.multipleFiles ? 'files' : 'file'}
        </span>
        <div class="upload-files-list" id="files-list"></div>
      </section>

      ${optionsHtml}

      <div class="process-btn-wrap">
        <button type="button" class="btn btn-primary btn-lg" id="process-btn" onclick="processFile()">
          <i data-lucide="zap"></i> Process ${tool.multipleFiles ? 'Files' : 'File'}
        </button>
        <button type="button" class="btn btn-outline" id="clear-btn" data-go-step="upload">
          <i data-lucide="x"></i> Clear &amp; restart
        </button>
      </div>

      ${trustStripHtml()}

      <div id="result-area"></div>
    </div>`;

  if (window.lucide) lucide.createIcons();
  renderFileList();
  maybeOpenPageOrganizer();
  wireStepNav();
}

// ── STEP 3 — DOWNLOAD ─────────────────────────────────────────────────────
// Re-renders the captured success markup (status card + Download button) on
// a dedicated page. The actual file was already auto-downloaded on Process,
// the visible button is a fallback in case the browser blocked it.
function renderDownloadStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  const slug = Flow.baseSlug();

  container.innerHTML = `
    <div class="tool-page">
      ${toolHeaderBlock(tool, {
        heading: `Your file is ready`,
        desc: `Files are deleted automatically — download below or try another tool.`,
        icon: 'check-circle-2',
        hideStatus: true,
        back: { href: '/', label: 'All Tools' },
      })}
      ${stepIndicatorHtml('download')}

      <section class="download-step" aria-label="Download your result">
        <div id="result-area" class="download-result">${Flow.result ? Flow.result.html : ''}</div>

        <div class="download-actions">
          <a href="/${slug}" class="btn btn-outline" data-go-step="upload">
            <i data-lucide="rotate-ccw"></i> Process another file
          </a>
          <a href="/" class="btn btn-outline">
            <i data-lucide="grid-3x3"></i> Try another tool
          </a>
          <a href="/blog.html" class="btn btn-outline">
            <i data-lucide="book-open"></i> Read guides
          </a>
        </div>
      </section>
    </div>`;

  if (window.lucide) lucide.createIcons();
  // Re-attach the burst animation to the cloned download button. The captured
  // markup still carries data-burst-bound="1", so clear it first to allow a
  // fresh binding on this dedicated download page.
  const area = document.getElementById('result-area');
  if (area) {
    area.querySelectorAll('[data-burst-bound]').forEach(el => el.removeAttribute('data-burst-bound'));
    if (typeof attachDownloadBurst === 'function') attachDownloadBurst(area);
  }
  wireStepNav();
}

// ── FILE INPUT ─────────────────────────────────────────────────────────────

function setupFileInput() {
  const input = document.getElementById('file-input');
  const area  = document.getElementById('upload-area');
  if (!input || !area) return;

  area.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    input.click();
  });
  input.addEventListener('change', () => handleFiles(input.files));
  area.addEventListener('dragover',  e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault(); area.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
}

function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const incoming = Array.from(fileList);

  // 100MB client-side check → show Sign Up Required modal
  for (const f of incoming) {
    if (f.size > MAX_FILE_BYTES) {
      showSignupModal(f);
      const inputEl = document.getElementById('file-input');
      if (inputEl) inputEl.value = '';
      return;
    }
  }

  const wrapped = incoming.map(f => ({ file: f, rotation: 0, id: cryptoId() }));

  if (currentTool.multipleFiles) {
    selectedFiles = [...selectedFiles, ...wrapped];
  } else {
    selectedFiles = [wrapped[0]];
  }

  // Persist immediately so a refresh on /preview keeps the file blobs.
  persistFlowState();

  // Files chosen on the upload step → navigate to preview step. Otherwise
  // (already on preview / adding more files) just refresh the file list.
  if (Flow.step === 'upload') {
    Flow.navTo('preview');
  } else {
    renderFileList();
    maybeOpenPageOrganizer();
  }
}

// ── PAGE ORGANIZER (high-res preview + per-page reorder/rotate/delete) ────
// When the current tool operates on a single PDF and PageOrganizer wants it,
// we hide the plain file row and mount the thumbnail grid.
function maybeOpenPageOrganizer() {
  // Compress gets its own dedicated single-page preview — bypass the
  // multi-page organizer grid entirely.
  if (currentTool && currentTool.id === 'compress') {
    closePageOrganizer();
    renderCompressPreview();
    return;
  }
  if (!window.PageOrganizer) return;
  const files = selectedFiles.map(e => e.file);
  if (!window.PageOrganizer.shouldHandle(currentTool.id, files)) {
    closePageOrganizer();
    return;
  }
  const list = document.getElementById('files-list');
  if (!list) return;
  // Hide the plain row and mount the organizer right above it.
  let host = document.getElementById('page-organizer');
  if (!host) {
    host = document.createElement('div');
    host.id = 'page-organizer';
    host.className = 'page-organizer';
    list.parentNode.insertBefore(host, list);
  }
  list.style.display = 'none';

  if (pageOrganizer) { try { pageOrganizer.destroy(); } catch {} pageOrganizer = null; }
  window.PageOrganizer.open(host, files[0], { onChange: () => {} })
    .then(ctrl => { pageOrganizer = ctrl; })
    .catch(() => {
      // Fall back to the plain file row so the user is never stuck.
      list.style.display = '';
      host.remove();
    });
}

function closePageOrganizer() {
  if (pageOrganizer) { try { pageOrganizer.destroy(); } catch {} pageOrganizer = null; }
  const host = document.getElementById('page-organizer');
  if (host) host.remove();
  const cmpHost = document.getElementById('compress-preview-host');
  if (cmpHost) cmpHost.remove();
  const list = document.getElementById('files-list');
  if (list) list.style.display = '';
}

function cryptoId() {
  return 'f' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function renderFileList() {
  const list     = document.getElementById('files-list');
  const clearBtn = document.getElementById('clear-btn');
  if (!list) return;

  if (selectedFiles.length === 0) {
    list.innerHTML = '';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (clearBtn) clearBtn.style.display = 'inline-flex';

  list.innerHTML = selectedFiles.map((entry, i) => {
    const f = entry.file;
    const isImage = /^image\//.test(f.type);
    const isPdf   = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    let thumb;
    if (isImage) {
      thumb = `<div class="file-thumb-wrap"><img src="${URL.createObjectURL(f)}" alt="" style="transform:rotate(${entry.rotation}deg)"></div>`;
    } else if (isPdf) {
      // PDF first-page preview (rendered async right after this innerHTML).
      thumb = `<div class="file-thumb-wrap pdf-thumb" data-pdf-thumb="${entry.id}"><i data-lucide="file-text"></i></div>`;
    } else {
      thumb = `<div class="file-thumb-wrap"><i data-lucide="file-text"></i></div>`;
    }
    return `
      <div class="upload-file-item" draggable="true" data-index="${i}">
        <i data-lucide="grip-vertical" class="file-drag-handle"></i>
        ${thumb}
        <span class="upload-file-name">${escapeHtml(f.name)}</span>
        <span class="upload-file-size">${formatBytes(f.size)}</span>
        <button class="file-rotate-btn" title="Rotate 90°" onclick="rotateFile(${i})" aria-label="Rotate file">
          <i data-lucide="rotate-cw"></i>
        </button>
        <button class="upload-file-remove" onclick="removeFile(${i})" title="Remove" aria-label="Remove file">
          <i data-lucide="x"></i>
        </button>
      </div>`;
  }).join('');

  if (window.lucide) lucide.createIcons();
  attachDragHandlers();
  renderPdfThumbnails();
}

// Render the first page of every PDF in the file list as an inline thumbnail.
// Speeds up the UI for tools like Merge by giving each row a real preview.
async function renderPdfThumbnails() {
  if (!window.PdfPreview) return;
  for (const entry of selectedFiles) {
    const host = document.querySelector(`[data-pdf-thumb="${entry.id}"]`);
    if (!host || host.dataset.rendered === '1') continue;
    host.dataset.rendered = '1';
    let pdfDoc;
    try {
      pdfDoc = await window.PdfPreview.loadDocument(entry.file);
      const canvas = await window.PdfPreview.renderPage(pdfDoc, 1, 64, 0);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.objectFit = 'cover';
      canvas.style.borderRadius = '6px';
      host.innerHTML = '';
      host.appendChild(canvas);
    } catch (_) {
      // Leave the fallback file-text icon in place.
    } finally {
      try { pdfDoc && window.PdfPreview.unloadDocument(pdfDoc); } catch (_) {}
    }
  }
}

function attachDragHandlers() {
  const items = document.querySelectorAll('#files-list .upload-file-item');
  items.forEach(el => {
    el.addEventListener('dragstart', e => {
      dragSrcIndex = parseInt(el.dataset.index, 10);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragSrcIndex));
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      items.forEach(i => i.classList.remove('drop-target'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      const target = parseInt(el.dataset.index, 10);
      if (dragSrcIndex === null || dragSrcIndex === target) return;
      const moved = selectedFiles.splice(dragSrcIndex, 1)[0];
      selectedFiles.splice(target, 0, moved);
      dragSrcIndex = null;
      renderFileList();
    });

    // Touch fallback: long-press + swap with neighbour using touch events
    let touchStartY = null;
    el.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (touchStartY === null) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const idx = parseInt(el.dataset.index, 10);
      if (Math.abs(dy) > 30) {
        const swap = dy > 0 ? idx + 1 : idx - 1;
        if (swap >= 0 && swap < selectedFiles.length) {
          [selectedFiles[idx], selectedFiles[swap]] = [selectedFiles[swap], selectedFiles[idx]];
          renderFileList();
        }
      }
      touchStartY = null;
    });
  });
}

function rotateFile(index) {
  if (!selectedFiles[index]) return;
  selectedFiles[index].rotation = (selectedFiles[index].rotation + 90) % 360;
  renderFileList();
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileList();
  if (selectedFiles.length === 0) {
    closePageOrganizer();
    if (typeof clearAllBursts === 'function') clearAllBursts();
  }
}

function clearAll() {
  selectedFiles = [];
  renderFileList();
  closePageOrganizer();
  const r = document.getElementById('result-area');
  if (r) r.innerHTML = '';
  const input = document.getElementById('file-input');
  if (input) input.value = '';
  if (typeof clearAllBursts === 'function') clearAllBursts();
  // Clear the captured download-step result so a fresh upload starts clean.
  Flow.result = null;
  // Wipe persisted state for this slug — sessionStorage + IndexedDB blobs.
  if (window.ToolState && currentTool) ToolState.clear(Flow.baseSlug());
}

// ── PROCESS FILE ───────────────────────────────────────────────────────────

async function processFile() {
  if (!currentTool) return;
  if (selectedFiles.length === 0) {
    showStatus('error', 'No file selected', 'Please upload a file before processing.');
    return;
  }
  if (!currentTool.working) { showComingSoon(currentTool.name); return; }

  // Daily usage limit — guests 15/day, logged-in 100/day
  if (window.UsageLimit && !window.UsageLimit.canUse()) {
    window.UsageLimit.showLimitModal();
    return;
  }

  // Re-check 100MB limit defensively
  for (const e of selectedFiles) {
    if (e.file.size > MAX_FILE_BYTES) { showSignupModal(e.file); return; }
  }

  // ── Page-organizer integration ──────────────────────────────────────────
  // If the user reordered, rotated, or deleted pages in the preview grid,
  // assemble the edited PDF here and substitute it for the original file.
  // Server-side and client-side flows both see the edited PDF transparently.
  if (pageOrganizer && selectedFiles.length === 1) {
    try {
      if (pageOrganizer.getPageCount() === 0) {
        showStatus('error', 'No pages selected', 'Please keep at least one page before processing.');
        return;
      }
      showProcessing('Processing your file…', 'Just a moment.');
      const { file: editedFile } = await pageOrganizer.getEditedPdf();
      if (editedFile.size > MAX_FILE_BYTES) { hideProcessing(); showSignupModal(editedFile); return; }
      selectedFiles[0] = { ...selectedFiles[0], file: editedFile, rotation: 0 };
      hideProcessing();
    } catch (err) {
      hideProcessing();
      showStatus('error', 'Please try again',
        'Processing is taking longer than usual. Please wait or try again later.');
      return;
    }
  }

  const formData = new FormData();

  if (currentTool.multipleFiles) {
    const isImgInput = currentTool.group === 'image' ||
                       currentTool.id === 'scan-to-pdf' ||
                       currentTool.id === 'jpg-to-pdf';
    const field = isImgInput ? 'images' : 'pdfs';
    selectedFiles.forEach(e => formData.append(field, e.file));
  } else {
    const field = currentTool.group === 'image' ? 'image' : 'pdf';
    formData.append(field, selectedFiles[0].file);
  }

  // Per-file rotations (server may use; safe to ignore otherwise)
  formData.append('rotations', JSON.stringify(selectedFiles.map(e => e.rotation)));

  (currentTool.options || []).forEach(opt => {
    const el = document.getElementById(`opt-${opt.id}`);
    if (el && el.value.trim() !== '') formData.append(opt.id, el.value.trim());
  });
  // Compress: inject the tier-aware level value (slider → 'low'|'medium'|'high').
  if (currentTool.id === 'compress') {
    const lvl = readCompressLevel();
    if (lvl) formData.append('level', lvl);
  }

  showProcessing(`Processing your file…`, 'This usually takes only a few seconds.');
  const processBtn = document.getElementById('process-btn');
  if (processBtn) processBtn.disabled = true;

  // ── Browser-side path FIRST: zero upload, instant result for any tool
  // marked `clientSide: true` and supported by BrowserTools. If the
  // browser handler succeeds we're done. If it throws (or signals
  // NO_BROWSER_GAIN — e.g. compress couldn't shrink it), we fall through
  // to the queue / direct paths below.
  if (currentTool.clientSide && window.BrowserTools && window.BrowserTools.supports(currentTool.id)) {
    try {
      const opts = {};
      (currentTool.options || []).forEach(o => {
        const el = document.getElementById(`opt-${o.id}`);
        if (el && el.value !== '') opts[o.id] = el.value;
      });
      const result = await window.BrowserTools.process(
        currentTool.id,
        selectedFiles.map(e => e.file),
        opts,
      );
      const { blob, filename } = result;
      hideProcessing();
      triggerDownload(blob, filename);
      if (window.UsageLimit) window.UsageLimit.record(selectedFiles.length);
      // Compress: surface "already optimised" when the PDF could not be shrunk.
      const isAlreadyOpt = currentTool.id === 'compress' && result.alreadyOptimized;
      showStatus(
        'success',
        isAlreadyOpt ? 'Already optimised' : 'Your file is ready',
        isAlreadyOpt
          ? 'Your PDF is already well-optimised. Use the deep compression option below for a stronger result.'
          : 'Press the button if download does not start automatically.',
        createStatusUrl(blob),
        filename,
      );
      if (currentTool.id === 'compress') appendCompressAdvancedLink();
      if (processBtn) processBtn.disabled = false;
      return;
    } catch (err) {
      hideProcessing();
      const rawMsg = (err && err.message) || '';
      let userMsg = 'Something went wrong. Please try again.';
      if (rawMsg === 'file_too_large_for_browser') {
        userMsg = 'This file is too large to process in the browser. Please use a file under 50 MB.';
      } else if (rawMsg === 'memory_pressure') {
        userMsg = 'Your browser is running low on memory. Please close other tabs and try again.';
      } else if (rawMsg && rawMsg !== '__orig__' &&
                 rawMsg !== 'NO_BROWSER_GAIN' &&
                 rawMsg !== 'No browser-side compression possible' &&
                 !rawMsg.startsWith('no_processor_') &&
                 rawMsg.length < 200) {
        userMsg = rawMsg.charAt(0).toUpperCase() + rawMsg.slice(1).replace(/_/g, ' ');
      }
      showStatus('error', 'Processing failed', userMsg);
      if (processBtn) processBtn.disabled = false;
      return;
    }
  }

  // No browser handler found for this tool
  hideProcessing();
  showStatus('error', 'Tool unavailable',
    'This tool is not yet available in your browser. Please try again in a moment.');
  if (processBtn) processBtn.disabled = false;
}

// ── BRANDED FILENAME ───────────────────────────────────────────────────────
// Returns "ILovePDF-[Original-Name].<ext>" — strips original ext, sanitises.
function brandedFilename(originalName, newExt) {
  const base = (originalName || 'file').replace(/\.[^.]+$/, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
  return `ILovePDF-${safe}${newExt}`;
}

// ── HELPERS ────────────────────────────────────────────────────────────────

function setMeta(name, content) {
  let m = document.querySelector(`meta[name="${name}"]`);
  if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m); }
  m.content = content;
}

function mimeToExt(ct) {
  if (ct.includes('application/pdf')) return '.pdf';
  if (ct.includes('wordprocessingml') || ct.includes('msword')) return '.docx';
  if (ct.includes('spreadsheetml') || ct.includes('ms-excel')) return '.xlsx';
  if (ct.includes('presentationml') || ct.includes('ms-powerpoint')) return '.pptx';
  if (ct.includes('image/jpeg')) return '.jpg';
  if (ct.includes('image/png'))  return '.png';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('application/zip')) return '.zip';
  return '.bin';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Create an object URL for showStatus download links and schedule automatic
// revocation after 5 minutes (generous enough for any user action).
function createStatusUrl(blob) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 5 * 60 * 1000);
  return url;
}

// Fetch with automatic retry on HTTP 429 (rate-limit only — hard limits like
// LIMIT_REACHED are not retried). Up to maxRetries attempts with exponential
// back-off starting at 1 s, doubling each time, capped at 8 s.
async function fetchWithRetry(url, options, maxRetries) {
  maxRetries = (maxRetries === undefined) ? 3 : maxRetries;
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);
    if (r.status === 429) {
      try {
        const data = await r.clone().json();
        // Hard limits should surface to the user immediately — no retry.
        if (data.error === 'LIMIT_REACHED' || data.error === 'FILE_TOO_LARGE') return r;
      } catch (_) {}
      if (attempt < maxRetries) {
        await new Promise(res => setTimeout(res, delay));
        delay = Math.min(delay * 2, 8000);
        continue;
      }
    }
    return r;
  }
}

// Compress: small "need more compression?" CTA appended below the standard
// success card. Clicking it runs a render-based deep compression entirely in
// the browser: each page is rasterised to JPEG then re-embedded in a new PDF.
function appendCompressAdvancedLink() {
  const area = document.getElementById('result-area');
  if (!area || area.querySelector('.compress-advanced-link')) return;
  const link = document.createElement('div');
  link.className = 'compress-advanced-link';
  link.innerHTML = `
    <p class="compress-advanced-hint">Need a smaller file?</p>
    <button type="button" class="btn btn-outline btn-sm" id="try-advanced-compress">
      <i data-lucide="zap"></i> Try deep compression
    </button>
    <p class="compress-advanced-note">Renders each page as an optimised image for maximum size reduction.</p>
  `;
  area.appendChild(link);
  if (window.lucide) lucide.createIcons();
  const btn = link.querySelector('#try-advanced-compress');
  if (btn) btn.addEventListener('click', runAdvancedCompress, { once: true });
}

async function runAdvancedCompress() {
  if (!selectedFiles || !selectedFiles.length) return;
  const btn = document.getElementById('try-advanced-compress');
  if (btn) { btn.disabled = true; btn.textContent = 'Compressing…'; }
  const processBtn = document.getElementById('process-btn');
  if (processBtn) processBtn.disabled = true;
  showProcessing('Applying deep compression…', 'Rendering pages for maximum size reduction.');

  try {
    // Render-based deep compression: every page → JPEG canvas → re-embedded PDF.
    const { PDFDocument } = await window.BrowserTools._loadPdfLib();
    let pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      const m = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
      pdfjsLib = m && (m.default || m);
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
      window.pdfjsLib = pdfjsLib;
    }

    const file    = selectedFiles[0].file;
    const data    = await file.arrayBuffer();
    const srcPdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const total   = srcPdf.numPages;
    const outDoc  = await PDFDocument.create();

    for (let i = 1; i <= total; i++) {
      showProcessing(
        `Deep compression — page ${i} of ${total}…`,
        'Optimising image quality for a smaller file size.',
      );
      const page = await srcPdf.getPage(i);
      // Native page size (points) — preserve original dimensions exactly.
      const vp1   = page.getViewport({ scale: 1 });
      const pw    = vp1.width;
      const ph    = vp1.height;
      // Render at ~110 DPI (scale ≈ 1.53) — good balance of quality vs size.
      const scale = Math.min(1.53, 110 / 72);
      const vp    = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      const jpgBytes = await new Promise((res, rej) => {
        canvas.toBlob(b => {
          if (!b) { rej(new Error('Canvas encode failed')); return; }
          b.arrayBuffer().then(ab => res(new Uint8Array(ab))).catch(rej);
        }, 'image/jpeg', 0.72);
      });
      canvas.width = 0; canvas.height = 0;
      const img = await outDoc.embedJpg(jpgBytes);
      const pg  = outDoc.addPage([pw, ph]);
      pg.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
    await srcPdf.destroy();

    const outBytes = await outDoc.save({ useObjectStreams: true });
    const blob     = new Blob([outBytes], { type: 'application/pdf' });
    const filename = brandedFilename(file.name, '.pdf');
    const saved    = Math.max(0, Math.round((1 - blob.size / file.size) * 100));

    hideProcessing();
    triggerDownload(blob, filename);
    if (window.UsageLimit) window.UsageLimit.record(1);
    showStatus(
      'success',
      saved > 0 ? `Reduced by ${saved}%` : 'Compression complete',
      'Press the button if the download does not start automatically.',
      createStatusUrl(blob),
      filename,
    );
  } catch (err) {
    hideProcessing();
    const msg = (err && err.message && err.message.length < 200)
      ? err.message : 'Please try again with a different file.';
    showStatus('error', 'Deep compression failed', msg);
  } finally {
    if (processBtn) processBtn.disabled = false;
  }
}

function showStatus(type, title, message, downloadUrl, filename) {
  const area = document.getElementById('result-area');
  if (!area) return;
  const icons = { loading: `<div class="spinner"></div>`, success: `<i data-lucide="check-circle-2"></i>`, error: `<i data-lucide="alert-circle"></i>` };
  const classes = { loading: 'status-loading', success: 'status-success', error: 'status-error' };
  // The download CTA is wrapped in .dl-pulse so the button visibly *swells*
  // once the file is ready, drawing the eye. On click we fire a heavy,
  // persistent particle burst + stop the pulse (see attachDownloadBurst).
  const downloadBtn = (downloadUrl && filename)
    ? `<div class="download-btn-wrap">
         <span class="dl-pulse">
           <a href="${downloadUrl}" download="${filename}"
              class="btn btn-primary dl-burst-trigger">
             <i data-lucide="download"></i> Download File
           </a>
         </span>
       </div>`
    : '';
  area.innerHTML = `
    <div class="status-card ${classes[type]}">
      ${icons[type]}
      <div>
        <div class="status-card-title">${title}</div>
        <div class="status-card-msg">${message}</div>
        ${downloadBtn}
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
  attachDownloadBurst(area);

  // 3-step flow: success results live on the dedicated /download page so the
  // user sees a clear "your file is ready" page with a fallback download
  // button. Errors stay inline on the preview step. Skip if we're already
  // on the download step (re-rendering existing result html).
  if (type === 'success' && Flow.step !== 'download') {
    Flow.commitResult();
  }
}

// ── DOWNLOAD BURST ─────────────────────────────────────────────────────────
// Wires the visual "explosion" of particles around the Download Again button
// the first time the user clicks it. Idempotent — safe to call repeatedly.
function attachDownloadBurst(scope) {
  const root = scope || document;
  root.querySelectorAll('.dl-burst-trigger:not([data-burst-bound])').forEach((btn) => {
    btn.dataset.burstBound = '1';
    btn.addEventListener('click', (e) => {
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      explodeAt(cx, cy);
      const wrap = btn.closest('.dl-pulse');
      if (wrap) wrap.classList.add('dl-fired');
      // Don't preventDefault — the actual download must still fire.
    });
  });
}

// Fires a heavy burst of coloured particles across the viewport from (x, y).
// Particles are PERSISTENT — they remain on screen until clearAllBursts() is
// called (on Clear / new upload / page refresh).
function explodeAt(x, y) {
  const N = 90;
  const colors = ['#E5322E', '#ff6a5b', '#ffb84a', '#10b981', '#3b82f6',
                  '#a855f7', '#f59e0b', '#06b6d4', '#ec4899', '#22c55e'];
  const host = document.createElement('div');
  host.className = 'burst-host burst-persist';
  host.style.left = x + 'px';
  host.style.top  = y + 'px';
  document.body.appendChild(host);

  // Maximum reach: a generous fraction of the smaller viewport dimension so
  // the burst really feels like it covers the container.
  const reach = Math.max(window.innerWidth, window.innerHeight) * 0.6;

  for (let i = 0; i < N; i++) {
    const p = document.createElement('span');
    p.className = 'burst-particle';
    const angle    = (Math.PI * 2 * i) / N + Math.random() * 0.5;
    const distance = 120 + Math.random() * reach;
    const size     = 8 + Math.random() * 14;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance + 80; // slight downward gravity
    const dur = 900 + Math.random() * 600;
    const rot = (Math.random() * 720 - 360).toFixed(0);
    const shape = Math.random() < 0.35 ? '4px' : '50%'; // mix of squares/dots
    p.style.width  = size + 'px';
    p.style.height = size + 'px';
    p.style.borderRadius = shape;
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.setProperty('--dx', dx + 'px');
    p.style.setProperty('--dy', dy + 'px');
    p.style.setProperty('--dur', dur + 'ms');
    p.style.setProperty('--rot', rot + 'deg');
    host.appendChild(p);
  }
  // NOTE: no setTimeout removal — host persists until cleared.
}

// Removes any persistent burst hosts from the DOM. Called on Clear All / on
// removing the last file / on starting a new upload.
function clearAllBursts() {
  document.querySelectorAll('.burst-host.burst-persist').forEach((el) => el.remove());
}

// Expose globally so queue-client.js (or any future caller) can re-trigger
// after dynamically appending its own download CTA.
window.attachDownloadBurst = attachDownloadBurst;
window.explodeAt = explodeAt;
window.clearAllBursts = clearAllBursts;

function showTextResult(text, label = 'Result') {
  const area = document.getElementById('result-area');
  if (!area) return;
  area.innerHTML = `
    <div class="text-result-card">
      <div class="text-result-header">
        <span class="text-result-label"><i data-lucide="file-text"></i> ${label}</span>
        <button class="btn btn-outline btn-sm" onclick="copyTextResult(this)"><i data-lucide="copy"></i> Copy</button>
      </div>
      <textarea class="text-result-area" readonly>${escapeHtml(text)}</textarea>
    </div>`;
  if (window.lucide) lucide.createIcons();
  if (Flow.step !== 'download') Flow.commitResult();
}

function showReport(report) {
  const area = document.getElementById('result-area');
  if (!area) return;
  const rows = Object.entries(report).map(([k, v]) => `
    <div class="report-row">
      <span class="report-key">${k}</span>
      <span class="report-val">${v}</span>
    </div>`).join('');
  area.innerHTML = `
    <div class="text-result-card">
      <div class="text-result-header">
        <span class="text-result-label"><i data-lucide="bar-chart-2"></i> Comparison Report</span>
      </div>
      <div class="report-table">${rows}</div>
    </div>`;
  if (window.lucide) lucide.createIcons();
  if (Flow.step !== 'download') Flow.commitResult();
}

function copyTextResult(btn) {
  const ta = btn.closest('.text-result-card')?.querySelector('textarea');
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    btn.innerHTML = '<i data-lucide="check"></i> Copied!';
    if (window.lucide) lucide.createIcons();
    setTimeout(() => { btn.innerHTML = '<i data-lucide="copy"></i> Copy'; if (window.lucide) lucide.createIcons(); }, 2000);
  });
}

function showComingSoon(toolName) {
  const modal = document.getElementById('coming-soon-modal');
  const label = document.getElementById('modal-tool-name');
  if (!modal) return;
  if (label) label.textContent = toolName || 'This feature';
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderSeoContent(tool) {
  const catDesc = {
    'Organize PDFs':       'organize, rearrange, and manage PDF documents',
    'Compress & Optimize': 'compress and reduce PDF file size without losing quality',
    'Convert From PDF':    'convert PDF files to other popular formats',
    'Convert To PDF':      'convert documents and images into PDF format',
    'Edit & Annotate':     'edit, annotate, and modify your PDF files',
    'Security':            'protect and secure your PDF documents',
    'Advanced Tools':      'perform advanced AI-powered PDF operations',
    'Image Tools':         'edit, transform, and enhance images',
  };
  const kw = catDesc[tool.category] || 'work with PDF and document files';
  const isImage = tool.group === 'image';
  const fileType = isImage ? 'image' : 'PDF';

  // Per-tool deep content (benefits / use cases / FAQ) generated from
  // scripts/blog-data.js. Optional — only renders when present.
  // tool.id is the internal id (e.g. 'merge'); the content map is keyed by
  // URL slug (e.g. 'merge-pdf') — TOOL_ID_TO_BLOG_SLUG bridges them.
  const slug = TOOL_ID_TO_BLOG_SLUG[tool.id] || tool.id;
  const extra = (window.TOOL_CONTENT && window.TOOL_CONTENT[slug]) || null;

  const benefitsBlock = extra ? `
      <h3>Benefits of ${escapeHtml(tool.name)}</h3>
      <ul class="seo-benefits">
        ${extra.benefits.map(b => `<li><strong>${escapeHtml(b.title)}.</strong> ${b.body}</li>`).join('\n        ')}
      </ul>` : '';

  const useCasesBlock = extra ? `
      <h3>Common use cases</h3>
      <ul class="seo-usecases">
        ${extra.useCases.map(uc => `<li><strong>${escapeHtml(uc.audience)}:</strong> ${uc.body}</li>`).join('\n        ')}
      </ul>` : '';

  return `
    <div class="seo-content">
      <h2>${tool.name} Online — Free, Fast &amp; Secure</h2>
      <p><strong>ILovePDF's ${tool.name}</strong> lets you ${tool.description.charAt(0).toLowerCase() + tool.description.slice(1)} — entirely for free, instantly. No software to download, no account to create, no hidden fees.</p>
      <p>Drag and drop your ${fileType} onto the upload area or click to browse. Files up to 100&nbsp;MB are supported. Once processing is complete, the file is deleted from our servers automatically — usually within seconds.</p>
      <h3>How ${tool.name} works</h3>
      <ol class="seo-steps">
        <li><strong>Upload your file</strong> — drag &amp; drop or click the upload area.</li>
        <li><strong>Preview &amp; configure</strong> — review your file and adjust any options.</li>
        <li><strong>Process</strong> — click the Process button and wait a few seconds.</li>
        <li><strong>Download</strong> — your file is ready instantly. We delete it shortly after.</li>
      </ol>
      ${benefitsBlock}
      ${useCasesBlock}
      <h3>Why choose ILovePDF?</h3>
      <ul class="seo-why">
        <li><strong>Fast.</strong> Most files are processed in seconds.</li>
        <li><strong>Free.</strong> No watermark, no daily cap, no signup needed for files under 100&nbsp;MB.</li>
        <li><strong>Secure.</strong> HTTPS uploads and automatic deletion within 10 minutes.</li>
        <li><strong>Complete.</strong> ${TOOLS.length} tools to ${kw} — all in one place.</li>
      </ul>
    </div>
    ${extra && extra.faq && extra.faq.length ? renderToolFaq(tool, extra.faq) : ''}`;
}

function renderToolFaq(tool, faq) {
  const items = faq.map(f => `
      <details class="blog-faq-item">
        <summary>${escapeHtml(f.q)}</summary>
        <div class="blog-faq-answer"><p>${f.a}</p></div>
      </details>`).join('');
  // Inject FAQ JSON-LD too — small SEO boost.
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: String(f.a).replace(/<[^>]+>/g, '') },
    })),
  });
  // Append the schema once per tool render; remove any previous one.
  document.querySelectorAll('script[data-tool-faq-ld]').forEach(s => s.remove());
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.setAttribute('data-tool-faq-ld', '1');
  script.textContent = ld;
  document.head.appendChild(script);
  return `
    <section class="tool-faq" aria-label="Frequently asked questions">
      <h2>Frequently asked questions about ${escapeHtml(tool.name)}</h2>
      <div class="blog-faq-list">${items}</div>
    </section>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── COMPRESS — single-page preview + tier-aware options ───────────────────
// Free users get the strongest compression (~30% reduction, hard-coded).
// Paid / logged-in users get a Low / Medium / High slider that maps to the
// `level` option the backend route already understands.
function isPaidUser() {
  // Logged-in (any auth provider) is treated as "paid" for the compress
  // slider gate. If a real billing tier exists later, swap this for a
  // window.AuthUI.current().plan === 'pro' check.
  try {
    if (window.AuthUI && window.AuthUI.current) return !!window.AuthUI.current();
    if (window.firebase?.auth) return !!window.firebase.auth().currentUser;
  } catch (_) {}
  return false;
}

function renderCompressOptionsHtml() {
  // BUG-2 FIX: slider is now available to all users — no paid gate.
  return `
    <div class="options-section compress-options" data-compress-options="all">
      <div class="options-title"><i data-lucide="sliders-horizontal"></i> Compression Level</div>
      <div class="compress-slider-wrap">
        <input type="range" min="0" max="2" step="1" value="1"
               class="compress-slider" id="opt-level" />
        <div class="compress-slider-labels">
          <span data-lvl="0">Low<br><small>Best quality</small></span>
          <span data-lvl="1" class="active">Medium<br><small>Recommended</small></span>
          <span data-lvl="2">High<br><small>Smallest file</small></span>
        </div>
      </div>
    </div>`;
}

// Wire the slider's active-label tracking once the options HTML is in DOM.
function wireCompressSlider() {
  const slider = document.getElementById('opt-level');
  if (!slider) return;
  const labels = document.querySelectorAll('.compress-slider-labels [data-lvl]');
  function paint() {
    const v = String(slider.value);
    labels.forEach((s) => s.classList.toggle('active', s.dataset.lvl === v));
  }
  slider.addEventListener('input', paint);
  paint();
}

// Render a single-page thumbnail preview for the uploaded compress PDF.
async function renderCompressPreview() {
  const list = document.getElementById('files-list');
  if (!list) return;
  const entry = selectedFiles[0];
  if (!entry) return;

  // Mount/reuse the host element above the plain file row.
  let host = document.getElementById('compress-preview-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'compress-preview-host';
    list.parentNode.insertBefore(host, list);
  }
  host.innerHTML = `
    <div class="compress-preview">
      <div class="po-spinner" style="width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#E5322E;border-radius:50%;animation:spin 1s linear infinite;"></div>
      <div class="compress-preview-meta">Reading <strong>${escapeHtml(entry.file.name)}</strong>…</div>
    </div>`;

  // Wire the slider regardless of preview success.
  wireCompressSlider();

  if (!window.PdfPreview) return;
  let pdfDoc;
  try {
    pdfDoc = await window.PdfPreview.loadDocument(entry.file);
    const canvas = await window.PdfPreview.renderPage(pdfDoc, 1, 280, 0);
    canvas.classList.add('compress-preview-canvas');
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'compress-preview';
    wrap.appendChild(canvas);
    const meta = document.createElement('div');
    meta.className = 'compress-preview-meta';
    meta.innerHTML = `
      <strong>${escapeHtml(entry.file.name)}</strong><br>
      ${formatBytes(entry.file.size)} · ${pdfDoc.pageCount} page${pdfDoc.pageCount === 1 ? '' : 's'} · Showing page 1
    `;
    wrap.appendChild(meta);
    host.appendChild(wrap);
  } catch (err) {
    host.innerHTML = `
      <div class="compress-preview">
        <div class="compress-preview-meta" style="color:#b91c1c">
          Couldn't render a preview. Your file will still be compressed.
        </div>
      </div>`;
  } finally {
    try { pdfDoc && window.PdfPreview.unloadDocument(pdfDoc); } catch (_) {}
  }
}

// Convert the slider value (0/1/2) into the level string the Express
// /api/compress route forwards to the upstream processor.
function readCompressLevel() {
  // BUG-2 FIX: read actual slider value for all users.
  const slider = document.getElementById('opt-level');
  if (!slider) return 'medium';
  const v = parseInt(slider.value, 10);
  if (v === 0) return 'low';
  if (v === 2) return 'high';
  return 'medium';
}

// ── SPA NAVIGATION ─────────────────────────────────────────────────────────
// Exposed so chrome.js (and any future code) can navigate to any tool without
// a full page reload. Only meaningful when the tool.html shell is in the DOM.
window.loadToolPage = function loadToolPage(path) {
  const step = /\/preview\/?$/i.test(path)  ? 'preview'
             : /\/download\/?$/i.test(path) ? 'download'
             : 'upload';

  const rawSlug = path
    .replace(/^\/+/, '')
    .replace(/\/(preview|download)\/?$/i, '')
    .toLowerCase()
    .split('?')[0]
    .split('#')[0];

  if (!rawSlug) { window.location.href = '/'; return; }

  const slugMeta = window.SLUG_MAP && window.SLUG_MAP[rawSlug];
  if (slugMeta && slugMeta.special) {
    window.location.href = slugMeta.special;
    return;
  }

  const toolId = (slugMeta && slugMeta.id) ? slugMeta.id : rawSlug;
  const tool   = (typeof TOOLS !== 'undefined') ? TOOLS.find(t => t.id === toolId) : null;

  if (tool && tool.url && !path.startsWith(tool.url)) {
    window.location.href = tool.url;
    return;
  }

  // Reset in-progress state
  selectedFiles = [];
  if (pageOrganizer) { try { pageOrganizer.destroy(); } catch (_) {} pageOrganizer = null; }
  Flow.result = null;
  Flow.step   = step;

  if (!tool) {
    currentTool = null;
    renderNotFound(toolId, rawSlug);
    try { sessionStorage.removeItem('__tp_redir__'); } catch (_) {}
    return;
  }

  currentTool = tool;
  buildSidebar(currentTool.id);
  setMetaForStep(Flow.step);
  renderStep();
  try { window.scrollTo(0, 0); } catch (_) {}
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};
