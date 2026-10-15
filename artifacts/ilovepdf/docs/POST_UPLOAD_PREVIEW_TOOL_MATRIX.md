# Shared Post-Upload Preview — Tool Inventory & Validation Contract

The shared selected-file preview is the only generic file-preview renderer for upload-enabled tools. Legacy per-tool rich preview renderers have been removed from `public/js/live-preview.js`; tool processing modules and functional editors remain separate.

## Coverage inventory

The authoritative shared-shell inventory is `public/js/tools-config.js`. Every entry declaring `acceptedFiles` must also be listed in `UPLOAD_TOOL_IDS` in `public/js/live-preview.js`. The regression script fails if the lists drift.

| Tool | ID | Selected-file preview | Preserved tool-specific UI |
|---|---|---|---|
| Merge PDF | `merge` | Shared file cards and PDF thumbnails; multi-file remove actions | Existing merge processing and file selection state |
| Split PDF | `split` | Shared file card and PDF thumbnail | Existing split options; PageOrganizer when applicable |
| Rotate PDF | `rotate` | Shared file card and PDF thumbnail | Existing Rotate editor, page rotation controls, PageOrganizer |
| Crop PDF | `crop` | Shared file card and PDF thumbnail | Existing crop options and PageOrganizer when applicable |
| Organize PDF | `organize` | Shared file card and PDF thumbnail | Existing PageOrganizer |
| Compress PDF | `compress` | Shared file card and PDF thumbnail | Existing compression mode and target-size options |
| PDF to Word | `pdf-to-word` | Shared file card and PDF thumbnail | Existing processing flow |
| PDF to PowerPoint | `pdf-to-powerpoint` | Shared file card and PDF thumbnail | Existing processing flow |
| PDF to Excel | `pdf-to-excel` | Shared file card and PDF thumbnail | Existing processing flow |
| PDF to JPG | `pdf-to-jpg` | Shared file card and PDF thumbnail | Existing processing flow |
| Word to PDF | `word-to-pdf` | Shared file card | Existing processing flow |
| PowerPoint to PDF | `powerpoint-to-pdf` | Shared file card | Existing processing flow |
| Excel to PDF | `excel-to-pdf` | Shared file card | Existing processing flow |
| Word to Excel | `word-to-excel` | Shared file card | Existing processing flow |
| JPG to PDF | `jpg-to-pdf` | Shared image thumbnail cards and multi-file remove actions | Existing processing flow |
| HTML to PDF | `html-to-pdf` | Shared file card | Existing processing flow |
| Edit PDF | `edit` | Shared file card and PDF thumbnail | Existing PRO editor / editing controls |
| Watermark PDF | `watermark` | Shared file card and PDF thumbnail | Existing watermark options and PageOrganizer when applicable |
| Sign PDF | `sign` | Shared file card and PDF thumbnail | Existing signing options and PageOrganizer when applicable |
| Add Page Numbers | `page-numbers` | Shared file card and PDF thumbnail | Existing page-number options and PageOrganizer when applicable |
| Redact PDF | `redact` | Shared file card and PDF thumbnail | Existing redaction options and PageOrganizer when applicable |
| Protect PDF | `protect` | Shared file card and PDF thumbnail | Existing protection options |
| Unlock PDF | `unlock` | Shared file card and PDF thumbnail | Existing unlock options |
| Repair PDF | `repair` | Shared file card and PDF thumbnail | Existing repair flow and PageOrganizer when applicable |
| Scan to PDF | `scan-to-pdf` | Shared image thumbnail cards and multi-file remove actions | Existing scan-to-PDF processing flow |
| OCR | `ocr` | Shared file card and PDF thumbnail | Existing OCR options and PageOrganizer when applicable |
| Compare PDF | `compare` | Shared multi-file cards and PDF thumbnails; remove actions | Existing comparison processing flow |
| AI Summarizer | `ai-summarize` | Shared file card and PDF thumbnail | Existing summarization options |
| Translate PDF | `translate` | Shared file card and PDF thumbnail | Existing translation options |
| Workflow Builder | `workflow` | Shared file card and PDF thumbnail | Existing workflow options |
| Background Remover | `background-remover` | Shared image thumbnail | Existing PRO editor when available |
| Crop Image | `crop-image` | Shared image thumbnail | Existing crop options |
| Resize Image | `resize-image` | Shared image thumbnail | Existing resize options |
| Image Filters | `image-filters` | Shared image thumbnail | Existing filter options |

**Shared-shell upload-enabled tools: 34.** Tools without file-upload input are intentionally excluded.

## Standalone upload routes

These routes are outside the shared `tool.html` workflow and retain their specialized processing/result flows while using the same preview-card visual system:

- `/image-compressor.html` — selected-image card before compression; original/compressed comparison remains a post-processing result.
- `/image-converter.html` — image thumbnail queue, conversion settings, and object-URL cleanup.
- `/zip-builder.html` — file-card/type-badge list and existing ZIP creation workflow.

## Preview and lifecycle rules

- `LivePreview.mount()` uses one shared renderer for every ID in `UPLOAD_TOOL_IDS`; no per-tool rich preview dispatcher remains.
- Image thumbnails use object URLs and revoke them when the preview is replaced or an item is removed.
- PDF first-page thumbnails are attempted only when the existing `PdfPreview` API is already available; a failed thumbnail leaves the metadata card usable. The selected-file card itself does not eagerly download PDF.js.
- Multi-file remove actions route through the existing `window.removeFile(index)` flow so the selected-file state remains authoritative.
- PageOrganizer, Rotate controls, and PRO editors are functional editing surfaces, not alternate generic file-preview renderers. They mount separately so they cannot overwrite the shared file-preview host.
- Compression settings remain wired, but the obsolete dedicated compression thumbnail renderer and its host were removed.
- The shared site header remains active on tool workspaces; the marketing footer and its stylesheet are intentionally omitted from upload/preview tool routes. Homepage and other public content pages retain their footer.
- The preview panel is sticky beneath the fixed shared header. The selected-document list is the only independently scrollable region inside that panel; filenames wrap and cards shrink to avoid viewport overflow.
- Upload/dropzone behavior, processing engines, result/download behavior, homepage branding, and logos remain outside this preview cleanup.

## Validation

Run from `artifacts/ilovepdf`:

```sh
npm run test:shared-preview
node --check public/js/live-preview.js
node --check public/js/tool-page.js
node --check scripts/shared-post-upload-preview-regression-check.js
```

The source regression checks validate inventory parity, old-renderer removal, shared host wiring, sticky panel/document-list scrolling, footer-free tool workspaces, shared-header cache version parity, and standalone route contracts. It is not a substitute for browser testing. Browser tests for Merge, all other upload-enabled tools, corrupt/large files, file removal during rendering, and mobile/tablet/desktop layout are still required before calling the work fully validated.
