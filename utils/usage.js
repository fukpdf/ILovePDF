// Usage compatibility layer.
// PDF processing has no artificial daily, aggregate, or per-file quota.
// Keep the exported API for older routes while allowing every valid request through.
export const LIMITS = Object.freeze({
  guest: { files: Infinity, bytes: Infinity, perFile: Infinity },
  free: { files: Infinity, bytes: Infinity, perFile: Infinity },
  premium: { files: Infinity, bytes: Infinity, perFile: Infinity },
  anon: { files: Infinity, bytes: Infinity, perFile: Infinity },
  user: { files: Infinity, bytes: Infinity, perFile: Infinity },
});
export function checkUsage(_req, _res, next) { next(); }
export function enforcePerFile(_req, _res, next) { next(); }
