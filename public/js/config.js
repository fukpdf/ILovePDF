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
  // IMPORTANT: Replit *dev* domains rotate every time the repl is recreated.
  // For a stable production backend, publish this repl (Replit Deployments)
  // and replace PROD_BACKEND with the resulting `.replit.app` URL — that one
  // does not change. Until then, this points at the *current* dev domain so
  // the deployed Firebase frontend can reach the running backend.
  //
  // Quick override (no redeploy needed): in DevTools console run
  //   localStorage.setItem('ilovepdf:api_base', 'https://your-backend.example')
  // and reload. Use '' for same-origin.
  const PROD_BACKEND = 'https://0d5bd5df-7f07-4f86-8880-3cb6e70f08c0-00-23sfw4xi4di1y.kirk.replit.dev';
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
  console.log('[ilovepdf:config] API_BASE =', base || '(same-origin)');

  // ── Queue API base — Cloudflare Worker URL ──────────────────────────────
  // Set this to your deployed Worker (e.g. https://ilovepdf-queue.<acct>.workers.dev
  // or a custom route like https://queue.ilovepdf.cyou). Resolution order
  // mirrors API_BASE: window override → localStorage → hardcoded map.
  function resolveQueueBase() {
    if (typeof window.QUEUE_API_BASE_OVERRIDE === 'string') return window.QUEUE_API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:queue_api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    // Default: same Worker URL across all production hosts. Replace once
    // you've run `wrangler deploy`.
    return 'https://ilovepdf-queue.safderkhan318.workers.dev';
  }
  window.QUEUE_API_BASE = resolveQueueBase().replace(/\/+$/, '');
  console.log('[ilovepdf:config] QUEUE_API_BASE =', window.QUEUE_API_BASE || '(disabled)');
  window.queueUrl = function (path) {
    if (!window.QUEUE_API_BASE) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return window.QUEUE_API_BASE + (path.startsWith('/') ? path : '/' + path);
  };

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
