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
└── public/
    ├── index.html               — Dashboard (mega-menu header, 5-col footer, signup modal, processing overlay)
    ├── tool.html                — Tool page (same persistent layout)
    ├── blog.html, blog/         — Blog
    ├── privacy.html, terms.html, disclaimer.html
    ├── robots.txt, sitemap.xml
    ├── css/styles.css           — Full design system (red theme, mega-menu, footer, processing UI)
    └── js/
        ├── tools-config.js      — All tool definitions + 8 categories (matches header hierarchy)
        ├── sidebar.js           — Sidebar nav with category groupings
        ├── mega-menu.js         — Topbar mega-menu (8 categories with hover/click dropdowns)
        ├── dashboard.js         — Card rendering for the home page
        ├── tool-page.js         — Per-tool UI, drag-drop reorder, rotation, branded download, signup check
        └── shared.js            — Modals, sidebar toggle, cookies, signup-required, processing overlay
```

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
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare R2 storage (uploads + saved files) |
| `FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN` / `FIREBASE_PROJECT_ID` / `FIREBASE_APP_ID` | Public Firebase Web SDK config (returned by `/api/config/firebase`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Admin SDK credentials for verifying Firebase ID tokens |
| `HF_API_KEY`                   | Optional Hugging Face token for AI tools          |

The backend logs which services are enabled at startup. Until R2/Firebase env vars
are set, those endpoints respond with `503 not configured` instead of crashing.

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
