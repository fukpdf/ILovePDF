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
let _cropUploadRun = 0;

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
  const registryMeta = (window.ToolRegistry && window.ToolRegistry.isReady())
    ? window.ToolRegistry.getBySlug(rawSlug) || window.ToolRegistry.get(rawSlug)
    : null;
  const meta    = window.SLUG_MAP && window.SLUG_MAP[rawSlug];
  const toolId  = registryMeta ? registryMeta.id : ((meta && meta.id) ? meta.id : rawSlug);

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

document.addEventListener('DOMContentLoaded', async () => {
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

  // Phase 4 Unit 2: wait for the authoritative registry before resolving the tool.
  // Legacy TOOLS remains the compatibility/detail source during migration; registry
  // metadata owns identity, slug, routing, execution, and lifecycle policy.
  if (window.ToolRegistryReady) {
    try { await window.ToolRegistryReady; } catch (_) { /* fail open to legacy config */ }
  }

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

  // Unit 5: resolve identity from the authoritative registry after its readiness barrier.
  // TOOLS remains UI/detail compatibility data only.
  const pathSlug = slug.replace(/\/(preview|download)$/i, '');
  const registryTool = (window.ToolRegistry && window.ToolRegistry.isReady())
    ? (window.ToolRegistry.getBySlug(pathSlug) || window.ToolRegistry.get(toolId))
    : null;
  const authoritativeId = registryTool ? registryTool.id : toolId;
  const legacyTool = TOOLS.find(t => t.id === authoritativeId);
  currentTool = (window.ToolRegistry && window.ToolRegistry.isReady())
    ? window.ToolRegistry.mergeLegacy(legacyTool)
    : legacyTool;

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
function standaloneToolHeadingHtml(tool, className = 'tool-header-name', id = '') {
  const cls = className || 'tool-header-name';
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<h1 class="${cls}"${idAttr} data-tool-name-heading="1">
    <span class="tool-name-sticker" aria-hidden="true"><i data-lucide="${tool.icon || 'file-text'}"></i></span>
    <span class="tool-heading-label">${escapeHtml(tool.name)}</span>
  </h1>`;
}

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
          ${heading === tool.name ? standaloneToolHeadingHtml(tool) : `<h1 class="tool-header-name">${heading}</h1>`}
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
  const homepageIcon = (slug, fallback) => {
    try {
      for (const group of (window.TOOL_GROUPS || [])) {
        const match = (group.items || []).find(item => item.slug === slug || item.tid === slug);
        if (match && match.icon) return match.icon;
      }
    } catch (_) {}
    return fallback;
  };
  return `
    <section class="popular-tools${currentToolId === 'crop' ? ' popular-tools--crop' : ''}" aria-label="Popular tools">
      <h2 class="popular-title">Popular tools</h2>
      <div class="popular-grid">
        ${list.map(t => `
          <a class="popular-card" href="/${t.slug}">
            <span class="popular-card-body">
              <span class="popular-card-name"><span class="tool-name-sticker" aria-hidden="true"><i data-lucide="${homepageIcon(t.slug, t.icon)}"></i></span><span class="popular-card-name-label">${t.name}</span></span>
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
  const cloudButtonsHtml = config.cloudButtons
    ? '<div class="ilpdf-branded-clouds" aria-label="Cloud upload options">' +
      '<button type="button" class="ilpdf-branded-cloud ilpdf-cloud-google" id="upload-google-drive" title="Upload from Google Drive" aria-label="Upload from Google Drive"><i data-lucide="hard-drive-upload"></i></button>' +
      '<button type="button" class="ilpdf-branded-cloud ilpdf-cloud-dropbox" id="upload-dropbox" title="Upload from Dropbox" aria-label="Upload from Dropbox"><i data-lucide="box"></i></button>' +
      '</div>'
    : '<div class="ilpdf-branded-clouds" aria-hidden="true"><span class="ilpdf-branded-cloud"><i data-lucide="hard-drive-upload"></i></span><span class="ilpdf-branded-cloud"><i data-lucide="box"></i></span></div>';
  const multiAttr = tool.multipleFiles ? 'multiple' : '';
  container.innerHTML = `
    <div class="tool-page ilpdf-branded-upload ${config.pageClass || ''}">
      <section class="ilpdf-branded-upload-hero" aria-labelledby="${config.headingId || 'tool-upload-heading'}">
        ${(config.title || tool.name) === tool.name ? standaloneToolHeadingHtml(tool, 'ilpdf-branded-title', config.headingId || 'tool-upload-heading') : `<h1 class="ilpdf-branded-title" id="${config.headingId || 'tool-upload-heading'}">${escapeHtml(config.title || tool.name)}</h1>`}
        <p class="ilpdf-branded-subtitle">${config.subtitle || escapeHtml(tool.description)}</p>

        <div class="ilpdf-branded-upload-zone" id="upload-area" tabindex="0" role="button" aria-label="${escapeHtml(fileLabel)}">
          <input type="file" id="file-input" accept="${tool.acceptedFiles}" ${multiAttr}>

          <div class="ilpdf-branded-action-row">
            <button type="button" class="btn btn-primary ilpdf-branded-select" id="upload-cta-btn">
              <i data-lucide="upload"></i> ${escapeHtml(fileLabel)}
            </button>
            ${cloudButtonsHtml}
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

  if (config.cloudButtons) {
    const googleBtn = document.getElementById('upload-google-drive');
    const dropboxBtn = document.getElementById('upload-dropbox');
    if (googleBtn) googleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.CloudUpload && typeof window.CloudUpload.open === 'function') {
        window.CloudUpload.open('google-drive', document.getElementById('file-input'));
      } else {
        document.getElementById('file-input')?.click();
      }
    });
    if (dropboxBtn) dropboxBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.CloudUpload && typeof window.CloudUpload.open === 'function') {
        window.CloudUpload.open('dropbox', document.getElementById('file-input'));
      } else {
        document.getElementById('file-input')?.click();
      }
    });
  }

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
function getBrandedUploadConfig(tool) {
  const isImage = tool.group === 'image';
  const fileType = isImage ? 'image' : 'PDF';
  const noun = tool.multipleFiles ? `${fileType} files` : fileType;
  const operation = tool.name.replace(/\s+/g, ' ').trim();
  return {
    pageClass: 'ilpdf-branded-tool-upload',
    headingId: `${tool.id}-upload-heading`,
    title: tool.name,
    subtitle: tool.description,
    fileLabel: `Select ${noun}`,
    cloudButtons: false,
    benefitsLabel: `How ${operation} works`,
    benefits: [
      { sticker: 'ilpdf-branded-sticker-upload', icon: 'upload-cloud', title: `Upload your ${fileType}`, text: tool.multipleFiles ? `Choose your ${fileType.toLowerCase()} files or drag them into the upload area.` : `Choose a ${fileType.toLowerCase()} file or drag it into the upload area.` },
      { sticker: 'ilpdf-branded-sticker-crop', icon: tool.icon || 'settings-2', title: `Use ${operation}`, text: `Review the preview and use the available ${operation.toLowerCase()} controls before processing.` },
      { sticker: 'ilpdf-branded-sticker-download', icon: 'download', title: 'Download your result', text: 'Review the finished file, then download it or start another task.' }
    ]
  };
}

