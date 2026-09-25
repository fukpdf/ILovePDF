# Phase 5 — Standard Tool Migration

## Unit 1 — Crop PDF reference implementation

Branch: `phase-5-unit-1-crop-reference`

Crop is the reference implementation for the standard tool family.

### Audit findings

Before this unit:
- Crop had a dedicated ToolApp boundary, but its processor spawned a fresh `pdf-lib-worker.js` for every job.
- The authoritative registry still declared Crop as main-thread browser execution.
- BrowserTools therefore did not classify Crop as worker-safe.
- The shared tool page still contained legacy `MAX_FILE_BYTES` rejection checks.
- The shared PDF worker did not expose a Crop operation, so Crop could not use the standard persistent WorkerPool / adaptive streaming path.

### Unit 1 implementation

Crop now:
1. remains tool-owned through `CropPdfApp`;
2. uses the shared `WorkerPool` for normal jobs;
3. uses `RuntimeStreamBridge.pipelineStreamToWorker` for large single-file jobs;
4. uses a cancellation token so unmount/reset/recovery can cancel active work;
5. uses the shared persistent `pdf-worker.js` Crop operation;
6. declares `browser-worker`, `workerPool=true`, `streaming=adaptive-worker`, and `fileSizePolicy=unlimited` in the canonical registry;
7. keeps shared input validation and output validation at the platform boundary;
8. removes the legacy 100 MB rejection from the shared tool page;
9. keeps the Crop-specific preview/preparation journey and SEO/UI behavior unchanged.

### No artificial processing limits

Crop does not introduce:
- file-size rejection thresholds;
- page-count rejection thresholds;
- fixed processing-time rejection timers.

Memory/device pressure remains adaptive rather than becoming a hard user-facing size limit.

### Verification

`npm run audit:phase5` verifies the complete Crop reference contract, including registry capability parity, worker operation, WorkerPool execution, adaptive streaming, cancellation/lifecycle cleanup, unlimited file policy, shared validation, and tool-shell integration.

Production deployment remains gated by this audit in `.github/workflows/deploy.yml`.

### Migration rule for Units 2+

Each standard tool will be audited against the same lifecycle:

register metadata → load on demand → validate input → prepare engine → process → validate output → expose result → cleanup.

Processing internals remain tool-owned; the shared platform owns lifecycle, contracts, routing, resource management, and verification.


## Unit 7 — Repair PDF

Branch: `phase-5-unit-7-repair-reference`

### Audit findings

Repair had two competing browser execution paths: a dedicated `repair-pdf-app.js` / `repair-worker.js` path with fixed timeouts, and an existing shared `OPS.repair` operation in `pdf-worker.js`. The registry still declared Repair as main browser execution. The dedicated path also performed extra PDF.js verification.

### Unit 7 implementation

Repair now uses the authoritative shared BrowserTools execution boundary:
- WorkerPool for normal jobs.
- RuntimeStreamBridge adaptive streaming for large files.
- Shared `OPS.repair` in `pdf-worker.js`.
- Existing Repair depth modes (`fast`, `standard`, `deep`, `maximum`) and output modes are preserved in the worker operation.
- The worker verifies that the generated PDF can be loaded and contains at least one page before returning it.
- `repair-pdf-app.js` is now only a lifecycle adapter; it no longer owns a dedicated worker, CDN dependency, fixed timeout, or alternate processing path.
- Both registries declare browser-worker, adaptive-worker streaming, WorkerPool, lazy loading, and unlimited file-size policy.


## Unit 8 — Edit PDF

Branch: `phase-5-unit-8-edit-reference`

### Audit findings

Before this unit:
- the registry already advertised Edit as browser-worker/WorkerPool, but the actual `edit-pdf-app.js` still spawned a dedicated `pdf-lib-worker.js`;
- that adapter imposed 75s worker and 90s hard processing timers;
- Edit PDF PRO performed its final PDF export on the main thread with pdf-lib, despite the shared worker operation `OPS.edit` already existing;
- the shared worker operation only covered the lightweight text-placement contract and did not represent the full interactive editor state.

### Unit 8 implementation

