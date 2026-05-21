// routes/security-telemetry.js — Phase 4 / Task 9 (Security Telemetry Endpoint)
// =============================================================================
// POST /api/security-telemetry — accepts batched security events from browsers.
//
// Design:
//   - Anonymous: no PII accepted or stored
//   - Rate-limited: max 6 requests per IP per minute (own limiter, not apiLimiter)
//   - Privacy-safe: strips any fields not in the ALLOWED_FIELDS whitelist
//   - In-memory store: last 1000 events (not persisted — restarts clear it)
//   - Admin export: GET /api/security-telemetry/export (admin-auth required)
//   - Health check: GET /api/security-telemetry/ping
// =============================================================================

import { Router } from 'express';
import rateLimit  from 'express-rate-limit';

const router = Router();

// ── In-memory event store ─────────────────────────────────────────────────────
const MAX_EVENTS = 1000;
const _events    = [];

// Per-type counts (for dashboard)
const _counts = Object.create(null);

// ── Safe field whitelist ──────────────────────────────────────────────────────
const ALLOWED_EVENT_FIELDS = new Set([
  'type', 'ts', 'reason', 'skewMs', 'count', 'tier', 'from', 'to',
  'score', 'path', 'chunkId', 'workerId', 'domain', 'origin', 'feature',
  'retries', 'byteLength', 'memMB', 'heapMB', 'driftPct', 'errorCode',
  'ok', 'advisory', 'enforce', 'event', 'healthy', 'blocked',
]);

const ALLOWED_EVENT_TYPES = new Set([
  'integrity-failure', 'worker-restart', 'nonce-violation', 'replay-attempt',
  'deploy-mismatch', 'proto-pollution', 'runtime-drift', 'tier-change',
  'foreign-degrade', 'wasm-event', 'perf-pressure', 'blob-leak',
  'worker-blocked', 'sri-mismatch', 'origin-violation', 'seal-failure',
  'devtools-degraded', 'panic-activated', 'panic-recovered',
]);

// ── Per-IP rate limiter ───────────────────────────────────────────────────────
const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 6,               // max 6 batches per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'telemetry_rate_limit', hint: 'Max 6 batches per minute.' },
});

// ── Strip PII / filter fields ─────────────────────────────────────────────────
function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.type !== 'string') return null;
  if (!ALLOWED_EVENT_TYPES.has(ev.type)) return null;  // unknown types dropped

  const clean = Object.create(null);
  for (const key of ALLOWED_EVENT_FIELDS) {
    if (key in ev) {
      const val = ev[key];
      // Only allow primitives (no nested objects that could contain PII)
      if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        // Truncate long strings
        clean[key] = typeof val === 'string' ? val.slice(0, 200) : val;
      }
    }
  }
  // Always stamp with server-side receive time (do not trust client ts alone)
  clean._receivedAt = Date.now();
  return clean;
}

function storeEvent(ev) {
  if (_events.length >= MAX_EVENTS) _events.shift();
  _events.push(ev);
  _counts[ev.type] = (_counts[ev.type] || 0) + 1;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check (no auth required)
router.get('/ping', (req, res) => {
  res.json({ ok: true, stored: _events.length, ts: Date.now() });
});

// Batch ingest
router.post('/', telemetryLimiter, (req, res) => {
  const body = req.body;

  // Accept: { events: [...] } or a plain array
  const raw = Array.isArray(body) ? body : (body && Array.isArray(body.events) ? body.events : null);

  if (!raw) {
    return res.status(400).json({ error: 'invalid_payload', hint: 'Send { events: [...] } or an array.' });
  }

  // Limit batch size
  const batch = raw.slice(0, 50);
  let accepted = 0;
  let rejected = 0;

  for (const ev of batch) {
    const clean = sanitizeEvent(ev);
    if (clean) {
      storeEvent(clean);
      accepted++;
    } else {
      rejected++;
    }
  }

  return res.json({
    ok:       true,
    accepted,
    rejected,
    stored:   _events.length,
  });
});

// Admin export (requires X-Admin-Token header matching env var)
router.get('/export', (req, res) => {
  const token = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return res.json({
    events:  _events.slice(),
    counts:  Object.assign({}, _counts),
    stored:  _events.length,
    maxSize: MAX_EVENTS,
    ts:      Date.now(),
  });
});

// Summary (public, but de-identified counts only)
router.get('/summary', (req, res) => {
  return res.json({
    counts: Object.assign({}, _counts),
    total:  _events.length,
    ts:     Date.now(),
  });
});

export default router;
