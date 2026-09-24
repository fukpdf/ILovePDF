# Phase 3 — Worker Cancellation & Deterministic Cleanup

## Scope

This unit hardens the browser-only processing lifecycle for cancellation, timeout, worker failure, and transferred input buffers.

## Implemented

- `ClientProcessingKernel` v1.3.0 accepts an `AbortSignal` and `cancelToken`/`token`.
- Cancellation before dispatch, during input acquisition, and during worker execution rejects with `processing_cancelled`.
- Processing workers are always terminated on resolve, reject, timeout, abort, or postMessage failure.
- Input `ArrayBuffer` values are registered with `ClientFileLifecycle` before transfer and released on cleanup.
- Output validation remains enforced when requested.
- `WorkerPool` v5.1 removes queued cancelled tasks immediately.
- Running pool-task cancellation terminates the current worker before the slot can be reused, preventing late messages from an abandoned task from reaching the next task.
- Pool cancellation callbacks are unsubscribed after settlement.
- Worker error, message-error, task-timeout, and heartbeat-timeout paths use the same safe terminate-before-reuse boundary.

## Safety boundary

A transferred `ArrayBuffer` becomes detached in the sending realm; lifecycle tracking records the buffer reference for deterministic bookkeeping and removes that reference during cleanup. JavaScript/WASM memory cannot be promised to be cryptographically erased.

## Validation

`scripts/client-processing-validation.js` now checks cancellation, callback cleanup, worker termination, and buffer lifecycle contracts in addition to the existing malformed-input/output/invariant checks.

This is a deterministic source/contract and PDF-engine harness. Browser E2E, real-device memory profiling, and visual-fidelity certification remain separate validation work and are not claimed by this document.

## Processing policy

- No hard file-size or page-count limit is imposed by the shared client processing kernel or WorkerPool.
- Device capability is used for pacing/concurrency rather than rejecting large files.
- `public/js/processing-experience.js` provides rotating friendly processing copy with slower cadence on low-capability devices.
- The processing experience must remain informational and non-blocking; actual progress/state remains authoritative.
- Cartoon/illustration presentation is a UI layer and should be added per tool without coupling it to processing engines.
