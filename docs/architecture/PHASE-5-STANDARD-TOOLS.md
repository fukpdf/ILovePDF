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
