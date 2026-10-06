// routes/security-dashboard.js — Phase 7 / Enterprise Security Dashboard API
// =============================================================================
// Server-side API for the enterprise security dashboard.
// Aggregates telemetry data, incident summaries, and worker health into
// dashboard-friendly JSON endpoints.
//
// Endpoints:
//   GET  /api/security-dashboard/ping       — liveness + uptime
//   GET  /api/security-dashboard/summary    — overall security posture
//   GET  /api/security-dashboard/telemetry  — recent telemetry window
//   GET  /api/security-dashboard/incidents  — recent incidents from DB
//   GET  /api/security-dashboard/view       — serves the dashboard HTML
// =============================================================================

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router    = Router();

// ── GET /api/security-dashboard/ping ──────────────────────────────────────────
router.get('/ping', (_req, res) => {
  res.json({
    ok:      true,
    service: 'security-dashboard',
    version: '1.0',
    ts:      Date.now(),
    uptime:  process.uptime(),
  });
});

// ── GET /api/security-dashboard/summary ───────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    let db = null;
    try {
      const dbMod = await import('../utils/db.js');
      db = dbMod.default;
    } catch (_) {}

    let eventStats    = { total: 0, bySeverity: {}, last1h: 0 };
    let incidentStats = { open: 0, total: 0 };

    if (db) {
      try {
        const countRow  = db.prepare('SELECT COUNT(*) as cnt FROM security_events').get();
        eventStats.total = countRow?.cnt || 0;

        const oneHourAgo = Date.now() - 3_600_000;
        const recentRow  = db.prepare('SELECT COUNT(*) as cnt FROM security_events WHERE ts > ?').get(oneHourAgo);
        eventStats.last1h = recentRow?.cnt || 0;

        const typeCounts = db.prepare(
          'SELECT type, COUNT(*) as cnt FROM security_events GROUP BY type ORDER BY cnt DESC LIMIT 10'
        ).all();
        typeCounts.forEach(r => { eventStats.bySeverity[r.type] = r.cnt; });
      } catch (_) {}

      try {
        const openInc  = db.prepare("SELECT COUNT(*) as cnt FROM security_incidents WHERE state IN ('OPEN','INVESTIGATING')").get();
        const totalInc = db.prepare('SELECT COUNT(*) as cnt FROM security_incidents').get();
        incidentStats.open  = openInc?.cnt  || 0;
        incidentStats.total = totalInc?.cnt || 0;
      } catch (_) {}
    }

    res.json({
      ok:          true,
      ts:          Date.now(),
      events:      eventStats,
      incidents:   incidentStats,
      nodeVersion: process.version,
      uptime:      Math.round(process.uptime()),
    });
  } catch (e) {
    res.status(500).json({ error: 'summary_error', hint: e.message });
  }
});

// ── GET /api/security-dashboard/telemetry ────────────────────────────────────
router.get('/telemetry', async (req, res) => {
  try {
    let db = null;
    try { const m = await import('../utils/db.js'); db = m.default; } catch (_) {}
    if (!db) return res.json({ ok: true, events: [], total: 0 });

    const windowMs = parseInt(req.query.window || '3600000');
    const limit    = Math.min(parseInt(req.query.limit  || '200'), 500);
    const since    = Date.now() - windowMs;

    let events = [];
    try {
      events = db.prepare(
        'SELECT type, ts, reason, tier, score FROM security_events WHERE ts > ? ORDER BY ts DESC LIMIT ?'
      ).all(since, limit);
    } catch (e) {
      console.warn('[sec-dashboard] telemetry query error:', e.message);
    }

    res.json({ ok: true, events, total: events.length, windowMs });
  } catch (e) {
    res.status(500).json({ error: 'telemetry_error', hint: e.message });
  }
});

// ── GET /api/security-dashboard/incidents ────────────────────────────────────
router.get('/incidents', async (req, res) => {
  try {
    let db = null;
    try { const m = await import('../utils/db.js'); db = m.default; } catch (_) {}
    if (!db) return res.json({ ok: true, incidents: [] });

    let incidents = [];
    try {
      incidents = db.prepare(
        'SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 100'
      ).all();
    } catch (_) {}

    res.json({ ok: true, incidents, total: incidents.length });
  } catch (e) {
    res.status(500).json({ error: 'incidents_error', hint: e.message });
  }
});

// ── GET /api/security-dashboard/view — serve dashboard HTML ─────────────────
router.get('/view', (_req, res) => {
  const htmlPath = path.resolve(__dirname, '../admin/security-dashboard.html');
  res.sendFile(htmlPath, err => {
    if (err) res.status(404).send('Security dashboard not found.');
  });
});

export default router;
