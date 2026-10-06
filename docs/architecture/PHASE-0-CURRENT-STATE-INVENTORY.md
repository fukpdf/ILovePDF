# Phase 0 — Current-State Repository Inventory

Validation baseline: `main` at `37f3f71ccb1e477af1bb2290e01bfc7f6fe301af` (2026-09-29)

## Repository shape

At the validation baseline:

- public HTML files: 61
- JavaScript files in the repository: 725
- maintenance/audit JavaScript files under `scripts/`: 47
- authoritative package manifests: root `package.json` + `package-lock.json`; Cloudflare Worker has its own package manifest/lockfile

These counts are discovery facts for the audited commit, not permanent constants. The Phase 0 closure audit recomputes the relevant inventory on every run.

## Runtime and deployment paths

| Boundary | Current path |
|---|---|
| Public static frontend | `public/` |
| Shared tool shell | `public/tool.html` |
| Shared client processing | `public/js/browser-tools.js`, `advanced-engine.js`, tool runtimes |
| Shared runtime bundles | `public/js/bundles/` |
| Node server | `server.js` / Express 5 |
| Temporary server uploads | `utils/upload.js` → OS temp upload directory |
| Optional durable object storage | Cloudflare R2 routes/configuration |
| Static deployment | Firebase Hosting |
| Worker deployment | Cloudflare Worker under `cloudflare/worker/` |
| Alternative server deployment | documented Docker/Vercel paths; Replit is the documented Node runtime |

## Tool inventory / ownership baseline

The authoritative client tool inventory is `public/js/tools-config.js`. Server-side clean-URL/SEO mapping is maintained by `utils/seo.js`. The shared `tool.html` shell receives per-tool context at request time; standalone tools may retain their own HTML entry points.

Tool ownership remains distinct from the shared platform: shared lifecycle/runtime/UI infrastructure does not replace tool-specific processors or validation.

## Browser/server execution split

Browser-first processing is the preferred path where technically reliable. Client-side tools use browser APIs/engines and may use Web Workers/runtime bundles. Server-side routes remain available for operations requiring server/native capabilities or authenticated/storage workflows.

This is a current-state description. It does not claim that every existing tool already satisfies the final Phase 1 client-first contract; those exceptions are migrated in later phases.

## Security and secrets

- Express applies security middleware/CSP/origin/rate-limit controls.
- Server credentials are environment/provider secrets.
- `JWT_SECRET` is required for production and the documented development fallback is explicitly insecure.
- Firebase/R2/Worker credentials are not intended for frontend source.
- Runtime telemetry and security incident routes are separate from document processing.
- No processed-file bytes are intended to be logged.

## Temporary/permanent storage

- Default server upload lifecycle uses an OS temporary directory.
- Upload cleanup and periodic orphan sweeping are implemented.
- Client-generated files/object URLs/runtime state have explicit lifecycle contracts in the architecture documentation.
- Durable account storage, where enabled, is a separate product capability with its own access/retention boundary.

## Tests and CI

The repository does not use a conventional unit-test framework as its primary test suite. Its current validation model is script/CI based:

- `npm test` → enterprise CI gate
- security/runtime audits
- JavaScript syntax checks
- runtime bundle integrity checks
- phase-specific closure audits
- GitHub Actions workflows for audit/deployment

Browser/E2E validation remains a separate layer and is not inferred from source/CI checks.

## Current UI/shared systems

- `public/tool.html` is the standard tool shell.
- `public/js/chrome.js` supplies the shared public header/footer shell.
- canonical header/footer/accessibility styles are under `public/css/`.
- language/i18n runtime is shared.
- standalone tools remain allowed where their UI/processing architecture requires independence.

## Migration constraints / non-goals

Phase 0 does not migrate tool engines, redesign tool processors, or claim production-scale backend separation. It establishes the current-state baseline so later phases can make controlled changes without confusing current architecture with target architecture.

## Governance boundary

Repository policy is documented in `CONTRIBUTING.md` and `.github/CODEOWNERS`. GitHub branch protection/rulesets are administrative controls and cannot be created by committed source files. At the time of this validation, the GitHub API reports `main` as unprotected; this remains an administrator action and is deliberately recorded rather than falsely marked as implemented.
