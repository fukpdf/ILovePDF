# Tool page performance audit — 2026-10-13

## Scope and evidence

Repository source audit of `artifacts/ilovepdf/public/tool.html`, its tool-page shell CSS, compression runtime entry points, and the shared `tool-page.js`. The live browser Network waterfall, Lighthouse trace, real-device layout shifts, and end-to-end file processing were **not** available from this audit environment; source findings must not be represented as live-site measurements.

## Confirmed findings

1. **Oversized shared script graph.** Before this patch, `tool.html` declared 388 external script tags, 137 of them parser-blocking classic scripts. Four deferred diagnostic/admin scripts were included on every public tool page despite not being needed for upload/compression:
   - `runtime-production-certification.js`
   - `runtime-devtools-dashboard.js`
   - `runtime-enterprise-certification.js`
   - `runtime-inspector.js`
2. **PDF-to-Word fidelity modules blocked parsing.** Ten `/js/pdf-pipeline/*` scripts were synchronous even though their own page comments describe them as PDF-to-Word fidelity modules and their `PDFPipeline` references in `browser-tools.js` occur inside the asynchronous `pdfToWord()` implementation. They can be deferred in source order; deferred scripts execute before `DOMContentLoaded`, before the deferred `tool-page.js` boot path can accept a user upload.
3. **Layout-shift risk remains in the upload shell.** Initial HTML includes only a small upload skeleton, while `renderBrandedUploadStep()` replaces the entire `#tool-content` with a tool heading, upload zone, cloud-provider controls, benefits, trust strip, SEO content, learn-more content, and popular-tool cards. The skeleton CSS reserves fixed 64×64 px icon and 200×48 px button dimensions, but it does not reserve the final page's full height. A targeted `main#tool-content` viewport minimum was added so the shared footer stays below the initial viewport while JavaScript replaces the skeleton. This is a mitigation, not proof of a good CLS score: local movement within the upload hero and the longer SEO/content sections still need a browser trace.
4. **Non-critical runtime enhancements also blocked parsing.** The AI-upgrade and enterprise-telemetry scripts are event-driven/diagnostic enhancements that register their boot work around `DOMContentLoaded`; they are now deferred so they do not pause HTML parsing while retaining their own boot hooks.
5. **No exact duplicate external script URLs found** in the inspected source template. This is a template-level check; it does not prove the live browser has no redirects, dynamically injected duplicates, or repeated requests.
6. **Compression entry points are already deferred.** `compress-worker-adapter.js`, `compress-runtime.js`, `compress-pdf-app.js`, and `tool-page.js` are deferred, so the immediate opportunity was the broader shared script graph, not changing the compression entry points blindly.

## Changes in this branch

- Removed the four admin/developer diagnostics script tags from the public shared tool page. The diagnostics remain in the repository; this change only stops loading them for every public tool page.
- Added `defer` to the ten PDF-to-Word fidelity scripts while preserving their source order.
- Reserved the first viewport on `main#tool-content` to reduce the chance that the shared footer enters the viewport during skeleton replacement.
- Deferred `runtime-ai-upgrade.js` and `runtime-telemetry-enterprise.js`, whose boot work is scheduled from DOM/runtime readiness events.
- Added `scripts/tool-page-performance-check.js` and the `audit:tool-page-performance` package script to prevent regressions in script loading, diagnostics exclusion, upload skeleton dimensions, duplicate URLs, and the audited parser-blocking ceiling.

## Source-level verification

After the patch:
- External script tags in `tool.html`: **384** (down from 388).
- Parser-blocking external script tags: **125** (down from 137).
- Exact duplicate external script URLs: **0** in the template.
- The thirteen static assertions in the new performance check were evaluated against the current branch source and all passed.

To run the committed test in the repository:

```sh
cd artifacts/ilovepdf
node scripts/tool-page-performance-check.js
```

## Remaining work — do not mark complete yet

The remaining 125 parser-blocking scripts are still a substantial performance risk. The viewport reservation mitigates footer movement, but CLS remains an open item until measured; if local shifts remain, consider tool-aware placeholders or server-rendered shell markup. They include runtime/security infrastructure and other tool bundles with documented ordering dependencies. **Do not add `defer` globally or delete bundles by filename alone.** Continue dependency tracing and move only verified non-critical/feature-specific modules to a deferred or on-demand loading path, then run the full repository test suite.

Before deployment, verify on the deployed site with browser DevTools/Lighthouse:
- cold and warm cache, desktop and mobile;
- request initiators, transfer sizes, cache status, script evaluation/long tasks;
- FCP/LCP/CLS/INP/TBT and console/network errors;
- upload → compression → download, cancel/retry, large PDFs, and representative other tools;
- compare before/after measurements against the exact deployed commit.

Core Web Vitals targets are LCP ≤ 2.5 s, CLS ≤ 0.1, and INP ≤ 200 ms at the 75th percentile. These are targets, not results from this source audit.
