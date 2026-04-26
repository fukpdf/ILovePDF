// Queue client — submits a job to the Cloudflare Worker queue API and polls
// for completion. Wired into tool-page.js for tools listed in QUEUED_TOOL_IDS.
// UI helpers (showProcessing / hideProcessing / triggerDownload / showStatus)
// are reused as-is so the visual experience is unchanged.
(function () {
  // Tools that go through the Cloudflare queue. MUST stay in sync with
  // cloudflare/worker/src/processors.js → QUEUED_TOOLS.
  const QUEUED_TOOL_IDS = new Set([
    'compress',
    'ocr',
    'pdf-to-word',
    'pdf-to-excel',
    'pdf-to-powerpoint',
    'word-to-pdf',
    'excel-to-pdf',
    'powerpoint-to-pdf',
    'ai-summarize',
    'translate',
    'background-remover',
    'resize-image',
    'image-filters',
    'compare',
  ]);

  const POLL_MS    = 3000;
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes ceiling

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
    if (!url) throw new Error('queue api not configured');
    const fd = new FormData();
    fd.append('tool', tool.id);
    fd.append('file', file, file.name);
    Object.entries(options || {}).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) fd.append(k, v);
    });
    const headers = await getAuthHeader();
    const t0 = performance.now();
    console.log('[queue] POST', url, '| tool=', tool.id, '| size=', file.size, '| auth=', !!headers.Authorization);
    const r = await fetch(url, { method: 'POST', body: fd, headers });
    console.log('[queue] response', r.status, '(', Math.round(performance.now() - t0), 'ms )');
    if (r.status === 413 || r.status === 429) {
      const data = await r.json().catch(() => ({}));
      const err = new Error(data.message || 'Limit reached');
      err.code = data.error || 'LIMIT_REACHED';
      err.isAnonymous = !!data.isAnonymous;
      throw err;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(data.error || 'queue submit failed');
    }
    return r.json();
  }

  async function pollUntilDone(jobId, onTick) {
    const start = Date.now();
    const url = window.queueUrl('/api/job-status/' + encodeURIComponent(jobId));
    let consecutiveErrors = 0;
    let lastStatus = null;
    console.log('[queue] polling', jobId, 'every', POLL_MS, 'ms');
    while (Date.now() - start < MAX_WAIT_MS) {
      try {
        const r = await fetch(url, { headers: await getAuthHeader() });
        if (r.ok) {
          consecutiveErrors = 0;
          const j = await r.json();
          if (j.status !== lastStatus) {
            console.log('[queue]', jobId, 'status →', j.status, '(', Math.round((Date.now() - start) / 1000), 's )');
            lastStatus = j.status;
          }
          if (typeof onTick === 'function') onTick(j);
          if (j.status === 'done')   { console.log('[queue]', jobId, 'done. result_url=', j.result_url); return j; }
          if (j.status === 'failed') throw new Error(j.error || 'processing failed');
        } else {
          console.warn('[queue] poll', jobId, '→', r.status);
          consecutiveErrors++;
        }
      } catch (e) {
        console.warn('[queue] poll error', jobId, e?.message || e);
        consecutiveErrors++;
        if (consecutiveErrors > 5) throw e;
      }
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    throw new Error('Timed out waiting for the job to finish.');
  }

  async function fetchResultBlob(resultUrl) {
    const r = await fetch(resultUrl, { credentials: 'omit' });
    if (!r.ok) throw new Error('Could not download result (' + r.status + ')');
    return r.blob();
  }

  // Public entry — returns true if the request was handled by the queue path,
  // false if the caller should fall back to the existing direct route.
  async function tryProcess(tool, files, options, ui) {
    if (!isQueued(tool.id)) return false;
    const file = files[0];
    if (!file) return false;

    ui.showProcessing(`Queuing ${tool.name}…`, 'Uploading your file to secure storage…');
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
      ui.showStatus('error', 'Queue error', err.message || 'Could not submit to the queue.');
      return true;
    }

    ui.showProcessing(`Processing ${tool.name}…`, 'Your job is running on a worker. This page will update when it’s ready.');
    let final;
    try {
      final = await pollUntilDone(job.job_id, (j) => {
        if (j.status === 'processing') {
          ui.showProcessing(`Processing ${tool.name}…`, 'Worker is converting your file. Hang tight.');
        }
      });
    } catch (err) {
      ui.hideProcessing();
      ui.showStatus('error', 'Processing failed', err.message || 'The job failed. Please try again.');
      return true;
    }

    try {
      const blob = await fetchResultBlob(final.result_url);
      const filename = final.result_name || ('ILovePDF-' + (file.name || 'file'));
      ui.hideProcessing();
      ui.triggerDownload(blob, filename);
      if (window.UsageLimit) window.UsageLimit.record(1);
      ui.showStatus('success', 'File ready!',
        `Your file downloaded as <code>${filename.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</code>.`,
        URL.createObjectURL(blob), filename);
    } catch (err) {
      ui.hideProcessing();
      ui.showStatus('error', 'Download failed', err.message || 'Could not download the result.');
    }
    return true;
  }

  window.QueueClient = { tryProcess, isQueued, QUEUED_TOOL_IDS };
})();
