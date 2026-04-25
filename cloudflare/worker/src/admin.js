// Admin endpoints — password-protected stats + recent jobs view.
//
// Authentication is stateless: HMAC-SHA256(expiry, ADMIN_PASSWORD) → bearer
// token. No KV writes for sessions, no third-party deps. Tokens are valid
// for 12 hours.
//
// Endpoints:
//   POST /api/admin/login     { password } -> { token, expires_at }
//   GET  /api/admin/stats     (Bearer)     -> { totals, by_status, by_tool, ... }
//   GET  /api/admin/jobs      (Bearer)     -> { jobs: [...] }   (last 20 by default)

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;       // 12 hours
const PREFIX       = 'job:';
const enc          = new TextEncoder();
const dec          = new TextDecoder();

// ── crypto helpers ──────────────────────────────────────────────────────────
function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const s = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ── token issue / verify ───────────────────────────────────────────────────
async function issueToken(env) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = String(exp);
  const key = await hmacKey(env.ADMIN_PASSWORD);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  return { token: `${b64uEncode(enc.encode(payload))}.${b64uEncode(sig)}`, expires_at: exp };
}

async function verifyToken(env, token) {
  if (!token || !env.ADMIN_PASSWORD) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64     = token.slice(dot + 1);
  let payloadBytes, sigBytes;
  try {
    payloadBytes = b64uDecode(payloadB64);
    sigBytes     = b64uDecode(sigB64);
  } catch { return false; }
  const payload = dec.decode(payloadBytes);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const key = await hmacKey(env.ADMIN_PASSWORD);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  return timingSafeEqual(expected, sigBytes);
}

function getBearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return { ok: false, code: 503, msg: 'ADMIN_PASSWORD not set on Worker' };
  }
  const ok = await verifyToken(env, getBearer(request));
  if (!ok) return { ok: false, code: 401, msg: 'unauthorized' };
  return { ok: true };
}

// ── KV helpers — list job metadata cheaply (no per-key reads) ──────────────
// Returns up to `cap` entries: [{ id, ts, cts, status, tool, size, name, expiration }]
async function listJobMeta(env, cap = 1000) {
  const out = [];
  let cursor;
  let pages = 0;
  do {
    const page = await env.PDF_STATUS.list({
      prefix: PREFIX,
      limit: 1000,
      cursor,
    });
    for (const k of page.keys) {
      const m = k.metadata || {};
      out.push({
        id:         k.name.slice(PREFIX.length),
        ts:         Number(m.ts || 0),
        cts:        Number(m.cts || m.ts || 0),
        status:     m.status || 'unknown',
        tool:       m.tool   || '',
        size:       Number(m.size || 0),
        name:       m.name   || '',
        expiration: k.expiration || null,
      });
      if (out.length >= cap) return out;
    }
    cursor = page.list_complete ? null : page.cursor;
    pages++;
  } while (cursor && pages < 5);
  return out;
}

// ── handlers ───────────────────────────────────────────────────────────────
async function handleLogin(request, env, json) {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: 'ADMIN_PASSWORD not set on Worker' }, 503);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const supplied = String(body.password || '');
  if (!supplied) return json({ error: 'password required' }, 400);

  // Constant-time compare against the configured password.
  const a = enc.encode(supplied);
  const b = enc.encode(env.ADMIN_PASSWORD);
  if (!timingSafeEqual(a, b)) return json({ error: 'invalid password' }, 401);

  const t = await issueToken(env);
  return json({ token: t.token, expires_at: t.expires_at });
}

async function handleStats(request, env, json) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.msg }, auth.code);

  const meta = await listJobMeta(env, 5000);
  const now  = Date.now();
  const day  = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;

  const byStatus = {};
  const byTool   = {};
  let last24   = 0, last1h = 0;
  let bytes24  = 0, bytesAll = 0;
  for (const j of meta) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    if (j.tool) byTool[j.tool] = (byTool[j.tool] || 0) + 1;
    bytesAll += j.size;
    if (j.cts && now - j.cts < day)  { last24 += 1; bytes24 += j.size; }
    if (j.cts && now - j.cts < hour) { last1h += 1; }
  }

  return json({
    totals: {
      jobs_indexed: meta.length,
      last_24h:     last24,
      last_1h:      last1h,
      bytes_24h:    bytes24,
      bytes_all:    bytesAll,
    },
    by_status: byStatus,
    by_tool:   byTool,
    generated_at: now,
  });
}

async function handleJobs(request, env, json) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ error: auth.msg }, auth.code);

  const url   = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const status = url.searchParams.get('status') || '';

  const meta = await listJobMeta(env, 2000);
  const filtered = status ? meta.filter(m => m.status === status) : meta;
  filtered.sort((a, b) => (b.cts || b.ts) - (a.cts || a.ts));
  const top = filtered.slice(0, limit);

  // Hydrate the top N with a couple of useful fields the metadata doesn't
  // carry (attempts, error message). One read per shown row.
  const hydrated = await Promise.all(top.map(async (m) => {
    const raw = await env.PDF_STATUS.get(PREFIX + m.id);
    let extra = {};
    if (raw) {
      try {
        const j = JSON.parse(raw);
        extra = {
          attempts: j.attempts || 0,
          error:    j.error || null,
          file_name: j.file_name || m.name,
          result_name: j.result_name || null,
          ip:       (j.ip || '').slice(0, 32),
          user_id:  j.user_id || null,
        };
      } catch {}
    }
    return { ...m, ...extra };
  }));

  return json({ jobs: hydrated, total_indexed: meta.length });
}

export async function handleAdmin(request, env, p, json) {
  if (p === '/api/admin/login' && request.method === 'POST') {
    return handleLogin(request, env, json);
  }
  if (p === '/api/admin/stats' && request.method === 'GET') {
    return handleStats(request, env, json);
  }
  if (p === '/api/admin/jobs' && request.method === 'GET') {
    return handleJobs(request, env, json);
  }
  return null;       // not an admin route
}
