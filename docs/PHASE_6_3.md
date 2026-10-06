# Phase 6.3 — Analytics Sync Layer

**Status:** Complete  
**Build date:** 2026-06-26  
**Depends on:** Phase 6.1 (AnalyticsEngine), Phase 6.2 (AdminAnalytics)

---

## Overview

Phase 6.3 introduces a **provider-agnostic analytics sync layer** that sits between `AnalyticsEngine` and any future analytics backend (Firebase, Cloudflare, GA4, Clarity, self-hosted). In this phase, all providers are **disabled** — there are zero network calls. The full queue → batch → retry → DLQ infrastructure runs locally, persisting state to `localStorage` and exposing a rich debug/export API.

The design goal is **zero-friction provider activation**: connecting a real provider in Phase 6.4 requires only implementing its `send()` stub. No changes to `AnalyticsEngine`, tool pages, or any other file.

---

## Architecture

```
DOM events (ilpdf:step, download:triggered)
        +  AnalyticsEngine.export() backfill (one-time on boot)
                            │
                            ▼
                  window.AnalyticsSync.ingest()
                            │
                            ▼
              ┌─────────────────────────┐
              │  Event Queue (FIFO)     │  ilpdf_sync_v1
              │  Max 200, deduplicated  │  persisted on pagehide
              └────────────┬────────────┘
                           │  BATCH_SIZE=10 or 30s interval
                           ▼
              ┌─────────────────────────┐
              │  Batch Builder          │  ilpdf_batches_v1
              │  Groups of 10 events    │  max 20 batches stored
              └────────────┬────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │  Provider Adapters      │  all disabled (simulation)
              │  Firebase / Cloudflare  │
              │  GA4 / Clarity / Self   │
              └────────────┬────────────┘
                           │  on failure
                           ▼
              ┌─────────────────────────┐
              │  Retry + DLQ            │  ilpdf_retry_v1
              │  Exp backoff 2^n sec    │  max 50 DLQ entries
              │  Max 5 retries          │
              └─────────────────────────┘
```

---

## New Files

| File | Purpose |
|------|---------|
| `public/js/analytics-sync.js` | Main sync layer runtime (IIFE, `window.AnalyticsSync`) |
| `docs/PHASE_6_3.md` | This document |

---

## Modified Files

| File | Change |
|------|--------|
| `public/js/runtime-tool-idle-loader.js` | Added `analytics-sync.js` to idle stack (after `analytics-engine.js`) |
| `public/index.html` | Added `<script src="/js/analytics-sync.js" defer>` after `analytics-engine.js` |
| `public/admin/analytics.html` | Added `#aa-sync-section` DOM + sidebar "Sync Layer" nav item |
| `public/js/admin-analytics.js` | Added `renderSync()` + `syncMetricCard()` helper; wired into `render()` |
| `public/css/admin-analytics.css` | Added `.aa-sync-*` styles for the sync panel |

---

## New localStorage Keys

| Key | Purpose | Max Size |
|-----|---------|----------|
| `ilpdf_sync_v1` | Event queue + drop/total counters | 200 events |
| `ilpdf_batches_v1` | Completed batch records | 20 batches |
| `ilpdf_retry_v1` | Dead-letter queue + retry stats | 50 DLQ entries |

**Zero conflict** with existing keys (`ilpdf_ae_v1`, `iplv_tool_pop_v2`, `iplv_engagement_v2`, `ilpdf_visits_v1`, `iplv_heatmap_v1`).

---

## Configuration

```js
CFG = {
  MAX_QUEUE:         200,    // max queued events (oldest dropped when full)
  MAX_BATCHES:       20,     // max stored batches
  MAX_DLQ:           50,     // max dead-letter entries
  BATCH_SIZE:        10,     // events per batch
  BATCH_INTERVAL_MS: 30000,  // 30 s auto-flush interval
  MAX_RETRIES:       5,      // retries before DLQ
  DEDUP_WINDOW_MS:   200,    // same event in 200 ms = duplicate
  BACKFILL_EVENTS:   20,     // recent AE events to ingest on boot
}
```

