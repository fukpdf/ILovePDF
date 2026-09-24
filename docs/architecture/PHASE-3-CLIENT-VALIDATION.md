# Phase 3 — Client Processing Validation Harness

This gate provides deterministic validation for the browser-processing foundation without treating Node execution as browser certification.

## Automated checks

- shared client-processing kernel and file-lifecycle contracts
- malformed, empty, and truncated PDF rejection
- output reopenability
- rotate invariant preservation
- transferable ArrayBuffer contract
- worker timeout and termination behavior through a deterministic Worker stub
- migrated worker operation/protocol markers
- stale worker absence
- transferable output messaging in the persistent PDF worker

Run:

`npm run test:client-processing`

The harness exits non-zero on failed checks.

## Validation boundary

The Node harness does **not** certify browser-only behavior. Browser E2E remains required for:

1. real RuntimeWorkerFactory spawning in Chromium/Firefox-class browsers;
2. actual ArrayBuffer transfer/detachment behavior;
3. real timeout/termination under browser scheduling;
4. OffscreenCanvas/image rendering;
5. DOM/layout-dependent tools;
6. representative PDF/image/Office fixtures and visual/content fidelity.

Therefore a passing Node gate must not be described as 100% tool accuracy or browser E2E certification.

## Fixture policy

Representative fixtures should cover valid PDFs, malformed/truncated PDFs, encrypted PDFs where supported, rotated/cropped pages, image-heavy PDFs, native-text PDFs, scanned PDFs, DOCX/XLSX/PPTX files, EXIF-oriented images, and large files. Each tool should define deterministic invariants plus output-openability checks before being marked browser-validated.
