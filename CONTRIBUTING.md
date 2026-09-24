# Contributing to ILovePDF

## Development model

- `main` is the production branch.
- Feature, fix, audit, and migration work should be performed on a short-lived branch.
- Changes should enter `main` through a pull request after the repository audit workflow passes.
- Do not commit runtime user files, credentials, secrets, generated outputs, screenshots, prompts, or temporary processing data.

## Required validation

Before opening a pull request:

1. Run `npm ci --omit=dev`.
2. Run `npm test`.
3. Run `npm run audit:security`.
4. Run `npm run audit:runtime`.
5. Run the JavaScript syntax check used by `.github/workflows/audit.yml`.
6. Review the diff for accidental secrets, generated artifacts, or unrelated changes.

The pull request must describe the affected architecture/tool boundary and list validation performed.

## Architecture rules

- Keep shared platform code independent from tool engines.
- Prefer browser-side processing when a reliable browser implementation exists.
- Lazy-load tool engines and large dependencies; do not preload every engine.
- Treat static dependency caches separately from temporary user-file/result lifecycle.
- Release object URLs, workers, buffers, and temporary browser storage after processing.
- Laba AI is a separate chatbot surface and is not part of the document-tool registry or processing engines.
- Secrets belong in the deployment/provider secret store, never in source or browser-delivered configuration.

## Branch and release policy

Recommended GitHub repository enforcement for `main`:

- Require pull requests before merging.
- Require the Source Audit status check.
- Require at least one approving review where repository ownership permits.
- Dismiss stale approvals when new commits change the reviewed code.
- Block force-push and branch deletion.
- Require branches to be up to date before merge when practical.
- Restrict direct pushes to maintainers/administrators.
- Keep production deployment tied to the validated `main` commit.

These settings are repository-level GitHub administration controls; this file documents the policy but does not itself enforce those controls.
