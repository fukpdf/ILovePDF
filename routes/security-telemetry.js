// routes/security-telemetry.js — Phase 5 / Task 3 (Advanced Security Telemetry)
// =============================================================================
// POST /api/security-telemetry — accepts batched security events from browsers.
//
// v2.0 upgrades (Phase 5):
//   • SQLite persistence via better-sqlite3 (same pattern as utils/db.js)
//   • Rolling cleanup: max 10,000 events, prunes oldest hourly
//   • Anomaly scoring: server-side rate analysis per IP + event type
//   • Batch persistence: all accepted events written to DB atomically
//   • Replay-safe: deduplicated event IDs prevent double-counting
//   • Session tracking: sessionId grouping for crash timeline reconstruction
//   • GET /api/security-telemetry/timeline — session crash timeline
//   • GET /api/security-telemetry/anomaly  — current anomaly score
//   • GET /api/security-telemetry/stats    — aggregate statistics
//
// Retained from v1.0:
//   - Anonymous (no PII accepted or stored)
//   - Rate-limited: max 6 requests per IP per minute
//   - Privacy-safe field whitelist
//   - Admin export endpoint
//   - Health ping
//   - Public summary
// =============================================================================

import { Router } from 'express';
import rateLimit  from 'express-rate-limit';
import Database   from 'better-sqlite3';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, '.data');
const DB_PATH   = path.join(DATA_DIR, 'app.db');

const router = Router();

// ── DB init ───────────────────────────────────────────────────────────────────
function _initDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = new Database(DB_PATH);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS security_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type  TEXT    NOT NULL,
        session_id  TEXT,
        tier        TEXT,
        score       INTEGER,
        path        TEXT,
        reason      TEXT,
        data_json   TEXT,
        ip_hash     TEXT,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sec_events_type ON security_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_sec_events_ts   ON security_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_sec_events_sid  ON security_events(session_id);

      CREATE TABLE IF NOT EXISTS sec_telemetry_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Mark schema version
    db.prepare("INSERT OR IGNORE INTO sec_telemetry_meta VALUES ('schema_version', '2.0')").run();
    return db;
  } catch (e) {
    console.warn('[SecTelemetry] SQLite init failed:', e.message, '— falling back to in-memory');
    return null;
  }
}

let _db = null;
try { _db = _initDb(); } catch (_) {}

// ── Prepared statements ────────────────────────────────────────────────────────
let _stmtInsert = null;
let _stmtCount  = null;
let _stmtClean  = null;

if (_db) {
  try {
    _stmtInsert = _db.prepare(`
      INSERT INTO security_events
        (event_type, session_id, tier, score, path, reason, data_json, ip_hash, received_at)
      VALUES
        (@type, @sessionId, @tier, @score, @path, @reason, @dataJson, @ipHash, @receivedAt)
    `);
    _stmtCount = _db.prepare('SELECT COUNT(*) as n FROM security_events');
    _stmtClean = _db.prepare(`
      DELETE FROM security_events
      WHERE id IN (
        SELECT id FROM security_events ORDER BY received_at ASC LIMIT ?
      )
    `);
  } catch (e) {
    console.warn('[SecTelemetry] Failed to prepare statements:', e.message);
    _db = null;
  }
}

const MAX_DB_EVENTS  = 10000;
const MAX_MEM_EVENTS = 1000;

// ── In-memory store (fallback / fast access) ──────────────────────────────────
const _events = [];
const _counts = Object.create(null);

// ── Replay-safe deduplication (last 10k event IDs in a bounded Set) ──────────
const _seenIds  = new Set();
const MAX_SEEN  = 10000;

function _trackId(id) {
  if (!id) return false; // no ID = allow (old clients)
  if (_seenIds.has(id)) return true; // duplicate
  _seenIds.add(id);
  if (_seenIds.size > MAX_SEEN) {
    const arr = Array.from(_seenIds);
    for (let i = 0; i < 1000; i++) _seenIds.delete(arr[i]);
  }
  return false;
}

