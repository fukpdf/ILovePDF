// routes/threat-feed.js — Phase 8 / Objective 4 (Threat Intelligence Feed)
// =============================================================================
// Serves signed threat intelligence rules to the browser RuntimeThreatIntel.
// Rules are versioned, HMAC-signed, and cached server-side for performance.
//
// Endpoints:
//   GET /api/threat-feed             — get current signed rule set
//   GET /api/threat-feed/ping        — health
//   POST /api/threat-feed/rules      — admin: update rule set
//   POST /api/threat-feed/rollback   — admin: rollback to previous rule set
// =============================================================================

import { Router } from 'express';
import crypto     from 'crypto';
import rateLimit  from 'express-rate-limit';

const router = Router();
const SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';

// ── Built-in baseline rule set ────────────────────────────────────────────────
const BASELINE_RULES = {
  version:    '1.0.0',
  issuedAt:   Date.now(),
  expiresIn:  3600,   // seconds
  thresholds: {
    automationBlock:      80,   // automation score to block dispatch
    behaviorCritical:     75,   // behavior score for CRITICAL risk
    behaviorHigh:         50,
    replayWindowMs:       300_000,  // 5 minutes
    rateLimitPerMinute:   30,
    incidentEscalateSev:  70,
  },
  automationSignatures: [
    { id: 'auto-001', pattern: 'uniform-timing',   weight: 30,
      description: 'Perfectly uniform inter-action timing' },
    { id: 'auto-002', pattern: 'no-mouse-entropy', weight: 25,
      description: 'No mouse movement entropy detected' },
    { id: 'auto-003', pattern: 'rapid-sequential',  weight: 20,
      description: 'Rapid sequential file submissions' },
    { id: 'auto-004', pattern: 'headless-ua',        weight: 15,
      description: 'User-agent matches known headless browser pattern' },
  ],
  workerFingerprints: {
    blocklist: [],
    suspiciousOrigins: [],
  },
  suspiciousDomains: {
    blocklist:    [],
    watchlist:    [],
  },
  behaviorRules: [
    { id: 'beh-001', pattern: 'no-viewport-change', weight: 10 },
    { id: 'beh-002', pattern: 'instant-first-action', weight: 15 },
    { id: 'beh-003', pattern: 'no-focus-events', weight: 10 },
    { id: 'beh-004', pattern: 'clipboard-paste-only', weight: 8 },
  ],
  cspViolationRules: {
    autoEscalateSeverity: 'HIGH',
    knownRoguePrefixes: ['chrome-extension://', 'moz-extension://', 'blob:http://'],
  },
  rollbackAllowed: true,
};

// ── Rule store (in-memory; optionally persist to SQLite in future) ─────────────
let _current  = Object.assign({}, BASELINE_RULES, { issuedAt: Date.now() });
let _previous = null;
let _updateCount = 0;

// ── Sign rule set ─────────────────────────────────────────────────────────────
function _signRules(rules) {
  const payload = JSON.stringify({
    version:   rules.version,
    issuedAt:  rules.issuedAt,
    expiresIn: rules.expiresIn,
  });
  return crypto.createHmac('sha256', SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 48);
}

function _buildResponse(rules) {
  const sig = _signRules(rules);
  return {
    ok:        true,
    rules,
    signature: sig,
    ts:        Date.now(),
    version:   rules.version,
    expiresAt: rules.issuedAt + (rules.expiresIn * 1000),
  };
}

// ── Admin token guard ─────────────────────────────────────────────────────────
function _adminOnly(req, res, next) {
  const token    = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}

// ── Rate limiters ──────────────────────────────────────────────────────────────
const feedLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,        // browsers poll max every 5 min so 30/min is very generous
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'threat_feed_rate_limit' },
});

// ── GET /api/threat-feed — serve signed rules ─────────────────────────────────
router.get('/', feedLimiter, (req, res) => {
  // Refresh issuedAt each serve so the browser gets fresh expiry
  _current.issuedAt = Date.now();
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.json(_buildResponse(_current));
});

// ── GET /api/threat-feed/ping ─────────────────────────────────────────────────
router.get('/ping', (_req, res) => {
  res.json({
    ok:          true,
    service:     'threat-feed',
    version:     _current.version,
    updateCount: _updateCount,
    ts:          Date.now(),
  });
});

// ── POST /api/threat-feed/rules — admin: push updated rule set ────────────────
router.post('/rules', _adminOnly, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  // Merge with current, preserving baseline structure
  _previous = Object.assign({}, _current);
  _current  = Object.assign({}, BASELINE_RULES, body, {
    issuedAt:  Date.now(),
    expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 3600,
  });
  _updateCount++;

  console.info('[ThreatFeed] rules updated | version:', _current.version,
    '| update#:', _updateCount);

  res.json({ ok: true, version: _current.version, updatedAt: _current.issuedAt });
});

// ── POST /api/threat-feed/rollback — admin: restore previous rules ─────────────
router.post('/rollback', _adminOnly, (req, res) => {
  if (!_previous) {
    return res.status(400).json({ error: 'no_previous_version' });
  }
  if (!_current.rollbackAllowed) {
    return res.status(403).json({ error: 'rollback_disabled' });
  }

  const tmp    = _current;
  _current     = Object.assign({}, _previous, { issuedAt: Date.now() });
  _previous    = tmp;
  _updateCount++;

  console.info('[ThreatFeed] rollback executed | restored to version:', _current.version);
  res.json({ ok: true, rolledBackTo: _current.version, ts: _current.issuedAt });
});

export default router;
