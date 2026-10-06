# PROJECT_RULES.md — Permanent Development Rules

**Authority**: These rules govern all development on the ILovePDF project.  
**Applies to**: Human developers, AI assistants, automated tools, CI/CD systems.  
**Last updated**: 2026-06-19

> Any future AI must read this file — along with `docs/AI_GUARDRAILS.md` and `docs/23_AI_CONTEXT_EXPORT.md` — before writing a single line of code.

---

## 1. Architecture-First Philosophy

**Architecture decisions are made before code is written.**

Every change that affects more than one file requires a plan first:
1. Identify every file that will change
2. Identify every dependent that might break
3. Document the plan (even a short comment is fine for small changes)
4. Get the plan reviewed before implementing

Do not start coding and figure out the architecture as you go. This project has 43 tools, 19 runtime bundles, 16 workers, and 22 debug panels — unplanned changes cascade.

---

## 2. Microfrontend-First

**Every tool is a self-contained microfrontend.**

- The shared shell is `tool.html`. It must remain generic — it contains no tool-specific logic.
- Per-tool context is injected **server-side only** by `utils/seo.js` → `buildHtml()`.
- Per-tool client logic lives in `BrowserTools.process()` via the tool ID.
- Standalone tools (Numbers to Words, Currency Converter, etc.) have their own HTML files and are completely independent. They do not share the `tool.html` shell.

Adding a new tool must not require changes to the shell. If a new tool requires changes to `tool.html`, that is a design smell — reconsider the approach.

---

## 3. Isolation-First

**Every component is isolated from every other component.**

- **Module isolation**: All JS modules use IIFE closures. They expose only a documented `window.*` API. Internal state is private.
- **Worker isolation**: Each Web Worker is an independent process. Workers communicate only via `postMessage`. Workers cannot access `window.*` globals directly.
- **Bundle isolation**: Each runtime bundle loads independently, deferred after first paint. Bundles depend on each other only via `window.*` globals (runtime-linked, not build-linked).
- **Tool isolation**: A failure in one tool's runtime (circuit breaker open, worker crash, memory error) must not affect any other tool. Arc 3–5 enforce this.
- **Admin isolation**: Admin auth is separate from user auth. Admin cookies, admin DB (`utils/admin-db.js`), and admin routes (`routes/admin.js`, `routes/admin-api.js`) are fully isolated from user-facing systems.

When adding new code, ask: "If this breaks, what else breaks?" The answer should be "nothing outside its own boundary."

---

## 4. No Rewrites

**Never rewrite a working system.**

This rule has no exceptions except explicit multi-session human approval with a documented migration plan.

**Specifically banned without approval**:
- Replacing the Express server with a different framework
- Replacing the custom JWT auth with a third-party auth service
- Replacing SQLite with a different database
- Replacing the Vanilla JS frontend with a SPA framework
- Replacing the bundle system with a module bundler (webpack, vite, esbuild)
- Replacing the manual Arc build system with an automated one

**Why**: Rewrites are the #1 cause of production regressions in this codebase. The existing systems work. They have subtle behavior (CSP nonces, cross-origin cookie detection, Arc bundle load order, PageOrganizer safety nets) that a rewrite will silently break.

When something seems "messy", **refactor in-place** rather than rewrite. Add tests before refactoring.

---

## 5. Backward Compatibility

**Never break an existing contract.**

Contracts in this codebase:
- `window.BrowserTools.process(toolId, files, opts)` → `{ blob, filename }` — never change the signature or return shape
- `window.PageOrganizer.open(hostEl, file, { onChange })` → `ctrl` — never change the signature
- `buildHtml(slug, template, step)` → HTML string — never change the signature
- All `/api/*` routes — never change method, path, or required body shape without versioning
- JWT cookie name `ilovepdf_token` — never rename (all clients look for this name)
- SQLite table names and column names — never rename without migration

