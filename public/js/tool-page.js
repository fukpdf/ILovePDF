// ── i18n translation helper ─────────────────────────────────────────────────
// Uses window.t() when available AND resolved; falls back to English string.
// Guards against TWO failure modes that cause corruption:
//   1. Raw key returned when locale missing → `v === key` guard
//   2. _humaniseKey fallback (last dot-segment capitalised, e.g. 'Title', 'Desc',
//      'Upload files') returned when key absent from locale cache → humanised guard.
//      Without this guard the old code accepted 'Title' as a real translation.
function _tp(key, fallback) {
  if (typeof window.t === 'function') {
    var v = window.t(key);
    if (v && v !== key) {
      // Reject _humaniseKey output: last dot-segment, first-char upper, underscores→spaces
      var last = key.split('.').pop();
      var humanised = last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
      if (v !== humanised) return v; // genuine translation
    }
  }
  return fallback; // English fallback (covers cache-empty race condition)
}

let currentTool = null;
let selectedFiles = [];   // array of { file, rotation, id, _thumbUrl? }
let dragSrcIndex = null;
let pageOrganizer = null; // active PageOrganizer controller (single-PDF page-level UI)
// Tracks the currently mounted pro-editor module (BgRemoverPro / EditPdfPro)
// so destroy() is called before mounting a new instance on tool switch.
let _activeMountedModule = null;
// Re-entrancy guard for processFile(): prevents a rapid double-click from
// launching two concurrent processing runs.  Set to true the moment we commit
// to processing; cleared in the try/finally regardless of exit path.
let _processingInFlight = false;

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

    // Phase 3: record this download in the recent-downloads metadata store.
    try {
      if (window.SessionPersist && currentTool) {
        const _dlA = area.querySelector('a[download]');
        if (_dlA) {
          window.SessionPersist.saveDownload({
            slug: Flow.baseSlug(),
            name: _dlA.getAttribute('download') || 'download',
            size: 0,
          });
        }
      }
    } catch (_) {}

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
  // Phase 3: update session resume pointer + snapshot current tool options.
  try {
    if (window.SessionPersist) {
      window.SessionPersist.saveResume(slug, Flow.step);
      const _opts = window.SessionPersist.readDomOptions(currentTool);
      if (Object.keys(_opts).length) window.SessionPersist.saveOptions(slug, _opts);
    }
  } catch (_) {}
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
      // Track via ObjectURLRegistry so it is revoked on memory pressure or pagehide.
      const fresh = window.ObjectURLRegistry
        ? window.ObjectURLRegistry.create(resultBlob, 'hydrated-result')
        : URL.createObjectURL(resultBlob);
      html = ToolState.rewriteBlobHrefs(html, fresh);
      // Schedule revocation after 30 min (ample time for the user to download).
      setTimeout(() => {
        try {
          window.ObjectURLRegistry ? window.ObjectURLRegistry.revoke(fresh) : URL.revokeObjectURL(fresh);
        } catch (_) {}
      }, 30 * 60 * 1000);
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
window.renderStep = renderStep; // exposed for i18n bridge re-render on language switch

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
  hydrateFlowState().finally(() => {
    renderStep();
    // Phase 7G: crash recovery — show banner if an interrupted session exists.
    // Runs after renderStep() so the tool UI is already visible before the banner appears.
    if (window.CrashRecoveryUI && currentTool && Flow.step === 'upload') {
      const toolIdForCrash = currentTool.id;
      const slugForCrash   = Flow.baseSlug();
      window.CrashRecoveryUI.check(toolIdForCrash, slugForCrash, {
        onResume: function (checkpoint) {
          // Re-run hydration with the restored checkpoint data
          hydrateFlowState().then(function (ok) {
            if (ok) renderStep();
          }).catch(function () {});
          if (window.RuntimeTelemetry) {
            try { window.RuntimeTelemetry.record('crash-recovery:tool-resumed', { tool: toolIdForCrash }); } catch (_) {}
          }
        },
        onDiscard: function () {
          // Clear flow state and restart fresh
          Flow.reset();
          if (window.ToolState) {
            try { window.ToolState.clear(slugForCrash); } catch (_) {}
          }
          renderStep();
        },
      }).catch(function () {});
    }
    // Phase 3: offer to resume a recent session on a different tool.
    // Delayed so it appears after the page settles and never blocks rendering.
    setTimeout(function () {
      try {
        if (window.SessionPersist) {
          window.SessionPersist.maybeShowResumeBanner(Flow.baseSlug());
        }
      } catch (_) {}
    }, 1800);
  });
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
          <i data-lucide="arrow-left"></i> ${_tp('tool.all_tools', 'All Tools')}
        </a>
      </div>
      <div class="status-card status-error" style="margin-top:24px">
        <i data-lucide="home"></i>
        <div>
          <div class="status-card-title">${_tp('status.not_found', 'Page not found')}</div>
          <div class="status-card-msg">
            ${_tp('status.taking_back', 'Taking you back to all tools in')}
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
  // Register with TimerRegistry so pagehide clears it even if countdown is mid-run.
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('not-found-countdown', tick);

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
    ? `<span class="tool-status status-live"><span class="status-dot"></span>${_tp('tool.live_ready', 'Live &amp; Ready')}</span>`
    : (!opts.hideStatus && !tool.working
        ? `<span class="tool-status status-soon"><span class="status-dot"></span>${_tp('tool.coming_soon', 'Coming Soon')}</span>`
        : '');
  const heading = opts.heading || tool.name;
  const desc    = opts.desc    || tool.description;
  const icon    = opts.icon    || tool.icon;
  const back    = opts.back    || { href: '/', label: _tp('tool.all_tools', 'All Tools') };
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
    { id: 'upload',   label: _tp('tool.step_upload',   'Upload'),   icon: 'upload' },
    { id: 'preview',  label: _tp('tool.step_preview',  'Preview'),  icon: 'eye' },
    { id: 'download', label: _tp('tool.step_download', 'Download'), icon: 'download' },
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
      <div class="options-title"><i data-lucide="sliders-horizontal"></i> ${_tp('tool.options', 'Options')}</div>
      <div class="options-grid">${fields}</div>
    </div>`;
}

// Reusable: trust strip shown on upload + preview steps so visitors see
// the safety/privacy commitments before they hand over a file. Required
// signals for AdSense reviewers.
function trustStripHtml() {
  return `
    <ul class="trust-strip" aria-label="Why you can trust this tool">
      <li><i data-lucide="shield-check"></i> ${_tp('tool.trust_secure', 'Secure processing')}</li>
      <li><i data-lucide="trash-2"></i> ${_tp('tool.trust_deleted', 'Files deleted after download for your privacy')}</li>
      <li><i data-lucide="cloud-off"></i> ${_tp('tool.trust_no_install', 'No installation required')}</li>
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
      <a href="/blog/${slug}-guide" class="tool-learn-more-cta">
        Read guide <i data-lucide="arrow-right"></i>
      </a>
    </aside>`;
}

function popularToolsHtml(currentToolId) {
  const POPULAR = [
    { slug: 'merge-pdf',    name: 'Merge PDF',     icon: 'layers',       description: 'Combine multiple PDF files into one document.' },
    { slug: 'compress-pdf', name: 'Compress PDF',  icon: 'archive',      description: 'Reduce PDF file size while keeping the document usable.' },
    { slug: 'split-pdf',    name: 'Split PDF',     icon: 'scissors',     description: 'Split a PDF into separate files or selected pages.' },
    { slug: 'pdf-to-word',  name: 'PDF to Word',   icon: 'file-text',    description: 'Convert PDF documents into editable Word files.' },
    { slug: 'pdf-to-jpg',   name: 'PDF to JPG',    icon: 'image',        description: 'Convert PDF pages into JPG images for easy sharing.' },
    { slug: 'word-to-pdf',  name: 'Word to PDF',   icon: 'file-text',    description: 'Turn Word documents into PDF files for sharing and printing.' },
    { slug: 'rotate-pdf',   name: 'Rotate PDF',    icon: 'rotate-cw',    description: 'Rotate PDF pages to the correct orientation.' },
    { slug: 'organize-pdf', name: 'Organize PDF',  icon: 'list-ordered', description: 'Reorder, arrange, and manage PDF pages with ease.' },
  ];
  const list = POPULAR.filter(p => p.slug !== `${currentToolId}-pdf` && p.slug !== currentToolId).slice(0, 6);
  return `
    <section class="popular-tools" aria-label="Popular tools">
      <h2 class="popular-title">Popular tools</h2>
      <div class="popular-grid">
        ${list.map(t => `
          <a class="popular-card" href="/${t.slug}">
            <span class="popular-card-icon"><i data-lucide="${t.icon}"></i></span>
            <span class="popular-card-body">
              <span class="popular-card-name">${t.name}</span>
              <span class="popular-card-description">${t.description}</span>
            </span>
            <span class="popular-card-arrow" aria-hidden="true">→</span>
          </a>`).join('')}
      </div>
    </section>`;
}

// ── SHARED BRANDED UPLOAD — tool-specific content, common visual system ────
function renderBrandedUploadStep(tool, config) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.remove('ew-wide');

  const fileLabel = tool.multipleFiles
    ? _tp('tool.upload_files', config.fileLabel || 'Select files')
    : _tp('tool.upload_file', config.fileLabel || 'Select file');
  const multiAttr = tool.multipleFiles ? 'multiple' : '';

  container.innerHTML = `
    <div class="tool-page ilpdf-branded-upload ${config.pageClass || ''}">
      <section class="ilpdf-branded-upload-hero" aria-labelledby="${config.headingId || 'tool-upload-heading'}">
        <h1 class="ilpdf-branded-title" id="${config.headingId || 'tool-upload-heading'}">${escapeHtml(config.title || tool.name)}</h1>
        <p class="ilpdf-branded-subtitle">${config.subtitle || escapeHtml(tool.description)}</p>

        <div class="ilpdf-branded-upload-zone" id="upload-area" tabindex="0" role="button" aria-label="${escapeHtml(fileLabel)}">
          <input type="file" id="file-input" accept="${tool.acceptedFiles}" ${multiAttr}>

          <div class="ilpdf-branded-action-row">
            <button type="button" class="btn btn-primary ilpdf-branded-select" id="upload-cta-btn">
              <i data-lucide="upload"></i> ${escapeHtml(fileLabel)}
            </button>
            <div class="ilpdf-branded-clouds" aria-hidden="true">
              <span class="ilpdf-branded-cloud"><i data-lucide="hard-drive-upload"></i></span>
              <span class="ilpdf-branded-cloud"><i data-lucide="box"></i></span>
            </div>
          </div>

          <div class="ilpdf-branded-droptext">or drop ${tool.multipleFiles ? 'files' : 'your file'} here</div>

          <div class="ilpdf-branded-benefits" aria-label="${escapeHtml(config.benefitsLabel || 'How this tool works')}">
            ${(config.benefits || []).map(function (b) {
              return `
                <div class="ilpdf-branded-benefit">
                  <div class="ilpdf-branded-sticker ${escapeHtml(b.sticker || '')}" aria-hidden="true">
                    ${b.art || ''}<i data-lucide="${escapeHtml(b.icon || 'check-circle-2')}"></i>
                  </div>
                  <div class="ilpdf-branded-benefit-copy">
                    <strong>${escapeHtml(b.title)}</strong>
                    <span>${escapeHtml(b.text)}</span>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
      </section>

      ${trustStripHtml()}
      ${renderSeoContent(tool)}
      ${learnMoreHtml(tool)}
      ${popularToolsHtml(tool.id)}
    </div>`;

  if (window.lucide) lucide.createIcons();
  setupFileInput();

  const cta = document.getElementById('upload-cta-btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      e.stopPropagation();
      document.getElementById('file-input')?.click();
    });
  }

  wireStepNav();
  try {
    window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'upload' } }));
  } catch (_) {}
}

