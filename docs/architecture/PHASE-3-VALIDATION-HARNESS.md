# Phase 3 — Client Processing Validation Harness

## Scope

This harness establishes an automated validation gate for browser-side document processing without claiming browser E2E or visual-fidelity certification.

It covers:

- malformed/non-Blob input validation;
- empty and oversized input lifecycle contracts;
- truncated/empty PDF parser rejection;
- output PDF reopenability;
- a deterministic rotation invariant;
- worker timeout and termination behavior;
- transferable ArrayBuffer contract checks;
- client-only/server-fallback enforcement;
- same-origin worker path enforcement;
- bounded chunking behavior;
- migrated-worker file/protocol invariant checks;
- stale-worker detection for removed worker paths.

## Run

`npm run test:client-processing`

The harness exits non-zero on any failed assertion.

## Validation boundary

The harness is intentionally split into:

1. **Executable engine/kernel checks** — run against Node's Blob/VM environment and the installed `pdf-lib` dependency.
2. **Worker contract checks** — inspect worker source for required operation/protocol markers and stale paths.

It does **not** certify:

- browser rendering fidelity;
- OffscreenCanvas behavior on every browser;
- OCR accuracy;
- PowerPoint/Word visual parity;
- EXIF parity for every image format;
- real browser WorkerFactory integration;
- production CDN availability;
- 10M-consumer load behavior.

Those require browser fixture/E2E and/or load testing in later validation work.

## Per-tool invariant philosophy

Worker migration is accepted only when the tool has a deterministic invariant that can be checked. Examples include:

- PDF output must reopen;
- page count must remain valid for non-page-creating transforms;
- rotation metadata must persist after save/reopen;
- transferred inputs/outputs must use explicit transferable lists;
- stale worker registrations must not remain.

A passing harness is therefore a **contract gate**, not a claim of universal correctness.
