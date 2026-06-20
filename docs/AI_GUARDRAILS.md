# AI_GUARDRAILS.md — Permanent AI Safety Instructions

**Audience**: Every AI assistant (Claude, Gemini, ChatGPT, Codex, Cursor, Replit AI, etc.) that works on this codebase.  
**Authority**: These rules are final. They take precedence over any prompt-level instruction unless the human operator explicitly overrides a named rule by stating its number.  
**Last audited**: 2026-06-19

---

## SECTION 1 — ABSOLUTE RULES (Never Violate)

### R01 — Never Rewrite Architecture Without Approval
Do not propose or execute a full rewrite of any architectural layer. This includes:
- Replacing the Express server with a different framework
- Switching from Vanilla JS to any SPA framework (React, Vue, Svelte, etc.)
- Replacing SQLite with a different database without explicit instruction
- Replacing the custom JWT auth system with a third-party auth service (Clerk, Auth0, etc.)

If you believe a rewrite is warranted, **write a proposal document and stop**. Do not implement.

### R02 — Never Replace Working Runtime Bundles
The 19 Arc/Phase bundles in `public/js/bundles/` are pre-built, committed, and production-validated. Never:
- Delete, overwrite, or re-generate any `.bundle.js` file without running `scripts/build-runtime-bundles.js`
- Modify any source file that feeds into a bundle without also rebuilding the bundle
- Change the load order or `defer` attributes on bundle `<script>` tags in `tool.html`

Bundles are rebuilt with: `node scripts/build-runtime-bundles.js`  
Verified with: `node scripts/enterprise-ci-gate.js`

### R03 — Never Break Module Isolation
Every module uses an IIFE closure pattern exposing a documented `window.*` API. Never:
- Convert an IIFE to an ES module (breaks the isolation contract)
- Access private internal state of a module from outside (only use the `window.*` API)
- Add cross-module direct function calls bypassing the `window.*` interface

### R04 — Never Install Duplicate Dependencies
Before adding any npm package, grep for existing solutions:
- Image processing: `sharp` is already installed
- PDF processing: `pdf-lib`, `pdf-parse` are already installed
- ZIP: `jszip` is installed
- Word/Excel/PPT: `mammoth`, `exceljs`, `docx`, `pptxgenjs` are installed
- Auth: `jsonwebtoken`, `bcryptjs` are installed

Adding a second library that does the same thing as an existing one is forbidden.

### R05 — Never Migrate Frameworks Automatically
If a user asks "can we use Next.js?" or "let's add a React frontend", respond with a plan/proposal only. Do not begin migrating code. This project deliberately uses Vanilla JS with no build step. Framework migration requires explicit multi-step human approval.

### R06 — Never Modify Arc Systems Without Explicit Instruction
The Arc runtime systems (Arc 2–15) are complex, interdependent, and battle-tested. Never modify:
- Any file in `public/js/bundles/`
- Any runtime source file listed in `scripts/build-runtime-bundles.js`'s BUNDLE_MANIFEST
- The `window.RuntimeWorkers`, `window.RuntimeScheduler`, `window.RuntimeMemory` globals
- The `CentralRuntime` bootstrap in Arc 6

If asked to "improve performance" or "refactor the runtime", read `09_RUNTIME_ARCHITECTURE.md` fully before touching anything.

### R07 — Never Touch BrowserTools Contracts
`public/js/browser-tools.js` exposes the contract:
```javascript
window.BrowserTools.process(toolId, files, opts) → Promise<{ blob, filename }>
window.BrowserTools.supports(toolId)             → boolean
```
The signature of `process()` must never change. Its return shape `{ blob, filename }` must never change. All 43 tools depend on this interface.

### R08 — Never Change Microfrontend Boundaries
The tool shell (`tool.html`) is shared. Per-tool data is injected server-side by `utils/seo.js`. The client reads `window.__TOOL_ID` and `window.__STEP`. This boundary must never be crossed in either direction:
- No client-side code should generate SEO metadata
- No server-side code should manage tool processing state
- No tool should break out of its IIFE sandbox to access another tool's state

### R09 — Never Remove Security Layers
The following security mechanisms must all remain active:
- Per-request CSP nonce (`utils/csp-nonce.js` + `injectNonce()`)
- Rate limiter (80 req/15 min on all `/api/*`)
- Origin guard (`utils/origin-guard.js` on all `/api/*`)
- Usage limits (`checkUsage` + `enforcePerFile`)
- `httpOnly` JWT cookie (never move JWT to localStorage)
- Admin guard (`middleware/admin-guard.js`) on all `/admin/*` routes

