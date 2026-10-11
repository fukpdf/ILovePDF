# Homepage First-Render Optimization and Laba Removal

**Repository:** `fukpdf/ILovePDF`  
**Working branch:** `audit/homepage-deep-audit-20261011`  
**Status:** Audit in progress — not certified complete  
**Last updated:** 2026-10-11

## Non-negotiable scope

- Preserve the current ILovePDF branding, tool cards, routes, upload/processing flows, navigation, responsive behavior, and accessibility.
- Make the first meaningful render visually complete and stable. Do not hide a slow staged-load problem with an artificial screenshot or loading overlay.
- Remove Laba completely from the user-facing product and remove Laba-only assets/modules only after dependency references have been classified.
- Do not modify unrelated PDF/image engines, tool workflows, API routes, worker/security infrastructure, or dependencies.
- Make small commits on the topic branch. Keep `main` untouched until the complete test matrix passes and the deployment consequence is reviewed.
- Never report unmeasured metrics as facts.

## Reference comparison

The official reference is [https://www.ilovepdf.com/](https://www.ilovepdf.com/). Its homepage exposes the main tool catalogue, navigation, category filters, and footer as a cohesive page. This is a behavior and information-architecture reference, not permission to copy proprietary implementation or assume all resources arrive simultaneously.

The repository's existing source loader `public/index.html` fetches four base64 chunks, concatenates them, decompresses with `DecompressionStream('deflate')`, then replaces the document. The deploy assembler `scripts/assemble-homepage-index.js` inflates those chunks at build time so production can serve full HTML. Validate both the production artifact and the actual initial render: source-loader behavior alone does not prove what production users receive.

Earlier CI measurements on this branch recorded the following before/after sample: same-origin JS resources 114 → 64; JS bytes observed in the first 4.5 seconds 2,098,540 → 1,044,568; total requests 156 → 105; CLS 0.5193 → 0.0352; FCP 300 ms → 224 ms; LCP 1,728 ms → 1,564 ms. These were unthrottled local CI measurements, not production field data. Re-run after changes; INP remains unmeasured unless a valid interaction measurement is added.

## Current known implementation

- Homepage renderer: `public/js/home.js`
- Shared navigation/tool registry: `public/js/chrome.js`
- Card paint accelerator: `public/js/home-fast-boot.js`
- Chunk assembler: `scripts/assemble-homepage-index.js`
- Homepage source integrity checks: `scripts/homepage-deep-audit-check.js`
- Browser/viewport/a11y/performance checks: `scripts/homepage-browser-audit.mjs`
- Laba-specific assets/modules are present under `public/laba/` and `public/js/laba-*.js`.
- `public/js/homepage-lazy-loader.js` is dedicated to deferring Laba's AI stack; it must be removed from the served homepage and deleted only after references are audited.
- The assembler currently moves the Laba widget script after the homepage renderer rather than removing it. This is not sufficient for the requested total removal.

## Controlled implementation chunks

### Chunk A — Read-only dependency inventory
1. Scan tracked text files for Laba/widget/lazy-loader references.
2. Classify each reference as homepage HTML, build script, audit/test, documentation, Laba-only implementation, or shared/non-Laba functionality.
3. Do not delete shared modules based only on a filename or keyword.
4. Record every candidate file and all external references before removal.

### Chunk B — Remove Laba from the homepage output
1. Remove Laba widget script and stylesheet references and the Laba-only lazy loader from the assembled HTML.
2. Remove any static Laba widget markup/initialization if present, after confirming its exact boundaries.
3. Keep the homepage renderer, tool registry, navigation, and translations intact.
4. Add build-time assertions that the assembled homepage contains no Laba widget, Laba stylesheet, or Laba lazy-loader reference.

### Chunk C — Remove dedicated Laba implementation
1. Remove only Laba-specific scripts/assets after the repository scan shows no live non-Laba consumer.
2. Update homepage tests so they assert Laba is absent instead of expecting the Laba widget or its AI modules.
3. Remove Laba-only files and references; do not remove shared PDF engines or general AI dependencies without evidence they are exclusively Laba-owned.
4. Re-run the repository reference scan and explain any remaining historical documentation references.

### Chunk D — First-render stabilization
1. Ensure the delivered HTML already contains the primary heading, hero, categories, cards, and layout skeleton before non-critical scripts execute.
2. Make critical CSS/layout available before first paint; defer non-critical CSS/JS only when this does not create a flash of unstyled content.
3. Preserve image/font dimensions and reserve space for dynamic content.
4. Avoid an extra client-side fetch/decompress/document-replacement step on the production path.
5. Compare first paint, FCP/LCP/CLS, resource requests, initial JS/CSS bytes, and screenshots against the current baseline.

### Chunk E — Full verification and documentation
1. Build/assemble from a clean checkout.
2. Run static/source, route/link, and asset checks.
3. Run Chromium browser tests at 320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, and 1920 px.
4. Run axe accessibility checks; fix real violations instead of suppressing them.
5. Verify header/mobile menu, every tool card/link, footer, no horizontal overflow, no hidden cards, no Laba UI/network requests, no console errors, and no engine regressions.
6. Repeat the checks after fixes and update this root-level document and the existing audit log.
7. Keep the PR draft and do not merge to `main` until evidence is complete. The deployment workflow can deploy Firebase Hosting on a push to `main`.

## Definition of done

- No Laba widget, stylesheet, script, AI stack, or UI is loaded by the homepage.
- No Laba-specific module remains referenced by live application code.
- All 41 currently inventoried homepage cards remain present, visible, titled, described, iconed, and linked to valid destinations (update the count only if the authoritative catalogue proves it changed).
- No unnecessary PDF/OCR/conversion engine loads on the homepage.
- No staged unstyled page or avoidable layout shift remains.
- Build, route, asset, viewport, accessibility, console, and final regression checks pass.
- Metrics are reported with measurement context; anything not measured is explicitly marked `NOT MEASURED`.
- Final status is one of `PASS`, `PASS WITH KNOWN ISSUES`, or `BLOCKED`.

## Execution log

- 2026-10-11: Added a read-only repository Laba-reference inventory script and wired it into the homepage audit workflow. Awaiting CI output before any Laba implementation deletion.
- 2026-10-11: The latest browser audit exposed a test-script bug (a Node-side check referenced the browser-only `document` global). The script now uses IDs captured in the browser snapshot; rerun is required to confirm the fix.
