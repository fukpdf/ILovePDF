/* Runtime config — loaded on every page BEFORE any other script.
   Decoupled / serverless setup: both API_BASE and QUEUE_API_BASE point
   at the Cloudflare Worker. There is no Replit / Express backend in
   this configuration.

   Override priority (both bases):
     1. window.{API_BASE_OVERRIDE | QUEUE_API_BASE_OVERRIDE}  (inline in HTML for testing)
     2. localStorage 'ilovepdf:api_base' / 'ilovepdf:queue_api_base'  (developer override)
     3. Hard-coded production URL below
*/
(function () {
  // ── Single backend for everything: Cloudflare Worker ────────────────────
  // The Worker handles the queue producer (POST /api/queue-job),
  // status polling, result download, and limits. Frontend talks to it
  // directly from Firebase Hosting — no intermediate server.
  const CLOUDFLARE_WORKER = 'https://ilovepdf-queue.safderkhan318.workers.dev';

  function resolveBase() {
    if (typeof window.API_BASE_OVERRIDE === 'string') return window.API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    return CLOUDFLARE_WORKER;
  }

  const base = resolveBase().replace(/\/+$/, ''); // strip trailing slashes
  window.API_BASE = base;
  console.log('[ilovepdf:config] API_BASE =', base || '(same-origin)');

  function resolveQueueBase() {
    if (typeof window.QUEUE_API_BASE_OVERRIDE === 'string') return window.QUEUE_API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:queue_api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    return CLOUDFLARE_WORKER;
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