function renderUploadStep(tool) {
  // Shared upload experience for all standard tools. Tool-specific processing,
  // editors, previews, options, SEO content, and result handling stay intact.
  return renderBrandedUploadStep(tool, getBrandedUploadConfig(tool));
}
// ── STEP 2b — PRO MAX EDITOR STEP ─────────────────────────────────────────
// Mounts a full interactive editor (BgRemoverPro / EditPdfPro) in place of
// the standard preview+process flow. The editor's callback fires
// showStatus('success', …) which commits the Flow and navigates to download.
function renderProPreviewStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.add('ew-wide');

  const isBgRemover = tool.id === 'background-remover';

  container.innerHTML = `
    <div class="tool-page tool-page--pro" style="padding-bottom:0">
      ${toolHeaderBlock(tool, {
        heading:    isBgRemover ? tool.name : tool.name + ' — PRO Editor',
        desc:       isBgRemover
                      ? 'Automatic AI removal \xb7 100% local \xb7 Free'
                      : 'Edit your file in the interactive editor below, then click Download when done.',
        icon:       tool.icon || 'edit-3',
        hideStatus: true,
        back: { href: '#step:upload', label: _tp('tool.back_to_upload', 'Back to upload') },
      })}
      ${stepIndicatorHtml('preview')}
      <div id="pro-editor-mount" style="margin-top:12px;flex:1;${isBgRemover ? '' : 'min-height:520px;'}"></div>
      <div id="result-area" style="margin-top:12px;padding:0 24px;"></div>
    </div>`;

  if (window.lucide) lucide.createIcons();
  wireStepNav();

  const mount = document.getElementById('pro-editor-mount');
  const file  = selectedFiles[0] && selectedFiles[0].file;
  if (!file || !mount) { Flow.navTo('upload'); return; }

  // onResult: used by EditPdfPro — shows the Download button for manual save.
  function onResult(blob, filename, mime) {
    if (!blob || blob.size < 10) {
      showStatus('error', _tp('status.export_failed', 'Export failed'), _tp('status.export_empty', 'The output appears empty. Please try again.'));
      return;
    }
    // Route through ObjectURLRegistry so memory-pressure and pagehide both revoke.
    const reg = window.ObjectURLRegistry;
    const url  = reg ? reg.create(blob, 'pro-editor-result') : URL.createObjectURL(blob);
    setTimeout(() => {
      try { reg ? reg.revoke(url) : URL.revokeObjectURL(url); } catch (_) {}
    }, 60 * 60 * 1000);
    showStatus(
      'success',
      _tp('status.file_ready', 'Your file is ready'),
      _tp('status.click_download', 'Click the Download button below to save your file.'),
      url,
      filename
    );
  }

  // commitResult: used by BgRemoverPro — user already downloaded via the
  // in-editor button, so we just show the success card and commit the flow.
  function commitResult(blob, filename, mime) {
    if (!blob || blob.size < 10) {
      showStatus('error', _tp('status.export_failed', 'Export failed'), _tp('status.export_empty', 'The output appears empty. Please try again.'));
      return;
    }
    const reg = window.ObjectURLRegistry;
    const url  = reg ? reg.create(blob, 'bg-remover-result') : URL.createObjectURL(blob);
    setTimeout(() => {
      try { reg ? reg.revoke(url) : URL.revokeObjectURL(url); } catch (_) {}
    }, 60 * 60 * 1000);
    showStatus(
      'success',
      'Background removed!',
      filename + ' has been saved. Use the button below if the download didn\'t complete.',
      url,
      filename
    );
    // showStatus auto-calls Flow.commitResult() for type === 'success'
  }

  // Destroy any previously mounted pro-editor before mounting a new one.
  // Prevents window keydown handlers and document slider listeners from stacking.
  if (_activeMountedModule) {
    try { _activeMountedModule.destroy(); } catch (_) {}
    _activeMountedModule = null;
  }
  if (isBgRemover && window.BgRemoverPro) {
    _activeMountedModule = window.BgRemoverPro;
    window.BgRemoverPro.mount(file, mount, commitResult);
  } else if (tool.id === 'edit' && window.EditPdfPro) {
    _activeMountedModule = window.EditPdfPro;
    window.EditPdfPro.mount(file, mount, onResult);
  }
}

