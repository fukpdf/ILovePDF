// ILovePDF Service Worker — Phase 22 PWA Offline System
// Strategy: network-first for navigation, cache-first for static assets,
// network-only for API. COEP/COOP headers are re-applied on cached navigations.

const CACHE_VERSION = 'v1';
const CACHE_STATIC  = `iplv-static-${CACHE_VERSION}`;
const CACHE_PAGES   = `iplv-pages-${CACHE_VERSION}`;
const CACHE_LOCALE  = `iplv-locale-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/offline.html',
  '/locales/en.json',
  '/favicon.svg',
];

const STATIC_EXTS   = /\.(js|css|woff2?|ttf|otf|png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i;
const LOCALE_PATH   = /^\/locales\//;
const API_PATH      = /^\/api\//;
const ADMIN_PATH    = /^\/admin\//;
const IMMUTABLE_EXTS = /\.(woff2?|ttf|otf)(\?|$)/i;

// Security headers required for SharedArrayBuffer (COEP/COOP)
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// ── Install: pre-cache essential offline assets ────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Cache entry limits (Phase 28C — prevents unbounded growth) ────────────────
const CACHE_MAX_ENTRIES = {
  [CACHE_STATIC]: 180,   // JS/CSS/fonts/images
  [CACHE_PAGES]:   60,   // HTML navigation pages
  [CACHE_LOCALE]:  40,   // locale JSON files
};

async function pruneCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys  = await cache.keys();
    if (keys.length <= maxEntries) return;
    const excess = keys.slice(0, keys.length - maxEntries);
    await Promise.all(excess.map(k => cache.delete(k)));
    console.info('[SW] pruned', excess.length, 'stale entries from', cacheName);
  } catch (err) {
    console.warn('[SW] pruneCache error:', err.message);
  }
}

// ── Activate: delete stale caches + prune oversized ones ──────────────────────
self.addEventListener('activate', event => {
  const current = new Set([CACHE_STATIC, CACHE_PAGES, CACHE_LOCALE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !current.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => Promise.all(
        Object.entries(CACHE_MAX_ENTRIES).map(([name, max]) => pruneCache(name, max))
      ))
      // Phase 23: broadcast SW_ACTIVATED so RuntimeUpdater can detect version changes
      .then(() => self.clients.matchAll({ includeUncontrolled: true, type: 'window' }))
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION });
        });
      })
  );
});

// ── Fetch: route-based caching strategies ─────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // API & admin: always network-only (never cache auth or data)
  if (API_PATH.test(path) || ADMIN_PATH.test(path)) return;

  // Locale files: stale-while-revalidate
  if (LOCALE_PATH.test(path)) {
    event.respondWith(staleWhileRevalidate(request, CACHE_LOCALE));
    return;
  }

  // Static assets (JS/CSS/fonts/images): cache-first
  if (STATIC_EXTS.test(path)) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // HTML navigation: network-first → offline fallback
  if (request.mode === 'navigate' || request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
});

// ── Strategies ─────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    // Re-inject isolation headers so SharedArrayBuffer still works after SW serves page
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) {
      headers.set(k, v);
    }
    const body = await response.arrayBuffer();
    const cloned = new Response(body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    });
    // Cache successful page responses for offline access
    if (response.ok) {
      const cache = await caches.open(CACHE_PAGES);
      cache.put(request, cloned.clone());
      pruneCache(CACHE_PAGES, CACHE_MAX_ENTRIES[CACHE_PAGES]);
    }
    return cloned;
  } catch {
    // Try page cache first, then offline fallback
    const cachedPage = await caches.match(request, { cacheName: CACHE_PAGES });
    if (cachedPage) return cachedPage;
    const offline = await caches.match('/offline.html', { cacheName: CACHE_STATIC });
    return offline || new Response(
      '<!DOCTYPE html><html><body><h1>You\'re offline</h1><p>Please check your connection.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ── Background sync: retry failed uploads when back online ────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'iplv-retry-upload') {
    event.waitUntil(retryPendingUploads());
  }
});

const IDB_DB   = 'iplv-sync';
const IDB_STORE = 'pending-uploads';

function openSyncDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function retryPendingUploads() {
  let db;
  try {
    db = await openSyncDb();
  } catch {
    return; // IDB unavailable — nothing to retry
  }

  const tx      = db.transaction(IDB_STORE, 'readwrite');
  const store   = tx.objectStore(IDB_STORE);
  const records = await new Promise((res, rej) => {
    const r = store.getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });

  for (const record of records) {
    try {
      const resp = await fetch(record.url, {
        method:  record.method || 'POST',
        headers: record.headers || {},
        body:    record.body,
      });
      if (resp.ok) {
        store.delete(record.id);
        console.info('[SW] retried upload', record.id, resp.status);
      }
    } catch (err) {
      console.warn('[SW] retry failed for', record.id, err.message);
      // leave in queue for next sync opportunity
    }
  }

  db.close();
}

// ── Phase 28: URL heat map for RuntimePrefetch.getHeatMap() ──────────────
// Tracks per-URL visit counts across SW lifetime. Keyed by pathname only.
const _urlHeat = new Map();  // pathname → hit count

function _heatKey(url) {
  try { return new URL(url, 'https://x').pathname; } catch { return url; }
}

// ── Message handler: multi-type (CACHE_STATS, PREFETCH_URLS, TRACK_URL, HEAT_REPORT) ──
self.addEventListener('message', event => {
  if (!event.data) return;
  const { type } = event.data;

  // ── CACHE_STATS: RuntimeOffline.getCacheStats() ──────────────────────────
  if (type === 'CACHE_STATS') {
    const port = event.ports && event.ports[0];
    if (!port) return;
    Promise.all([
      caches.open(CACHE_STATIC).then(c => c.keys().then(k => k.length)),
      caches.open(CACHE_PAGES).then(c  => c.keys().then(k => k.length)),
      caches.open(CACHE_LOCALE).then(c => c.keys().then(k => k.length)),
    ]).then(([staticCount, pagesCount, localeCount]) => {
      port.postMessage({
        available:   true,
        version:     CACHE_VERSION,
        staticCount, pagesCount, localeCount,
        maxStatic:   CACHE_MAX_ENTRIES[CACHE_STATIC],
        maxPages:    CACHE_MAX_ENTRIES[CACHE_PAGES],
        maxLocale:   CACHE_MAX_ENTRIES[CACHE_LOCALE],
      });
    }).catch(() => port.postMessage({ available: false }));
    return;
  }

  // ── PREFETCH_URLS: RuntimePrefetch — cache predicted tool routes ─────────
  // Caches a list of URLs into CACHE_PAGES so subsequent navigations are instant.
  // Only caches HTML navigation responses; skips API/admin paths.
  if (type === 'PREFETCH_URLS') {
    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
    event.waitUntil(
      caches.open(CACHE_PAGES).then(cache => {
        const fetches = urls
          .filter(u => {
            try {
              const p = new URL(u, self.location.origin).pathname;
              return !API_PATH.test(p) && !ADMIN_PATH.test(p) && !STATIC_EXTS.test(p);
            } catch { return false; }
          })
          .map(u =>
            fetch(u, { credentials: 'same-origin' })
              .then(r => {
                if (r.ok && r.status < 400) return cache.put(u, r);
              })
              .catch(() => {})
          );
        return Promise.all(fetches);
      })
    );
    return;
  }

  // ── TRACK_URL: RuntimePrefetch — increment heat score for a URL ──────────
  if (type === 'TRACK_URL') {
    const key = _heatKey(event.data.url || '');
    if (key) _urlHeat.set(key, (_urlHeat.get(key) || 0) + 1);
    return;
  }

  // ── HEAT_REPORT: RuntimePrefetch.getHeatMap() — return URL heat scores ───
  if (type === 'HEAT_REPORT') {
    const port = event.ports && event.ports[0];
    if (!port) return;
    const hits = [];
    _urlHeat.forEach((count, url) => hits.push({ url, count }));
    hits.sort((a, b) => b.count - a.count);
    port.postMessage({ hits });
    return;
  }
});

// ── Push notifications (future use) ───────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json().catch(() => ({ title: 'ILovePDF', body: event.data.text() }));
  event.waitUntil(
    data.then(d => self.registration.showNotification(d.title || 'ILovePDF', {
      body:    d.body    || 'Your file is ready.',
      icon:    '/favicon.svg',
      badge:   '/favicon.svg',
      vibrate: [100, 50, 100],
      data:    { url: d.url || '/' },
    }))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const win = list.find(c => c.url === url && 'focus' in c);
      return win ? win.focus() : clients.openWindow(url);
    })
  );
});
