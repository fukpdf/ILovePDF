/* Runtime config — loaded on every page BEFORE any other script. */
(function () {
  function resolveBase() {
    if (typeof window.API_BASE_OVERRIDE === 'string') return window.API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    // Default to same origin (works both in Replit dev and when deployed)
    return window.location.origin;
  }

  const base = resolveBase().replace(/\/+$/, '');
  window.API_BASE = base;

  function resolveQueueBase() {
    if (typeof window.QUEUE_API_BASE_OVERRIDE === 'string') return window.QUEUE_API_BASE_OVERRIDE;
    try {
      const ls = localStorage.getItem('ilovepdf:queue_api_base');
      if (ls !== null) return ls;
    } catch (_) {}
    // Default to same origin (no separate Cloudflare worker needed)
    return window.location.origin;
  }
  window.QUEUE_API_BASE = resolveQueueBase().replace(/\/+$/, '');

  // ── Silent keep-alive ──────────────────────────────────────────────────
  // Pings the API every 3 minutes so the upstream processing service does
  // not idle/sleep between user requests. Errors are swallowed silently.
  // Both timers are registered with TimerRegistry (when available) so they
  // are cancelled on pagehide / bfcache restore and never become orphans.
  (function startKeepAlive() {
    const url = window.location.origin + '/api/health';
    const ping = () => {
      try {
        fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit' })
          .catch(() => {});
      } catch (_) {}
    };
    // Fire one shortly after load, then every 3 minutes.
    const warmupId  = setTimeout(ping, 5000);
    const intervalId = setInterval(ping, 3 * 60 * 1000);
    // Register after DOMContentLoaded so TimerRegistry is guaranteed to exist.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (window.TimerRegistry) {
          window.TimerRegistry.registerTimeout('keep-alive', warmupId);
          window.TimerRegistry.registerInterval('keep-alive', intervalId);
        }
      }, { once: true });
    } else {
      if (window.TimerRegistry) {
        window.TimerRegistry.registerTimeout('keep-alive', warmupId);
        window.TimerRegistry.registerInterval('keep-alive', intervalId);
      }
    }
  })();

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
