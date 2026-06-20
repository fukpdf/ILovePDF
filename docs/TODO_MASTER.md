# TODO_MASTER.md — Single Source of Truth for Outstanding Work

**Last updated**: 2026-06-19  
**Derived from**: Full read-only audit of all 24 existing docs + codebase  
**Code changes**: ZERO — documentation only

---

## DONE

### Auth
- [x] Email/password signup + login with bcrypt + JWT httpOnly cookie
- [x] JWT 30-day expiry, SameSite=lax / SameSite=None auto-detection
- [x] GET /api/auth/me profile endpoint
- [x] POST /api/auth/change-password
- [x] DELETE /api/auth/account (full account deletion)
- [x] POST /api/auth/logout (cookie clear)
- [x] Google Sign-In via Firebase Auth (optional, server validates ID token)
- [x] `pending_signups` table created for email verification flow
- [x] `verify-signup.html` page exists (landing page for email link)
- [x] Admin auth (separate from user JWT, `middleware/admin-guard.js`)

### Payments / Tiers
- [x] `users.plan` column exists in SQLite schema (`'free' | 'premium'`)
- [x] Usage limit tiers enforced server-side (guest/free/premium in `utils/usage.js`)
- [x] Premium tier bypasses all file limits (code path exists)
- [x] Client-side upgrade modal triggered when limits hit

### Ads
- [x] AdSense publisher tag (`ca-pub-3242156405919556`) on all indexed pages
- [x] `ads.txt` file committed and deployed
- [x] CSP allows all AdSense/DoubleClick domains
- [x] Ad slot containers (`<aside class="ad-slot ...">`) in HTML templates
- [x] Phase A–P AdSense compliance audit complete

### SEO
- [x] 43 tool slugs with unique title, desc, canonical, OG, Twitter, 4x JSON-LD
- [x] Sitemap index + 4 sub-sitemaps (tools, blog, categories, static)
- [x] robots.txt (Disallow /admin, /debug, /api/)
- [x] Clean URLs (no .html extensions)
- [x] 301 redirects for legacy .html URLs
- [x] `/tools` directory page
- [x] Category landing pages

### Blog
- [x] 37 blog articles in `public/blog/*.html`
- [x] Each article has Article + FAQPage + BreadcrumbList JSON-LD
- [x] Blog generation pipeline (`scripts/blog-data.js` → `scripts/generate-blogs.js`)
- [x] Blog index page (`/blog`)
- [x] Server routing for `/blog/:slug` clean URLs

### Runtime
- [x] 19 runtime bundles (Phase 6–9 + Arc 2–15) built and committed
- [x] 16 Web Workers for parallel heavy computation
- [x] 22 debug panels in Arc 10D admin dashboard
- [x] All Arc systems (Arc 2–15) fully implemented
- [x] OPFS streaming for files > 200 MB
- [x] Circuit breakers (Arc 12–13) per tool
- [x] Policy engine (Arc 15)
- [x] Cross-tab coordination (Arc 11 + SharedWorker)

### Admin
- [x] `/admin/login` and `/admin/setup` pages
- [x] Admin API: users CRUD, stats, usage log (`routes/admin-api.js`)
- [x] Security dashboard (`admin/security-dashboard.html`)
- [x] Security telemetry pipeline (client → server → IDB → dashboard)
- [x] Threat feed aggregation (`routes/threat-feed.js`)
- [x] Execution tickets (anti-duplication, Phase 6)

### Workers / Cloudflare
- [x] Cloudflare Worker (`ilovepdf-queue`) — queue producer + consumer
- [x] Cloudflare R2 integration (temp + user file storage)
- [x] Cloudflare KV (`PDF_STATUS`) for job status
- [x] HuggingFace Space integration for heavy AI processing
- [x] Skip-queue logic for files < 2 MB
- [x] Dead letter queue (`pdf-jobs-dlq`)

### Ezoic / Monetization Infrastructure
- [x] AdSense-compliant HTML structure (ad slot containers)
- [x] CSP configured for all ad network domains
- [x] Cookie consent banner with localStorage persistence
- [x] Privacy Policy with full ad disclosure

