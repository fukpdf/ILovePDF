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
  const toolId  = registryMeta ? registryMeta.id : rawSlug;

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

  // Phase 4: the published Tool Registry is the runtime routing authority.
  // Resolve only after the registry readiness barrier so clean URLs never depend
  // on the legacy SLUG_MAP identity table.
  if (window.ToolRegistryReady) {
    try { await window.ToolRegistryReady; } catch (_) { /* registry failure is handled below */ }
  }
  const pathnameSlug = (window.location.pathname || '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .replace(/\/(preview|download)$/i, '');
  const queryId = new URLSearchParams(window.location.search).get('id');
  const registryByPath = window.ToolRegistry && window.ToolRegistry.isReady()
    ? (window.ToolRegistry.getBySlug(pathnameSlug) || window.ToolRegistry.get(pathnameSlug))
    : null;
  const registryByQuery = window.ToolRegistry && window.ToolRegistry.isReady() && queryId
    ? window.ToolRegistry.get(queryId)
    : null;
  const toolId = (window.__TOOL_ID && window.ToolRegistry && window.ToolRegistry.isReady())
    ? (window.ToolRegistry.get(window.__TOOL_ID)?.id || window.__TOOL_ID)
    : (registryByQuery?.id || registryByPath?.id || window.__TOOL_ID || queryId || pathnameSlug || null);

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

  // Registry-owned standalone routes replace the legacy SLUG_MAP special-route table.
  const slug = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const registryRoute = window.ToolRegistry && window.ToolRegistry.isReady()
    ? window.ToolRegistry.getBySlug(slug.replace(/\/(preview|download)$/i, ''))
    : null;
  if (registryRoute && registryRoute.specialRoute) {
    if (safeRedirect(registryRoute.specialRoute)) return;
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
    : '';
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
    <section class="popular-tools" aria-label="Popular tools">
      <h2 class="popular-title">Popular tools</h2>
      <div class="popular-grid">${list.map(t => `<a class="popular-card" href="/${t.slug}"><span class="popular-card-body"><span class="popular-card-name"><span class="tool-name-sticker" aria-hidden="true"><i data-lucide="${homepageIcon(t.slug, t.icon)}"></i></span><span class="popular-card-name-label">${t.name}</span></span><span class="popular-card-description">${t.description}</span></span><span class="popular-card-arrow" aria-hidden="true">→</span></a>`).join('')}</div>
    </section>`;
}

// ── SHARED BRANDED UPLOAD — deterministic tool-specific visual palette ────
function brandedToolPalette(tool) {
  // Human-designed flat color families: the upload CTA's violet remains the
  // visual anchor, while each tool gets two restrained supporting accents.
  const palettes = [
    ['#5b3df5','#18b7d6','#ffb703'], ['#5b3df5','#ff6b6b','#06d6a0'],
    ['#2563eb','#06b6d4','#f59e0b'], ['#7c3aed','#ec4899','#22c55e'],
    ['#0f766e','#14b8a6','#f59e0b'], ['#c2410c','#f97316','#facc15'],
    ['#4338ca','#6366f1','#fb7185'], ['#047857','#10b981','#fbbf24'],
    ['#be123c','#f43f5e','#22d3ee'],
  ];
  const id = String(tool && (tool.id || tool.name) || 'tool');
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return palettes[Math.abs(hash) % palettes.length];
}

// ── SHARED BRANDED UPLOAD — tool-specific content, common visual system ────
/* CLOUD PROVIDERS — compact side buttons + centered provider menu. */
function cloudProviderLogo(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'google-drive') return '<svg viewBox="0 0 64 56" aria-hidden="true"><path fill="#0F9D58" d="M21 3h16l20 35H41L21 3z"/><path fill="#4285F4" d="M21 3 3 34l8 14 18-31L21 3z"/><path fill="#F4B400" d="M11 48h36l10-17H21L11 48z"/></svg>';
  if (p === 'dropbox') return '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="#0061FF" d="m20 9 12 9-12 9-12-9 12-9zm24 0 12 9-12 9-12-9 12-9zM20 29l12 9-12 9-12-9 12-9zm24 0 12 9-12 9-12-9 12-9z"/><path fill="#0061FF" d="m20 50 12-9 12 9-12 7-12-7z"/></svg>';
  if (p === 'onedrive') return '<svg viewBox="0 0 64 52" aria-hidden="true"><path fill="#0364B8" d="M25 44H13C6 44 1 39 1 33s5-11 12-11c1-8 8-14 16-14 7 0 13 4 15 10 1 0 2-.2 3-.2 8 0 15 6 15 13.5S55 44 47 44H25z"/><path fill="#0078D4" d="M39 44h9c7 0 14-5 14-12.7 0-6.2-4.8-11.4-11-12.4-1.4 0-3.1.1-4.5.7C44 14 39 9 32 9c-1.3 0-2.5.2-3.7.5 6.4 1.8 11.1 7.2 12 13.9 7 0 12.8 4.7 14.4 11H39v9.6z"/></svg>';
  if (p === 'box') return '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="#0061D5" d="m8 19 24-11 24 11-24 11L8 19zm0 6 24 11 24-11v20L32 56 8 45V25z"/><path fill="#fff" d="m20 27 12 6 12-6v6l-12 6-12-6v-6z"/></svg>';
  if (p === 'icloud') return '<svg viewBox="0 0 64 56" aria-hidden="true"><path fill="#5B5B60" d="M21 45H12C5 45 1 40 1 34s5-11 12-11c1-9 8-15 17-15 8 0 14 5 16 12 1 0 2-.2 3-.2 8 0 14 6 14 13.5S57 45 49 45H21z"/></svg>';
  if (p === 'mega') return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="#d9272e"/><path fill="#fff" d="M12 40V23h7l13 11 13-11h7v17h-6V32L32 44 18 32v8h-6z"/></svg>';
  if (p === 'pcloud') return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="#7b4bd6"/><path fill="#fff" d="M17 44V25c0-7 5-11 12-11 6 0 10 3 12 8 5 0 9 4 9 9s-4 9-10 9H28v-6h12c2 0 4-1 4-3s-2-3-5-3h-3v-4c0-3-3-5-6-5s-6 2-6 6v19h-7z"/></svg>';
  if (p === 'sync') return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="#1a73e8"/><path fill="#fff" d="M18 28c3-7 8-10 15-10 5 0 9 2 12 6l-4 3c-2-2-5-4-8-4-4 0-7 2-9 5h7v5H18v-5zm28 8c-3 7-8 10-15 10-5 0-9-2-12-6l4-3c2 2 5 4 8 4 4 0 7-2 9-5h-7v-5h13v5z"/></svg>';
  if (p === 'proton') return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="#6d4aff"/><path fill="#fff" d="M16 44V27c0-8 6-13 16-13s16 5 16 13v17h-7V28c0-4-3-7-9-7s-9 3-9 7v16h-7z"/></svg>';
  return '<i data-lucide="cloud"></i>';
}

function renderCloudProviderMenu() {
  // The More menu intentionally shows logos only. Provider names remain in
  // accessible labels/tooltips, while Google Drive and Dropbox stay outside.
  return '<div class="ilpdf-cloud-provider-picker" id="cloud-provider-picker">' +
    '<div class="ilpdf-cloud-provider-list" id="cloud-provider-list" hidden>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="onedrive" title="Microsoft OneDrive" aria-label="Microsoft OneDrive">' + cloudProviderLogo('onedrive') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="icloud" title="iCloud Drive" aria-label="iCloud Drive">' + cloudProviderLogo('icloud') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="box" title="Box" aria-label="Box">' + cloudProviderLogo('box') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="mega" title="MEGA" aria-label="MEGA">' + cloudProviderLogo('mega') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="pcloud" title="pCloud" aria-label="pCloud">' + cloudProviderLogo('pcloud') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="sync" title="Sync.com" aria-label="Sync.com">' + cloudProviderLogo('sync') + '</button>' +
      '<button type="button" class="ilpdf-cloud-provider-option" data-cloud-provider="proton" title="Proton Drive" aria-label="Proton Drive">' + cloudProviderLogo('proton') + '</button>' +
    '</div></div>';
}

function normalizeUploadAcceptSpec(spec) {
  const mimeByExtension = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.txt': 'text/plain',
    '.zip': 'application/zip'
  };
  return String(spec || '')
    .split(',')
    .map(function (rule) { return rule.trim().toLowerCase(); })
    .filter(Boolean)
    .flatMap(function (rule) {
      if (rule.startsWith('.') && mimeByExtension[rule]) return [rule, mimeByExtension[rule]];
      return [rule];
    })
    .filter(function (rule, index, list) { return list.indexOf(rule) === index; })
    .join(',');
}

function renderBrandedUploadStep(tool, config) {
  const container = document.getElementById('tool-content');
  if (!container) return;
  container.classList.remove('ew-wide');

  const fileLabel = tool.multipleFiles
    ? _tp('tool.upload_files', config.fileLabel || 'Select files')
    : _tp('tool.upload_file', config.fileLabel || 'Select file');
  const cloudButtonsHtml =
    '<div class="ilpdf-branded-clouds" aria-label="Cloud upload options">' +
      '<div class="ilpdf-cloud-card-row">' +
        '<button type="button" class="ilpdf-branded-cloud ilpdf-cloud-google" id="upload-google-drive" title="Upload from Google Drive" aria-label="Upload from Google Drive">' + cloudProviderLogo('google-drive') + '</button>' +
        '<button type="button" class="ilpdf-branded-cloud ilpdf-cloud-dropbox" id="upload-dropbox" title="Upload from Dropbox" aria-label="Upload from Dropbox">' + cloudProviderLogo('dropbox') + '</button>' +
        '<button type="button" class="ilpdf-branded-cloud ilpdf-cloud-more-trigger" id="cloud-more-btn" title="More cloud providers" aria-label="More cloud providers" aria-expanded="false" aria-controls="cloud-provider-list"><span class="ilpdf-cloud-single-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7 9l5 5 5-5"/></svg></span></button>' +
      '</div>' +
      renderCloudProviderMenu() +
    '</div>';
  const multiAttr = tool.multipleFiles ? 'multiple' : '';
  container.innerHTML = `
    <div class="tool-page ilpdf-branded-upload ${config.pageClass || ''}">
      <section class="ilpdf-branded-upload-hero" aria-labelledby="${config.headingId || 'tool-upload-heading'}">
        ${(config.title || tool.name) === tool.name ? standaloneToolHeadingHtml(tool, 'ilpdf-branded-title', config.headingId || 'tool-upload-heading') : `<h1 class="ilpdf-branded-title" id="${config.headingId || 'tool-upload-heading'}">${escapeHtml(config.title || tool.name)}</h1>`}
        <p class="ilpdf-branded-subtitle">${config.subtitle || escapeHtml(tool.description)}</p>

        <div class="ilpdf-branded-upload-zone" id="upload-area" tabindex="0" role="button" aria-label="${escapeHtml(fileLabel)}">
          <input type="file" id="file-input" accept="${normalizeUploadAcceptSpec(tool.acceptedFiles)}" ${multiAttr}>

          <div class="ilpdf-branded-action-row">
            <button type="button" class="btn btn-primary ilpdf-branded-select" id="upload-cta-btn">
              <i data-lucide="upload"></i> ${escapeHtml(fileLabel)}
            </button>
            ${cloudButtonsHtml}
          </div>
          <div class="ilpdf-branded-droptext">or drop ${tool.multipleFiles ? 'files' : 'your file'} here</div>
        </div>

        <div class="ilpdf-branded-benefits" id="upload-benefits-list" aria-label="${escapeHtml(config.benefitsLabel || 'How this tool works')}">${(config.benefits || []).map(function (b) { return `<div class="ilpdf-branded-benefit"><div class="ilpdf-branded-sticker ${escapeHtml(b.sticker || '')}" aria-hidden="true">${b.art || ''}<i data-lucide="${escapeHtml(b.icon || 'check-circle-2')}"></i></div><div class="ilpdf-branded-benefit-copy"><strong>${escapeHtml(b.title)}</strong><span>${escapeHtml(b.text)}</span></div></div>`; }).join('')}</div>
      </section>

      ${trustStripHtml()}
      ${renderSeoContent(tool)}
      ${learnMoreHtml(tool)}
      ${popularToolsHtml(tool.id)}
    </div>`;

  const palette = brandedToolPalette(tool);
  const brandedRoot = container.querySelector('.ilpdf-branded-upload');
  if (brandedRoot) {
    brandedRoot.style.setProperty('--tool-tone', palette[0]);
    brandedRoot.style.setProperty('--tool-tone-2', palette[1]);
  }

  decorateSeoLineVisuals(container.querySelector('.seo-content--crop-contract'));

  if (window.lucide) lucide.createIcons();
  setupFileInput();

  {
    const moreBtn = document.getElementById('cloud-more-btn');
    const providerList = document.getElementById('cloud-provider-list');
    if (moreBtn && providerList) {
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = providerList.hidden;
        providerList.hidden = !open;
        moreBtn.setAttribute('aria-expanded', String(open));
        moreBtn.classList.toggle('is-open', open);
      });
      providerList.querySelectorAll('[data-cloud-provider]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          const provider = btn.getAttribute('data-cloud-provider');
          if (provider === 'google-drive' || provider === 'dropbox') {
            if (window.CloudUpload && typeof window.CloudUpload.open === 'function') {
              window.CloudUpload.open(provider, document.getElementById('file-input'));
            } else {
              document.getElementById('file-input')?.click();
            }
          }
          providerList.hidden = true;
          moreBtn.setAttribute('aria-expanded', 'false');
        });
      });
    }

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
    // Keep provider buttons opt-in until a verified CloudUpload adapter is
    // present. The local file picker remains the canonical shared path.
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

  container.classList.remove('ew-wide', 'tool-page');
  container.innerHTML = `
    <div class="ilpdf-download-page">
      <section class="ilpdf-download-hero" aria-label="Download your result">
        <h1 class="ilpdf-download-heading">Your ${escapeHtml(tool.name)} task was completed successfully.</h1>

        <div class="ilpdf-download-main">
          <div id="result-area" class="download-result">
            ${Flow.result ? Flow.result.html : ''}
          </div>

          <div class="ilpdf-download-cloud-actions" aria-label="More download options">
            <a href="/${slug}" class="ilpdf-download-circle ilpdf-download-back"
               data-go-step="upload"
               aria-label="Go back and process another file" title="Process another file">
              <i data-lucide="arrow-left"></i>
            </a>
            <div class="ilpdf-download-provider-actions" aria-label="Provider and sharing options">
              <button type="button" class="ilpdf-download-circle ilpdf-download-action-disabled"
                      aria-label="Save to Google Drive" title="Save to Google Drive" disabled>
                ${cloudProviderLogo('google-drive')}
              </button>
              <button type="button" class="ilpdf-download-circle ilpdf-download-share-trigger"
                      aria-label="Share download link" title="Share download link">
                <i data-lucide="link-2"></i>
              </button>
              <button type="button" class="ilpdf-download-circle ilpdf-download-action-disabled"
                      aria-label="Save to Dropbox" title="Save to Dropbox" disabled>
                ${cloudProviderLogo('dropbox')}
              </button>
              <button type="button" class="ilpdf-download-circle ilpdf-download-delete"
                      aria-label="Clear this result" title="Clear this result">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="ilpdf-continue-card" aria-label="Continue to other PDF tools">
        <div class="ilpdf-continue-title">Continue to...</div>
        <div class="related-tools-grid" id="related-tools-grid"></div>
        <div class="ilpdf-continue-more" id="related-tools-more" hidden>
          <a href="/tools">See more</a>
        </div>
      </section>

      <section class="ilpdf-thanks-card" aria-label="Share and support ILovePDF">
        <div class="ilpdf-thanks-kicker"><i data-lucide="heart-handshake" aria-hidden="true"></i> Made to help, free to use</div>
        <h2>Found this tool helpful? Spread the word!</h2>
        <p>Your support helps us keep ILovePDF free for everyone. Share it with a friend, colleague, or student. If you can, a small donation helps cover hosting, maintenance, and the work needed to keep these tools available—every contribution makes a difference.</p>
        <div class="ilpdf-share-actions" aria-label="Social sharing">
          <a class="ilpdf-share-btn ilpdf-share-facebook" href="#" data-share-network="facebook" aria-label="Share on Facebook"><span class="ilpdf-share-letter" aria-hidden="true">f</span> Facebook</a>
          <a class="ilpdf-share-btn ilpdf-share-x" href="#" data-share-network="x" aria-label="Share on X"><span class="ilpdf-share-letter" aria-hidden="true">𝕏</span> Share on X</a>
          <a class="ilpdf-share-btn ilpdf-share-linkedin" href="#" data-share-network="linkedin" aria-label="Share on LinkedIn"><span class="ilpdf-share-letter" aria-hidden="true">in</span> LinkedIn</a>
        </div>
        <a class="ilpdf-support-project-btn" href="/blog/support-the-project.html">
          <i data-lucide="heart" aria-hidden="true"></i>
          <span>Support the project</span>
          <i data-lucide="arrow-up-right" aria-hidden="true"></i>
        </a>
        <p class="ilpdf-support-note">Donations are optional. Sharing ILovePDF is also a huge help.</p>
      </section>

      <section class="ilpdf-platforms" aria-labelledby="ilpdf-platforms-title">
        <div class="ilpdf-platforms-eyebrow">ILOVEPDF EVERYWHERE</div>
        <h2 id="ilpdf-platforms-title">Your PDFs. Every device.</h2>
        <p class="ilpdf-platforms-intro">Work across your favourite devices with the same simple way to manage PDFs.</p>

        <div class="ilpdf-platform-grid">
          <div class="ilpdf-platform-item">
            <span class="ilpdf-platform-logo ilpdf-platform-logo--windows" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false"><path d="M4 10.2 21 7.8v15H4V10.2Zm20-2.7L44 4.5v18.3H24V7.5ZM4 25.2h17v15L4 37.8V25.2Zm20 0h20v18.3L24 40.8V25.2Z" fill="currentColor"/></svg>
            </span>
            <h3>Windows</h3>
            <p>PDF tools for Windows PCs and laptops.</p>
            <a class="ilpdf-platform-link" href="/download/windows">Explore Windows app <i data-lucide="arrow-up-right" aria-hidden="true"></i></a>
          </div>

          <div class="ilpdf-platform-item">
            <span class="ilpdf-platform-logo ilpdf-platform-logo--mac" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false"><path d="M31.6 24.6c0-4.4 3.6-6.5 3.8-6.6-2.1-3.1-5.4-3.5-6.6-3.6-2.8-.3-5.4 1.7-6.9 1.7-1.6 0-3.8-1.6-6.2-1.6-3.2.1-6.2 1.9-7.9 4.8-3.3 5.7-.9 14.2 2.3 18.8 1.5 2.3 3.4 4.8 5.8 4.7 2.3-.1 3.2-1.5 6.1-1.5 2.8 0 3.6 1.5 6.1 1.5 2.5-.1 4.1-2.3 5.6-4.6 1.8-2.6 2.4-5.3 2.4-5.4-.1 0-4.7-1.9-4.7-8.2ZM27.1 11.4c1.2-1.5 2.1-3.4 1.9-5.4-1.8.1-3.9 1.2-5.2 2.7-1.1 1.2-2.1 3.2-1.9 5.1 2 .1 4-.9 5.2-2.4Z" fill="currentColor"/></svg>
            </span>
            <h3>Mac</h3>
            <p>PDF tools for MacBook and iMac.</p>
            <a class="ilpdf-platform-link" href="/download/mac">Explore Mac app <i data-lucide="arrow-up-right" aria-hidden="true"></i></a>
          </div>

          <div class="ilpdf-platform-item">
            <span class="ilpdf-platform-logo ilpdf-platform-logo--android" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false"><path d="M14.1 15.5 11.5 11a.9.9 0 0 1 1.6-.9l2.8 4.7a14.7 14.7 0 0 1 14.2 0l2.8-4.7a.9.9 0 1 1 1.6.9l-2.6 4.5a13 13 0 0 1 5.8 10.6H8.3a13 13 0 0 1 5.8-10.6ZM8.3 28.2h29.4V35a3.1 3.1 0 0 1-3.1 3.1h-2.3v3.5a2 2 0 0 1-4 0v-3.5h-8.1v3.5a2 2 0 0 1-4 0v-3.5h-2.3A3.1 3.1 0 0 1 8.3 35v-6.8Z" fill="currentColor"/><circle cx="16" cy="20.4" r="1.3" fill="#fff"/><circle cx="30" cy="20.4" r="1.3" fill="#fff"/></svg>
            </span>
            <h3>Android</h3>
            <p>PDF tools for Android phones and tablets.</p>
            <a class="ilpdf-platform-link" href="/download/android">Explore Android app <i data-lucide="arrow-up-right" aria-hidden="true"></i></a>
          </div>

          <div class="ilpdf-platform-item">
            <span class="ilpdf-platform-logo ilpdf-platform-logo--ios" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false"><path d="M33.2 25.2c0-5.1 4.2-7.5 4.4-7.6-2.4-3.6-6.2-4-7.6-4.1-3.2-.3-6.2 2-7.9 2-1.8 0-4.4-1.9-7.1-1.8-3.7.1-7.1 2.2-9 5.5-3.8 6.5-1 16.2 2.6 21.4 1.7 2.6 3.9 5.5 6.6 5.4 2.6-.1 3.7-1.8 6.9-1.8 3.2 0 4.1 1.8 6.9 1.7 2.9-.1 4.7-2.6 6.4-5.2 2-3 2.8-6 2.8-6.2-.1 0-5.4-2.1-5.4-9.3ZM28.1 10.1c1.4-1.7 2.4-3.9 2.2-6.1-2 .1-4.4 1.4-5.9 3.1-1.3 1.4-2.4 3.6-2.2 5.8 2.3.1 4.5-1.1 5.9-2.8Z" fill="currentColor"/></svg>
            </span>
            <h3>iPhone &amp; iPad</h3>
            <p>PDF tools for iPhone and iPad.</p>
            <a class="ilpdf-platform-link" href="/download/ios">Explore iPhone &amp; iPad app <i data-lucide="arrow-up-right" aria-hidden="true"></i></a>
          </div>
        </div>
      </section>

      <div class="ad-wrap ad-wrap--tight ilpdf-download-ad" role="complementary" aria-label="Advertisement">
        <div class="ad-slot ad-slot--download"
             id="ad-download-banner"
             data-ad-slot="download-banner"
             data-ad-ezoic="104"
             data-ad-pending="1"
             aria-hidden="true"></div>
      </div>
    </div>`;

  const area = document.getElementById('result-area');
  if (area) {
    // UI-only: preserve the exact real download anchor while moving it into
    // the iLovePDF-style result layout.
    const realDownload = area.querySelector('a[download]');
    if (realDownload) {
      const filename = realDownload.getAttribute('download') || 'download';
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const labels = {
        pdf: 'Download PDF', doc: 'Download WORD', docx: 'Download WORD',
        ppt: 'Download POWERPOINT', pptx: 'Download POWERPOINT',
        xls: 'Download EXCEL', xlsx: 'Download EXCEL',
        jpg: 'Download JPG', jpeg: 'Download JPG', png: 'Download PNG', zip: 'Download ZIP'
      };
      const label = labels[ext] || 'Download File';

      area.innerHTML = '<div class="ilpdf-download-reference-result"><div class="ilpdf-download-cta-wrap"></div></div>';

      realDownload.className = 'btn btn-primary ilpdf-download-primary dl-burst-trigger';
      realDownload.style.setProperty('background', 'linear-gradient(135deg,#4f46e5 0%,#7c3aed 50%,#9333ea 100%)', 'important');
      realDownload.style.setProperty('background-color', '#4f46e5', 'important');
      realDownload.style.setProperty('border-color', '#4f46e5', 'important');
      realDownload.style.setProperty('color', '#fff', 'important');
      realDownload.innerHTML = '<i data-lucide="download" aria-hidden="true"></i><span>' + label + '</span>';
      realDownload.setAttribute('aria-label', label);
      area.querySelector('.ilpdf-download-cta-wrap').appendChild(realDownload);
    }

    area.querySelectorAll('[data-burst-bound]').forEach(el => el.removeAttribute('data-burst-bound'));
    if (typeof attachDownloadBurst === 'function') attachDownloadBurst(area);
  }

  const resultArea = document.getElementById('result-area');
  const shareTrigger = container.querySelector('.ilpdf-download-share-trigger');
  const deleteTrigger = container.querySelector('.ilpdf-download-delete');

  if (shareTrigger) {
    shareTrigger.addEventListener('click', async () => {
      const downloadAnchor = resultArea && resultArea.querySelector('a[download]');
      const shareUrl = downloadAnchor && downloadAnchor.href;
      if (!shareUrl) return;
      try {
        if (navigator.share) {
          await navigator.share({ title: tool.name + ' result', url: shareUrl });
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(shareUrl);
          shareTrigger.setAttribute('title', 'Download link copied');
          shareTrigger.setAttribute('aria-label', 'Download link copied');
          setTimeout(() => {
            shareTrigger.setAttribute('title', 'Share download link');
            shareTrigger.setAttribute('aria-label', 'Share download link');
          }, 1800);
        }
      } catch (_) {}
    });
  }

  if (deleteTrigger) {
    deleteTrigger.addEventListener('click', () => {
      try {
        if (window.ToolState && currentTool) {
          const clear = window.ToolState.clearAfterDelivery || window.ToolState.clear;
          if (typeof clear === 'function') clear.call(window.ToolState, slug);
        }
      } catch (_) {}
      Flow.navTo('upload');
    });
  }

  container.querySelectorAll('[data-share-network]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const network = link.getAttribute('data-share-network');
      const shareUrl = encodeURIComponent(window.location.href);
      const text = encodeURIComponent(tool.name + ' — free online PDF tool');
      const targets = {
        facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + shareUrl,
        x: 'https://twitter.com/intent/tweet?url=' + shareUrl + '&text=' + text,
        linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + shareUrl
      };
      const target = targets[network];
      if (target) {
        window.open(target, '_blank', 'noopener,noreferrer,width=680,height=620');
      }
    });
  });

  if (window.lucide) lucide.createIcons();

  wireStepNav();
  try { window.dispatchEvent(new CustomEvent('ilpdf:step', { detail: { step: 'download' } })); } catch (_) {}

  setTimeout(function () {
    try {
      const relGrid = document.getElementById('related-tools-grid');
      const more = document.getElementById('related-tools-more');
      if (!relGrid || !window.TOOL_GROUPS) return;
      const toolId = tool && (tool.id || tool.tid);
      const relHtml = _buildRelatedToolsHtml(toolId, 6);
      if (!relHtml) return;
      relGrid.innerHTML = relHtml;
      if (more) more.hidden = false;
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
    var icon = String(t.icon || 'file').replace(/[^a-z0-9-]/gi, '');
    var name = String(t.name || t.tid || 'Tool');
    var description = String(t.description || t.desc || 'Open this tool to continue working with your files.');
    var safeName = name.replace(/[&<>"']/g, function (ch) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]);
    });
    var safeDescription = description.replace(/[&<>"']/g, function (ch) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]);
    });
    var palette = ['merge','compress','convert','image','word','rotate','protect','unlock'];
    var colorIndex = related.indexOf(t) % palette.length;
    return '<a class="popular-card continue-tool-card continue-tool-card--' + palette[colorIndex] + '" href="' + href + '" aria-label="' + safeName + '">' +
      '<span class="popular-card-icon" aria-hidden="true"><i data-lucide="' + icon + '"></i></span>' +
      '<span class="popular-card-body"><span class="popular-card-name">' + safeName + '</span>' +
      '<span class="popular-card-description">' + safeDescription + '</span></span>' +
      '<span class="popular-card-arrow" aria-hidden="true">→</span>' +
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

  // Validate immediately at selection time so an unsupported file never enters
  // the upload/preview pipeline. Keep the same BrowserTools validator used by
  // processing; this is only an early UI guard.
  if (window.BrowserTools && typeof window.BrowserTools.validateInputFiles === 'function') {
    const validation = window.BrowserTools.validateInputFiles(
      incoming,
      currentTool && currentTool.acceptedFiles,
      currentTool && currentTool.multipleFiles
    );
    if (!validation.ok) {
      showStatus(
        'error',
        _tp('status.invalid_input', 'Invalid input'),
        validation.message || _tp('status.invalid_input_msg', 'Please check the selected files and try again.')
      );
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

  // All file-upload tools use the same Crop-PDF reference preparation journey;
  // tool-specific processing and preview controls remain isolated.
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
  window.PageOrganizer.open(host, files[0], { onChange: () => {}, allowStructuralEdits: !(currentTool && currentTool.id === 'rotate') })
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

function rotateFile(index) {
  if (!selectedFiles[index]) return;
  selectedFiles[index].rotation = (selectedFiles[index].rotation + 90) % 360;
  const degreesEl = document.getElementById('opt-degrees');
  if (degreesEl) degreesEl.value = String(selectedFiles[index].rotation);
  renderFileList();
}

function removeFile(index) {
  const _rem = selectedFiles[index];
  if (_rem && _rem._thumbUrl) { try { URL.revokeObjectURL(_rem._thumbUrl); } catch (_) {} }
  selectedFiles.splice(index, 1);
  renderFileList();
  if (selectedFiles.length === 0) {
    closePageOrganizer();
    if (typeof clearAllBursts === 'function') clearAllBursts();
  }
}

function clearAll() {
  selectedFiles.forEach(function (e) { if (e._thumbUrl) { try { URL.revokeObjectURL(e._thumbUrl); } catch (_) {} } });
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
  // Phase 3: also clear the cross-session resume pointer for this tool.
  try { if (window.SessionPersist) window.SessionPersist.clearResume(); } catch (_) {}
}

// ── OUTPUT VALIDATOR ─────────────────────────────────────────────────────────
// Inspects every result before handing it to the download trigger.
// Guards against empty blobs, malformed PDFs, and text-only whitespace outputs.
const OutputValidator = {
  async check(toolId, result) {
    if (window.BrowserTools && typeof window.BrowserTools.validateOutput === 'function') {
      return window.BrowserTools.validateOutput(toolId, result);
    }
    return { ok: false, msg: 'Output validation is unavailable. Please reload and try again.' };
  },
};

// ── PROCESSING RETRY WRAPPER ──────────────────────────────────────────────────
// Attempt the browser-side processing up to MAX_ATTEMPTS times.
// Terminal errors (file too large, user-correctable inputs) are not retried.
async function tryWithRetry(toolId, files, opts) {
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 0) {
        showProcessing(_tp('processing.retrying', 'Retrying processing…'), _tp('processing.retrying_msg', 'The browser worker is retrying the operation.'));
        await new Promise(r => setTimeout(r, 700));
      }
      const registryTool = (window.ToolRegistry && typeof window.ToolRegistry.get === 'function')
        ? window.ToolRegistry.get(toolId) : null;
      if (registryTool && registryTool.execution === 'browser') {
        if (!window.BrowserToolRuntime || typeof window.BrowserToolRuntime.execute !== 'function') {
          throw new Error('BrowserToolRuntime is unavailable — canonical browser execution cannot continue');
        }
        return await window.BrowserToolRuntime.execute(toolId, files, opts);
      }
      return await window.BrowserTools.process(toolId, files, opts);
    } catch (err) {
      lastErr = err;
      const m = (err && err.message) || '';
      // Don't retry terminal / user-correctable conditions
      if (
        m === 'file_too_large_for_browser' ||
        m === 'memory_pressure' ||
        m === 'No files provided' ||
        m.startsWith('Please enter') ||
        m.startsWith('Please upload') ||
        m.startsWith('No text provided') ||
        m.includes('Please select') ||
        m.includes('Please upload two')
      ) throw err;
    }
  }
  throw lastErr;
}

// ── PROCESS FILE ───────────────────────────────────────────────────────────

async function processFile() {
  // Re-entrancy guard: a rapid double-click must never launch two concurrent
  // processing runs.  All downstream validation is synchronous so this guard
  // fires before any async work begins.
  if (_processingInFlight) return;
  if (!currentTool) return;
  if (selectedFiles.length === 0) {
    showStatus('error', _tp('status.no_file', 'No file selected'), _tp('status.no_file_msg', 'Please upload a file before processing.'));
    return;
  }
  if (!currentTool.working) {
    showStatus('error', _tp('tool.unavailable', 'Tool unavailable'), _tp('tool.unavailable_msg', 'This tool is not currently available.'));
    return;
  }

  // Daily usage limit — guests 15/day, logged-in 100/day
  if (window.UsageLimit && !window.UsageLimit.canUse()) {
    window.UsageLimit.showLimitModal();
    return;
  }

  // Shared execution-boundary input validation. The selected tool's
  // accepted file contract is checked before any processor/worker is invoked.
  if (window.BrowserTools && typeof window.BrowserTools.validateInputFiles === 'function') {
    const inputValidation = window.BrowserTools.validateInputFiles(
      selectedFiles.map(e => e.file),
      currentTool.acceptedFiles,
      currentTool.multipleFiles
    );
    if (!inputValidation.ok) {
      showStatus('error',
        _tp('status.invalid_input', 'Invalid input'),
        inputValidation.message || _tp('status.invalid_input_msg', 'Please check the selected files and try again.'));
      return;
    }
  }

  // Compress PDF uses the selected mode directly: Deep Compression needs no
  // second click, while Custom passes its validated target size to the renderer.
  if (currentTool.id === 'compress') {
    let mode;
    let targetBytes = null;
    try {
      // Read the mode once, then validate the target against that exact mode.
      // This prevents a missing target from silently falling through to Deep.
      mode = readCompressMode();
      targetBytes = readCompressTargetBytes(mode);
      if (mode === 'custom' && !Number.isSafeInteger(targetBytes)) {
        throw new Error('Custom mode requires a valid target size. Deep Compression was not started.');
      }
      if (mode === 'deep' && targetBytes !== null) {
        throw new Error('Unexpected custom target detected. Please reselect the compression mode.');
      }
    } catch (err) {
      showStatus('error', 'Check compression settings', err.message || 'Enter a valid output size.');
      return;
    }
    _processingInFlight = true;
    const compressProcessBtn = document.getElementById('process-btn');
    if (compressProcessBtn) compressProcessBtn.disabled = true;
    try {
      await runAdvancedCompress({ targetBytes, mode });
    } finally {
      _processingInFlight = false;
      if (compressProcessBtn) compressProcessBtn.disabled = false;
    }
    return;
  }

  // Past all synchronous validation — commit to processing.
  // The try/finally below guarantees _processingInFlight and processBtn are
  // always restored regardless of which exit path fires (success, error, throw).
  _processingInFlight = true;
  const processBtn = document.getElementById('process-btn');

  // Soft 90-second warning: if processing is still running after 90 s, update
  // the subtitle to reassure the user and hint at cancellation — without
  // interrupting the actual processing.
  let _softWarnTimer = setTimeout(() => {
    try {
      const msgEl = document.getElementById('processing-msg');
      if (msgEl && _processingInFlight) {
        msgEl.textContent = 'Still working\u2026 Large files can take a few minutes. You can cancel and try again if needed.';
      }
    } catch (_) {}
  }, 90000);

  // Phase 7J: record tool processing start in session recorder + forensics
  try {
    var _p7Sr = window.RuntimeSessionRecorder;
    if (_p7Sr && typeof _p7Sr.record === 'function') {
      _p7Sr.record('tool_process_start', {
        tool: currentTool.id,
        files: selectedFiles.length,
        totalBytes: selectedFiles.reduce(function (s, e) { return s + (e.file ? e.file.size : 0); }, 0),
      });
    }
  } catch (_) {}

  // Phase 8J: persist processing start to IDB for cross-navigation forensics
  try {
    var _p8Sp = window.RuntimeSessionPersistence;
    if (_p8Sp && typeof _p8Sp.persistEvent === 'function') {
      _p8Sp.persistEvent('tool_process_start', {
        tool: currentTool.id,
        files: selectedFiles.length,
      });
    }
  } catch (_) {}

  // Phase 8J: check memory vault for any cached execution context
  try {
    var _p8Mv = window.RuntimeMemoryVault;
    if (_p8Mv && typeof _p8Mv.store === 'function') {
      _p8Mv.store('last_tool_dispatch', { tool: currentTool.id, ts: Date.now() }, 60000);
    }
  } catch (_) {}
  try {
    // ── Page-organizer integration ──────────────────────────────────────────
    // Rotate PDF is worker-owned: keep the original bytes intact and pass the
    // page rotation/order plan to RotateRuntime instead of baking a new PDF on
    // the main thread. Other page-level tools retain their existing editor path.
    let rotatePagePlan = null;
    if (pageOrganizer && selectedFiles.length === 1) {
      try {
        if (pageOrganizer.getPageCount() === 0) {
          showStatus('error', _tp('status.no_pages', 'No pages selected'), _tp('status.no_pages_msg', 'Please keep at least one page before processing.'));
          return;
        }

        if (currentTool.id === 'rotate' && typeof pageOrganizer.getRotationPlan === 'function') {
          rotatePagePlan = pageOrganizer.getRotationPlan();
        } else if (currentTool.id === 'organize' && typeof pageOrganizer.getOrderSummary === 'function') {
          // Keep the original PDF bytes intact; the canonical Organize worker
          // applies the page order directly so the UI and exported structure stay aligned.
        } else {
          showProcessing(_tp('steps.processing_file', 'Processing your file…'), 'Just a moment.');
          const { file: editedFile } = await pageOrganizer.getEditedPdf();
          selectedFiles[0] = { ...selectedFiles[0], file: editedFile, rotation: 0 };
          hideProcessing();
        }
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
    showProcessing(_tp('steps.processing_file', 'Processing your file…'), _tp('steps.usual_time', 'This usually takes only a few seconds.'));
    if (processBtn) processBtn.disabled = true;

    // ── Browser-side path FIRST: dispatch only through the authoritative
    // execution manifest. There is no server/upload fallback for a tool that
    // declares a browser processor but cannot execute it locally.
    const executionManifest = (window.BrowserTools &&
      typeof window.BrowserTools.getToolExecutionManifest === 'function')
      ? window.BrowserTools.getToolExecutionManifest(currentTool.id)
      : null;

    const toolModule = (window.ToolModuleRegistry && typeof window.ToolModuleRegistry.get === 'function')
      ? window.ToolModuleRegistry.get(currentTool.id) : null;

    if (currentTool.clientSide &&
        executionManifest &&
        executionManifest.processor === 'browser-tools') {
      try {
        const opts = {};
        (currentTool.options || []).forEach(o => {
          const el = document.getElementById(`opt-${o.id}`);
          if (el && el.value !== '') opts[o.id] = el.value;
        });
        if (currentTool.id === 'rotate' && rotatePagePlan) {
          opts.pagePlan = rotatePagePlan;
        }
        if (currentTool.id === 'organize' && pageOrganizer && typeof pageOrganizer.getOrderSummary === 'function') {
          const summary = pageOrganizer.getOrderSummary();
          opts.pageOrder = Array.isArray(summary.order) ? summary.order.join(',') : '';
        }
        const result = await tryWithRetry(
          currentTool.id,
          selectedFiles.map(e => e.file),
          opts,
        );

        // ── Output Validation Layer ───────────────────────────────────────
        const validation = await OutputValidator.check(currentTool.id, result);
        if (!validation.ok) {
          hideProcessing();
          showStatus('error', _tp('status.result_incomplete', 'Result incomplete'), validation.msg);
          return;
        }

        const { blob, filename } = result;
        hideProcessing();
        if (window.UsageLimit) window.UsageLimit.record(selectedFiles.length);

        // Phase 7J: record success to session recorder + forensics snapshot
        try {
          var _p7SrOk = window.RuntimeSessionRecorder;
          if (_p7SrOk && typeof _p7SrOk.record === 'function') {
            _p7SrOk.record('tool_process_success', {
              tool: currentTool.id,
              outputBytes: blob ? blob.size : 0,
            });
          }
          var _p7Fok = window.RuntimeForensics;
          if (_p7Fok && typeof _p7Fok.snapshot === 'function') {
            _p7Fok.snapshot('tool-success', { tool: currentTool.id, outputBytes: blob ? blob.size : 0 });
          }
        } catch (_) {}

        // Compress: surface "already optimised" when the PDF could not be shrunk.
        const isAlreadyOpt = currentTool.id === 'compress' && result.alreadyOptimized;
        showStatus(
          'success',
          isAlreadyOpt ? _tp('status.already_opt', 'Already optimised') : _tp('status.file_ready', 'Your file is ready'),
          result.report && result.report.message
            ? result.report.message
            : (isAlreadyOpt
                ? _tp('status.already_opt_msg', 'Your PDF is already well-optimised. No verified lossless reduction was available, so the original was preserved.')
                : _tp('status.click_download', 'Click the Download button below to save your file.')),
          createStatusUrl(blob),
          filename,
        );
        return;
      } catch (err) {
        hideProcessing();
        const rawMsg = (err && err.message) || '';
        let userMsg = 'Something went wrong. Please try again.';
        if (rawMsg === 'file_too_large_for_browser') {
          userMsg = 'Your device could not complete this browser-side operation. Please try again; larger documents may simply require more device memory or processing time.';
        } else if (rawMsg === 'memory_pressure') {
          userMsg = 'Your device is running low on memory. Please close other tabs and try again.';
        } else if (rawMsg && rawMsg !== '__orig__' &&
                   rawMsg !== 'NO_BROWSER_GAIN' &&
                   rawMsg !== 'No browser-side compression possible' &&
                   !rawMsg.startsWith('no_processor_') &&
                   !rawMsg.includes('Worker') &&
                   !rawMsg.includes('wasm') &&
                   !rawMsg.includes('OPFS') &&
                   !rawMsg.includes('chunk') &&
                   !rawMsg.includes('ArrayBuffer') &&
                   rawMsg.length < 220) {
          userMsg = rawMsg.charAt(0).toUpperCase() + rawMsg.slice(1).replace(/_/g, ' ');
        }

        // Phase 7J: forensics snapshot + incident engine + session recorder on errors
        try {
          var _p7Tool = currentTool ? currentTool.id : 'unknown';
          var _p7Ctx  = { tool: _p7Tool, error: rawMsg.slice(0, 120) };

          var _p7Rf = window.RuntimeForensics;
          if (_p7Rf && typeof _p7Rf.snapshot === 'function') {
            _p7Rf.snapshot('tool-error', _p7Ctx);
          }

          var _p7Sr2 = window.RuntimeSessionRecorder;
          if (_p7Sr2 && typeof _p7Sr2.record === 'function') {
            _p7Sr2.record('tool_process_error', _p7Ctx);
          }

          // Only raise an incident for genuine failures (not "no browser gain")
          if (rawMsg !== 'NO_BROWSER_GAIN' && rawMsg !== 'No browser-side compression possible') {
            var _p7Inc = window.RuntimeIncidentEngine;
            if (_p7Inc && typeof _p7Inc.report === 'function') {
              _p7Inc.report('browser-tool-error', 35, 'tool-page', _p7Ctx);
            }
            var _p7Ss = window.RuntimeSecurityStream;
            if (_p7Ss && typeof _p7Ss.push === 'function') {
              _p7Ss.push('tool-error', 'tool-page', 'WARN',
                'Browser tool error: ' + _p7Tool, _p7Ctx);
            }
          }
        } catch (_) {}

        showStatus('error', _tp('status.processing_failed', 'Processing failed'), userMsg);
        return;
      }
    }

    // No verified browser processor exists for this tool. Do not upload the
    // user's file through an unverified fallback path.
    hideProcessing();
    showStatus('error', _tp('status.tool_unavailable', 'Tool unavailable'),
      _tp('status.tool_unavailable_msg', 'This tool is not yet available in your browser. Please try again in a moment.'));
  } finally {
    // Always restore button state and clear the re-entrancy guard — regardless
    // of which exit path fired (success return, error return, or uncaught throw).
    clearTimeout(_softWarnTimer);
    _processingInFlight = false;
    if (processBtn) processBtn.disabled = false;
  }
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
  const reg = window.ObjectURLRegistry;
  const url  = reg ? reg.create(blob, 'trigger-download') : URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => {
    try { reg ? reg.revoke(url) : URL.revokeObjectURL(url); } catch (_) {}
  }, 30000);
}

// Create an object URL for showStatus download links and schedule automatic
// revocation after 5 minutes (generous enough for any user action).
// Routes through ObjectURLRegistry when available so memory-pressure cleanup
// and pagehide revocation both fire correctly.
function createStatusUrl(blob) {
  if (window.ObjectURLRegistry) {
    const url = window.ObjectURLRegistry.create(blob, 'status-download');
    setTimeout(() => {
      try { window.ObjectURLRegistry.revoke(url); } catch (_) {}
    }, 5 * 60 * 1000);
    return url;
  }
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

async function runAdvancedCompress(config = {}) {
  if (!selectedFiles || !selectedFiles.length) return;

  // The selected mode is authoritative. Never infer Custom vs Deep from the
  // presence of targetBytes, because a missing/mismatched target must fail
  // closed instead of silently running Deep Compression.
  const requestedMode = config.mode;
  if (requestedMode !== 'deep' && requestedMode !== 'custom') {
    showStatus('error', 'Choose compression mode', 'Select Deep Compression or Custom before processing.');
    return;
  }
  const isCustom = requestedMode === 'custom';
  const targetBytes = isCustom && Number.isSafeInteger(config.targetBytes) && config.targetBytes > 0
    ? config.targetBytes : null;
  if (isCustom && !targetBytes) {
    showStatus('error', 'Custom target missing', 'Custom mode did not receive a valid target size. Deep Compression was not started. Please re-enter the target and try again.');
    return;
  }
  const processBtn = document.getElementById('process-btn');
  if (processBtn) processBtn.disabled = true;
  showProcessing(
    isCustom ? 'Applying custom compression…' : 'Applying deep compression…',
    isCustom
      ? 'Trying a lossless compression pass against your target. The target will not be forced by degrading content.'
      : 'Applying a lossless structural pass. Images and decoded page content will not be re-encoded.',
  );

  // Keep the source document outside the try so every exit path destroys it.
  let srcPdf = null;
  let sourcePdfLib = null;
  const cancelButton = document.getElementById('processing-cancel-btn');
  let preflightCancelled = false;
  const onCompressionCancel = () => {
    preflightCancelled = true;
    if (window.CompressRuntime && typeof window.CompressRuntime.cancelActive === 'function') {
      window.CompressRuntime.cancelActive('user-cancel');
    }
  };
  if (cancelButton) {
    cancelButton.addEventListener('click', onCompressionCancel);
    cancelButton.classList.remove('hidden');
  }
  try {
    const { PDFDocument, PDFName } = await window.BrowserTools._loadPdfLib();
    let pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      const _p = window.__pdfjsLibPromise ||
        import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(m => {
          const lib = m && (m.default || m);
          lib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
          window.pdfjsLib = lib;
          return lib;
        });
      window.__pdfjsLibPromise = _p;
      pdfjsLib = await _p;
    }

    const file = selectedFiles[0].file;
    let data = await file.arrayBuffer();

    // Fail closed before any rewrite for signatures, encryption and form/XFA
    // markers. The page-rendering implementation below is a legacy fallback,
    // not the verified object-level kit; these document classes must remain
    // byte-for-byte unchanged until the lossless qpdf path is wired in.
    const rawPdfBytes = new Uint8Array(data);
    const hasAsciiToken = (token) => {
      outer: for (let i = 0; i <= rawPdfBytes.length - token.length; i++) {
        for (let j = 0; j < token.length; j++) {
          if (rawPdfBytes[i + j] !== token.charCodeAt(j)) continue outer;
        }
        return true;
      }
      return false;
    };
    const sensitivePdfReason = [
      ['/ByteRange', 'Digitally signed PDFs cannot be modified without invalidating their signature.'],
      ['/Encrypt', 'Encrypted PDFs are preserved unchanged until a verified lossless path is available.'],
      ['/XFA', 'XFA forms are preserved unchanged to avoid damaging form data.'],
      ['/AcroForm', 'Interactive forms are preserved unchanged until form-safe compression is available.'],
      ['/Outlines', 'PDF bookmarks/outlines are preserved unchanged until document-structure preservation is verified.'],
      ['/EmbeddedFiles', 'PDF attachments are preserved unchanged until document-structure preservation is verified.'],
      ['/StructTreeRoot', 'Tagged-PDF structure is preserved unchanged until document-structure preservation is verified.'],
    ].find(([token]) => hasAsciiToken(token));
    if (sensitivePdfReason) {
      hideProcessing();
      showStatus(
        'success',
        'Compression safely skipped',
        sensitivePdfReason[1] + ' Your original PDF is ready to download unchanged.',
        createStatusUrl(file),
        file.name,
      );
      return;
    }

    // Keep a PDF-Lib copy of the original so text/vector pages can be copied
    // into the output without flattening them into a JPEG page image.
    sourcePdfLib = await PDFDocument.load(data.slice(0), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });

    // AcroForm can live in a compressed object stream, so raw marker scanning
    // is not enough. Check the parsed catalog before the legacy page-rebuild path.
    if (sourcePdfLib.catalog.get(PDFName.of('AcroForm'))) {
      hideProcessing();
      showStatus(
        'success',
        'Compression safely skipped',
        'This PDF contains an interactive form. It is preserved unchanged until form-safe compression is available.',
        createStatusUrl(file),
        file.name,
      );
      return;
    }

    srcPdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    data = null;

    // Page copying into a fresh PDFDocument can drop document-level navigation
    // and embedded files. Query the parsed PDF.js catalog as well as raw tokens.
    const [outline, attachments] = await Promise.all([
      typeof srcPdf.getOutline === 'function' ? srcPdf.getOutline() : Promise.resolve(null),
      typeof srcPdf.getAttachments === 'function' ? srcPdf.getAttachments() : Promise.resolve(null),
    ]);
    if (outline || attachments) {
      hideProcessing();
      showStatus(
        'success',
        'Compression safely skipped',
        'This PDF contains bookmarks or embedded attachments. The original is preserved unchanged.',
        createStatusUrl(file),
        file.name,
      );
      return;
    }

    const total = srcPdf.numPages;

    // The previous UI path rasterized image-only pages into JPEGs. That can
    // damage 1-bit scans, masks, image filters, and non-page objects, so it is
    // deliberately removed from the active path. Until the full image-object
    // optimizer passes its quality gates, use only a verified lossless QPDF
    // structural pass and preserve the original on every failed check.
    for (let i = 1; i <= srcPdf.numPages; i++) {
      showProcessing(
        'Checking PDF structure — page ' + i + ' of ' + srcPdf.numPages + '…',
        'Checking for links and annotations before lossless compression.',
      );
      const page = await srcPdf.getPage(i);
      const annotations = await page.getAnnotations({ intent: 'display' });
      page.cleanup();
      if (preflightCancelled) {
        throw new Error('Compression cancelled. The original PDF was preserved unchanged.');
      }
      if (annotations.length > 0) {
        hideProcessing();
        showStatus(
          'success',
          'Compression safely skipped',
          'This PDF contains links or annotations. The original is preserved unchanged.',
          createStatusUrl(file),
          file.name,
        );
        return;
      }
    }

    showProcessing(
      isCustom ? 'Applying Custom compression…' : 'Applying Deep compression…',
      'Processing locally in your browser. Text, vectors and protected streams stay intact; eligible RGB images are re-encoded only when visual quality checks pass.',
    );
    let runtimeResult;
    if (preflightCancelled) throw new Error('Compression cancelled. The original PDF was preserved unchanged.');
    if (!window.CompressRuntime || typeof window.CompressRuntime.execute !== 'function') {
      throw new Error('The local compression runtime is unavailable. No upload fallback was attempted.');
    }
    runtimeResult = await window.CompressRuntime.execute(file, {
      mode: requestedMode,
      targetBytes,
    });

    const outputBlob = runtimeResult.blob;
    if (outputBlob.size > file.size) {
      throw new Error('The candidate was larger than the source. The original PDF must be preserved.');
    }
    const outputSignature = await outputBlob.slice(0, 5).text();
    if (outputSignature !== '%PDF-') {
      throw new Error('Compression produced an invalid PDF. The original was not replaced.');
    }
    const report = runtimeResult.report || {};
    hideProcessing();
    if (window.UsageLimit) window.UsageLimit.record(1);
    if (!['qpdf-lossless-structure', 'browser-rgb-image', 'ghostscript-quality-gated'].includes(report.method) || outputBlob.size >= file.size) {
      const title = isCustom && targetBytes && file.size > targetBytes
        ? 'Custom target not reached'
        : 'Already optimised';
      showStatus(
        'success',
        title,
        report.message || 'No verified reduction was available, so the original PDF is preserved unchanged.',
        createStatusUrl(file),
        file.name,
      );
      return;
    }

    const filename = file.name.replace(/\.pdf$/i, '') + '_compressed.pdf';
    const title = isCustom && report.targetReached
      ? 'Custom target reached with quality-gated compression'
      : (isCustom ? 'Custom target not reached' : 'Deep compression result');
    showStatus(
      'success',
      title,
      report.message || 'Lossless structural compression completed and page-content streams were verified.',
      createStatusUrl(outputBlob),
      filename,
    );
  } catch (err) {
    hideProcessing();
    const msg = (err && err.message && err.message.length < 200)
      ? err.message : 'Please try again with a different file.';
    showStatus('error', isCustom ? 'Custom compression failed' : 'Deep compression failed', msg);
  } finally {
    if (cancelButton) {
      cancelButton.removeEventListener('click', onCompressionCancel);
      cancelButton.classList.add('hidden');
    }
    if (srcPdf) { try { await srcPdf.destroy(); } catch (_) {} srcPdf = null; }
    sourcePdfLib = null;
    if (processBtn) processBtn.disabled = false;
  }
}
function showStatus(type, title, message, downloadUrl, filename) {
  // Phase 7J: push error/success events into the security stream
  try {
    if (type === 'error') {
      var _p7Ss3 = window.RuntimeSecurityStream;
      if (_p7Ss3 && typeof _p7Ss3.push === 'function') {
        _p7Ss3.push('tool-status-error', 'tool-page', 'INFO',
          title, { msg: (message || '').slice(0, 120) });
      }
    }
  } catch (_) {}

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
             <i data-lucide="download"></i> ${currentTool && currentTool.id === 'rotate' ? 'Download PDF' : 'Download File'}
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
      // Cleanup is deliberately delayed so the browser has time to start the
      // download, then removes only this tool's temporary source/result state.
      try {
        if (window.ToolState && currentTool) {
          const slug = Flow.baseSlug();
          setTimeout(() => {
            try {
              if (window.ToolState.clearAfterDelivery) {
                window.ToolState.clearAfterDelivery(slug);
              } else {
                window.ToolState.clear(slug);
              }
            } catch (_) {}
          }, 5000);
        }
      } catch (_) {}
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


function renderSeoToolIdentity(tool) {
  const palette = brandedToolPalette(tool);
  const icon = escapeHtml(tool && tool.icon ? tool.icon : 'file-text');
  const name = escapeHtml(tool && tool.name ? tool.name : 'PDF Tool');
  return '<div class="seo-tool-identity" aria-label="' + name + '">' +
    '<div class="seo-tool-logo-wrap">' +
      '<span class="seo-tool-logo" style="--seo-logo-a:' + palette[0] + ';--seo-logo-b:' + palette[1] + ';--seo-logo-c:' + palette[2] + '" aria-hidden="true">' +
        '<span class="seo-logo-accent seo-logo-accent-a"></span><span class="seo-logo-accent seo-logo-accent-b"></span>' +
        '<i data-lucide="' + icon + '"></i>' +
      '</span>' +
    '</div>' +
    '<div class="seo-tool-name">' + name + '</div></div>';
}

function renderSeoFeatureVisual(icon, variant) {
  const safeIcon = escapeHtml(icon || 'file-text');
  const v = Number.isFinite(Number(variant)) ? Number(variant) : 0;
  const labels = ['INPUT', 'ADJUST', 'OUTPUT'];
  const label = labels[v % labels.length];
  return `
    <span class="seo-feature-visual" aria-hidden="true" data-visual-variant="${v % 3}">
      <span class="seo-visual-sheet">
        <span class="seo-visual-sheet-line line-a"></span>
        <span class="seo-visual-sheet-line line-b"></span>
        <span class="seo-visual-sheet-line line-c"></span>
      </span>
      <span class="seo-visual-icon"><i data-lucide="${safeIcon}"></i></span>
      <span class="seo-visual-chip">${label}</span>
      <span class="seo-visual-dot dot-a"></span>
      <span class="seo-visual-dot dot-b"></span>
    </span>`;
}



function seoLineIcon(text) {
  const value = String(text || '').toLowerCase();
  const rules = [
    // Compression use cases: prefer audience/context visuals over generic file icons.
    [/job applications?/, 'user-round-check'],
    [/marketing files?/, 'megaphone'],
    [/legal\s*&?\s*finance/, 'users-round'],
    [/email\s*&?\s*sharing/, 'send'],
    [/upload|select|drag|file/, 'upload-cloud'],
    [/preview|review|inspect|check/, 'scan-search'],
    [/compress|size|smaller|storage|attachment/, 'minimize-2'],
    [/quality|visual|image|photo|scan/, 'image'],
    [/rotate|sideways|orientation|portrait|landscape|turn/, 'rotate-cw'],
    [/merge|combine|join/, 'git-merge'],
    [/split|separate|divide|extract/, 'scissors'],
    [/convert|format|word|jpg|png|excel|powerpoint/, 'repeat-2'],
    [/protect|security|password|encrypt|safe/, 'shield-check'],
    [/unlock|locked/, 'unlock'],
    [/sign|signature/, 'pen-line'],
    [/edit|annotate|markup|text/, 'pencil-line'],
    [/watermark|stamp/, 'stamp'],
    [/crop|margin|edge|trim/, 'crop'],
    [/page|pages|document/, 'file-text'],
    [/print|printer/, 'printer'],
    [/share|send|email/, 'send'],
    [/download|output|result|finish/, 'download'],
    [/archive|store/, 'archive'],
    [/form|application/, 'clipboard-list'],
    [/invoice|receipt|finance/, 'receipt-text'],
    [/study|notes|school/, 'graduation-cap'],
    [/job|resume|portfolio|career/, 'briefcase-business'],
    [/legal|contract/, 'scale'],
  ];
  for (const [re, icon] of rules) if (re.test(value)) return icon;
  return 'circle-check';
}

function decorateSeoLineVisuals(root) {
  if (!root) return;

  const wrapCopy = (item, className) => {
    if (!item || item.querySelector('.' + className)) return;
    const copy = document.createElement('span');
    copy.className = className;
    Array.from(item.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
        if (!(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('seo-line-visual'))) {
          copy.appendChild(node);
        }
      }
    });
    item.appendChild(copy);
  };

  const add = (item, copySelector, copyClass) => {
    if (!item) return;
    const source = item.querySelector(copySelector || 'strong');
    const label = source ? source.textContent : item.textContent;
    if (!item.querySelector('.seo-line-visual')) {
      const icon = seoLineIcon(label);
      const visual = document.createElement('span');
      visual.className = 'seo-line-visual';
      visual.setAttribute('aria-hidden', 'true');
      visual.innerHTML = '<i data-lucide="' + escapeHtml(icon) + '"></i>';
      item.insertBefore(visual, item.firstChild);
    }
    item.classList.add('seo-line-item');
    wrapCopy(item, copyClass || 'seo-line-copy');
  };

  root.querySelectorAll('.seo-steps li').forEach(li => add(li, 'strong', 'seo-line-copy'));
  root.querySelectorAll('.seo-benefits li').forEach(li => add(li, 'strong', 'seo-line-copy'));
  root.querySelectorAll('.seo-usecase-grid > *').forEach(card => add(card, 'strong', 'seo-usecase-copy'));

  root.querySelectorAll('.seo-feature-card').forEach(card => {
    const heading = card.querySelector('h3');
    const visualIcon = card.querySelector('.seo-visual-icon');
    if (heading && visualIcon) {
      const icon = seoLineIcon(heading.textContent);
      visualIcon.innerHTML = '<i data-lucide="' + escapeHtml(icon) + '"></i>';
      visualIcon.setAttribute('aria-label', heading.textContent.trim());
    }
  });
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

  // Rotate gets purpose-built copy because this page is both a tool and a
  // useful landing page for people searching for PDF rotation help.
  if (tool.id === 'rotate') {
    const rotateFaq = [
      { q: 'How do I rotate a PDF page?', a: 'Upload your PDF, review the page previews, choose All, Portrait, or Landscape, then select Right or Left and click Rotate PDF.' },
      { q: 'Can I rotate only selected pages?', a: 'Yes. Use the page preview editor to work with the pages that need a different orientation before creating the final PDF.' },
      { q: 'Does rotating a PDF reduce quality?', a: 'Rotation changes the page orientation rather than re-encoding the page content, so the original text, images, and vector content are not intentionally compressed just because you rotate a page.' },
      { q: 'Can I undo a PDF rotation?', a: 'Yes. Before processing, use Reset all. After creating a file, rotate it in the opposite direction to reverse the same 90-degree change.' },
    ];

    return `
      <section class="seo-content seo-content--crop-contract seo-content--rotate" aria-labelledby="rotate-seo-heading">
        ${renderSeoToolIdentity(tool)}
        <div class="seo-intro">
          <span class="seo-kicker">PDF ROTATION TOOL</span>
          <h2 id="rotate-seo-heading">Rotate PDF Online — Free, Fast &amp; Easy</h2>
          <p><strong>Need to turn a sideways PDF page upright?</strong> This free online PDF rotator lets you rotate PDF pages to the correct orientation and create a clean file ready to read, share, or print.</p>
          <p>It is useful for scanned documents, contracts, invoices, forms, notes, and other PDFs where one or more pages appear sideways or upside down.</p>
        </div>

        <div class="seo-feature-grid">
          <article class="seo-feature-card">
            ${renderSeoFeatureVisual('scan-search', 0)}
            <span class="seo-feature-icon"><i data-lucide="scan-search"></i></span>
            <h3>See the page before you rotate</h3>
            <p>Review the actual PDF page previews so you can identify the pages that need correction.</p>
          </article>
          <article class="seo-feature-card">
            ${renderSeoFeatureVisual('rotate-cw', 1)}
            <span class="seo-feature-icon"><i data-lucide="rotate-cw"></i></span>
            <h3>Rotate right or left</h3>
            <p>Choose the direction that matches the way your page needs to turn, with separate portrait and landscape controls.</p>
          </article>
          <article class="seo-feature-card">
            ${renderSeoFeatureVisual('printer', 2)}
            <span class="seo-feature-icon"><i data-lucide="printer"></i></span>
            <h3>Ready for sharing and printing</h3>
            <p>Correct the orientation before sending the document to a client, colleague, archive, or printer.</p>
          </article>
        </div>

        <div class="seo-section-block">
          <h3>How to rotate a PDF online</h3>
          <ol class="seo-steps">
            <li><strong>Upload your PDF</strong> — select a PDF file or drag it into the upload area.</li>
            <li><strong>Check the page previews</strong> — identify pages that are sideways or upside down.</li>
            <li><strong>Choose the pages to rotate</strong> — use All, Portrait, or Landscape when you need a specific orientation.</li>
            <li><strong>Choose Right or Left</strong> — apply the direction that fixes the page orientation.</li>
            <li><strong>Rotate PDF</strong> — create the corrected PDF and download the finished file.</li>
          </ol>
        </div>

        <div class="seo-section-block">
          <h3>Why rotate a PDF?</h3>
          <ul class="seo-benefits">
            <li><strong>Fix sideways scans.</strong> Correct pages captured in the wrong orientation by scanners or mobile devices.</li>
            <li><strong>Clean up mixed documents.</strong> Make portrait and landscape pages easier to read in the same PDF.</li>
            <li><strong>Improve print readiness.</strong> Correct page orientation before printing or sending a document for review.</li>
            <li><strong>Keep the workflow simple.</strong> Preview the document first instead of guessing which direction to rotate it.</li>
          </ul>
        </div>

        <div class="seo-section-block">
          <h3>Common PDF rotation use cases</h3>
          <div class="seo-usecase-grid">
            <div><strong>Scanned contracts</strong><span>Fix individual pages that were scanned sideways.</span></div>
            <div><strong>Invoices &amp; receipts</strong><span>Make business documents easier to review and archive.</span></div>
            <div><strong>Study notes</strong><span>Correct photographed or scanned pages before sharing.</span></div>
            <div><strong>Office forms</strong><span>Standardize mixed portrait and landscape pages.</span></div>
          </div>
        </div>

        <div class="seo-section-block seo-trust-block">
          <h3>Free PDF rotation without unnecessary steps</h3>
          <p>There is no desktop software to install and no complicated PDF editor to learn. The page is designed around the task people actually came to complete: <strong>upload, inspect, rotate, and download.</strong></p>
        </div>
      </section>
      ${renderToolFaq(tool, rotateFaq)}
    `;
  }

  if (tool.id === 'compress') {
    const compressFaq = [
      { q: 'How much can a PDF be compressed?', a: 'The reduction depends on the document. Image-heavy PDFs can often shrink substantially, while text-only PDFs usually have less data to optimise.' },
      { q: 'Will compressing a PDF make it blurry?', a: 'Compression primarily optimises embedded image data. Text and vector content are not intentionally blurred by the compression step.' },
      { q: 'Which compression level should I choose?', a: 'Choose Low for maximum visual quality, Medium for a balanced result, or High when reducing file size is the main priority.' },
      { q: 'Is my original PDF changed?', a: 'No. The uploaded file is used to create a separate compressed result; your original file remains unchanged.' },
    ];

    return `
      <section class="seo-content seo-content--crop-contract seo-content--compress" aria-labelledby="compress-seo-heading">
        ${renderSeoToolIdentity(tool)}
        <div class="seo-intro">
          <span class="seo-kicker">PDF COMPRESSION TOOL</span>
          <h2 id="compress-seo-heading">Compress PDF Online — Free, Fast &amp; Simple</h2>
          <p><strong>Need to reduce a large PDF?</strong> This online PDF compressor helps shrink page data and keep the document practical to read, share, print, and store.</p>
          <p>Compress scanned documents, portfolios, brochures, invoices, reports, and other PDFs before uploading, emailing, publishing, or archiving them.</p>
        </div>

        <div class="seo-feature-grid">
          <article class="seo-feature-card">${renderSeoFeatureVisual('minimize-2', 0)}<span class="seo-feature-icon"><i data-lucide="minimize-2"></i></span><h3>Reduce file size</h3><p>Optimise PDF data so large documents take less storage and are easier to transfer.</p></article>
          <article class="seo-feature-card">${renderSeoFeatureVisual('sliders-horizontal', 1)}<span class="seo-feature-icon"><i data-lucide="sliders-horizontal"></i></span><h3>Choose the compression level</h3><p>Balance output size and visual quality with Low, Medium, or High compression.</p></article>
          <article class="seo-feature-card">${renderSeoFeatureVisual('send', 2)}<span class="seo-feature-icon"><i data-lucide="send"></i></span><h3>Prepare lighter documents</h3><p>Create a smaller PDF before sharing, uploading, printing, or storing the finished document.</p></article>
        </div>

        <div class="seo-section-block">
          <h3>How to compress a PDF online</h3>
          <ol class="seo-steps">
            <li><strong>Upload your PDF</strong> — select a PDF file or drag it into the upload area.</li>
            <li><strong>Open the compression controls</strong> — review the document before selecting a compression level.</li>
            <li><strong>Set the compression level</strong> — choose Low, Medium, or High according to the size and quality you need.</li>
            <li><strong>Review the result</strong> — check that important text, images, and page content remain suitable for your purpose.</li>
            <li><strong>Compress PDF</strong> — process the document and download the finished compressed PDF.</li>
          </ol>
        </div>

        <div class="seo-section-block">
          <h3>Why compress a PDF?</h3>
          <ul class="seo-benefits">
            <li><strong>Share files faster.</strong> Smaller PDFs are easier to upload, download, and send over slower connections.</li>
            <li><strong>Meet attachment limits.</strong> Reducing file size can help when email or application portals impose size limits.</li>
            <li><strong>Save storage space.</strong> Smaller documents use less cloud and archive storage.</li>
            <li><strong>Keep a practical balance.</strong> Select a compression level that fits the document's purpose instead of using the strongest setting every time.</li>
          </ul>
        </div>

        <div class="seo-section-block">
          <h3>Common PDF compression use cases</h3>
          <div class="seo-usecase-grid">
            <div><strong>Job applications</strong><span>Reduce portfolio or resume PDFs for portals with strict upload limits.</span></div>
            <div><strong>Marketing files</strong><span>Make brochures and downloadable PDFs lighter for website visitors.</span></div>
            <div><strong>Legal &amp; finance</strong><span>Reduce document size before archiving or moving large batches.</span></div>
            <div><strong>Email &amp; sharing</strong><span>Prepare documents for services with attachment or upload limits.</span></div>
          </div>
        </div>

        <div class="seo-section-block seo-trust-block">
          <h3>Compress PDF files without unnecessary steps</h3>
          <p>The workflow is built around a simple task: <strong>upload, choose, review, and download.</strong> You can prepare a smaller PDF without installing desktop software.</p>
        </div>
      </section>
      ${renderToolFaq(tool, compressFaq)}
    `;
  }

  // Generic SEO content for the other tools.
  const slug = TOOL_ID_TO_BLOG_SLUG[tool.id] || tool.id;
  const extra = (window.TOOL_CONTENT && window.TOOL_CONTENT[slug]) || null;

  const benefitItems = extra?.benefits || [
    { title: 'Simple workflow', body: `Complete the main ${escapeHtml(tool.name).toLowerCase()} task with a clear upload, configure, process, and download flow.` },
    { title: 'Browser-based processing', body: 'Use the configured browser processing path without installing desktop software.' },
    { title: 'Practical output', body: 'Prepare a finished document that is ready to read, share, print, or store.' },
  ];
  const featureIcons = ['sparkles', 'sliders-horizontal', 'check-circle-2'];
  const featureItems = benefitItems.slice(0, 3);

  const benefitsBlock = extra ? `
      <div class="seo-section-block">
        <h3>Why use ${escapeHtml(tool.name)}?</h3>
        <ul class="seo-benefits">
          ${extra.benefits.map(b => `<li><strong>${escapeHtml(b.title)}.</strong> ${b.body}</li>`).join('')}
        </ul>
      </div>` : '';

  const useCasesBlock = extra ? `
      <div class="seo-section-block">
        <h3>Common use cases</h3>
        <div class="seo-usecase-grid">
          ${extra.useCases.slice(0, 4).map(uc => `<div><strong>${escapeHtml(uc.audience)}</strong><span>${uc.body}</span></div>`).join('')}
        </div>
      </div>` : '';

  return `
    <section class="seo-content seo-content--crop-contract" aria-labelledby="${escapeHtml(tool.id)}-seo-heading">
      ${renderSeoToolIdentity(tool)}
        <div class="seo-intro">
        <span class="seo-kicker">${escapeHtml(tool.name).toUpperCase()} TOOL</span>
        <h2 id="${escapeHtml(tool.id)}-seo-heading">${escapeHtml(tool.name)} Online — Free, Fast &amp; Secure</h2>
        <p><strong>Need to ${escapeHtml(tool.description.charAt(0).toLowerCase() + tool.description.slice(1))}?</strong> This online tool helps you complete the task quickly and prepare a practical result.</p>
        <p>Use it for ${fileType} files when you need a straightforward browser-based workflow before sharing, printing, publishing, or archiving.</p>
      </div>

      <div class="seo-feature-grid">
        ${featureItems.map((b, i) => `<article class="seo-feature-card">${renderSeoFeatureVisual(featureIcons[i], i)}<span class="seo-feature-icon"><i data-lucide="${featureIcons[i]}"></i></span><h3>${escapeHtml(b.title)}</h3><p>${b.body}</p></article>`).join('')}
      </div>

      <div class="seo-section-block">
        <h3>How ${escapeHtml(tool.name)} works</h3>
        <ol class="seo-steps">
          <li><strong>Upload your file</strong> — select a ${fileType} file or drag it into the upload area.</li>
          <li><strong>Preview &amp; configure</strong> — review your file and adjust the available options.</li>
          <li><strong>Process</strong> — start the configured ${escapeHtml(tool.name).toLowerCase()} operation.</li>
          <li><strong>Download</strong> — download the processed result directly from your browser.</li>
        </ol>
      </div>
      ${benefitsBlock}
      ${useCasesBlock}
      <div class="seo-section-block seo-trust-block">
        <h3>${escapeHtml(tool.name)} without unnecessary steps</h3>
        <p>The workflow is built around the task you came to complete: <strong>upload, configure, process, and download.</strong> Processing follows this tool's configured browser workflow.</p>
      </div>
    </section>
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
  return `
    <div class="options-section compress-options" data-compress-options="all">
      <div class="options-title"><i data-lucide="sliders-horizontal"></i> Compression Mode</div>
      <div class="form-group">
        <label class="form-label" for="opt-compress-mode">Choose compression</label>
        <select class="form-select" id="opt-compress-mode" name="compressMode">
          <option value="" selected disabled>Choose a compression mode</option>
          <option value="deep">Deep Compression</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="compress-estimate" id="compress-estimate" aria-live="polite" hidden>
        <span class="compress-estimate-label" id="compress-estimate-label">Estimated output size</span>
        <strong id="compress-estimate-value">Calculating…</strong>
        <small id="compress-estimate-note">Approximate estimate; actual size depends on PDF content.</small>
      </div>
      <div class="form-group compress-custom-target" id="compress-custom-target" hidden>
        <label class="form-label" for="opt-compress-target">Desired output size</label>
        <div class="compress-custom-target-row">
          <input class="form-input" id="opt-compress-target" type="number"
                 min="1" step="any" inputmode="decimal" placeholder="e.g. 2.5" />
          <select class="form-select" id="opt-compress-unit" aria-label="Output size unit">
            <option value="MB" selected>MB</option>
            <option value="KB">KB</option>
          </select>
        </div>
        <small class="compress-estimate-note">Custom preserves selectable text and vector pages, keeps image-only pages at 150 DPI or higher, and adjusts measured output (up to 4 passes). Exact size cannot be guaranteed.</small>
      </div>
    </div>`;
}

function formatCompressSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}

