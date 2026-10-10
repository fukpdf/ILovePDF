# Browser Compression Kit Integration — Status

## Scope of this branch

This is a safety-first integration slice, not certification of the new TypeScript/WASM kit.

### Implemented in this slice
- The existing worker compression route now returns the exact input bytes without attempting a pdf-lib rewrite when the source visibly contains `/ByteRange`, `/Encrypt`, `/XFA`, or `/AcroForm`.
- The compression path no longer strips document metadata as a side effect.
- Add a first-pass `src/browser/wasmCli.ts` adapter that writes input bytes to the WASM virtual filesystem, validates exit status and output PDF signature, and cleans temporary virtual files. This adapter is not yet wired into the compression UI.
- The existing compression regression script asserts those guard conditions.
- Existing UI/runtime files and the root package scripts are intentionally retained.

### Not yet certified / still required before enabling the new engine
- Integrate the supplied TypeScript modules behind the existing worker adapter while preserving UI modes and result/report contracts.
- Add an initial in-memory WASM CLI adapter (`src/browser/wasmCli.ts`) and ambient declaration for the undocumented Ghostscript package. QPDF's published factory/FS/callMain contract was cross-checked against its declarations and README. The adapter is not yet wired to the existing UI or bundled with local WASM assets.
- Finish verifying Ghostscript-WASM runtime behavior from its published package tests/artifacts and test both engines against real PDFs.
- Use qpdf-style lossless structural processing only when decoded page-content streams remain byte-identical after decoding; use a cryptographic digest, not FNV or extracted-text counts.
- Prove link, annotation, AcroForm, font, page-box, rotation, outline and attachment preservation, not just annotation counts.
- Implement and validate image dictionary eligibility, full deduplication identity (including bytes and all relevant dictionary entries), correct image placement matrices, and true box/bicubic resampling.
- Implement the browser-only quality gate with fail-closed output selection, worker cancellation, progress, lazy WASM loading and explicit memory-limit / unreachable-target messages.
- Add the requested real-PDF fixture suite: Flate text, Word export, 1-bit scan, grayscale, CMYK JPEG, RGB photos, mixed aspect ratios, SMask, AcroForm, signed, encrypted and 100-page PDFs.
- Add regression tests for each legacy bug, tune `gsQFactor`, `minPsnrDb`, and `minSharpnessRatio` using measured results, and record the results table.
- Verify that no network request carries PDF bytes. WASM package downloads are not PDF uploads; PDF data must remain in browser memory only.
- Preserve the existing site's build/test/audit commands. Do not replace the production `package.json` with the standalone kit manifest.
- Review the Ghostscript AGPL-3.0 obligations before release.

## Important limitation

The legacy pdf-lib serialization route for ordinary PDFs is **not** proof of the requested content-stream hash contract. This branch does not claim that the full quality contract is met and must not be deployed as the completed hybrid engine until the remaining checks pass. If a check is unavailable or fails, the implementation must return the original PDF rather than an unverified candidate.

## Validation status

No local `npm test`, typecheck, Vite build, browser fixture run, network-capture test, or PDF content-stream hash comparison has been executed by this GitHub-only change operation. The added regression assertions need to be run in the repository environment.


## Package API audit (2026-10-10)

- `@neslinesli93/qpdf-wasm` publishes a default async module factory. Its published declarations expose `callMain(args: string[]): number`, `FS`, and `WORKERFS`; the README demonstrates `locateFile`, `FS.writeFile`, `FS.readFile`, and `callMain`. The kit's `wasmCli.ts` must match those actual types and check the numeric exit code and output file existence.
- `@jspawn/ghostscript-wasm` version `0.0.2` declares `gs.js` as `main` and `gs.mjs` as `module`. Its published test `tests/all.js` initializes the default module factory, uses `mod.FS.mkdir/mount/chdir`, calls `mod.callMain(args)`, and asserts exit codes 0 and 1; `js/post.js` explicitly exposes `FS.writeFile` and `FS.readFile`. Its docs are sparse, so browser bundling and `locateFile` still require a package-level smoke test. The package is AGPL-3.0 and is a release/legal review item.
- The repository's production app is a vanilla Node/static-page application, not an existing Vite TypeScript app: its root `package.json` build script currently only prints “Build complete”. The kit cannot be safely enabled by copying its standalone manifest or assuming a Vite worker/WASM URL pipeline already exists. A deliberate build integration and asset-path test is required.
- No PDF fixture, browser network-capture, content-stream digest, typecheck, or full test execution is evidenced by this API audit.
