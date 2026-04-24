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
  // Replace this with your production backend URL once you publish the
  // Express server (e.g. https://ilovepdf-api.<your-name>.repl.co or a
  // Railway/Render/Fly URL). The current value points at the Replit dev
  // domain so you can test the deployed Firebase frontend right away.
  const PROD_BACKEND = 'https://b937f7de-fc5b-41b1-9d1f-328f94d47152-00-2zzk5nctdcm15.kirk.replit.dev';
  const HOST_TO_BACKEND = {
    'ilovepdf.cyou':                 PROD_BACKEND,
    'www.ilovepdf.cyou':             PROD_BACKEND,
    'ilovepdf-web.web.app':          PROD_BACKEND,
    'ilovepdf-web.firebaseapp.com':  PROD_BACKEND,
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
