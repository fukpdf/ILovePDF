# Phase 3 — Security, Validation & File Lifecycle

Status: Unit 1 implemented on `phase-3-security-file-lifecycle`

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

## Next Phase 3 units

1. Unified input validation contract, including content/signature checks where technically safe.
2. Output structural validation before success/delivery.
3. Browser temporary object URL / worker / buffer release hooks.
4. Server and R2 lifecycle coverage audit across every upload-producing route.
5. Security regression + runtime consistency verification.

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