// Wire the compression mode controls after the preview options enter the DOM.
function wireCompressOptions() {
  const mode = document.getElementById('opt-compress-mode');
  const customBox = document.getElementById('compress-custom-target');
  const estimateLabel = document.getElementById('compress-estimate-label');
  const estimateValue = document.getElementById('compress-estimate-value');
  const estimateNote = document.getElementById('compress-estimate-note');
  const targetInput = document.getElementById('opt-compress-target');
  const unitSelect = document.getElementById('opt-compress-unit');
  if (!mode || !customBox || !estimateValue) return;

  const sourceFile = selectedFiles[0] && selectedFiles[0].file;
  const sourceSize = sourceFile ? sourceFile.size : 0;
  // Raster/JPEG output varies widely with document content; show a rough
  // midpoint estimate rather than promising a precise output size.
  const estimatedDeepBytes = Math.max(1024, Math.round(sourceSize * 0.45));

  function paint() {
    const isDeep = mode.value === 'deep';
    const isCustom = mode.value === 'custom';
    // Show exactly one mode-specific control: estimate for Deep, empty target
    // input for Custom, and neither until the user chooses a mode.
    customBox.hidden = !isCustom;
    const estimateBox = document.getElementById('compress-estimate');
    if (estimateBox) estimateBox.hidden = !isDeep;
    if (targetInput) targetInput.required = isCustom;
    if (isDeep) {
      estimateValue.textContent = formatCompressSize(estimatedDeepBytes);
      if (estimateNote) estimateNote.textContent = 'Approximate only; actual size depends on PDF content and page complexity.';
    }
  }

  mode.addEventListener('change', paint);
  if (targetInput) targetInput.addEventListener('input', paint);
  if (unitSelect) unitSelect.addEventListener('change', paint);
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

  // Wire mode-dependent estimate/custom controls regardless of preview success.
  wireCompressOptions();

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

function readCompressTargetBytes(selectedMode) {
  const mode = document.getElementById('opt-compress-mode');
  const modeValue = selectedMode || (mode && mode.value);
  if (!modeValue) {
    throw new Error('Choose Deep Compression or Custom before processing.');
  }
  if (modeValue !== 'deep' && modeValue !== 'custom') {
    throw new Error('The selected compression mode is not supported.');
  }
  if (modeValue !== 'custom') return null;
  const input = document.getElementById('opt-compress-target');
  const unit = document.getElementById('opt-compress-unit');
  const value = Number(input && input.value);
  if (!input || !input.value.trim() || !Number.isFinite(value) || value <= 0) {
    throw new Error('Enter a valid desired output size.');
  }
  const multiplier = unit && unit.value === 'KB' ? 1024 : 1024 * 1024;
  const bytes = Math.round(value * multiplier);
  const sourceFile = selectedFiles[0] && selectedFiles[0].file;
  if (!Number.isSafeInteger(bytes) || bytes < 1024) {
    throw new Error('The desired output size must be at least 1 KB.');
  }
  if (sourceFile && bytes >= sourceFile.size) {
    throw new Error('Choose an output size smaller than the original PDF.');
  }
  return bytes;
}

function readCompressMode() {
  const mode = document.getElementById('opt-compress-mode');
  if (!mode || !mode.value) {
    throw new Error('Choose Deep Compression or Custom before processing.');
  }
  if (mode.value !== 'deep' && mode.value !== 'custom') {
    throw new Error('The selected compression mode is not supported. Please choose Deep Compression or Custom.');
  }
  return mode.value;
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

  // Phase 4 Unit 6: SPA navigation resolves identity exclusively from the
  // published Tool Registry. Legacy SLUG_MAP remains compatibility data only.
  const registryMeta = (window.ToolRegistry && window.ToolRegistry.isReady())
    ? (window.ToolRegistry.getBySlug(rawSlug) || window.ToolRegistry.get(rawSlug))
    : null;
  if (registryMeta && registryMeta.specialRoute) {
    window.location.href = registryMeta.specialRoute;
    return;
  }

  const toolId = registryMeta ? registryMeta.id : rawSlug;
  const legacyTool = (typeof TOOLS !== 'undefined') ? TOOLS.find(t => t.id === toolId) : null;
  const tool = (window.ToolRegistry && window.ToolRegistry.isReady())
    ? window.ToolRegistry.mergeLegacy(legacyTool)
    : legacyTool;

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
  // Activate the selected logical module without eagerly loading its processor.
  // The module registry is a boundary/contract layer; BrowserTools remains the
  // lazy execution owner for browser-capable tools.
  try {
    if (window.ToolModuleRegistry) {
      const moduleActivation = window.ToolModuleRegistry.activate(currentTool.id);
      if (!moduleActivation.ok) {
        console.warn('[ToolModuleRegistry] activation failed:', currentTool.id);
      } else if (moduleActivation.module.capability === 'unavailable') {
        console.warn('[ToolModuleRegistry] no browser processor is registered for:', currentTool.id);
      }
    }
  } catch (_) {}
  buildSidebar(currentTool.id);
  setMetaForStep(Flow.step);
  renderStep();
  try { window.scrollTo(0, 0); } catch (_) {}
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};
