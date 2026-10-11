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

The source-only `public/index.html` loader fetches four base64 chunks and replaces the document, but `.github/workflows/deploy.yml` runs `scripts/assemble-homepage-index.js` before every production deployment and rejects a loader artifact. Production should therefore serve full HTML, not the four-request loader. The assembler also removes retired Laba/announcement tags and tool-only scripts. Validate both the assembled artifact and browser behavior on every change.

Earlier CI measurements on this branch recorded the following before/after sample: same-origin JS resources 114 → 64; JS bytes observed in the first 4.5 seconds 2,098,540 → 1,044,568; total requests 156 → 105; CLS 0.5193 → 0.0352; FCP 300 ms → 224 ms; LCP 1,728 ms → 1,564 ms. These were unthrottled local CI measurements, not production field data. Re-run after changes; INP remains unmeasured unless a valid interaction measurement is added.

## Current known implementation

- Homepage renderer: `public/js/home.js`
- Shared navigation/tool registry: `public/js/chrome.js`
- Card paint accelerator: `public/js/home-fast-boot.js`
- Chunk assembler: `scripts/assemble-homepage-index.js`
- Homepage source integrity checks: `scripts/homepage-deep-audit-check.js`
- Browser/viewport/a11y/performance checks: `scripts/homepage-browser-audit.mjs`
- All dedicated Laba widget assets/modules and `public/js/homepage-lazy-loader.js` have been deleted from the working branch after the repository scan. Active runtime manifests, tool-page HTML, SEO allowlists, and AI fallback integrations have been cleaned. Historical phase records are marked as historical instead of rewriting past claims.
- `scripts/assemble-homepage-index.js` removes any legacy Laba/announcement tags from the compressed source before serving the full production HTML. It also strips an explicit allowlist of tool-only runtime/federation/worker scripts from the homepage while leaving `public/tool.html` and engine source files intact.
- `public/js/home.js` and the duplicate root `home.js` now render recent tools inside their own section; neither may replace the `#tools-root` category container.

## Controlled implementation chunks

### Chunk A — Read-only dependency inventory — COMPLETE
1. Scan tracked text files for Laba/widget/lazy-loader references.
2. Classify references as homepage HTML, build script, audit/test, documentation, Laba-only implementation, or shared/non-Laba functionality.
3. Delete only dedicated Laba modules and remove Laba-specific integration points from shared code; preserve generic engines and tool-page processing boundaries.
4. Keep the scanner and final re-scan as verification evidence.

### Chunk B — Remove Laba from the homepage output — IMPLEMENTED, RE-TESTED
1. Remove Laba widget script and stylesheet references and the Laba-only lazy loader from assembled HTML.
2. Remove the delayed announcement modal assets that displaced the actual homepage as the measured LCP element.
3. Keep the homepage renderer, tool registry, navigation, translations, auth, ads, and PDF tool routes intact.
4. Add build-time and browser assertions that the assembled homepage contains no Laba widget, Laba stylesheet, or Laba lazy-loader request.

### Chunk C — Remove dedicated Laba implementation — IN PROGRESS
1. Dedicated widget, stylesheet, knowledge JSON, lazy loader, and Laba-only JS modules have been deleted.
2. Active shared AI integrations and audit scripts no longer use Laba as a fallback; generic vector operations retain deterministic local fallback behavior.
3. Runtime manifests, security allowlists, SEO path allowlists, tool-page markup, and active architecture docs have been updated.
4. Remaining references must be classified as historical documentation, removal tests/scanners, or any unexpected active code before final sign-off.

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


## First-render resource inventory — implementation evidence

The browser audit now records the served document’s byte length, linked stylesheets and media attributes, inline style-block count, script order/type/defer/async flags, font-face count, and image source/loading/intrinsic dimensions. It also fails if the actual served homepage still contains the four-chunk `DecompressionStream` document-replacement loader. This inventory is evidence for the implementation, not a claim that all resources are delivered simultaneously.

### Planned loading order

