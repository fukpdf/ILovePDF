---
name: Phase 4 Revenue Architecture Foundation
description: What was built, key constraints, and activation notes for the ads-first revenue system.
---

# Phase 4 — Revenue Architecture Foundation

## What was built (2026-06-23)

### New files
- `public/css/ads.css` — CLS-safe reserved dimensions for all ad slot types (leaderboard, rectangle, in-content, download, sticky-footer). Debug mode via `<body data-ad-debug="1">`. Also contains session-length CSS (session-continue-section, related-tool-card, recent-dl-item).
- `public/js/ad-manager.js` — `window.AdManager` IIFE. Provider-agnostic slot manager: IntersectionObserver viewability, AdSense `<ins>` injection (when slot IDs issued), Ezoic placeholder renaming, mobile sticky footer injection. API: register, discoverSlots, activate, activateAll, setProvider, onViewable, getStats, createStickyFooter.

### Modified files
- `public/index.html` — CSS link for ads.css; two ad slot placeholders (home-hero = Ezoic 101, home-mid = Ezoic 102); session-continue section (`#session-continue-section`); ad-manager.js deferred script tag alongside runtime-ads.js.
- `public/tool.html` — CSS link for ads.css only (tool page ad slots injected by JS).
- `public/js/home.js` — `renderSessionContinue()` + `_timeAgo()` added before INIT block; called in DOMContentLoaded. Reads SessionPersist.loadResume() + SessionPersist.getDownloads() (Phase 3 API).
- `public/js/tool-page.js` — `renderDownloadStep()` gets related-tools grid + download-banner ad slot appended. `_buildRelatedToolsHtml(toolId, maxCount)` helper at module scope (same-category first, fills from other groups).
- `public/js/runtime-tool-idle-loader.js` — `/js/ad-manager.js` added to IDLE_STACK (end of list).

## Key constraints (NEVER touch)
- `BrowserTools.process()`, Workers, Arc bundles (`public/js/bundles/`), security layers, runtime-shield, download logic, PDF output, Auth, Firebase, DB, server.js middleware

## Ad slot inventory
| ID | Element ID | Ezoic | Location |
|---|---|---|---|
| home-hero | ad-home-hero | 101 | Homepage below quick-access |
| home-mid | ad-home-mid | 102 | Homepage between PDF/Image sections |
| download-banner | ad-download-banner | 104 | Tool download step |
| sticky-footer | ad-slot-sticky-footer | 106 | Mobile only, appended to body |

## Activation notes
- **AdSense slots are PENDING** — no `data-ad-adsense` attribute on any slot yet. AdManager will activate automatically once slot IDs are added to each slot's `data-ad-adsense` attribute (post-approval).
- **Ezoic** — auto-activates if `window.ezstandalone` is detected. No Ezoic scripts needed; containers are already named correctly.
- **Debug** — add `data-ad-debug="1"` to `<body>` to see outlined slot placeholders without live ads.

**Why:** Slots must stay invisible until filled (no layout flash). AdManager's CLS strategy: `min-height:0` by default, `min-height` only activates on `.ad-slot--active`. Contains layout prevent reflows from escaping slot boundary.
