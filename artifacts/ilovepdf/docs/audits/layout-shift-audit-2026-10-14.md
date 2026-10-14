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
- `npm test` includes both checks.
- `npm run audit:layout-shift` runs both regression checks and JavaScript syntax checks.
- `npm run build` normalizes all public HTML before Firebase Hosting deploys it.

## Verification status and remaining limitation

The changes have been committed to `main` and the final source has been re-fetched for static verification. The connected GitHub session reported no commit status checks and no workflow runs for the inspected commit. A local checkout, Node execution, real-browser trace, Lighthouse run, and live-production before/after CLS measurement were not available in this execution context.

Therefore:
- **Source-level mitigation implemented:** yes — font swap risk is normalized in the build path and diagnostic attribution is available.
- **Regression checks authored and wired into package scripts:** yes.
- **Regression checks executed successfully against the repository:** not verified here.
- **CLS score / browser-level root cause certification:** not claimed. Run `npm test`, `npm run audit:layout-shift`, then capture cold-cache and warm-cache desktop/mobile browser traces before certifying a numeric CLS result.