// ── ROTATE PDF — iLovePDF-style full-screen preview ───────────────────────
function renderRotatePreviewStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.add('ew-wide');

  const fileName = selectedFiles.length === 1
    ? selectedFiles[0].file.name
    : 'PDF';

  container.innerHTML = `
    <div class="tool-page ilpdf-rotate-page ilpdf-rotate-preview">
      <div class="ilpdf-rotate-editor">
        <header class="ilpdf-rotate-editor-top">
          <div class="ilpdf-rotate-file">
            <button type="button" class="ilpdf-rotate-back" data-go-step="upload" aria-label="Back to upload">
              <i data-lucide="arrow-left"></i>
            </button>
            <div class="ilpdf-rotate-file-icon"><i data-lucide="file-text"></i></div>
            <div class="ilpdf-rotate-file-copy">
              <strong>${escapeHtml(fileName)}</strong>
              <span>Rotate PDF</span>
            </div>
          </div>
          <button type="button" class="ilpdf-rotate-reset" id="rotate-reset-all">
            <i data-lucide="rotate-ccw"></i> Reset all
          </button>
        </header>

        <div class="ilpdf-rotate-editor-body">
          <main class="ilpdf-rotate-pages" aria-label="PDF page previews">
            <div class="ilpdf-rotate-pages-head">
              <span>PDF preview</span>
              <span class="ilpdf-rotate-page-note">Rotate pages before processing</span>
            </div>
            <div id="page-organizer" class="page-organizer ilpdf-rotate-organizer"></div>
            <div id="files-list" style="display:none" aria-hidden="true"></div>
          </main>

          <aside class="ilpdf-rotate-controls" aria-label="Rotate PDF controls">
            <div class="ilpdf-rotate-control-block">
              <div class="ilpdf-rotate-control-title">Select files to rotate:</div>
              <div class="ilpdf-rotate-segment" role="radiogroup" aria-label="Select files to rotate">
                <button type="button" class="is-active" data-rotate-orientation="all" aria-pressed="true">All</button>
                <button type="button" data-rotate-orientation="portrait" aria-pressed="false">Portrait</button>
                <button type="button" data-rotate-orientation="landscape" aria-pressed="false">Landscape</button>
              </div>
            </div>

            <div class="ilpdf-rotate-control-block">
              <div class="ilpdf-rotate-control-title">Rotation</div>
              <div class="ilpdf-rotate-direction">
                <button type="button" class="ilpdf-rotate-direction-btn" data-rotate-direction="right">
                  <i data-lucide="rotate-cw"></i>
                  <span>Right</span>
                </button>
                <button type="button" class="ilpdf-rotate-direction-btn" data-rotate-direction="left">
                  <i data-lucide="rotate-ccw"></i>
                  <span>Left</span>
                </button>
              </div>
            </div>

            <div class="ilpdf-rotate-controls-spacer"></div>

            <button type="button" class="btn btn-primary ilpdf-rotate-process" id="process-btn" onclick="processFile()">
              <i data-lucide="rotate-cw"></i> Rotate PDF
            </button>

            <!-- Keep the existing processFile() contract intact. These values
                 remain neutral because PageOrganizer has already applied the
                 visual rotation state that will be exported. -->
            <select id="opt-degrees" hidden aria-hidden="true">
              <option value="0" selected>0</option>
              <option value="90">90</option>
              <option value="180">180</option>
              <option value="270">270</option>
            </select>
            <input id="opt-pages" type="hidden" value="all">

            <div class="ilpdf-rotate-control-foot">
              <i data-lucide="shield-check"></i>
              <span>Your PDF is processed with the existing Rotate PDF engine.</span>
            </div>
          </aside>
        </div>
      </div>
    </div>`;

  if (window.lucide) lucide.createIcons();

  // Bind the CTA directly as well as retaining the existing processFile()
  // entry point. This avoids relying on inline-handler scope in deployments
  // that load tool-page.js differently.
  const rotateProcessBtn = document.getElementById('process-btn');
  if (rotateProcessBtn) {
    rotateProcessBtn.addEventListener('click', function (event) {
      event.preventDefault();
      if (typeof window.processFile === 'function') {
        window.processFile();
      } else if (typeof processFile === 'function') {
        processFile();
      }
    });
  }

  wireStepNav();

  // Mount the existing page renderer/editor. Its getEditedPdf() remains the
  // single source of truth for the output PDF.
  maybeOpenPageOrganizer();

  const readyWaitStart = Date.now();
  function getOrganizer() {
    if (pageOrganizer) return pageOrganizer;
    if (Date.now() - readyWaitStart > 12000) return null;
    setTimeout(getOrganizer, 50);
    return null;
  }

  function withOrganizer(fn) {
    if (pageOrganizer) {
      fn(pageOrganizer);
      return;
    }
    const timer = setInterval(function () {
      if (pageOrganizer) {
        clearInterval(timer);
        fn(pageOrganizer);
      } else if (Date.now() - readyWaitStart > 12000) {
        clearInterval(timer);
      }
    }, 50);
  }

  document.querySelectorAll('[data-rotate-orientation]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-rotate-orientation]').forEach(function (b) {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  });

  document.querySelectorAll('[data-rotate-direction]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const direction = btn.getAttribute('data-rotate-direction');
      const active = document.querySelector('[data-rotate-orientation].is-active');
      const orientation = active ? active.getAttribute('data-rotate-orientation') : 'all';
      const delta = direction === 'left' ? 270 : 90;

      withOrganizer(function (organizer) {
        if (typeof organizer.applyRotationByOrientation === 'function') {
          Promise.resolve(organizer.applyRotationByOrientation(delta, orientation));
        } else if (orientation === 'all' && typeof organizer.applyRotationAll === 'function') {
          organizer.applyRotationAll(delta);
        }
      });
    });
  });

  const resetBtn = document.getElementById('rotate-reset-all');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      const reset = document.querySelector('#page-organizer [data-act="reset"]');
      if (reset) reset.click();
    });
  }

  // Do not let the old generic rotate dropdown apply a second rotation.
  const legacyDegrees = document.getElementById('opt-degrees');
  if (legacyDegrees) legacyDegrees.value = '0';

  try { window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'preview' } })); } catch (_) {}
}

