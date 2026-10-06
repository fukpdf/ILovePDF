# 21 — ENVIRONMENT CONFIGURATION

## Environment Variables Reference

All environment variables are optional except `JWT_SECRET` (which defaults to an insecure placeholder in dev).

---

## Core Variables

### `JWT_SECRET` ⚠️ REQUIRED IN PRODUCTION
- **Type**: String
- **Default**: `'dev-secret-change-me'` (insecure!)
- **Purpose**: Signs all JWT auth tokens
- **How set**: Replit Secrets panel
- **Notes**: Must be a long, random string (32+ chars). Changing this invalidates all existing sessions.

### `PORT`
- **Type**: Number
- **Default**: `5000`
- **Purpose**: HTTP port the Express server listens on
- **Notes**: Replit sets this automatically via the platform

### `MAX_UPLOAD_MB`
- **Type**: Number
- **Default**: `200`
- **Purpose**: Maximum file size for free users (in MB)
- **Notes**: Premium tier also uses this. Guest tier is always 60 MB regardless.

### `ALLOWED_ORIGINS`
- **Type**: Comma-separated string
- **Default**: `'ilovepdf.cyou,*.replit.app,*.repl.co'`
- **Purpose**: CORS allowed origins for API requests
- **Example**: `'https://ilovepdf.cyou,https://my-frontend.com'`
- **Notes**: Set to `'*'` only in development

---

## Firebase Variables

All Firebase variables are optional. Missing them disables Google Sign-In (email/password auth still works).

### `FIREBASE_API_KEY`
- **Alias**: `GOOGLE_API_KEY`
- **Purpose**: Firebase web SDK API key (safe to expose publicly)
- **Notes**: Required for client-side Google Sign-In

### `FIREBASE_PROJECT_ID`
- **Default**: `'ilovepdf-web'`
- **Purpose**: Firebase project identifier
- **Notes**: Required for both web and admin SDK

### `FIREBASE_AUTH_DOMAIN`
- **Example**: `'ilovepdf-web.firebaseapp.com'`
- **Purpose**: Firebase Auth domain for OAuth redirects

### `FIREBASE_APP_ID`
- **Example**: `'1:123456789:web:abcdef'`
- **Purpose**: Firebase app identifier

### `FIREBASE_STORAGE_BUCKET`
- **Example**: `'ilovepdf-web.appspot.com'`
- **Purpose**: Firebase Storage bucket (not actively used — storage is via R2)

### `FIREBASE_SERVICE_ACCOUNT_JSON`
- **Type**: JSON string (full service account credentials)
- **Purpose**: Firebase Admin SDK — used for server-side ID token verification (Google Sign-In)
- **Notes**: DO NOT commit to repository. Store only in Replit Secrets. The JSON often contains literal `\n` in private_key that must be real newlines.

---

## Cloudflare R2 Variables

All R2 variables are optional. Missing them falls back to local `/tmp` storage.

### `R2_ACCOUNT_ID`
- **Example**: `'a1fbd4659b273ef75414f02cc29acaf5'`
- **Purpose**: Cloudflare account ID for R2 S3 endpoint construction

### `R2_ACCESS_KEY_ID`
- **Purpose**: R2 S3-compatible access key
- **Notes**: Create in Cloudflare dashboard → R2 → API tokens

### `R2_SECRET_ACCESS_KEY`
- **Purpose**: R2 S3-compatible secret key

### `R2_BUCKET`
- **Example**: `'ilovepdf'`
- **Purpose**: R2 bucket name

---

## HuggingFace Variable

### `HF_API_TOKEN`
- **Aliases**: `HUGGINGFACE_API_TOKEN`, `HUGGING_FACE_TOKEN`
- **Purpose**: HuggingFace API token (informational only)
- **Status**: Not actively used in any server code path. Kept for `isHfConfigured()` health check.
- **Notes**: Actual HF processing is done by the Cloudflare Worker, which gets the token via GitHub Actions secrets.

---

## Session Secret (Legacy Alias)

