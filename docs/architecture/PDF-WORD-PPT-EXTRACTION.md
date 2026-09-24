# PDF -> Word / PowerPoint extraction boundary

Native PDF.js content extraction now runs in the dedicated `pdf-content-extract-worker.js` for both PDF -> Word and PDF -> PowerPoint.

## Why the worker stops at content extraction

Word and PowerPoint reconstruct layout differently:
- Word uses paragraph grouping, heading detection, list/form/signature heuristics and typography metadata.
- PowerPoint uses title/body extraction and slide-oriented content rules.

Keeping those reconstruction stages in their tool-specific modules avoids a false shared abstraction that could reduce fidelity.

The worker emits one page at a time and the PDF input is transferred as an `ArrayBuffer`. The main thread no longer owns the PDF.js parsing loop for these native-text paths.

OCR remains a separate fallback because the current Tesseract path uses DOM canvas rendering and language-specific runtime behavior. It should only be migrated after fixture coverage proves equivalent results.