// ── STEP 2 — PREVIEW + PROCESS ────────────────────────────────────────────
// Shows the selected file(s), the tool's options, and a single Process CTA.
// Reuses every existing helper (renderFileList, maybeOpenPageOrganizer,
// processFile) — only the surrounding chrome changes.
function renderPreviewStep(tool) {
  if (tool) {
    renderToolPreviewPreparation(tool);
    return;
  }
  renderStandardPreviewStep(tool);
}

function renderToolPreviewPreparation(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.add('ew-wide');
  const isImage = tool.group === 'image';
  container.innerHTML = `
    <div class="tool-page ew-preview-page crop-preview-prep-page">
      ${toolHeaderBlock(tool, {
        heading: `Preparing — ${tool.name}`,
        desc: `Preparing your ${isImage ? 'image' : 'file'} for the ${tool.name} preview.`,
        icon: tool.icon || (isImage ? 'image' : 'file-text'),
        hideStatus: true,
        back: { href: '#step:upload', label: _tp('tool.back_to_upload', 'Back to upload') },
      })}
      ${stepIndicatorHtml('preview')}
      ${cropUploadJourneyHtml(tool)}
    </div>`;
  const journey = document.getElementById('crop-upload-journey');
  if (journey) journey.hidden = false;
  if (window.lucide) lucide.createIcons();
  const runId = ++_cropUploadRun;
  const startedAt = Date.now();
  runToolPreviewPreparation(tool, runId, startedAt, 2200);
}

