# ILovePDF Homepage Deep Audit — 2026-10-11

## Status

**Audit in progress — not certified complete.** This document records repository evidence inspected so far. It is not a substitute for browser, viewport, route, accessibility, or production measurements.

## Scope and safety boundaries

- Limit implementation changes to homepage-specific HTML/bootstrap, homepage JS/CSS/assets, and narrowly scoped build/CI validation required by the homepage.
- Do not edit PDF/image processing engines, tool runtime implementations, unrelated tool pages, API routes, security/worker infrastructure, or unrelated dependencies.
- Preserve current branding, layout, tool functionality, navigation, and routes.
- Make changes in small, reviewable commits on a topic branch; inspect changed paths before each commit/PR.
- Do not claim performance improvements without before/after measurements.
- Do not merge until validation evidence is complete and deployment consequences are understood.

## Repository evidence inspected

- Repository: `fukpdf/ILovePDF`; default branch: `main`.
- Homepage source: `public/index.html` currently contains a runtime bootstrap that fetches four `/index-chunks/z*.b64` files, concatenates base64, decompresses using `DecompressionStream('deflate')`, then replaces the document with the decompressed HTML.
- Chunk assembler: `scripts/assemble-homepage-index.js` reads those four chunks, inflates them using Node zlib, checks for HTML, `/js/chrome.js`, and `/js/home.js`, and writes `public/index.html`.
- Deployment workflow: `.github/workflows/deploy.yml` has a `push` trigger for `main` plus `workflow_dispatch`; it assembles the homepage before deploying Firebase Hosting and performs URL smoke checks. Therefore, merging a PR into `main` may trigger a production deployment.
- Homepage logic: `public/js/home.js`; tool catalogue/routing map: `public/js/tools-config.js`.
- `package.json` contains many tool/engine audit scripts; these must not be modified as part of this homepage task unless a direct, evidenced homepage dependency requires it.
- Recent commits show prior work on critical-path script ordering, homepage loader/chunks, bootstrap restoration, and build-time assembly. Their existence does not establish that all homepage requirements pass.

## Initial findings requiring verification

1. **Source/deploy artifact split:** source `public/index.html` is a loader, while the deployment workflow is expected to replace it with assembled full HTML. Verify that the assembler output is correct and that local/test hosting does not accidentally serve the loader.
2. **Loader compatibility/failure handling:** the source loader throws when `DecompressionStream` is unavailable. Its failure handler writes to `document.body`, which may not yet exist if a fetch fails very early. Determine whether this source file is ever served directly in supported environments; fix only if the runtime loader is part of a supported path.
3. **CI evidence:** the inspected latest commit had no reported combined status entries from the GitHub status endpoint. This does not prove workflows passed or failed; inspect actual Actions runs.
4. **Production side effect:** merging to `main` can launch Firebase Hosting deployment. Treat merge as a release action, not a documentation-only action.

## Chunked execution plan

### Chunk 0 — Baseline and scope
- Inventory homepage entry points, assets, scripts, styles, tool-card data, links, routes, workflows, and existing audit documents.
- Record baseline commit and exact file SHAs.
- Establish a changed-path allowlist; stop if a proposed change touches unrelated engines or tool files.

### Chunk 1 — Build/loader correctness
- Run the homepage assembler in a clean checkout/CI environment.
- Validate all four chunks exist, decode/inflate successfully, output is full HTML, critical scripts exist and are correctly ordered.
- Verify build output is deterministic and does not leave a loader artifact in the deploy artifact.
- Add/adjust narrowly scoped checks only if existing checks do not cover a demonstrated failure.

### Chunk 2 — Dependency and loading audit
- Trace homepage script/style references and transitive imports.
- Confirm PDF/OCR/conversion engines, WASM, and workers are not initialized by homepage-only navigation.
- Correct only homepage import boundaries; no engine rewrites.

### Chunk 3 — Cards, routes, assets, links
- Derive a complete inventory from the actual homepage data and markup.
- Check every card's metadata, icon mapping, route target, and destination existence.
- Check header, navigation, CTA, footer, legal/social/language/account links and asset responses.
- Report counts and evidence; repair only confirmed homepage defects.

### Chunk 4 — Responsive, accessibility, visual integrity
- Test viewports: 320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, and 1920 px.
- Check overflow, clipping, overlap, focus, semantics, keyboard/touch behavior, contrast, alt text, reduced motion, and layout shifts.
- Keep the established visual identity.

### Chunk 5 — Performance and network evidence
- Capture reproducible before/after initial JS/CSS bytes, request count, long tasks, FCP/LCP/CLS/INP where available.
- Label unavailable metrics NOT MEASURED; do not infer them from source changes.
- Confirm tool-specific resources are absent from homepage network requests unless demonstrably required.

### Chunk 6 — Re-test, commit, PR, merge gate
- Run build, relevant tests, route/link checks, browser tests, and final regression pass.
- Review the diff for unrelated paths and verify no tool engine files changed.
- Commit each coherent chunk with clear messages; open a PR to `main`.
- Do not merge while checks are missing/failing or while production deployment consequences are unresolved.
- After any merge/deploy, verify commit SHA, deployment version, homepage response, key routes, and code health again.

## Validation status matrix

| Area | Status | Evidence needed |
|---|---|---|
| Homepage build/assembly | Partial source inspection | Run assembler and validate output |
| Critical-path script order | Static guard exists | Run guard against assembled artifact |
| Heavy engine isolation | Not verified | Transitive import + browser network trace |
| Tool cards and links | Not verified | Full inventory and destination checks |
| Responsive viewports | Not measured | Browser screenshots/tests at all listed widths |
| Accessibility | Not measured | Automated and manual keyboard/semantic checks |
| Console/runtime errors | Not measured | Browser console and failed-request report |
| Performance metrics | Not measured | Repeatable before/after browser measurements |
| CI/Actions status | Not verified | Inspect actual workflow runs/checks |
| Production deployment | Not performed by this audit | Verify only after an explicitly approved release |

## Completion rule

Final status must be exactly one of `PASS`, `PASS WITH KNOWN ISSUES`, or `BLOCKED`, based on observed test evidence. A successful build alone is insufficient.

## Follow-up scope: first-render and Laba removal

The active implementation plan and execution log now live at the repository root in [`HOMEPAGE_LOADING_AND_LABA_REMOVAL.md`](../HOMEPAGE_LOADING_AND_LABA_REMOVAL.md). A read-only inventory script (`scripts/laba-removal-audit.js`) is wired into the Homepage Deep Audit workflow to classify repository references before any Laba-specific deletion. Laba removal is not complete until that inventory is reviewed, the assembler and tests assert the widget is absent, and browser verification passes.
