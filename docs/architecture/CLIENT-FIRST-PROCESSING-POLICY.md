# Client-First Processing & AI Isolation Policy

Status: Phase 1 architectural requirement
Scope: all ILovePDF web tools and the optional Laba AI chatbot integration

## 1. Browser-first processing

Every tool must prefer local browser processing when a reliable browser implementation exists.

The standard execution boundary is:

1. validate input locally
2. lazy-load only the selected tool's dependencies
3. use Web Workers / WorkerPool for worker-safe CPU-heavy work
4. use streaming/chunking/page-at-a-time helpers where the engine supports them
5. validate the produced result locally
6. present/download the result
7. clean temporary browser-side state

A tool must not upload a user's file merely because a browser implementation is inconvenient.

## 2. Worker isolation

Worker-safe tools must use the shared WorkerPool and must not silently fall back to main-thread execution after a worker failure. A worker failure is surfaced as an explicit processing error.

Tools that are not yet worker-safe may use the main browser thread temporarily, but their module boundary remains independent so they can be migrated to workers later without changing the shared upload/flow shell.

## 3. Lazy loading

Tool engines and large dependencies are loaded only when the selected tool needs them. Initial page load must not eagerly initialize every tool engine.

Reusable static dependency bytes may be cached in IndexedDB or browser cache. User files and generated results are temporary data and are not treated as reusable application assets.

## 4. Streaming and chunking

Large-file processing should use Blob/File slicing, page-at-a-time processing, bounded batches, transferable buffers, and cooperative yielding where supported by the selected engine.

The implementation must not claim streaming when an underlying library requires the complete file in memory.

## 5. Temporary-data lifecycle

User input files, generated result blobs, object URLs, and per-tool temporary state must have an explicit lifecycle.

After successful result delivery, only the relevant temporary tool state is removed. The implementation must not clear the user's entire browser cache.

Permanent user storage, if introduced for an authenticated product feature, must be an explicit product feature with its own retention and access controls.

## 6. No GitHub data path

GitHub is source control only. The application must never send user PDF files, images, screenshots, extracted text, generated results, prompts, API credentials, or other private processing data to the original GitHub repository.

Runtime user data must not be written into source files, generated commits, issues, pull requests, or repository logs.

## 7. Laba AI boundary

Laba AI is a separate chatbot surface, not an ILovePDF document-processing engine and not part of the tool-module registry.

The chatbot may call an AI provider only when an explicitly configured provider/API credential is available. There is no hidden AI provider, fabricated response mode, or automatic provider substitution.

If no valid AI provider is configured, the chatbot must report that AI service is unavailable rather than silently sending data to another provider.

Document files and extracted document text must not be sent to an AI provider unless the user-facing feature explicitly requires it and the configured provider path is available.

## 8. Secrets

AI keys, storage credentials, signing secrets, and other server credentials belong in deployment/provider secret storage or GitHub Actions Secrets. They must never be embedded in frontend JavaScript or committed source.

## 9. Independent tool modules

Shared platform code owns lifecycle primitives, accessibility, common validation, worker orchestration, storage boundaries, telemetry contracts, and UX shell behavior.

Each tool owns its processor, tool-specific validation, engine dependencies, options, and output validation.

A change to one tool must not require another tool's processor to execute or be bundled eagerly.

## 10. Required verification

For each migration or new tool module, verify:

- browser-side execution path exists where technically supported
- no unintended network upload of user files
- lazy dependency loading
- worker usage where worker-safe
- bounded memory strategy where practical
- output validation
- temporary-state cleanup
- no secrets/private user data in repository content
- no hidden AI fallback/provider substitution

This policy is an architectural constraint; it is not a claim that every existing tool already satisfies every item. Existing exceptions must be migrated phase-by-phase and documented.
