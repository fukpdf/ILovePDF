// routes/security-incidents.js — Phase 8 / Objective 7
// =============================================================================
// Persistent server-side incident storage and management.
// Receives escalated incidents from the browser RuntimeIncidentEngine,
// persists them in SQLite, deduplicates, correlates by IP and deployment,
// and provides admin export/query endpoints.
//
// Endpoints:
//   POST /api/security-incidents          — ingest incident(s) from browser
//   GET  /api/security-incidents          — list incidents (admin)
//   GET  /api/security-incidents/:id      — get single incident (admin)
//   PUT  /api/security-incidents/:id      — update state (admin)
//   GET  /api/security-incidents/export   — full export (admin)
//   GET  /api/security-incidents/ping     — health
// =============================================================================

import { Router }  from 'express';
import rateLimit   from 'express-rate-limit';
import Database    from 'better-sqlite3';
import crypto      from 'crypto';
import path        from 'path';
import fs          from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.resolve(__dirname, '../.data');
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
      CREATE TABLE IF NOT EXISTS p8_incidents (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id    TEXT    UNIQUE NOT NULL,
        type           TEXT    NOT NULL,
        severity       TEXT    NOT NULL,
        score          INTEGER NOT NULL DEFAULT 0,
        source         TEXT,
        state          TEXT    NOT NULL DEFAULT 'OPEN',
        session_id     TEXT,
        ip_hash        TEXT,
        deployment_id  TEXT,
        worker_id      TEXT,
        replay_chain   TEXT,
        data_json      TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        resolved_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_p8_inc_state    ON p8_incidents(state);
      CREATE INDEX IF NOT EXISTS idx_p8_inc_severity ON p8_incidents(severity);
      CREATE INDEX IF NOT EXISTS idx_p8_inc_ts       ON p8_incidents(created_at);
      CREATE INDEX IF NOT EXISTS idx_p8_inc_ip       ON p8_incidents(ip_hash);
      CREATE INDEX IF NOT EXISTS idx_p8_inc_deploy   ON p8_incidents(deployment_id);

      CREATE TABLE IF NOT EXISTS p8_incident_replay (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id  TEXT    NOT NULL,
        event_type   TEXT    NOT NULL,
        event_ts     INTEGER NOT NULL,
        event_data   TEXT,
        chain_pos    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_p8_replay_inc ON p8_incident_replay(incident_id);
    `);

    return db;
  } catch (e) {
    console.warn('[SecIncidents] DB init failed:', e.message);
    return null;
  }
}

let _db = null;
try { _db = _initDb(); } catch (_) {}

// ── Prepared statements ────────────────────────────────────────────────────────
let _stmtInsert = null;
let _stmtUpdate = null;

if (_db) {
  try {
    _stmtInsert = _db.prepare(`
      INSERT OR IGNORE INTO p8_incidents
        (incident_id, type, severity, score, source, state,
         session_id, ip_hash, deployment_id, worker_id, replay_chain,
         data_json, created_at, updated_at)
      VALUES
        (@incidentId, @type, @severity, @score, @source, @state,
         @sessionId, @ipHash, @deploymentId, @workerId, @replayChain,
         @dataJson, @createdAt, @updatedAt)
    `);

    _stmtUpdate = _db.prepare(`
      UPDATE p8_incidents
      SET state = @state, updated_at = @updatedAt, resolved_at = @resolvedAt
      WHERE incident_id = @incidentId
    `);
  } catch (e) {
    console.warn('[SecIncidents] Failed to prepare statements:', e.message);
  }
}

// ── Severity ranks ─────────────────────────────────────────────────────────────
const SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const VALID_STATES     = new Set(['OPEN', 'INVESTIGATING', 'RESOLVED', 'ESCALATED']);

// ── IP hashing ────────────────────────────────────────────────────────────────
function _hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

// ── Sanitize incident from browser ────────────────────────────────────────────
function _sanitize(raw, req) {
  if (!raw || typeof raw !== 'object') return null;

  const type     = typeof raw.type === 'string'
    ? raw.type.replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80) : null;
  if (!type) return null;

  const severity = VALID_SEVERITIES.has(raw.severity) ? raw.severity : 'LOW';
  const score    = typeof raw.score === 'number'
    ? Math.max(0, Math.min(100, Math.round(raw.score))) : 0;
  const source   = typeof raw.source === 'string'
    ? raw.source.slice(0, 80) : 'browser';

  const incidentId = (typeof raw.id === 'string' && raw.id.startsWith('inc_'))
    ? raw.id.slice(0, 80)
    : 'inc_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');

  const sessionId    = typeof raw.sessionId === 'string'
    ? raw.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : null;
  const deploymentId = typeof raw.deploymentId === 'string'
    ? raw.deploymentId.slice(0, 80) : null;
  const workerId     = typeof raw.workerId === 'string'
    ? raw.workerId.slice(0, 80) : null;

  const ipHash = _hashIp(req.ip || req.connection?.remoteAddress);

  return {
    incidentId,
    type,
    severity,
    score,
    source,
    state:        'OPEN',
    sessionId,
    ipHash,
    deploymentId,
    workerId,
    replayChain:  null,
    dataJson:     JSON.stringify({ type, severity, score, source }),
    createdAt:    Date.now(),
    updatedAt:    Date.now(),
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

// ── Rate limiter (browser ingestion) ──────────────────────────────────────────
const ingestLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'incident_rate_limit' },
});

// ── POST /api/security-incidents — browser incident ingestion ─────────────────
router.post('/', ingestLimiter, (req, res) => {
  const body  = req.body;
  const items = Array.isArray(body) ? body : (body && typeof body === 'object' ? [body] : []);
  const batch = items.slice(0, 20);

  let accepted = 0;
  let rejected = 0;

  if (_db && _stmtInsert) {
    const insertMany = _db.transaction((rows) => {
      for (const row of rows) {
        try { _stmtInsert.run(row); accepted++; } catch (_) { rejected++; }
      }
    });
    const sanitized = batch.map(r => _sanitize(r, req)).filter(Boolean);
    try { insertMany(sanitized); } catch (_) {}
  }

  return res.json({ ok: true, accepted, rejected, ts: Date.now() });
});

// ── GET /api/security-incidents — list (admin) ─────────────────────────────────
router.get('/', _adminOnly, (req, res) => {
  if (!_db) return res.json({ ok: true, incidents: [], total: 0 });

  const state    = VALID_STATES.has(req.query.state) ? req.query.state : null;
  const severity = VALID_SEVERITIES.has(req.query.severity) ? req.query.severity : null;
  const limit    = Math.min(parseInt(req.query.limit || '100'), 500);
  const since    = parseInt(req.query.since || '0');

  try {
    let query = 'SELECT * FROM p8_incidents WHERE 1=1';
    const params = [];
    if (state) { query += ' AND state = ?'; params.push(state); }
    if (severity) { query += ' AND severity = ?'; params.push(severity); }
    if (since) { query += ' AND created_at >= ?'; params.push(since); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = _db.prepare(query).all(...params);
    const total = _db.prepare('SELECT COUNT(*) as n FROM p8_incidents').get().n;

    return res.json({ ok: true, incidents: rows, total, fetched: rows.length });
  } catch (e) {
    return res.status(500).json({ error: 'query_error', hint: e.message });
  }
});

// ── GET /api/security-incidents/export — full export (admin) ──────────────────
router.get('/export', _adminOnly, (req, res) => {
  if (!_db) return res.json({ ok: true, incidents: [], replayChains: [] });
  try {
    const incidents   = _db.prepare('SELECT * FROM p8_incidents ORDER BY created_at DESC LIMIT 5000').all();
    const replayChains = _db.prepare('SELECT * FROM p8_incident_replay ORDER BY incident_id, chain_pos').all();
    const summary = {
      total:    incidents.length,
      open:     incidents.filter(r => r.state === 'OPEN').length,
      critical: incidents.filter(r => r.severity === 'CRITICAL').length,
    };
    return res.json({ ok: true, incidents, replayChains, summary, exportedAt: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: 'export_error', hint: e.message });
  }
});

// ── GET /api/security-incidents/:id — single incident (admin) ─────────────────
router.get('/:id', _adminOnly, (req, res) => {
  if (!_db) return res.status(404).json({ error: 'not_found' });
  try {
    const inc = _db.prepare('SELECT * FROM p8_incidents WHERE incident_id = ?').get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not_found' });
    const chain = _db.prepare(
      'SELECT * FROM p8_incident_replay WHERE incident_id = ? ORDER BY chain_pos'
    ).all(req.params.id);
    return res.json({ ok: true, incident: inc, replayChain: chain });
  } catch (e) {
    return res.status(500).json({ error: 'query_error', hint: e.message });
  }
});

// ── PUT /api/security-incidents/:id — update state (admin) ────────────────────
router.put('/:id', _adminOnly, (req, res) => {
  if (!_db || !_stmtUpdate) return res.status(503).json({ error: 'db_unavailable' });

  const { state } = req.body || {};
  if (!VALID_STATES.has(state)) {
    return res.status(400).json({ error: 'invalid_state', valid: Array.from(VALID_STATES) });
  }

  try {
    _stmtUpdate.run({
      state,
      updatedAt:  Date.now(),
      resolvedAt: (state === 'RESOLVED') ? Date.now() : null,
      incidentId: req.params.id,
    });
    return res.json({ ok: true, incidentId: req.params.id, state });
  } catch (e) {
    return res.status(500).json({ error: 'update_error', hint: e.message });
  }
});

// ── GET /api/security-incidents/ping ─────────────────────────────────────────
router.get('/ping', (req, res) => {
  let dbCount = null;
  if (_db) {
    try { dbCount = _db.prepare('SELECT COUNT(*) as n FROM p8_incidents').get().n; } catch (_) {}
  }
  res.json({ ok: true, service: 'security-incidents', version: '1.0',
    dbEnabled: _db !== null, dbCount, ts: Date.now() });
});

export default router;
