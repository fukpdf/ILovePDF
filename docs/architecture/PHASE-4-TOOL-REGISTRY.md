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


## Unit 6 — Legacy routing authority removal

Implemented on `phase-4-unit-6-legacy-routing-removal`.

- Initial tool resolution now waits for the published Tool Registry and resolves pathname/query/server identities through registry entries.
- SPA popstate routing remains registry-backed and no longer treats `SLUG_MAP` as an identity authority.
- Standalone/special routes are read from the registry `specialRoute` field.
- `TOOLS` remains a UI/detail compatibility layer only; `SLUG_MAP` remains compatibility data for legacy surfaces but is not authoritative for runtime tool identity.
- The Phase 4 audit rejects reintroduction of direct `SLUG_MAP` identity resolution in `tool-page.js`.
- No file-size/page-count limits or server/Laba AI dependency are introduced.


## Unit 7 — Runtime capability contract

Implemented on `phase-4-unit-7-capability-contract`.

- Registry capability metadata is now an enforced runtime contract, not documentation only.
- `ToolExecutionPolicy` compares registry `lazyLoad`, `workerPool`, and `streaming` capabilities with the actual BrowserTools execution manifest before processing.
- Worker tools must remain worker-pool backed with `adaptive-worker` streaming; browser/special-page tools cannot silently advertise worker execution.
- The registry file-size policy remains `unlimited`; unsupported restrictive policies are rejected rather than silently applied.
- The Phase 4 audit validates every registry entry's capability contract and the runtime enforcement boundary.
- This closes capability drift between the authoritative registry and processor implementation without adding file-size/page-count limits or a server/Laba AI dependency.


## Unit 8 — Runtime registry integrity

Implemented on `phase-4-unit-8-registry-integrity`.

- Published registry entries are normalized into immutable runtime snapshots.
- Tool entries, dependency arrays, and capability metadata are frozen so consumers cannot mutate authoritative execution metadata after load.
- The runtime registry exposes a lightweight `health()` snapshot with readiness, endpoint, schema version, loaded tool count, and load error state for diagnostics.
- The Phase 4 audit verifies the immutable entry/capability boundary and health API.
- No file-size/page-count limits, server processing dependency, or Laba AI dependency is introduced.


## Unit 9 — Runtime manifest contract

Implemented on `phase-4-unit-9-runtime-manifest-contract`.

- The canonical Phase 4 Tool Registry now has a build-time and runtime contract with `RuntimeToolManifestRegistry`.
- Every canonical tool ID must have exactly one runtime manifest entry, and every runtime manifest entry must exist in the canonical registry.
- Runtime validation waits for the published Tool Registry readiness barrier and exposes immutable diagnostic snapshots through `registryContractStatus()`.
- The richer runtime manifest remains responsible for family-level hydration, worker, memory, recovery, offline, thermal, and analytics policy; it no longer operates with an unverified tool-identity universe.
- Phase 4 CI audits the one-to-one identity contract and registry-count parity.
- No file-size/page-count limits, server processing dependency, or Laba AI dependency is introduced.