// ── Anomaly scoring ────────────────────────────────────────────────────────────
const _recentEvents = []; // { type, ts, ipHash } rolling 5-min window
const ANOMALY_WINDOW_MS = 5 * 60 * 1000;
const HIGH_SEV_TYPES = new Set([
  'integrity-failure', 'seal-failure', 'sri-mismatch', 'origin-violation',
  'proto-pollution', 'panic-activated', 'nonce-violation',
]);

function _updateRecentEvents(ev, ipHash) {
  const now = Date.now();
  _recentEvents.push({ type: ev.type, ts: now, ipHash });
  // Prune old entries
  const cutoff = now - ANOMALY_WINDOW_MS;
  while (_recentEvents.length > 0 && _recentEvents[0].ts < cutoff) {
    _recentEvents.shift();
  }
}

function _computeAnomalyScore() {
  const now    = Date.now();
  const cutoff = now - ANOMALY_WINDOW_MS;
  const window = _recentEvents.filter(e => e.ts >= cutoff);

  let score = 0;
  const reasons = [];

  // High event rate
  const rate = window.length / (ANOMALY_WINDOW_MS / 60000); // per minute
  if (rate > 30) { score += 30; reasons.push(`High rate: ${Math.round(rate)}/min`); }
  else if (rate > 15) { score += 15; reasons.push(`Elevated rate: ${Math.round(rate)}/min`); }

  // High-severity events
  const highCount = window.filter(e => HIGH_SEV_TYPES.has(e.type)).length;
  if (highCount > 5)  { score += 40; reasons.push(`${highCount} high-sev events in 5min`); }
  else if (highCount > 2) { score += 20; reasons.push(`${highCount} high-sev events in 5min`); }

  // Simultaneous seal + SRI failure (coordinated attack)
  const hasSeal = window.some(e => e.type === 'seal-failure');
  const hasSri  = window.some(e => e.type === 'sri-mismatch' || e.type === 'integrity-failure');
  if (hasSeal && hasSri) { score += 25; reasons.push('Simultaneous seal+SRI failure'); }

  // Multiple distinct IPs with high-sev events
  const badIps = new Set(window.filter(e => HIGH_SEV_TYPES.has(e.type)).map(e => e.ipHash));
  if (badIps.size > 3) { score += 15; reasons.push(`${badIps.size} distinct IPs with high-sev events`); }

  return {
    score:   Math.min(100, score),
    level:   score >= 70 ? 'CRITICAL' : score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'NORMAL',
    reasons: reasons,
    window:  window.length,
    ts:      now,
  };
}

// ── IP hashing (one-way, privacy-preserving) ───────────────────────────────────
function _hashIp(ip) {
  if (!ip) return 'unknown';
  // Simple one-way: take last octet bucket to avoid storing real IPs
  const parts = String(ip).split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  return ip.length > 8 ? ip.slice(0, 8) + '…' : ip;
}

// ── Safe field whitelist ───────────────────────────────────────────────────────
const ALLOWED_EVENT_FIELDS = new Set([
  'type', 'ts', 'reason', 'skewMs', 'count', 'tier', 'from', 'to',
  'score', 'path', 'chunkId', 'workerId', 'domain', 'origin', 'feature',
  'retries', 'byteLength', 'memMB', 'heapMB', 'driftPct', 'errorCode',
  'ok', 'advisory', 'enforce', 'event', 'healthy', 'blocked',
  'id',  // v2.0: replay-safe event ID
]);

const ALLOWED_EVENT_TYPES = new Set([
  'integrity-failure', 'worker-restart', 'nonce-violation', 'replay-attempt',
  'deploy-mismatch', 'proto-pollution', 'runtime-drift', 'tier-change',
  'foreign-degrade', 'wasm-event', 'perf-pressure', 'blob-leak',
  'worker-blocked', 'sri-mismatch', 'origin-violation', 'seal-failure',
  'devtools-degraded', 'panic-activated', 'panic-recovered', 'security-anomaly',
  'worker-orphan-candidate', 'perf-battery-critical', 'perf-thermal-pressure',
]);

