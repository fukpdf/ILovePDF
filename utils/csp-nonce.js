// utils/csp-nonce.js
// Phase 2 — Enterprise CSP Nonce + Secure Runtime Execution Layer
//
// Responsibilities:
//   1. Generate cryptographically secure per-request nonces
//   2. Provide an HTML injection helper for pre-built template strings
//   3. Export Express middleware that stamps res.locals.nonce on every request
//
// Nonce strategy:
//   Pre-built HTML templates (CATEGORY_HTML, COMPARISON_HTML, etc.) are built
//   once at boot with the placeholder literal  __CSP_NONCE__  in every
//   nonce="..." attribute. Per-request, injectNonce() replaces the placeholder
//   with the real nonce. Cost per request: one RegExp replace on ≤100 KB string
//   — immeasurably fast vs. network latency.

import { randomBytes } from 'crypto';

// ── Nonce generation ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure 128-bit nonce encoded as URL-safe base64.
 * A fresh nonce is generated for every HTTP request.
 * @returns {string}
 */
export function generateNonce() {
  return randomBytes(16).toString('base64url');
}

// ── Template injection ────────────────────────────────────────────────────────

const NONCE_PLACEHOLDER = '__CSP_NONCE__';
const NONCE_RE          = /__CSP_NONCE__/g;

/**
 * Replace all  __CSP_NONCE__  occurrences in an HTML string with the real nonce.
 * Safe to call on HTML that has no placeholder — returns the string unchanged.
 *
 * @param {string} html
 * @param {string} nonce
 * @returns {string}
 */
export function injectNonce(html, nonce) {
  if (!html || !nonce) return html;
  return html.replace(NONCE_RE, nonce);
}

/**
 * Wrap an inline <script> body with a nonce attribute.
 * Returns the ready-to-inject <script> tag.
 *
 * @param {string} body   - The raw JS to embed (no <script> tags)
 * @param {string} nonce  - The per-request nonce (may be __CSP_NONCE__ for templates)
 * @returns {string}
 */
export function nonceScript(body, nonce = NONCE_PLACEHOLDER) {
  return `<script nonce="${nonce}">${body}</script>`;
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Express middleware: generate a fresh nonce and attach it to res.locals.nonce.
 * Must be mounted BEFORE any route or middleware that reads res.locals.nonce.
 */
export function nonceMiddleware(req, res, next) {
  res.locals.nonce = generateNonce();
  next();
}

export { NONCE_PLACEHOLDER };
