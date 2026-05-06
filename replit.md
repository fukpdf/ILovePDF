# ILovePDF — Free Online PDF & Image Tools
ILovePDF is a production-ready platform offering 33+ online tools for PDF and image processing (merge, split, compress, convert, OCR, AI summarize, image manipulation, and more).

## Run & Operate
- **Run**: `node server.js`
- **Port**: 5000
- **Required env vars**: `JWT_SECRET` (auth signing key)
- **Optional env vars**:
  - Firebase Auth: `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`
  - Cloudflare R2 storage: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
  - HuggingFace (informational only): `HF_API_TOKEN`
  - CORS: `ALLOWED_ORIGINS` (comma-separated, defaults to production domains; `*` allows all)

## Stack
- **Backend**: Node.js 20 + Express 5 (ES modules)
- **Frontend**: Vanilla HTML/CSS/JS (no SPA framework)
- **Database**: SQLite via `better-sqlite3` (`.data/app.db` — users, pending signups)
- **Storage**: Cloudflare R2 (optional; falls back to local `/tmp/ilovepdf-uploads`)
- **Auth**: JWT cookies (`ilovepdf_token`) + optional Firebase bridge for Google Sign-In

## Where things live
- `server.js` — Express entry point, middleware, route mounts
- `routes/` — auth, organize, edit, convert, security, advanced, image, r2, seo-routes
- `utils/db.js` — SQLite schema (source of truth)
- `utils/firebase-admin.js` — Firebase Admin init + JWT cookie helpers
- `utils/r2.js` — Cloudflare R2 helpers
- `public/` — all static frontend assets
- `public/js/tools-config.js` — source of truth for all tool definitions
- `public/js/auth-ui.js` — auth modal + profile chip (injected on every page)
- `cloudflare/worker/` — optional Cloudflare Queue Worker for heavy async jobs

## Architecture decisions
- **Browser-first processing**: Most PDF/image tools run in the browser (pdf-lib, canvas APIs); server handles auth, storage, and heavier conversions.
- **Optional Firebase**: Firebase is an enhancement for Google Sign-In only. The app fully works with its own email/password auth (SQLite + bcrypt + JWT).
- **Optional R2**: File uploads fall back to local temp storage when R2 is not configured.
- **Graceful degradation**: All optional services (Firebase, R2, HF) are probed at boot and disabled cleanly if credentials are absent — no hard crashes.
- **Same-origin + cross-origin cookies**: `cookieOpts()` auto-detects cross-origin requests and switches to `SameSite=None; Secure` for the JWT cookie.

## Product
- 33+ PDF tools: merge, split, compress, rotate, watermark, sign, protect, unlock, OCR, repair, compare, AI summarize/translate
- Image tools: background remover, crop, resize, filters
- Utility tools: Numbers to Words, Currency Converter
- User tiers: Guest → Free → Premium with per-day quotas and file-size caps
- SEO: dynamic canonical URLs, structured data, sitemap, blog

## User preferences
- Prefers detailed explanations
- Wants iterative development with confirmation before major changes

## Gotchas
- `JWT_SECRET` must be set; defaults to `dev-secret-change-me` (insecure) if missing
- `better-sqlite3` is a native addon — must be compiled for the correct Node version
- `.data/` directory is auto-created at boot for SQLite; keep it out of Docker/CI caches
- Firebase and R2 are entirely optional — the app boots and runs tools without them

## Pointers
- Express 5 docs: https://expressjs.com/
- pdf-lib: https://pdf-lib.js.org/
- Firebase Admin SDK: https://firebase.google.com/docs/admin/setup
- Cloudflare R2: https://developers.cloudflare.com/r2/