// ── Sanitize incoming event ────────────────────────────────────────────────────
function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.type !== 'string') return null;
  if (!ALLOWED_EVENT_TYPES.has(ev.type)) return null;

  const clean = Object.create(null);
  for (const key of ALLOWED_EVENT_FIELDS) {
    if (key in ev) {
      const val = ev[key];
      if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        clean[key] = typeof val === 'string' ? val.slice(0, 200) : val;
      }
    }
  }
  clean._receivedAt = Date.now();
  return clean;
}

// ── Persist to SQLite + in-memory ─────────────────────────────────────────────
function storeEvent(ev, sessionId, ipHash) {
  // In-memory
  if (_events.length >= MAX_MEM_EVENTS) _events.shift();
  _events.push(ev);
  _counts[ev.type] = (_counts[ev.type] || 0) + 1;

  // SQLite
  if (_db && _stmtInsert) {
    try {
      _stmtInsert.run({
        type:      ev.type,
        sessionId: sessionId || null,
        tier:      ev.tier   || null,
        score:     typeof ev.score === 'number' ? ev.score : null,
        path:      ev.path   || null,
        reason:    ev.reason || null,
        dataJson:  JSON.stringify(ev),
        ipHash:    ipHash || null,
        receivedAt: ev._receivedAt || Date.now(),
      });
    } catch (e) {
      // Non-fatal — in-memory already stored
    }
  }
}

// ── Batch persist (atomic) ────────────────────────────────────────────────────
function storeBatch(events, sessionId, ipHash) {
  if (_db && _stmtInsert) {
    const insertMany = _db.transaction((evs) => {
      for (const ev of evs) {
        try {
          _stmtInsert.run({
            type:      ev.type,
            sessionId: sessionId || null,
            tier:      ev.tier   || null,
            score:     typeof ev.score === 'number' ? ev.score : null,
            path:      ev.path   || null,
            reason:    ev.reason || null,
            dataJson:  JSON.stringify(ev),
            ipHash:    ipHash || null,
            receivedAt: ev._receivedAt || Date.now(),
          });
        } catch (_) {}
      }
    });
    try { insertMany(events); } catch (_) {}
  }
  // In-memory
  for (const ev of events) {
    if (_events.length >= MAX_MEM_EVENTS) _events.shift();
    _events.push(ev);
    _counts[ev.type] = (_counts[ev.type] || 0) + 1;
  }
}

// ── Rolling DB cleanup (runs hourly) ─────────────────────────────────────────
function _cleanupDb() {
  if (!_db || !_stmtCount || !_stmtClean) return;
  try {
    const { n } = _stmtCount.get();
    if (n > MAX_DB_EVENTS) {
      const excess = n - MAX_DB_EVENTS;
      _stmtClean.run(excess);
      console.info('[SecTelemetry] DB cleanup: removed', excess, 'old events');
    }
  } catch (e) {
    console.warn('[SecTelemetry] DB cleanup failed:', e.message);
  }
}
setInterval(_cleanupDb, 60 * 60 * 1000); // hourly

// ── Per-IP rate limiter ────────────────────────────────────────────────────────
const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'telemetry_rate_limit', hint: 'Max 6 batches per minute.' },
});

// ── Routes ─────────────────────────────────────────────────────────────────────

// Health check
router.get('/ping', (req, res) => {
  const dbOk = _db !== null;
  let dbCount = null;
  if (_db && _stmtCount) {
    try { dbCount = _stmtCount.get().n; } catch (_) {}
  }
  res.json({
    ok:         true,
    stored:     _events.length,
    dbEnabled:  dbOk,
    dbCount:    dbCount,
    ts:         Date.now(),
    version:    '2.0',
  });
});

