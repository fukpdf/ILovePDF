# 01 — PROJECT MASTER

## Project Purpose

ILovePDF (hosted at **ilovepdf.cyou**) is a free, browser-first online platform offering 43+ tools for PDF manipulation and image processing. It runs without plugins, accounts, or software installation. Files are processed in the browser whenever possible; server-side processing is the fallback for operations that require native libraries (qpdf, Ghostscript, Sharp).

The site generates revenue via Google AdSense (publisher ID `ca-pub-3242156405919556`) and is structured to qualify for Google AdSense approval: legal pages, structured data, clean URLs, and full SEO metadata on every page.

---

## Current Maturity

| Dimension | Status |
|-----------|--------|
| Core tool functionality | Production-ready (33+ working tools) |
| Browser-side processing | Production (pdf-lib, PDF.js, canvas, OPFS streaming) |
| Runtime observability | Enterprise-grade (Arc 2–15, 19 bundles, 22 debug panels) |
| Auth system | Fully working (email/password JWT + optional Firebase Google Sign-In) |
| SEO | Fully instrumented (sitemap, robots, canonical, OG, Twitter cards, JSON-LD) |
| AdSense compliance | Certified ready (Phase P audit complete) |
| Admin dashboard | Working (/admin with Arc 10D panels) |
| Blog | 37 articles live with structured data |
| Deployment | GitHub Actions → Firebase Hosting + Cloudflare Worker |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (Client)                         │
│  tool.html (shared shell)  ←  tool-page.js (step orchestrator) │
│  BrowserTools.process()    ←  advanced-engine.js (wraps BT)    │
│  PageOrganizer (grid UI)   ←  page-organizer.js                │
│  LivePreview (v6.0)        ←  live-preview.js                  │
│  16 Web Workers            ←  pdf-worker, pdf-lib-worker, etc  │
│  19 Runtime Bundles        ←  Arc 2–15 (loaded deferred)       │
│  22 Debug Panels           ←  Arc 10D+                         │
└────────────────────┬────────────────────────────────────────────┘
                     │ fetch /api/* (XHR/FormData)
┌────────────────────▼────────────────────────────────────────────┐
│                  EXPRESS 5 SERVER (Node.js 20)                  │
│  server.js — middleware, CSP, rate limit, route mounts          │
│  routes/: auth, organize, edit, convert, security, advanced,    │
│            image, r2, search, admin*, debug, seo-routes         │
│  utils/: db (SQLite), seo, usage, r2, firebase-admin, ai, ...  │
└────────┬───────────────────┬───────────────────────────────────┘
         │                   │
┌────────▼──────┐   ┌────────▼──────────────────────────────────┐
│  SQLite DB    │   │  Cloudflare R2 (optional)                  │
│  .data/app.db │   │  tmp/ — auto-purged after 10 min           │
│  users table  │   │  users/<uid>/ — permanent (paid plans)     │
│  usage_log    │   └────────────────────────────────────────────┘
│  pending_signups│
└───────────────┘
         │
┌────────▼──────────────────────────────────────────────────────┐
│  Firebase Hosting (optional, static CDN layer)                │
│  cleanUrls: true — serves public/ without .html extensions    │
└───────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────────┐
│  Cloudflare Worker (optional, heavy async jobs)               │
│  ilovepdf-queue → KV (PDF_STATUS) + R2 storage               │
│  HF Space URL for AI processing (external)                    │
└───────────────────────────────────────────────────────────────┘
```

---

## Major Systems

| System | Files | Purpose |
|--------|-------|---------|
| Tool Engine | `browser-tools.js`, `advanced-engine.js` | Client-side PDF/image processing |
| Page Organizer | `page-organizer.js` | Per-page grid UI (rotate, reorder, delete) |
| Live Preview | `live-preview.js` | Real document previews before download |
| Runtime Bundles | `public/js/bundles/*.bundle.js` | 19 Arc/Phase bundles (deferred load) |
| Web Workers | `public/workers/*.js` | 16 workers for heavy computation |
| Debug Shell | `/debug`, `public/js/debug-panels/` | 22 observability panels (Arc 10D+) |
| Auth | `routes/auth.js`, `utils/firebase-admin.js` | JWT + optional Firebase |
| Database | `utils/db.js`, `.data/app.db` | SQLite, WAL mode |
| SEO | `utils/seo.js`, `utils/seo-keywords.js`, `routes/seo-routes.js` | Dynamic meta, JSON-LD, sitemap |
| Blog | `public/blog/*.html` (37 articles) | Editorial content, structured data |
| Admin | `routes/admin.js`, `admin/security-dashboard.html` | Internal observability |
| Cloudflare Worker | `cloudflare/worker/src/` | Async heavy job queue |
| Security | `routes/security*.js`, `utils/origin-guard.js` | CSP, rate limiting, telemetry |

---

## Tool Engine

The tool engine has two layers:

1. **`BrowserTools`** (`browser-tools.js`): Direct tool implementations using pdf-lib, PDF.js, Canvas, Tesseract.js, XLSX, etc. Loaded from CDN scripts with IDB caching.
2. **`AdvancedEngine`** (`advanced-engine.js`, v5.4): Wraps `BrowserTools.process()` transparently. Adds: worker pool, streaming (OPFS), battery throttle, retry logic, memory guards, quality scoring, DebugTrace.

Tool runtimes (e.g., `rotate-runtime.js`, `compress-runtime.js`) further wrap `BrowserTools.process()` for specific tool lifecycle management (telemetry, deduplication, cancellation).

---

## Deployment Flow

```
Developer pushes to main branch
       ↓
GitHub Actions (.github/workflows/deploy.yml)
       ├── Firebase Hosting deploy (public/ → CDN)
       └── Cloudflare Worker deploy (cloudflare/worker/src/)
```

The Express server (Node.js) runs separately on Replit (port 5000). Firebase Hosting is a static CDN layer for the `/public` directory. The Node server handles all `/api/*` routes and dynamic SEO injection.

---

## Runtime Philosophy

- **Browser-first**: All operations that can run in the browser do. Server is fallback.
- **Zero-upload for most tools**: `clientSide: true` tools never send files to the server.
- **Graceful degradation**: Firebase, R2, HuggingFace are optional. Missing them disables features cleanly.
- **Deferred loading**: Runtime bundles load after initial paint. CDN libraries cached in IDB.
- **Memory safety**: AdvancedEngine monitors heap usage, cancels if pressure detected.

---

## Isolation Philosophy

- Each tool has its own runtime adapter (e.g., `rotate-runtime.js`, `compress-runtime.js`)
- Workers are isolated processes — each heavy job gets a dedicated Web Worker
- Arc systems are bundled independently, load deferred, and communicate via well-defined globals (`window.RuntimeWorkers`, `window.RuntimeScheduler`, etc.)
- PageOrganizer is a self-contained module with an explicit API surface (`getEditedPdf`, `applyRotationAll`, `getOrderSummary`, `getPageCount`, `destroy`)

---

## Microfrontend Philosophy

The tool shell (`tool.html`) is a shared template. Per-tool behavior is injected at request time by the Express SEO middleware (`utils/seo.js` → `buildHtml()`). The client-side `tool-page.js` reads `window.__TOOL_ID` and `window.__STEP` injected by the server to render the correct step (upload / preview / download).

Stand-alone tools (Numbers to Words, Currency Converter, QR Code Generator, etc.) have their own `.html` files and are served directly as static files.

---

## Security Model

- **CSP**: Per-request nonce, strict `script-src`, `frame-src` allows AdSense domains, `connect-src` allows Firebase/HuggingFace/AdSense endpoints
- **Rate limiting**: 80 req/15 min on all `/api/*` routes (express-rate-limit)
- **Origin guard**: `utils/origin-guard.js` validates `Origin` header on API requests
- **JWT**: `httpOnly` cookie, `SameSite=lax` (same-origin) or `SameSite=None; Secure` (cross-origin)
- **Packet validator**: Soft validation layer on all API POST bodies
- **Security telemetry**: Real-time incident pipeline (Arc-era routes/security-telemetry.js)
- **Permissions-Policy**: Restricts accelerometer, geolocation, gyroscope, magnetometer, microphone, payment, serial, USB

---

## SEO Model

- **Dynamic injection**: `buildHtml()` injects title, canonical, OG, Twitter, JSON-LD at request time into `tool.html`
- **JSON-LD schemas**: SoftwareApplication + FAQPage + HowTo + BreadcrumbList on every tool page
- **Sitemap**: `/sitemap.xml` index pointing to sub-sitemaps (tools, blog, categories, static pages)
- **Blog**: 37 articles at `/blog/:slug` with Article + FAQPage JSON-LD
- **Clean URLs**: No `.html` extensions anywhere in the public-facing URL space
- **robots.txt**: Disallows /debug, /p9-test, /dashboard, /admin
