# PDF-to-image worker boundary

Phase 2 browser-first migration for PDF -> JPG.

- PDF.js rendering runs inside `pdf-image-worker.js`.
- Rendering uses `OffscreenCanvas`; no DOM canvas is accessed by the worker.
- JPEG encoding and page buffers remain browser-side.
- The main thread is limited to orchestration and ZIP packaging for multi-page output.
- The worker is explicitly allowlisted by `RuntimeWorkerFactory` and terminated after completion/error.
- Quality presets currently map to bounded render scales; fixture validation is still required before treating output fidelity as production-certified.
- The legacy DOM/PDF.js implementation remains in source temporarily for migration comparison and must be removed only after fixture/browser verification.
- Browsers without OffscreenCanvas are not silently routed to a server processor; the worker reports an explicit capability error.
