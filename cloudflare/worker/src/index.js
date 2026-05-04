// ILovePDF queue Worker — single deployment that acts as:
//   • Producer:  POST /api/queue-job              → enqueue
//                GET  /api/job-status/:job_id     → poll
//                GET  /api/job-file/:key          → stream R2 result (fallback if no public R2 URL)
//   • Consumer:  queue() handler processes jobs, writes results back to R2,
//                updates KV with status + result URL.
//
// Direct tools (Merge/Split/Rotate/Organize/JPG↔PDF/Page Numbers/Watermark)
// are NOT routed through here — they keep talking to the existing Express
// backend, unchanged.

import { createJob, getJob, updateJob, newJobId } from './jobs.js';
import { putTempObject, putResultObject, buildResultUrl, getObjectBytes } from './r2.js';
import { identify } from './auth.js';
import { checkAndConsume, LIMITS } from './limits.js';
import { process as processJob, QUEUED_TOOLS } from './processors.js';
import { handleAdmin } from './admin.js';

// ── CORS ─────────────────────────────────────────────────────────────────────
// Always permissive: ILovePDF is a public tool surface — same-origin and
// cross-origin browsers (incl. Firebase Hosting + Replit dev preview) all
// need to talk to the queue. ALLOWED_ORIGINS may pin one origin in prod;
// otherwise we mirror the request origin (or `*` when none was sent).
function corsHeaders(env, request) {
  const origin = request.headers.get('origin') || '';
  const list   = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const wildcard = list.includes('*') || list.length === 0;
  let allow;
  if (wildcard) {
    allow = origin || '*';
  } else if (origin && list.includes(origin)) {
    allow = origin;
  } else {
    allow = list[0];
  }
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-requested-with',
    'access-control-expose-headers': 'content-disposition,content-type',
    'access-control-allow-credentials': allow === '*' ? 'false' : 'true',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

// Retained for backward compatibility with any consumers that import it.
// HuggingFace is no longer used in active processing paths — all AI tasks
// are handled browser-side (extractive summarize, MyMemory translate) or
// by the Express backend on Cloud Run.
export function readHfToken(env) {
  return (env && (env.HF_API_TOKEN || env.HF_TOKEN || env.HUGGINGFACE_API_TOKEN || env.HUGGING_FACE_TOKEN)) || '';
}

const json = (env, request, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env, request) },
  });

// ── Producer: POST /api/queue-job ────────────────────────────────────────────
async function handleQueueJob(request, env) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) {
    return json(env, request, { error: 'multipart/form-data required' }, 400);
  }

  const form = await request.formData();
  const tool = String(form.get('tool') || '').trim();
  if (!QUEUED_TOOLS.has(tool)) {
    return json(env, request, { error: `tool not queue-eligible: ${tool}` }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json(env, request, { error: 'file is required' }, 400);
  }

  const identity = await identify(request, env);
  const buf = new Uint8Array(await file.arrayBuffer());
  const fileSize = buf.byteLength;

  const limit = await checkAndConsume(env, identity, fileSize);
  if (!limit.ok) {
    return json(env, request, {
      error: limit.code,
      message: limit.message,
      isAnonymous: identity.kind === 'guest',
    }, limit.code === 'FILE_TOO_LARGE' ? 413 : 429);
  }

  // Collect non-file form fields as the per-tool options blob.
  const options = {};
  for (const [k, v] of form.entries()) {
    if (k === 'file' || k === 'tool') continue;
    if (typeof v === 'string') options[k] = v;
  }

  // Stash the input in R2 (tmp/ prefix → existing 10-min sweeper cleans it).
  const fileKey = await putTempObject(env, buf, file.name, file.type);

  const jobId = newJobId();
  const record = await createJob(env, {
    job_id: jobId,
    tool,
    user_id: identity.user_id,
    ip: identity.ip,
    file_key: fileKey,
    file_name: file.name || 'input',
    file_size: fileSize,
    content_type: file.type || 'application/octet-stream',
    options,
  });

  await env.PDF_QUEUE.send(record);

  // Tell the client whether direct-route would have been faster (small files).
  const skipBytes = Number(env.SKIP_QUEUE_BYTES || 0);
  return json(env, request, {
    job_id: jobId,
    status: 'pending',
    poll_url: `/api/job-status/${jobId}`,
    direct_eligible: skipBytes > 0 && fileSize <= skipBytes,
  }, 202);
}

