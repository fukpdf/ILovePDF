# Browser Compression Kit Integration — Status

## Implemented in this branch

- The active \`runAdvancedCompress\` UI path no longer rasterizes PDF pages into JPEGs. The previous page-render route could damage 1-bit scans, masks, image filters, links, and page structures.
- Deep/Custom now route through a dedicated module worker (\`public/workers/compression-kit-worker.js\`) and a locally bundled QPDF-WASM engine. The canonical \`CompressWorkerAdapter\` also points to that worker, and cancellation terminates its dedicated worker.
- Added a strict QPDF structural pass using \`--stream-data=preserve\` and \`--object-streams=generate\`. It does not request image optimization or Flate recompression; the candidate is accepted only when smaller than the source.
- Added QPDF JSON object selection and SHA-256 checks for every decoded page-content stream, preserving page order and stream order. If any content stream cannot be fully decoded, page count differs, a hash differs, or any validation fails, the exact original bytes are returned.
- Added fail-closed preflight for visible signature/encryption/XFA/form markers, parsed \`/AcroForm\`, PDF.js outlines/attachments, page annotations/links, and QPDF catalog/page-tree structures including forms, outlines, tagged structure, permissions, actions, names, and annotations.
- Added a static browser build script that bundles the kit and copies QPDF/Ghostscript WASM assets to same-origin \`/vendor/compression/\` paths. The deploy workflow runs the build and smoke-checks the emitted bundle, worker, and WASM assets.
- Added mocked WASM CLI tests, QPDF JSON/hash-gate tests, published-package initialization smoke tests, and a generated 100-page PDF integration fixture. The regression workflow typechecks the compression modules, runs tests, and builds the bundle in an isolated workspace.
- \`CompressRuntime\` now carries an additive \`report\` field while retaining \`blob\`, \`filename\`, and \`alreadyOptimized\`.

## Important: this is not the full image-optimization kit yet

The integrated engine is currently a **lossless structural pass only**. It can compact PDF objects and may reduce file size, but it does not yet downsample or re-encode eligible RGB JPEG image objects. Deep/Custom preserve their UI mode names; Custom reports when its target is unreachable rather than degrading content to force a target.

Still required to meet the original full contract:
- Integrate the supplied shared policy/bytes/JPEG/image-math/placement/quality modules and browser image-object compressor.
- Prove exact eligibility for RGB DCT images and exact dictionary identity before deduplication; preserve gray, CMYK, Indexed, Flate, CCITT, JBIG2, masks, and all non-eligible image bytes.
- Implement correct placed-size DPI, uniform aspect ratio, true box/bicubic resampling, minimum 150 DPI, no upscaling, source-quality ceiling, and no WebP/AVIF PDF images.
- Integrate the deep Ghostscript/qpdf path only if it can satisfy the same decoded content-stream and structure-preservation contract. Do not use Ghostscript \`pdfwrite\` on documents where it rewrites non-image content.
- Add real fixture PDFs for Word export, Flate text, 1-bit/grayscale scans, CMYK JPEG, RGB photos, mixed aspect ratios, SMask, AcroForm, signed, encrypted, and 100-page documents. The current 100-page test generates a fixture; it is not a substitute for the requested real-world fixture set.
- Add browser automation/network capture proving that no PDF bytes leave the browser, exercise cancellation/memory pressure in actual browsers, and record quality-gate metrics and policy tuning.
- Review Ghostscript-WASM AGPL-3.0 obligations before shipping its asset. It is currently staged by the build script but is not invoked by the active lossless route.

## Validation status

Static source checks have been inspected, and GitHub Actions has a current run queued. A queued run is **not a passing test result**. No completed TypeScript check, npm test run, browser build smoke test, browser network capture, or real-PDF hash comparison has been evidenced yet. The PR must remain draft until the workflow completes and the remaining full image-engine contract is implemented and validated.

## Package API notes (2026-10-10)

- QPDF-WASM \`0.3.0\` publishes a default module factory, \`callMain\`, and an Emscripten filesystem. Its published documentation demonstrates local \`locateFile\`, \`FS.writeFile\`, \`FS.readFile\`, and CLI invocation.
- Ghostscript-WASM \`0.0.2\` publishes a module factory and \`gs.wasm\` at package root; its published tests exercise \`FS\`, \`callMain\`, and exit statuses. Browser bundling/asset loading still requires a passing build smoke test.
- The production app is a vanilla Node/static-page app, not a pre-existing Vite project. This branch adds an esbuild pipeline rather than assuming Vite \`?url\` imports exist.
