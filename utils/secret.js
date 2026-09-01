// Centralized production secret handling.
// Production MUST fail closed when JWT/session secret is absent or weak.
import crypto from 'node:crypto';

const DEV_SECRET = process.env.ILOVEPDF_DEV_SECRET || crypto.randomBytes(32).toString('hex');

export function getJwtSecret() {
  const configured = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET or SESSION_SECRET must be configured with at least 32 characters in production.');
  }
  return DEV_SECRET;
}

export const JWT_SECRET = getJwtSecret();
