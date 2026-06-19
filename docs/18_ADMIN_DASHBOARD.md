# 18 — ADMIN DASHBOARD

## Overview

The admin dashboard is a protected, real-time observability interface built on Arc 10D and expanded in subsequent Arcs. It provides operational visibility into the runtime, security, user activity, and system health.

---

## Access

| URL | Purpose |
|-----|---------|
| `/admin` | Redirects to `/admin/login` if not authenticated |
| `/admin/login` | Admin login form |
| `/admin/setup` | First-time admin account setup |
| `/admin/*` | Protected dashboard (requires admin session) |
| `/debug` | Arc debug panels (requires admin auth) |

---

## Admin Routes

### `routes/admin.js`
- Serves admin static pages (`/admin/login`, `/admin/setup`, `/admin/*`)
- `POST /api/admin/auth/login` — admin authentication
- `POST /api/admin/auth/logout` — admin logout

### `routes/admin-api.js`
All routes protected by `adminGuard` middleware:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/users` | List all users |
| GET | `/api/admin/users/:id` | Get user details |
| PATCH | `/api/admin/users/:id` | Update user (plan, name, etc.) |
| DELETE | `/api/admin/users/:id` | Delete user |
| GET | `/api/admin/stats` | Platform usage statistics |
| GET | `/api/admin/usage` | Usage log (all users) |
| POST | `/api/admin/broadcast` | Send notification to users |

### `routes/security-dashboard.js`
```
GET /api/security-dashboard/summary    → Aggregated security metrics
GET /api/security-dashboard/incidents  → Recent security incidents
GET /api/security-dashboard/telemetry  → Raw telemetry events
GET /api/security-dashboard/threats    → Active threat indicators
```

### `routes/security-incidents.js` (Phase 8)
Persistent incident storage:
```
GET  /api/security-incidents       → Paginated incident list
POST /api/security-incidents       → Create new incident
GET  /api/security-incidents/:id   → Get incident details
PATCH /api/security-incidents/:id  → Update incident status
```

### `routes/threat-feed.js` (Phase 8)
Threat intelligence aggregation:
```
GET /api/threat-feed          → All active threat indicators
GET /api/threat-feed/summary  → Aggregated threat metrics
```

### `routes/live-intelligence.js` (Phase 3)
Real-time knowledge layer:
```
GET /live-intel/dashboard     → Live metrics snapshot
WS  /live-intel/stream        → WebSocket real-time stream (if configured)
```

---

## Debug Panels (`/debug`)

Arc 10D introduced the `/debug` endpoint serving 22 observability panels. Route: `routes/debug.js`

### Panel Categories

**Performance + Health**
| Panel | File | Data source |
|-------|------|-------------|
| Control | `panel-control.js` | `window.CentralRuntime.getStatus()` |
| Performance | `panel-performance.js` | `window.RuntimeHealth.metrics()` |
| Timeline | `panel-timeline.js` | `window.RuntimeTelemetry.getTimeline()` |
| Traces | `panel-traces.js` | `window.DebugTrace.getAll()` |
| Blackbox | `panel-blackbox.js` | `window.RuntimeForensics.getLog()` |

**Stability + Recovery**
| Panel | File | Data source |
|-------|------|-------------|
| Incidents | `panel-incidents.js` | `window.IncidentEngine.getAll()` |
| Recovery | `panel-recovery.js` | `window.DistributedRecovery.getHistory()` |
| Crash Survival | `panel-crash-survival.js` | `window.CrashSurvival.status()` |
| Recovery Memory | `panel-recovery-memory.js` | `window.EnterpriseMemoryFabric.get()` |
| Deploy Resilience | `panel-deploy-resilience.js` | `window.DeployResilience.status()` |

**Infrastructure**
| Panel | File | Data source |
|-------|------|-------------|
| Tab Mesh | `panel-tab-mesh.js` | `window.TabMesh.status()` |
| Persistent Storage | `panel-persistent-storage.js` | IDB + OPFS status |

**Tool Intelligence**
| Panel | File | Data source |
|-------|------|-------------|
| Tool Health | `panel-tool-health.js` | Per-tool health scores |
| Tool Insights | `panel-tool-insights.js` | Usage pattern analysis |
| Tool Recovery | `panel-tool-recovery.js` | Per-tool recovery events |
| Tool Registry | `panel-tool-registry.js` | `window.RuntimeAdapters.list()` |
| Tool SLA | `panel-tool-sla.js` | SLA compliance per tool |
| Circuit Breaker | `panel-tool-circuit-breaker.js` | Circuit breaker states |
| Tool Discovery | `panel-tool-discovery.js` | Capability discovery log |
| Tool Optimizer | `panel-tool-optimizer.js` | Auto-tuning recommendations |
| Tool Persistence | `panel-tool-persistence.js` | State persistence log |
| Tool Predictor | `panel-tool-predictor.js` | Processing time predictions |

---

## Admin Database (`utils/admin-db.js`)

Separate database for admin-specific data:
- Admin user accounts
- Audit log (admin actions)
- Configuration overrides

---

## Community API (`routes/community-api.js`)

Public (no auth) endpoint for community engagement metrics:
```
GET /api/community/stats
Response: {
  totalProcessed: 12345,   // total files processed
  activeTodayCount: 234,   // users active today
  toolUsage: {             // most-used tools
    'merge': 3421,
    'compress': 2100,
    ...
  }
}
```

**Caching**: 30s server-side cache (prevents abuse on polling endpoints).  
**Mounting**: Before rate limiter (exempt from 80 req/15 min limit).

---

## Security Dashboard UI

`admin/security-dashboard.html` — standalone HTML page with:
- Real-time threat visualization (map, charts)
- Incident timeline
- Alert feed
- Rule configuration UI

---

## Execution Tickets (`routes/execution-tickets.js`)

Phase 6 anti-duplication system:
```
POST /api/ticket         → Create execution ticket (returns ticketId)
DELETE /api/ticket/:id   → Release ticket after processing

Semantics:
  - Each processing request acquires a ticket before starting
  - If ticket exists for same (userId, toolId, fileHash): return existing result
  - Prevents duplicate processing of identical files
```

---

## Server Health Endpoint

```
GET /api/server-health
Response: {
  ok: true,
  buildId: 'mpxgtdiz',
  timestamp: 1234567890000,
  memory: {
    heapUsed: 45,    // MB
    heapTotal: 120,  // MB
    rss: 180         // MB
  },
  latency: {
    p50: 45,    // ms
    p95: 200,   // ms
    p99: 500    // ms
  },
  requestCount: { total: 12345, last5min: 67 },
  services: {
    firebase: true,
    r2: false,
    hf: false
  },
  uptime: 3600  // seconds
}
```

Used by admin dashboard + uptime monitors.

---

## Admin Guard (`middleware/admin-guard.js`)

Separate from user JWT auth:
```javascript
// Admin session stored in cookie: ilovepdf_admin_token
// Separate secret from JWT_SECRET
// Checked by adminGuard middleware on all /admin/* routes
```

Admin credentials stored in `utils/admin-db.js` (SQLite, separate from app.db).