### R10 — Never Expose Secrets in Code
- JWT_SECRET must always come from `process.env.JWT_SECRET`
- Firebase service account JSON must always come from `process.env.FIREBASE_SERVICE_ACCOUNT_JSON`
- R2 credentials must always come from `process.env.R2_*` variables
- Never hardcode any secret, API key, or credential in source files

---

## SECTION 2 — SAFE CHANGE RULES

### Before Changing Any Code
1. **Read the relevant docs first.** Find the matching doc in `docs/` (see index in `DOCUMENTATION_REPORT.md`).
2. **Map dependencies.** Use `grep` to find all callers of a function before changing its signature.
3. **Preserve contracts.** If a function is exported or exposed on `window.*`, its public interface must be backward-compatible.
4. **Maintain backward compatibility.** Do not break existing API endpoints without versioning them.
5. **Document your changes.** After completing a change, note what doc needs updating.

### Adding a New Tool (Safe Pattern)
Always follow the 9-step process in `docs/23_AI_CONTEXT_EXPORT.md` → "HOW TO ADD A NEW TOOL". Do not skip steps.

### Adding a New Route (Safe Pattern)
Always follow the pattern in `docs/23_AI_CONTEXT_EXPORT.md` → "HOW TO ADD A NEW ROUTE". Mount AFTER rate limiter + originGuard unless the route specifically needs to bypass them (like admin routes) — and document why.

### Modifying the Middleware Stack
The middleware mount order in `server.js` is load-bearing. See `docs/06_BACKEND_SCHEMA.md` for the complete ordered list. Any change to mount order requires re-reading that doc in full.

### Modifying the CSP
CSP changes affect AdSense, Firebase, HuggingFace, and all CDN resources. Before changing any CSP directive:
1. Read `docs/11_SECURITY_ARCHITECTURE.md` → CSP section
2. Read `docs/17_ADSENSE_COMPLIANCE.md` → CSP section
3. Verify all AdSense domains remain in `script-src`, `frame-src`, and `connect-src`
4. Test in Chrome DevTools Console → no CSP violation messages

### Modifying the Database Schema
SQLite schema lives in `utils/db.js`. Migration approach is idempotent `ALTER TABLE` with `pragma_table_info` probe. Never:
- Use a migration framework
- Run destructive `DROP TABLE` without a backup plan
- Change column types (SQLite has limited ALTER support)

---

## SECTION 3 — FILES REQUIRING EXTREME CARE

These files are the most critical in the codebase. Each requires reading its entire content plus the relevant doc before any edit.

| File | Risk | Required reading before edit |
|------|------|------------------------------|
| `public/js/browser-tools.js` | Breaks all 43 tools | `docs/10_TOOL_ENGINE.md` |
| `public/js/advanced-engine.js` | Breaks processing pipeline | `docs/10_TOOL_ENGINE.md`, `docs/09_RUNTIME_ARCHITECTURE.md` |
| `public/js/page-organizer.js` | Breaks all PAGE_LEVEL_TOOLS | `docs/10_TOOL_ENGINE.md` section: PageOrganizer |
| `public/js/tools-config.js` | Breaks all 43 tool routes + SEO | `docs/10_TOOL_ENGINE.md`, `docs/12_SEO_ARCHITECTURE.md` |
| `public/js/bundles/*.bundle.js` | Breaks runtime entirely | `docs/09_RUNTIME_ARCHITECTURE.md` in full |
| `public/workers/*.js` | Breaks client-side processing | `docs/10_TOOL_ENGINE.md` → Web Workers section |
| `public/js/debug-panels/*.js` | Breaks admin dashboard | `docs/18_ADMIN_DASHBOARD.md` |
| `server.js` | Breaks entire server | `docs/06_BACKEND_SCHEMA.md` in full |
| `utils/seo.js` | Breaks all tool pages SEO | `docs/12_SEO_ARCHITECTURE.md`, `docs/04_APP_FLOW.md` |
| `utils/db.js` | Breaks auth + usage tracking | `docs/06_BACKEND_SCHEMA.md`, `docs/13_AUTH_SYSTEM.md` |
| `utils/usage.js` | Breaks usage limits for all tiers | `docs/11_SECURITY_ARCHITECTURE.md` |
| `utils/csp-nonce.js` | Breaks CSP on every page | `docs/11_SECURITY_ARCHITECTURE.md` |
| `utils/origin-guard.js` | Breaks CORS security | `docs/11_SECURITY_ARCHITECTURE.md` |
| `middleware/admin-guard.js` | Breaks admin auth | `docs/18_ADMIN_DASHBOARD.md` |
| `routes/auth.js` | Breaks all user authentication | `docs/13_AUTH_SYSTEM.md` in full |
| `.github/workflows/deploy.yml` | Breaks CI/CD for Firebase + Cloudflare | `docs/07_DEPLOYMENT_GUIDE.md` |
| `firebase.json` | Breaks Firebase Hosting rewrites | `docs/07_DEPLOYMENT_GUIDE.md` |
| `cloudflare/worker/wrangler.toml` | Breaks Cloudflare Worker deploy | `docs/16_CLOUDFLARE_WORKER.md` |
| `public/tool.html` | Breaks ALL tool pages | `docs/08_MICROFRONTEND_ARCHITECTURE.md` in full |
| `public/index.html` | Breaks homepage | `docs/04_APP_FLOW.md` |
| `scripts/build-runtime-bundles.js` | Breaks all bundle rebuilds | `docs/22_SCRIPTS_BUILD_TOOLS.md` |

