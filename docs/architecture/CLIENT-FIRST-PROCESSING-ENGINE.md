# Client-First Processing Architecture — New PDF Engine Contract

## Decision

The document processing plane is being redesigned as browser-only. A document tool must not silently upload a user's file to a server for processing.

Pipeline:

File/Blob -> bounded chunks -> transferable ArrayBuffer -> Worker/Worker Pool -> native/WASM engine -> validated output -> Blob/stream -> download -> deterministic cleanup

## Engine implementation

For CPU-heavy and fidelity-sensitive operations, preferred implementation:
1. Rust or C++ compiled to WebAssembly for the core algorithm.
2. JavaScript only as thin orchestration/UI.
3. Dedicated Web Workers for CPU-heavy work.
4. WorkerPool for independent page/file tasks.
5. Transferable ArrayBuffer rather than structured-clone copies.
6. Blob/ReadableStream chunking when the operation can safely stream.
7. Page-at-a-time processing when the engine supports independent page transforms.
8. Lazy loading so a selected tool loads only its required engine.

C++ is not inherently more accurate. Accuracy comes from correctness and standards compliance. Each migrated tool therefore requires fixture-based output validation.

## Memory/device policy

- Low-memory/low-core devices: smaller chunks, fewer workers, aggressive cleanup.
- Capable devices: larger chunks and bounded parallelism.
- Never create an unbounded worker count.
- Terminate idle workers.
- Release transferred buffers and object URLs as soon as ownership ends.
- Avoid retaining full input, full output, and multiple page copies simultaneously.

## Streaming/chunking rule

Chunking is a transport and memory-management strategy, not a guarantee that every PDF operation can process arbitrary byte ranges independently. PDF operations requiring cross-reference tables, object graphs, random access, or whole-document rewriting may need reassembly or memory mapping inside the worker. We will never split a PDF at arbitrary byte offsets and treat each chunk as a valid PDF.

## Accuracy/authenticity gate

Every migrated tool requires:
- valid-input fixtures
- malformed/encrypted/edge-case fixtures where relevant
- deterministic output checks
- page-count/page-size/rotation/content checks appropriate to the operation
- visual comparison where rendering matters
- output-openability validation
- no silent fallback to a different processor

A successful download alone is not a migration pass.

## Browser code visibility

WASM/native-style browser modules can make implementation harder to casually inspect than readable JavaScript, but browser-delivered executable code cannot be made impossible to reverse engineer. The browser must receive executable bytes. Do not put secrets or private server-only algorithms in browser code.

After processing, terminate workers, revoke object URLs, drop application-owned references/buffers where practical, and do not claim guaranteed cryptographic erasure from JavaScript/WASM memory.

## Legacy migration rule

The existing browser-tools implementation is legacy during migration. It must not be deleted blindly because current tools depend on it.

For each tool:
1. inventory every legacy function/dependency;
2. implement its new worker/WASM engine;
3. run fixture and browser verification;
4. switch its registry entry;
5. remove the old function and unused dependency;
6. verify no legacy path remains.

This prevents a half-migrated production site.

## Server processing fallback

The new client-processing kernel rejects a server-fallback flag. Server infrastructure may remain for non-processing concerns, but document bytes must not be uploaded merely because a browser engine failed.

If required browser capability is unavailable, show a clear local-processing-unavailable state rather than silently sending the file elsewhere.

## Laba AI boundary

Laba AI remains a separate chatbot surface and is not a PDF processing engine or processing fallback.
