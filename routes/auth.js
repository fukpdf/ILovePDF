import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../utils/db.js';
import { verifyIdToken, isFirebaseConfigured } from '../utils/firebase-admin.js';

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'ilovepdf_token';
const QUOTA = 2 * 1024 * 1024 * 1024; // 2 GB
const VERIFY_TTL_MS = 30 * 60 * 1000; // confirmation link valid 30 min

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name,
    storage_quota: u.storage_quota,
    storage_used:  u.storage_used,
    avatar_url:    u.avatar_url || null,
  };
}

router.post('/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (password.length < 6)             return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (email, name, password_hash, storage_quota, storage_used)
    VALUES (?, ?, ?, ?, 0)
  `).run(email.toLowerCase(), name.trim(), hash, QUOTA);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.cookie(COOKIE, sign(user), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  res.cookie(COOKIE, sign(user), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

/* ─────────── Email-confirmation signup flow ─────────── */

// Step 1 — user enters email, server creates a confirmation token + link.
// (No email service configured on this plan — server returns the link directly.)
router.post('/auth/start-signup', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM pending_signups WHERE email=? OR expires_at<?').run(email, now);
  db.prepare(`
    INSERT INTO pending_signups (token, email, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, email, now + VERIFY_TTL_MS, now);

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const link  = `${proto}://${host}/verify-signup?token=${token}`;
  // emailDelivered:false signals the frontend to show the link inline (demo mode).
  res.json({ ok: true, email, link, emailDelivered: false });
});

// Step 2 — frontend (verify-signup.html) validates the token before showing the form.
router.get('/auth/verify-token', (req, res) => {
  const row = db.prepare('SELECT email, expires_at FROM pending_signups WHERE token=?').get(req.query.token);
  if (!row)                       return res.status(404).json({ error: 'This confirmation link is invalid.' });
  if (row.expires_at < Date.now()) return res.status(410).json({ error: 'This confirmation link has expired. Please start over.' });
  res.json({ ok: true, email: row.email });
});

// Step 3 — user submits first/last name + password (twice). Account created, auto-login.
router.post('/auth/complete-signup', (req, res) => {
  const { token, firstName, lastName, password, confirmPassword } = req.body || {};
  if (!token)                                return res.status(400).json({ error: 'Missing confirmation token.' });
  if (!firstName || !lastName)               return res.status(400).json({ error: 'First and last name are required.' });
  if (!password || password.length < 6)      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword)          return res.status(400).json({ error: 'Passwords do not match.' });

  const row = db.prepare('SELECT email, expires_at FROM pending_signups WHERE token=?').get(token);
  if (!row)                       return res.status(404).json({ error: 'Confirmation link is invalid.' });
  if (row.expires_at < Date.now()) return res.status(410).json({ error: 'Confirmation link has expired.' });

  if (db.prepare('SELECT id FROM users WHERE email=?').get(row.email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const fullName = `${String(firstName).trim()} ${String(lastName).trim()}`.trim();
  const hash     = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (email, name, password_hash, storage_quota, storage_used)
    VALUES (?, ?, ?, ?, 0)
  `).run(row.email, fullName, hash, QUOTA);

  db.prepare('DELETE FROM pending_signups WHERE token=?').run(token);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.cookie(COOKIE, sign(user), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

/* ─────────── Firebase Auth bridge ──────────────────────────────────────
   The browser signs in with Firebase (Google or email/password) and POSTs
   the resulting ID token here. We verify it with the Admin SDK, upsert a
   row in our SQLite users table, and issue the same ilovepdf_token JWT
   cookie used by the rest of the app — so existing tools, usage tracking,
   storage quotas etc. continue to work unchanged. */
router.post('/auth/firebase', async (req, res) => {
  if (!isFirebaseConfigured()) {
    return res.status(503).json({ error: 'Firebase Auth is not configured on the server.' });
  }
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
  let decoded;
  try {
    decoded = await verifyIdToken(idToken);
  } catch (e) {
    console.error('[auth] firebase verify failed:', e.message);
    return res.status(401).json({ error: 'Invalid Firebase token.' });
  }
  const email = (decoded.email || `${decoded.uid}@firebase.local`).toLowerCase();
  const name  = decoded.name || decoded.displayName || email.split('@')[0];

  let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    const placeholderHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 8);
    const info = db.prepare(`
      INSERT INTO users (email, name, password_hash, storage_quota, storage_used, avatar_url)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(email, name, placeholderHash, QUOTA, decoded.picture || null);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  } else if (decoded.picture && user.avatar_url !== decoded.picture) {
    db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(decoded.picture, user.id);
    user.avatar_url = decoded.picture;
  }
  res.cookie(COOKIE, sign(user), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

// Optional: simulate consuming or releasing storage
router.post('/auth/storage', authMiddleware, (req, res) => {
  const delta = parseInt(req.body?.delta, 10);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const next = Math.max(0, Math.min(user.storage_quota, user.storage_used + delta));
  db.prepare('UPDATE users SET storage_used=? WHERE id=?').run(next, user.id);
  res.json({ user: publicUser({ ...user, storage_used: next }) });
});

export default router;
