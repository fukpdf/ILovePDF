# Tool-page on-demand engine architecture audit — 2026-10-13

## Scope and intent

Refactor the shared tool page so opening a tool route does not request the processing engines, preview renderers, worker scripts, or unrelated tool-app bundles. Once the user selects a file, prioritize the preview path first. After the preview UI is visible, schedule the selected tool's processing foundation in the background during idle time. Let the user review the preview/settings while the engine warms in the background. If the user presses **Process** before the engine is ready, wait on the same preparation promise and start processing automatically once it succeeds.

This is a source/repository audit. It is **not** a live Lighthouse/DevTools verification report.

## Source-level results

- The shared HTML template had 388 external script tags on the baseline branch.
- The current branch template has **23 external script tags** and **0 parser-blocking external scripts**: 365 fewer static script tags in the initial HTML.
- Static HTML references **0 processing/preview engine scripts** and has **0 worker prefetch links**.
- The initial HTML no longer references processing engines, preview renderers, worker-pool scripts, per-tool processor bundles, or the idle runtime loader. The five remaining classic shell scripts that previously blocked parsing now use `defer` and execute in document order.
- Five worker `rel=prefetch` links were removed; worker downloads are now initiated through the selected-tool loader.
- The processing engine and preview scripts are not requested by static script tags on initial page load. The small shell still has normal UI/navigation, localization, registry, session-state, auth, and PWA scripts.
- The ad bootstrap no longer forces a third-party ad script request after 4.5 seconds or on any first scroll. It loads only if an actual ad slot exists and approaches the viewport; browsers without `IntersectionObserver` use a slot-aware scroll/resize fallback.
- The source-level regression test checks the initial shell, zero parser-blocking scripts, on-demand manifest, script ordering/deduplication, shared CDN dependency promises, preview-first background engine scheduling, process-button readiness gate, ad-slot-gated ad loading, layout reservation, and JavaScript syntax.
- The PDF-to-Word fidelity pipeline is downloaded sequentially after file selection for that tool only; its existing fallback loader safely reuses the already-loaded modules.

## Architecture changes

### Initial tool-page open

Keep the branded upload shell, route/tool metadata, essential localization/navigation, tool registry/configuration, session state, usage-limit UI, and `tool-page.js`. Add the small `tool-engine-loader.js` orchestrator. Processing/preview engines and unrelated diagnostic/dashboard scripts are absent from the initial HTML.

### After file selection

`runToolPreviewPreparation()` now prioritizes the preview before starting the processing runtime:

1. **Preview track first:** PDF preview renderer, live-preview module, page organizer, route preview helper, and only the special editor module needed by tools such as Edit PDF or Background Remover. The preview is rendered as soon as its dependencies are ready.
2. **Selected processing track second:** once the preview UI is visible, the engine is scheduled with `requestIdleCallback` (900 ms maximum wait) or a short timeout fallback. It loads ordered shared worker/runtime dependencies, `BrowserTools`, `BrowserToolRuntime`, and only the selected tool's advanced/translation enhancements where applicable. The engine's own `prewarm()` hook warms only that tool's likely CDN libraries or worker.

This avoids having the initial preview compete with dozens of processing-runtime requests. If the user presses **Process** before the idle callback, `processFile()` immediately calls `prepareEngine(toolId)`; the loader deduplicates the request and joins the same in-flight promise. Live Preview and Page Organizer are only requested for tool IDs whose manifest supports those experiences. Edit PDF and Background Remover prefer their dedicated editor engines and skip the generic runtime bundle when their editor mount API is available; generic fallback modules load only if that editor failed to register. Processing status is updated while the user reviews the file and settings.

### When Process is clicked

`processFile()` checks the selected tool's engine-ready state. If loading is still in progress, it waits on `prepareEngine(toolId)` and then continues the same click automatically. A failed load displays an actionable error and permits retry; it does not claim that processing started or silently switch to an unrelated processor.

### Readiness and dependency safety

- Preview resources are loaded first at high priority; after the preview is visible, the selected engine begins warming at idle priority. Within each selected track, resources are preloaded together and classic scripts execute sequentially with `async = false` to preserve dependency order without a serial network waterfall.
- Script requests and per-tool preparation promises are deduplicated.
- A failed script is removed from the in-flight cache so the user can retry.
- Advanced Engine's resumable-progress listener now handles being initialized after the page `load` event and checks the file that was already selected.
- Compression's dedicated `runAdvancedCompress()` path does not download the unrelated Advanced Engine bundle.

## Files changed in this branch

