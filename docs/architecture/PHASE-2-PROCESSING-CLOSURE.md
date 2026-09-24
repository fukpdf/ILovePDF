# Phase 2 Processing Closure Matrix

## Worker-authoritative processing

| Tool | Runtime path | Boundary |
|---|---|---|
| JPG/PNG → PDF | image-pdf-worker | transferable ArrayBuffers |
| PDF → JPG | pdf-image-worker | PDF.js + OffscreenCanvas |
| Excel → PDF | spreadsheet-pdf-worker | transferable ArrayBuffer |
| Word → Excel | word-excel-worker | transferable DOCX buffer |
| PowerPoint → PDF | powerpoint-pdf-worker | transferable PPTX buffer |
| PDF → Excel native extraction | pdf-text-extract-worker | transferable PDF buffer |
| PDF → Word native extraction | pdf-content-extract-worker | transferable PDF buffer |
| PDF → PowerPoint native extraction | pdf-content-extract-worker | transferable PDF buffer |
| PDF OCR | ocr-pdf-worker | PDF rendering + Tesseract |
| Scan → PDF image encoding | scan-pdf-worker | transferable image buffers |
| Crop image | image-tools-worker | transferable image buffer |
| Resize image | image-tools-worker | transferable image buffer |
| Image filters | image-tools-worker | transferable image buffer |
| Background remover CV | remove-bg-worker | transferable RGBA buffer |

## Intentional main-thread boundaries

- DOCX → PDF stays main-thread because Mammoth + DOM + html2pdf HTML/CSS layout is part of the rendering contract.
- HTML → PDF stays main-thread because DOM/layout APIs are part of the rendering contract.
- PDF office output assembly remains tool-specific after shared PDF.js extraction to preserve existing output contracts.
- OCR DOCX/searchable-PDF assembly remains main-thread after recognition data is produced in the Worker.
- Background-remover AI integration remains behind its existing app contract; the CV fallback is already isolated in a dedicated Worker.
- AI summary, translation, and workflow remain separate application pipelines.

## Cleanup

- Migrated jobs use transferable buffers where possible.
- New image/document workers terminate after completion/error.
- Browser adapters have hard timeouts.
- Stale allowlist entries for missing ocr-worker.js, pdf-xlsx-worker.js, and pdf-pptx-worker.js were removed.
- Protect, Sign, and Redact remain quarantined until standards-compliant implementations exist.

## Validation boundary

This is an architecture closure matrix, not fixture/E2E certification. Browser fixture tests, malformed/edge-case tests, output-openability checks, and visual/semantic comparisons remain required before production fidelity is claimed.
