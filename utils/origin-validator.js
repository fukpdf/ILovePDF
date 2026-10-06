// utils/origin-validator.js — Phase 4 / Task 3 (Server-Side Origin Validation)
// =============================================================================
// Shared origin validation utilities for API route protection.
//
// Design principles:
//   - Soft-fail in development (localhost, Replit dev domains, ALLOW_ANY mode)
//   - Strict enforcement in production with known-origin configuration
//   - Telemetry logging for all violations (no silent drops)
//   - Replay-safe: does not modify request state
//
// Usage:
//   import { createApiOriginGuard } from './utils/origin-validator.js';
//   app.use('/api', createApiOriginGuard({ allowAny, isDev }));
// =============================================================================

// ── Allowed production origins ────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  'https://ilovepdf.cyou',
  'https://www.ilovepdf.cyou',
  'https://ilovepdf-web.web.app',
  'https://ilovepdf-web.firebaseapp.com',
]);

// ── Allowed development origin patterns ───────────────────────────────────────
const DEV_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  /^https:\/\/[\w-]+\.replit\.dev$/,
  /^https:\/\/[\w-]+\.repl\.co$/,
  /^https:\/\/[\w-]+\.replit\.app$/,
  /^https:\/\/[\w-]+\.repl\.run$/,
];

// ── Violation telemetry log (in-memory, bounded) ──────────────────────────────
const _violations = [];
const MAX_VIOLATIONS = 200;

function _recordViolation(origin, path, reason) {
  const entry = {
    ts:     Date.now(),
    origin: origin || '(none)',
    path:   path   || '/',
    reason,
  };
  if (_violations.length >= MAX_VIOLATIONS) _violations.shift();
  _violations.push(entry);
  console.warn('[OriginGuard] violation:', reason, '| origin:', entry.origin, '| path:', path);
}

// ── Public validators ─────────────────────────────────────────────────────────

/**
 * Returns true if the given origin is allowed for API access.
 * @param {string|undefined} origin — value of the Origin request header
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true;                        // same-origin (no Origin header)
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (DEV_PATTERNS.some(p => p.test(origin))) return true;
  return false;
}

/**
 * Returns true if the current host looks like a development/Replit environment.
 * @param {import('express').Request} req
 */
export function isDevRequest(req) {
  const host = req.hostname || '';
  return (
    host === 'localhost'   ||
    host === '127.0.0.1'  ||
    /\.replit\.dev$/.test(host) ||
    /\.repl\.co$/.test(host)    ||
    /\.replit\.app$/.test(host) ||
    process.env.NODE_ENV !== 'production'
  );
}

/**
 * Creates an Express middleware that guards API routes against unknown origins.
 *
 * @param {object} opts
 * @param {boolean} opts.allowAny  — if true, all origins are allowed (dev/open mode)
 * @param {boolean} [opts.logOnly] — if true, log violations but never block
 * @returns {import('express').RequestHandler}
 */
export function createApiOriginGuard({ allowAny = false, logOnly = false } = {}) {
  return function apiOriginGuard(req, res, next) {
    // If CORS is in open mode (ALLOWED_ORIGINS=*), skip enforcement.
    if (allowAny) return next();

    const origin = req.headers.origin;
    const isDev  = isDevRequest(req);

    // Same-origin requests (no Origin header) always pass.
    if (!origin) return next();

    // Check allowlist.
    if (isAllowedOrigin(origin)) return next();

    // Violation detected.
    _recordViolation(origin, req.path, isDev ? 'dev-soft-fail' : 'blocked');

    // In development or log-only mode: warn but allow through.
    if (isDev || logOnly) {
      console.warn('[OriginGuard] dev soft-fail — allowing:', origin);
      res.setHeader('X-Origin-Warning', 'origin-not-in-allowlist');
      return next();
    }

    // Production: block.
    return res.status(403).json({
      error:  'unauthorized_origin',
      origin: origin,
      hint:   'API access is restricted to approved origins.',
    });
  };
}

/**
 * Returns recent violations (for admin dashboard / telemetry export).
 */
export function getViolations() {
  return _violations.slice();
}
