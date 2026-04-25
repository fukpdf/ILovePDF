// Thin R2 helpers used by both the producer (upload incoming file) and
// consumer (download input, save processed result).

const sanitize = (n) =>
  String(n || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

export async function putTempObject(env, body, originalName, contentType) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const key = `tmp/${Date.now()}_${id}_${sanitize(originalName)}`;
  await env.PDF_BUCKET.put(key, body, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });
  return key;
}

export async function putResultObject(env, body, originalName, ext, contentType) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const base = sanitize(originalName).replace(/\.[^.]+$/, '');
  const key = `results/${Date.now()}_${id}_${base}${ext}`;
  await env.PDF_BUCKET.put(key, body, {
    httpMetadata: {
      contentType: contentType || 'application/octet-stream',
      contentDisposition: `attachment; filename="ILovePDF-${base}${ext}"`,
    },
  });
  return key;
}

export async function getObjectBytes(env, key) {
  const obj = await env.PDF_BUCKET.get(key);
  if (!obj) throw new Error(`R2 object not found: ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
}

// Build a download URL for the result. Prefers a public R2 base if the user
// has fronted their bucket with a custom domain; otherwise falls back to a
// streaming endpoint exposed by this Worker (/api/job-file/:key).
export function buildResultUrl(env, request, key) {
  const base = (env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  const url = new URL(request.url);
  return `${url.origin}/api/job-file/${encodeURIComponent(key)}`;
}
