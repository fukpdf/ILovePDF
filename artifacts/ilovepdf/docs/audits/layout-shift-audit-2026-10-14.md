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

### Header space reservation, asynchronous credits, and responsive navigation

A second header-related shift risk remained even when the canonical stylesheet was linked in the head: the old `body:has(.site-header)` offset only activated after `chrome.js` injected the header element. The first layout could therefore be calculated without the header offset and then move when the element appeared.

Changes:
- The canonical header CSS now reserves the header offset using the head's `data-shared-header-css` link, which exists before the shared-shell runtime injects the header. The mobile header height is reserved as 64px from the same first style calculation.
- The existing mobile and desktop community-economy widgets (credits/savings) are absolutely positioned within the header. Their asynchronous insertion and counter updates no longer participate in flex sizing and cannot push the brand or nav.
- Mobile/tablet brand positioning uses the viewport center rather than the remaining flex space. The existing credits widget remains on the right; on very narrow phones only the secondary savings pill is hidden to prevent overlap with the centered brand.
- Desktop primary navigation is now ordered **Merge PDF → Split PDF → Compress PDF → Organize PDF → All Tools**. Obsolete Organize/Convert dropdown wiring was removed; the All Tools mega-menu remains.
- The shared header stylesheet cache key was bumped, and both the homepage assembler and public-HTML normalizer now emit the canonical key.
- The shared-shell regression check asserts the desktop nav order, removal of legacy dropdown code, first-paint space reservation, absolute credits widgets, and centered mobile/tablet brand. The build/test/audit scripts now syntax-check `public/js/chrome.js`.

These are source-level fixes and regression guards. They reduce known causes of header-related layout shifts, but actual device/browser CLS still requires runtime traces.
 
### Preview transition and processing-engine warmup

The tool preview preparation path contained a fixed 2,200 ms minimum wait and awaited `BrowserTools.prewarm(tool.id)` before the preview UI could appear. That delayed the transition even when the preview renderer was ready and coupled processing-engine warmup to preview visibility.

Changes:
- Reduced the minimum transition time to 250 ms to avoid a long artificial wait.
- The transition now waits for preview-renderer readiness plus that short minimum display time; renderer errors no longer strand the user on the preparation screen.
- Processing-engine warmup is scheduled in idle time after `renderStandardPreviewStep(tool)`, so it no longer blocks the preview screen.
- Extended `shared-shell-cache-regression-check.js` to prevent the 2.2-second wait from returning, require engine warmup to occur after preview rendering, and verify the initial tool HTML has no parser-blocking or eager heavy-engine script URLs.
- The current source has 22 direct external script URLs, 173 `data-lazy-src` entries, zero parser-blocking direct external scripts, and no identified preview/processing/worker engine among the initial `src` URLs. The 173 lazy entries are still booted after upload intent; this is distinct from the initial page-load path and should be measured separately.

## CLS diagnostics

The performance monitor previously summed every layout shift across the page lifetime, which is not the CLS session-window algorithm. It now calculates CLS as the largest session window (new window after a 1-second gap or 5 seconds from the first shift), excluding shifts with recent user input. It also keeps a bounded ring buffer of the latest 25 layout-shift entries with:
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
- `npm run build` assembles the homepage, normalizes all public HTML, runs the shared-shell/CLS/font regression checks, and syntax-checks shared chrome, the tool page, the monitor, and the normalizer before Firebase Hosting deploys it.

## Verification status and remaining limitation

The changes have been committed to `main` and the latest source files were re-fetched. Source-level assertions were checked against the current committed contents: desktop navigation order, removal of obsolete dropdown code, canonical stylesheet references in the key entry points/build scripts, CSS brace balance, first-paint body offset reservation, absolute credit widgets, and viewport-centered mobile/tablet branding. A repository-backed `npm test` / `npm run build` execution, real-browser trace, Lighthouse run, and live-production before/after CLS measurement were not available in this execution context.

Therefore:
- **Source-level mitigation implemented:** yes — font swap risk is normalized in the build path and diagnostic attribution is available.
- **Regression checks authored and wired into package scripts:** yes.
- **Regression checks executed successfully against the repository:** not verified here.
- **CLS score / browser-level root cause certification:** not claimed. Run `npm test`, `npm run audit:layout-shift`, then capture cold-cache and warm-cache desktop/mobile browser traces before certifying a numeric CLS result.
