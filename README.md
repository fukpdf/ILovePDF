# ILovePDF — Free Online PDF & Image Tools

Production-ready PDF + image processing platform with **33 tools**, branded as **ILovePDF** (red theme `#E5322E`). Single-deploy Node/Express app — runs on Replit, Railway, or any Node host.

## Architecture (current)

```
server.js                      Express entry (port 5000)
├── routes/
│   ├── auth.js                Email/password signup + Firebase Auth bridge
│   ├── r2.js                  Cloudflare R2 upload / signed download / user files
│   ├── organize.js            Merge, Split, Rotate, Crop, Organize PDF
│   ├── edit.js                Compress, Edit, Watermark, Sign, Page Numbers, Redact
│   ├── convert.js             JPG↔PDF, PDF↔Word/PPT/Excel/HTML
│   ├── security.js            Protect / Unlock PDF
│   ├── advanced.js            Repair, OCR, Compare, AI Summarize, Translate, Workflow
│   └── image.js               Background Remover, Crop, Resize, Filters
├── utils/
│   ├── firebase-admin.js      Verifies Firebase ID tokens, mints our cookie
│   ├── r2.js                  S3-compatible R2 client + 10-min tmp/ sweeper
│   ├── ai.js                  Hugging Face: BART summarize + Helsinki-NLP translate
│   ├── usage.js               Per-IP / per-user daily quotas
│   ├── upload.js              Multer config + scratch-disk sweep
│   ├── db.js                  SQLite (.data/app.db) — users + pending_signups
│   └── seo.js                 Slug map + per-tool metadata for SEO routes
└── public/
    ├── index.html, tool.html, blog/*, privacy.html, terms.html …
    ├── css/styles.css, css/home.css
    └── js/
        ├── firebase-init.js   Loads /api/config/firebase, exposes window.FB
        ├── auth-ui.js         Modal: Continue with Google + email/password
        ├── browser-tools.js   pdf-lib in-browser handlers for 8 light tools
        ├── tool-page.js       Per-tool UI; auto-routes to client- or server-side
        ├── tools-config.js    All 33 tool definitions (clientSide flag)
        └── usage-limit.js, shared.js, chrome.js, mega-menu.js, …
```

## Tool execution split

| # | Tool | Where it runs |
|---|---|---|
| 1 | Merge | **Browser** (pdf-lib) |
| 2 | Split | **Browser** |
| 3 | Rotate | **Browser** |
| 4 | Organize / Reorder | **Browser** |
| 5 | Crop | **Browser** |
| 6 | Add Page Numbers | **Browser** |
| 7 | Watermark | **Browser** |
| 8 | JPG/PNG → PDF | **Browser** |
| 9–33 | All other PDF/image/AI tools | Server (Node + pdf-lib + sharp + HF) |

Browser-side tools never upload — files are processed locally with pdf-lib.js. The server-side path is still wired as a fallback if the client handler throws.

## Firebase Auth

- **Frontend** loads `/api/config/firebase` at runtime, then dynamically imports the Firebase web SDK. Provides Continue with Google, email/password, and password reset.
- **Backend** (`/api/auth/firebase`) verifies the ID token with `firebase-admin`, creates / updates a row in our SQLite `users` table, and sets the existing `ilovepdf_token` JWT cookie. All other endpoints (usage limits, R2 ownership, etc.) keep working unchanged.
- **Fallback**: if Firebase is not configured on the server, the modal falls back to legacy `/api/auth/signup` + `/api/auth/login`.

## Cloudflare R2

- `POST /api/r2/upload` (field `file`, optional `permanent=1` for logged-in users) → returns `{ key, url }`.
- `GET /api/r2/download?key=...` → returns a fresh 10-minute signed URL. Keys under `users/<id>/` require the matching session.
- `GET /api/user/files` → lists the logged-in user's permanent files.
- **Auto-cleanup**: every 5 min the server scans `tmp/*` and deletes any object older than 10 minutes.

## Hugging Face (AI tools only)

- `/api/ai-summarize` → `facebook/bart-large-cnn` for chunked + recursive summarisation.
- `/api/translate` → `Helsinki-NLP/opus-mt-en-{es,fr,de,it,pt,ru,zh,ja,ar,hi,nl,ko}`.
- Both routes fall back to the existing offline implementation if the HF token is missing or the API errors out.

## Environment variables

Copy `.env.example` to `.env` (or set in Replit Secrets). Required for the new features:

| Variable | Where to get it |
|---|---|
| `FIREBASE_API_KEY` | Firebase Console → Project Settings → Your apps → Web → Config |
| `FIREBASE_AUTH_DOMAIN` | Same place — usually `yourproject.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | Same place |
| `FIREBASE_APP_ID` | Same place |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Project Settings → Service Accounts → **Generate new private key** → paste the entire JSON file as a single line |
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → top of the R2 page (32-hex string) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 → Manage R2 API tokens → Create token (Object Read & Write) |
| `R2_BUCKET` | The bucket name you created (e.g. `ilovepdf-storage`) |
| `HUGGINGFACE_API_TOKEN` | huggingface.co → Settings → Access Tokens (Read) |

Optional:

- `JWT_SECRET` — long random string (defaults to a dev value; **set in production**).
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to call `/api/*` from a different domain (e.g. `https://www.yourdomain.com,https://app.yourdomain.com`).
- `MAX_UPLOAD_MB` — currently hard-coded at 100; raise via `utils/upload.js` if needed.

## Endpoints summary

```
GET  /api/health                        Status of firebase / r2 / hf
GET  /api/config/firebase               Public Firebase web config

POST /api/auth/signup                   Legacy email/password signup
POST /api/auth/login                    Legacy email/password login
POST /api/auth/firebase                 Mint cookie from Firebase ID token
POST /api/auth/logout
GET  /api/auth/me

POST /api/r2/upload                     Upload file (tmp/ or users/<id>/)
GET  /api/r2/download?key=...           Signed download URL
GET  /api/user/files                    List user's permanent files

POST /api/merge        /split /rotate /crop /organize     (server-side fallback)
POST /api/compress
POST /api/pdf-to-word  /pdf-to-powerpoint /pdf-to-excel /pdf-to-jpg
POST /api/word-to-pdf  /powerpoint-to-pdf /excel-to-pdf /jpg-to-pdf /html-to-pdf
POST /api/edit /watermark /sign /page-numbers /redact
POST /api/protect /unlock
POST /api/repair /ocr /compare /ai-summarize /translate /workflow
POST /api/image/bg-remove /image/crop /image/resize /image/filter
```

## Running locally

```bash
npm install
cp .env.example .env   # then fill in real values
node server.js
```

App listens on `http://localhost:5000`.

## Deployment

- **Replit** — already wired; press Run.
- **Railway / Cloud Run** — `node server.js` with the same env vars. Behind a load balancer, leave `app.set('trust proxy', 1)` as-is.
- **Custom domain** (Cloudflare DNS) — point `app.yourdomain.com` (or apex) at the host. Set `ALLOWED_ORIGINS` if you split frontend/backend across two hostnames.

## Security notes

- All secrets live in env vars — never in source.
- `.gitignore` excludes `.env`, `.data/`, `uploads/`, `node_modules/`, `attached_assets/`.
- Per-IP rate limiting (80 req / 15 min on `/api/*`).
- Per-user / per-IP daily file & data quotas (`utils/usage.js`).
- Multer enforces 100 MB upload cap; oversize requests rejected before parsing.
- Strict security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- R2 credentials never reach the browser; downloads use 10-minute signed URLs.
- Firebase ID tokens are verified server-side with the Admin SDK on every login.
# ILovePDF