Edit now:
1. keeps the existing interactive EditPdfPro UI and preview behavior;
2. serializes page order, deleted pages, per-page rotations, annotations, styles, embedded PNG/JPEG data, and renderer scale into a worker-safe editor-state contract;
3. performs final PDF reconstruction/export inside the shared persistent `pdf-worker.js`;
4. preserves the lightweight text-only Edit contract for legacy/runtime callers;
5. routes both the ToolAppManager adapter and EditPdfPro export through `BrowserTools.process('edit', ...)`;
6. uses the shared WorkerPool for normal jobs and RuntimeStreamBridge for large single-file jobs;
7. adds cancellation-token propagation without sending non-cloneable token objects into the worker;
8. removes the dedicated Edit worker and fixed processing timers;
9. verifies the generated PDF in the worker before returning it;
10. preserves the existing registry contract: browser-worker, lazy load, WorkerPool, adaptive-worker streaming, and unlimited file-size policy.

### No artificial processing limits

Edit does not introduce:
- file-size rejection thresholds;
- page-count rejection thresholds;
- fixed processing-time rejection timers.

Device/memory pressure remains adaptive through the shared worker/runtime layers.

### Verification

`scripts/phase5-edit-check.js` is the Unit 8 migration gate. It checks registry parity, WorkerPool/stream routing, cancellation propagation, shared worker Edit support, rich editor-state export, output verification, the ToolApp adapter, the Edit PRO export path, lifecycle cleanup, and the no-artificial-timeout policy.

Production deployment remains gated by the Phase 5 validation chain.


## Unit 9 — Watermark PDF

Branch: `phase-5-unit-9-watermark-reference`

### Audit findings

The registry already declared Watermark as browser-worker/WorkerPool/adaptive-worker/unlimited, and `pdf-worker.js` already contained an `OPS.watermark` operation. However, the actual `watermark-pdf-app.js` still bypassed the shared runtime by spawning a dedicated `pdf-lib-worker.js`, reading the complete file on the main thread, and enforcing 75s/90s processing timers.

### Unit 9 implementation

Watermark now:
1. uses the existing shared BrowserTools WorkerPool route;
2. uses RuntimeStreamBridge for large single-file inputs;
3. propagates shared cancellation tokens;
4. removes the dedicated per-job worker and fixed processing timers;
5. preserves the existing text/opacity/position semantics while extending the worker contract to support top/bottom/left/right and corner positions plus configurable angle/font scale;
6. verifies the worker-produced PDF by reopening it and checking page count;
7. keeps the ToolAppManager lifecycle contract: mount, unmount, reset, recover, destroy, getState;
8. retains the registry's browser-worker, WorkerPool, adaptive-worker, and unlimited-file policy.

No artificial file-size, page-count, or processing-time rejection limit was added.

Verification is provided by `scripts/phase5-watermark-check.js`.


## Unit 10 — Sign PDF

Branch: `phase-5-unit-10-sign-reference`

### Audit findings

Sign had two browser execution layers: `sign-runtime.js` already used the shared PDF worker factory, but the authoritative `sign-app.js` still intercepted the tool with a dedicated `pdf-lib-worker.js`, read the complete file on the main thread, and enforced 75s/90s processing timers.

### Unit 10 implementation

Sign now:
1. routes the ToolAppManager processing adapter through shared `BrowserTools.process('sign', ...)`;
2. uses the existing shared `OPS.sign` operation;
3. uses WorkerPool for normal jobs and adaptive streaming for large single-file jobs;
4. propagates shared cancellation tokens;
5. removes the dedicated per-job worker and fixed processing timers from the authoritative Sign adapter;
6. preserves signature text, target-page behavior, styled signature and underline output;
7. explicitly keeps signature text out of diagnostic logging;
8. preserves mount/unmount/reset/recover/destroy/getState lifecycle semantics;
9. retains the registry's browser-worker, WorkerPool, adaptive-worker and unlimited-file policy.

The legacy `sign-runtime.js` remains compatible and already declares zero finite timeout values; it is not used as a competing processing implementation after `sign-app.js` registration.

No artificial file-size, page-count or processing-time rejection limit was added.

Verification is provided by `scripts/phase5-sign-check.js`.


## Unit 11 — Add Page Numbers

Audit found the authoritative Page Numbers adapter still spawned a dedicated `pdf-lib-worker.js` and enforced 75s/90s processing timers, despite the registry and shared worker already advertising the shared browser-worker contract.

