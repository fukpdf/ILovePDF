# ILovePDF Phase 1 — Target Platform Architecture

Status: Phase 1 foundation document
Scope: architecture boundaries only; existing working tool engines must remain isolated.

## 1. Core rule

The platform uses a shared platform layer plus independently deployable/loadable tool modules.

Shared changes may propagate through versioned contracts/components. A defect in one tool must not require loading or executing another tool's engine.

## 2. Target repository domains

- apps/ — web, mobile, desktop, admin applications
- packages/ — shared UI, design tokens, auth, security primitives, validation contracts, i18n, analytics, API types, feature flags
- tools/ — independently owned tool modules and their engines
- services/ — API, jobs, file lifecycle, payments, notifications, search, admin services
- infrastructure/ — deployment, CDN, Cloudflare, storage, observability
- docs/ — architecture, tool contracts, security, operations, deployment
- tests/ — shared contract/integration tests and tool-specific regression suites

This is a target architecture. Migration must be incremental; do not move the current application wholesale in one change.

## 3. Runtime loading model

A public page loads the shared shell first. A tool module and its processing engine are loaded only when the user invokes that tool.

Flow:

User opens site
-> shared shell/design/i18n/security primitives
-> user selects a tool
-> tool manifest/module loads
-> required engine/library loads
-> input validation
-> processing
-> output validation
-> delivery
-> temporary user-data cleanup

Do not preload every tool engine on initial page load.

## 4. Isolation boundary

Every tool owns:
- tool UI/editor
- tool options
- tool processing logic
- engine adapters
- tool-specific validation
- tool-specific tests
- performance characteristics
- version metadata

Shared platform owns:
- shell/header/footer
- design system
- accessibility primitives
- authentication contracts
- entitlement checks
- common file/security validation primitives
- analytics/event contracts
- i18n
- API client contracts
- feature flags
- common error/loading/result states

A shared package must not import a tool engine.

## 5. File lifecycle and cache policy

Permanent/static assets should be cacheable for performance.

Temporary user files and generated result artifacts must have an explicit lifecycle:
1. acquire
2. process
3. validate
4. deliver
5. release temporary object URLs/workers/buffers
6. remove temporary browser storage entries when no longer needed

Do not clear the entire browser cache after delivery. Static JS/CSS/fonts/engine assets may be intentionally cached.

Current repository already contains an IndexedDB asset cache for CDN scripts/model assets and separate tool-state/blob persistence. Phase 1 therefore defines the boundary: asset cache is performance infrastructure; user-file/result storage is temporary data and must be cleaned by lifecycle rules.

## 6. Processing and validation

Processing is not considered successful merely because an engine returned bytes.

Required pipeline:

input -> type/size/security checks -> tool engine -> output structural validation -> tool-specific semantic checks where possible -> integrity checks -> delivery.

A validation failure must prevent the result from being presented as successful.

## 7. Secrets

Secrets are runtime configuration, never source code or browser-delivered configuration.

Production secrets should come from the deployment/provider secret store. GitHub Actions secrets may be used for CI/CD credentials where necessary. Browser configuration may contain only values explicitly designed to be public.

## 8. Deployment isolation

A tool change should be buildable/testable independently. The long-term deployment path is:

change -> static/type/unit checks -> tool regression tests -> integration/contract tests -> staging -> controlled production rollout -> monitoring -> rollback if health gates fail.

The current repository is a single Node/Express deployment, so Phase 1 does not pretend that independent production services already exist. The boundary is being documented before migration.

## 9. Apps

Web, Android, iOS and desktop should consume shared API contracts and tool metadata. Native-only capabilities such as camera/scanner access remain platform adapters rather than being forced into the web implementation.

## 10. Admin

Admin is a separate privileged application surface. It controls configuration, tool availability, feature flags, content, plans/entitlements and operational views through authenticated server-side APIs.

Admin actions require authorization and audit logging.

## 11. Design rule

The existing website visual language remains the source of truth for the migration:
- existing theme
- stickers/illustrations
- header/footer
- cards
- upload experience
- typography
- motion language
- result/download presentation

The architecture changes underneath these visuals. A new design system should extract and reuse the existing visual language rather than replace it without a requirement.

## 12. Non-goals of Phase 1

- no mass tool rewrite
- no forced C++/Rust rewrite
- no claim of 100% output correctness
- no claim of 100M concurrent capacity
- no claim that current single-deploy infrastructure is already horizontally isolated
- no removal of working tool-specific engines merely to make the code look uniform