### CI/CD
- [x] GitHub Actions pipeline (push to main → Firebase + Cloudflare deploy)
- [x] Migrated to `google-github-actions/auth@v2` (modern service account auth)
- [x] Cloudflare Worker secrets pushed at deploy time

---

## IN PROGRESS

### Monetization — Premium Payments
- [ ] **Stripe integration** (or PayPal)
  - Status: `users.plan` column exists, tier enforcement works, payment processor not wired
  - Dependencies: Stripe account, `stripe` npm package, `/api/payment/*` routes
  - Priority: **HIGH** — this is the primary revenue unlock

### Email Verification
- [ ] **Email sending for signup verification**
  - Status: `pending_signups` table exists, `verify-signup.html` exists, email sender not connected
  - Dependencies: Email provider (Resend, SendGrid, Mailgun, or Postmark)
  - Priority: **HIGH** — unverified signups reduce trust signals

### Password Reset
- [ ] **Forgot password / reset flow**
  - Status: No route exists. Requires same email provider as above.
  - Dependencies: Email verification flow must be done first
  - Priority: **MEDIUM**

---

## PENDING

### Auth Improvements
- [ ] **Email verification gate** — require verified email before login (not just signup)
  - Dependencies: Email sending (above)
  - Priority: Medium

- [ ] **"Remember me" option** — 90-day cookie vs 30-day default
  - Dependencies: None
  - Priority: Low

- [ ] **Session revocation** — server-side token invalidation list (currently logout = cookie clear only)
  - Dependencies: Redis or DB-backed token store
  - Priority: Low

- [ ] **OAuth providers beyond Google** — GitHub, Apple, Microsoft
  - Dependencies: Firebase Auth additional providers
  - Priority: Low

### Payments
- [ ] **Premium plan activation UI** — pricing page, plan comparison, upgrade flow
  - Dependencies: Stripe integration
  - Priority: High (after Stripe is wired)

- [ ] **Stripe webhook handlers** — subscription events (created, cancelled, failed)
  - Dependencies: Stripe integration
  - Priority: High (after Stripe is wired)

- [ ] **Usage enforcement for premium** — verify plan via payment provider, not just DB column
  - Dependencies: Stripe integration
  - Priority: Medium

### Ads
- [ ] **Activate actual AdSense ad units** — insert `<ins class="adsbygoogle">` blocks into slot containers
  - Status: Slot containers exist but no ad units loaded
  - Dependencies: AdSense account approval (publisher ID already set)
  - Priority: **HIGH** — direct revenue impact

- [ ] **Ezoic integration** — as alternative/supplement to AdSense
  - Status: Not started
  - Dependencies: Ezoic account, DNS or CDN routing
  - Priority: Medium

- [ ] **Ad performance tracking** — correlate tool usage with ad impressions
  - Dependencies: AdSense activated
  - Priority: Low

### SEO
- [ ] **hreflang tags** — multilingual alternate URL support
  - Status: i18n UI exists, no URL variants exist
  - Dependencies: Language-prefixed URLs (`/fr/merge-pdf` etc.) — requires significant routing work
  - Priority: Low

- [ ] **Google Search Console submission** — submit sitemaps after deployment
  - Status: sitemaps exist and valid
  - Dependencies: Production deployment
  - Priority: Medium (manual step)

- [ ] **Core Web Vitals optimization** — LCP, CLS, FID improvements
  - Dependencies: None
  - Priority: Medium

### Blog
- [ ] **Remaining 6 tool blog articles** (docs say 37 articles for 43 tools — ~6 tool topics without articles)
  - Status: 37 articles exist; not all 43 tools have dedicated articles
  - Dependencies: `scripts/blog-data.js` entries + `node scripts/generate-blogs.js`
  - Priority: Medium

- [ ] **Blog content freshness** — update `dateModified` + refresh outdated articles
  - Dependencies: Manual content review
  - Priority: Low

- [ ] **Blog images** — OG images for each article (currently placeholder URLs)
  - Dependencies: Image generation or design work
  - Priority: Low

