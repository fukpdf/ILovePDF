# Shared Post-Upload Preview — Tool Inventory & Validation Contract

This work standardizes the **post-upload Preview step** across the shared `tool.html` workflow. It does not replace upload/dropzone UI, the processing engines, result/download pages, homepage, shared shell, or tool-specific editing controls.

## Coverage inventory

The authoritative shared-shell inventory is `public/js/tools-config.js`. Every entry declaring `acceptedFiles` must also be listed in `UPLOAD_TOOL_IDS` in `public/js/live-preview.js`. The regression script fails if the lists drift.

| Tool | Accepted files | Multi-file | Preview path |
|---|---|---:|---|
| Merge PDF (`merge`) | `.pdf` | Yes | Rich merge preview; reorder/remove controls |
| Split PDF (`split`) | `.pdf` | No | PageOrganizer for a valid single PDF; shared fallback otherwise |
| Rotate PDF (`rotate`) | `.pdf` | No | Dedicated Rotate editor and page controls |
| Crop PDF (`crop`) | `.pdf` | No | PageOrganizer for a valid single PDF; shared fallback otherwise |
| Organize PDF (`organize`) | `.pdf` | No | PageOrganizer for a valid single PDF; shared fallback otherwise |
| Compress PDF (`compress`) | `.pdf` | No | Dedicated compression preview; existing mode/size options preserved |
| PDF to Word (`pdf-to-word`) | `.pdf` | No | Dedicated rich preview |
| PDF to PowerPoint (`pdf-to-powerpoint`) | `.pdf` | No | Dedicated rich preview |
| PDF to Excel (`pdf-to-excel`) | `.pdf` | No | Dedicated rich preview |
| PDF to JPG (`pdf-to-jpg`) | `.pdf` | No | Shared preview fallback with PDF first-page thumbnail |
| Word to PDF (`word-to-pdf`) | `.doc,.docx` | No | Dedicated rich preview |
| PowerPoint to PDF (`powerpoint-to-pdf`) | `.ppt,.pptx` | No | Dedicated rich preview |
| Excel to PDF (`excel-to-pdf`) | `.xls,.xlsx` | No | Dedicated rich preview |
| Word to Excel (`word-to-excel`) | `.docx` | No | Dedicated rich preview |
| JPG to PDF (`jpg-to-pdf`) | `.jpg,.jpeg,.png` | Yes | Shared preview fallback with image thumbnails and remove controls |
| HTML to PDF (`html-to-pdf`) | `.html,.htm` | No | Dedicated rich preview |
| Edit PDF (`edit`) | `.pdf` | No | Existing PRO editor or PageOrganizer/editor fallback |
| Watermark PDF (`watermark`) | `.pdf` | No | PageOrganizer for a valid single PDF; existing options preserved |
| Sign PDF (`sign`) | `.pdf` | No | PageOrganizer for a valid single PDF; existing options preserved |
| Add Page Numbers (`page-numbers`) | `.pdf` | No | PageOrganizer for a valid single PDF; existing options preserved |
| Redact PDF (`redact`) | `.pdf` | No | PageOrganizer for a valid single PDF; existing options preserved |
| Protect PDF (`protect`) | `.pdf` | No | Shared preview fallback with PDF first-page thumbnail |
| Unlock PDF (`unlock`) | `.pdf` | No | Shared preview fallback with PDF first-page thumbnail |
| Repair PDF (`repair`) | `.pdf` | No | PageOrganizer for a valid single PDF; shared fallback if unavailable |
| Scan to PDF (`scan-to-pdf`) | `.jpg,.jpeg,.png` | Yes | Dedicated rich preview |
| OCR (`ocr`) | `.pdf` | No | PageOrganizer for a valid single PDF; rich preview fallback otherwise |
| Compare PDF (`compare`) | `.pdf` | Yes | Shared multi-file preview with PDF thumbnails and remove controls |
| AI Summarizer (`ai-summarize`) | `.pdf` | No | PageOrganizer for a valid single PDF; rich preview fallback otherwise |
| Translate PDF (`translate`) | `.pdf` | No | PageOrganizer for a valid single PDF; rich preview fallback otherwise |
| Workflow Builder (`workflow`) | `.pdf` | No | Shared preview fallback with PDF first-page thumbnail |
| Background Remover (`background-remover`) | `.jpg,.jpeg,.png,.webp` | No | Existing PRO editor or dedicated rich preview |
| Crop Image (`crop-image`) | `.jpg,.jpeg,.png,.webp` | No | Shared preview fallback with image thumbnail |
| Resize Image (`resize-image`) | `.jpg,.jpeg,.png,.webp` | No | Shared preview fallback with image thumbnail |
| Image Filters (`image-filters`) | `.jpg,.jpeg,.png,.webp` | No | Shared preview fallback with image thumbnail |

**Shared-shell upload-enabled tools: 34.** Utilities without file-upload input are intentionally excluded.

## Standalone upload routes

These pages are outside the shared three-step `tool.html` workflow and keep their specialized preview/result behavior:

- `/image-compressor.html` — original/compressed image comparison.
- `/image-converter.html` — multi-image queue and conversion settings.
- `/zip-builder.html` — multi-file list and ZIP creation.

They use `special-upload-flow.js` for their shared dropzone/preparation behavior. They are not rewritten into the shared-shell preview because that would alter their separate processing and result workflows.

## Implementation and safety rules

- The shared fallback is used for upload-enabled tools without a dedicated rich renderer.
- PDF fallback cards attempt to render the first page through the existing `PdfPreview` API; a failed thumbnail leaves a usable file card.
- Image thumbnails use object URLs marked for cleanup. Remove actions clean up thumbnails and then re-render the current preview.
- Merge retains its multi-file ordering controls.
- PageOrganizer, Rotate, Compress, and PRO editor paths are retained where they own interactive editing controls; the legacy file list is not removed from those flows.
- The upload page, processing engine, and download/result page remain outside this change.

## Validation

Run from `artifacts/ilovepdf`:

```sh
npm run test:shared-preview
node --check public/js/live-preview.js
node --check public/js/tool-page.js
```

The source regression check validates inventory parity and preview wiring. It is not a substitute for browser tests. Runtime visual checks still need to exercise single/multi-file uploads, remove/clear, PageOrganizer, Merge reorder, image/PDF thumbnail failures, mobile widths, and Process-to-download regression.
