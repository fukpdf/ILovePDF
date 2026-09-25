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


## Unit 3 — Compress PDF migration

Branch: `phase-5-unit-3-compress-reference`

Compress is the third standard-tool migration target.

### Audit findings

Before this unit:
- Compress spawned a dedicated `compress-worker.js` per job.
- Compress had fixed 75-second worker and 90-second hard processing timers.
- Compress also contained a main-thread pdf-lib CDN fallback and an original-file fallback.
- The canonical registry already declared browser-worker execution, adaptive-worker streaming, WorkerPool capability, and unlimited file-size policy.
- The shared PDF worker already exposes `OPS.compress`, including the existing “return the smaller representation” behavior.

### Unit 3 implementation

Compress now:
1. remains tool-owned through `CompressPdfApp`;
2. uses the shared `WorkerPool` for normal jobs;
3. uses `RuntimeStreamBridge.pipelineStreamToWorker` for large single-file jobs;
4. uses a cancellation token for lifecycle cleanup;
5. uses the existing shared PDF worker Compress operation;
6. removes the dedicated spawn-per-job worker;
7. removes fixed processing-time rejection timers;
8. removes the main-thread/CDN fallback so processing stays inside the browser worker architecture;
9. keeps unlimited file-size/page policy;
10. preserves the output contract and already-optimized indication.

The Phase 5 audit gate now checks the Compress migration contract in addition to Crop and Rotate.
