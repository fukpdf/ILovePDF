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

// ── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(env, request) {
  const origin = request.headers.get('origin') || '*';
  const allowList = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allow = allowList.includes('*') || allowList.includes(origin) ? origin : allowList[0] || '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
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
      if (p === '/' || p === '/api/health') {
        return json(env, request, { ok: true, service: 'ilovepdf-queue', tools: [...QUEUED_TOOLS] });
      }
      return json(env, request, { error: 'not found' }, 404);
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
