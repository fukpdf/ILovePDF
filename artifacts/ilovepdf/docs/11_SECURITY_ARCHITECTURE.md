# 11 — SECURITY ARCHITECTURE

## Layers of Security

```
[Browser] CSP nonce + Permissions-Policy + X-Frame-Options
     ↓
[Network] HTTPS enforced (HSTS), Strict-Transport-Security
     ↓
[Server] Rate limiter → Origin guard → Packet validator
     ↓
[Auth] JWT httpOnly cookie → bcrypt password hash
     ↓
[Data] Usage limits → File size caps → File cleanup
     ↓
[Runtime] Client-side security telemetry + incident pipeline
```

---

## Content Security Policy (CSP)

Generated **per request** with a unique nonce. Set in Express middleware (`server.js`).

### Directives

```
default-src 'self'
script-src  'self' 'nonce-{random}' 'wasm-unsafe-eval'
            https://pagead2.googlesyndication.com
            https://partner.googleadservices.com
            https://tpc.googlesyndication.com
            https://unpkg.com
            https://cdn.jsdelivr.net
            https://www.googletagmanager.com
            https://www.google-analytics.com

style-src   'self' 'unsafe-inline' https://fonts.googleapis.com
            https://cdn.jsdelivr.net
img-src     'self' data: blob: https: http:
font-src    'self' https://fonts.gstatic.com https://cdn.jsdelivr.net
connect-src 'self' blob:
            https://api-inference.huggingface.co
            https://*.googleapis.com
            https://identitytoolkit.googleapis.com
            https://securetoken.googleapis.com
            https://firebaseinstallations.googleapis.com
            https://pagead2.googlesyndication.com
            https://adservice.google.com
            https://ep1.adtrafficquality.google
            https://formspree.io
            wss:
worker-src  'self' blob:
frame-src   'self'
            https://googleads.g.doubleclick.net
            https://tpc.googlesyndication.com
            https://www.google.com
            https://pagead2.googlesyndication.com
child-src   'self' blob:
upgrade-insecure-requests
```

**Nonce implementation**: `utils/csp-nonce.js`
- `generateNonce()` → 16 random bytes → base64url
- `injectNonce()` → replaces `__CSP_NONCE__` placeholder in pre-built HTML

---

## HTTP Security Headers

All set in the CSP middleware on every response:

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Force HTTPS 1 year |
| `X-Frame-Options` | `SAMEORIGIN` | Prevent clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Controlled referrer |
| `Permissions-Policy` | `accelerometer=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()` | Feature restriction |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS filter |

---

## Rate Limiting

```javascript
// express-rate-limit config
windowMs: 15 * 60 * 1000  // 15 minutes
max: 80                    // 80 requests per IP
standardHeaders: true
legacyHeaders: false
```

Applied to all `/api/*` routes.  
**Excluded**: `/api/community` (has own 30s server-side cache), `/admin/*`

Response on limit hit:
```json
{ "error": "Too many requests from this IP. Please wait 15 minutes and try again." }
```

---

## Origin Guard (`utils/origin-guard.js`)

Validates `Origin` header on all API requests. Rejects cross-origin requests from unknown origins.

Allowed origins:
- Same-origin (no Origin header or matching host)
- `ALLOWED_ORIGINS` env var (comma-separated list)
- Default production domains: `ilovepdf.cyou`, `*.replit.app`, `*.repl.co`

---

## Authentication

### Email/Password Auth
```
POST /api/auth/signup
  → bcrypt.hash(password, 10) → stored as password_hash
  → JWT signed with JWT_SECRET (30-day expiry)
  → httpOnly cookie: ilovepdf_token

POST /api/auth/login
  → bcrypt.compare(password, user.password_hash)
  → Same cookie set on success
```

**Cookie options** (auto-detected cross-origin):
```javascript
// Same-origin request:
{ httpOnly: true, sameSite: 'lax', secure: false (dev) / true (prod), maxAge: 30d }

// Cross-origin request (Firebase Hosting → Replit backend):
{ httpOnly: true, sameSite: 'none', secure: true, maxAge: 30d }
```

