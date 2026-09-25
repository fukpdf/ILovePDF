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
