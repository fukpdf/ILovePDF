# PROJECT_STATE_EXPORT.md — Machine-Readable Project State

**Purpose**: Allows any AI assistant to understand the complete ILovePDF project state within minutes.  
**Last updated**: 2026-06-19  
**Read this file + `docs/23_AI_CONTEXT_EXPORT.md` before any coding session.**

---

## IDENTITY

```
Project name:     ILovePDF
Domain:           ilovepdf.cyou
Publisher ID:     ca-pub-3242156405919556 (Google AdSense)
Firebase project: ilovepdf-web
CF account:       a1fbd4659b273ef75414f02cc29acaf5
HF Space:         https://ilovepdf-ilovepdf.hf.space
Replit port:      5000
Node version:     20
Module system:    ES modules ("type": "module" in package.json)
```

---

## CURRENT PHASE

```
Current Arc:      Arc 15 (ERAPO — Enterprise Runtime Automation & Policy Orchestration)
Next Arc:         Arc 16 (not yet defined)
Current Phase:    Production (full feature set deployed)
Build ID:         Generated at server boot (Date.now().toString(36))
```

---

## RUNTIME COUNTS

```
Runtime bundles:   19   (Phase 6-core, Phase 6-deferred, Phase 7, Phase 8, Phase 9, Arc 2–Arc 15)
Web Workers:       16   (processing workers; 2 additional helper files: workerPool.js, p4-heartbeat-mixin.js)
Debug panels:      22   (all in public/js/debug-panels/)
Arc bundles:       14   (Arc 2 through Arc 15)
Phase bundles:      5   (Phase 6-core, Phase 6-deferred, Phase 7, Phase 8, Phase 9)
Total bundle size: ~1.4 MB (unminified, all deferred except phase6-core and phase9-infra)
```

---

## TOOL COUNTS

```
Total tool slugs:    43   (registered in SLUG_MAP)
Working tools:       41   (workflow-builder has working: false)
Client-side tools:   34   (run in browser via BrowserTools.process())
Standalone pages:     7   (numbers-to-words, currency-converter, qr-code-generator,
                            barcode-generator, zip-builder, image-compressor, image-converter)
Server-only tools:    2   (require native libs: protect-pdf, some compress ops)
PAGE_LEVEL_TOOLS:    13   (open PageOrganizer: split, rotate, organize, crop, page-numbers,
                            watermark, sign, redact, ocr, ai-summarize, translate, repair, edit)
```

---

## CONTENT COUNTS

```
Blog articles:       37   (public/blog/*.html)
Blog index:           1   (public/blog.html)
Scripts:             19   (scripts/)
Route files:         18   (routes/)
Utility files:       18   (utils/)
```

---

## DEPLOYMENT CHAIN

```
Trigger:  git push to main branch
    ↓
GitHub Actions (.github/workflows/deploy.yml)
    ├── Step 1: google-github-actions/auth@v2
    │           credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
    ├── Step 2: npx firebase-tools deploy --only hosting --project ilovepdf-web
    │           → Deploys public/ to Firebase CDN (static files only)
    └── Step 3: cloudflare/wrangler-action@v3
                → Deploys cloudflare/worker/ to Cloudflare Workers
                → Pushes HF_API_TOKEN as Worker secret

Replit (always running, separate from CI/CD):
    node server.js → port 5000 → handles /api/* + dynamic routes
```

---

## WORKER CHAIN (File Processing)

```
Three processing tiers:

TIER 1 — Browser (primary, zero upload)
  BrowserTools.process(toolId, files, opts)
    → Web Worker spawned (from public/workers/)
    → CDN library (pdf-lib, pdf.js, etc.) loaded + IDB-cached
    → Result Blob → blob: URL → download

TIER 2 — Node.js server (fallback / native-only)
  POST /api/{tool}
    → multer parses file to /tmp/ilovepdf-uploads/
    → qpdf / Ghostscript / Sharp / pdf-lib
    → buffer → res.send() → browser creates blob: URL

TIER 3 — Cloudflare Worker (async heavy jobs)
  POST /api/queue/submit
    → file to R2 tmp/
    → PDF_QUEUE.send(message)
    → Worker: R2.get() → POST HF_SPACE_URL → R2.put(result)
    → KV: status=done, resultKey=...
    → Client polls: GET /api/queue/status/:jobId
    → GET /api/r2/download/:key → signed URL (15 min)
```

---

## AUTH CHAIN