If a contract must change, version it:
- New API routes: add `/api/v2/...` alongside existing `/api/...`
- New globals: add a new name alongside the old one (deprecate, don't delete)

---

## 6. Documentation-First Workflow

**Document before coding. Update docs after coding.**

### Before starting any non-trivial task:
1. Read the relevant doc from `docs/` (see `DOCUMENTATION_REPORT.md` for the index)
2. Check `AI_GUARDRAILS.md` for rules that apply
3. Check `TODO_MASTER.md` to see if this work is already tracked

### After completing any task:
1. Update the relevant doc if the implementation differs from what's documented
2. If a new route was added: update `docs/06_BACKEND_SCHEMA.md`
3. If a new env var was added: update `docs/21_ENVIRONMENT_CONFIG.md`
4. If a new tool was added: update `docs/10_TOOL_ENGINE.md` + `docs/23_AI_CONTEXT_EXPORT.md`
5. If a new Arc bundle was added: update `docs/09_RUNTIME_ARCHITECTURE.md` + `docs/03_TRD.md` + `docs/CHANGELOG.md`
6. If CI/CD changed: update `docs/07_DEPLOYMENT_GUIDE.md`

Documentation drift is a serious problem. Stale docs cause AI assistants and new developers to work from wrong information. Keep them current.

---

## 7. Security Is Non-Negotiable

**Security features are never removed for convenience.**

The following must always be active:
- **CSP nonces** per request (every HTML response gets a fresh nonce)
- **Rate limiting** on all `/api/*` routes (80 req/15 min)
- **Origin guard** on all `/api/*` routes
- **Usage limits** (guest/free/premium tier enforcement)
- **JWT as httpOnly cookie** (never in localStorage, never in a URL param)
- **bcrypt** for all password hashing (cost ≥ 10)
- **Admin guard** on all `/admin/*` and `/api/admin/*` routes

If you are tempted to disable one of these "just for testing", use a local dev flag gated on `NODE_ENV !== 'production'`, and remove it before committing.

---

## 8. Browser-First Processing

**If a tool can run in the browser, it must run in the browser.**

The defining characteristic of ILovePDF is that files never leave the user's device for most tools. This is both a privacy feature and a performance feature (no upload latency).

The `clientSide: true` flag on a tool means the browser path is the primary path. Server fallback exists for browsers that lack required APIs, but the server is never the default for client-capable tools.

**Before adding a server route for a new tool**, check:
- Can this be done with `pdf-lib`? (merge, split, rotate, watermark, protect, etc.)
- Can this be done with `pdf.js`? (rendering, text extraction)
- Can this be done with Canvas API? (image processing, cropping, filters)
- Can this be done with a CDN-loaded WASM library?

Only use the server for operations that genuinely require native code (Ghostscript for compression, qpdf for encryption, Sharp for server-side image processing).

---

## 9. Progressive Enhancement

**The app must work without optional services.**

Firebase, R2, and HuggingFace are all optional. The server boots and works correctly without any of them configured. This is enforced by:
- `isFirebaseConfigured()` guards before any Firebase call
- `isR2Configured()` guards before any R2 call
- `isHfConfigured()` guards before any HuggingFace call
- Graceful degradation to local `/tmp` storage when R2 is absent

Any new optional integration must follow this same pattern:
1. Add an `is{Service}Configured()` function that checks env vars
2. Log the status at server boot
3. Return graceful fallback behavior when not configured (not an error)

---

## 10. One Source of Truth Per Data Type

**Each type of data has exactly one authoritative source.**

| Data | Source of Truth |
|------|----------------|
| Tool definitions (all 43) | `public/js/tools-config.js` → TOOLS array |
| Tool URL slugs | `utils/seo.js` → SLUG_MAP (must match tools-config.js) |
| Tool SEO copy | `utils/seo-keywords.js` |
| Database schema | `utils/db.js` |
| Bundle manifest | `public/js/bundles/bundle-manifest.json` (generated, do not edit manually) |
| Blog article content | `scripts/blog-data.js` |
| Environment variables | Replit Secrets + `.env.example` (documentation) |
| GitHub Actions secrets | GitHub repo Settings → Secrets |
| Runtime globals | `docs/09_RUNTIME_ARCHITECTURE.md` → Runtime Globals Reference |

When data appears to live in two places (e.g., SLUG_MAP exists in both `tools-config.js` and `seo.js`), changes must be made to **both** in the same commit.

---

## 11. Commit Hygiene

**One logical change per commit.**

- Do not mix documentation changes with code changes in the same commit
- Do not mix bundle rebuilds with route changes
- CI/CD workflow changes are their own commit
- Blog generation is its own commit

Commit messages should describe the "why", not just the "what":
- ✓ `"Migrate Firebase deploy to google-github-actions/auth (FIREBASE_TOKEN deprecated)"`
- ✗ `"update deploy.yml"`

---

## 12. AI Assistant Rules

When an AI assistant works on this project, these additional rules apply:

1. **Read before writing.** Always read the relevant source files and docs before making changes.
2. **Propose before implementing for risky changes.** If a change touches a file in the "extreme care" list (see `AI_GUARDRAILS.md` Section 3), write a proposal first.
3. **No hallucinated APIs.** Do not invent function names, route paths, or globals that don't exist. Grep the codebase to verify.
4. **Minimal footprint.** Make the smallest change that solves the problem. Do not refactor unrelated code "while you're in there".
5. **Announce what you're changing.** Before writing any file, state what you're about to change and why.
6. **Update docs after changes.** See Rule 6 above.

---

## Quick Reference: What Requires Approval Before Starting

| Action | Approval required? |
|--------|-------------------|
| Add a new tool (following the 9-step guide) | No |
| Add a new API route to an existing router | No |
| Fix a bug in a route handler | No |
| Add a blog article | No |
| Update SEO copy | No |
| Modify a runtime bundle source file | Read docs first, then proceed carefully |
| Change middleware mount order in `server.js` | Read `06_BACKEND_SCHEMA.md` first |
| Add a new npm package | Check for existing alternative first |
| Modify CSP directives | Read `11_SECURITY_ARCHITECTURE.md` + `17_ADSENSE_COMPLIANCE.md` first |
| Remove or rename a `window.*` global | **Get explicit approval** |
| Change `BrowserTools.process()` signature | **Get explicit approval** |
| Replace a major dependency | **Get explicit approval** |
| Introduce a new framework | **Get explicit approval — likely rejected** |
| Rewrite any existing system | **Get explicit approval — likely rejected** |