// ── Producer: GET /api/job-status/:job_id ────────────────────────────────────
async function handleJobStatus(request, env, jobId) {
  const job = await getJob(env, jobId);
  if (!job) return json(env, request, { error: 'job not found' }, 404);
  const out = {
    job_id: job.job_id,
    tool: job.tool,
    status: job.status,
    attempts: job.attempts,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
  if (job.status === 'done') {
    let url = job.result_url || '';
    if (url.startsWith('RELATIVE:')) {
      const u = new URL(request.url);
      url = `${u.origin}${url.slice('RELATIVE:'.length)}`;
    }
    out.result_url = url;
    out.result_name = job.result_name || null;
    out.result_mime = job.result_mime || null;
  }
  if (job.status === 'failed') out.error = job.error || 'processing failed';
  return json(env, request, out);
}

// ── Producer: GET /api/job-file/:key — streams R2 result if no public URL ───
async function handleJobFile(request, env, key) {
  const obj = await env.R2.get(key);
  if (!obj) return json(env, request, { error: 'not found' }, 404);
  const headers = new Headers(corsHeaders(env, request));
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, max-age=300');
  return new Response(obj.body, { headers });
}

// ── GET /api/health — service diagnostics (R2 + HF + queue + KV) ────────────
async function handleHealth(request, env) {
  const r2_bound  = !!env.R2;
  const kv_bound  = !!env.PDF_STATUS;
  const q_bound   = !!env.PDF_QUEUE;
  const hf_url    = env.HF_SPACE_URL || null;
  const hf_token  = !!readHfToken(env);
  const fb_proj   = env.FIREBASE_PROJECT_ID || null;

  // Best-effort R2 reachability check (HEAD on a bogus key is enough — R2
  // returns null without throwing, which proves the binding works).
  let r2_reachable = null;
  if (r2_bound) {
    try { await env.R2.head('__healthcheck__'); r2_reachable = true; }
    catch (e) { r2_reachable = false; }
  }

  // Best-effort HF Space ping (quick HEAD; treat any non-5xx as "up").
  let hf_reachable = null;
  if (hf_url) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(hf_url, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(t);
      hf_reachable = r.status < 500;
    } catch { hf_reachable = false; }
  }

  // Health is green when the core queue infrastructure is present.
  // HuggingFace is informational only — not required for operation.
  const ok = r2_bound && kv_bound && q_bound;
  return json(env, request, {
    ok,
    service: 'ilovepdf-queue',
    services: {
      r2:        { bound: r2_bound, reachable: r2_reachable },
      kv:        { bound: kv_bound },
      queue:     { bound: q_bound },
      hf:        { configured: !!hf_url, token: hf_token, reachable: hf_reachable, url: hf_url, note: 'not used for processing' },
      firebase:  { project_id: fb_proj },
      backend:   { cloud_run_url: env.BACKEND_URL || null },
    },
    tools: [...QUEUED_TOOLS],
  });
}

