# 19 — DATA FLOWS

## File Processing Data Flow

### Client-Side Processing (Zero Upload)

```
User selects file
  ↓
File stays in browser memory (File object)
  ↓
BrowserTools.process(toolId, [file], opts)
  ↓
CDN library loaded (if needed, from IDB cache or CDN)
  ↓
Web Worker spawned (or reused from pool)
  ↓
File → ArrayBuffer → posted to Worker via SharedArrayBuffer or copy
  ↓
Worker processes (pdf-lib, XLSX, Tesseract, etc.)
  ↓
Result ArrayBuffer → back to main thread
  ↓
Wrap in Blob → blob: URL
  ↓
User downloads via <a download> → file never left the device
```

### Server-Side Processing (Upload)

```
User selects file
  ↓
FormData built (file + options)
  ↓
POST /api/{tool} (e.g. /api/merge)
  ↓
multer middleware: file written to /tmp/ilovepdf-uploads/{uuid}
  ↓
checkUsage: usage_log updated (daily_bytes + file_count)
  ↓
Route handler processes file with native libs:
  - qpdf / Ghostscript (shell exec via child_process)
  - pdf-lib (Node.js)
  - Sharp (image)
  - docx / exceljs / pptxgenjs
  ↓
Output buffer assembled
  ↓
cleanupFiles(): /tmp/{uuid} deleted
  ↓
res.send(buffer) with Content-Disposition: attachment
  ↓
Browser receives blob → blob: URL for download
```

### Cloudflare Queue Processing (Heavy Async)

```
User submits heavy job
  ↓
POST /api/queue/submit (Node.js server)
  ↓
File PUT to R2 (tmp/{id})
  ↓
PDF_QUEUE.send({ jobId, type, r2Key, opts })
  ↓
KV: PDF_STATUS[job:{jobId}] = { status:'pending' }
  ↓
Client polls GET /api/queue/status/:jobId
  ↓
Worker picks up message from Queue
  ↓
R2.get(r2Key) → file bytes
  ↓
POST {HF_SPACE_URL}/api/predict
  ↓
KV: status='processing', progress=...
  ↓
HF returns result
  ↓
R2.put('results/{jobId}.pdf', result)
  ↓
KV: status='done', resultKey='results/{jobId}.pdf'
  ↓
Client polls: status='done'
  ↓
GET /api/r2/download/{resultKey} → signed URL
  ↓
User downloads from R2 signed URL (15 min expiry)
  ↓
R2 lifecycle deletes result after 24h
```

---

## Auth Data Flow

### Sign Up

```
POST /api/auth/signup { email, name, password }
  ↓
Validation: email unique, password >= 6 chars
  ↓
bcrypt.hash(password, 10) → password_hash
  ↓
INSERT INTO users (email, name, password_hash, storage_quota=2GB)
  ↓
jwt.sign({ id, email, name }, JWT_SECRET, { expiresIn:'30d' })
  ↓
res.cookie('ilovepdf_token', token, { httpOnly, sameSite, secure, maxAge:30d })
  ↓
Response: { user: { id, email, name, storage_quota, storage_used, avatar_url } }
```

### Google Sign-In

```
Client: Firebase SDK → Google OAuth → ID token
  ↓
POST /api/auth/firebase { idToken }
  ↓
Firebase Admin: verifyIdToken(idToken)
  → decoded: { email, name, picture, uid }
  ↓
SELECT user by email
  → exists: update avatar_url if changed
  → doesn't exist: INSERT new user
  ↓
Same JWT + cookie response as email/password
```

---

## Usage Tracking Data Flow

### Pre-flight check (before upload)

```
POST /api/{tool} (any file upload)
  ↓
checkUsage middleware:
  1. Read JWT cookie → user.id (or null for guest)
  2. SELECT from usage_log WHERE user_id=? (or ip=?)
  3. If last_reset != today(): reset file_count=0, daily_bytes=0
  4. Check: file_count >= LIMITS[tier].files? → 429 "Daily limit reached"
  ↓
multer parses file (now that pre-flight passed)
  ↓
enforcePerFile middleware:
  5. Check: req.file.size > LIMITS[tier].perFile? → 413 "File too large"
  6. UPDATE usage_log SET file_count=file_count+1, daily_bytes=daily_bytes+size
```