1. **HTML response:** complete homepage document, semantic header/hero/tool catalogue skeleton and stylesheet references.
2. **Critical CSS:** layout, typography, logo/header, hero and first visible card grid; avoid post-paint style injection that causes an unstyled flash.
3. **Critical assets:** logo and only genuinely required first-viewport assets with reserved dimensions; no blanket lazy-loading of above-fold assets.
4. **Shared shell and registry:** shared navigation/tool metadata in a deterministic execution order before the homepage renderer needs it.
5. **Homepage interactions:** category filtering, recent tools and mobile navigation, without importing PDF/OCR/WASM/worker processing engines.
6. **Non-critical enhancements:** translations not required for initial geometry, auth initialization, analytics/ads where applicable, and below-fold media deferred only when behavior remains intact.
7. **Tool-only runtime:** loaded only after navigating to the corresponding tool workflow.

### Comparison method

Compare the **actual served page** at the same viewport and browser conditions, not only source files. Capture the resource inventory, first-paint screenshots, FCP/LCP/CLS, request/byte counts, browser console, all 41 cards and links, and axe results. The official iLovePDF homepage is a UX reference; this work does not assume access to its private source or copy its proprietary implementation. INP is reported as `NOT MEASURED` unless a genuine interaction metric is captured.


## Chunk F — Remove the source-loader flash from Node-hosted deployments

**Finding:** The Node/Express server served `public/index.html` directly from `express.static`, while the committed file was the four-chunk runtime loader. Firebase deploy already runs the assembler, but Node/Replit/Railway startup did not guarantee that step. That made the user-visible loading sequence depend on which hosting path was used.

**Implementation:** The existing assembler is now exported as a reusable function and is called by `server.js` before static middleware can serve files. If assembly fails, startup fails rather than serving a misleading loader page. The PDF/tool engines and their routes are unchanged. The source chunks remain the source of truth, and the existing assembler still owns homepage-only cleanup.

**Verification required:** production artifact assembly, Node server startup, HTTP response contains full HTML and no `DecompressionStream` loader, all homepage browser tests, and regression checks. This chunk is not considered complete until those checks pass.


## Chunk G — Remove duplicate CSS downloads

**Measured finding:** The browser resource inventory found `/css/home-footer-v2.css` referenced twice (once without a query and once with a cache-busting query). Both URLs target the same local stylesheet path, so the browser can download and parse the same CSS twice.

**Implementation:** The homepage assembler now deduplicates repeated local `/css/*.css` stylesheet paths while preserving the last occurrence to retain the existing cascade position and cache-busting URL. A source-level assertion blocks duplicate local stylesheet paths from returning. No CSS content, tool engines, or tool-page markup is changed.

**Verification required:** browser resource inventory confirms one request for each local CSS path; compare FCP/LCP/CLS and rerun all viewport, route, accessibility, and Laba checks.


## Chunk H — Node server smoke verification

A dedicated CI smoke test now starts the real Express server on an isolated local port and checks the actual HTTP response for a full HTML document, no chunk/decompression loader, a real homepage H1, working homepage CSS, and no duplicate local stylesheet paths. The test shuts down its child process and never deploys or contacts production. This verifies the Node-hosted path in addition to the static assembler and browser test server.


## Chunk I — Prevent late duplicate footer CSS injection

**Measured finding:** The static page includes the footer stylesheet in the head, but `chrome.js` was checking only for a custom data attribute before injecting the same stylesheet again. The dynamically appended URL had a cache-busting query, so static deduplication alone could not detect the runtime duplicate. This can trigger redundant CSS parsing and late style recalculation.

**Implementation:** The shared chrome now checks existing stylesheet URLs by resolved pathname before appending the footer CSS. If the page already has `/css/home-footer-v2.css`, the static stylesheet is reused. The assembler and static audit normalize relative and absolute local CSS URLs so duplicate paths are detected consistently. The language-selector browser test resets to a known desktop viewport before interaction.

**Verification required:** the post-load resource inventory must show one request per local CSS path; CLS and footer language interaction must pass again.


## Chunk K — Canonical footer ordering and interaction

The browser audit found the footer language menu could be covered by the homepage blog section when opened upward. The shared shell previously replaced only the first footer in its existing location. It now removes any existing footer copies and appends exactly one canonical footer after all lower-page content. The browser audit checks one footer and verifies it follows the lower sections before exercising the language selector.
