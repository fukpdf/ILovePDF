// KV-backed job-status store. Single source of truth for the queue lifecycle.
//
// Job record shape:
//   {
//     job_id, tool, user_id, ip, file_key, file_size, file_name, content_type,
//     options, status, result_key, result_url, error, attempts,
//     created_at, updated_at
//   }

const PREFIX = 'job:';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export async function createJob(env, job) {
  const ttl = Number(env.RESULT_TTL_SECONDS || 86400);
  const record = {
    status: 'pending',
    attempts: 0,
    result_key: null,
    result_url: null,
    error: null,
    ...job,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.PDF_JOBS_KV.put(PREFIX + job.job_id, JSON.stringify(record), {
    expirationTtl: ttl,
  });
  return record;
}

export async function getJob(env, jobId) {
  const raw = await env.PDF_JOBS_KV.get(PREFIX + jobId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updateJob(env, jobId, patch) {
  const cur = (await getJob(env, jobId)) || { job_id: jobId };
  const next = isObj(patch) ? { ...cur, ...patch, updated_at: Date.now() } : cur;
  const ttl = Number(env.RESULT_TTL_SECONDS || 86400);
  await env.PDF_JOBS_KV.put(PREFIX + jobId, JSON.stringify(next), {
    expirationTtl: ttl,
  });
  return next;
}

export function newJobId() {
  // 16-byte hex id — matches utils/r2.js style.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
