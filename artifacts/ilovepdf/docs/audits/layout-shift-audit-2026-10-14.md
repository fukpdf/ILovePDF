# Layout-shift (CLS) source audit — 2026-10-14

## Scope and evidence

This is a source-level audit of the public HTML build pipeline, shared tool shell, Google Fonts loading, and the existing client performance monitor. It is not a browser trace or a field/Core Web Vitals measurement.

## Confirmed source-level risk and mitigation

### Google Fonts late swap

Several standalone public pages were requesting Inter from Google Fonts with `display=swap`. That policy permits text to switch from fallback font metrics to Inter after the page has laid out. The resulting line wrapping and element dimensions can move headings, buttons, cards, and downstream sections.

Changes:
- Added `scripts/normalize-public-font-display.js`, which recursively scans `public/**/*.html` during the production build.
- The normalizer converts active Google Fonts CSS stylesheet links to low-priority style preloads, changes the font policy to `display=optional`, and preserves a no-JavaScript stylesheet fallback with the same optional policy.
- The root build command now runs the homepage assembler first and the font normalizer second. Firebase Hosting's configured predeploy command is `npm run build`, so the normalization is part of that build path.
- Updated known standalone pages directly: About, Tools, Blog, Privacy, Terms, Image Compressor, Image Converter, Currency Converter, Numbers to Words, QR Code Generator, Barcode Generator, and ZIP Builder.

The homepage assembler already had a first-render stabilization pass for the server-rendered nav and optional Google Fonts policy; the tool shell already used an optional font stylesheet. The new normalizer extends that protection to all public HTML pages handled by the build.

### Shared header stylesheet applied after parsing

About, Tools, Blog, Privacy, and Terms were confirmed to load `chrome.js` without linking the canonical shared-header stylesheet in their initial HTML head. The shared-shell runtime appends that stylesheet later. On those pages, the header can first participate in normal flow and then become fixed when the stylesheet arrives; this is a source-level layout-shift risk, particularly on cold-cache and mobile visits.

Changes:
- The public HTML normalizer now detects pages that use `chrome.js` or contain the shared `.site-header` markup and ensures exactly one canonical `/css/home-header-v2.css?v=20261014-hide-all-scrollbars-v2` stylesheet is present in the document head.
- The Firebase predeploy build runs this normalization across all public HTML files.
- The known static pages listed above were updated directly in `main`.
- The font/layout regression check now asserts that each shared-shell HTML page has one canonical first-paint header stylesheet in its head.

This avoids waiting for the shared-shell script to append critical header CSS after page parsing. It is a source-level mitigation; its effect on actual CLS still needs a browser trace.

### Preview transition and processing-engine warmup

The tool preview preparation path contained a fixed 2,200 ms minimum wait and awaited `BrowserTools.prewarm(tool.id)` before the preview UI could appear. That delayed the transition even when the preview renderer was ready and coupled processing-engine warmup to preview visibility.

Changes:
- Reduced the minimum transition time to 250 ms to avoid a long artificial wait.
- The transition now waits for preview-renderer readiness plus that short minimum display time; renderer errors no longer strand the user on the preparation screen.
- Processing-engine warmup is scheduled in idle time after `renderStandardPreviewStep(tool)`, so it no longer blocks the preview screen.
- Extended `shared-shell-cache-regression-check.js` to prevent the 2.2-second wait from returning, require engine warmup to occur after preview rendering, and verify the initial tool HTML has no parser-blocking or eager heavy-engine script URLs.
- The current source has 22 direct external script URLs, 173 `data-lazy-src` entries, zero parser-blocking direct external scripts, and no identified preview/processing/worker engine among the initial `src` URLs. The 173 lazy entries are still booted after upload intent; this is distinct from the initial page-load path and should be measured separately.

## CLS diagnostics

The performance monitor previously kept only the aggregate CLS score. It now also keeps a bounded ring buffer of the latest 25 layout-shift entries with:
- route pathname;
- shift value, timestamp, and whether recent user input caused it;
- up to five source nodes per entry, identified by tag, id, class, and role;
- previous and current rectangles for each source node.

Node text and page content are deliberately not collected. The CLS aggregate continues to exclude entries with recent user input, as required by the Web Vitals definition.

## Regression protection

- `scripts/layout-shift-attribution-regression-check.js` checks that source attribution, geometry, route, and recent-input handling work with a deterministic PerformanceObserver harness.
- `scripts/public-font-layout-stability-check.js` exercises the font normalizer against a fixture and every HTML file under `public` without writing files.
- `npm test` includes the shared-shell, CLS-attribution, and public-font stability checks.
- `npm run audit:layout-shift` runs both regression checks and JavaScript syntax checks.
- `npm run build` assembles the homepage, normalizes all public HTML, runs the shared-shell/CLS/font regression checks, and syntax-checks the monitor/normalizer before Firebase Hosting deploys it.

## Verification status and remaining limitation

The changes have been committed to `main` and the final source has been re-fetched for static verification. The connected GitHub session reported no commit status checks and no workflow runs for the inspected commit. A local checkout, Node execution, real-browser trace, Lighthouse run, and live-production before/after CLS measurement were not available in this execution context.

Therefore:
- **Source-level mitigation implemented:** yes — font swap risk is normalized in the build path and diagnostic attribution is available.
- **Regression checks authored and wired into package scripts:** yes.
- **Regression checks executed successfully against the repository:** not verified here.
- **CLS score / browser-level root cause certification:** not claimed. Run `npm test`, `npm run audit:layout-shift`, then capture cold-cache and warm-cache desktop/mobile browser traces before certifying a numeric CLS result.
