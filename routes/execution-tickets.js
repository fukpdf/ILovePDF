import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET as SECRET } from '../utils/secret.js';

const router = Router();
const COOKIE = 'ilovepdf_token';
const TICKET_TTL_MS = 90_000;
const NONCE_POOL_SIZE = 5_000;
const MAX_OPS_PER_TICKET = 8;
const usedNonces = new Set();
const nonceTimes = [];

function trackNonce(nonce, exp) { usedNonces.add(nonce); nonceTimes.push({ nonce, exp }); }
function evictExpiredNonces() {
  const now = Date.now();
  while (nonceTimes.length && nonceTimes[0].exp < now) {
    usedNonces.delete(nonceTimes.shift().nonce);
  }
  while (usedNonces.size > NONCE_POOL_SIZE) {
    const entry = nonceTimes.shift();
    if (!entry) break;
    usedNonces.delete(entry.nonce);
  }
}
setInterval(evictExpiredNonces, 30_000);

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex').slice(0, 48);
}
function verifySignature(payload, sig) {
  if (typeof sig !== 'string' || !/^[a-f0-9]{48}$/.test(sig)) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)));
}
function authenticatedUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, SECRET); } catch { return null; }
}
function requireAuth(req, res, next) {
  const user = authenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: 'Authentication required.' });
  req.ticketUser = user;
  next();
}

const ALLOWED_OPS = new Set([
  'pdf-merge','pdf-split','pdf-compress','pdf-convert','pdf-ocr','pdf-rotate','pdf-watermark','pdf-protect','pdf-unlock',
  'pdf-repair','pdf-sign','pdf-compare','pdf-ai-summarize','image-compress','image-resize','image-crop','image-filter',
  'image-bg-remove','word-to-pdf','excel-to-pdf','ppt-to-pdf','premium-exec','worker-spawn','wasm-load',
]);
function sanitizeOps(raw) {
  if (!Array.isArray(raw)) return ['premium-exec'];
  return raw.filter(op => typeof op === 'string' && ALLOWED_OPS.has(op)).slice(0, MAX_OPS_PER_TICKET);
}
function sanitizeSessionId(raw) {
  if (typeof raw !== 'string') return null;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}
function sanitizeFingerprint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safe = {};
  for (const k of ['hash','tier','score','ua','lang','tz','colorDepth']) {
    if (raw[k] !== undefined) safe[k] = String(raw[k]).slice(0, 128);
  }
  return safe;
}

const ticketLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ticket requests. Please wait.' },
});

router.post('/execution-ticket', ticketLimiter, requireAuth, (req, res) => {
  try {
    const userId = String(req.ticketUser.id);
    const sessionId = sanitizeSessionId(req.body?.sessionId) || ('user_' + userId);
    const fingerprint = sanitizeFingerprint(req.body?.fingerprint);
    const ops = sanitizeOps(req.body?.ops);
    const now = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const exp = now + TICKET_TTL_MS;
    const ticket = { userId, sessionId, fingerprint, ops, iat: now, exp, nonce, v: 2 };
    const sig = sign(ticket);
    trackNonce(nonce, exp);
    const ipHash = crypto.createHash('sha256').update((req.ip || '') + SECRET).digest('hex').slice(0, 12);
    res.json({ ok: true, ticket, sig, ipHash, serverTs: now });
  } catch (err) {
    console.error('[ExecTicket] issue error:', err.message);
    res.status(500).json({ error: 'ticket issuance failed' });
  }
});

router.post('/execution-ticket/verify', ticketLimiter, requireAuth, (req, res) => {
  try {
    const { ticket, sig } = req.body || {};
    if (!ticket || !sig || typeof ticket !== 'object' || Array.isArray(ticket)) {
      return res.status(400).json({ ok: false, reason: 'missing-ticket' });
    }
    const now = Date.now();
    if (!Number.isInteger(ticket.iat) || !Number.isInteger(ticket.exp) || ticket.exp <= now || ticket.exp - ticket.iat > TICKET_TTL_MS) {
      return res.status(401).json({ ok: false, reason: 'expired', serverTs: now });
    }
    if (String(ticket.userId) !== String(req.ticketUser.id)) {
      return res.status(403).json({ ok: false, reason: 'user-mismatch' });
    }
    if (!ticket.nonce || !usedNonces.has(ticket.nonce)) {
      return res.status(401).json({ ok: false, reason: 'invalid-nonce' });
    }
    if (!verifySignature(ticket, sig)) {
      return res.status(401).json({ ok: false, reason: 'invalid-signature' });
    }
    usedNonces.delete(ticket.nonce);
    res.json({ ok: true, sessionId: ticket.sessionId, ops: ticket.ops, serverTs: now });
  } catch (err) {
    console.error('[ExecTicket] verify error:', err.message);
    res.status(500).json({ ok: false, reason: 'verify-error' });
  }
});

router.get('/execution-ticket/ping', (req, res) => {
  res.json({ ok: true, serverTs: Date.now(), poolSize: usedNonces.size, ttl: TICKET_TTL_MS, version: 'p6.2.0' });
});

export default router;
