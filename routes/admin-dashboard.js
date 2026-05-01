// Admin Dashboard API — all routes mounted at /admin/*
// Endpoints: login, stats, logs, feedback, file read/write, AI edit
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ADMIN_JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_COOKIE     = 'ilovepdf_admin_token';
const SESSION_DAYS     = 7;

/* ── DB: additional tables ──────────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS request_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ip          TEXT,
    tool        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rlog_ts   ON request_logs(ts);
  CREATE INDEX IF NOT EXISTS idx_rlog_path ON request_logs(path);

  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    user_id    INTEGER,
    email      TEXT,
    message    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'feedback',
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);
`);

/* ── Request logging middleware (exported for server.js) ────── */
export function requestLogMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    try {
      const duration = Date.now() - start;
      const ip = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || '?';
      // Derive tool name from path (e.g. /api/compress → compress)
      const toolMatch = req.path.match(/^\/(?:api\/)?([a-z-]+)/);
      const tool = toolMatch ? toolMatch[1] : null;
      db.prepare(`
        INSERT INTO request_logs (method, path, status, duration_ms, ip, tool)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.method, req.path.slice(0, 200), res.statusCode, duration, ip.slice(0, 60), tool);
    } catch (_) {}
  });
  next();
}

/* ── Auth helpers ───────────────────────────────────────────── */
function signAdminToken() {
  return jwt.sign({ admin: true }, ADMIN_JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}
function adminAuthMiddleware(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE]
             || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.admin) throw new Error('Not an admin token');
    next();
  } catch {
    res.clearCookie(ADMIN_COOKIE);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

/* ── Serve dashboard HTML ───────────────────────────────────── */
router.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin', 'index.html'));
});

/* ── POST /admin/login ──────────────────────────────────────── */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const envUser = process.env.ADMIN_USERNAME || 'admin';
  const envPass = process.env.ADMIN_PASSWORD;

  if (!envPass) {
    return res.status(503).json({ error: 'Admin password not configured. Set ADMIN_PASSWORD in Secrets.' });
  }
  if (username !== envUser || password !== envPass) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = signAdminToken();
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
  res.json({ ok: true, token });
});

/* ── POST /admin/logout ─────────────────────────────────────── */
router.post('/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ── GET /admin/stats ───────────────────────────────────────── */
router.get('/stats', adminAuthMiddleware, (req, res) => {
  try {
    const todayStr   = new Date().toISOString().slice(0, 10);
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const nowMs      = Date.now();
    const dayMs      = 24 * 60 * 60 * 1000;

    // Usage stats from usage_log
    const usageToday = db.prepare(`
      SELECT SUM(file_count) AS files, SUM(daily_bytes) AS bytes
      FROM usage_log WHERE last_reset = ?
    `).get(todayStr);

    const usageMonth = db.prepare(`
      SELECT SUM(file_count) AS files
      FROM usage_log WHERE last_reset >= ?
    `).get(monthStart);

    // Request log stats
    const reqToday = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed,
             AVG(duration_ms) AS avg_ms
      FROM request_logs WHERE ts >= ?
    `).get(nowMs - dayMs);

    const reqMonth = db.prepare(`
      SELECT COUNT(*) AS total
      FROM request_logs WHERE ts >= ?
    `).get(new Date(monthStart).getTime());

    // Most used tools (last 7 days)
    const topTools = db.prepare(`
      SELECT tool, COUNT(*) AS cnt
      FROM request_logs
      WHERE ts >= ? AND tool IS NOT NULL AND method = 'POST'
      GROUP BY tool ORDER BY cnt DESC LIMIT 10
    `).all(nowMs - 7 * dayMs);

    // Recent failed requests
    const recentFailed = db.prepare(`
      SELECT id, ts, method, path, status, duration_ms, ip
      FROM request_logs
      WHERE status >= 400
      ORDER BY ts DESC LIMIT 20
    `).all();

    // User counts
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    const newUsersToday = db.prepare(`
      SELECT COUNT(*) AS n FROM users WHERE created_at >= ?
    `).get(Math.floor((nowMs - dayMs) / 1000));

    res.json({
      usage: {
        files_today:  usageToday?.files  || 0,
        bytes_today:  usageToday?.bytes  || 0,
        files_month:  usageMonth?.files  || 0,
      },
      requests: {
        total_today:  reqToday?.total   || 0,
        success_today: reqToday?.success || 0,
        failed_today:  reqToday?.failed  || 0,
        avg_ms:        Math.round(reqToday?.avg_ms || 0),
        total_month:   reqMonth?.total   || 0,
      },
      users: {
        total:     userCount?.n     || 0,
        new_today: newUsersToday?.n || 0,
      },
      top_tools: topTools,
      recent_failed: recentFailed,
    });
  } catch (err) {
    console.error('[admin] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

/* ── GET /admin/logs ────────────────────────────────────────── */
router.get('/logs', adminAuthMiddleware, (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const status = req.query.status ? parseInt(req.query.status, 10) : null;

    let query = 'SELECT * FROM request_logs';
    const params = [];
    if (status) { query += ' WHERE status = ?'; params.push(status); }
    query += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    const logs = db.prepare(query).all(...params);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

/* ── GET /admin/feedback ────────────────────────────────────── */
router.get('/feedback', adminAuthMiddleware, (req, res) => {
  try {
    const resolved = req.query.resolved === '1' ? 1 : 0;
    const items = db.prepare(
      'SELECT * FROM feedback WHERE resolved=? ORDER BY ts DESC LIMIT 100'
    ).all(resolved);
    res.json({ feedback: items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feedback.' });
  }
});

/* ── POST /admin/feedback (public — users submit feedback) ──── */
router.post('/feedback', (req, res) => {
  const { message, email, type } = req.body || {};
  if (!message || typeof message !== 'string' || message.trim().length < 3) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  try {
    db.prepare(`
      INSERT INTO feedback (message, email, type)
      VALUES (?, ?, ?)
    `).run(message.trim().slice(0, 2000), (email || '').slice(0, 200), (type || 'feedback').slice(0, 50));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save feedback.' });
  }
});

/* ── PATCH /admin/feedback/:id/resolve ─────────────────────── */
router.patch('/feedback/:id/resolve', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  try {
    db.prepare('UPDATE feedback SET resolved=1 WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update feedback.' });
  }
});

/* ── File tree helper ───────────────────────────────────────── */
const EXCLUDED = new Set(['node_modules', '.git', '.data', 'dist', '.npm', '.cache', 'coverage']);
const EXCLUDED_FILES = new Set(['.env', 'package-lock.json']);
const MAX_FILE_SIZE  = 500 * 1024; // 500 KB read limit

function buildTree(dir, relBase = '') {
  const items = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }

  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.replit') continue;
    if (EXCLUDED.has(e.name) || EXCLUDED_FILES.has(e.name)) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      items.push({ name: e.name, path: rel, type: 'dir', children: buildTree(path.join(dir, e.name), rel) });
    } else {
      const stat = fs.statSync(path.join(dir, e.name));
      items.push({ name: e.name, path: rel, type: 'file', size: stat.size });
    }
  }
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function safePath(relPath) {
  const abs = path.resolve(ROOT, relPath);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
    throw new Error('Path traversal not allowed');
  }
  // Block sensitive paths
  const parts = relPath.split(path.sep);
  for (const p of parts) {
    if (EXCLUDED.has(p) || p.startsWith('.env')) throw new Error('Access denied');
  }
  return abs;
}

/* ── GET /admin/files ───────────────────────────────────────── */
router.get('/files', adminAuthMiddleware, (_req, res) => {
  try {
    res.json({ tree: buildTree(ROOT) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build file tree.' });
  }
});

/* ── GET /admin/file?path=… ─────────────────────────────────── */
router.get('/file', adminAuthMiddleware, (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required.' });
  try {
    const abs = safePath(relPath);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large to read (${Math.round(stat.size / 1024)} KB). Max: 500 KB.` });
    }
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ path: relPath, content, size: stat.size });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
    res.status(400).json({ error: err.message });
  }
});

/* ── POST /admin/file — write file with auto-backup ─────────── */
router.post('/file', adminAuthMiddleware, (req, res) => {
  const { path: relPath, content } = req.body || {};
  if (!relPath || typeof content !== 'string') {
    return res.status(400).json({ error: 'path and content are required.' });
  }
  try {
    const abs = safePath(relPath);
    // Create backup
    let backupPath = null;
    if (fs.existsSync(abs)) {
      const backupDir = path.join(ROOT, '.data', 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const safeName = relPath.replace(/[/\\]/g, '__');
      backupPath = path.join(backupDir, `${safeName}.${Date.now()}.bak`);
      fs.copyFileSync(abs, backupPath);
    }
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true, backupPath: backupPath ? path.relative(ROOT, backupPath) : null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ── POST /admin/ai-edit — get AI suggestion for a file ─────── */
router.post('/ai-edit', adminAuthMiddleware, async (req, res) => {
  const { filePath, fileContent, instruction } = req.body || {};
  if (!filePath || !fileContent || !instruction) {
    return res.status(400).json({ error: 'filePath, fileContent, and instruction are required.' });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI service not configured. Set DEEPSEEK_API_KEY.' });
  }

  const ext = path.extname(filePath).slice(1) || 'js';
  const prompt = `You are JARVIS, an expert code assistant. You are editing a file in an ILovePDF Node.js/Express project.

File: ${filePath}

Current content:
\`\`\`${ext}
${fileContent.slice(0, 8000)}
\`\`\`

Instruction: ${instruction}

Provide:
1. A brief explanation of the changes you'll make
2. The COMPLETE updated file content (not just a diff)

Format your response as:
EXPLANATION:
<your explanation here>

UPDATED_FILE:
\`\`\`${ext}
<complete updated file content>
\`\`\``;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });

    clearTimeout(timer);
    if (!upstream.ok) throw new Error(`DeepSeek HTTP ${upstream.status}`);

    const data = await upstream.json();
    const raw = data?.choices?.[0]?.message?.content || '';

    // Parse explanation and code
    const explMatch = raw.match(/EXPLANATION:\s*([\s\S]*?)(?=UPDATED_FILE:|$)/i);
    const codeMatch = raw.match(/```(?:\w+)?\s*([\s\S]*?)```/s);

    res.json({
      explanation: (explMatch?.[1] || '').trim(),
      suggestedContent: (codeMatch?.[1] || '').trim(),
      raw,
    });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI response timed out.' });
    console.error('[admin/ai-edit] error:', err.message);
    res.status(500).json({ error: 'AI edit service error.' });
  }
});

/* ── POST /admin/system/test-keys ───────────────────────────── */
router.post('/system/test-keys', adminAuthMiddleware, async (req, res) => {
  const results = {};

  // Test DeepSeek
  const dsKey = process.env.DEEPSEEK_API_KEY;
  results.deepseek = dsKey ? 'configured' : 'missing';

  // Test R2
  const { isR2Configured } = await import('../utils/r2.js');
  results.r2 = isR2Configured() ? 'configured' : 'missing';

  // Test HuggingFace
  const { isHfConfigured } = await import('../utils/ai.js');
  results.huggingface = isHfConfigured() ? 'configured' : 'missing';

  // Test Firebase
  const { isFirebaseConfigured } = await import('../utils/firebase-admin.js');
  results.firebase = isFirebaseConfigured() ? 'configured' : 'missing';

  // JWT secret strength
  const jwtSecret = process.env.JWT_SECRET;
  results.jwt_secret = !jwtSecret ? 'missing (using dev default!)' :
                       jwtSecret.length < 16 ? 'weak (too short)' : 'ok';

  // Admin password
  results.admin_password = process.env.ADMIN_PASSWORD ? 'set' : 'missing';

  res.json({ keys: results });
});

/* ── POST /admin/system/clear-uploads ──────────────────────── */
router.post('/system/clear-uploads', adminAuthMiddleware, async (req, res) => {
  try {
    const { sweepUploads } = await import('../utils/upload.js');
    sweepUploads();
    res.json({ ok: true, message: 'Upload sweep triggered.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
