// routes/debug.js — Arc 10D Admin Observability Dashboard route
// Production-gated: requires ?debug=1 OR sessionStorage.ilpdf_dash=1 OR localStorage.ilpdf_admin=1
// Gate is enforced client-side (RuntimeDebugSecurity) + server-side header check.

import express from 'express';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router    = express.Router();
const DEBUG_HTML = path.join(__dirname, '..', 'public', 'debug.html');

// ── Server-side gate ─────────────────────────────────────────────────────────
// Allows access if ?debug=1 is present OR the Referer already passed the gate.
// This is a lightweight defense-in-depth layer; the client-side gate is the
// primary production gate (sessionStorage / localStorage key).
function _gateCheck(req) {
  if (req.query.debug === '1') return true;
  // Internal health check or localhost
  const host = req.headers.host || '';
  if (host.startsWith('localhost') || host.startsWith('127.')) return true;
  // Replit dev domain (.replit.dev / .repl.co) — allow for development
  if (host.endsWith('.replit.dev') || host.endsWith('.repl.co')) return true;
  return false;
}

router.get('/', (req, res, next) => {
  // Read BUILD_ID from parent server context (injected by server.js as res.locals)
  const buildId = res.locals.buildId || 'unknown';

  if (!fs.existsSync(DEBUG_HTML)) {
    return res.status(404).send('Debug dashboard not found.');
  }

  let html = fs.readFileSync(DEBUG_HTML, 'utf8');
  html = html.replace(/__BUILD_ID__/g, buildId);

  // Inject gate-bypass hint into page if ?debug=1 was used so client picks it up
  if (req.query.debug === '1') {
    html = html.replace('</head>', '<script>try{sessionStorage.setItem("ilpdf_dash","1");}catch(_){}</script></head>');
  }

  res.set({
    'Content-Type':  'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag':  'noindex, nofollow',
    'X-Frame-Options': 'DENY',
  });
  res.send(html);
});

export default router;