// ── Producer: GET /api/limits — surface tier caps to the UI (read-only) ─────
async function handleLimits(request, env) {
  const id = await identify(request, env);
  const tier = id.plan || (id.user_id ? 'free' : 'guest');
  const cap = LIMITS[tier] || LIMITS.guest;
  return json(env, request, {
    tier,
    files_per_day: cap.files === Infinity ? null : cap.files,
    bytes_per_file: cap.perFile,
  });
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === '/api/queue-job' && request.method === 'POST') {
        return await handleQueueJob(request, env);
      }
      if (p.startsWith('/api/job-status/') && request.method === 'GET') {
        return await handleJobStatus(request, env, decodeURIComponent(p.slice('/api/job-status/'.length)));
      }
      if (p.startsWith('/api/job-file/') && request.method === 'GET') {
        return await handleJobFile(request, env, decodeURIComponent(p.slice('/api/job-file/'.length)));
      }
      if (p === '/api/limits' && request.method === 'GET') {
        return await handleLimits(request, env);
      }
      if (p.startsWith('/api/admin/')) {
        const jsonOut = (body, status = 200) => json(env, request, body, status);
        const adminResp = await handleAdmin(request, env, p, jsonOut);
        if (adminResp) return adminResp;
      }
      if (p === '/api/health') {
        return await handleHealth(request, env);
      }
      // Proxy unmatched /api/* requests to Cloud Run (or any BACKEND_URL).
      // Set BACKEND_URL in wrangler.toml / dashboard secrets to activate.
      if (p.startsWith('/api/') && env.BACKEND_URL) {
        const backendBase = env.BACKEND_URL.replace(/\/$/, '');
        const target      = backendBase + p + url.search;
        const proxied     = new Request(target, {
          method:  request.method,
          headers: request.headers,
          body:    (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
          redirect: 'follow',
        });
        try {
          const resp    = await fetch(proxied);
          const headers = new Headers(resp.headers);
          Object.entries(corsHeaders(env, request)).forEach(([k, v]) => headers.set(k, v));
          return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
        } catch (proxyErr) {
          console.error('[proxy] backend request failed:', proxyErr.message);
          return json(env, request, { error: 'backend unreachable', detail: proxyErr.message }, 502);
        }
      }

      // Not an API route — pass through to Firebase Hosting so its SPA
      // rewrites serve the correct index.html / tool.html shell.
      return fetch(request);
    } catch (e) {
      console.error('[fetch] unhandled:', e?.stack || e?.message || e);
      return json(env, request, { error: 'internal error' }, 500);
    }
  },

  // ── Consumer: drains the pdf-jobs queue ───────────────────────────────────
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      const job = msg.body;
      const jobId = job?.job_id;
      if (!jobId) { msg.ack(); continue; }

      try {
        const cur = await getJob(env, jobId);
        if (!cur) { msg.ack(); continue; }              // expired or deleted
        if (cur.status === 'done') { msg.ack(); continue; }

        await updateJob(env, jobId, {
          status: 'processing',
          attempts: (cur.attempts || 0) + 1,
        });

        const result = await processJob(env, { ...cur, ...job });

        const resultKey = await putResultObject(
          env, result.bytes, cur.file_name, result.ext, result.mime,
        );
        const resultUrl = buildResultUrl(env, new Request('https://placeholder/'), resultKey);

        // We can't build the canonical URL here (no request) unless R2 has a
        // public base. If it doesn't, the client polls via /api/job-status/
        // and gets a server-side absolute URL constructed at poll time.
        await updateJob(env, jobId, {
          status: 'done',
          result_key: resultKey,
          result_url: env.R2_PUBLIC_BASE_URL ? resultUrl : `RELATIVE:/api/job-file/${encodeURIComponent(resultKey)}`,
          result_name: `ILovePDF-${(cur.file_name || 'file').replace(/\.[^.]+$/, '')}${result.ext}`,
          result_mime: result.mime,
          error: null,
        });
        msg.ack();
      } catch (err) {
        const reason = err?.message || String(err);
        console.error(`[queue] job ${jobId} failed:`, reason);
        const cur = await getJob(env, jobId);
        const attempts = (cur?.attempts || 0);
        // Cloudflare auto-retries up to max_retries (wrangler.toml). Only
        // mark as terminal failure once retries are exhausted.
        if (attempts >= 3) {
          await updateJob(env, jobId, { status: 'failed', error: reason });
          msg.ack();
        } else {
          msg.retry({ delaySeconds: Math.min(60, 5 * attempts) });
        }
      }
    }
  },
};
