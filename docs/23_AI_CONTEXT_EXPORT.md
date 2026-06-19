# 23 — AI CONTEXT EXPORT

This document is a condensed, machine-readable snapshot of the ILovePDF codebase. It is designed to be loaded as context for AI assistants (Claude, GPT-4, etc.) when working on this project. It contains critical facts, gotchas, conventions, and constraints that would otherwise require reading many files.

---

## CRITICAL FACTS

```
Project: ILovePDF — free online PDF + image tools
Domain: ilovepdf.cyou
Publisher: Google AdSense ca-pub-3242156405919556

Stack:
  Backend:  Node.js 20, Express 5 (ES modules), SQLite (better-sqlite3)
  Frontend: Vanilla HTML/CSS/JS (no SPA framework, no build step)
  Database: .data/app.db, WAL mode
  Storage:  Cloudflare R2 (optional) → /tmp/ilovepdf-uploads (fallback)
  Auth:     JWT cookie (ilovepdf_token) + optional Firebase Google Sign-In
  Port:     5000
  Start:    node server.js

Tools: 43 URL slugs → tool IDs (see SLUG_MAP in public/js/tools-config.js)
Runtime bundles: 19 bundles (Phase 6–9 + Arc 2–15) in public/js/bundles/
Web Workers: 16 workers in public/workers/
Debug panels: 22 panels in public/js/debug-panels/
Blog articles: 37 in public/blog/
```

---

## ARCHITECTURE RULES

```
1. All /api/* routes go through:
   a. express-rate-limit (80 req/15 min)
   b. originGuard (validates Origin header)
   c. checkUsage (daily file quota)
   d. enforcePerFile (per-file size cap)

2. Route mounting order matters (server.js):
   - adminRouter BEFORE rate limiter
   - communityApiRouter BEFORE rate limiter
   - authRouter passes through WITHOUT checkUsage
   - r2Router passes through WITHOUT checkUsage

3. CSP nonce is per-request, injected by injectNonce()
   - TOOL_HTML pre-built at boot with __CSP_NONCE__ placeholder
   - buildHtml() returns HTML with __CSP_NONCE__ still in it
   - injectNonce() replaces it just before res.send()

4. Tool HTML shell (tool.html) is shared for all tools
   - buildHtml(slug, TOOL_HTML, step) injects per-tool data
   - window.__TOOL_ID and window.__STEP are how client knows which tool/step

5. PageOrganizer opens automatically for PAGE_LEVEL_TOOLS
   - After getEditedPdf(), rotate tool MUST reset #opt-degrees to '0'
   - This prevents double-rotation when opts are passed to BrowserTools

6. clientSide: true tools → BrowserTools.process() first, server fallback
   clientSide: false tools → direct POST to apiEndpoint
```

---

## DATABASE SCHEMA

```sql
-- Main tables
users (id, email, name, password_hash, storage_quota, storage_used, avatar_url, plan, created_at)
pending_signups (token, email, expires_at, created_at)
usage_log (id, user_id, ip, daily_usage_mb, daily_bytes, file_count, last_reset)

-- Usage limits
guest  (IP-based):  10 files/day, 60 MB/file,  600 MB/day
free   (JWT user):  30 files/day, 200 MB/file, 6 GB/day
premium (plan=premium): unlimited

-- users.plan values: 'free' | 'premium'
-- Password: bcrypt, cost=10
-- JWT: 30-day expiry, signed with JWT_SECRET
```

---

## FILE LAYOUT (SOURCE OF TRUTH FILES)