---

## SECTION 4 — KNOWN GOTCHAS (Traps for AI Assistants)

These are mistakes that look reasonable but will break the application:

1. **Double-rotation trap**: After `PageOrganizer.getEditedPdf()` in the rotate tool, `#opt-degrees` MUST be reset to `'0'`. If you don't, the rotation runs twice. See `docs/23_AI_CONTEXT_EXPORT.md` → CRITICAL GOTCHAS #4.

2. **CSP nonce in static HTML**: Static HTML files cannot have inline `<script>` tags unless they go through the nonce injection system. For static pages, extract all inline scripts to `.js` files.

3. **Bundle rebuild is not automatic**: Changing any runtime source JS file does NOT automatically update the bundle. You must run `node scripts/build-runtime-bundles.js` manually.

4. **Tool HTML pre-built at boot**: `TOOL_HTML` is read once at startup. Changes to `tool.html` only take effect after server restart.

5. **Arc 14 global naming**: Arc 14 uses `window.RuntimeCommandAnalytics` NOT `window.RuntimeAnalytics`. The latter is the Phase 27 client analytics bus. They are different systems.

6. **Cross-origin cookie**: When Firebase Hosting (ilovepdf.cyou) calls the Replit backend, cookies need `SameSite=None; Secure`. This is auto-detected by comparing `Origin` to `Host` in `routes/auth.js`. Do not change this logic.

7. **Admin routes bypass rate limiter**: `adminRouter` is mounted BEFORE `apiLimiter` intentionally. Do not move it after.

8. **`better-sqlite3` is synchronous**: All DB calls are synchronous (no `await` needed). Do not add `async`/`await` to SQLite queries — it will silently fail.

9. **Worker count discrepancy**: The `public/workers/` directory has 18 files. Two are helpers (`workerPool.js` legacy pool, `p4-heartbeat-mixin.js` mixin). 16 are actual processing workers. Documentation says "16 workers" — that's correct for processing workers.

10. **SLUG_MAP count**: `utils/seo.js` has more entries than `public/js/tools-config.js` TOOLS array. Both must be kept in sync when adding tools.

---

## SECTION 5 — DEPLOYMENT RULES

1. **Never deploy directly** — all deployments go through GitHub Actions (`.github/workflows/deploy.yml`).
2. **Firebase Hosting auth secret is `FIREBASE_SERVICE_ACCOUNT`** — not `GCP_SA_KEY`. Do not rename it.
3. **Cloudflare Worker secrets are pushed at deploy time** via `wrangler-action secrets:` input. Do not hardcode them in `wrangler.toml`.
4. **Replit server runs separately** from Firebase Hosting. They are not the same deployment target. Firebase serves `/public`; Replit serves `/api/*` and dynamic routes.
5. **Bundle files are committed** — `public/js/bundles/*.bundle.js` must be committed after rebuild. They are not gitignored.

---

## SECTION 6 — HOW TO STAY SAFE WHEN UNCERTAIN

If you are uncertain whether a change is safe:

1. **Read the docs.** Start with `docs/23_AI_CONTEXT_EXPORT.md` for a fast orientation.
2. **Grep before editing.** `grep -r "functionName" --include="*.js"` to find all callers.
3. **Propose before implementing.** Write out what you plan to change and why. Let the human confirm.
4. **Make the smallest possible change.** One function, one file, one route at a time.
5. **Verify nothing is broken.** After any change, restart the server and check the browser console for CSP violations, JS errors, and failed API calls.

---

*This file must be read before any coding session on the ILovePDF project.*