async function runToolPreviewPreparation(tool, runId, startedAt, minimumMs) {
  const journey = document.getElementById('crop-upload-journey');
  if (!journey) return;
  const file = selectedFiles[0] && selectedFiles[0].file;
  if (!file) { renderStandardPreviewStep(tool); return; }

  const engineWarm = (window.BrowserTools && typeof window.BrowserTools.prewarm === 'function')
    ? window.BrowserTools.prewarm(tool.id)
    : Promise.resolve({ warmed: false });
  const previewWarm = (window.PdfPreview && typeof window.PdfPreview.loadPdfJs === 'function' && tool.group !== 'image')
    ? window.PdfPreview.loadPdfJs()
    : Promise.resolve();
  const isImage = tool.group === 'image';
  const stages = [
    { at: 0, stage: 'read', title: 'Reading your ' + (isImage ? 'image' : 'file'), detail: 'Checking the selected file before the preview opens.' },
    { at: 28, stage: 'engine', title: 'Preparing ' + tool.name, detail: 'Getting the ' + tool.name + ' workspace ready.' },
    { at: 58, stage: 'preview', title: 'Preparing preview', detail: 'Getting the preview renderer ready.' },
    { at: 86, stage: 'preview', title: 'Finishing preview setup', detail: 'Almost ready — preparing your workspace.' }
  ];
  const updateVisual = value => {
    if (runId !== _cropUploadRun) return;
    let current = stages[0];
    stages.forEach(item => { if (value >= item.at) current = item; });
    cropJourneySetStage(current.stage, current.title, current.detail, value, true);
  };
  updateVisual(0);
  const start = performance.now();
  await new Promise(resolve => {
    const tick = now => {
      if (runId !== _cropUploadRun) return resolve();
      const elapsed = now - start;
      updateVisual(Math.min(92, (elapsed / minimumMs) * 92));
      if (elapsed < minimumMs) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  if (runId !== _cropUploadRun) return;
  await Promise.all([engineWarm, previewWarm]);
  const remaining = Math.max(0, minimumMs - (Date.now() - startedAt));
  if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
  if (runId !== _cropUploadRun) return;
  cropJourneySetStage('ready', tool.name + ' is ready', 'Opening your preview workspace.', 100, true);
  await new Promise(resolve => setTimeout(resolve, 220));
  if (runId !== _cropUploadRun) return;
  renderStandardPreviewStep(tool);
}
function renderStandardPreviewStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.add('ew-wide');

  if ((tool.id === 'background-remover' && window.BgRemoverPro) ||
      (tool.id === 'edit' && window.EditPdfPro)) {
    renderProPreviewStep(tool);
    return;
  }

  if (tool.id === 'rotate') {
    renderRotatePreviewStep(tool);
    return;
  }

  const optionsHtml = buildOptionsHtml(tool);

  const _ctxFile = selectedFiles.length === 1
    ? selectedFiles[0].file.name
    : `${selectedFiles.length} files selected`;

  container.innerHTML = `
    <div class="tool-page ew-preview-page">
      ${toolHeaderBlock(tool, {
        heading: `Preview & Process — ${tool.name}`,
        desc: `Review your ${tool.multipleFiles ? 'files' : 'file'} below, then click Process.`,
        icon: 'eye',
        hideStatus: true,
        back: { href: '#step:upload', label: _tp('tool.back_to_upload', 'Back to upload') },
      })}
      ${stepIndicatorHtml('preview')}

      <div class="ew-context-banner">
        <div class="ew-context-icon"><i data-lucide="${tool.icon || 'file'}"></i></div>
        <span class="ew-context-label">${tool.name}</span>
        <span class="ew-context-file">— ${_ctxFile}</span>
        <span class="ew-context-chip">Preview Ready</span>
      </div>

      <div class="ew-preview-workspace">
        <div class="ew-preview-main">
          <div id="live-preview-host"></div>
          <section class="preview-step upload-section ew-file-section" aria-label="Selected files">
            <span class="upload-label">
              <i data-lucide="file" style="display:inline-block;width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i>
              Selected ${tool.multipleFiles ? 'files' : 'file'}
            </span>
            <div class="upload-files-list" id="files-list"></div>
          </section>
        </div>

        <aside class="ew-preview-aside">
          ${optionsHtml}
          <div class="ew-process-panel">
            <button type="button" class="btn btn-primary btn-lg" id="process-btn" onclick="processFile()">
              <i data-lucide="zap"></i> Process ${tool.multipleFiles ? 'Files' : 'File'}
            </button>
            <button type="button" class="btn btn-outline" id="clear-btn" data-go-step="upload">
              <i data-lucide="x"></i> Clear &amp; restart
            </button>
          </div>
          ${trustStripHtml()}
        </aside>
      </div>

      <div id="result-area"></div>
    </div>`;

  if (window.lucide) lucide.createIcons();
  renderFileList();
  maybeOpenPageOrganizer();
  wireStepNav();
  try { window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'preview' } })); } catch (_) {}

  try {
    if (window.SessionPersist && tool) {
      const _savedOpts = window.SessionPersist.loadOptions(Flow.baseSlug());
      if (_savedOpts) window.SessionPersist.applyDomOptions(tool, _savedOpts);
    }
  } catch (_) {}

  if (window.LivePreview && window.LivePreview.supported(tool.id) && selectedFiles.length) {
    const lpHost = document.getElementById('live-preview-host');
    if (lpHost) {
      window.LivePreview.mount(tool.id, selectedFiles.map(function (w) { return w.file; }), lpHost)
        .catch(function () {});
    }
  }
}