// ── STEP 1 — UPLOAD ───────────────────────────────────────────────────────

// Minimal hero: tool icon, name (H1), description, ONE big "Upload File"
// primary button. Drag-and-drop is still supported on the same area for
// power users. SEO content stays here on the canonical page.
function renderUploadStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.remove('ew-wide');

  const fileLabel = tool.multipleFiles
    ? _tp('tool.upload_files', 'Select PDF files')
    : _tp('tool.upload_file', 'Select PDF file');
  const multiAttr = tool.multipleFiles ? 'multiple' : '';
  const fileType  = tool.group === 'image' ? 'image' : 'PDF';
  const isRotateTool = tool.id === 'rotate';

  if (tool.id === 'crop') {
    const cropFaq = [
      { q: 'How do I crop a PDF?', a: 'Upload your PDF, adjust the crop area for the page, review the result, and create the cropped PDF.' },
      { q: 'Can I remove PDF margins?', a: 'Yes. Cropping can remove unwanted white space or margins around the page content.' },
      { q: 'Will cropping change the original PDF file?', a: 'No. The uploaded file is used to create a separate processed result; your original file is not edited in place.' },
      { q: 'Can I crop a scanned PDF?', a: 'Yes. Cropping is useful for scanned documents, receipts, forms, screenshots, and other PDFs with extra page margins.' },
    ];

    return `
      <section class="seo-content seo-content--tool seo-content--crop" aria-labelledby="crop-seo-heading">
        <div class="seo-intro">
          <span class="seo-kicker">PDF CROP TOOL</span>
          <h2 id="crop-seo-heading">Crop PDF Online — Free, Fast &amp; Simple</h2>
          <p><strong>Need to remove unwanted PDF margins?</strong> This online PDF crop tool helps you trim page edges and keep the content you actually need.</p>
          <p>Crop scanned documents, forms, receipts, notes, screenshots, and other PDF pages before sharing, printing, or archiving them.</p>
        </div>

        <div class="seo-feature-grid">
          <article class="seo-feature-card seo-sticker-card">
            <span class="seo-feature-icon seo-sticker-icon"><i data-lucide="crop"></i></span>
            <div>
              <h3>Trim unwanted page space</h3>
              <p>Remove extra margins and empty areas around the useful content on your PDF pages.</p>
            </div>
          </article>
          <article class="seo-feature-card seo-sticker-card">
            <span class="seo-feature-icon seo-sticker-icon"><i data-lucide="scan-search"></i></span>
            <div>
              <h3>Review before processing</h3>
              <p>Use the page workflow to check the document before creating the final cropped PDF.</p>
            </div>
          </article>
          <article class="seo-feature-card seo-sticker-card">
            <span class="seo-feature-icon seo-sticker-icon"><i data-lucide="printer"></i></span>
            <div>
              <h3>Prepare cleaner documents</h3>
              <p>Crop pages before printing, presenting, sharing, or storing the finished document.</p>
            </div>
          </article>
        </div>

        <div class="seo-section-block seo-section-with-sticker">
          <div class="seo-section-heading">
            <span class="seo-section-sticker seo-section-sticker-crop" aria-hidden="true"><i data-lucide="crop"></i></span>
            <div>
              <span class="seo-section-kicker">STEP-BY-STEP</span>
              <h3>How to crop a PDF online</h3>
            </div>
          </div>
          <ol class="seo-steps">
            <li><strong>Upload your PDF</strong> — select a PDF file or drag it into the upload area.</li>
            <li><strong>Open the crop controls</strong> — review the page and identify the margins or areas you want to remove.</li>
            <li><strong>Set the crop values</strong> — adjust the page edges according to the content you want to keep.</li>
            <li><strong>Review the result</strong> — check that important text, images, and page content remain inside the crop area.</li>
            <li><strong>Crop PDF</strong> — process the document and download the finished file.</li>
          </ol>
        </div>

        <div class="seo-section-block seo-section-with-sticker">
          <div class="seo-section-heading">
            <span class="seo-section-sticker seo-section-sticker-focus" aria-hidden="true"><i data-lucide="scan-search"></i></span>
            <div>
              <span class="seo-section-kicker">CLEANER PAGES</span>
              <h3>Why crop a PDF?</h3>
            </div>
          </div>
          <ul class="seo-benefits">
            <li><strong>Remove excess margins.</strong> Trim empty space around scanned or photographed pages.</li>
            <li><strong>Focus the document.</strong> Keep attention on the content that matters.</li>
            <li><strong>Improve print layout.</strong> Reduce unnecessary page space before printing.</li>
            <li><strong>Clean up scans.</strong> Remove borders and surrounding areas from scanned paperwork.</li>
          </ul>
        </div>

        <div class="seo-section-block seo-section-with-sticker">
          <div class="seo-section-heading">
            <span class="seo-section-sticker seo-section-sticker-usecase" aria-hidden="true"><i data-lucide="files"></i></span>
            <div>
              <span class="seo-section-kicker">REAL-WORLD USE</span>
              <h3>Common PDF cropping use cases</h3>
            </div>
          </div>
          <div class="seo-usecase-grid">
            <article class="seo-usecase-card">
              <span class="seo-usecase-sticker"><i data-lucide="file-scan"></i></span>
              <strong>Scanned documents</strong>
              <span>Remove scanner borders and excess white space.</span>
            </article>
            <article class="seo-usecase-card">
              <span class="seo-usecase-sticker"><i data-lucide="receipt-text"></i></span>
              <strong>Receipts &amp; invoices</strong>
              <span>Focus pages on the useful transaction details.</span>
            </article>
            <article class="seo-usecase-card">
              <span class="seo-usecase-sticker"><i data-lucide="clipboard-pen-line"></i></span>
              <strong>Forms &amp; applications</strong>
              <span>Trim unnecessary page areas before sharing.</span>
            </article>
            <article class="seo-usecase-card">
              <span class="seo-usecase-sticker"><i data-lucide="book-open"></i></span>
              <strong>Study material</strong>
              <span>Clean up photographed or scanned notes.</span>
            </article>
          </div>
        </div>

        <div class="seo-section-block seo-trust-block seo-section-with-sticker">
          <div class="seo-section-heading">
            <span class="seo-section-sticker seo-section-sticker-trust" aria-hidden="true"><i data-lucide="sparkles"></i></span>
            <div>
              <span class="seo-section-kicker">SIMPLE WORKFLOW</span>
              <h3>Crop PDF pages without unnecessary steps</h3>
            </div>
          </div>
          <p>The workflow is built around a simple task: <strong>upload, adjust, review, and download.</strong> You can prepare a cleaner PDF without installing desktop software.</p>
        </div>
      </section>
      ${renderToolFaq(tool, cropFaq)}
    `;
  }

  // Generic SEO content for the other tools.
  const slug = TOOL_ID_TO_BLOG_SLUG[tool.id] || tool.id;
  const extra = (window.TOOL_CONTENT && window.TOOL_CONTENT[slug]) || null;

  const benefitsBlock = extra ? `
      <h3>Benefits of ${escapeHtml(tool.name)}</h3>
      <ul class="seo-benefits">
        ${extra.benefits.map(b => `<li><strong>${escapeHtml(b.title)}.</strong> ${b.body}</li>`).join('\\n        ')}
      </ul>` : '';

  const useCasesBlock = extra ? `
      <h3>Common use cases</h3>
      <ul class="seo-usecases">
        ${extra.useCases.map(uc => `<li><strong>${escapeHtml(uc.audience)}:</strong> ${uc.body}</li>`).join('\\n        ')}
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
        <li><strong>Secure.</strong> Processing follows the tool's configured processing path; see the site's privacy information for data handling details.</li>
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
  // FAQ content remains visible and useful to visitors. Do not emit FAQPage
  // structured data: Google retired FAQ rich results in May 2026.
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