---

## window.AnalyticsSync API

```js
window.AnalyticsSync.ingest('TOOL_COMPLETED', { slug: 'merge' })
// → manually enqueue an event

window.AnalyticsSync.flush()
// → force batch-build + write all state to localStorage

window.AnalyticsSync.export()
// → download JSON blob: full queue + batches + DLQ + stats

window.AnalyticsSync.exportNDJSON()
// → download NDJSON blob: one event per line

window.AnalyticsSync.compressedPayload()
// → { compact: "PV:3,TO:1,FU:2", queueSize: 6, ... }

window.AnalyticsSync.debug()
// → full internal state: queue[], batches[], dlq[], providers[], stats, memory

window.AnalyticsSync.getQueue()   // → copy of current queue array
window.AnalyticsSync.getStats()   // → queue/batch/DLQ/provider counts
window.AnalyticsSync.config()     // → current CFG copy
window.AnalyticsSync.providers    // → frozen map of 5 provider stubs
```

---

## Provider Adapter Interface

```js
{
  id:         'firebase',
  name:       'Firebase Analytics',
  enabled:    false,           // set true to activate in Phase 6.4
  connected:  false,
  connect:    function() {},   // called when enabled = true
  disconnect: function() {},
  send:       function(batch) { return Promise.resolve({ ok: false }); }, // replace with fetch()
  flush:      function() {},
  status:     function() { return { id, name, enabled, connected }; },
}
```

**5 providers:** `firebase`, `cloudflare`, `ga4`, `clarity`, `selfhosted`

---

## Hook Mechanism

Since `window.AnalyticsEngine` is frozen (Phase 6.1), `AnalyticsSync` cannot inject into it. Instead it hooks via:

1. **DOM event listeners** — listens to `ilpdf:step` and `download:triggered` (same events AE uses), plus derives `PAGE_VIEW` / `TOOL_OPEN` from `location.pathname`
2. **One-time backfill** — on boot, calls `AnalyticsEngine.export().recentEvents` once to seed the queue with existing session history (last 20 events)
3. **Public `ingest()`** — external callers (e.g., future tool pages, A/B tests) can push events directly

---

## Loading Strategy

| Context | How loaded |
|---------|-----------|
| Tool pages | `runtime-tool-idle-loader.js` idle stack (after `analytics-engine.js`) |
| Homepage | `<script defer>` tag in `index.html` (after `analytics-engine.js`) |
| Admin dashboard | Not loaded — `admin-analytics.js` reads the 3 LS keys directly |

---

## Performance Contract

- Boot deferred via `requestIdleCallback` (3 s hard timeout)
- Zero blocking on: upload, preview, processing, download
- `BrowserTools.process()` — untouched
- All localStorage writes happen on `pagehide` / `visibilitychange` only
- No `XMLHttpRequest`, `fetch()`, or WebSocket in Phase 6.3
- Batch interval uses `setInterval` — no `requestAnimationFrame`

---

## Admin Dashboard Integration

The **Analytics Dashboard** (`/admin/analytics`) shows a new **Sync Layer** section with 8 metric cards:

- Queue Size, Pending Events, Dropped Events, Retry Count
- Batches Formed, Avg Batch Time, Last Flush, Sync Status

Plus a **Provider Status** panel showing all 5 providers as "Disabled".

Data is read directly from `localStorage` keys — no runtime dependency on `window.AnalyticsSync` being loaded.

---

## Activating a Provider (Phase 6.4+)

1. Replace the stub `send()` in `_PROVIDERS.firebase` (or any other) with a real `fetch()` call
2. Set `provider.enabled = true`
3. `AnalyticsSync` will route all pending and future batches to it automatically
4. No changes to `AnalyticsEngine`, tool pages, admin dashboard, or any other file

---

## What is NOT Modified

- `AnalyticsEngine` API — frozen, not touched
- `BrowserTools` / processing pipeline — not touched
- Security chain — not touched
- Workers — not touched
- Firebase auth — not touched
- Upload / download flows — not touched
- `AdManager` — not touched
- Arc systems (11–15) — not touched