// ── STEP 3 — DOWNLOAD ─────────────────────────────────────────────────────
// Re-renders the captured success markup (status card + Download button) on
// a dedicated page. The user clicks Download to save — no auto-download.
function renderDownloadStep(tool) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  const slug = Flow.baseSlug();

  if (tool.id === 'rotate') {
    container.classList.remove('ew-wide');
    container.innerHTML = `
      <div class="tool-page ilpdf-rotate-page ilpdf-download-page">
        <div class="ilpdf-rotate-download">
          <div class="ilpdf-download-card">
            <div class="ilpdf-download-icon"><i data-lucide="check"></i></div>
            ${standaloneToolHeadingHtml(tool, "ilpdf-download-title")}
            <p>Your rotated PDF is ready.</p>
            <div id="result-area" class="download-result">${Flow.result ? Flow.result.html : ''}</div>
            <div class="ilpdf-download-actions">
              <button type="button" class="btn btn-primary ilpdf-download-main" id="rotate-download-btn">
                <i data-lucide="download"></i> Download PDF
              </button>
              <a href="/${slug}" class="ilpdf-download-secondary" data-go-step="upload">
                Rotate another PDF
              </a>
            </div>
          </div>
        </div>
      </div>`;
    if (window.lucide) lucide.createIcons();

    const area = document.getElementById('result-area');
    if (area) {
      area.querySelectorAll('[data-burst-bound]').forEach(el => el.removeAttribute('data-burst-bound'));
      if (typeof attachDownloadBurst === 'function') attachDownloadBurst(area);
    }
    const rotateDownloadBtn = document.getElementById('rotate-download-btn');
    if (rotateDownloadBtn) {
      rotateDownloadBtn.addEventListener('click', function () {
        const realDownload = document.querySelector('#result-area a[download]');
        if (realDownload) {
          realDownload.click();
        } else {
          const fallback = document.querySelector('#result-area a[href^="blob:"]');
          if (fallback) fallback.click();
        }
      });
    }
    wireStepNav();
    try { window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'download' } })); } catch (_) {}
    return;
  }

  container.classList.remove('ew-wide');
  container.innerHTML = `
    <div class="tool-page">
      ${toolHeaderBlock(tool, {
        heading: _tp('status.file_ready', 'Your file is ready'),
        desc: `Files are deleted automatically — download below or try another tool.`,
        icon: 'check-circle-2',
        hideStatus: true,
        back: { href: '/', label: _tp('tool.all_tools', 'All Tools') },
      })}
      ${stepIndicatorHtml('download')}

      <section class="download-step" aria-label="Download your result">
        <div id="result-area" class="download-result">${Flow.result ? Flow.result.html : ''}</div>

        <div class="download-actions">
          <a href="/${slug}" class="btn btn-outline" data-go-step="upload">
            <i data-lucide="rotate-ccw"></i> Process another PDF
          </a>
          <a href="/" class="btn btn-outline">
            <i data-lucide="grid-3x3"></i> Try another tool
          </a>
          <a href="/blog" class="btn btn-outline">
            <i data-lucide="book-open"></i> Read guides
          </a>
        </div>

        <div class="related-tools-section" id="related-tools-area" style="display:none">
          <div class="related-tools-title">Try these next</div>
          <div class="related-tools-grid" id="related-tools-grid"></div>
        </div>

        <div class="ad-wrap ad-wrap--tight" role="complementary" aria-label="Advertisement">
          <div class="ad-slot ad-slot--download"
               id="ad-download-banner"
               data-ad-slot="download-banner"
               data-ad-ezoic="104"
               data-ad-pending="1"
               aria-hidden="true"></div>
        </div>
      </section>
    </div>`;

  if (window.lucide) lucide.createIcons();
  const area = document.getElementById('result-area');
  if (area) {
    area.querySelectorAll('[data-burst-bound]').forEach(el => el.removeAttribute('data-burst-bound'));
    if (typeof attachDownloadBurst === 'function') attachDownloadBurst(area);
  }
  wireStepNav();
  try { window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'download' } })); } catch (_) {}

  setTimeout(function () {
    try {
      const relGrid = document.getElementById('related-tools-grid');
      const relArea = document.getElementById('related-tools-area');
      if (!relGrid || !relArea || !window.TOOL_GROUPS) return;
      const toolId = tool && (tool.id || tool.tid);
      const relHtml = _buildRelatedToolsHtml(toolId, 4);
      if (!relHtml) return;
      relGrid.innerHTML = relHtml;
      relArea.style.display = '';
      if (window.lucide) window.lucide.createIcons({ nodes: [relGrid] });
    } catch (_) {}

    try {
      if (window.AdManager) {
        const slot = document.getElementById('ad-download-banner');
        if (slot) {
          window.AdManager.register('download-banner', slot);
          window.AdManager.activateAll();
        }
      }
    } catch (_) {}
  }, 0);
}