```
server.js                      - Express entry point, all route mounts
routes/auth.js                 - Auth API (signup/login/logout/me/firebase/change-pw/delete)
routes/organize.js             - merge, split, rotate, reorder
routes/edit.js                 - compress, edit, watermark, sign, crop, page-numbers, redact
routes/convert.js              - all format conversions (pdf↔word/excel/ppt/jpg/html)
routes/security.js             - protect, unlock
routes/advanced.js             - repair, ocr, translate, compare, ai-summarize
routes/image.js                - background-remove, crop-image, resize-image, filters
routes/r2.js                   - R2 upload/download/list/delete
routes/seo-routes.js           - sitemap.xml, robots.txt, category pages
utils/db.js                    - SQLite schema + migration (source of truth for DB)
utils/seo.js                   - buildHtml(), buildHomeHtml(), SLUG_MAP, JSON-LD builders
utils/seo-keywords.js          - Per-tool SEO copy: title, desc, long content, FAQs
utils/usage.js                 - checkUsage, enforcePerFile, LIMITS object
utils/r2.js                    - R2 client, putTempObject, putUserObject, getSignedUrl
utils/firebase-admin.js        - Firebase Admin init, verifyIdToken, isFirebaseConfigured
utils/ai.js                    - isHfConfigured() only (AI moved to extractive + MyMemory)
utils/pdfText.js               - extractPdfText, extractiveSummarize, textToPdf, wrapText
utils/pdfTools.js              - qpdfMerge/Split/Rotate/Reorder/Protect/Unlock, gsCompress
utils/cleanup.js               - cleanupFiles(files), sendPdf(res, buffer, filename)
utils/upload.js                - createUpload(type, maxSize), UPLOAD_DIR, sweepUploads()
utils/csp-nonce.js             - generateNonce(), injectNonce(html, nonce)
utils/origin-guard.js          - originGuard middleware
utils/server-health-monitor.js - getHealthSnapshot(), requestTimingMiddleware()
public/js/tools-config.js      - TOOLS array + SLUG_MAP (all 43 tool definitions)
public/js/browser-tools.js     - window.BrowserTools: client-side tool processing
public/js/advanced-engine.js   - window.AdvancedEngine: wraps BrowserTools (v5.4)
public/js/page-organizer.js    - window.PageOrganizer: PDF page grid UI (v2.0)
public/js/live-preview.js      - window.LivePreview: document preview engine (v6.0)
public/js/auth-ui.js           - auth modal + profile chip (injected on every page)
public/js/bundles/             - 19 runtime bundles (pre-built, committed)
public/workers/                - 16 Web Workers
public/js/debug-panels/        - 22 debug panel JS files
public/blog/                   - 37 blog articles (static HTML)
scripts/                       - 19 build/maintenance scripts
cloudflare/worker/src/         - Cloudflare Worker source (6 files)
.github/workflows/deploy.yml   - CI/CD pipeline
firebase.json                  - Firebase Hosting config
cloudflare/worker/wrangler.toml - Cloudflare Worker config
```

---

## ALL 43 TOOL SLUGS → IDs

```
merge-pdf          → merge
split-pdf          → split
rotate-pdf         → rotate
crop-pdf           → crop
organize-pdf       → organize
compress-pdf       → compress
pdf-to-word        → pdf-to-word
pdf-to-powerpoint  → pdf-to-powerpoint
pdf-to-excel       → pdf-to-excel
pdf-to-jpg         → pdf-to-jpg
word-to-pdf        → word-to-pdf
powerpoint-to-pdf  → powerpoint-to-pdf
excel-to-pdf       → excel-to-pdf
word-to-excel      → word-to-excel
jpg-to-pdf         → jpg-to-pdf
html-to-pdf        → html-to-pdf
edit-pdf           → edit
watermark-pdf      → watermark
sign-pdf           → sign
add-page-numbers   → page-numbers
redact-pdf         → redact
protect-pdf        → protect
unlock-pdf         → unlock
repair-pdf         → repair
scan-pdf           → scan-to-pdf
ocr-pdf            → ocr
compare-pdf        → compare
ai-summarizer      → ai-summarize
translate-pdf      → translate
workflow-builder   → workflow      [working: false]
numbers-to-words   → numbers-to-words  [standalone: /numbers-to-words.html]
currency-converter → currency-converter [standalone: /currency-converter.html]
background-remover → background-remover
crop-image         → crop-image
resize-image       → resize-image
image-filters      → image-filters
image-compressor   → image-compressor  [standalone]
image-converter    → image-converter   [standalone]
qr-code-generator  → qr-code-generator [standalone]
barcode-generator  → barcode-generator [standalone]
zip-builder        → zip-builder        [standalone]
```

