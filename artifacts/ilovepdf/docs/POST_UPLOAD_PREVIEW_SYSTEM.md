# Shared Post-Upload Preview — Implementation & Validation Plan

## Scope

Repository: `fukpdf/ILovePDF`  
Application root: `artifacts/ilovepdf/`  
Working branch: `feat/post-upload-preview-controlled`

Use one shared selected-file preview for all 34 upload-enabled shared-shell tools. Remove the previous per-tool preview renderer implementations and references from the shared preview module, while preserving actual processing engines and functional editing controls.

Out of scope: upload/dropzone behavior, processing engine implementation, result/download pages, homepage, header/footer, logos, unrelated performance code, and deployment.

## Architecture contract

- `public/js/live-preview.js` contains only the shared selected-file preview and its small helpers.
- `LivePreview.supported(toolId)` is derived from the authoritative upload-tool ID inventory and returns true for every tool declaring `acceptedFiles`.
- Shared preview cards display file name, type, size, ready state, and image thumbnails where appropriate. PDFs use a first-page thumbnail only if the existing `PdfPreview` API is already available; the card must remain usable if thumbnail rendering fails.
- Object URLs must be revoked when previews are replaced or files removed.
- Multi-file removal must call the existing selected-file state handler rather than maintain a second file list.
- Merge must not call a separate `mountMergePreview` implementation.
- Compression must not use a separate `renderCompressPreview` implementation or `compress-preview-host`.
- PageOrganizer, Rotate controls, and PRO editors are functional editing surfaces. They must mount separately from the shared file-preview host and must not overwrite it.
- Processing remains behind the existing explicit Process action. Keep the current processing and download/result workflows intact.
- Standalone Image Compressor, Image Converter, and ZIP Builder retain their specialized processing/result experiences but use the shared preview-card visual language for selected files.

## Required source checks

1. Inventory parity: every tool with `acceptedFiles` is registered once; no non-upload tool is registered.
2. Old renderer removal: legacy per-tool preview functions and the old compression preview function/host must not remain referenced.
3. Shared-host wiring: standard tools, Rotate, and PRO editor tools all mount the shared selected-file preview.
4. Editing controls: PageOrganizer, Rotate, compression options, and PRO editors remain wired separately.
5. Lifecycle: object URLs are cleaned up; PDF thumbnail failure does not remove the metadata card; stale async completion must not replace a detached preview.
6. Responsive styles apply to shared previews in the standard, Rotate, and PRO editor layouts.
7. Inline JavaScript and changed source files parse successfully.

## Runtime validation still required

Run `npm run test:shared-preview` and syntax checks from `artifacts/ilovepdf`. Then use browser tests on desktop, tablet, and mobile to check Merge, single-file PDF, image, office-document, multi-file, PageOrganizer, Rotate, Compress, and PRO-editor paths. Test valid/corrupt/large files, removing/replacing files while thumbnails are rendering, repeated file selection, clear/restart, processing, and download/result navigation.

Do not claim full completion based only on static checks. If browser tests or CI cannot run in the current environment, record that limitation. Keep changes on the feature branch and do not merge or deploy automatically.
