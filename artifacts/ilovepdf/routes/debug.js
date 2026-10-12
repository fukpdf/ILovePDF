// routes/debug.js — Arc 10D Admin Observability Dashboard route
// Production-gated: requires an authenticated admin session. Development-only
// hosts may still use the dashboard without an admin session.

import express from 'express';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';
import { adminGuard } from '../middleware/admin-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router    = express.Router();
const DEBUG_HTML = path.join(__dirname, '..', 'public', 'debug.html');

function isDevelopmentHost(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' ||
    host.endsWith('.replit.dev') || host.endsWith('.repl.co');
}

router.get('/', (req, res, next) => {
  // Never allow a public query parameter to bypass the production gate.
  // Development hosts remain convenient for local/debug work.
  if (!isDevelopmentHost(req)) return adminGuard(req, res, next);
  return next();
}, (req, res) => {
  const buildId = res.locals.buildId || 'unknown';

  if (!fs.existsSync(DEBUG_HTML)) {
    return res.status(404).send('Debug dashboard not found.');
  }

  let html = fs.readFileSync(DEBUG_HTML, 'utf8');
  html = html.replace(/__BUILD_ID__/g, buildId);

  res.set({
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag':  'noindex, nofollow',
    'X-Frame-Options': 'DENY',
  });
  res.send(html);
});

export default router;
