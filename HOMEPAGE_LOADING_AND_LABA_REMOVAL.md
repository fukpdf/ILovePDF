# Homepage First-Render Optimization and Laba Removal

**Repository:** `fukpdf/ILovePDF`  
**Implementation branch:** `audit/homepage-deep-audit-20261011`  
**Status:** Merged to `main`; canonical Firebase deployment verified; custom-domain automation 403 remains a known warning  
**Last updated:** 2026-10-11

## Non-negotiable scope

- Preserve the current ILovePDF branding, tool cards, routes, upload/processing flows, navigation, responsive behavior, and accessibility.
- Make the first meaningful render visually complete and stable. Do not hide a slow staged-load problem with an artificial screenshot or loading overlay.
- Remove Laba completely from the user-facing product and remove Laba-only assets/modules only after dependency references have been classified.
- Do not modify unrelated PDF/image engines, tool workflows, API routes, worker/security infrastructure, or dependencies.
- Use topic branches and reviewed pull requests. The homepage implementation and follow-up smoke-check fixes have now been merged to `main` after dedicated browser, regression, security, and deployment checks.
- Never report unmeasured metrics as facts.

## Reference comparison

The official reference is [https://www.ilovepdf.com/](https://www.ilovepdf.com/). A live-page inspection on 2026-10-11 confirmed the following visible/document structure: (1) header with All PDF Tools, primary tool links, login/sign-up and language selection; (2) hero heading and supporting copy; (3) category filters for All, Workflows, Organize, Optimize, Convert, Edit, PDF Security and PDF Intelligence; (4) tool-card catalogue with titles and descriptions; (5) workflow, desktop/mobile and business promotion; (6) iLoveIMG cross-product promotion; (7) trust/security section; and (8) footer groups for Product, Resources, Solutions, Legal, Company and language selection. This is the content inventory visible in the inspected page, not a claim that every network resource finishes simultaneously.

The project homepage currently has its own branded header/hero, 41 registry-driven cards, category sections, utility/secondary content and footer. The important difference was not simply the amount of content: the source public/index.html could be a four-chunk JavaScript loader that replaced the document after fetch/decompression, and category cards could be inserted after first paint. The implementation now assembles full HTML before serving, pre-renders all 41 cards from the existing registry, and defers tool-specific processing stacks to the relevant workflow. The browser QA confirms the resulting homepage has no horizontal overflow and no avoidable card insertion shift above the CLS threshold.

This comparison is a behavior and information-architecture reference, not permission to copy proprietary implementation or assume the official page downloads every resource in one network phase. The official site's private network waterfall was not independently measured in this CI run; exact official FCP/LCP/CLS/request counts are therefore NOT MEASURED.

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

### Chunk C — Remove dedicated Laba implementation — IMPLEMENTED, RE-AUDITED
1. Dedicated widget, stylesheet, knowledge JSON, lazy loader, and Laba-only JS modules have been deleted.
2. Active shared AI integrations and audit scripts no longer use Laba as a fallback; generic vector operations retain deterministic local fallback behavior.
3. Runtime manifests, security allowlists, SEO path allowlists, tool-page markup, and active architecture docs have been updated.
4. Remaining references must be classified as historical documentation, removal tests/scanners, or any unexpected active code before final sign-off.

### Chunk D — First-render stabilization — IMPLEMENTED, BROWSER VERIFIED
1. Ensure the delivered HTML already contains the primary heading, hero, categories, cards, and layout skeleton before non-critical scripts execute.
2. Make critical CSS/layout available before first paint; defer non-critical CSS/JS only when this does not create a flash of unstyled content.
3. Preserve image/font dimensions and reserve space for dynamic content.
4. Avoid an extra client-side fetch/decompress/document-replacement step on the production path.
5. Compare first paint, FCP/LCP/CLS, resource requests, initial JS/CSS bytes, and screenshots against the current baseline.

### Chunk E — Full verification and documentation — DEDICATED WORKFLOW PASSED; MERGE/POST-MERGE VERIFICATION PENDING
1. Build/assemble from a clean checkout.
2. Run static/source, route/link, and asset checks.
3. Run Chromium browser tests at 320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, and 1920 px.
4. Run axe accessibility checks; fix real violations instead of suppressing them.
5. Verify header/mobile menu, every tool card/link, footer, no horizontal overflow, no hidden cards, no Laba UI/network requests, no console errors, and no engine regressions.
6. Repeat the checks after fixes and update this root-level document and the existing audit log.
7. The dedicated homepage workflow has passed. Review the unrelated existing CI failures and deployment consequences, then merge the reviewed PR to `main` and repeat the smoke/browser checks against the merged revision.

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

- 2026-10-11: Read-only scan and dedicated homepage workflow passed: 1,026 tracked text files scanned; no dedicated Laba paths or active application references remain. All remaining references are documented historical records, test/removal guards, or workflow references.
- 2026-10-11: Fixed the browser audit's Node/browser scope error by using IDs captured in the browser DOM snapshot. Subsequent static, route, responsive, accessibility, and Laba checks passed.


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

The browser audit found the footer language menu could be covered by the homepage blog section when opened upward. The shared shell previously replaced only the first footer in its existing location. It now removes any existing footer copies and appends exactly one canonical footer after all lower-page content. The browser audit checks one footer and verifies it follows the lower sections before exercising the language selector. The footer also gets an explicit stacking level. A second `.footer` rule had `overflow:hidden`, which clipped the upward-opening language panel despite its z-index; that clipping is now removed from the footer itself and constrained to the decorative watermark pseudo-element instead.


## Chunk L — Pre-render all homepage cards into the initial HTML

**Measured finding:** The layout-shift trace showed the three category shells initially arriving without their cards; `home.js` inserted the card markup roughly a quarter-second later. The PDF category expanded and the image/utility sections collapsed during that render, producing a CLS spike of 0.372 in one run. This was the real “HTML/CSS arriving in stages” behavior the user reported.

**Implementation:** The existing `TOOL_GROUPS`, `TOOL_ICON_SVGS`, and `CAT_CONFIG` data are now read by the build-time assembler to render the same 41 cards, descriptions, routes, badges, and inline SVG icons into the assembled HTML. The renderer is data-driven from the existing source files; it does not duplicate the registry or modify tool engines. At runtime, `home.js` recognizes matching cards and leaves them untouched. A static audit now fails if all 41 cards are not present in the initial HTML. Responsive overflow diagnostics also report the exact elements exceeding the viewport.

## Latest verification after responsive/menu remediation — 2026-10-11

**Current implementation result:** the dedicated Homepage Deep Audit workflow passed on commit e379412f61e73b6aa250837f9264b0478dbb0260.

### Laba removal scan
- Tracked text files scanned: **1,026**.
- Dedicated Laba/lazy-loader paths remaining: **0**.
- Laba-specific files with references remaining: **0**.
- Other references: **16 files**, all classified by the scanner as documentation, historical records, removal guards, or test/workflow references.
- Active application-code references: **0**.
- Homepage Laba UI/assets/network requests: **0**.

### Browser verification
- Viewports checked: **15/15 pass** at 320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, and 1920 px.
- Homepage cards: **41 present, visible, titled, described, and iconed**.
- Card routes checked: **41/41**.
- Homepage anchors: **151** with usable targets; **53 unique internal navigation/footer destinations** checked.
- Accessibility: **0 axe violations**, including **0 critical/serious**.
- Uncaught browser errors: **0**.
- Failed same-origin assets: **0**.
- Tool-only processing/federation/worker scripts requested by homepage: **0**.
- Desktop All Tools menu bounds: contained within the viewport after opening.
- Horizontal overflow: **0** at every required viewport.

### Latest performance sample
Unthrottled local Chromium CI; not production field data:
- FCP: **356 ms**
- LCP: **356 ms** (hero paragraph was the measured LCP element)
- CLS: **0.0319**
- Requests: **86**
- Same-origin scripts: **48**, encoded bytes **850,146**
- CSS files: **9**, encoded bytes **209,860**
- INP: **NOT MEASURED**

A second successful run measured FCP/LCP **372 ms** and CLS **0.0318**. An earlier intermittent run exposed CLS **0.319**; the DOM trace identified the shared shell replacing the existing header with a skeleton and rebuilding the nav. The header is now preserved on the homepage and only missing dropdown panels are hydrated in place. The final browser test explicitly asserts the server-rendered header remains mounted at boot. The final samples meet the CLS target of less than 0.1; all timings are local lab measurements only.

### Fixes from the failed viewport run
- The root scrollport is clipped to the viewport to eliminate the measured 2–3 px horizontal overflow.
- The desktop All Tools menu is anchored to the viewport rather than the narrow navigation item, preventing the panel from extending beyond the right edge.
- The shared shell preserves the existing homepage header and hydrates only missing dropdown panels in place; it no longer replaces the visible header with a skeleton on the homepage.
- The browser audit now asserts header preservation, captures root/body/pseudo-element overflow diagnostics, and verifies the opened desktop menu remains within viewport bounds.

### Production deployment verification — 2026-10-11

- Homepage implementation merged to main: commit f148a22c2837a69729e145df75e3be705a6b183d.
- Deployment smoke-check follow-up merged to main: commit a15546b84269fb39f1da8ed39b1ca2760910c2bc.
- Custom-domain smoke policy merged to main: commit 025b30bea185d9226b01706e45a7d41a0672b1a7.
- Latest Deploy Project workflow: **SUCCESS** (run 38145498989).
- Canonical Firebase origin: homepage, Crop PDF, Compress PDF, tool config, tool-page.js, home.js and home-fast-boot.js returned **HTTP 200**.
- Homepage critical-path script order: **PASS**.
- Deployed version endpoint matched the main commit: **PASS**.
- Custom domain https://ilovepdf.cyou/compress-pdf returned **HTTP 403** to GitHub Actions curl even with browser-like headers. The workflow now reports this specific custom-domain probe as a warning while keeping canonical-origin route/assets and deployment-version checks mandatory. Search indexing has a page for the route, but direct current browser behavior was not independently verified. Do not interpret this as a confirmed user-facing outage or as a confirmed fix.

### Broader repository CI note
The dedicated homepage workflow, source audit, project regression tests, security/file-lifecycle audit, syntax checks, and deployment-origin smoke checks passed. Some separate Phase 5 workflows still report missing audit scripts referenced by repository package scripts, and the global i18n workflow inspects the unassembled source loader instead of the production HTML artifact. These broader repository/CI contract issues are documented and were not “fixed” by editing unrelated PDF/image processing engines.

## Follow-up: stable first-paint bootstrap — 2026-10-11

**Branch:** `perf/homepage-stable-first-paint-20261011`

### Finding

The assembled homepage already contains all tool cards, and `home.js` is the authoritative owner of homepage rendering. However, `home-fast-boot.js` also called the category renderer, recent-tools renderer, icon-repair hook, and Lucide's DOM replacement. At the same time, `home.js` runs its own `bootHomePage()` path and calls `renderRecentUse()`, `renderCategorySections()`, and icon repair. The fast-boot helper also had overlapping readiness starts (DOMContentLoaded plus an independent zero-delay timeout), which could invoke its paint path twice. This duplicated work after the browser had begun painting and could cause avoidable main-thread work or movement in the Recent Tools section when it contains saved entries.

### Implementation

- Replaced the fast-boot paint hooks with a one-shot, idempotent `ilovepdf:tool-groups-ready` signal.
- Removed DOM rendering, icon replacement, and duplicate polling starts from `home-fast-boot.js`. `home.js` remains the single authoritative owner of rendering and icon repair; pre-rendered category cards remain in place.
- Added `scripts/homepage-fast-boot-check.js`, a regression guard that rejects reintroduction of render calls, Lucide DOM replacement, interval polling, or duplicate readiness-dispatch sites.
- Wired the new guard into `.github/workflows/homepage-audit.yml` so it runs after production HTML assembly and before the full homepage browser audit.
- Kept the change scoped to homepage boot behavior; PDF/image processing engines and tool routes are untouched.

### Verification status

- Static implementation and workflow changes are committed on the follow-up branch.
- The new regression check and full browser/a11y/viewport suite must run in CI before merge.
- No post-change FCP/LCP/CLS improvement is claimed yet. Capture before/after lab results under the same viewport, throttling, browser and cache conditions. Confirm first-viewport screenshots and geometry remain stable; verify all 41 cards/routes, language switching, recent-tools behavior, mobile menu, axe, console, and asset checks.
- Reference guidance used: [web.dev — Optimize LCP](https://web.dev/articles/optimize-lcp) and [web.dev — Optimize CLS](https://web.dev/articles/optimize-cls). These recommend exposing critical content early and preventing unexpected shifts; they do not substitute for measurements on this project.

### Follow-up: full-viewport and dense responsive coverage — 2026-10-11

**User requirement:** the page should use the available screen width correctly, leave no accidental side gaps, and be checked across window sizes without unrelated visual redesign.

**Audit improvement:**
- Expanded width checks from 15 preset widths to a dense 40px sweep from 320px through 1920px, plus breakpoint edges and wide displays up to 2880px.
- At every tested width, the browser audit now checks the .page shell reaches both viewport edges, the tools grid uses a sensible share of available width, the responsive column count matches the intended breakpoints (2 columns through 768px, 3 through 1280px, 4 above 1280px), and no cards are clipped, hidden, overlapping, or horizontally overflowing.
- Added mixed viewport width/height profiles for short laptop windows, tablet portrait/landscape, mobile portrait, standard desktop and ultrawide screens. These assert full-width header/page coverage and that hero text remains inside its visual container.
- Corrected the browser audit's whitespace-splitting regular expressions so computed grid tracks and diagnostic class names are actually parsed; syntax-only checks would not catch this logic error.
- First expanded-matrix run exposed a test-selector false negative: `document.querySelector('.tools-grid')` selected an empty/hidden grid (width 0) even though all 41 real cards were visible. The audit now selects the widest visible grid containing actual tool cards and falls back to the visible content shell plus measured card-column positions. The original failure was a test instrumentation issue, not evidence of a user-facing width defect; the corrected full suite is being rerun.
- The next verification caught a duplicate `vw` declaration in the newly expanded browser audit before any viewport assertions ran. Removed the duplicate declaration; CI must re-run the browser suite against this exact revision before the change can be considered verified.
- This is a test-first change: it does not globally force every child section to 100% width. Centered content and internal spacing are preserved where intentional; only measured unintended gaps or clipping should be corrected.

**Verification:** the new width/height checks are committed in scripts/homepage-browser-audit.mjs. The Homepage Deep Audit workflow must pass these new assertions before the pull request is eligible to merge. If any profile fails, use the reported width, geometry and offending selector to make a minimal targeted fix, then rerun the same full workflow. No claim is made that the expanded matrix has passed until CI reports success.

### Final status
**PASS WITH KNOWN ISSUES**

The homepage implementation is merged and deployed. Its required browser matrix passes with 41 cards/routes, 0 axe violations, 0 page errors, 0 failed assets, 0 Laba requests, no horizontal overflow, and CLS 0.0319 in local unthrottled CI. INP and official-site field performance remain NOT MEASURED. The remaining operational caveat is the custom-domain HTTP 403 from automated smoke requests; validate the route in a real browser or review the domain's bot/security policy separately.


## Matched live homepage comparison

The homepage audit workflow now includes `scripts/homepage-live-comparison.mjs`. It loads the currently deployed `https://ilovepdf.cyou/` and the official `https://www.ilovepdf.com/` in fresh browser contexts, on mobile (390×844) and desktop (1366×768), with three runs per site/profile. It records median FCP, LCP, response-start, DOMContentLoaded, load-event, transfer-size estimate, resource/script/CSS counts, CLS, and failed navigation status. This is a same-runner lab comparison, not field Core Web Vitals; cross-origin resource transfer sizes may be unavailable where the server does not expose Resource Timing data. Because this benchmark targets the public URLs, it measures the deployed c.you version, not unmerged PR code.
