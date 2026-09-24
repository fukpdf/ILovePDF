# ILovePDF Tool Module Contract

Every tool migrated to the target architecture must have a clear boundary.

## Required metadata

A tool manifest should define, at minimum:

- id
- display name
- slug
- category
- supported input types
- single/multiple input policy
- client/server execution mode
- required engine dependencies
- authentication requirement
- plan/entitlement requirement
- usage limits
- feature flags
- output type
- cleanup policy
- version
- validation capabilities

## Runtime contract

A tool exposes a small lifecycle:

1. register metadata
2. load on demand
3. validate input
4. prepare engine
5. process
6. validate output
7. expose result
8. cleanup temporary resources

The shared platform calls the contract; it does not know the internal implementation of the tool.

## Isolation requirements

A tool must not:
- modify another tool's processing state
- rely on another tool's mutable globals
- import another tool's private engine
- require all engines to load at startup
- store secrets in browser code
- report success before output validation

A tool may use shared packages through stable public contracts.

## Error contract

Errors should be typed into categories such as:
- INVALID_INPUT
- UNSUPPORTED_FORMAT
- LIMIT_EXCEEDED
- ENGINE_LOAD_FAILED
- PROCESSING_FAILED
- OUTPUT_VALIDATION_FAILED
- TEMP_STORAGE_FAILED
- AUTH_REQUIRED
- ENTITLEMENT_REQUIRED
- RATE_LIMITED

User-facing copy is handled by the shared presentation layer; internal diagnostics must not expose secrets or sensitive file content.

## Validation contract

At minimum:
- input MIME/extension and size checks
- parser acceptance where applicable
- output existence
- output type
- output readability/openability
- expected structural properties

Where a deterministic semantic check exists, it should be added to the tool's regression suite.

## Lazy loading contract

Only dependencies needed by the selected tool may load.

A tool may use browser cache/IndexedDB for reusable static engine assets, model weights or libraries subject to versioning and storage limits.

User files and generated outputs must have separate lifecycle/cleanup rules.

## Regression contract

Before a migrated tool is marked complete:
- source-level checks pass
- tool-specific tests pass
- shared contract tests pass
- unrelated tool configuration remains unchanged
- no legacy upload/preview system remains active for that tool
- no new console/runtime error is introduced by the changed code path

Browser visual rendering is a separate validation category and must only be reported when actually executed.

## Module ownership reconciliation (Phase 1)

The module registry is a contract boundary, not a processor implementation. The current
36-tool configuration was audited against BrowserTools and special routes before module
activation was tightened.

Known execution gaps remain explicit:
- `word-to-excel` is configured as client-side but has no BrowserTools handler yet.
- `numbers-to-words` and `currency-converter` use special HTML routes and are not
  BrowserTools processors.
- These tools must not be forced through the standard BrowserTools path until their
  dedicated module/processor contract is implemented.

Migration rule: **configured tool → independent module contract → declared processor →
validated execution**. A missing processor is an explicit gap, not a silent fallback.

## Current execution capability audit (Phase 1)

Audited against the current `public/js/tools-config.js`, `public/js/browser-tools.js`, `public/workers/workerPool.js`, `public/workers/pdf-worker.js`, and `public/js/stream-helpers.js`.

| Tool | Browser handler | WorkerPool | Current worker-safe set | Streaming/chunking status |
|---|---|---|---|---|
| Merge | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Split | Yes | No | No | Not worker-streamed |
| Rotate PDF | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Crop PDF | Yes | No | No | Preview/page helpers exist; processor not worker-safe |
| Organize PDF | Yes | No | No | Not worker-wired |
| Compress PDF | Yes | Yes | Yes | Whole buffers currently sent to worker |
| PDF to Word | Yes | No | No | Main-thread/library dependent |
| PDF to PowerPoint | Yes | No | No | Main-thread/library dependent |
| PDF to Excel | Yes | No | No | Main-thread/library dependent |
| PDF to JPG | Yes | No | No | Page-at-a-time helpers available |
| Word to PDF | Yes | No | No | Main-thread/library dependent |
| PowerPoint to PDF | Yes | No | No | Main-thread/library dependent |
| Excel to PDF | Yes | No | No | Main-thread/library dependent |
| Word to Excel | Configured client-side | No handler | No | Dedicated processor required before claiming support |
| JPG to PDF | Yes | No | No | Browser/canvas path |
| HTML to PDF | Yes | No | No | DOM-dependent |
| Edit PDF | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Watermark | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Sign PDF | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Add Page Numbers | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Redact PDF | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Protect PDF | Yes | No | No | Not worker-wired |
| Unlock PDF | Yes | No | No | Not worker-wired |
| Repair PDF | Yes | No | No | Main-thread/library dependent |
| Scan to PDF | Yes | No | No | Device/camera surface |
| OCR | Yes | No | No | Tesseract owns its worker/runtime |
| Compare PDF | Yes | No | No | Main-thread/library dependent |
| AI Summarizer | Yes | No | No | Explicit provider configuration required |
| Translate | Yes | No | No | Provider/engine dependent; no hidden fallback |
| Workflow Builder | Yes | Yes | Yes | Whole buffers currently sent to worker |
| Background Remover | Yes | No | No | Dedicated model/worker validation required |
| Crop Image | Yes | No | No | Canvas-dependent |
| Image Resize | Yes | No | No | Canvas-dependent |
| Image Filters | Yes | No | No | Canvas-dependent |

### Special/non-standard surfaces

`numbers-to-words`, `currency-converter`, and other `SLUG_MAP` entries with `special` routes are separate pages and are not counted as BrowserTools document processors. They require their own capability audit before migration into the standard tool-module runtime.

### Interpretation

A config flag such as `clientSide: true` is not by itself proof that a processor is complete or worker-safe. The runtime capability profile distinguishes browser handler, worker safety, lazy loading, and validation. Streaming/chunking is only claimed where the underlying processor actually supports it.
