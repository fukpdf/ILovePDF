# ILovePDF Queue Worker (Cloudflare)

Production-ready queue layer for the heavy tools, built only on
Cloudflare + Firebase + Hugging Face. Sits **alongside** the existing
Express backend — the direct tools (Merge, Split, Rotate, Organize,
JPG↔PDF, Page Numbers, Watermark) keep going to the Express server,
unchanged.

## What lives here

| File                  | Role                                                     |
|-----------------------|----------------------------------------------------------|
| `wrangler.toml`       | KV / R2 / queue bindings, env vars                       |
| `src/index.js`        | HTTP API (producer) + queue consumer in one Worker        |
| `src/jobs.js`         | KV job-record CRUD                                       |
| `src/r2.js`           | R2 helpers (input upload, result save, signed URLs)      |
| `src/auth.js`         | Firebase ID-token verification (RS256, no SDK needed)    |
| `src/limits.js`       | Per-tier daily limits (guest 10/60 MB · free 30/200 MB · premium ∞) |
| `src/processors.js`   | Tool routing → HF Space / pdf-lib light fallback         |

## API

| Method | Path                       | Purpose                                        |
|--------|----------------------------|------------------------------------------------|
| POST   | `/api/queue-job`           | Multipart upload (`tool`, `file`, options) → returns `{job_id, status:"pending"}` (HTTP 202) |
| GET    | `/api/job-status/:job_id`  | Poll status. When `done`, response includes `result_url`, `result_name`, `result_mime` |
| GET    | `/api/job-file/:key`       | Streams an R2 result if you haven't fronted the bucket with a public domain |
| GET    | `/api/limits`              | Returns current tier + daily caps              |
| GET    | `/api/health`              | Liveness + accepted tools                      |

`POST /api/queue-job` and `/api/limits` accept an optional
`Authorization: Bearer <Firebase-ID-token>` header. Unauthenticated calls
are treated as the "guest" tier, keyed by client IP.

## One-time setup

```bash
cd cloudflare/worker
npm install

# 1. Create the queue + DLQ
npx wrangler queues create pdf-jobs
npx wrangler queues create pdf-jobs-dlq

# 2. Create the KV namespace and paste the id into wrangler.toml
npx wrangler kv namespace create PDF_JOBS_KV

# 3. Set the secret(s)
npx wrangler secret put HF_API_TOKEN
# Optional: if you've fronted your R2 bucket with a custom domain
npx wrangler secret put R2_PUBLIC_BASE_URL    # e.g. https://files.ilovepdf.cyou

# 4. Deploy
npx wrangler deploy
```

The deployed URL prints at the end of `wrangler deploy`. Drop it into
`public/js/config.js` → `resolveQueueBase()`, or simply set
`localStorage.setItem('ilovepdf:queue_api_base','https://YOUR-WORKER-URL')`
in DevTools to test before changing code.

## Job lifecycle

```
client ──► POST /api/queue-job ──► R2 (tmp/…)
                              └─► PDF_QUEUE.send(job)
                              └─► KV: status=pending
                              ◄── 202 { job_id }

queue() consumer ──► KV: status=processing
                ──► HF Space (heavy) OR pdf-lib (light)
                ──► R2 (results/…)
                ──► KV: status=done, result_url

client polls GET /api/job-status/:id every 3 s
       └─► fetches result_url, downloads, shows "File ready!"
```

## Failure handling

* HF Space errors / network timeouts → consumer calls `msg.retry()` with
  exponential delay (5 s, 10 s, 15 s) up to `max_retries = 2`.
* Final failure → KV record marked `failed` with the error reason,
  message acked, message also lands in the `pdf-jobs-dlq` for inspection.
* KV records auto-expire after `RESULT_TTL_SECONDS` (24 h default), so
  stale jobs disappear without manual cleanup.

## Tier limits

Mirrors `utils/usage.js` in the Express backend:

| Tier    | Files / day | Per-file size |
|---------|-------------|---------------|
| guest   | 10          | 60 MB         |
| free    | 30          | 200 MB        |
| premium | unlimited   | 1 GB          |

Premium is detected via the custom Firebase claim `plan = "premium"`.
Set it in your auth backend with `admin.auth().setCustomUserClaims(uid, { plan: 'premium' })`.

## Adding / removing queued tools

Edit **two** lists, one in each side:

* Worker:   `cloudflare/worker/src/processors.js` → `QUEUED_TOOLS`
* Frontend: `public/js/queue-client.js` → `QUEUED_TOOL_IDS`

Anything not in the worker list is rejected with `400 tool not queue-eligible`.
Anything not in the frontend list keeps using the Express backend.