---

## PAGE_LEVEL_TOOLS (opens PageOrganizer)

```javascript
const PAGE_LEVEL_TOOLS = new Set([
  'split', 'rotate', 'organize', 'crop', 'page-numbers',
  'watermark', 'sign', 'redact', 'ocr',
  'ai-summarize', 'translate', 'repair', 'edit'
]);
```

---

## CRITICAL GOTCHAS

```
1. JWT_SECRET defaults to 'dev-secret-change-me' — must be set in production.

2. better-sqlite3 is a native addon — requires Python + GCC for compilation.
   The Replit nix config provides these.

3. .data/ directory is auto-created at boot. Must NOT be in Docker/CI caches.

4. PageOrganizer safety net: After getEditedPdf() in the rotate tool,
   ALWAYS reset #opt-degrees to '0'. Otherwise the rotation runs twice.
   (fix applied in routes/organize.js applyRotationAll flow)

5. Homepage pre-built at boot: __HOME_HTML = buildHomeHtml(base).replace(BUILD_ID).
   CSP nonce injected per-request by injectNonce(). Cache-Control: no-store.

6. TOOL_HTML pre-built once: let TOOL_HTML = fs.readFileSync('tool.html').replace(BUILD_ID).
   buildHtml() called per-request using this pre-built template.

7. Firebase Hosting rewrites ALL non-file paths to /tool.html.
   Node.js server handles all /api/* and dynamic routes.
   The two coexist: Firebase for static, Replit for API.

8. SameSite=None required for cross-origin cookies (Firebase frontend → Replit backend).
   Auto-detected by comparing Origin header to Host.

9. Bundle rebuild is NOT automatic. Run build-runtime-bundles.js manually
   after changing any runtime source file.

10. Arc 14 uses 'RuntimeCommandAnalytics' (NOT 'RuntimeAnalytics') to avoid
    conflict with Phase 27 client analytics bus on window.RuntimeAnalytics.

11. AI summarizer is EXTRACTIVE only (not abstractive). HuggingFace is stubbed.
    Translation uses MyMemory public API (2500 char limit per request).

12. R2 temp files auto-deleted after 10 min via R2 lifecycle rules.
    Local /tmp files swept every 30 min by sweepUploads().

13. Blog clean URLs work via: Firebase cleanUrls:true serves blog/{slug}.html at /blog/{slug}.
    Express also serves them at the same path for when the Node server handles the request.

14. Cloudflare Worker skip-queue threshold: files < 2 MB processed synchronously.
    Files >= 2 MB go to the queue and return a jobId for polling.

15. express.static serves from 'public/' AFTER all explicit routes.
    Most tool pages are served dynamically by buildHtml() before static files are checked.
```

---

## RUNTIME BUNDLE CHAIN

```
Load order (all in tool.html):
  runtime-phase6-core.bundle.js   → sync (9 KB) — non-deferred bootstrap
  runtime-phase6-deferred.bundle.js → defer (151 KB)
  runtime-phase7.bundle.js         → defer (195 KB)
  runtime-phase8-deferred.bundle.js → defer (68 KB)
  runtime-phase9-infra.bundle.js   → sync (28 KB) — infra layer
  runtime-arc2.bundle.js through runtime-arc15.bundle.js → defer (63-109 KB each)

Arc 15 is the LATEST arc (ERAPO: Enterprise Runtime Automation & Policy Orchestration)
Arc 15 includes: sitemap clean URLs + policy engine + automated remediation
```

---

## SECURITY CONSTRAINTS

