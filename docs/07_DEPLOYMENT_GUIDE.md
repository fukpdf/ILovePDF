# 07 — DEPLOYMENT GUIDE

## Overview

ILovePDF has three deployment targets:

| Target | What it serves | How it's deployed |
|--------|---------------|-------------------|
| Replit (Node.js) | `/api/*` routes, dynamic SEO, auth | Runs continuously on Replit |
| Firebase Hosting | `/public/*` static files (CDN) | GitHub Actions → firebase-action |
| Cloudflare Worker | Async heavy job queue | GitHub Actions → wrangler-action |

---

## GitHub Actions Pipeline

**File**: `.github/workflows/deploy.yml`  
**Trigger**: Push to `main` branch

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      1. Checkout code
      2. Deploy Firebase Hosting (w9jds/firebase-action@master)
         → Uses FIREBASE_SERVICE_ACCOUNT secret (GCP_SA_KEY)
         → Args: "deploy --only hosting --project ilovepdf-web"
      3. Deploy Cloudflare Worker (cloudflare/wrangler-action@v3)
         → Uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID secrets
         → Working directory: cloudflare/worker
         → Pushes HF_API_TOKEN as Worker secret
```

**Required GitHub Secrets**:
| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON (base64) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Worker deploy permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `HF_TOKEN` | HuggingFace API token (pushed to Worker as secret) |

---

## Firebase Hosting

**Config**: `firebase.json`

```json
{
  "hosting": {
    "public": "public",
    "cleanUrls": true,
    "redirects": [
      { "/contact" → "/about#contact" (301) },
      { "/contact.html" → "/about#contact" (301) }
    ],
    "rewrites": [
      { "/*/preview"  → "/tool.html" },
      { "/*/download" → "/tool.html" },
      { "**"          → "/tool.html" }
    ]
  }
}
```

**`cleanUrls: true`**: Firebase automatically serves `privacy.html` at `/privacy` — no `.html` in URLs.

**Note**: Firebase Hosting is a CDN for the `/public` directory only. It does NOT run the Node.js server. API calls from Firebase-hosted pages go to the Replit server URL.

**Project**: `ilovepdf-web`  
**Config file**: `.firebaserc` → `{ "projects": { "default": "ilovepdf-web" } }`

---

## Cloudflare Worker

**Config**: `cloudflare/worker/wrangler.toml`

```toml
name              = "ilovepdf-queue"
main              = "src/index.js"
compatibility_date  = "2025-09-23"

[[kv_namespaces]]
binding = "PDF_STATUS"
id      = "2737f11930d841a782ae421b8dd9175a"

[[r2_buckets]]
binding     = "R2"
bucket_name = "ilovepdf"

[[queues.producers]]
queue   = "pdf-jobs"
binding = "PDF_QUEUE"

[[queues.consumers]]
queue              = "pdf-jobs"
max_batch_size     = 5
max_batch_timeout  = 5
max_concurrency    = 10
max_retries        = 2
dead_letter_queue  = "pdf-jobs-dlq"
```

**Worker source files**:
- `cloudflare/worker/src/index.js` — Entry point, route dispatch
- `cloudflare/worker/src/auth.js` — Auth validation
- `cloudflare/worker/src/jobs.js` — Job queue management
- `cloudflare/worker/src/processors.js` — PDF job processors
- `cloudflare/worker/src/r2.js` — R2 file helpers
- `cloudflare/worker/src/admin.js` — Admin endpoints
- `cloudflare/worker/src/limits.js` — Rate/size limits

---

## Replit Deployment

The Node.js server runs on Replit via the workflow `node server.js` on port 5000.

**Environment variables required on Replit**:
| Var | Required | Purpose |
|-----|----------|---------|
| `JWT_SECRET` | Yes | JWT signing key |
| `FIREBASE_API_KEY` | Optional | Firebase web SDK |
| `FIREBASE_PROJECT_ID` | Optional | Firebase project |
| `FIREBASE_AUTH_DOMAIN` | Optional | Firebase auth domain |
| `FIREBASE_APP_ID` | Optional | Firebase app ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Optional | Firebase Admin (ID token verify) |
| `R2_ACCOUNT_ID` | Optional | Cloudflare R2 |
| `R2_ACCESS_KEY_ID` | Optional | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Optional | Cloudflare R2 |
| `R2_BUCKET` | Optional | Cloudflare R2 bucket name |
| `HF_API_TOKEN` | Optional | HuggingFace (informational only) |
| `ALLOWED_ORIGINS` | Optional | CORS allowed origins |
| `MAX_UPLOAD_MB` | Optional | Max per-file size (default 200) |

---

## Rollback

### Replit rollback
Use Replit's built-in checkpoint system. Each agent session creates automatic checkpoints. Navigate to History → select checkpoint → Restore.

### Firebase Hosting rollback
```bash
firebase hosting:releases:list
firebase hosting:rollback --project ilovepdf-web
```
Or rollback via Firebase Console → Hosting → Release History.

### Cloudflare Worker rollback
```bash
cd cloudflare/worker
npx wrangler rollback
```
Or via Cloudflare Dashboard → Workers → ilovepdf-queue → Deployments.

---

## Build Scripts

The bundles must be rebuilt after modifying runtime JS files:

```bash
node scripts/build-runtime-bundles.js
node scripts/verify-runtime-bundles.js
node scripts/generate-sri-hashes.js
```

**Note**: Bundle rebuild is NOT automatic — it must be triggered manually. The existing bundles in `public/js/bundles/` are pre-built and committed to the repo.

---

## Docker Support

A `Dockerfile` exists for containerized deployment:
```dockerfile
# Basic Node 20 container
# Exposes port 5000
# CMD: node server.js
```
SQLite `.data/` directory must be mounted as a volume to persist data across container restarts.

---

## Vercel Support

A `vercel.json` exists for Vercel deployment (alternative to Replit):
```json
{ rewrites/routes for Express app }
```
Note: `better-sqlite3` requires native compilation at deploy time on Vercel.
