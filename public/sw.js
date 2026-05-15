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

// ── Activate: delete stale caches ─────────────────────────────────────────
self.addEventListener('activate', event => {
  const current = new Set([CACHE_STATIC, CACHE_PAGES, CACHE_LOCALE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !current.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
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
    return new Response(body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Offline fallback
    const cached = await caches.match('/offline.html', { cacheName: CACHE_STATIC });
    return cached || new Response(
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

async function retryPendingUploads() {
  // Placeholder: real implementation would read from IDB queue
  // and retry any uploads that failed while offline
}

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
