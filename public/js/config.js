/* Runtime config — loaded on every page BEFORE any other script.
   Determines the backend API base URL so the frontend (which may be on
   Firebase Hosting) can reach the backend (which runs the Express
   server with all the /api routes).

   Priority:
     1. window.API_BASE_OVERRIDE  (set inline in HTML for testing)
     2. localStorage 'ilovepdf:api_base'  (developer override)
     3. Hard-coded production map by hostname
     4. Empty string -> same origin (works in dev or when backend serves the frontend)
*/
(function () {
  // ── Production frontend hosts → backend URL ─────────────────────────────
  // Add your backend URL here once it's deployed (Replit / Railway / Render / etc).
  // Example: 'https://ilovepdf-api.up.railway.app'
  const HOST_TO_BACKEND = {
    'ilovepdf.cyou':                 '', // ← set to your backend URL when known
    'www.ilovepdf.cyou':             '',
    'ilovepdf-web.web.app':          '',
    'ilovepdf-web.firebaseapp.com':  '',
  };

  function resolveBase() {
    if (typeof window.API_BASE_OVERRIDE === 'string') return window.API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    const host = (location.hostname || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(HOST_TO_BACKEND, host)) {
      return HOST_TO_BACKEND[host] || '';
    }
    return ''; // same-origin (dev, replit dev domain, or backend-served frontend)
  }

  const base = resolveBase().replace(/\/+$/, ''); // strip trailing slashes
  window.API_BASE = base;

  // Build an absolute API URL. Always pass paths starting with '/api/...'.
  window.apiUrl = function (path) {
    if (!path) return base;
    if (/^https?:\/\//i.test(path)) return path;
    return base + (path.startsWith('/') ? path : '/' + path);
  };

  // Convenience wrapper: same as fetch() but auto-prefixes API_BASE for /api/... paths
  // and always includes credentials so the auth cookie travels cross-origin.
  window.apiFetch = function (path, opts) {
    const url = path.startsWith('/api/') ? window.apiUrl(path) : path;
    const o = Object.assign({ credentials: 'include' }, opts || {});
    return fetch(url, o);
  };
})();
