// Usage tracking + per-user / per-IP daily limits.
// Schema mirrors the requested Firebase shape (user_id, ip, daily_usage_mb,
// file_count, last_reset). We persist in our SQLite DB so existing auth keeps
// working. Migrating to Firebase Auth would be a separate project (it would
// invalidate every existing JWT cookie / user row).
import jwt from 'jsonwebtoken';
import db from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'ilovepdf_token';

export const LIMITS = {
  // anonymous: 10 files / day, 200 MB / day
  anon: { files: 10, bytes: 200 * 1024 * 1024, perFile: 100 * 1024 * 1024 },
  // logged-in: 1 GB / day, 50 MB / file
  user: { files: 1000, bytes: 1024 * 1024 * 1024, perFile: 50 * 1024 * 1024 },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER,
    ip              TEXT NOT NULL,
    daily_usage_mb  REAL NOT NULL DEFAULT 0,
    daily_bytes     INTEGER NOT NULL DEFAULT 0,
    file_count      INTEGER NOT NULL DEFAULT 0,
    last_reset      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_ip   ON usage_log(ip);
`);

function today() { return new Date().toISOString().slice(0, 10); }
function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0].trim())
      || req.ip
      || req.socket?.remoteAddress
      || '0.0.0.0';
}
function readUserFromCookie(req) {
  const tok = req.cookies?.[COOKIE];
  if (!tok) return null;
  try { return jwt.verify(tok, SECRET); } catch { return null; }
}

function fetchOrCreateRow(userId, ip) {
  const date = today();
  let row;
  if (userId) {
    row = db.prepare('SELECT * FROM usage_log WHERE user_id=?').get(userId);
    if (!row) {
      const info = db.prepare(
        'INSERT INTO usage_log (user_id, ip, last_reset) VALUES (?,?,?)'
      ).run(userId, ip, date);
      row = db.prepare('SELECT * FROM usage_log WHERE id=?').get(info.lastInsertRowid);
    }
  } else {
    row = db.prepare('SELECT * FROM usage_log WHERE user_id IS NULL AND ip=?').get(ip);
    if (!row) {
      const info = db.prepare(
        'INSERT INTO usage_log (user_id, ip, last_reset) VALUES (NULL, ?, ?)'
      ).run(ip, date);
      row = db.prepare('SELECT * FROM usage_log WHERE id=?').get(info.lastInsertRowid);
    }
  }
  // Daily reset (24-hour window driven by date string)
  if (row.last_reset !== date) {
    db.prepare('UPDATE usage_log SET daily_usage_mb=0, daily_bytes=0, file_count=0, last_reset=? WHERE id=?')
      .run(date, row.id);
    row.daily_usage_mb = 0; row.daily_bytes = 0; row.file_count = 0; row.last_reset = date;
  }
  return row;
}

function blocked(res, message, isAnonymous, status = 429) {
  return res.status(status).json({ error: 'LIMIT_REACHED', message, isAnonymous });
}

// Single middleware that:
//  1. Pre-blocks if the user is already over today's quota,
//  2. Pre-blocks if the upload Content-Length would push them over their daily
//     bytes OR exceeds the per-file cap (logged-in 50MB), BEFORE multer reads,
//  3. Hooks `res.on('finish')` to record actual usage on a successful response.
export function checkUsage(req, res, next) {
  const user = readUserFromCookie(req);
  const ip   = clientIp(req);
  const row  = fetchOrCreateRow(user?.id || null, ip);
  const limits = user ? LIMITS.user : LIMITS.anon;

  // (1) Already over the daily quotas?
  if (row.file_count >= limits.files) {
    return blocked(res,
      user ? `You have reached today's file limit (${limits.files}). Resets in 24 hours.`
           : 'You have reached the free daily limit (10 files). Sign up to continue.',
      !user);
  }
  if (row.daily_bytes >= limits.bytes) {
    const totalMb = Math.round(limits.bytes / (1024 * 1024));
    return blocked(res,
      user ? `You have reached today's data quota (${totalMb} MB). Resets in 24 hours.`
           : `You have reached the free daily data limit (${totalMb} MB). Sign up to continue.`,
      !user);
  }

  // (2) Cheap pre-flight using Content-Length (multipart adds a few KB overhead;
  //     close enough to bounce obvious offenders before reading the body).
  const contentLen = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLen) {
    if (contentLen > limits.perFile + 64 * 1024 /* multipart slack */) {
      const cap = Math.round(limits.perFile / (1024 * 1024));
      return blocked(res,
        user ? `File too large. Logged-in users may upload up to ${cap} MB per file.`
             : `File too large. Maximum ${cap} MB per file for free users — sign up for higher limits.`,
        !user, 413);
    }
    if (row.daily_bytes + contentLen > limits.bytes) {
      return blocked(res,
        user ? 'Processing this file would exceed your 1 GB daily quota.'
             : 'Processing this file would exceed the free 200 MB daily limit. Sign up to continue.',
        !user);
    }
  }

  // (3) Record actual usage AFTER the response is sent (multer has parsed by then)
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const files = [].concat(req.file || []).concat(req.files || []);
    const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0);
    const fileCount  = files.length || 1;
    const mb = totalBytes / (1024 * 1024);
    try {
      db.prepare(`
        UPDATE usage_log SET
          daily_usage_mb = daily_usage_mb + ?,
          daily_bytes    = daily_bytes + ?,
          file_count     = file_count + ?
        WHERE id=?
      `).run(mb, totalBytes, fileCount, row.id);
    } catch (e) {
      console.error('[usage] record error:', e.message);
    }
  });

  next();
}

// Kept for backward-compat (server.js mounts it as a no-op tail middleware)
export function enforcePerFile(_req, _res, next) { next(); }