```
Email/password:
  POST /api/auth/signup  → bcrypt.hash → INSERT users → JWT cookie
  POST /api/auth/login   → bcrypt.compare → JWT cookie
  All subsequent:        → jwt.verify(ilovepdf_token cookie)

Google Sign-In (optional):
  Firebase SDK → Google OAuth → ID token
  POST /api/auth/firebase { idToken }
  → Firebase Admin verifyIdToken() → upsert user → JWT cookie

Admin:
  POST /api/admin/auth/login → admin-specific cookie
  middleware/admin-guard.js validates on all /admin/* routes

Cookie name:    ilovepdf_token
Algorithm:      HS256 (jsonwebtoken default)
Expiry:         30 days
httpOnly:       true (XSS-resistant)
SameSite:       lax (same-origin) | none+secure (cross-origin)
```

---

## SECURITY CHAIN (per request)

```
Every API request:
  1. compression middleware
  2. requestTimingMiddleware
  3. CSP nonce generated (res.locals.nonce)
  4. Security headers set (X-Frame-Options, HSTS, etc.)
  5. express-rate-limit (80 req/15 min/IP)
  6. [Admin routes: adminGuard check]
  7. [Community API: cached aggregate, no limit]
  8. originGuard (validates Origin header)
  9. checkUsage (daily quota pre-flight)
  10. [Route handler runs]
  11. enforcePerFile (per-file size check)
  12. cleanupFiles (temp file deletion)
```

---

## SEO INJECTION CHAIN

```
GET /:slug (e.g. /merge-pdf)
  ↓
server.js: SLUG_MAP lookup
  ↓
buildHtml(slug, TOOL_HTML, 'upload')
  → getToolSeo(slug) from utils/seo-keywords.js
  → inject: title, desc, canonical, OG, Twitter, 4x JSON-LD
  → inject: window.__TOOL_ID, window.__STEP
  → inject: BUILD_ID (cache-busting)
  ↓
injectNonce(html, res.locals.nonce)
  → replace __CSP_NONCE__ with per-request nonce
  ↓
res.set('Cache-Control', 'no-store')
res.type('html').send(finalHtml)
```

---

## RUNTIME BUNDLE LOAD ORDER (tool.html)

```
1.  runtime-phase6-core.bundle.js     → SYNC (9 KB)  — bootstrap
2.  runtime-phase6-deferred.bundle.js → defer (151 KB)
3.  runtime-phase7.bundle.js          → defer (195 KB)
4.  runtime-phase8-deferred.bundle.js → defer (68 KB)
5.  runtime-phase9-infra.bundle.js    → SYNC (28 KB)  — infra
6.  runtime-arc2.bundle.js            → defer (63 KB)
7.  runtime-arc3.bundle.js            → defer (63 KB)
8.  runtime-arc4.bundle.js            → defer (80 KB)
9.  runtime-arc5.bundle.js            → defer (83 KB)
10. runtime-arc6.bundle.js            → defer (96 KB)  ← CentralRuntime + all Runtime* globals
11. runtime-arc7.bundle.js            → defer (79 KB)
12. runtime-arc8.bundle.js            → defer (74 KB)
13. runtime-arc9.bundle.js            → defer (81 KB)
14. runtime-arc10.bundle.js           → defer (83 KB)  ← 22 debug panels
15. runtime-arc11.bundle.js           → defer (109 KB) ← TabMesh
16. runtime-arc12.bundle.js           → defer (88 KB)  ← circuit breakers
17. runtime-arc13.bundle.js           → defer (74 KB)  ← persistent state
18. runtime-arc14.bundle.js           → defer (85 KB)  ← command center
19. runtime-arc15.bundle.js           → defer (98 KB)  ← policy engine (CURRENT ARC)
```

---

## KEY GLOBALS CHEAT SHEET

