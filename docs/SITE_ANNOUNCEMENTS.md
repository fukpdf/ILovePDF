# Site Announcement UI

## Purpose
A small reusable pattern for temporary service notices, apologies, planned improvements, and future product announcements without a heavy dependency or duplicated modal code.

## Current status (2026-10-11)
- The announcement is **disabled on the homepage** because the delayed apology modal competed with the first-render experience and became the measured LCP element in local browser QA.
- The reusable JS/CSS files are retained for a future explicitly approved announcement, but the homepage assembler removes their tags from the delivered homepage.
- Do not re-enable the announcement by adding it to the homepage without repeating the first-render, CLS, accessibility, and visual regression checks.

## Files
- public/js/site-announcement.js: configuration, rendering, display policy, dismissal persistence, Escape/backdrop/button handling, keyboard focus loop and focus restoration.
- public/css/site-announcement.css: isolated responsive styles, safe-area padding, reduced-motion support.
- public/index.html source chunks may still contain the historical tags; `scripts/assemble-homepage-index.js` removes them from the assembled production artifact.

## Updating or adding an announcement
1. Edit the single CONFIG object in the JS file.
2. Keep the message factual and avoid promising dates or unconfirmed features.
3. Change version whenever announcement content meaningfully changes.
4. Set enabled: false to turn it off without removing the reusable implementation.
5. If a future notice must appear on more pages, add the deferred script to those specific templates intentionally; do not inject it globally by default.

## Acceptance checks
- The production homepage contains no announcement CSS/script reference or announcement overlay.
- The primary heading and tool catalogue remain visible without a delayed modal.
- CLS/LCP are measured after the change; metrics are reported with the local CI measurement context.
- If the announcement is ever reintroduced, test close/action/backdrop/Escape, focus management, storage failure, reduced motion, mobile layout, and no impact to upload/processing/navigation.

## Deployment
Changes deploy through .github/workflows/deploy.yml on pushes to main, targeting Firebase Hosting. Confirm the workflow succeeds and inspect the production URL before considering the task live.


### Brand styling
The announcement UI must follow the existing homepage design tokens from `public/css/home.css`: `--primary: #4f46e5`, `--primary-2: #7c3aed`, `--primary-deep: #1e1b4b`, and the `--grad` indigo/violet gradient. Do not introduce an unrelated red theme for this feature.
