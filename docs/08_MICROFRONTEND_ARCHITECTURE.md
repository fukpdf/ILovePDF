# 08 — MICROFRONTEND ARCHITECTURE

## Philosophy

ILovePDF does NOT use a traditional SPA framework. Instead, it implements a **server-rendered microfrontend pattern** where:

1. The server injects per-tool context (`window.__TOOL_ID`, `window.__STEP`) into a shared HTML shell
2. Client-side modules bootstrap themselves based on that context
3. Feature modules are isolated via IIFE closures exposing only a documented `window.*` API
4. Runtime systems load deferred (after first paint) in pre-built bundles

This gives the performance of a static site with the per-page dynamism of an SPA.

---

## Shell Architecture

### Shared Shell (`public/tool.html`)

```html
<head>
  <!-- Per-tool SEO injected by buildHtml() at request time -->
  <!-- title, canonical, OG, Twitter, JSON-LD, AdSense tag -->
</head>
<body>
  <!-- window.__TOOL_ID, window.__STEP set by server -->
  <script>
    window.__TOOL_ID = 'rotate';
    window.__STEP    = 'upload';
    window.__BUILD_ID = '...';
    window.__CSP_NONCE = '...';
  </script>

  <!-- Core modules (synchronous) -->
  <script src="/js/tools-config.js"></script>
  <script src="/js/auth-ui.js"></script>
  <script src="/js/tool-page.js"></script>
  <script src="/js/page-organizer.js"></script>
  <script src="/js/browser-tools.js"></script>
  <script src="/js/advanced-engine.js"></script>

  <!-- Runtime bundles (deferred) -->
  <script src="/js/bundles/runtime-phase6-core.bundle.js"></script>
  <script defer src="/js/bundles/runtime-phase6-deferred.bundle.js"></script>
  <!-- ... all 18 other bundles ... -->
</body>
```

### Homepage (`public/index.html`)

Separate file, served by the pre-built `__HOME_HTML` with `buildHomeHtml()`. Has its own JS (`home.js`, `homepage-lazy-loader.js`).

---

## Module Isolation Pattern

All modules use an **IIFE (Immediately Invoked Function Expression)** closure:

```javascript
(function () {
  'use strict';

  // Private state — not accessible from outside
  var _privateState = {};

  // Private functions
  function _doSomething() { ... }

  // Public API — exposed on window
  window.ModuleName = {
    publicMethod1: function() { ... },
    publicMethod2: function() { ... },
  };
})();
```

This prevents global namespace pollution and ensures modules cannot directly access each other's internals — only the public API.

---

## Module Communication

Modules communicate exclusively via **documented `window.*` globals**:

| Global | Module | Purpose |
|--------|--------|---------|
| `window.BrowserTools` | `browser-tools.js` | Core tool processing |
| `window.AdvancedEngine` | `advanced-engine.js` | Wraps BrowserTools with retry/memory |
| `window.PageOrganizer` | `page-organizer.js` | PDF page grid UI |
| `window.LivePreview` | `live-preview.js` | Document preview panels |
| `window.RuntimeWorkers` | Arc runtime | Web Worker orchestration |
| `window.RuntimeScheduler` | Arc runtime | Task scheduling |
| `window.RuntimeCancellation` | Arc runtime | Cancellation token system |
| `window.RuntimeMemory` | Arc runtime | Memory pressure monitoring |
| `window.RuntimeProgress` | Arc runtime | Progress tracking |
| `window.RuntimeQueue` | Arc runtime | Job queue engine |
| `window.RuntimeCleanup` | Arc runtime | Resource cleanup contracts |
| `window.RuntimeHealth` | Arc runtime | Health monitor |
| `window.RuntimeTelemetry` | Arc runtime | Telemetry bus |
| `window.RuntimeState` | Arc runtime | Shared state manager |
| `window.RuntimeEventBus` | Arc runtime | Event bus (pub/sub) |
| `window.RuntimeAdapters` | Arc runtime | Per-tool adapter registry |
| `window.UsageLimit` | usage tracking | Client-side usage tracking |
| `window.ToolState` | state persistence | sessionStorage + IDB persistence |
| `window.IDBCache` | CDN script cache | IndexedDB CDN script cache |
| `window.PdfPreview` | page preview | PDF page thumbnail renderer |
| `window.OutputValidator` | validation | Output quality validation |

---

## Container Boundaries

### Tool Container
Each tool page is an isolated container managed by `tool-page.js`:
- `selectedFiles[]`: the tool's file state
- `pageOrganizer`: reference to active PageOrganizer instance
- `currentTool`: the tool config object
- `Flow`: step state machine (upload / preview / download)

When the user navigates to a different tool page, the browser loads a fresh HTML shell — all state is reset. State can be persisted across refreshes via `ToolState` (sessionStorage + IDB).

### Worker Container
Each Web Worker is a fully isolated process:
- Spawned by `RuntimeWorkers` with `new Worker(url)`
- Communicates only via `postMessage` / `onmessage`
- Workers are pooled and reused for efficiency

### Bundle Container
Each runtime bundle is a self-contained unit:
- Built by `scripts/build-runtime-bundles.js` by concatenating source files
- Loaded deferred after first paint
- Each bundle registers its modules on `window.*`
- Bundles have no build-time dependencies on each other (all linked via runtime globals)

---

## Standalone Microfrontends

Some tools are completely standalone HTML pages (not the shared `tool.html` shell):

| Tool | File | Reason |
|------|------|--------|
| Numbers to Words | `numbers-to-words.html` | Custom calculator UI |
| Currency Converter | `currency-converter.html` | Custom live-rates UI |
| QR Code Generator | `qr-code-generator.html` | Canvas-based generator |
| Barcode Generator | `barcode-generator.html` | Canvas-based generator |
| ZIP Builder | `zip-builder.html` | Multi-file browser ZIP |
| Image Compressor | `image-compressor.html` | Client-side image tool |
| Image Converter | `image-converter.html` | Client-side image tool |

These are served directly as static files, bypassing the SEO injection middleware. They have their own `<head>` with manual SEO metadata.

---

## SEO Injection Boundary

The only code that modifies the HTML shell per-tool is `utils/seo.js` → `buildHtml()`. This runs server-side and injects:
- `<title>`
- `<meta name="description">`
- `<link rel="canonical">`
- OG/Twitter meta tags
- JSON-LD schemas (SoftwareApplication, FAQPage, HowTo, BreadcrumbList)
- `window.__TOOL_ID` and `window.__STEP` values

Client-side code never modifies the `<head>` after initial load.

---

## State Persistence Layer

`ToolState` (`public/js/tool-page.js` uses this global):
- **sessionStorage**: JSON snapshot of step + file metadata + result URL
- **IndexedDB**: Actual file blobs + result blobs (survive page refresh)
- **Hydration**: On page load, `hydrateFlowState()` restores files from IDB if session was interrupted
- **Isolation**: Keyed by tool slug (`rotate-pdf`, `merge-pdf`, etc.) — different tools don't share state