```
CSP: nonce-based, per-request. Any inline <script> needs nonce="${res.locals.nonce}".
Rate limit: 80 req / 15 min / IP on all /api/* routes.
Origin guard: validates Origin header on all /api/* (after health/config endpoints).
File upload: 100 MB hard cap via multer. Further enforced by enforcePerFile middleware.
Password: bcrypt cost=10. Min 6 chars enforced server-side.
JWT: httpOnly cookie. Never in localStorage.
Admin: Separate auth from user JWT. adminGuard middleware on all /admin/* and /api/admin/*.
```

---

## DEPLOYMENT TARGETS

```
Replit:            node server.js on port 5000 (primary API server)
Firebase Hosting:  public/ directory (static CDN, cleanUrls:true)
Cloudflare Worker: cloudflare/worker/ (ilovepdf-queue, pdf-jobs queue)

CI/CD: GitHub Actions (.github/workflows/deploy.yml)
  Push to main → deploy Firebase Hosting → deploy Cloudflare Worker

Required GitHub Secrets:
  FIREBASE_SERVICE_ACCOUNT, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, HF_TOKEN
```

---

## HOW TO ADD A NEW TOOL

```
1. Add entry to TOOLS array in public/js/tools-config.js
   - Set id, name, icon, description, category, group, badge
   - Set apiEndpoint, acceptedFiles, multipleFiles, working, clientSide
   - Set options[] array

2. Add slug → id mapping to SLUG_MAP in public/js/tools-config.js

3. Add slug → id mapping to SLUG_MAP in utils/seo.js

4. Add SEO metadata to utils/seo-keywords.js:
   - title, desc, long (300+ words), faqs (5-7 Q&A), related (slugs)

5a. For client-side tool: Implement in browser-tools.js PROCESSORS object
5b. For server-side tool: Add route in appropriate routes/*.js file

6. If it's a PAGE_LEVEL_TOOL (single PDF + grid): Add to PAGE_LEVEL_TOOLS set in page-organizer.js

7. If it has a live preview: Add to SUPPORTED set in live-preview.js + implement preview handler

8. Optionally add a blog article in scripts/blog-data.js + regenerate

9. Test: visit /:slug, upload file, process, download
```

---

## HOW TO ADD A NEW ROUTE

```javascript
// 1. Create routes/my-route.js:
import express from 'express';
const router = express.Router();
router.post('/my-endpoint', upload.single('file'), async (req, res) => {
  // ...
});
export default router;

// 2. Import + mount in server.js:
import myRouter from './routes/my-route.js';
// Mount AFTER rate limiter + originGuard (after line ~220 in server.js):
app.use('/api', myRouter);
```

---

## HOW TO MODIFY BUNDLES

```bash
# 1. Edit source files in public/js/ (the raw .js files, not bundles)
# 2. Rebuild:
node scripts/build-runtime-bundles.js
# 3. Verify:
node scripts/enterprise-ci-gate.js
# 4. Restart server (BUILD_ID changes → cache bust)
```

---

## WINDOW GLOBALS CHEAT SHEET

```javascript
window.BrowserTools.process(toolId, files, opts) → Promise<{blob, filename}>
window.AdvancedEngine.audit()  → diagnostic report string
window.PageOrganizer.open(hostEl, file, {onChange}) → Promise<ctrl>
  ctrl.getEditedPdf()   → Promise<{blob, file}>
  ctrl.applyRotationAll(delta)  → void
  ctrl.getOrderSummary()  → {order, rotations}
  ctrl.getPageCount()   → number
  ctrl.destroy()         → void
window.LivePreview.mount(toolId, files, hostEl) → Promise<void>
window.LivePreview.supported(toolId)  → boolean
window.RuntimeDiagnostics.print() → logs full runtime state to console
window.RuntimeHealth.metrics()   → {memory, workers, latency}
window.DebugTrace.getAll()        → [trace, ...]
window.UsageLimit.canUse(toolId)  → boolean
window.ToolState.save(state)      → void
window.ToolState.load(toolId)     → state | null
window.IDBCache.get(url)          → Promise<Uint8Array | null>
window.IDBCache.put(url, bytes)   → Promise<void>
```