// Phase 4: Build HTML for related tools grid (same category first, then others)
function _buildRelatedToolsHtml(toolId, maxCount) {
  if (!window.TOOL_GROUPS) return '';
  var related = [];
  var currentGroupKey = null;

  (window.TOOL_GROUPS || []).forEach(function (g) {
    (g.items || []).forEach(function (t) {
      if ((t.tid || t.id) === toolId) currentGroupKey = g.key;
    });
  });

  // Same group first
  (window.TOOL_GROUPS || []).forEach(function (g) {
    if (g.key !== currentGroupKey) return;
    (g.items || []).forEach(function (t) {
      if ((t.tid || t.id) === toolId) return;
      if (!t.tid && !t.url) return;
      if (related.length < maxCount) related.push(t);
    });
  });

  // Fill from other groups
  if (related.length < maxCount) {
    (window.TOOL_GROUPS || []).forEach(function (g) {
      if (g.key === currentGroupKey) return;
      (g.items || []).forEach(function (t) {
        if (!t.tid && !t.url) return;
        var alreadyIn = related.some(function (r) { return (r.tid || r.id) === (t.tid || t.id); });
        if (!alreadyIn && related.length < maxCount) related.push(t);
      });
    });
  }

  return related.slice(0, maxCount).map(function (t) {
    var href = t.url || (t.tid ? '/' + t.tid : '/');
    var icon = t.icon || 'file';
    var name = t.name || t.tid || 'Tool';
    return '<a class="related-tool-card" href="' + href + '">' +
      '<span class="rt-icon"><i data-lucide="' + icon + '"></i></span>' +
      '<span>' + name + '</span>' +
    '</a>';
  }).join('');
}

// ── FILE INPUT ─────────────────────────────────────────────────────────────

function setupFileInput() {
  const input = document.getElementById('file-input');
  const area  = document.getElementById('upload-area');
  if (!input || !area) return;
  // Guard: renderUploadStep() is called every time the user presses "Back to
  // Upload", which would stack duplicate listeners on the same elements.
  // dataset.inputBound mirrors the stepBound / touchBound patterns used
  // elsewhere in this file.
  if (area.dataset.inputBound === '1') return;
  area.dataset.inputBound = '1';

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
  // Phase 17 Fix 4: keyboard activation (Enter / Space) for upload area
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
}

function cropUploadJourneyHtml(tool) {
  return `
    <section class="crop-upload-journey" id="crop-upload-journey" aria-label="Preparing tool" hidden>
      <div class="crop-journey-visual" aria-hidden="true">
        <div class="crop-journey-paper">
          <span class="crop-journey-line l1"></span>
          <span class="crop-journey-line l2"></span>
          <span class="crop-journey-line l3"></span>
          <span class="crop-journey-corner c1"></span>
          <span class="crop-journey-corner c2"></span>
          <span class="crop-journey-corner c3"></span>
          <span class="crop-journey-corner c4"></span>
          <span class="crop-journey-scan"></span>
        </div>
        <div class="crop-journey-orbit"><i data-lucide="${tool && tool.icon ? escapeHtml(tool.icon) : 'file-text'}"></i></div>
      </div>
      <div class="crop-journey-copy">
        <div class="crop-journey-kicker">Your tool is getting ready</div>
        <strong id="crop-journey-title">Reading your selected file</strong>
        <span id="crop-journey-detail">Your selected file is prepared for the next step.</span>
      </div>
      <div class="crop-journey-progress-wrap">
        <div class="crop-journey-progress" role="progressbar" aria-label="Preparing selected file" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-describedby="crop-journey-progress-text">
          <span id="crop-journey-progress-fill"></span>
        </div>
        <div class="crop-journey-progress-meta">
          <span id="crop-journey-progress-text">Preparing…</span>
          <strong id="crop-journey-percent">0%</strong>
        </div>
      </div>
      <ol class="crop-journey-stages" aria-label="Tool preparation stages">
        <li data-crop-stage="read" class="is-active"><span><i data-lucide="file-search-2"></i></span><b>Read PDF</b></li>
        <li data-crop-stage="engine"><span><i data-lucide="cpu"></i></span><b>Prepare tool</b></li>
        <li data-crop-stage="preview"><span><i data-lucide="scan-line"></i></span><b>Prepare preview</b></li>
        <li data-crop-stage="ready"><span><i data-lucide="check"></i></span><b>Ready</b></li>
      </ol>
      <div class="crop-journey-status" id="crop-journey-status" role="status" aria-live="polite" aria-atomic="true">Preparing…</div>
    </section>
  `;
}

function cropJourneySetStage(stage, title, detail, percent, determinate) {
  const root = document.getElementById('crop-upload-journey');
  if (!root) return;
  const titleEl = document.getElementById('crop-journey-title');
  const detailEl = document.getElementById('crop-journey-detail');
  const statusEl = document.getElementById('crop-journey-status');
  const fill = document.getElementById('crop-journey-progress-fill');
  const pct = document.getElementById('crop-journey-percent');
  const bar = root.querySelector('.crop-journey-progress');
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (statusEl) statusEl.textContent = title + (detail ? ' — ' + detail : '');
  const order = ['read','engine','preview','ready'];
  const activeIndex = order.indexOf(stage);
  root.querySelectorAll('[data-crop-stage]').forEach(function (el) {
    const idx = order.indexOf(el.dataset.cropStage);
    el.classList.toggle('is-active', idx === activeIndex);
    el.classList.toggle('is-done', idx >= 0 && idx < activeIndex);
  });
  if (determinate && Number.isFinite(percent)) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    if (fill) fill.style.width = value + '%';
    if (pct) pct.textContent = value + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(value));
    root.classList.add('is-determinate');
  } else {
    if (fill) fill.style.width = '38%';
    if (pct) pct.textContent = 'Working…';
    if (bar) bar.removeAttribute('aria-valuenow');
    root.classList.remove('is-determinate');
  }
}