- `public/tool.html`: remove eager engine/preview/diagnostic/app scripts and worker prefetches; retain the upload/UI shell; make the ad runtime conditional on an actual near-viewport slot.
- `public/js/tool-engine-loader.js`: new split preview/engine loader and per-tool manifest.
- `public/js/tool-page.js`: render preview before scheduling selected-engine background warming, show readiness/error status, and let Process immediately start or join engine preparation. The shared UI/flow script remains part of the shell because it renders the upload page and binds file selection; splitting it into a tiny upload-only bootstrap is a separate, higher-risk refactor.
- `public/js/browser-tools.js`: prewarm only the selected tool's libraries or worker in the background, with explicit dependency maps for compression, conversion, OCR/translation, and worker-backed tools; shared CDN promises prevent Preview and BrowserTools from racing to inject duplicate PDF-Lib, JSZip, or Tesseract scripts.
- `public/js/live-preview.js`, `public/js/page-organizer.js`, and `public/js/edit-pdf-pro.js`: reuse the shared dependency promise for overlapping CDN libraries and PDF.js imports.
- `public/js/advanced-engine.js`: make resumable-progress binding work when the engine is lazy-loaded after page load.
- `scripts/tool-page-performance-check.js`: regression checks for the new on-demand architecture.
- `docs/audits/tool-page-performance-audit-2026-10-13.md`: this report.

## Latest source verification pass — 2026-10-13

- Re-ran the committed static regression script's assertions against the current fetched branch source using a source-backed harness: **42 PASS, 0 FAIL** (35 architecture assertions plus 7 JavaScript syntax checks).
- Added and exercised a VM-style runtime loader test: **6 PASS, 0 FAIL**, covering compression/translation/PDF-to-Word module scoping, dependency order, and duplicate-request prevention. The `audit:tool-page-performance` package command now runs both checks.
- The verified shell metrics are 23 external script tags, 0 parser-blocking external script tags, 0 statically referenced processing/preview engine scripts, 0 worker prefetch links, and 0 exact duplicate external script URLs.
- The source-backed harness executes the same assertions against fetched repository content; the runtime-loader test was exercised with a mocked DOM. The actual `npm run audit:tool-page-performance` command has **not** been run inside a cloned repository/runtime. Full `npm test`, CI, browser Network traces and end-to-end upload/process/download testing remain outstanding.

## Remaining risks and verification required

1. **Browser runtime tests are still required.** This environment can inspect/update GitHub source, but it has not run the deployed site in a real browser with Network/Performance panels. The live URL was not accessible to the available web browser tool during the earlier audit.
2. Run the Node regression check and full project test suite from `artifacts/ilovepdf`; CI status for the current branch is not confirmed here.
3. Test at least Compress, Merge, Split, Rotate, PDF-to-Word, PDF-to-Excel, OCR, Translate, Edit PDF, Background Remover, image tools, and one multi-file tool. Verify preview, settings, progress, cancel/retry, output validation, download, route/back navigation, and mobile touch.
4. Confirm registry entries with `execution: "browser"` all have `RuntimeScheduler`, `BrowserToolRuntime`, and `BrowserTools` available. These are included in the lazy core manifest, but browser execution has not been exercised here.
5. The initial shell still references UI scripts such as `chrome.js`, `i18n.js`, `tool-content.js`, and `shared.js`. Supplemental `i18n-ext.js` is no longer in the initial HTML; `chrome.js` loads it only after a non-English language is selected. Some shell scripts may still inject navigation or registry helpers dynamically. Audit their runtime Network requests separately; the current count measures static external script tags, not every possible dynamic request.
6. `tool.html` still includes non-critical CSS for shared homepage/footer/blog/SEO/ad/editor styles. CSS critical-path pruning and actual CLS/LCP measurements remain open.
7. Firebase hosting cache headers still use revalidation for `/js/**`, `/css/**`, `/workers/**`, and `/locales/**`. Do not set immutable long-lived caching until all relevant assets have reliable content-hashed/versioned URLs.
8. The static-host guard blocks same-origin `/api/**` calls on Firebase static hosting. Browser-side tools must keep clear error handling; server-dependent features need separate end-to-end verification.

## Acceptance criteria before merge/deploy

- Initial tool open requests no processing engine, preview renderer, worker script, or unrelated per-tool processor.
- After file selection, preview is usable without waiting for the processing engine to finish downloading.
- The selected tool's engine reaches a ready or explicit error state; no other tool's heavy bundle is downloaded.
- Clicking Process while the engine is loading waits and then begins processing automatically.
- No duplicate script injection, unhandled preparation rejection, or deadlock on a failed request.
- All targeted tool smoke tests pass, and cold-cache/warm-cache mobile and desktop traces show actual improvement in LCP/TBT/INP without a CLS regression.

**Status: source refactor implemented on the draft PR branch; browser/end-to-end verification remains pending. Do not merge or deploy until acceptance criteria are met.**