The adapter now delegates to `BrowserTools.process('page-numbers', ...)`, uses the shared cancellation token and preserves lifecycle methods. The existing shared `OPS['page-numbers']` operation remains authoritative for numbering and position behavior.

No artificial file-size, page-count or processing-time limit is introduced. Large-file execution remains under the shared adaptive WorkerPool/streaming route.

Verification: `scripts/phase5-page-numbers-check.js`.


## Unit 12 — Redact PDF

Audit found Redact was intentionally using a dedicated `redact-worker.js` because true redaction requires pdf.js rasterisation; the shared pdf-lib rectangle operation was previously proven insecure because the underlying text remained recoverable. The app also owned fixed 120s/105s timers and bypassed the shared BrowserTools runtime.

The migration keeps the security-isolated worker family, but moves ownership into the shared runtime:
1. Redact is routed through `BrowserTools.process('redact', ...)`.
2. WorkerPool handles normal Redact jobs using the isolated `/workers/redact-worker.js` URL.
3. Adaptive RuntimeStreamBridge handles large inputs using the same isolated worker URL.
4. The Redact worker now supports transferable-stream and chunk-stream protocols while retaining its pdf.js raster-flattening security model.
5. The app adapter uses the shared CancelToken and lifecycle contract.
6. No artificial file-size, page-count or processing-time rejection limit is introduced.
7. The insecure shared `OPS.redact` path is not used for authoritative Redact processing.

Verification: `scripts/phase5-redact-check.js`.


## Unit 13 — Protect PDF

Audit found Protect still used a dedicated `pdf-lib-worker.js` and fixed 75s/90s processing timers. The existing Protect operation is retained unchanged for semantic compatibility: it applies the project's current protection/overlay behavior in the shared PDF worker; this migration does **not** claim that pdf-lib 1.17.1 provides native PDF encryption.

Migration:
1. Protect is now registered in the shared WorkerPool tool set.
2. Large inputs use RuntimeStreamBridge with the shared PDF worker.
3. Normal inputs use WorkerPool.
4. The app is a thin BrowserTools adapter with shared cancellation/lifecycle cleanup.
5. No artificial file-size/page-count/processing-time rejection limit is introduced.
6. The legacy dedicated app worker and fixed timers are removed.

Verification: `scripts/phase5-protect-check.js` — 17/17 checks passed.


## Unit 14 — Unlock PDF

Audit found Unlock was still an isolated dedicated `pdf-lib-worker.js` implementation with fixed 75s/90s timers and a full main-thread `arrayBuffer()` read before worker dispatch.

Migration:
1. Unlock is registered with the shared WorkerPool.
2. Large inputs use RuntimeStreamBridge adaptive streaming.
3. Normal inputs use WorkerPool transfer.
4. The app is a thin BrowserTools adapter with shared cancellation/lifecycle cleanup.
5. No artificial file-size/page-count/processing-time rejection limit is introduced.
6. Existing `OPS.unlock` semantics are preserved; this migration does not claim to bypass unknown/strong PDF encryption when the underlying pdf-lib loader cannot open the document.

Verification: `scripts/phase5-unlock-check.js` — 18/18 checks passed.


## Unit 15 — PDF to Word (DOCX packaging sub-migration)

Audit found the authoritative PDF→Word app still performed PDF.js extraction/OCR in the page context and spawned `pdf-word-docx-worker.js` directly for DOCX packaging. Because the full high-fidelity conversion engine uses browser APIs (PDF.js rendering, canvas/OCR, and PDFPipeline modules), the entire processor is not yet safe to advertise as a generic pdf-worker operation.

Implemented in this unit:
1. The DOCX packaging stage now uses the shared WorkerPool.
2. Shared `WorkerPool.CancelToken` is passed into the packaging task.
3. The existing dedicated DOCX worker protocol and high-fidelity document builder are preserved.
4. Direct `new Worker(DOCX_WORKER)` ownership was removed from the app.
5. Lifecycle cleanup no longer terminates an app-owned DOCX worker.
6. No artificial processing timeout was introduced.

This is intentionally a **sub-migration**, not a claim that the entire PDF→Word pipeline is now worker-safe. PDF.js extraction/OCR and browser-dependent fidelity modules remain to be isolated before the registry can truthfully advertise full shared-worker execution.


