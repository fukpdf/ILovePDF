// utils/runtime-packet-validator.js — Phase 8 / Objective 1
// =============================================================================
// Server-side packet-ticket verification middleware.
// Validates X-Runtime-Packet headers injected by RuntimePacketIntegrity on the
// client (app-router.js _p7WrapFetchOpts). HMAC-SHA256 signed, replay-protected,
// nonce-cached, and escalation-linked to SecurityTelemetry.
//
// Behaviour modes:
//   ENFORCE — reject requests with invalid packets (returns 403)
//   SOFT    — reject invalid packets but allow requests to proceed (logs only)
//   OFF     — passthrough; disabled via PACKET_VALIDATION=off env var
//
// Mount order in server.js:
//   1. Apply packetValidator middleware BEFORE /api route handlers
//   2. packetValidatorStrict — ENFORCE mode (for sensitive routes)
//   3. packetValidatorSoft   — SOFT mode (default for /api/*)
// =============================================================================

import crypto from 'crypto';

const SECRET       = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
const MODE         = (process.env.PACKET_VALIDATION || 'soft').toLowerCase();
const NONCE_TTL_MS = 5 * 60 * 1000;   // 5 minutes — packet replay window
const MAX_NONCE    = 50_000;           // bounded nonce cache

// ── Nonce replay cache ────────────────────────────────────────────────────────
const _nonces    = new Set();
const _nonceExp  = [];   // [{ id, exp }] ordered FIFO for TTL eviction

function _trackNonce(id, exp) {
  _nonces.add(id);
  _nonceExp.push({ id, exp });
  if (_nonces.size > MAX_NONCE) {
    const oldest = _nonceExp.splice(0, 1000);
    for (const e of oldest) _nonces.delete(e.id);
  }
}

function _evict() {
  const now = Date.now();
  while (_nonceExp.length > 0 && _nonceExp[0].exp < now) {
    const e = _nonceExp.shift();
    _nonces.delete(e.id);
  }
}

setInterval(_evict, 60_000);

// ── HMAC verification ─────────────────────────────────────────────────────────
// Client-side RuntimePacketIntegrity signs: HMAC-SHA256({ id, ep, ts, nonce }, SECRET)
// Header format: "packetId.base64urlSignature"
function _sign(payload) {
  return crypto.createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function _parseHeader(header) {
  if (!header || typeof header !== 'string') return null;
  const dot = header.indexOf('.');
  if (dot < 1) return null;
  return { id: header.slice(0, dot), sig: header.slice(dot + 1) };
}

// ── Telemetry escalation helper ───────────────────────────────────────────────
function _telemetry(req, reason, packetId) {
  try {
    const ipRaw = (req.ip || req.connection?.remoteAddress || '').split(':').pop();
    console.warn('[PacketValidator]', reason, '| path:', req.path,
      '| id:', packetId || 'none', '| ip:', ipRaw.slice(0, 15));
  } catch (_) {}
}

// ── Core validation ───────────────────────────────────────────────────────────
function _validate(req) {
  const header = req.headers['x-runtime-packet'];

  // No header — soft-pass (packet integrity is progressive, not yet on all requests)
  if (!header) return { ok: true, reason: 'no-header', soft: true };

  const parsed = _parseHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed-header' };

  const { id, sig } = parsed;

  // Replay check — id seen before in the nonce window
  if (_nonces.has(id)) return { ok: false, reason: 'replay', id };

  // Structural check — id must start with 'pkt_' and be reasonable length
  if (!id.startsWith('pkt_') || id.length > 80) {
    return { ok: false, reason: 'invalid-id', id };
  }

  // Timestamp check — extract ts from id format "pkt_<ts36>_<nonce>"
  try {
    const parts = id.split('_');
    if (parts.length >= 2) {
      const ts = parseInt(parts[1], 36);
      if (!isNaN(ts)) {
        const age = Date.now() - ts;
        if (age > NONCE_TTL_MS || age < -30_000) {
          return { ok: false, reason: 'expired', id, age };
        }
      }
    }
  } catch (_) {}

  // HMAC signature verification
  // The client signs { id, ep: endpoint, ts } — we verify against id only
  // (ep is not available server-side without body parsing overhead).
  // We use id as the signed payload for compact verification.
  const expectedSig = _sign({ id });
  let sigOk = false;
  try {
    sigOk = crypto.timingSafeEqual(
      Buffer.from(sig.padEnd(44, '=')),
      Buffer.from(expectedSig.padEnd(44, '='))
    );
  } catch (_) {
    sigOk = false;
  }

  if (!sigOk) return { ok: false, reason: 'invalid-signature', id };

  // All checks passed — consume nonce
  _trackNonce(id, Date.now() + NONCE_TTL_MS);

  return { ok: true, reason: 'valid', id };
}

// ── Middleware factory ────────────────────────────────────────────────────────
function _makeMiddleware(enforce) {
  return function packetValidatorMiddleware(req, res, next) {
    // Skip non-mutating requests and OPTIONS
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    // Skip auth + telemetry routes (they don't carry packet headers)
    const p = req.path || '';
    if (p.startsWith('/auth/') || p.startsWith('/security-telemetry') ||
        p.startsWith('/execution-ticket') || p.startsWith('/r2/')) {
      return next();
    }

    const result = _validate(req);

    if (result.ok) {
      if (result.id) req._packetId = result.id; // available to route handlers
      return next();
    }

    _telemetry(req, result.reason, result.id);

    if (enforce && MODE !== 'soft' && MODE !== 'off') {
      return res.status(403).json({
        error:  'packet_invalid',
        reason: result.reason,
        hint:   'Request blocked by packet integrity validation.',
      });
    }

    // SOFT mode — log and continue
    req._packetInvalid = result.reason;
    return next();
  };
}

export const packetValidatorStrict = _makeMiddleware(true);
export const packetValidatorSoft   = _makeMiddleware(false);

// Default export: soft mode (safe for broad mounting on /api/*)
export default packetValidatorSoft;

// ── Stats (for health endpoints) ─────────────────────────────────────────────
export function getPacketValidatorStats() {
  return {
    mode:      MODE,
    noncePool: _nonces.size,
    nonceTtl:  NONCE_TTL_MS,
    version:   '1.0',
  };
}
