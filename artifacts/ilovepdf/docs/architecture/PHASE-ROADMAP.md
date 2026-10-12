# ILovePDF Platform Roadmap

## Phase 0 — Discovery / current-state audit
Repository inventory, dependencies, runtime paths, existing tools, security, storage, deployment, tests, admin and current UI systems.

## Phase 1 — Target architecture foundation
Freeze boundaries, shared-vs-tool contracts, tool lifecycle, lazy loading rules, file/cache lifecycle, secrets policy, deployment isolation model and migration rules.

## Phase 2 — Shared design/platform layer
Extract current visual language into reusable components/tokens without changing the intended visual identity.

## Phase 3 — Security, validation and file lifecycle
Unify input/output validation contracts, temporary data cleanup, browser resource release, server-side file lifecycle and security gates.

## Phase 4 — Tool registry and independent module boundaries
Introduce authoritative tool metadata and explicit tool ownership/dependency boundaries.

## Phase 5 — Standard tool migration
Migrate the standard tool-page family one tool at a time. Crop is the reference implementation; processing engines remain tool-owned.

## Phase 6 — Special/standalone tool migration
Numbers to Words, Currency Converter, Image Compressor, Image Converter, QR, Barcode, ZIP and N2W, preserving their app-specific logic while adopting shared platform contracts.

## Phase 7 — Backend/API/job architecture
Separate request handling, asynchronous jobs, workers, file storage and output delivery where scale requires it.

## Phase 8 — Accounts, plans, entitlements and payments
Central authorization/entitlement model; payment providers remain behind a service boundary.

## Phase 9 — Admin and operations platform
Privileged admin application, RBAC, audit logs, feature flags, tool controls, content, SEO/i18n operations and health views.

## Phase 10 — Scanner/OCR and native capabilities
Camera/scanner adapters, OCR pipelines and mobile-native integrations.

## Phase 11 — Web/mobile/desktop product surfaces
Android, iOS and desktop clients consuming stable shared contracts.

## Phase 12 — Scale, reliability and continuous delivery
Load testing, CDN/cache strategy, queues/workers, observability, controlled rollout, rollback, disaster recovery and continuous tool lifecycle.

### Phase execution rule

For EVERY phase and EVERY tool:

AUDIT RELATED FILES
-> document findings
-> implement only the intended scope
-> source-level verification
-> run available tests/checks
-> report exact changed files and validation status
-> move to next unit

Never mark a change as validated merely because code was written.
