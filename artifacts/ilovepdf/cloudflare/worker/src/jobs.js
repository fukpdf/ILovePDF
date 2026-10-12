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

// We attach a small metadata blob to every KV write so the admin dashboard
// can render stats and the recent-jobs list with a single list() call,
// avoiding 1 + N round-trips for a 1,000-job index.
function jobMetadata(record) {
  return {
    ts:     record.updated_at || record.created_at || Date.now(),
    cts:    record.created_at || Date.now(),
    status: record.status || 'pending',
    tool:   record.tool || '',
    size:   Number(record.file_size || 0),
    name:   String(record.file_name || '').slice(0, 80),
  };
}

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
  await env.PDF_STATUS.put(PREFIX + job.job_id, JSON.stringify(record), {
    expirationTtl: ttl,
    metadata: jobMetadata(record),
  });
  return record;
}

export async function getJob(env, jobId) {
  const raw = await env.PDF_STATUS.get(PREFIX + jobId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updateJob(env, jobId, patch) {
  const cur = (await getJob(env, jobId)) || { job_id: jobId };
  const next = isObj(patch) ? { ...cur, ...patch, updated_at: Date.now() } : cur;
  const ttl = Number(env.RESULT_TTL_SECONDS || 86400);
  await env.PDF_STATUS.put(PREFIX + jobId, JSON.stringify(next), {
    expirationTtl: ttl,
    metadata: jobMetadata(next),
  });
  return next;
}

export function newJobId() {
  // 16-byte hex id — matches utils/r2.js style.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
