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


## Phase 3 current execution status — 2026-09-24

The repository currently has 36 configured tool IDs in `public/js/tools-config.js`. They are not all expected to use a Web Worker: some intentionally remain main-thread because DOM/layout APIs are part of their rendering contract, while AI/utility tools have separate pipelines.

### Active processing paths

- PDF structural worker: merge, split, rotate, organize, crop, compress, page-numbers, watermark, repair, workflow, edit, compare.
- Image/document workers: JPG/PNG→PDF, PDF→JPG, Excel→PDF, Word→Excel, PowerPoint→PDF, PDF native extraction→Word/Excel/PowerPoint, OCR, Scan→PDF image encoding, crop/resize/filter image processing, CV background-removal.
- Intentional main-thread paths: DOCX→PDF, HTML→PDF, post-extraction office document assembly, OCR-derived DOCX/searchable-PDF assembly, AI background-removal integration.
- Separate application pipelines: AI summarize and translate. Laba AI is not part of this document-processing registry.

### Security-sensitive tools deliberately not active

Protect, Sign, Redact, and Unlock are not promoted as production security processors. The current PDF worker contains legacy implementations, but they are not authoritative:
- Protect is not PDF encryption.
- Sign is not cryptographic digital signing.
- Redact is visual covering, not irreversible content removal.
- Unlock does not provide a standards-compliant password/encryption engine.

Their tool definitions are now marked unavailable rather than advertising non-compliant behavior.

### Important distinction

Therefore: **all currently active processing tools have an identified execution path; not every configured tool has a dedicated Worker engine, and four security-sensitive tools are intentionally quarantined pending proper engines.** This is deliberate, not an unfinished hidden migration.

