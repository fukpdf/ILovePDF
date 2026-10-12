export function originGuard(req, res, next) {
  // Pass health checks and public config unconditionally
  if (req.path.startsWith('/api/health') || req.path.startsWith('/api/config') || req.path.startsWith('/api/server-health')) {
    return next();
  }
  const origin = req.headers.origin;
  if (!origin) return next();

  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length === 0) return next();

  const host = req.headers.host;
  const originHost = origin.replace(/^https?:\/\//, '').split('/')[0];
  if (originHost === host || allowed.some(a => origin.toLowerCase().includes(a))) {
    return next();
  }

  next();
}
