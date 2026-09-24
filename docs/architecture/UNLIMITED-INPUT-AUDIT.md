# Unlimited Input Admission Audit — Phase 2

Status: audited at commit 88b7e0ccb08eee9e9ab254645ab100c0840e9d4e.

## Policy

Client document tools do not enforce a product file-size or page-count ceiling. Large inputs may take longer and may trigger lower concurrency, chunking, streaming, safe-mode pacing, or emergency runtime recovery.

## Audited runtime classes

The active browser processing runtimes and workers were checked for the previously identified admission patterns:

- size-based `wouldExceedLimit(...)` rejection
- fixed MAX/max page-count admission
- fixed object-count admission
- explicit file-too-large/product size rejection
- byte-length based product admission

No new product admission gate was found in the audited remaining runtime set.

## Intentional non-admission thresholds

The following patterns are intentionally retained because they select a safer execution strategy rather than reject the input:

- `pdf-worker-runtime-factory.js`: 10 MB threshold selects stream-native dispatch; smaller files use the normal path.
- `runtime-stream-bridge.js` / `runtime-streaming-hooks.js`: size thresholds select chunking/streaming paths.
- `runtime-streaming-hooks.js`: page batches are used for page-wise scheduling; the <=5 check only selects the direct path.
- `merge-runtime.js`: safe-mode thresholds change pacing/concurrency; they are not input rejection.
- `scan-pdf-worker.js`: adaptive image scaling is a resource/quality safeguard, not a file/page admission check.
- `powerpoint-pdf-worker.js`: ZIP uncompressed-expansion protection is retained as a security boundary against archive bombs.
- parser read windows and runtime emergency heap checks remain integrity/safety controls, not product quotas.

## Regression rule

A future size/page limit must not be introduced as a normal product admission check. If a bound is required for parser correctness or security, it must be documented as such and must not be presented to users as a normal file-size/page-count quota.

This audit intentionally does not remove parser/security limits merely because they contain numeric bounds.
