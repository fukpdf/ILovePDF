// utils/origin-guard.js — Phase 4 / Task 3 (Server-Side Origin Validation)
// =============================================================================
// Express middleware that validates the Origin, Referer, and Host headers on
// sensitive routes (API, telemetry, analytics, worker manifests, AI routes).
//
// Design:
//   • Allowlist-based — only known-good origins pass
//   • Referer checked as secondary signal (same rules, path stripped)
//   • Host header checked against expected deployment hosts
//   • Firebase sub-domain requests allowed for identity flows
//   • Dev / localhost always passes (NODE_ENV !== 'production')
//   • Violations: 403 JSON response + telemetry record (non-crashing)
//   • Soft mode: when ORIGIN_GUARD_SOFT=1 — logs but does not block
//
// Allowed origins (hard-coded + ALLOWED_ORIGINS env):
//   https://ilovepdf.cyou
//   https://www.ilovepdf.cyou
//   https://ilovepdf-web.web.app
//   https://ilovepdf-web.firebaseapp.com
//   Same-origin (no Origin header on same-origin requests)
//
// Usage:
//   import { originGuard } from './utils/origin-guard.js';
//   app.use('/api', originGuard);
// =============================================================================

const PRODUCTION_HOSTS = new Set([
  'ilovepdf.cyou',
  'www.ilovepdf.cyou',
]);

const ALLOWED_ORIGINS = new Set([
  'https://ilovepdf.cyou',
  'https://www.ilovepdf.cyou',
  'https://ilovepdf-web.web.app',
  'https://ilovepdf-web.firebaseapp.com',
]);

// Firebase Identity Platform subdomains (identity flows, not data routes)
const FIREBASE_ORIGIN_RE = /^https:\/\/[a-zA-Z0-9-]+\.googleapis\.com$/;
const FIREBASE_REFERER_RE = /^https:\/\/identitytoolkit\.googleapis\.com\//;

// Env-based extra origins (comma-separated ALLOWED_ORIGINS env)
const ENV_EXTRA = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(s => s && s !== '*');
ENV_EXTRA.forEach(o => ALLOWED_ORIGINS.add(o));

const IS_PROD  = process.env.NODE_ENV === 'production';
const SOFT     = process.env.ORIGIN_GUARD_SOFT === '1';

// Routes that require strict origin checking
// (applied only when mounted via app.use('/api', originGuard))
const STRICT_PREFIXES = [
  '/security-telemetry',
  '/ai/',
  '/r2/',
  '/auth/',
  '/admin',
];

// Routes that are public GET endpoints — never blocked
const PUBLIC_GET_PREFIXES = [
  '/health',
  '/geo',
  '/config/',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _extractOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin; // 'https://host:port'
  } catch (_) { return null; }
}

function _isLocalhost(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(origin);
}

function _isReplitDev(origin) {
  if (!origin) return false;
  // Replit dev domain: *.replit.dev / *.repl.co
  return /^https:\/\/[a-zA-Z0-9-]+\.(replit\.dev|repl\.co)(:\d+)?$/.test(origin);
}

function _isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin requests have no Origin header
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (_isLocalhost(origin)) return true;
  if (!IS_PROD && _isReplitDev(origin)) return true;
  if (!IS_PROD) return true; // dev environment: always allow
  if (FIREBASE_ORIGIN_RE.test(origin)) return true;
  return false;
}

function _isAllowedReferer(referer) {
  if (!referer) return true; // no referer → allow (direct calls, curl, etc.)
  const origin = _extractOrigin(referer);
  if (!origin) return true; // malformed referer → don't block, just log
  if (FIREBASE_REFERER_RE.test(referer)) return true;
  return _isAllowedOrigin(origin);
}

function _isStrictRoute(path) {
  return STRICT_PREFIXES.some(p => path.startsWith(p));
}

function _isPublicGet(path, method) {
  if (method !== 'GET') return false;
  return PUBLIC_GET_PREFIXES.some(p => path.startsWith(p));
}

function _record(type, data) {
  try {
    // Server-side logging only (telemetry goes via the client pipeline on the browser)
    console.warn(`[OriginGuard] ${type}:`, JSON.stringify(data));
  } catch (_) {}
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function originGuard(req, res, next) {
  // Always allow OPTIONS (pre-flight is handled by CORS middleware)
  if (req.method === 'OPTIONS') return next();

  // Always allow public GET endpoints
  if (_isPublicGet(req.path, req.method)) return next();

  const origin  = req.headers['origin']  || null;
  const referer = req.headers['referer'] || null;
  const host    = req.headers['host']    || '';

  // Extract bare hostname (strip port)
  const hostname = host.split(':')[0].toLowerCase();

  // Host validation — only in production
  if (IS_PROD && hostname && !PRODUCTION_HOSTS.has(hostname)) {
    // Allow Replit deployment domains
    if (!hostname.endsWith('.replit.app') && !hostname.endsWith('.repl.co')) {
      _record('host-violation', { host, path: req.path });
      if (!SOFT) {
        return res.status(403).json({
          error: 'origin_not_allowed',
          hint:  'Request origin does not match deployment.',
        });
      }
    }
  }

  // Origin check
  const originOk = _isAllowedOrigin(origin);

  // Referer check (only on strict routes as secondary signal)
  const strictRoute = _isStrictRoute(req.path);
  const refererOk   = strictRoute ? _isAllowedReferer(referer) : true;

  if (!originOk || !refererOk) {
    const violation = {
      origin:  origin  || '(none)',
      referer: referer || '(none)',
      host,
      path:    req.path,
      method:  req.method,
    };
    _record('origin-violation', violation);

    if (!SOFT) {
      return res.status(403).json({
        error: 'origin_not_allowed',
        hint:  'Cross-origin request blocked.',
      });
    }
    // Soft mode: log and allow
    console.warn('[OriginGuard] SOFT MODE — would have blocked:', violation);
  }

  next();
}

// ── Strict variant for highest-sensitivity routes ─────────────────────────────
// Same as originGuard but also rejects requests with NO origin on non-GET methods.
export function strictOriginGuard(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.method === 'GET')     return originGuard(req, res, next);

  const origin = req.headers['origin'] || null;
  if (!origin && IS_PROD) {
    _record('missing-origin', { path: req.path, method: req.method });
    if (!SOFT) {
      return res.status(403).json({
        error: 'origin_required',
        hint:  'Origin header is required for this endpoint.',
      });
    }
  }
  return originGuard(req, res, next);
}
