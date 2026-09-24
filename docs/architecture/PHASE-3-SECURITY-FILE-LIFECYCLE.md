# Phase 3 — Security, Validation & File Lifecycle

Status: Units 1–3 implemented on `phase-3-security-file-lifecycle`

## Audit findings

The Phase 2/main baseline already has:
- CSP nonce generation and security headers in `server.js`.
- API rate limiting and origin validation.
- Client-side validation before upload for supported tools.
- Server-side multer MIME/size checks and per-file usage enforcement.
- Temporary filesystem uploads under the OS temp directory.
- R2 temporary objects under `tmp/` with a 10-minute sweeper.
- `utils/cleanup.js` deleting response artifacts after an 8-second delay.

The lifecycle gap was that cleanup behavior was distributed between upload/R2 helpers and direct filesystem deletion, with no shared runtime registry describing which temporary user artifacts are currently owned by a request/tool.

## Unit 1 implementation

Added `utils/file-lifecycle.js`:
- registers temporary user artifacts with a generated lifecycle ID;
- records creation time, kind and optional owner;
- supports lookup/release/list/stat operations;
- keeps the lifecycle registry separate from permanent/static assets.

Updated `utils/cleanup.js`:
- preserves the existing public cleanup API and 8-second deferred deletion behavior;
- registers response artifacts before scheduling cleanup;
- releases registry entries after successful deletion or when the file is already absent;
- does not clear browser cache, static assets, R2 permanent user objects, or unrelated files.

## Scope boundary

This unit does not:
- remove existing upload limits;
- introduce a new file-size/page limit;
- change browser processing behavior;
- change permanent R2 storage;
- claim that all tools already use the shared lifecycle;
- alter tool processors.

## Unit 3 — Output structural validation

Added `utils/output-validator.js` as the shared generated-artifact validation layer.

Validation rules:
- PDF output must have the `%PDF-` signature, must parse through `pdf-lib`, and must contain at least one page.
- DOCX/XLSX/PPTX and ZIP outputs must have a ZIP container signature and successfully parse through `JSZip` with at least one entry.
- Generated JPEG/PNG/GIF/WebP/BMP/TIFF outputs are checked against their expected file signatures.
- JSON output is parsed before delivery.
- Unknown output types still receive a non-empty-buffer check so existing tools remain compatible.

Delivery integration:
- `utils/cleanup.js::sendPdf()` now validates every PDF before headers/body delivery.
- `routes/convert.js::sendFile()` now validates generated conversion artifacts before delivery.

Failure behavior:
- Structurally invalid generated artifacts are never sent as successful downloads.
- The server logs the validation reason and returns a generic HTTP 500 response when headers have not yet been sent.
- No new file-size or page-count processing limits were introduced; the PDF page check only rejects a structurally empty generated PDF.

Current scope boundary:
- This unit covers the shared PDF delivery path and the conversion router's generated-file delivery helper.
- Other upload-producing/direct `sendFile`/response paths remain part of the Phase 3 lifecycle coverage audit and are not marked covered yet.

## Unit 4 — Browser temporary resource lifecycle

Added `public/js/browser-resource-lifecycle.js` and loaded it immediately after the existing Object URL registry.

Capabilities:
- Scoped ownership for temporary browser resources.
- Object URL creation/revocation through the existing `ObjectURLRegistry` when available.
- Explicit tracking/release of temporary buffers.
- Worker tracking/release through the existing `WorkerLifecycle` when available.
- Scope-level cleanup and global pagehide cleanup.
- Memory-pressure cleanup is intentionally conservative: anonymous/ephemeral buffers and anonymous Object URLs may be released, while active tool scopes remain intact so an in-progress preview or operation is not broken.
- Durable OPFS/IDB data and user-selected `File` objects are never deleted by this layer.

This is a lifecycle API for future/current tool integrations; it does not monkey-patch every browser API or force-release active processing resources.

## Next Phase 3 units

1. Server and R2 lifecycle coverage audit across every upload-producing route.
2. Security regression + runtime consistency verification.

## Unit 2 — Unified input validation

Implemented in `utils/upload.js` at the shared multer boundary. Every `createUpload()` route now receives a post-write content-signature check before its route handler runs.

Recognized signatures currently checked:
- PDF: `%PDF-`
- JPEG: JPEG SOI marker
- PNG: PNG signature
- GIF: GIF87a/GIF89a
- WebP: RIFF/WEBP container markers
- BMP: BM signature
- TIFF: little/big-endian TIFF headers
- ZIP: ZIP local/empty/spanned archive signatures

The check uses the declared MIME type only as a routing hint and verifies the actual leading bytes. Unknown MIME types remain compatible with existing generic tools rather than being incorrectly rejected. Files that fail validation are deleted immediately and the route receives a 400 response before processing begins.

This preserves the existing browser-first architecture and does not impose a new file-size or page-count limit.
