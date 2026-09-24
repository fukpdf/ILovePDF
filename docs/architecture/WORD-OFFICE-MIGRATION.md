# Word office conversion boundary

## DOCX -> XLSX

DOCX -> XLSX now runs in `word-excel-worker.js`.

- DOCX bytes are transferred into the worker.
- Mammoth conversion runs off the main thread.
- HTML table/content extraction uses worker-safe parsing; no DOMParser is required.
- XLSX packaging is performed in the same isolated worker and returned as a transferable `ArrayBuffer`.
- Only `.docx` is accepted; legacy `.doc` remains intentionally unsupported in the browser path.

## DOCX -> PDF

DOCX -> PDF remains main-thread for now. The current implementation relies on Mammoth HTML plus `html2pdf.js`/HTML canvas and therefore depends on DOM/layout rendering. Moving it to a generic Worker would change rendering semantics rather than simply improve performance. A future migration should use a dedicated headless/standards-compliant document renderer and fixture comparison before replacing the current path.