```javascript
// Core processing (must exist before any tool use)
window.BrowserTools.process(toolId, files, opts)   → Promise<{ blob, filename }>
window.BrowserTools.supports(toolId)               → boolean

// UI
window.PageOrganizer.open(hostEl, file, {onChange})  → Promise<ctrl>
  ctrl.getEditedPdf()                               → Promise<{ blob, file }>
  ctrl.applyRotationAll(delta)                      → void
  ctrl.getOrderSummary()                            → { order, rotations }
  ctrl.getPageCount()                               → number
  ctrl.destroy()                                    → void
window.LivePreview.mount(toolId, files, hostEl)      → Promise<void>
window.LivePreview.supported(toolId)                 → boolean

// Arc 6 runtime systems
window.CentralRuntime    // master coordinator
window.RuntimeWorkers    // worker pool + orchestration
window.RuntimeScheduler  // task priority
window.RuntimeMemory     // NORMAL/WARNING/CRITICAL
window.RuntimeQueue      // FIFO + priority jobs
window.RuntimeCancellation // cancellation tokens
window.RuntimeProgress   // progress bus
window.RuntimeCleanup    // cleanup contracts
window.RuntimeTelemetry  // telemetry bus
window.RuntimeAdapters   // per-tool adapter registry
window.RuntimeState      // shared state
window.RuntimeHealth     // health monitor
window.RuntimeEventBus   // pub/sub
window.RuntimeDiagnostics // DevTools: .print()
window.RuntimeStreaming  // OPFS streaming

// Arc 14 (note: NOT RuntimeAnalytics)
window.RuntimeCommandAnalytics  // command analytics bus

// Arc 15
window.RuntimePolicy     // { define(rule), execute(policy) }

// Infrastructure
window.UsageLimit.canUse(toolId)   → boolean
window.ToolState.save(state)       → void
window.ToolState.load(toolId)      → state | null
window.IDBCache.get(url)           → Promise<Uint8Array | null>
window.OutputValidator.check(toolId, result) → { valid, score }
window.AdaptiveRuntime.profile     → 'full' | 'limited' | 'minimal'

// Observability
window.RuntimeForensics.snapshot(type, ctx)
window.DebugTrace.getAll()         → [trace, ...]
window.TabMesh.status()            → { tabs, active }
```

---

## DATABASE STATE

```sql
-- Location: .data/app.db (auto-created at boot, WAL mode)

users:
  id, email, name, password_hash, storage_quota (2GB default),
  storage_used, avatar_url, plan ('free'|'premium'), created_at

pending_signups:
  token, email, expires_at, created_at
  [Stub for email verification — not yet wired to email sender]

usage_log:
  id, user_id, ip, daily_usage_mb, daily_bytes, file_count, last_reset

-- Limits:
  guest  (IP):      10 files/day, 60 MB/file,  600 MB/day
  free   (JWT):     30 files/day, 200 MB/file, 6 GB/day
  premium (JWT):    unlimited
```

---

## ENVIRONMENT STATE

```
# Set in Replit shared env vars (non-secret):
PORT=5000
NODE_ENV=production
MAX_UPLOAD_MB=200
ALLOWED_ORIGINS=*
R2_ACCOUNT_ID=a1fbd4659b273ef75414f02cc29acaf5
R2_BUCKET=ilovepdf
HF_SPACE_URL=https://ilovepdf-ilovepdf.hf.space
FIREBASE_AUTH_DOMAIN=ilovepdf-web.firebaseapp.com
FIREBASE_PROJECT_ID=ilovepdf-web
FIREBASE_STORAGE_BUCKET=ilovepdf-web.firebasestorage.app
FIREBASE_APP_ID=1:220495273530:web:68068202e588705e989f03

# Required in Replit Secrets (not yet set at audit time):
JWT_SECRET                    — required for auth
FIREBASE_API_KEY              — optional (Google Sign-In)
FIREBASE_SERVICE_ACCOUNT_JSON — optional (Firebase Admin)
R2_ACCESS_KEY_ID              — optional (cloud storage)
R2_SECRET_ACCESS_KEY          — optional (cloud storage)
HUGGINGFACE_API_TOKEN         — optional (AI tools)

# GitHub Actions Secrets required:
FIREBASE_SERVICE_ACCOUNT      — service account JSON for Firebase deploy
CLOUDFLARE_API_TOKEN          — for Worker deploy
CLOUDFLARE_ACCOUNT_ID         — for Worker deploy
HF_TOKEN                      — pushed to Worker at deploy time
```

---

## GAP ANALYSIS (Outstanding Work)

```
HIGH PRIORITY (revenue-blocking):
  [ ] Activate AdSense ad units (approval pending)
  [ ] Stripe payment integration (users.plan col ready, no payment processor)
  [ ] Email provider (blocks: verification, password reset, admin notifications)

MEDIUM PRIORITY:
  [ ] Premium plan UI (after Stripe)
  [ ] Password reset flow (after email provider)
  [ ] R2 user file manager (after premium)
  [ ] Missing blog articles for ~6 tools

LOW PRIORITY:
  [ ] hreflang multilingual URLs
  [ ] Arc 16 (not yet scoped)
  [ ] Workflow builder tool (working: false)
  [ ] Ezoic integration
```

