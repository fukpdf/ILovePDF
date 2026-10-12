// Admin authentication middleware.
// Verifies the admin session cookie and attaches req.adminUser.
import db from '../utils/db.js';

const COOKIE = 'ilovepdf_admin';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours absolute
const IDLE_TTL_MS    = 30 * 60 * 1000;      // 30 min idle timeout

export function adminGuard(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return sendUnauth(req, res);

  const now = Date.now();
  const session = db.prepare('SELECT * FROM adm_sessions WHERE token=?').get(token);
  if (!session) return sendUnauth(req, res);

  // Absolute TTL
  if (now - session.created_at * 1000 > SESSION_TTL_MS) {
    db.prepare('DELETE FROM adm_sessions WHERE token=?').run(token);
    return sendUnauth(req, res);
  }
  // Idle TTL
  if (now - session.last_active * 1000 > IDLE_TTL_MS) {
    db.prepare('DELETE FROM adm_sessions WHERE token=?').run(token);
    return sendUnauth(req, res);
  }

  // Refresh last_active
  db.prepare('UPDATE adm_sessions SET last_active=? WHERE token=?')
    .run(Math.floor(now / 1000), token);

  const user = db.prepare('SELECT id, username FROM adm_users WHERE id=?').get(session.user_id);
  if (!user) return sendUnauth(req, res);

  req.adminUser = user;
  req.adminSession = token;
  next();
}

function sendUnauth(req, res) {
  if (req.path?.startsWith('/api/admin')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  return res.redirect('/admin/login');
}

export function getSessionToken(req) { return req.cookies?.[COOKIE]; }
export const ADMIN_COOKIE = COOKIE;
