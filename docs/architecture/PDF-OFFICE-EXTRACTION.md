# PDF -> Office extraction boundary

The native PDF text/table extraction phase for PDF -> Excel now runs in `pdf-text-extract-worker.js`.

- PDF.js text extraction is worker-side.
- Input PDF bytes are transferred as an `ArrayBuffer`.
- The worker reconstructs coordinate-based rows and returns structured sheet data.
- The main thread performs quality checks and only invokes the existing OCR fallback when native extraction is empty/garbled.
- OCR remains separate because the current Tesseract path depends on canvas and language-specific runtime behavior; it must be migrated independently with equivalent fixture coverage.
- The dedicated XLSX builder worker remains responsible for packaging structured sheets into XLSX.

This is intentionally an incremental migration: moving native extraction first avoids pretending that OCR and document-layout conversion are the same workload.
