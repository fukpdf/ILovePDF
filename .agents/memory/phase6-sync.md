---
name: Phase 6.3 Analytics Sync Layer
description: Architecture decisions and gotchas for analytics-sync.js (window.AnalyticsSync).
---

# Phase 6.3 Analytics Sync Layer

## Rule
`window.AnalyticsSync` is the provider-agnostic queue/batch/retry layer between AnalyticsEngine and any future backend. All 5 providers are disabled stubs in Phase 6.3.

## Hook mechanism (critical)
`window.AnalyticsEngine` is frozen — cannot inject or monkeypatch it. AnalyticsSync hooks by:
1. Listening to DOM events `ilpdf:step` and `download:triggered` (same events AE uses)
2. One-time backfill on boot via `AnalyticsEngine.export().recentEvents` (last 20 events)
3. Deriving `PAGE_VIEW` / `TOOL_OPEN` from `location.pathname` on init
4. Public `ingest(event, data, ts)` for external callers

## New localStorage keys (never overlap existing)
- `ilpdf_sync_v1` — event queue (max 200, FIFO drop)
- `ilpdf_batches_v1` — completed batches (max 20)
- `ilpdf_retry_v1` — DLQ + retry stats (max 50 DLQ entries)

## Admin dashboard integration pattern
Admin analytics page does NOT load analytics-sync.js. `renderSync()` in admin-analytics.js reads the 3 LS keys directly — same pattern as all other admin widgets. No runtime dependency on `window.AnalyticsSync` being loaded.

**Why:** admin/analytics.html is not a tool page so idle loader doesn't run there. Consistent with Phase 6.2 pattern (admin reads LS directly, never depends on runtime modules).

## Loading strategy
- Tool pages: added to `runtime-tool-idle-loader.js` IDLE_STACK (position 15, after analytics-engine.js)
- Homepage: `<script defer>` tag in index.html after analytics-engine.js
- Admin analytics page: not loaded (LS-only reads in admin-analytics.js)

## Performance
- Boot deferred via requestIdleCallback (3s timeout)
- All LS writes on pagehide/visibilitychange only
- Zero network calls in Phase 6.3
- Batch interval via setInterval (not RAF)

## Activating a provider (Phase 6.4+)
Replace the stub `send()` in `_PROVIDERS.<id>` with a real fetch() and set `provider.enabled = true`. No other changes needed.
