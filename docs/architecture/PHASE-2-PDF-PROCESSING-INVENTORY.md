# Phase 2 — Legacy PDF Processing Inventory

Status: audited on 2026-09-24
Branch: phase-2-shared-platform-foundation

## Current execution boundary

The legacy `public/js/browser-tools.js` currently contains the authoritative browser handlers for PDF and document/image tools. The file still contains large main-thread implementations, while a subset of PDF operations is already dispatched through `public/workers/pdf-worker.js` and `public/workers/workerPool.js`.

The new target is not to keep this file as a permanent processing engine. It will become a thin compatibility/dispatch layer only while each tool is migrated and verified.

## Classification

| Tool | Current legacy handler | Current worker path | Target architecture | Migration status |
|---|---|---|---|---|
| merge | pdf-lib in browser-tools | pdf-worker | WorkerPool + transferable buffers; WASM/native engine when fidelity requires | migrate |
| split | pdf-lib in browser-tools | pdf-worker | WorkerPool; whole-document parse with page-selection output | migrate |
| rotate | pdf-lib in browser-tools | pdf-worker | WorkerPool; page metadata operation | migrate |
| organize | pdf-lib in browser-tools | pdf-worker | WorkerPool; page graph/rebuild | migrate |
| page-numbers | pdf-lib in browser-tools | pdf-worker | WorkerPool; deterministic output validation | migrate |
| watermark | pdf-lib in browser-tools | pdf-worker | WorkerPool; deterministic output validation | migrate |
| crop | pdf-lib in browser-tools | main thread | WorkerPool; avoid UI-thread PDF parsing | migrate |
| compress | pdf-lib in browser-tools | pdf-worker | WorkerPool + stronger engine strategy; never pretend size reduction is guaranteed | migrate |
| protect | pdf-lib in browser-tools | pdf-worker | replace fake visual protection with standards-compliant PDF encryption engine | redesign |
| unlock | pdf-lib in browser-tools | pdf-worker | standards-compliant permission/encryption handling | redesign |
| sign | pdf-lib in browser-tools | pdf-worker | WorkerPool for document assembly; cryptographic signing needs dedicated standards engine | redesign |
| redact | pdf-lib in browser-tools | pdf-worker | true content removal/flattening, not only drawing a black rectangle | redesign |
| edit | pdf-lib in browser-tools | pdf-worker | document-content editing engine; preserve existing content/resources | redesign |
| repair | browser-tools handler | pdf-worker | parser/rebuilder engine with fixture corpus | migrate |
| compare | browser-tools handler | pdf-worker | structural + rendered/text comparison depending mode | redesign |
| pdf-to-jpg | pdfjs/canvas path | dedicated/legacy worker infrastructure exists | PDF.js rendering in worker + OffscreenCanvas where supported | migrate |
| jpg-to-pdf | canvas/pdf-lib path | no authoritative PDF worker yet | image decode/EXIF + PDF assembly in worker | migrate |
| ocr | Tesseract/browser path | OCR workers exist | WASM OCR worker pipeline, page streaming and bounded concurrency | migrate |
| pdf-to-word | conversion handler | dedicated worker exists | worker-first conversion with validated DOCX output | migrate |
| pdf-to-excel | conversion handler | dedicated worker exists | worker-first extraction with validation | migrate |
| pdf-to-powerpoint | conversion handler | dedicated worker exists | worker-first conversion with validation | migrate |
| word-to-pdf | conversion handler | dedicated worker infrastructure | worker/WASM where feasible | migrate |
| word-to-excel | conversion handler | dedicated worker infrastructure | worker-first | migrate |
| powerpoint-to-pdf | conversion handler | dedicated worker infrastructure | worker-first | migrate |
| excel-to-pdf | conversion handler | dedicated worker infrastructure | worker-first; bounded sheet/page rendering | migrate |
| scan-to-pdf | browser capture path | preprocessing workers exist | local capture + worker pipeline | migrate |
| background-remover | browser ML/canvas | remove-bg worker exists | dedicated worker/WASM/ML runtime | migrate |
| image tools | canvas/browser | image workers exist | worker-first image pipeline | migrate |
| AI summarize / translate | browser handlers + dedicated workers | summary/translation workers exist | keep separate from document-processing registry; Laba AI remains separate | separate review |
| workflow | browser handler | pdf-worker | worker pipeline with explicit operation manifest | migrate |

## Critical findings

1. `public/workers/pdf-worker.js` already implements a persistent worker dispatcher and receives transferable `ArrayBuffer` inputs.
2. `pdf-worker.js` also contains chunk-ack streaming and transferable ReadableStream protocols, but these currently accumulate chunks before invoking pdf-lib. Chunking therefore controls transport/backpressure/memory spikes; it does not make arbitrary PDF byte ranges independently processable.
3. `browser-tools.js` still reads complete files with `file.arrayBuffer()` for most PDF handlers. This is the main legacy memory path that must be removed tool-by-tool.
4. `WORKER_TOOLS` currently covers a subset of PDF operations. The remaining PDF handlers can still execute on the main thread.
5. The current worker imports pdf-lib from a CDN. This is suitable as an intermediate worker migration, but the long-term fidelity-sensitive engine should be evaluated for bundled WASM/native code rather than assuming JavaScript pdf-lib is equivalent to a native PDF engine.
6. The existing `protect` operation is not real PDF encryption; it draws a visual "PASSWORD PROTECTED" page. It must not be presented as cryptographic PDF protection.
7. The existing `redact` operation draws a black rectangle over content. Visual covering is not equivalent to removing the underlying content and must be replaced before calling the tool production-grade redaction.
8. "100% accurate" is not a valid blanket claim. Each migrated tool needs deterministic fixtures and output validation appropriate to its operation.

## Migration gate

A legacy handler is removable only after:
- new worker/WASM path is authoritative;
- representative fixture corpus passes;
- malformed/edge cases are tested;
- output file can be reopened by the selected parser;
- tool-specific invariants are checked;
- browser execution is verified;
- no server fallback exists;
- legacy references are removed and source search confirms no active path remains.

## Next migration order

1. Crop / Rotate / Merge / Split / Organize — simple structural operations.
2. Page Numbers / Watermark — deterministic page annotation.
3. Compress — benchmark multiple strategies.
4. Repair — malformed PDF corpus.
5. Redact / Protect / Unlock / Sign — standards-sensitive redesign.
6. PDF-to-image / OCR — rendering and WASM pipelines.
7. Office conversions — dedicated conversion engines.
8. AI-related operations — separate architecture review; do not couple Laba AI to the PDF processing registry.

This inventory is a migration map, not a claim that all listed tools are already production-verified.


## Security-sensitive quarantine update (2026-09-24)

Protect and Sign are not promoted into the authoritative worker registry because the current implementations are not standards-compliant security processors. `protect` creates a visual overlay rather than PDF encryption, and `sign` draws visible signature text rather than producing a cryptographic PDF digital signature. The legacy browser handlers and worker-tool registrations have been removed from the active dispatch path. They require dedicated Phase 3 security implementations before reactivation.

`unlock` remains worker-only but must continue to report its actual password/permission behavior; it must not imply that every encrypted PDF can be unlocked without the appropriate credentials.


## Edit + Compare migration update (2026-09-24)

`edit` and `compare` are now worker-dispatched only. The legacy main-thread handlers were removed from the active handler map. The worker already contains both operations. `edit` currently means additive text placement at coordinates; it does not claim arbitrary in-place PDF text editing. `compare` currently produces a structural comparison report (page count, page size, metadata) and does not claim pixel-perfect or semantic text-diff equivalence.