### Per-session tracking (client-side)

```
window.UsageLimit.increment(toolId, fileSize)
  → updates localStorage counts (visual feedback only)
  → client-side limit hit: shows upgrade modal

Server always enforces true limits (cannot be bypassed)
```

---

## SEO Injection Data Flow

### Per-tool page request

```
GET /merge-pdf
  ↓
server.js: slug = 'merge-pdf'
  ↓
SLUG_MAP lookup: { id:'merge' }
  ↓
buildHtml('merge-pdf', TOOL_HTML, 'upload')
  ↓
getToolSeo('merge-pdf', 'Merge PDF')
  → { title, desc, long (300+ words), faqs, related }
  ↓
Inject into TOOL_HTML:
  - <title>
  - <meta name="description">
  - <link rel="canonical">
  - OG/Twitter meta tags
  - JSON-LD: SoftwareApplication + FAQPage + HowTo + BreadcrumbList
  - window.__TOOL_ID = 'merge'
  - window.__STEP = 'upload'
  - Tool description HTML (H1 + intro + FAQ + related tools)
  ↓
injectNonce(html, res.locals.nonce)
  → replace __CSP_NONCE__ with per-request nonce
  ↓
res.set('Cache-Control', 'no-store')
res.type('html').send(finalHtml)
```

---

## State Persistence Data Flow

### File state across page navigation

```
User uploads file → processFiles() succeeds
  ↓
ToolState.save({
  toolId: 'rotate',
  step: 'download',
  resultBlobId: uuid,
  filename: 'ilovepdf-rotate.pdf',
  originalFileName: 'document.pdf',
  pageState: { order:[1,2,3], rotations:[0,90,0] }
})
  → localStorage: JSON metadata
  → IDB: actual Blob bytes (key=resultBlobId)
  ↓
User navigates away / refreshes
  ↓
tool-page.js loads: hydrateFlowState()
  → read localStorage metadata
  → if step='download': load Blob from IDB
  → restore download state (skip re-upload/processing)
```

---

## Security Telemetry Data Flow

```
Browser detects anomaly (e.g., repeated failed requests)
  ↓
window.RuntimeForensics.snapshot('suspicious-pattern', ctx)
  ↓
window.RuntimeSessionRecorder.record(event)
  ↓
POST /api/security-telemetry {
  type: 'suspicious-pattern',
  ctx: { toolId, count, timestamps },
  sessionId: 'uuid',
  timestamp: 1234567890000
}
  ↓
Server: validate packet (packetValidatorSoft)
  ↓
INSERT into security_incidents (type, severity, ctx, ip, userId, timestamp)
  ↓
panel-incidents.js: polls /api/security-dashboard/incidents
  → displays in admin dashboard
```

---

## CDN Library Loading Data Flow

```
BrowserTools.process() needs pdf-lib
  ↓
loadScriptCached(PDFLIB_URL, 'PDFLib', _pdflibSlot)
  ↓
window.IDBCache.get(PDFLIB_URL)
  → IDB hit: bytes → blob: URL → inject as <script>
  → IDB miss:
      fetch(PDFLIB_URL) → bytes
      execute via CDN script tag
      IDB.put(PDFLIB_URL, bytes)
      resolve(window.PDFLib)
  ↓
window.PDFLib now available
  ↓
BrowserTools._processors[toolId](files, opts, PDFLib)
```

---

## Blog Data Flow

```
scripts/blog-data.js (source of truth)
  ↓
node scripts/generate-blogs.js
  ↓
For each article:
  1. Generate HTML from template + article data
  2. Inject Article + FAQPage + BreadcrumbList JSON-LD
  3. Write public/blog/{slug}.html
  4. Update public/blog.html (article listing)
  ↓
git commit + push to main
  ↓
GitHub Actions: Firebase Hosting deploy
  ↓
Firebase CDN serves /blog/{slug} (via cleanUrls)
  → Cache-Control: public, max-age=300
```
