# ILovePDF — Free Online PDF & Image Tools

A production-ready PDF + image processing platform with 33 tools, branded as **ILovePDF** (red theme #E5322E).

## Architecture

```
/
├── server.js                    — Express entry (port 5000, rate limiting, security headers)
├── utils/cleanup.js             — File cleanup + shared response helpers
├── controllers/
│   ├── pdfController.js
│   └── imageController.js
├── routes/                      — All routes accept files up to 100 MB
│   ├── organize.js              — Merge, Split, Rotate, Crop, Organize PDF
│   ├── edit.js                  — Compress, Edit, Watermark, Sign, Page Numbers, Redact
│   ├── convert.js               — JPG↔PDF, Scan, PDF↔Word/PPT/Excel/HTML
│   ├── security.js              — Protect / Unlock PDF
│   ├── advanced.js              — Repair, OCR, Compare, AI Summarizer, Translate, Workflow
│   └── image.js                 — Background Remover, Crop, Resize, Filters
├── public/
│   ├── index.html               — Dashboard (mega-menu header, 5-col footer, signup modal, processing overlay)
│   ├── tool.html                — Tool page (same persistent layout)
│   ├── blog.html, blog/         — Blog
│   ├── privacy.html, terms.html, disclaimer.html
│   ├── robots.txt, sitemap.xml
│   ├── css/styles.css           — Full design system (red theme, mega-menu, footer, processing UI)
│   └── js/
│       ├── tools-config.js      — All tool definitions + 8 categories (matches header hierarchy)
│       ├── config.js            — API base + queue API base resolution
│       ├── queue-client.js      — Queue submit + 3 s polling for heavy tools (Cloudflare Worker)
│       ├── sidebar.js           — Sidebar nav with category groupings
│       ├── mega-menu.js         — Topbar mega-menu (8 categories with hover/click dropdowns)
│       ├── dashboard.js         — Card rendering for the home page
│       ├── tool-page.js         — Per-tool UI, drag-drop reorder, rotation, branded download, signup check
│       └── shared.js            — Modals, sidebar toggle, cookies, signup-required, processing overlay
└── cloudflare/worker/           — Scalable queue layer (deployed to Cloudflare, NOT to this Repl)
    ├── wrangler.toml            — KV / R2 / Queue bindings + env vars
    ├── README.md                — One-time setup + deploy guide
    └── src/
        ├── index.js             — Producer (HTTP) + queue consumer in one Worker
        ├── jobs.js              — KV job-record CRUD
        ├── r2.js                — R2 helpers (input upload, result save, signed URLs)
        ├── auth.js              — Firebase ID-token verifier (RS256, no SDK)
        ├── limits.js            — Tier caps mirroring utils/usage.js
        └── processors.js        — HF Space delegation + pdf-lib light fallback
```

## Tool routing

| Path                                           | Tools                                                                                                       |
|------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Direct → Express backend (unchanged)           | Merge, Split, Rotate, Crop, Organize, JPG↔PDF, Page Numbers, Watermark                                       |
| Queue → Cloudflare Worker (`pdf-jobs`)         | Compress, OCR, PDF↔Word/Excel/PowerPoint, AI Summarizer, Translate, Background Remover, Image Resize/Filters, Compare |

The frontend's `queue-client.js` decides per tool. Routing only kicks in
when `window.QUEUE_API_BASE` resolves to a real Worker URL, so dev/staging
keep working against the Express backend out of the box.

## Brand & UI

- **Brand**: ILovePDF
- **Primary color**: `#E5322E` (red)
- **Download filenames**: `ILovePDF-[Original-Name].<ext>`
- **Persistent layout**: header (with mega-menu) and 5-column footer present on every page
- **Mega-menu hierarchy** (matches sidebar):
  - Organize PDFs · Compress & Optimize · Convert From PDF · Convert To PDF · Edit & Annotate · Security · Advanced Tools · Image Tools

## Editor Features

- File thumbnails with drag-and-drop reordering (mouse + touch)
- Per-file rotation control (`rotations[]` sent in form data)
- Dedicated full-screen **processing overlay** with animated spinner before download
- 100 MB client-side size guard → opens **Sign Up Required** modal
- 100 MB backend limit (multer) returns `413` → also triggers Sign Up modal

## Tech Stack

- **Backend**: Node.js + Express 5 (ES Modules), multer (100 MB), express-rate-limit, compression
- **PDF processing**: pdf-lib, mammoth, pptxgenjs, exceljs, pdf-parse, JSZip
- **Image processing**: sharp
- **Frontend**: Pure HTML/CSS/JS (no frameworks), Lucide icons, Inter font, fully responsive

## Running

```bash
node server.js   # listens on port 5000
```

## Deployment

Frontend is hosted on **Firebase Hosting** (`ilovepdf.cyou`, project `ilovepdf-web`).
Backend (Node/Express) is intended to run on a separate host (e.g. Replit Deployments,
Railway, Fly, Render). The frontend reaches the backend via `public/js/config.js`,
which maps each frontend host to a backend URL through `HOST_TO_BACKEND` and exposes:

- `window.API_BASE` — root URL for API calls
- `apiUrl(path)` — prefixes API paths with the backend
- `apiFetch(path, opts)` — fetch wrapper that adds `credentials: 'include'`

`firebase.json` rewrites `/api/**` to `/index.html` so static hosting doesn't 404
on accidental client-side API misroutes; real API calls go directly to the backend.

### Server-side configuration (env vars)

| Variable                       | Purpose                                          |
|--------------------------------|--------------------------------------------------|
| `JWT_SECRET`                   | Signs the `ilovepdf_token` auth cookie           |
| `ALLOWED_ORIGINS`              | Extra CORS origins (comma-separated). Defaults already include `ilovepdf.cyou`, `www.ilovepdf.cyou`, `ilovepdf-web.web.app`, `ilovepdf-web.firebaseapp.com`. Use `*` to allow any. |
| `MAX_UPLOAD_MB`                | Hard ceiling on per-file upload size (default 200) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare R2 storage (uploads + saved files) |
| `FIREBASE_API_KEY` *or* `GOOGLE_API_KEY` | Public Firebase Web SDK API key (either env var works) |
| `FIREBASE_AUTH_DOMAIN` / `FIREBASE_PROJECT_ID` / `FIREBASE_APP_ID` / `FIREBASE_STORAGE_BUCKET` | Public Firebase Web SDK config (returned by `/api/config/firebase`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Admin SDK credentials for verifying Firebase ID tokens |
| `HF_API_TOKEN` (or legacy `HUGGINGFACE_API_TOKEN`) | Hugging Face inference token for AI tools |
| `HF_SPACE_URL`                 | Optional self-hosted HF Space fallback URL |

The backend logs which services are enabled at startup. Until R2/Firebase env vars
are set, those endpoints respond with `503 not configured` instead of crashing.

### User tier system

`utils/usage.js` enforces three tiers, all in one middleware (`checkUsage`):

| Tier    | Detection                                | Daily files | Per-file cap |
|---------|------------------------------------------|-------------|--------------|
| guest   | No auth cookie                           | 10          | 60 MB        |
| free    | Logged in, `users.plan='free'` (default) | 30          | 200 MB       |
| premium | Logged in, `users.plan='premium'`        | unlimited   | `MAX_UPLOAD_MB` |

To upgrade a user manually:
```sql
UPDATE users SET plan='premium' WHERE email='someone@example.com';
```

### Auto-cleanup

- Local uploads (`UPLOAD_DIR`): swept every 15 min by `utils/upload.js`.
- R2 `tmp/` prefix: swept every 5 min, objects older than 10 min deleted
  (`utils/r2.js → startR2Sweeper`).
- R2 `users/<uid>/` prefix: kept until the user deletes from /dashboard.html.

## Frontend tool dispatcher

`public/js/app-router.js` exposes a single `window.runTool(toolId, files, opts)`
plus a `TOOL_MAP` describing how each of the 33 tools is handled:

```js
TOOL_MAP['merge']    // { type: 'browser', id: 'merge' }       -> pdf-lib
TOOL_MAP['compress'] // { type: 'api', endpoint: '/api/compress', field: 'pdf' }
```

Browser tools (8) run entirely client-side via `browser-tools.js`
(merge, split, rotate, crop, organize, page-numbers, watermark, jpg-to-pdf).
The remaining 25 dispatch to the backend through `apiUrl()` from `config.js`
(which auto-prefixes with the production backend URL when the page is served
from Firebase Hosting).

`tool-page.js` already integrates this fast path internally — `runTool` is
the standalone API for any future entry points (quick-action cards, CLI,
external embeds).

### Cross-origin auth cookie

Because the frontend (Firebase) and backend (Replit/Railway) live on different
origins, `routes/auth.js` automatically sets the auth cookie with
`SameSite=None; Secure` for cross-origin requests, and `SameSite=Lax` for
same-origin (local dev / single-host deploy).

## Frontend pages

- `/` — Dashboard (tool grid)
- `/tool.html?id=...` — Per-tool page (also reachable via SEO slugs like `/merge-pdf.html`)
- `/n2w.html` — Numbers-to-words converter (special tool)
- `/dashboard.html` — "My Files" — lists the signed-in user's R2-saved files
- `/verify-signup.html` — Email-confirmation step of signup
- `/blog.html`, `/privacy.html`, `/terms.html`, `/disclaimer.html` — Static pages

## Tool-page routing

`utils/seo.js` (server) and `public/js/tools-config.js` (client) share the same
`SLUG_MAP` (34 entries). On Firebase static hosting, `tool-page.js` calls
`window.resolveToolIdFromUrl()` which checks (in order):

1. `window.__TOOL_ID` (server-injected, when serving from Express)
2. The current pathname against `SLUG_MAP`
3. The `?id=` query param
4. The first path segment

If nothing matches, a friendly **Tool not found** screen is rendered instead of
silently redirecting to `/` (the original "page reload" bug).

## Phase 1–5 Polish (April 2026)

- **Header redesign (chrome.js + home.css)**: Desktop header now shows inline nav: Merge PDF | Split PDF | Organize ▼ | Convert ▼ | All Tools ▼ | Search bar. Organize/Convert are simple dropdowns (hover + click toggle, ARIA-expanded). Mobile (<1024px) centers the brand and replaces the full search bar with a search icon that opens the mobile overlay. Implemented `wireSimpleDropdowns()` and `wireMobileSearchBtn()` in chrome.js.
- **Trust strip (tool-page.js)**: Changed "auto-deleted within 1 hour" → "auto-deleted after 10 minutes" to match R2 sweeper config.
- **SEO canonical URL (tool-page.js)**: `setMetaForStep()` now creates/updates a `<link rel="canonical">` pointing to the base tool URL (`origin/slug`) on every step render — preview and download steps still point back to the upload page.

## Recent Changes (April 2026)

- **Cloudflare Worker — CORS hardened**: `corsHeaders()` now mirrors the request origin when `ALLOWED_ORIGINS=*` (avoids the "Access-Control-Allow-Credentials with wildcard" pitfall) and exposes `content-disposition`. Added `readHfToken(env)` which accepts `HF_API_TOKEN`, `HF_TOKEN`, `HUGGINGFACE_API_TOKEN`, or `HUGGING_FACE_TOKEN`. `processors.js` uses the same fallback chain.
- **Header (chrome.js)** — "All Tools" mega-menu now lists ONLY the tools NOT already exposed in the main header (Advanced + Image groups). The Organize / Convert / Edit / Security tools remain in the inline dropdowns.
- **Mobile header (home.css)** — keeps Logo + Brand + Login + Signup + Hamburger visible at every breakpoint. Removed the rule that previously hid `.btn-signin` below 1280 px. `html, body { overflow-x:hidden }` to kill any horizontal scroll.
- **Compress PDF (tool-page.js + page-organizer.js + home.css)** — `compress` is removed from `PAGE_LEVEL_TOOLS`; tool-page.js renders a custom **single-page thumbnail preview** for the uploaded PDF. Tier-aware compression options:
  - Free / anonymous: locked at "High" (~30 % reduction) with a Sign-up CTA.
  - Logged-in / paid: full Low / Medium / High slider mapped to the `level` form field forwarded to the worker / HF Space.
- **Download Swell + Burst (home.css + tool-page.js)** — the "Download Again" CTA is wrapped in `.dl-pulse` so it gently swells when ready. Click triggers `explodeAt()` which spawns a particle burst before the download fires; respects `prefers-reduced-motion`.
