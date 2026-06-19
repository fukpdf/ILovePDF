# 03 — TECHNICAL REQUIREMENT DOCUMENT (TRD)

## Frontend Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| HTML | Vanilla HTML5 | — |
| CSS | Vanilla CSS (no framework) | — |
| JavaScript | Vanilla ES2020+ (no SPA framework) | — |
| PDF processing | pdf-lib (CDN, IDB-cached) | 1.17.1 |
| PDF rendering | PDF.js (CDN, IDB-cached) | 4.10.38 |
| Word parsing | Mammoth.js (CDN, IDB-cached) | 1.9.0 |
| Excel parsing | XLSX.js (CDN, IDB-cached) | 0.18.5 |
| OCR | Tesseract.js (CDN) | 5.1.1 |
| ZIP | JSZip (CDN, IDB-cached) | 3.10.1 |
| PPTX generation | pptxgenjs (CDN) | 3.12.0 |
| HTML to PDF | html2pdf.js (CDN) | 0.10.3 |
| Icons | Lucide icons (CDN) | — |
| Internationalization | Custom i18n.js | — |

**No build step for frontend.** All JS is vanilla, loaded via `<script>` tags. CDN libraries are cached in IndexedDB for offline/repeat use.

---

## Backend Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20 |
| Framework | Express | 5.2.1 (ES modules) |
| Auth | jsonwebtoken + bcryptjs | 9.0.3 / 3.0.3 |
| Cookies | cookie-parser | 1.4.7 |
| Rate limiting | express-rate-limit | 8.5.2 |
| Compression | compression (gzip) | 1.8.1 |
| File upload | multer | 2.1.1 |
| PDF processing | pdf-lib, pdf-parse | 1.17.1 / 2.4.5 |
| Word export | docx | 9.6.1 |
| Excel export | exceljs | 4.4.0 |
| PPT export | pptxgenjs | 4.0.1 |
| ZIP | jszip | 3.10.1 |
| HTML parsing | node-html-parser | 7.1.0 |
| Image processing | sharp | 0.33.5 |
| Firebase Admin | firebase-admin | 13.10.0 |
| AWS S3 (R2) | @aws-sdk/client-s3 | 3.1053.0 |
| Database | better-sqlite3 | 9.6.0 |

**Module system**: `"type": "module"` — all server-side code uses ES module `import/export`.

---

## Database

**SQLite** via `better-sqlite3`, file at `.data/app.db`, WAL mode.

### Tables

```sql
users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  storage_quota INTEGER NOT NULL DEFAULT 2147483648,  -- 2 GB
  storage_used  INTEGER NOT NULL DEFAULT 0,
  avatar_url    TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)

pending_signups (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
)

usage_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER,
  ip              TEXT NOT NULL,
  daily_usage_mb  REAL NOT NULL DEFAULT 0,
  daily_bytes     INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  last_reset      TEXT NOT NULL
)
```

### Migration approach
Idempotent migrations checked at boot via `pragma_table_info`. No migration framework — just conditional `ALTER TABLE` calls in `utils/db.js`.

---

## Hosting

| Layer | Service | Purpose |
|-------|---------|---------|
| Node.js server | Replit (primary) | API routes, dynamic SEO, auth |
| Static CDN | Firebase Hosting | `/public` directory, `cleanUrls: true` |
| Async jobs | Cloudflare Worker | Heavy PDF processing queue |
| File storage | Cloudflare R2 | Upload temp storage + signed download URLs |
| KV store | Cloudflare KV (`PDF_STATUS`) | Job status tracking |

---

## Firebase

- **Firebase Hosting** (`firebase.json`): Serves `public/` with clean URLs, no .html extensions
- **Firebase Auth** (optional): Google Sign-In via client-side Firebase SDK; server validates ID tokens via Firebase Admin SDK
- **Project ID**: `ilovepdf-web`
- **Firebase Admin**: Lazy-initialized from `FIREBASE_SERVICE_ACCOUNT_JSON` env var; server boots without it

Firebase Hosting rewrites all non-matched paths to `tool.html`. The Node Express server takes precedence during development (port 5000).

---

## Cloudflare

| Resource | Config |
|----------|--------|
| Worker name | `ilovepdf-queue` |
| Compatibility date | 2025-09-23 |
| KV namespace | `PDF_STATUS` |
| R2 bucket | `ilovepdf` |
| Queue | `pdf-jobs` (producer + consumer) |
| Max batch size | 5 messages |
| Max concurrency | 10 |
| Max retries | 2 |
| Dead letter queue | `pdf-jobs-dlq` |
| HF Space URL | `https://ilovepdf-ilovepdf.hf.space` |
| Skip queue threshold | 2 MB (files below go direct) |

---

## GitHub

- **Repo**: main branch
- **CI/CD**: `.github/workflows/deploy.yml` (GitHub Actions)
- **Triggers**: push to `main`
- **Steps**: Firebase Hosting deploy → Cloudflare Worker deploy
- **Secrets required**: `FIREBASE_SERVICE_ACCOUNT`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HF_TOKEN`

---

## Runtime Architecture

See `09_RUNTIME_ARCHITECTURE.md` for full Arc documentation.

Summary: 19 bundles (Phase 6 through Arc 15) loaded deferred after first paint. Total runtime JS: ~1.4 MB bundled. All runtime systems communicate via `window.*` globals with documented API surfaces.

---

## Bundle Architecture

| Bundle | Label | Files | Size |
|--------|-------|-------|------|
| runtime-phase6-core | Phase 6 Non-Deferred Core | 1 | 9 KB |
| runtime-phase6-deferred | Phase 6 Deferred | 12 | 151 KB |
| runtime-phase7 | Phase 7 Zero-Trust Mesh | 24 | 195 KB |
| runtime-phase8-deferred | Phase 8 Deferred Hardening | 6 | 68 KB |
| runtime-phase9-infra | Phase 9 Infrastructure Layer | 6 | 28 KB |
| runtime-arc2 | Arc 2 Production Hardening | 9 | 63 KB |
| runtime-arc3 | Arc 3 Tool Runtime Isolation | 9 | 63 KB |
| runtime-arc4 | Arc 4 Enterprise Tool Runtime Completion | 9 | 80 KB |
| runtime-arc5 | Arc 5 True Enterprise Tool Isolation | 9 | 83 KB |
| runtime-arc6 | Arc 6 Advanced Engine Full Decomposition | 15 | 96 KB |
| runtime-arc7 | Arc 7 Ultra Performance + Streaming | 8 | 79 KB |
| runtime-arc8 | Arc 8 Enterprise Observability + Live Control | 8 | 74 KB |
| runtime-arc9 | Arc 9 Autonomous Self-Healing + Intelligence | 8 | 81 KB |
| runtime-arc10 | Arc 10D Admin Observability Dashboard | 14 | 83 KB |
| runtime-arc11 | Arc 11 Distributed Runtime Mesh | 13 | 109 KB |
| runtime-arc12 | Arc 12 Enterprise Tool Intelligence Layer | 14 | 88 KB |
| runtime-arc13 | Arc 13 Persistent Tool Intelligence | 14 | 74 KB |
| runtime-arc14 | Arc 14 Enterprise Runtime Command Center | 15 | 85 KB |
| runtime-arc15 | Arc 15 Enterprise Runtime Automation & Policy | 15 | 98 KB |

Bundles are built by `scripts/build-runtime-bundles.js`. Integrity verified by `scripts/verify-runtime-bundles.js`.
