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


## Unit 6 — Organize PDF

Branch: `phase-5-unit-6-organize-reference`

### Audit findings

Before this unit:
- Organize was exposed through the browser-side `BrowserTools.organize` handler.
- The handler used pdf-lib directly on the main thread.
- The shared PDF worker already exposed `OPS.organize`, so the processing operation existed but was not connected to the standard worker execution path.
- The authoritative registries declared Organize as `browser` with no WorkerPool or adaptive-streaming capability.
- PageOrganizer remains responsible for the interactive page preview/reorder/rotate/delete UI and produces the edited PDF that is handed to processing.

### Unit 6 implementation

Organize now:
1. keeps the existing PageOrganizer UI and edited-PDF semantics;
2. routes processing through the shared persistent `pdf-worker.js` operation;
3. uses the shared WorkerPool for normal jobs;
4. uses the existing RuntimeStreamBridge adaptive path for large single-file jobs;
5. remains browser-only with no server/upload fallback;
6. declares `browser-worker`, `workerPool=true`, `streaming=adaptive-worker`, and `fileSizePolicy=unlimited` in both registry copies;
7. keeps shared input/output validation at the platform boundary;
8. does not add a file-size, page-count, or fixed processing-time rejection limit.

### Verification

`scripts/phase5-organize-check.js` verifies the Organize registry contract, canonical/published registry parity, BrowserTools worker capability, shared PDF worker operation, adaptive streaming infrastructure, unlimited processing policy, shared validation boundaries, and PageOrganizer integration.
