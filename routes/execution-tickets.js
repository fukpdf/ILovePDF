// routes/execution-tickets.js — Phase 6 Hybrid Execution Layer
// =============================================================================
// Issues short-lived HMAC-signed execution tickets to authenticated browsers.
// Tickets grant permission for premium/sensitive operations without exposing
// server-side auth logic to the client.
//
// Flow:
//   1. Browser POSTs /api/execution-ticket with { fingerprint, sessionId, ops }
//   2. Server validates rate limit + origin guard, then issues a signed ticket
//   3. Ticket payload: { sessionId, fingerprint, ops, iat, exp, nonce }
//   4. Signature: HMAC-SHA256(payload, SECRET).slice(0,32)
//   5. Ticket is valid for 90 seconds, single-use (nonce pool)
//   6. Browser-side runtime-hybrid-execution.js holds ticket in memory only
//
// Routes:
//   POST /api/execution-ticket          — issue ticket
//   POST /api/execution-ticket/verify   — verify ticket (optional server check)
//   GET  /api/execution-ticket/ping     — health probe
// =============================================================================

import { Router }  from 'express';
import rateLimit   from 'express-rate-limit';
import crypto      from 'crypto';

const router = Router();

const SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
const TICKET_TTL_MS   = 90_000;   // 90 seconds
const NONCE_POOL_SIZE = 5_000;    // replay protection pool
const MAX_OPS_PER_TICKET = 8;

// ── Nonce pool (in-process replay protection) ─────────────────────────────────
// In a multi-replica setup this should be a Redis set; for single-instance
// Replit deployment an in-memory bounded Set is sufficient.
const _usedNonces = new Set();
const _nonceTimes = [];   // [{nonce, exp}] for TTL eviction

function _trackNonce(nonce, exp) {
  _usedNonces.add(nonce);
  _nonceTimes.push({ nonce, exp });
}

function _evictExpiredNonces() {
  const now = Date.now();
  while (_nonceTimes.length > 0 && _nonceTimes[0].exp < now) {
    const entry = _nonceTimes.shift();
    _usedNonces.delete(entry.nonce);
  }
  if (_usedNonces.size > NONCE_POOL_SIZE) {
    // Emergency eviction — remove oldest 500
    const oldest = _nonceTimes.splice(0, 500);
    for (const e of oldest) _usedNonces.delete(e.nonce);
  }
}

setInterval(_evictExpiredNonces, 30_000);

// ── HMAC helpers ──────────────────────────────────────────────────────────────
function _sign(payload) {
  return crypto.createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 48);
}

function _verifySignature(payload, sig) {
  const expected = _sign(payload);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// ── Input sanitization ────────────────────────────────────────────────────────
const ALLOWED_OPS = new Set([
  'pdf-merge', 'pdf-split', 'pdf-compress', 'pdf-convert', 'pdf-ocr',
  'pdf-rotate', 'pdf-watermark', 'pdf-protect', 'pdf-unlock',
  'pdf-repair', 'pdf-sign', 'pdf-compare', 'pdf-ai-summarize',
  'image-compress', 'image-resize', 'image-crop', 'image-filter',
  'image-bg-remove', 'word-to-pdf', 'excel-to-pdf', 'ppt-to-pdf',
  'premium-exec', 'worker-spawn', 'wasm-load',
]);

function _sanitizeOps(raw) {
  if (!Array.isArray(raw)) return ['premium-exec'];
  return raw
    .filter(op => typeof op === 'string' && ALLOWED_OPS.has(op))
    .slice(0, MAX_OPS_PER_TICKET);
}

function _sanitizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function _sanitizeFingerprint(raw) {
  if (typeof raw !== 'object' || !raw) return {};
  const safe = {};
  const allowed = ['hash', 'tier', 'score', 'ua', 'lang', 'tz', 'colorDepth'];
  for (const k of allowed) {
    if (raw[k] !== undefined) {
      safe[k] = String(raw[k]).slice(0, 128);
    }
  }
  return safe;
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const ticketLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,   // 20 tickets per IP per minute — enough for normal use
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ticket requests. Please wait.' },
});

// ── POST /api/execution-ticket ────────────────────────────────────────────────
router.post('/execution-ticket', ticketLimiter, (req, res) => {
  try {
    const { sessionId: rawSession, fingerprint: rawFp, ops: rawOps } = req.body || {};

    const sessionId   = _sanitizeSessionId(rawSession) || ('anon_' + Date.now());
    const fingerprint = _sanitizeFingerprint(rawFp);
    const ops         = _sanitizeOps(rawOps);

    const now    = Date.now();
    const nonce  = crypto.randomBytes(16).toString('hex');
    const exp    = now + TICKET_TTL_MS;

    const payload = {
      sessionId,
      fingerprint,
      ops,
      iat: now,
      exp,
      nonce,
      v: 1,
    };

    const sig = _sign(payload);

    _trackNonce(nonce, exp);

    // IP hash (privacy-safe — no raw IPs stored)
    const ipHash = crypto.createHash('sha256')
      .update((req.ip || '') + SECRET)
      .digest('hex')
      .slice(0, 12);

    console.debug('[ExecTicket] issued | session:', sessionId.slice(0, 8),
      '| ops:', ops.join(','), '| exp:', new Date(exp).toISOString());

    return res.json({
      ok:        true,
      ticket:    payload,
      sig,
      ipHash,
      serverTs:  now,
    });
  } catch (err) {
    console.error('[ExecTicket] issue error:', err.message);
    return res.status(500).json({ error: 'ticket issuance failed' });
  }
});

// ── POST /api/execution-ticket/verify ────────────────────────────────────────
router.post('/execution-ticket/verify', ticketLimiter, (req, res) => {
  try {
    const { ticket, sig } = req.body || {};

    if (!ticket || !sig || typeof ticket !== 'object') {
      return res.status(400).json({ ok: false, reason: 'missing-ticket' });
    }

    // Expiry check
    const now = Date.now();
    if (!ticket.exp || ticket.exp < now) {
      return res.status(401).json({ ok: false, reason: 'expired', serverTs: now });
    }

    // Nonce replay check
    if (!ticket.nonce || !_usedNonces.has(ticket.nonce)) {
      return res.status(401).json({ ok: false, reason: 'invalid-nonce' });
    }

    // Signature check
    if (!_verifySignature(ticket, sig)) {
      return res.status(401).json({ ok: false, reason: 'invalid-signature' });
    }

    // Consume nonce (single-use)
    _usedNonces.delete(ticket.nonce);

    return res.json({ ok: true, sessionId: ticket.sessionId, ops: ticket.ops, serverTs: now });
  } catch (err) {
    console.error('[ExecTicket] verify error:', err.message);
    return res.status(500).json({ ok: false, reason: 'verify-error' });
  }
});

// ── GET /api/execution-ticket/ping ────────────────────────────────────────────
router.get('/execution-ticket/ping', (req, res) => {
  res.json({
    ok:        true,
    serverTs:  Date.now(),
    poolSize:  _usedNonces.size,
    ttl:       TICKET_TTL_MS,
    version:   'p6.1.0',
  });
});

export default router;