### Runtime
- [ ] **Arc 16** — Not yet defined
  - Dependencies: Arc 15 must be stable and monitored
  - Priority: Low

- [ ] **Automated bundle rebuild in CI** — auto-rebuild bundles when source files change
  - Status: Currently manual (`node scripts/build-runtime-bundles.js`)
  - Dependencies: Git diff detection in CI
  - Priority: Low

### Admin
- [ ] **Admin notifications / broadcasts** — `/api/admin/broadcast` endpoint exists, UI not wired
  - Dependencies: Email provider
  - Priority: Low

- [ ] **Admin analytics dashboard** — usage charts, tool popularity, conversion funnel
  - Dependencies: Depends on community-api + usage_log data
  - Priority: Medium

### Workers / Cloudflare
- [ ] **Permanent user file storage** (R2 `users/<uid>/`) — infrastructure exists, not exposed in UI
  - Status: `putUserObject()` exists in `utils/r2.js`, no frontend file manager
  - Dependencies: Premium plan activation
  - Priority: Medium (after premium)

- [ ] **R2 file manager UI** — list, download, delete user files
  - Status: `/api/r2/list` and `/api/r2/delete` endpoints exist
  - Dependencies: R2 user storage above
  - Priority: Medium

### Ezoic
- [ ] **Ezoic site-level integration** — not started
  - Dependencies: Ezoic account, DNS setup
  - Priority: Medium

### Internationalization
- [ ] **hreflang + URL variants** for multilingual SEO
  - Dependencies: Significant routing + SEO work
  - Priority: Low

- [ ] **Server-side language negotiation** — `Accept-Language` header handling
  - Dependencies: None
  - Priority: Low

### Tools
- [ ] **Workflow builder** (`/workflow-builder`) — slug registered, `working: false`
  - Status: Route exists but disabled
  - Dependencies: Design work
  - Priority: Low

- [ ] **Scan-to-PDF** improvements — better OCR integration for scanned documents
  - Status: Basic version exists
  - Dependencies: HuggingFace integration
  - Priority: Medium

- [ ] **PDF translate quality** — currently MyMemory API (2500 char limit)
  - Status: Works but limited
  - Dependencies: Better translation API (DeepL, Google Translate)
  - Priority: Medium

### Arc Roadmap
- [ ] **Arc 16** — to be scoped (likely: AI-native tool processing, on-device models)
- [ ] **Arc 17** — to be scoped (likely: community features, sharing, collaboration)

---

## BLOCKED

### Email Verification (blocks downstream)
- **Blocker**: No email provider configured
- **Blocked work**: Email verification flow, password reset, admin notifications
- **Resolution**: Choose and integrate Resend/SendGrid/Postmark; add to Replit Secrets

### Premium Activation (blocks downstream)
- **Blocker**: No payment processor integrated
- **Blocked work**: Premium plan UI, Stripe webhooks, R2 user storage UI, paid-only features
- **Resolution**: Stripe integration (high priority)

### AdSense Unit Activation
- **Blocker**: AdSense account approval may not be complete
- **Blocked work**: Actual ad revenue
- **Resolution**: Complete AdSense application, await Google approval, activate ad units

---

## Priority Matrix

| Item | Impact | Effort | Priority |
|------|--------|--------|----------|
| Activate AdSense ad units | Revenue | Low | 🔴 Do first |
| Stripe payment integration | Revenue | High | 🔴 Do first |
| Email provider + verification | Trust + UX | Medium | 🟠 Do soon |
| Password reset | UX | Low | 🟠 Do soon |
| Premium plan UI | Revenue | Medium | 🟠 Do soon (after Stripe) |
| Google Search Console submission | SEO | Low | 🟡 Quick win |
| Blog: remaining tool articles | SEO | Medium | 🟡 Medium |
| Ezoic integration | Revenue | Medium | 🟡 Medium |
| R2 file manager UI | Feature | Medium | 🟢 Later |
| hreflang URL variants | SEO | High | 🟢 Later |
| Arc 16 | Runtime | High | 🟢 Later |
| Workflow builder | Feature | High | 🟢 Later |
