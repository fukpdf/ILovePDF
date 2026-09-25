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


## Unit 4 — Merge PDF migration

Branch: `phase-5-unit-4-merge-reference`

### Audit findings

Before this unit:
- Merge used a dedicated `pdf-lib-worker.js` spawned for every job.
- Merge imposed fixed 120-second and 105-second processing timers.
- Merge accumulated every source file into main-thread ArrayBuffers before dispatch.
- The shared `pdf-worker.js` already exposed `OPS.merge`, and the registry already declared Merge as `browser-worker` with adaptive streaming and unlimited file-size policy.

### Unit 4 implementation

Merge now:
1. remains tool-owned through `MergePdfApp`;
2. uses the shared `WorkerPool` for normal multi-file jobs;
3. uses `RuntimeStreamBridge.streamFilesToWorkerReadable` for large aggregate inputs, preserving bounded multi-file backpressure;
4. uses a `WorkerPool.CancelToken` and lifecycle cleanup for unmount/reset/recovery/destroy;
5. uses the existing shared `OPS.merge` operation in `pdf-worker.js`;
6. removes the dedicated worker and fixed processing timers from the Merge app;
7. keeps the registry's `browser-worker`, `workerPool=true`, `streaming=adaptive-worker`, and `fileSizePolicy=unlimited` contract;
8. preserves the existing Merge output filename contract.

### Verification

The new `scripts/phase5-merge-check.js` statically verifies the registry contract, canonical/published registry parity, shared WorkerPool execution, multi-file stream path, cancellation/lifecycle cleanup, absence of fixed processing timers and file-size guards, shared worker operation, and standard shell integration.

This unit does not claim production deployment or merge status. GitHub branch/PR status must be checked separately before release.
