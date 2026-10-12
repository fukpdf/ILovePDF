# 06 — BACKEND SCHEMA

## Server Architecture

```
server.js (Express 5, ES modules)
  │
  ├── Middleware stack (in order):
  │   1. compression (gzip)
  │   2. requestTimingMiddleware (server-health-monitor)
  │   3. Homepage SEO injection (GET /)
  │   4. Geo API (GET /api/geo)
  │   5. seoRouter (sitemap, robots, tool categories)
  │   6. Legacy .html → clean URL 301 redirects
  │   7. Blog routes (GET /blog, GET /blog/:slug)
  │   8. CSP + Security headers middleware (per-request nonce)
  │   9. apiLimiter (80 req/15 min)
  │   10. express.json({ limit: '2mb' })
  │   11. cookieParser
  │   12. adminRouter (before rate limit)
  │   13. communityApiRouter (before rate limit)
  │   14. /api/config/firebase, /api/health, /api/server-health
  │   15. originGuard (all /api/* except health/config)
  │   16. authRouter (/api/auth/*)
  │   17. r2Router (/api/r2/*)
  │   18. searchRouter (/api/search/*)
  │   19. Security telemetry + execution tickets + incident routers
  │   20. packetValidatorSoft (POST body validation)
  │   21. /live-intel router
  │   22. /debug router (Arc 10D)
  │   23. checkUsage (per-file pre-flight quota)
  │   24. organizeRouter, editRouter, convertRouter, securityRouter, advancedRouter, imageRouter
  │   25. enforcePerFile (file size enforcement)
  │   26. Error handler
  │   27. Static pages (about, privacy, terms, disclaimer, blog)
  │   28. Tool SEO routes (GET /:slug, GET /:slug/:step)
  │   29. express.static('public') [with BUILD_ID cache-busting]
  │   30. Catch-all (index.html)
```

---

## Routes

### Auth Routes (`routes/auth.js`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | — | Create account (email+password) |
| POST | `/api/auth/login` | — | Log in, set JWT cookie |
| POST | `/api/auth/logout` | — | Clear JWT cookie |
| GET | `/api/auth/me` | JWT | Get current user profile |
| POST | `/api/auth/firebase` | — | Exchange Firebase ID token for JWT cookie |
| POST | `/api/auth/change-password` | JWT | Change password |
| DELETE | `/api/auth/account` | JWT | Delete account |

**Cookie**: `ilovepdf_token` — httpOnly, 30-day, SameSite=lax (same-origin) or None;Secure (cross-origin)

---

### Organize Routes (`routes/organize.js`)

| Method | Path | Description | Library |
|--------|------|-------------|---------|
| POST | `/api/merge` | Merge 2+ PDFs | qpdf → pdf-lib fallback |
| POST | `/api/split` | Split PDF by page range | qpdf → pdf-lib fallback |
| POST | `/api/rotate` | Rotate PDF pages | qpdf → pdf-lib fallback |
| POST | `/api/reorder` | Reorder PDF pages | pdf-lib |

---

### Edit Routes (`routes/edit.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/compress` | Compress PDF (Ghostscript → pdf-lib fallback) |
| POST | `/api/edit` | Add text overlay |
| POST | `/api/watermark` | Add text/image watermark |
| POST | `/api/sign` | Embed signature |
| POST | `/api/crop` | Crop page margins |
| POST | `/api/page-numbers` | Add page numbers |
| POST | `/api/redact` | Redact text |

---

### Convert Routes (`routes/convert.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jpg-to-pdf` | Images → PDF |
| POST | `/api/html-to-pdf` | HTML → PDF |
| POST | `/api/pdf-to-word` | PDF → DOCX (pdf-parse + docx) |
| POST | `/api/pdf-to-excel` | PDF → XLSX (pdf-parse + exceljs) |
| POST | `/api/pdf-to-powerpoint` | PDF → PPTX (pptxgenjs) |
| POST | `/api/pdf-to-jpg` | PDF pages → ZIP of JPGs (Sharp) |
| POST | `/api/word-to-pdf` | DOCX → PDF |
| POST | `/api/excel-to-pdf` | XLSX → PDF |
| POST | `/api/powerpoint-to-pdf` | PPTX → PDF |
| POST | `/api/word-to-excel` | DOCX → XLSX |

