# 13 — AUTH SYSTEM

## Overview

ILovePDF has a complete, production-ready auth system built on:
- **Primary**: Email/password with bcrypt hashing and JWT cookies
- **Optional**: Google Sign-In via Firebase Auth (bridge to JWT)

Both paths produce the same `ilovepdf_token` JWT cookie and use the same `users` table.

---

## Auth Files

| File | Purpose |
|------|---------|
| `routes/auth.js` | All auth API endpoints |
| `utils/db.js` | users + pending_signups tables |
| `utils/firebase-admin.js` | Firebase Admin SDK init + token verification |
| `public/js/auth-ui.js` | Client-side auth modal + profile chip |
| `public/js/firebase-init.js` | Firebase web SDK initialization |

---

## Email/Password Flow

### Sign Up

```
POST /api/auth/signup
Body: { email, name, password }

Validation:
  - email, name, password required
  - password.length >= 6
  - email not already in users table

Processing:
  - bcrypt.hash(password, 10) → password_hash
  - INSERT INTO users (email, name, password_hash, storage_quota=2GB)
  - JWT signed with JWT_SECRET (30-day expiry)
  - Cookie set: ilovepdf_token

Response: { user: { id, email, name, storage_quota, storage_used, avatar_url } }
```

**Note**: Email verification is present in the schema (`pending_signups` table + `verify-signup.html`) but the email-sending step is not yet active (requires email provider integration).

### Log In

```
POST /api/auth/login
Body: { email, password }

Processing:
  - SELECT * FROM users WHERE email = ?
  - bcrypt.compare(password, user.password_hash)
  - JWT signed + cookie set on success

Response: { user: ... }
```

### Log Out

```
POST /api/auth/logout

Processing:
  - res.clearCookie('ilovepdf_token')

Response: { success: true }
```

### Get Current User

```
GET /api/auth/me
Auth: JWT cookie required

Processing:
  - jwt.verify(token, JWT_SECRET)
  - SELECT * FROM users WHERE id = req.user.id

Response: { user: ... }
```

### Change Password

```
POST /api/auth/change-password
Auth: JWT cookie required
Body: { currentPassword, newPassword }

Processing:
  - Verify currentPassword against existing hash
  - bcrypt.hash(newPassword, 10)
  - UPDATE users SET password_hash = ? WHERE id = ?
```

### Delete Account

```
DELETE /api/auth/account
Auth: JWT cookie required

Processing:
  - DELETE FROM users WHERE id = ?
  - DELETE FROM usage_log WHERE user_id = ?
  - res.clearCookie('ilovepdf_token')
```

---

## Google Sign-In Flow (Firebase)

### Prerequisites

Firebase must be configured:
- `FIREBASE_API_KEY` + `FIREBASE_PROJECT_ID` + `FIREBASE_APP_ID` set
- `FIREBASE_SERVICE_ACCOUNT_JSON` set for server-side token verification

### Flow

```
Client-side:
  1. firebase-init.js loads Firebase web SDK from CDN
  2. auth-ui.js shows "Sign in with Google" button (if Firebase configured)
  3. User clicks → Google OAuth popup
  4. Firebase SDK: signInWithPopup(GoogleAuthProvider)
  5. Get ID token: await user.getIdToken()

Server-side:
  POST /api/auth/firebase
  Body: { idToken }

  Processing:
  - verifyIdToken(idToken) via Firebase Admin SDK
  - Extract email + name from decoded token
  - SELECT user by email, or INSERT new user with random secure password_hash
  - JWT signed + cookie set

Response: { user: ... }
```

### Configuration Check

```javascript
GET /api/config/firebase
Response: {
  apiKey, authDomain, projectId, appId, storageBucket
}
// Returns 503 if Firebase not configured
```

---

## JWT Token

```javascript
// Payload
{ id: user.id, email: user.email, name: user.name }

// Options
{ expiresIn: '30d' }

// Algorithm: HS256 (default jsonwebtoken)
// Secret: process.env.JWT_SECRET (required in production)
```

### Cookie Options (auto-detected)

```javascript
function cookieOpts(req) {
  const isCrossOrigin = origin !== host;
  return {
    httpOnly: true,
    sameSite: isCrossOrigin ? 'none' : 'lax',
    secure:   req.secure || isHttps || isCrossOrigin,
    maxAge:   30 * 24 * 3600 * 1000, // 30 days
    path:     '/',
  };
}
```

Cross-origin scenario: Firebase Hosting (`ilovepdf.cyou`) → Replit backend.

---

## User Schema

```sql
users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  storage_quota INTEGER NOT NULL DEFAULT 2147483648,  -- 2 GB (2 * 1024^3)
  storage_used  INTEGER NOT NULL DEFAULT 0,
  avatar_url    TEXT,                                  -- Firebase photo URL
  plan          TEXT NOT NULL DEFAULT 'free',          -- 'free' | 'premium'
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)
```

`publicUser(u)` projection (what's sent to client):
```javascript
{ id, email, name, storage_quota, storage_used, avatar_url }
```
`plan` is NOT exposed in the public projection (security: prevents gaming tier checks).

---

## Auth UI (`public/js/auth-ui.js`)

Injected on every page. Provides:

### Profile Chip (authenticated)
```html
<div class="profile-chip">
  <img src="{avatar_url}" />
  <span>{name}</span>
  <span class="plan-badge">{plan}</span>
  <div class="dropdown">
    [My Files] [Settings] [Log Out]
  </div>
</div>
```

### Auth Modal (unauthenticated)
```html
<div class="auth-modal">
  <div class="tabs">
    <button>Log In</button>
    <button>Sign Up</button>
  </div>
  <form>
    <!-- name field (sign up only) -->
    <input type="email" />
    <input type="password" />
    <button type="submit">Log In</button>
  </form>
  <!-- If Firebase configured: -->
  <button class="google-btn">Sign in with Google</button>
</div>
```

### Auth State Machine
```
initial → checking (GET /api/auth/me)
  ↓ success        ↓ 401
authenticated    unauthenticated
  ↓                ↓
profile chip    sign-in buttons
```

---

## Usage Limits Integration

Usage is tracked per user (by JWT `user.id`) or per IP (for guests):

```javascript
// utils/usage.js
function readUserFromCookie(req) {
  const tok = req.cookies?.ilovepdf_token;
  if (!tok) return null;
  try { return jwt.verify(tok, SECRET); } catch { return null; }
}

// Determines tier:
//   user.plan === 'premium' → LIMITS.premium
//   user exists → LIMITS.free
//   no user → LIMITS.guest (IP-based)
```

---

## Pending Signups (Email Verification Stub)

The `pending_signups` table supports a future email verification flow:
```sql
pending_signups (
  token       TEXT PRIMARY KEY,  -- UUID for email link
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,  -- 30 min from creation
  created_at  INTEGER NOT NULL
)
```

**Current status**: Table exists; `verify-signup.html` exists. Email sending not yet wired up (needs email provider: Resend, SendGrid, etc.).

---

## Security Properties

- **Passwords**: bcrypt with cost factor 10 — resistant to brute force
- **JWT**: Short-lived (30 days), rotated on each login, invalidated on logout via cookie clear
- **httpOnly cookie**: Not accessible to JavaScript — XSS-resistant
- **No password reset flow**: Not yet implemented (requires email provider)
- **No "remember me"**: All cookies are 30-day persistent
- **Admin auth**: Separate from user auth (different middleware + no JWT sharing)