async function handleFiles(fileList) {
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

  // Crop PDF gets a real local-read + dependency-prewarm journey before
  // the existing preview navigation. All other tools keep the exact old path.
  if (Flow.step === 'upload') {
    // All standard tools now share the same upload → preparation → preview
    // transition. The preparation panel is not an upload-speed indicator.
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
    .then(ctrl => {
      pageOrganizer = ctrl;
      try { window.dispatchEvent(new CustomEvent('ilpdf:rotate-organizer-ready')); } catch (_) {}
    })
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
      // Create blob URL once per file entry; reuse on re-renders (rotate, reorder).
      // Revoked in removeFile() and clearAll() to prevent accumulation.
      if (!entry._thumbUrl) entry._thumbUrl = URL.createObjectURL(f);
      thumb = `<div class="file-thumb-wrap"><img src="${entry._thumbUrl}" alt="" style="transform:rotate(${entry.rotation}deg)"></div>`;
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
//
// RCA-2 FIX: Previously appended the canvas directly and set objectFit:cover
// on it — objectFit does NOT apply to <canvas> elements. On mobile the canvas
// would collapse or display at wrong dimensions. Now converts to dataURL and
// injects an <img> element, which fully supports objectFit:cover.
async function renderPdfThumbnails() {
  if (!window.PdfPreview) return;
  for (const entry of selectedFiles) {
    const host = document.querySelector(`[data-pdf-thumb="${entry.id}"]`);
    if (!host || host.dataset.rendered === '1') continue;
    host.dataset.rendered = '1';
    let pdfDoc;
    try {
      pdfDoc = await window.PdfPreview.loadDocument(entry.file);
      const canvas = await window.PdfPreview.renderPage(pdfDoc, 1, 80, 0);

      // Error canvas → leave fallback icon in place, log exact reason.
      if (canvas && canvas._isErrorCanvas) {
        console.warn('[PDF_THUMB_STATE] thumbnail failed for', entry.file.name,
          '— reason:', canvas._errorReason || 'unknown');
        continue;
      }

      // Convert to dataURL so we can use an <img> element that respects objectFit.
      let dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      } catch (toUrlErr) {
        console.warn('[PDF_THUMB_STATE] toDataURL failed for', entry.file.name, ':', toUrlErr.message);
        // Fallback: append canvas directly with explicit size CSS (no objectFit)
        canvas.style.cssText = 'display:block;width:100%;height:100%;border-radius:6px;';
        if (host.isConnected) { host.innerHTML = ''; host.appendChild(canvas); }
        continue;
      }

      // Verify the dataURL decoded correctly before injecting.
      await new Promise(function (resolve) {
        if (!host.isConnected) { resolve(); return; }
        const img = new Image();
        const timer = setTimeout(function () {
          img.onload = img.onerror = null;
          // Timeout on img decode — fall back to canvas
          console.warn('[PDF_THUMB_STATE] img decode timeout for', entry.file.name);
          canvas.style.cssText = 'display:block;width:100%;height:100%;border-radius:6px;';
          if (host.isConnected) { host.innerHTML = ''; host.appendChild(canvas); }
          resolve();
        }, 2000);
        img.onload = function () {
          clearTimeout(timer);
          if (img.naturalWidth > 0 && img.naturalHeight > 0 && host.isConnected) {
            img.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;border-radius:6px;';
            img.setAttribute('draggable', 'false');
            host.innerHTML = '';
            host.appendChild(img);
            console.debug('[PDF_THUMB_STATE] thumbnail ok:', entry.file.name,
              img.naturalWidth + 'x' + img.naturalHeight);
          } else {
            console.warn('[PDF_THUMB_STATE] img decoded but zero dimensions for', entry.file.name);
          }
          resolve();
        };
        img.onerror = function () {
          clearTimeout(timer);
          console.warn('[PDF_THUMB_STATE] img load error for', entry.file.name);
          resolve();
        };
        img.src = dataUrl;
      });
    } catch (err) {
      console.warn('[PDF_THUMB_STATE] thumbnail exception for', entry.file && entry.file.name, ':', err && err.message);
      // Leave the fallback file-text icon in place — never show a broken state.
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

    // Touch fallback: long-press + swap with neighbour using touch events.
    // Guard with dataset.touchBound (mirrors the stepBound guard above) to
    // prevent duplicate listener accumulation across renderFileList() calls.
    if (el.dataset.touchBound !== '1') {
      el.dataset.touchBound = '1';
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
    }
  });
}
