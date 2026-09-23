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
