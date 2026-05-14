// Admin page router — serves the login page, setup, and the dashboard SPA.
// All actual CRUD endpoints live in routes/admin-api.js.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import db from '../utils/db.js';
import '../utils/admin-db.js'; // ensure tables exist
import { adminGuard, ADMIN_COOKIE } from '../middleware/admin-guard.js';
import { auditLog } from '../utils/admin-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.join(__dirname, '..', 'public', 'admin');

const router = express.Router();

// ── Rate limiter: 10 login attempts per 15 min per IP ────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (_req, res) =>
    res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' }),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

// ── Cookie options ────────────────────────────────────────────────────────────
function cookieOpts(req) {
  const isSecure = req.secure ||
    (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return {
    httpOnly:  true,
    sameSite:  'lax',
    secure:    isSecure,
    maxAge:    2 * 60 * 60 * 1000, // 2 hours
    path:      '/',
  };
}

// ── Setup page — only accessible when no admin exists ────────────────────────
router.get('/admin/setup', (req, res) => {
  const adminExists = db.prepare('SELECT 1 FROM adm_users LIMIT 1').get();
  if (adminExists) return res.redirect('/admin');
  res.sendFile(path.join(ADMIN_DIR, 'setup.html'));
});

router.post('/api/admin/auth/setup', loginLimiter, express.json(), (req, res) => {
  const adminExists = db.prepare('SELECT 1 FROM adm_users LIMIT 1').get();
  if (adminExists) return res.status(403).json({ error: 'Admin already configured.' });

  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const err = validatePassword(password);
  if (err) return res.status(400).json({ error: err });

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–32 alphanumeric characters.' });

  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare(
    'INSERT INTO adm_users (username, password_hash) VALUES (?,?)'
  ).run(username, hash);

  const token = createSession(info.lastInsertRowid, req);
  res.cookie(ADMIN_COOKIE, token, cookieOpts(req));
  auditLog(info.lastInsertRowid, 'SETUP', 'Admin account created', req.ip);
  res.json({ ok: true });
});

// ── Login page ────────────────────────────────────────────────────────────────
router.get('/admin/login', (req, res) => {
  const adminExists = db.prepare('SELECT 1 FROM adm_users LIMIT 1').get();
  if (!adminExists) return res.redirect('/admin/setup');
  res.sendFile(path.join(ADMIN_DIR, 'login.html'));
});

// ── Login API ─────────────────────────────────────────────────────────────────
router.post('/api/admin/auth/login', loginLimiter, express.json(), (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  const now = Date.now();

  // Check lockout — 5 failed attempts in 15 min
  const windowStart = Math.floor((now - 15 * 60 * 1000) / 1000);
  const failedCount = db.prepare(
    'SELECT COUNT(*) as c FROM adm_login_attempts WHERE ip=? AND success=0 AND attempted_at>?'
  ).get(ip, windowStart)?.c || 0;

  if (failedCount >= 5) {
    recordAttempt(ip, username, false);
    return res.status(429).json({
      error: 'Account locked due to too many failed attempts. Please wait 15 minutes.',
    });
  }

  if (!username || !password) {
    recordAttempt(ip, username, false);
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const user = db.prepare('SELECT * FROM adm_users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordAttempt(ip, username, false);
    auditLog(null, 'LOGIN_FAIL', `Failed login for "${username}"`, ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  recordAttempt(ip, username, true);
  db.prepare('UPDATE adm_users SET last_login=? WHERE id=?')
    .run(Math.floor(now / 1000), user.id);

  const token = createSession(user.id, req);
  res.cookie(ADMIN_COOKIE, token, cookieOpts(req));
  auditLog(user.id, 'LOGIN', 'Admin login', ip);
  res.json({ ok: true });
});

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/api/admin/auth/logout', (req, res) => {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (token) {
    db.prepare('DELETE FROM adm_sessions WHERE token=?').run(token);
    const uid = db.prepare('SELECT user_id FROM adm_sessions WHERE token=?').get(token)?.user_id;
    auditLog(uid, 'LOGOUT', '', req.ip);
  }
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ── Session check (for frontend polling) ─────────────────────────────────────
router.get('/api/admin/auth/me', adminGuard, (req, res) => {
  res.json({ username: req.adminUser.username, id: req.adminUser.id });
});

// ── Dashboard SPA (all /admin/* routes) ──────────────────────────────────────
router.get('/admin', adminGuard, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});
router.get('/admin/{*path}', adminGuard, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function createSession(userId, req) {
  const token = crypto.randomBytes(40).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO adm_sessions (token, user_id, created_at, last_active, ip, user_agent)
    VALUES (?,?,?,?,?,?)
  `).run(token, userId, now, now, req.ip, req.headers['user-agent']?.slice(0, 200) || '');
  return token;
}

function recordAttempt(ip, username, success) {
  db.prepare(
    'INSERT INTO adm_login_attempts (ip, username, attempted_at, success) VALUES (?,?,?,?)'
  ).run(ip, username || '', Math.floor(Date.now() / 1000), success ? 1 : 0);
}

function validatePassword(pw) {
  if (!pw || pw.length < 10)         return 'Password must be at least 10 characters.';
  if (!/[A-Z]/.test(pw))             return 'Password must include at least one uppercase letter.';
  if (!/[a-z]/.test(pw))             return 'Password must include at least one lowercase letter.';
  if (!/[0-9]/.test(pw))             return 'Password must include at least one number.';
  if (!/[^A-Za-z0-9]/.test(pw))      return 'Password must include at least one special character.';
  return null;
}

export { validatePassword };
export default router;