---

## HOW DOCS ARE ORGANIZED

```
docs/
├── 01_PROJECT_MASTER.md         ← Start here (architecture overview)
├── 02_PRD.md                    ← Product requirements + roadmap
├── 03_TRD.md                    ← Technical stack + all 19 bundles table
├── 04_APP_FLOW.md               ← User flow + page routing
├── 05_UI_UX_GUIDE.md            ← Theme + components + PageOrganizer UI
├── 06_BACKEND_SCHEMA.md         ← All routes + middleware stack order
├── 07_DEPLOYMENT_GUIDE.md       ← CI/CD + Firebase + Cloudflare + rollback
├── 08_MICROFRONTEND_ARCHITECTURE.md ← Module isolation + window globals
├── 09_RUNTIME_ARCHITECTURE.md   ← All 19 bundles (Phase 6-9, Arc 2-15)
├── 10_TOOL_ENGINE.md            ← 43 tools + BrowserTools + Workers + PageOrganizer
├── 11_SECURITY_ARCHITECTURE.md  ← CSP + headers + rate limit + circuit breakers
├── 12_SEO_ARCHITECTURE.md       ← JSON-LD + sitemap + AdSense + canonical
├── 13_AUTH_SYSTEM.md            ← Email/password + Firebase + JWT + schema
├── 14_BLOG_SYSTEM.md            ← 37 articles + generation pipeline
├── 15_INTERNATIONALIZATION.md   ← i18n engine + geo detection + RTL
├── 16_CLOUDFLARE_WORKER.md      ← Queue + R2 + job types + HF Space
├── 17_ADSENSE_COMPLIANCE.md     ← Phase A-P audit results
├── 18_ADMIN_DASHBOARD.md        ← 22 panels + admin routes
├── 19_DATA_FLOWS.md             ← End-to-end flows for every major operation
├── 20_TESTING_QUALITY.md        ← Build gates + OutputValidator + quality scoring
├── 21_ENVIRONMENT_CONFIG.md     ← All env vars + production checklist
├── 22_SCRIPTS_BUILD_TOOLS.md    ← 19 scripts + bundle build + blog pipeline
├── 23_AI_CONTEXT_EXPORT.md      ← Machine-readable: facts, gotchas, cheat sheets
├── AI_GUARDRAILS.md             ← Rules for AI assistants (read before coding)
├── CHANGELOG.md                 ← Arc-by-Arc development history
├── TODO_MASTER.md               ← DONE / IN PROGRESS / PENDING / BLOCKED
├── PROJECT_RULES.md             ← Development rules for humans + AI
├── PROJECT_STATE_EXPORT.md      ← This file (project state snapshot)
└── DOCUMENTATION_REPORT.md      ← Audit report + doc index
```

---

## KNOWN INCONSISTENCIES (Found During Audit)

The following were identified during the 2026-06-19 audit. They do not block operation.

| # | Location | Issue | Severity |
|---|----------|-------|---------|
| 1 | `07_DEPLOYMENT_GUIDE.md` L26 | Still references old `w9jds/firebase-action@master` — actual workflow now uses `google-github-actions/auth@v2` | **Fixed in this audit** |
| 2 | `07_DEPLOYMENT_GUIDE.md` L27 | Says "Uses FIREBASE_SERVICE_ACCOUNT secret (GCP_SA_KEY)" — no alias; the secret is just `FIREBASE_SERVICE_ACCOUNT` | **Fixed in this audit** |
| 3 | `01_PROJECT_MASTER.md` maturity table | Says "33+ working tools" — actual count is 41 working tools (43 slugs minus workflow-builder and workflow stub) | Minor — update in next doc pass |
| 4 | `10_TOOL_ENGINE.md` worker section | Worker table shows 16 items but counts `workerPool.js` as one (it's a helper). Two additional files exist: `shared-cluster-worker.js` + `p4-heartbeat-mixin.js`. Total files: 18. Processing workers: 16. | Minor — correct as written |
| 5 | `11_SECURITY_ARCHITECTURE.md` CSP | Shows `img-src` with `http:` — actual server.js CSP uses only `https:` | Minor |
| 6 | `DOCUMENTATION_REPORT.md` | References `controllers/` directory (imageController, pdfController) — no such directory exists in the root | Minor — was in prior version |