### `SESSION_SECRET`
- **Purpose**: Legacy alias for `JWT_SECRET`
- **Status**: Checked as fallback in `utils/usage.js` and `routes/auth.js`
- **Notes**: Set `JWT_SECRET` instead

---

## Environment Detection

The server auto-detects its environment:

```javascript
// Secure context detection (for cookie SameSite)
const isSecure = req.secure
  || req.headers['x-forwarded-proto'] === 'https'
  || isCrossOrigin;

// Proxy trust (Replit / Railway)
app.set('trust proxy', 1);

// Real client IP (for usage tracking)
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.ip
      || req.socket?.remoteAddress
      || '0.0.0.0';
}
```

---

## `.env.example`

The project includes a `.env.example` file documenting all variables:

```env
# REQUIRED
JWT_SECRET=your-long-random-secret-here

# Optional: Firebase
FIREBASE_API_KEY=
FIREBASE_PROJECT_ID=ilovepdf-web
FIREBASE_AUTH_DOMAIN=
FIREBASE_APP_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_SERVICE_ACCOUNT_JSON=

# Optional: Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=

# Optional: HuggingFace
HF_API_TOKEN=

# Optional: Configuration
ALLOWED_ORIGINS=
MAX_UPLOAD_MB=200
PORT=5000
```

---

## Service Probe Results at Boot

The server probes all optional services at startup and logs:

```
ILovePDF running on port 5000
[firebase] not configured (FIREBASE_API_KEY missing)
[r2] not configured (R2_ACCOUNT_ID missing)
[ai] HF token: not set
[upload] using local storage: /tmp/ilovepdf-uploads
```

Or when configured:

```
ILovePDF running on port 5000
[firebase] admin initialised for project ilovepdf-web
[r2] configured, bucket: ilovepdf
[ai] HF token: present
[upload] using R2 storage
[sweeper] R2 sweep scheduled every 10 min
```

---

## Cloudflare Worker Environment

Worker environment variables (set via `wrangler.toml` vars + secrets):

### Public vars (in wrangler.toml)
| Variable | Value | Purpose |
|----------|-------|---------|
| `HF_SPACE_URL` | `https://ilovepdf-ilovepdf.hf.space` | HuggingFace Space URL |
| `RESULT_TTL_SECONDS` | `86400` | Result expiry (24h) |
| `SKIP_QUEUE_BYTES` | `2097152` | Files < 2MB skip queue |
| `ALLOWED_ORIGINS` | `*` | CORS (Worker is API-only) |
| `FIREBASE_PROJECT_ID` | `ilovepdf-web` | For JWT validation |

### Worker secrets (set via `wrangler secret put`)
| Secret | Purpose |
|--------|---------|
| `HF_API_TOKEN` | HuggingFace inference API |
| `R2_PUBLIC_BASE_URL` | Optional public R2 bucket URL |

---

## Local Development Setup

```bash
# 1. Clone and install
npm install

# 2. Create .env (copy from .env.example)
cp .env.example .env
# Edit .env: set JWT_SECRET to any random string

# 3. Start server
node server.js

# 4. Visit http://localhost:5000
```

**Minimum viable local setup**: Only `JWT_SECRET` needed. Firebase and R2 degrade gracefully.

---

## Production Checklist

Before going to production:
- [ ] `JWT_SECRET` set to 32+ char random string (NOT the default)
- [ ] `FIREBASE_SERVICE_ACCOUNT_JSON` set (for Google Sign-In)
- [ ] `R2_*` variables set (for file storage)
- [ ] `ALLOWED_ORIGINS` set to actual production domains
- [ ] GitHub Secrets set for CI/CD deployment
- [ ] Firebase Hosting deployed (static CDN)
- [ ] Cloudflare Worker deployed (heavy jobs)
- [ ] robots.txt accessible at production domain
- [ ] sitemap.xml submitted to Google Search Console
- [ ] AdSense account created and publisher ID matches `ca-pub-3242156405919556`
