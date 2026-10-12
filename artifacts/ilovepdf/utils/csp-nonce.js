import crypto from 'crypto';

export function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

export function injectNonce(html, nonce) {
  if (!html) return '';
  return html.replace(/__CSP_NONCE__/g, nonce || '');
}