### Firebase Google Sign-In (optional)
```
Client: Firebase SDK → Google OAuth → ID token
POST /api/auth/firebase { idToken }
  → Server: verifyIdToken(idToken) via Firebase Admin SDK
  → Creates/finds user by email
  → Same JWT cookie set
```

### JWT Secret
`JWT_SECRET` env var. Defaults to `'dev-secret-change-me'` if not set (insecure — only for local dev).

---

## Usage Limits (Anti-abuse)

### Server-side (`utils/usage.js`)

Three tiers enforced server-side:

| Tier | Detection | Files/day | Bytes/day | Per-file max |
|------|-----------|-----------|-----------|-------------|
| Guest | IP address | 10 | 600 MB | 60 MB |
| Free | JWT user.id | 30 | 6 GB | 200 MB |
| Premium | JWT user.plan='premium' | ∞ | ∞ | 200 MB |

Daily reset: tracked by `last_reset` date string in `usage_log` table.

### Client-side (`window.UsageLimit`)
- Guest: 15 operations/day (session-local, not server-verified)
- Shows upgrade modal when limit hit
- Coordinates with server-side via API response codes

---

## File Security

- **No persistent storage** for processed files by default — files exist only in `/tmp/ilovepdf-uploads` and are deleted after response via `cleanupFiles()`
- **sweepUploads()** runs periodically to remove orphaned temp files > 30 min old
- **R2 temp files**: Auto-purged by lifecycle rule after 10 min
- **No file content logging**: Server never logs file bytes or contents
- **Client-side processing**: For `clientSide: true` tools, files never leave the browser

---

## Packet Validator (`utils/runtime-packet-validator.js`)

Soft validation layer on all API POST requests:
- Validates content-type, body structure, required fields
- **Does not block** (soft mode) — logs anomalies to security telemetry
- Anomalies trigger `POST /api/security-telemetry` from server side

---

## Security Telemetry Pipeline

**Client → Server pipeline** for runtime security events:

```
Browser event (e.g., CSP violation, anomalous behavior)
  → window.RuntimeForensics.snapshot(type, ctx)
  → window.RuntimeSessionRecorder.record(event, ctx)
  → POST /api/security-telemetry (routes/security-telemetry.js)
  → Stored in security incidents DB (routes/security-incidents.js)
  → Viewable in admin dashboard (panel-incidents.js)
```

**Threat feed**: `routes/threat-feed.js` provides aggregated threat intelligence to admin dashboard.

---

## Incident Engine

Runtime anomaly → incident workflow:
1. AdvancedEngine catches error
2. Calls `window.RuntimeForensics.snapshot('tool-error', ctx)`
3. Non-retriable errors escalate to `window.IncidentEngine.raise(incident)`
4. Incident stored in Arc 12 persistent incident log (IDB)
5. Panel-incidents.js displays in admin dashboard
6. `panel-tool-circuit-breaker.js` may open circuit breaker for the tool

---

## Circuit Breakers (Arc 12–13)

Each tool has a circuit breaker:
- **Closed**: Normal operation
- **Open**: After N consecutive failures (default 3) — tool temporarily disabled
- **Half-open**: Auto-reset probe after cooldown period (default 60s)

State persisted to IDB (Arc 13) — survives page refresh.

---

## Admin Security

- **Admin dashboard** (`/admin`): Separate admin auth (not user JWT)
- **Admin guard** (`middleware/admin-guard.js`): Validates admin session before all `/admin/*` routes
- **Admin API** (`routes/admin-api.js`): Full CRUD on users, settings — admin-only
- **Security dashboard** (`admin/security-dashboard.html`): Real-time threat visualization
- **robots.txt**: `Disallow: /admin, /debug, /p9-test, /dashboard` — keeps admin out of search index

---

## robots.txt Security Entries

```
Disallow: /admin
Disallow: /debug
Disallow: /p9-test
Disallow: /dashboard
Disallow: /api/
```

All internal tooling pages have `<meta name="robots" content="noindex, nofollow">` as secondary protection.
