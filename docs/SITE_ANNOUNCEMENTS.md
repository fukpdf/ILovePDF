# Site Announcement UI

## Purpose
A small reusable pattern for temporary service notices, apologies, planned improvements, and future product announcements without a heavy dependency or duplicated modal code.

## Current rollout
- Initial placement: homepage only (public/index.html).
- Current message: apology for inconvenience and notice that major experience improvements are underway.
- Enabled by default in the JS configuration.
- Version: 2026-10-major-improvements-1.
- Display delay: 1.2 seconds after DOM readiness; first paint and primary homepage content are not intentionally blocked.
- Dismissal: remembers the current announcement version for seven days; a version change makes the new announcement eligible immediately.
- Browser storage is best-effort; failures must not prevent site use.

## Files
- public/js/site-announcement.js: configuration, rendering, display policy, dismissal persistence, Escape/backdrop/button handling, keyboard focus loop and focus restoration.
- public/css/site-announcement.css: isolated responsive styles, safe-area padding, reduced-motion support.
- public/index.html: loads the stylesheet and deferred script on the homepage only.

## Updating or adding an announcement
1. Edit the single CONFIG object in the JS file.
2. Keep the message factual and avoid promising dates or unconfirmed features.
3. Change version whenever announcement content meaningfully changes.
4. Set enabled: false to turn it off without removing the reusable implementation.
5. If a future notice must appear on more pages, add the deferred script to those specific templates intentionally; do not inject it globally by default.

## Acceptance checks
- First-time visitor sees the modal after the configured delay.
- Close, primary action, backdrop click, and Escape dismiss it.
- Tab and Shift+Tab remain within the dialog while open; focus is restored after closing.
- Same version is suppressed for seven days after dismissal; a new version can display.
- Small viewport and reduced-motion behavior are supported.
- Storage being unavailable does not block the homepage.
- Tool upload, processing, download, navigation, SEO, and service-worker behavior remain unchanged.

## Deployment
Changes deploy through .github/workflows/deploy.yml on pushes to main, targeting Firebase Hosting. Confirm the workflow succeeds and inspect the production URL before considering the task live.


### Brand styling
The announcement UI must follow the existing homepage design tokens from `public/css/home.css`: `--primary: #4f46e5`, `--primary-2: #7c3aed`, `--primary-deep: #1e1b4b`, and the `--grad` indigo/violet gradient. Do not introduce an unrelated red theme for this feature.
