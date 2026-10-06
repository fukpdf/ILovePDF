# 16 — CLOUDFLARE WORKER

## Purpose

The Cloudflare Worker (`ilovepdf-queue`) handles heavy async PDF processing jobs that are too computationally expensive or slow for the browser or the main Node.js server. It uses Cloudflare Queues as a message bus and R2 for file storage.

---

## Architecture

```
Browser/Server
  → POST job to /api/queue/submit (Node.js server)
     → puts file to R2 tmp/
     → sends message to Cloudflare Queue (pdf-jobs)
        → Worker consumer picks up message
           → fetches file from R2
           → calls HF Space for heavy AI/ML processing
           → stores result in R2
           → updates job status in KV (PDF_STATUS)
  → GET /api/queue/status/:jobId
     → reads status from Cloudflare KV
```

---

## Worker Config (`cloudflare/worker/wrangler.toml`)

```toml
name              = "ilovepdf-queue"
main              = "src/index.js"
compatibility_date  = "2025-09-23"
compatibility_flags = ["nodejs_compat"]
account_id        = "a1fbd4659b273ef75414f02cc29acaf5"

# KV: job status
[[kv_namespaces]]
binding = "PDF_STATUS"
id      = "2737f11930d841a782ae421b8dd9175a"

# R2: file + result storage
[[r2_buckets]]
binding     = "R2"
bucket_name = "ilovepdf"

# Queue producer
[[queues.producers]]
queue   = "pdf-jobs"
binding = "PDF_QUEUE"

# Queue consumer
[[queues.consumers]]
queue              = "pdf-jobs"
max_batch_size     = 5       # up to 5 messages per batch
max_batch_timeout  = 5       # wait up to 5s to fill batch
max_concurrency    = 10      # 10 parallel consumer instances
max_retries        = 2       # retry failed messages twice
dead_letter_queue  = "pdf-jobs-dlq"  # failed messages → DLQ

[vars]
HF_SPACE_URL        = "https://ilovepdf-ilovepdf.hf.space"
RESULT_TTL_SECONDS  = "86400"    # results expire after 24h
SKIP_QUEUE_BYTES    = "2097152"  # files < 2 MB skip queue
ALLOWED_ORIGINS     = "*"
FIREBASE_PROJECT_ID = "ilovepdf-web"
```

---

## Worker Source Files (`cloudflare/worker/src/`)

| File | Purpose |
|------|---------|
| `index.js` | Entry point — exports `fetch` + `queue` handlers, routes requests |
| `auth.js` | JWT validation (uses same JWT_SECRET as main server) |
| `jobs.js` | Job lifecycle management (create, status, cancel, cleanup) |
| `processors.js` | Per-job-type processing logic (OCR, AI summarize, translate, etc.) |
| `r2.js` | R2 helpers (put, get, delete, pre-signed URLs) |
| `admin.js` | Admin endpoints for queue management |
| `limits.js` | Per-user rate limits + file size enforcement in Worker context |

---

## Job Types

| Job type | HF Processing | Description |
|----------|--------------|-------------|
| `ocr-heavy` | Yes | OCR on large/complex scanned PDFs |
| `ai-summarize-heavy` | Yes | AI summarization (HF Inference API) |
| `translate-heavy` | Yes | Translation of large documents |
| `repair-heavy` | Yes | Deep repair of corrupt PDFs |
| `compress-heavy` | No | Compression via WASM Ghostscript |

---

## Queue Message Format

```javascript
// Message sent to Queue (via PDF_QUEUE.send())
{
  jobId: 'uuid-v4',
  type: 'ai-summarize-heavy',
  r2Key: 'tmp/1234567890_abc123_document.pdf',
  userId: 123,            // null for guests
  ip: '1.2.3.4',
  opts: {
    language: 'en',
    mode: 'extractive'
  },
  createdAt: 1234567890000
}
```

---

## Job Status (Cloudflare KV)

Key: `job:{jobId}`  
Value (JSON):
```javascript
{
  status: 'pending' | 'processing' | 'done' | 'error',
  progress: 0-100,
  resultKey: 'tmp/result_...',  // R2 key when done
  error: null | 'error message',
  expiresAt: 1234567890         // unix timestamp
}
```

TTL: 24 hours (RESULT_TTL_SECONDS=86400)

---

## HuggingFace Space Integration

The Worker calls `HF_SPACE_URL` (a HuggingFace Gradio Space) for computationally heavy AI operations:

```javascript
// POST {HF_SPACE_URL}/api/predict
{
  fn_index: 0,
  data: [base64_pdf, 'en', 'extractive']
}
```

**Note**: The HF Space (`ilovepdf-ilovepdf`) is maintained separately from this repository. The Worker only calls it via HTTP.

`HF_API_TOKEN` is pushed to the Worker as a secret at deploy time (via `wrangler-action secrets:`).

---

## Skip-Queue Logic

Files under `SKIP_QUEUE_BYTES` (2 MB) skip the queue and are processed synchronously:

```javascript
if (file.size < SKIP_QUEUE_BYTES) {
  return processDirectly(file, opts);  // synchronous
}
// else:
await PDF_QUEUE.send(message);        // async queue
return { jobId, status: 'pending' };
```

---

## R2 Storage

### Temp files
- Key pattern: `tmp/{timestamp}_{id}_{safe_name}`
- Auto-deleted by R2 lifecycle rules after 10 min
- Used for: input files uploaded for processing

### User files (planned)
- Key pattern: `users/{uid}/{timestamp}_{id}_{safe_name}`
- Permanent storage for Premium users
- Download via pre-signed URLs (15-min expiry)

### Result files
- Key pattern: `results/{jobId}.{ext}`
- Deleted when job expires (24h TTL)

---

## R2 Helper (`utils/r2.js` — main server)

```javascript
// Upload file to R2 temp storage
putTempObject(buffer, originalName, contentType) → key

// Upload to user permanent storage
putUserObject(uid, buffer, originalName, contentType) → key

// Generate pre-signed download URL
getSignedUrl(key, expiresInSeconds=900) → signedUrl

// List user's files
listUserObjects(uid) → [{key, size, lastModified}]

// Delete object
deleteObject(key) → void
```

**R2 Sweeper**: `startR2Sweeper()` called at server boot. Runs every 10 min, deletes all `tmp/` objects older than 10 min.

---

## R2 API Routes (`routes/r2.js`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/r2/upload` | Optional | Upload file to R2 tmp/ |
| GET | `/api/r2/download/:key` | Check | Generate signed download URL |
| GET | `/api/r2/list` | JWT | List user's files |
| DELETE | `/api/r2/delete` | JWT | Delete R2 object |

---

## Deployment

```bash
# Deploy Worker only
cd cloudflare/worker
npx wrangler deploy

# Push secrets
npx wrangler secret put HF_API_TOKEN
npx wrangler secret put R2_PUBLIC_BASE_URL

# View Worker logs
npx wrangler tail

# View queue
npx wrangler queues list
```

Or via GitHub Actions (automated on every push to main).