## Unit 16 — PDF to Word native extraction

The next PDF→Word sub-stage is now isolated: PDF.js native text extraction runs in `public/workers/pdf-word-extract-worker.js` through the shared WorkerPool.

- The app transfers the input ArrayBuffer to the shared extraction worker.
- PDF.js parsing and `getTextContent()` page extraction occur off the main UI thread.
- WorkerPool cancellation is propagated through the existing CancelToken.
- The existing paragraph reconstruction and DOCX builder semantics are preserved.
- DOCX packaging continues through the shared WorkerPool.
- OCR fallback remains a separate browser-dependent stage because it currently uses Tesseract plus canvas rendering; it is not falsely marked as worker-safe yet.

Verification: `scripts/phase5-pdf-to-word-extract-check.js` — 13/13 checks passed.


## Unit 17 — PDF to Word OCR rasterisation

Unit 17 isolates the browser canvas portion of the OCR fallback without falsely claiming that the complete OCR engine is worker-safe.

Implementation:
1. Added `public/workers/pdf-word-render-worker.js` as an isolated PDF.js + OffscreenCanvas rasteriser.
2. OCR page rendering now runs through the shared WorkerPool, with the PDF ArrayBuffer transferred to the render worker.
3. Rendered PNG bytes are transferred back to the page and supplied to the existing Tesseract.js recogniser as a Blob.
4. Existing multilingual language selection, OCR text normalisation, RTL-aware DOCX packaging, and OCR page semantics are preserved.
5. Shared CancelToken propagation is retained for every render task.
6. Main-thread `document.createElement('canvas')`, PDF.js page rendering, and `toDataURL()` were removed from the OCR loop.
7. Tesseract.js itself remains page-context and is deliberately not advertised as worker-safe until its nested-worker/runtime contract is independently audited.
8. No artificial file-size, page-count, or processing-time rejection limit is introduced.

This is a **sub-migration**. PDF→Word is not yet declared fully worker-safe because OCR recognition and other high-fidelity browser-dependent stages still require independent validation.

Verification: `scripts/phase5-pdf-to-word-ocr-render-check.js`.


## Unit 18 — PDF to Word Tesseract OCR isolation

Unit 18 moves Tesseract recognition behind a dedicated WorkerPool boundary. The page no longer owns a Tesseract.js worker directly. The isolated OCR worker dynamically loads Tesseract.js v5 and creates the nested Tesseract browser worker with explicit worker/language paths. This preserves the documented Tesseract.js architecture while allowing the shared WorkerPool to own the outer job boundary and cancellation.

The raster image produced by Unit 17 is transferred into the OCR worker. OCR text is transferred back as plain text. Existing language detection, OCR page conversion, RTL/multilingual handling, and DOCX packaging remain unchanged.

This remains a sub-migration until browser compatibility is exercised across supported devices; no claim of full PDF→Word worker migration is made yet.

Verification: scripts/phase5-pdf-to-word-ocr-check.js.


## Unit 19 — PDF to Word OCR native-prepass removal

Unit 19 removes the remaining page-context PDF.js native-text prepass from the OCR fallback. Phase 1 already extracts native PDF text and returns the authoritative page count through `_extractWithSharedWorker()`; reopening the same PDF in `_runOcr()` was duplicate work and could undermine the worker-isolation boundary.

The OCR stage now consumes `totalPages` from the shared extraction result and proceeds directly to the existing WorkerPool render → WorkerPool Tesseract recognition path when the Phase 1 quality check decides OCR is required. The previous native prepass could also return native text during a forced-OCR request, so removing it keeps the `_forceOcr` contract consistent.

Obsolete page-side PDF.js/Tesseract loader state was removed from `pdf-word-app.js`. No artificial timeout or file/page limit was introduced.

Verification: `scripts/phase5-pdf-to-word-ocr-check.js`.


## Unit 20 — PDF to Word text structuring isolation

Unit 20 moves the PDF.js content-item → paragraph/line structure stage into the existing PDF extraction worker. The page no longer performs the font-height analysis, line bucketing, heading/list/form/signature detection, paragraph merging, or duplicate filtering for native PDF text.

