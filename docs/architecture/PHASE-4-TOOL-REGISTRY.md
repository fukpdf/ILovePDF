# Phase 4 — Tool Registry & Independent Module Boundaries

## Unit 1 — Authoritative registry foundation

Implemented on `phase-4-tool-registry`.

### Source of identity
`config/tool-registry.json` is the Phase 4 canonical registry for tool identity and module ownership metadata.

Each entry declares:
- stable tool ID and URL slug
- display name/category/group
- module owner
- execution class
- version
- dependency declaration
- authentication/entitlement declaration
- feature-flag slot
- output/cleanup/validation contracts

The registry currently covers the configured standard tools plus the special standalone tool surfaces represented by `SLUG_MAP`.

### Boundary rule
The registry is metadata only. It does not execute processors, load engines, or contain secrets. Existing tool processors remain untouched.

### Reconciliation gate
`npm run audit:phase4` verifies:
- registry schema and required fields
- unique tool IDs and slugs
- registry ↔ `tools-config.js` identity reconciliation
- `SLUG_MAP` ↔ registry reconciliation

### Scope
Unit 1 establishes the authoritative identity/ownership contract. It does not yet migrate runtime consumers away from the legacy `TOOLS` array or `SLUG_MAP`; that is a later Phase 4 unit so runtime behavior remains stable during the transition.

## Verification
Source-level implementation is complete for Unit 1. CI/deployment verification is required before Phase 4 is marked complete.


## Unit 2 — Browser runtime authority

Implemented on `phase-4-unit-2-runtime-registry`.

### Runtime delivery
- `public/config/tool-registry.json` publishes the exact CI-audited registry to Firebase Hosting.
- `public/js/tool-registry-runtime.js` loads and validates the registry before tool resolution.
- `window.ToolRegistryReady` provides an explicit readiness barrier.
- `tool-page.js` waits for the registry and resolves the legacy UI definition through `ToolRegistry.mergeLegacy()`.

### Migration safety
The legacy `TOOLS` array remains the compatibility/detail source for icons, descriptions, options, endpoints, and other UI-specific fields. Registry metadata is authoritative for identity, slug, module, execution class, version, entitlement, feature-flag, output, cleanup, and validation policy. This avoids a flag-day migration while making the runtime selection registry-driven.

### Failure behavior
If the published registry cannot be loaded or validated, the page fails open to the existing `TOOLS` resolution path so a registry delivery problem does not break the tool UI. CI prevents this fallback from being silently required in production by checking registry mirror parity and runtime wiring.

### Verification gate
`npm run audit:phase4` now additionally verifies:
- published registry mirror is byte-identical to the canonical registry
- browser registry loader exists and exposes its readiness promise
- `tool-page.js` waits for the registry and uses registry-backed resolution
- `tool.html` loads the registry runtime before `tool-page.js`


## Unit 4 — Adaptive Worker Streaming

Implemented on `phase-4-unit-4-adaptive-stream-execution`.

- Registry capability metadata now records `lazyLoad`, `workerPool`, `streaming`, and `fileSizePolicy`.
- Worker-safe tools use `adaptive-worker` streaming capability.
- Large single-file worker jobs route through `RuntimeStreamBridge.pipelineStreamToWorker`.
- Large multi-file worker jobs route through `RuntimeStreamBridge.streamFilesToWorkerReadable`, preserving sequential bounded input transfer.
- Small jobs retain the faster WorkerPool one-shot path.
- Streaming is an execution optimization, not a rejection threshold; the registry explicitly retains an `unlimited` file-size policy.
- No artificial page-count or file-size rejection was introduced.
- Unit 4 is enforced by `npm run audit:phase4`.