---

### Security Routes (`routes/security.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/protect` | Encrypt PDF (qpdf → pdf-lib fallback) |
| POST | `/api/unlock` | Decrypt PDF |

---

### Advanced Routes (`routes/advanced.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/repair` | Repair corrupt PDF |
| POST | `/api/ocr` | Apply OCR (Tesseract.js via worker) |
| POST | `/api/translate` | Translate PDF text (MyMemory API) |
| POST | `/api/compare` | Compare two PDFs |
| POST | `/api/ai-summarize` | Summarize PDF (extractive) |

---

### Image Routes (`routes/image.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/background-remove` | Remove image background (Sharp) |
| POST | `/api/crop-image` | Crop image |
| POST | `/api/resize-image` | Resize image |
| POST | `/api/filters` | Apply image filters |

---

### R2 Routes (`routes/r2.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/r2/upload` | Upload file to R2 tmp/ |
| GET | `/api/r2/download/:key` | Get signed download URL |
| GET | `/api/r2/list` | List user files (JWT auth) |
| DELETE | `/api/r2/delete` | Delete R2 object |

---

### SEO Routes (`routes/seo-routes.js`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sitemap.xml` | Sitemap index |
| GET | `/robots.txt` | Robots rules |
| GET | `/pdf-tools` | Tools category page |
| GET | `/submit-urls` | Ping search engines |
| GET | `/ping-index` | Ping indexing |

---

## Middleware

### CSP Middleware
Runs on every request. Generates per-request nonce (`utils/csp-nonce.js`). Sets:
- `Content-Security-Policy`: strict policy with nonce-based script-src
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: restricts accelerometer, geolocation, gyroscope, magnetometer, microphone, payment, serial, USB
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-XSS-Protection: 1; mode=block`

### Rate Limiter
- `express-rate-limit`: 80 req/15 min per IP on all `/api/*` routes
- Community API excluded (has own caching)
- Admin routes excluded

### Origin Guard (`utils/origin-guard.js`)
Validates `Origin` header on all `/api/*` requests. Allows same-origin and configured domains (`ALLOWED_ORIGINS` env var, defaults to production domains).

### Packet Validator (`utils/runtime-packet-validator.js`)
Soft validation on API POST bodies. Logs anomalies; does not block (soft mode).

### Usage Limiter (`utils/usage.js`)
- `checkUsage(req, res, next)`: Pre-flight check before `multer` parses body. Checks daily file count + byte quota.
- `enforcePerFile(req, res, next)`: Post-upload check on individual file size.

---

## File Handling

**Upload**: `multer` with `dest: UPLOAD_DIR` (`/tmp/ilovepdf-uploads` or R2 if configured).

**File size limits**: 100 MB via multer, then enforced again by `enforcePerFile`.

**Cleanup**: `utils/cleanup.js` provides `cleanupFiles(files)` — deletes temp files after response sent. `sweepUploads()` runs periodically to remove orphaned files.

**R2 storage**: `putTempObject()` writes to `tmp/{timestamp}_{id}_{filename}`. Auto-deleted by R2 lifecycle rules after 10 min (configurable).

---

## Validation

### Server-side Input Validation
- File type: checked via multer `fileFilter`
- File size: 100 MB cap via multer limits + enforcePerFile
- Page range: Regex parser in `parsePageRange()` within route handlers
- Text inputs: trimmed, length-checked inline

### Client-side Validation (before any upload)
- File type: checked against `tool.acceptedFiles`
- File size: checked against tier limit (guest 60 MB, free 200 MB)
- Empty file list: caught before `processFiles()`

---

## Error Handling

```js
// Global error handler in server.js
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')  → 413 "File too large"
  if (err.type === 'entity.too.large') → 413 "Request too large"
  else → 500 "Internal server error"
})
```

Route-level errors use `clientErrStatus(err)` helper:
- Returns 400 for input errors (no file, invalid range, corrupt, empty)
- Returns 500 for server faults
