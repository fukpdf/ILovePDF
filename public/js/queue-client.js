// Queue client — submits a job to the remote processing API and polls for
// completion. Wired into tool-page.js for tools listed in QUEUED_TOOL_IDS.
// UI helpers (showProcessing / hideProcessing / triggerDownload / showStatus)
// are reused so the visual experience is unchanged.
(function () {
  // Heavy tools that legitimately need the remote (Hugging Face) pipeline.
  // Browser-capable tools are NOT listed here — they run via BrowserTools
  // (see public/js/browser-tools.js) and never touch the queue.
  //
  // `compress` stays here as the optional ADVANCED fallback: BrowserTools
  // attempts a basic in-browser compression first, and only when that
  // doesn't help does the dispatcher fall through to this queue path.
  const QUEUED_TOOL_IDS = new Set([
    // Compress (advanced fallback only — browser tries basic first)
    'compress',
    // Convert (heavy)
    'ocr',
    'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
    'word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf', 'html-to-pdf',
    // Edit & annotate (heavy / server-only)
    'edit', 'sign', 'redact',
    // Advanced
    'repair', 'scan-to-pdf', 'compare', 'workflow',
    'ai-summarize', 'translate',
    // Image (AI)
    'background-remover',
  ]);

  // Neutral, user-facing message used for any processing failure.
  const NEUTRAL_ERR = 'Processing is taking longer than usual. Please wait or try again later.';

  const POLL_MS    = 1500;                  // 1.5 s — instant feedback
  const MAX_WAIT_MS = 10 * 60 * 1000;       // 10 minutes ceiling

  // Try to fetch a Firebase ID token if the user is signed in. Best-effort —
  // anonymous users still work (server falls back to IP-based guest tier).
  async function getAuthHeader() {
    try {
      if (window.firebase?.auth) {
        const u = window.firebase.auth().currentUser;
        if (u) return { Authorization: 'Bearer ' + (await u.getIdToken()) };
      }
      if (window.__getFirebaseIdToken) {
        const t = await window.__getFirebaseIdToken();
        if (t) return { Authorization: 'Bearer ' + t };
      }
    } catch (_) {}
    return {};
  }

  function isQueued(toolId) {
    return QUEUED_TOOL_IDS.has(toolId) && !!window.QUEUE_API_BASE;
  }

  async function submitJob(tool, file, options) {
    const url = window.queueUrl('/api/queue-job');
    if (!url) throw new Error(NEUTRAL_ERR);
    const fd = new FormData();
    fd.append('tool', tool.id);
    fd.append('file', file, file.name);
    Object.entries(options || {}).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) fd.append(k, v);
    });
    const headers = await getAuthHeader();
    const r = await fetch(url, { method: 'POST', body: fd, headers });
    if (r.status === 413 || r.status === 429) {
      const data = await r.json().catch(() => ({}));
      const err = new Error(data.message || 'Limit reached');
      err.code = data.error || 'LIMIT_REACHED';
      err.isAnonymous = !!data.isAnonymous;
      throw err;
    }
    if (!r.ok) throw new Error(NEUTRAL_ERR);
    return r.json();
  }

  async function pollUntilDone(jobId, onTick) {
    const start = Date.now();
    const url = window.queueUrl('/api/job-status/' + encodeURIComponent(jobId));
    let consecutiveErrors = 0;
    while (Date.now() - start < MAX_WAIT_MS) {
      try {
        const r = await fetch(url, { headers: await getAuthHeader() });
        if (r.ok) {
          consecutiveErrors = 0;
          const j = await r.json();
          if (typeof onTick === 'function') onTick(j);
          if (j.status === 'done')   return j;
          if (j.status === 'failed') throw new Error(NEUTRAL_ERR);
        } else {
          consecutiveErrors++;
        }
      } catch (e) {
        consecutiveErrors++;
        if (consecutiveErrors > 5) throw new Error(NEUTRAL_ERR);
      }
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    throw new Error(NEUTRAL_ERR);
  }

  async function fetchResultBlob(resultUrl) {
    const r = await fetch(resultUrl, { credentials: 'omit' });
    if (!r.ok) throw new Error(NEUTRAL_ERR);
    return r.blob();
  }

  // Public entry — returns true if the request was handled by the queue path,
  // false if the caller should fall back to the existing direct route.
  async function tryProcess(tool, files, options, ui) {
    if (!isQueued(tool.id)) return false;
    const file = files[0];
    if (!file) return false;

    ui.showProcessing(`Processing your file…`, 'This usually takes only a few seconds.');
    let job;
    try {
      job = await submitJob(tool, file, options);
    } catch (err) {
      ui.hideProcessing();
      if (err.code === 'LIMIT_REACHED' || err.code === 'FILE_TOO_LARGE') {
        if (typeof window.showLimitPopup === 'function') {
          window.showLimitPopup(err.message, err.isAnonymous);
        } else {
          alert(err.message);
        }
        return true;
      }
      ui.showStatus('error', 'Please try again', NEUTRAL_ERR);
      return true;
    }

    ui.showProcessing(`Processing your file…`, 'Almost done — this page will update when your file is ready.');
    let final;
    try {
      final = await pollUntilDone(job.job_id, (j) => {
        if (j.status === 'processing') {
          ui.showProcessing(`Processing your file…`, 'Almost done — hang tight.');
        }
      });
    } catch (err) {
      ui.hideProcessing();
      ui.showStatus('error', 'Please try again', NEUTRAL_ERR);
      return true;
    }

    try {
      const blob = await fetchResultBlob(final.result_url);
      const filename = final.result_name || ('ILovePDF-' + (file.name || 'file'));
      ui.hideProcessing();
      ui.triggerDownload(blob, filename);
      if (window.UsageLimit) window.UsageLimit.record(1);
      ui.showStatus('success', 'Your file is ready',
        `Press the button if download does not start automatically.`,
        URL.createObjectURL(blob), filename);
    } catch (err) {
      ui.hideProcessing();
      ui.showStatus('error', 'Please try again', NEUTRAL_ERR);
    }
    return true;
  }

  window.QueueClient = { tryProcess, isQueued, QUEUED_TOOL_IDS };
})();