// Batch ingest (v2.0 — replay-safe, session-aware, anomaly-tracked)
router.post('/', telemetryLimiter, (req, res) => {
  const body      = req.body;
  const ipHash    = _hashIp(req.ip || req.connection?.remoteAddress);
  const sessionId = (body && typeof body.sessionId === 'string')
    ? body.sessionId.slice(0, 64)
    : null;

  const raw = Array.isArray(body) ? body :
    (body && Array.isArray(body.events) ? body.events : null);

  if (!raw) {
    return res.status(400).json({ error: 'invalid_payload', hint: 'Send { events: [...] } or an array.' });
  }

  const batch = raw.slice(0, 50);
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  const cleanBatch = [];

  for (const ev of batch) {
    // Replay-safe deduplication
    if (ev.id && _trackId(ev.id)) {
      duplicates++;
      continue;
    }

    const clean = sanitizeEvent(ev);
    if (clean) {
      cleanBatch.push(clean);
      _updateRecentEvents(clean, ipHash);
      accepted++;
    } else {
      rejected++;
    }
  }

  // Atomic batch persist
  if (cleanBatch.length > 0) {
    storeBatch(cleanBatch, sessionId, ipHash);
  }

  let dbCount = null;
  if (_db && _stmtCount) {
    try { dbCount = _stmtCount.get().n; } catch (_) {}
  }

  return res.json({
    ok:         true,
    accepted,
    rejected,
    duplicates,
    stored:     _events.length,
    dbCount:    dbCount,
  });
});

// Anomaly score (public — de-identified)
router.get('/anomaly', (req, res) => {
  const anomaly = _computeAnomalyScore();
  // Don't expose reasons publicly
  return res.json({
    score: anomaly.score,
    level: anomaly.level,
    ts:    anomaly.ts,
  });
});

// Session timeline — requires admin token
router.get('/timeline', (req, res) => {
  const token    = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId query param required' });
  }

  let timeline = [];
  if (_db) {
    try {
      const rows = _db.prepare(`
        SELECT * FROM security_events
        WHERE session_id = ?
        ORDER BY received_at ASC
        LIMIT 500
      `).all(sessionId);
      timeline = rows.map(r => {
        try { return JSON.parse(r.data_json); } catch (_) { return r; }
      });
    } catch (_) {
      // Fall back to in-memory
      timeline = _events.filter(e => e._sessionId === sessionId);
    }
  } else {
    timeline = _events.filter(e => e._sessionId === sessionId);
  }

  return res.json({
    sessionId,
    events: timeline,
    count:  timeline.length,
    ts:     Date.now(),
  });
});

// Aggregate statistics (admin)
router.get('/stats', (req, res) => {
  const token    = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }

  let dbStats = null;
  if (_db) {
    try {
      const total = _stmtCount.get().n;
      const byType = _db.prepare(`
        SELECT event_type, COUNT(*) as n
        FROM security_events
        GROUP BY event_type
        ORDER BY n DESC
        LIMIT 20
      `).all();
      const recent = _db.prepare(`
        SELECT event_type, COUNT(*) as n
        FROM security_events
        WHERE received_at >= ?
        GROUP BY event_type
        ORDER BY n DESC
      `).all(Date.now() - 3600000);

      dbStats = { total, byType, lastHour: recent };
    } catch (e) {
      dbStats = { error: e.message };
    }
  }

  return res.json({
    memory:  { count: _events.length, counts: Object.assign({}, _counts) },
    db:      dbStats,
    anomaly: _computeAnomalyScore(),
    ts:      Date.now(),
    version: '2.0',
  });
});

// Admin export (full event dump)
router.get('/export', (req, res) => {
  const token    = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_SECRET;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }

  let dbEvents = null;
  if (_db) {
    try {
      dbEvents = _db.prepare(`
        SELECT * FROM security_events
        ORDER BY received_at DESC
        LIMIT 5000
      `).all();
    } catch (_) {}
  }

  return res.json({
    events:   _events.slice(),
    counts:   Object.assign({}, _counts),
    stored:   _events.length,
    maxSize:  MAX_MEM_EVENTS,
    dbEvents: dbEvents,
    anomaly:  _computeAnomalyScore(),
    ts:       Date.now(),
    version:  '2.0',
  });
});

// Summary (public — counts only)
router.get('/summary', (req, res) => {
  return res.json({
    counts: Object.assign({}, _counts),
    total:  _events.length,
    ts:     Date.now(),
  });
});

export default router;