The extraction worker now returns structured paragraphs directly. The existing formatting semantics are preserved, including RTL/multilingual text handling, heading levels, list detection, signature/form markers, bold/italic detection, visual x-position data, and page width metadata.

This avoids sending raw PDF.js item arrays back to the page only to immediately process them again, reducing main-thread CPU work and duplicate structured-clone traffic.

OCR rendering/recognition and DOCX packaging remain on WorkerPool. No artificial file-size/page-count/processing-time limit is introduced.

Verification: `scripts/phase5-pdf-to-word-structure-check.js`.


## Unit 21 — PDF to Word OCR text structuring isolation

Unit 21 removes the remaining OCR text-to-paragraph CPU stage from the page context. After Tesseract recognition, `public/workers/pdf-word-ocr-worker.js` now normalises OCR symbols and builds the same heading/list paragraph contract before returning the result through WorkerPool.

Implementation:
1. OCR recognition and OCR text structuring now share the isolated WorkerPool boundary.
2. The worker returns both raw OCR text and structured paragraphs for compatibility and quality checks.
3. `pdf-word-app.js` validates the structured paragraph payload and consumes it directly.
4. The page-side `_ocrToPages()` function and OCR line splitting/heading/list parsing were removed.
5. Multilingual/RTL text is kept as returned text; existing DOCX packaging remains unchanged.
6. Tesseract nested-worker lifecycle and the outer WorkerPool cancellation boundary remain intact.
7. No artificial file-size, page-count, or processing-time rejection limit is introduced.

This is another **sub-migration**; PDF→Word is still not declared fully worker-safe because remaining fidelity/document-preparation stages must be audited independently.

Verification: `scripts/phase5-pdf-to-word-ocr-structure-check.js`.


## Unit 22 — PDF to Word quality analysis isolation

Unit 22 moves remaining conversion-quality bookkeeping out of the PDF→Word page context. The extraction worker now computes native-text character metrics and returns `analysis.avgCharsPerPage`; the page uses that worker result to decide whether OCR is required. The OCR worker returns its character count directly, avoiding a second page-side reduction over OCR text. The DOCX worker now returns final character/paragraph/page statistics with the generated buffer, so final quality metadata no longer requires page-side traversal of the document structure.

No conversion semantics or OCR threshold were changed. No artificial file-size/page-count/processing-time limit was introduced. This remains a sub-migration and does not yet constitute a full PDF→Word worker-migration claim.

Verification: `scripts/phase5-pdf-to-word-quality-check.js`.

## Unit 23 — PDF to Word conversion decision isolation

Unit 23 moves the OCR-fallback decision boundary into the extraction worker. The worker now receives the explicit force-OCR option, evaluates the existing native-text threshold (`avgCharsPerPage < 8`) and returns `needsOcr` plus a descriptive decision reason. The page consumes that decision rather than recomputing the threshold. The OCR worker also returns its existing readability threshold (`charCount >= 10`) as `readable`, so the page no longer calculates that threshold itself.

The documented thresholds and forced-OCR behavior are preserved; this change relocates decision analysis rather than changing conversion policy. WorkerPool and cancellation paths remain unchanged, and no artificial file-size/page-count/processing-time limit was added.

Verification: `scripts/phase5-pdf-to-word-decision-check.js`.

## Unit 24 — WorkerPool priority validation audit

The Phase 24 WorkerPool introduced four queue tiers (`high`, `normal`, `low`, `background`) and priority validation. Audit found `run()` referenced an undefined `pool_proto_queues` symbol, which could throw before a task was dispatched whenever WorkerPool was called. The validation now checks the authoritative `TIER_ORDER` array and falls back unknown priorities to `normal`.

No queue-size, task-count, or execution-time policy was changed. Cancellation, starvation prevention, adaptive worker caps, idle cleanup, and zero artificial execution timeout remain intact.

Verification: `scripts/phase5-worker-pool-check.js`.

## Unit 25 — Worker cancellation isolation

Audit found that cancelling an active WorkerPool task previously settled its Promise but left the same Worker alive. The slot could then be reused for another queued task while the cancelled worker computation continued. Unit 25 retires the active worker on cancellation, spawns a replacement, and only then settles the cancelled task so the slot cannot overlap cancelled work with a new job.

Verification: `scripts/phase5-worker-cancel-check.js`.