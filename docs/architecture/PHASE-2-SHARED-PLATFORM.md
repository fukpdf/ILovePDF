# Phase 2 — Shared Platform Foundation

Status: **Unit 1 implemented — shared design tokens and primitives**

## Audit findings

The repository already contains several shared platform pieces:
- `public/css/home-header-v2.css` — canonical public header styling.
- `public/css/home-footer-v2.css` — canonical public footer styling.
- `public/css/shared-a11y.css` — shared accessibility rules.
- `public/js/shared-core.js` — platform event/auth/analytics/navigation/i18n bridge.
- `public/js/shared.js` — shared modal, processing and shell helpers.
- `public/js/runtime-lazy-engine-loader.js` — lazy engine loading.
- `public/js/runtime-worker-coordinator.js` and related runtime modules — worker scheduling/prewarm/coordinator infrastructure.
- `docs/architecture/PHASE-1-TARGET-ARCHITECTURE.md` — explicitly defines shared shell/design system ownership and lazy tool loading.

The main gap for Phase 2 Unit 1 was that the existing visual language was distributed across multiple stylesheets with repeated literal values. There was no small, canonical token layer that later shared components could consume without rewriting the current visual design.

## Implemented scope

Added `public/css/platform-tokens.css` containing:
- brand/color aliases
- surface/border aliases
- gradient aliases
- radius and shadow tokens
- spacing tokens
- content-width token
- focus-ring token
- reusable container/stack/cluster/surface/accessibility primitives

The values intentionally alias the **existing** ILovePDF visual language. This unit does not redesign the site and does not migrate tool engines.

## Boundary rules

- Shared tokens contain no tool-specific processing logic.
- No PDF/image engine is imported by the shared layer.
- Laba AI remains outside the document-tool processing architecture.
- Tokens are presentation infrastructure only.
- Existing page-specific styles remain authoritative until individually migrated and verified.

## Verification target

After inclusion on the canonical public shells, source/CI checks must confirm:
1. CSS is syntactically valid through the repository's available validation path.
2. Existing JavaScript tests remain green.
3. Security/runtime audits remain green.
4. No processing engine is added to the shared layer.
5. The visual values are unchanged unless a later migration intentionally opts into a token.

## Next Unit

Unit 2 will wire the token layer into the canonical header/footer/tool shell with no intended visual change, then verify the resulting public pages before extracting additional shared components.
