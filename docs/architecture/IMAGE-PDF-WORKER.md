# Image-to-PDF worker boundary

Phase 2 browser-first migration.

- JPEG/PNG bytes are read as ArrayBuffers and transferred to `image-pdf-worker.js`.
- PDF assembly runs in a dedicated worker using pdf-lib.
- The worker is explicitly allowlisted by `RuntimeWorkerFactory`.
- The worker is terminated after completion/error and application references to the input list are released.
- This boundary does not claim EXIF normalization, arbitrary image formats, or PDF-to-image rendering; those remain separate capabilities until independently fixture-tested.
- This does not claim cryptographic erasure of browser memory.
