# CHANGELOG.md — ILovePDF Development History

Chronological history of all major development phases and Arcs.  
Each entry documents: purpose, files added, globals exposed, panels, bundles, major features.  
**Code changes**: ZERO — documentation only.

---

## Pre-Arc Era — Core Application (Phases 1–5)

### Phase 1 — Foundation
**Purpose**: Initial Express server, PDF processing routes, basic frontend.

**Key files established**:
- `server.js` — Express 5 entry point
- `routes/organize.js` — merge, split, rotate, reorder
- `routes/edit.js` — compress, edit, watermark, sign, crop, page-numbers, redact
- `routes/convert.js` — all format conversions
- `routes/security.js` — protect, unlock
- `routes/advanced.js` — repair, ocr, translate, compare, ai-summarize
- `routes/image.js` — background-remove, crop-image, resize-image, filters
- `routes/auth.js` — email/password JWT authentication
- `utils/db.js` — SQLite schema (users, pending_signups, usage_log)
- `public/js/browser-tools.js` — `window.BrowserTools` (client-side PDF processing)
- `public/js/tools-config.js` — TOOLS array + SLUG_MAP (43 tool definitions)
- `public/js/tool-page.js` — 3-step upload/preview/download flow
- `public/js/page-organizer.js` — `window.PageOrganizer` PDF page grid UI
- `public/js/auth-ui.js` — auth modal + profile chip
- `public/tool.html` — shared tool shell template
- `public/index.html` — homepage

**Security established**:
- Per-request CSP nonce (`utils/csp-nonce.js`)
- Rate limiting (80 req/15 min)
- Origin guard (`utils/origin-guard.js`)
- Usage limits (guest/free/premium tiers)
- JWT httpOnly cookies

**Globals established**:
- `window.BrowserTools` — `{ process(toolId, files, opts), supports(toolId) }`
- `window.PageOrganizer` — `{ open, PAGE_LEVEL_TOOLS, shouldHandle }`

---

### Phase 2 — Security Hardening
**Purpose**: CSP nonce system, strict `script-src`, remove `unsafe-inline`.

**Changes**:
- Nonce-based CSP replacing `unsafe-inline`
- `utils/csp-nonce.js` — `generateNonce()` + `injectNonce(html, nonce)`
- `__CSP_NONCE__` placeholder pattern in HTML templates
- `buildHtml()` / `buildHomeHtml()` introduced to pre-build HTML at boot

---

### Phase 3 — SEO Infrastructure
**Purpose**: Full programmatic SEO system for AdSense compliance.

**Files added**:
- `utils/seo.js` — `buildHtml()`, `buildHomeHtml()`, `SLUG_MAP`, JSON-LD builders
- `utils/seo-keywords.js` — per-tool SEO copy (title, desc, long, FAQs, related)
- `utils/seo-categories.js` — category landing page logic
- `utils/seo-guides.js` — guide content
- `utils/seo-comparison.js` — comparison page content
- `routes/seo-routes.js` — `/sitemap.xml`, `/robots.txt`, category pages
- `routes/live-intelligence.js` — `/live-intel` real-time knowledge layer

**SEO systems**:
- 4-schema JSON-LD per tool page: SoftwareApplication + FAQPage + HowTo + BreadcrumbList
- Sitemap index → 4 sub-sitemaps (tools, blog, categories, static)
- robots.txt with Disallow entries for `/admin`, `/debug`, `/api/`
- Clean URLs (no `.html` extensions)

---

### Phase 4 — Security Mesh
**Purpose**: Origin validation, security telemetry, execution tickets.

**Files added**:
- `routes/security-telemetry.js` — client-side threat reporting pipeline
- `routes/execution-tickets.js` — anti-duplication ticket system
- `utils/runtime-packet-validator.js` — soft POST body validation
- `utils/origin-validator.js` — enhanced origin validation

---

### Phase 5 — Advanced Engine
**Purpose**: `AdvancedEngine` wrapping `BrowserTools` with enterprise capabilities.

**Files added**:
- `public/js/advanced-engine.js` — `window.AdvancedEngine` v5.4
- `public/js/live-preview.js` — `window.LivePreview` v6.0

**Globals added**:
- `window.AdvancedEngine` — wraps BrowserTools with retry, memory guards, quality scoring, DebugTrace
- `window.LivePreview` — `{ mount(toolId, files, hostEl), supported(toolId) }`

---

## Phase 6 — Advanced Engine Foundation

**Bundle**: `runtime-phase6-core.bundle.js` (9 KB, sync) + `runtime-phase6-deferred.bundle.js` (151 KB, defer)  
**Source files**: 13 total  
**Purpose**: Enterprise runtime foundation — device profiling, worker pool, OPFS streaming.

**Systems added**:
| System | Purpose |
|--------|---------|
| Adaptive Runtime | Device profiling → `full`/`limited`/`minimal` profile |
| Adaptive Degradation | Auto-degrades quality under memory pressure |
| Worker Pool | Web Worker lifecycle, reuse, load balancing |
| RuntimeStreaming (RSE v2.0) | OPFS-based chunked streaming for files > 200 MB |
| Memory Telemetry | Heap monitoring, GC pressure detection |

**Globals added**:
- `window.AdaptiveRuntime` — `{ profile: 'full' | 'limited' | 'minimal' }`
- `window.WorkerPool` — managed Web Worker pool

---

## Phase 7 — Zero-Trust Mesh

**Bundle**: `runtime-phase7.bundle.js` (195 KB, defer)  
**Source files**: 24  
**Purpose**: Zero-trust security layer over the entire runtime.

**Systems added**:
- Runtime forensics (tamper detection)
- Session recorder (tool usage events)
- Session persistence (IDB cross-navigation)
- Memory vault (short-TTL encrypted local cache)
- Origin validator (cross-frame message validation)
- Incident engine (anomaly → alert pipeline)
- Stability metrics

**Globals added**:
- `window.RuntimeForensics` — `{ snapshot(type, ctx) }`
- `window.RuntimeSessionRecorder` — event recording
- `window.RuntimeSessionPersistence` — IDB persistence
- `window.RuntimeMemoryVault` — encrypted short-TTL cache
- `window.StabilityMetrics` — stability scoring

---

## Phase 8 — Deferred Hardening

**Bundle**: `runtime-phase8-deferred.bundle.js` (68 KB, defer)  
**Source files**: 6  
**Purpose**: Edge-case failure hardening, crash recovery, deadlock detection.

**Systems added**:
- Packet validator (API request/response validation)
- Security telemetry (client → server threat reporting)
- Execution tickets (prevents duplicate processing)
- Crash recovery UI (graceful error screens)
- Deadlock monitor

**Key route**: `POST /api/security-telemetry`

---

## Phase 9 — Infrastructure Layer

**Bundle**: `runtime-phase9-infra.bundle.js` (28 KB, sync)  
**Source files**: 6  
**Purpose**: Low-level server infrastructure.

**Files added**:
- `utils/server-health-monitor.js` — `getHealthSnapshot()` + `requestTimingMiddleware()`
- `utils/upload.js` — `UPLOAD_DIR`, `sweepUploads()`
- `utils/usage.js` — `checkUsage`, `enforcePerFile`, LIMITS object

**Key endpoint**: `GET /api/server-health`

---

## Arc 2 — Production Hardening

**Bundle**: `runtime-arc2.bundle.js` (63 KB, defer)  
**Source files**: 9  
**Tasks**: T006–T015  
**Purpose**: First formal Arc — production stability for a live user base.

**Systems added**:
- T006: Worker lifecycle normalization
- T007: Download orchestration
- T008: Retry orchestration safety
- T009: Navigation cancellation safety
- T010–T015: Adaptive degradation + lifecycle audit
- T012: Shared cleanup contracts (10 built-in contracts)

**Globals added**:
- `window.WorkerLifecycle`
- `window.DownloadManager`
- `window.RetryOrchestrator`
- `window.NavCancel`
- `window.AdaptiveDegradation`
- `window.CleanupContracts`

---

## Arc 3 — Tool Runtime Isolation

**Bundle**: `runtime-arc3.bundle.js` (63 KB, defer)  
**Source files**: 9  
**Purpose**: Prevent tool failures from cascading to other tools.

**Systems added**:
- Per-tool state sandboxes
- Tool-level memory budgets
- Tool-level timeout guards
- Independent processing pipelines per tool

**Key principle**: A failure in one tool's runtime cannot cascade to another tool.

---

## Arc 4 — Enterprise Tool Runtime Completion

**Bundle**: `runtime-arc4.bundle.js` (80 KB, defer)  
**Source files**: 9  
**Purpose**: Enterprise-grade per-tool intelligence and optimization.

**Systems added**:
- Tool SLA tracking (expected vs actual processing time)
- Tool health scoring (success rate, p50/p95 latency)
- Tool discovery registry (dynamic capability detection)
- Tool optimizer (auto-tunes parameters from device profile)

---

## Arc 5 — True Enterprise Tool Isolation

**Bundle**: `runtime-arc5.bundle.js` (83 KB, defer)  
**Source files**: 9  
**Purpose**: Hard isolation boundaries — no cross-tool contamination.

**Systems added**:
- Cross-tool state contamination prevention
- Worker claim exclusivity
- Output watermarking (result blobs tagged with generation context)
- Tool runtime versioning

---

## Arc 6 — Advanced Engine Full Decomposition

**Bundle**: `runtime-arc6.bundle.js` (96 KB, defer)  
**Source files**: 15  
**Tasks**: T020–T034  
**Purpose**: Decompose the monolithic AdvancedEngine into 15 named subsystems.

**Globals added** (all major runtime globals):
- `window.CentralRuntime` v2.0.0 (T020) — master bootstrap coordinator
- `window.RuntimeScheduler` (T021) — task priority scheduler
- `window.RuntimeWorkers` (T022) — worker orchestration
- `window.RuntimeMemory` (T023) — memory controller (NORMAL/WARNING/CRITICAL)
- `window.RuntimeQueue` (T024) — FIFO + priority job queue
- `window.RuntimeCancellation` (T025) — cancellation token system
- `window.RuntimeProgress` (T026) — progress tracking bus
- `window.RuntimeCleanup` (T027) — resource cleanup contracts
- `window.RuntimeTelemetry` (T028) — telemetry event bus
- `window.RuntimeAdapters` (T029) — per-tool adapter registry
- `window.RuntimeState` (T030) — shared state manager
- `window.RuntimeHealth` (T031) — health monitor
- `window.RuntimeEventBus` (T032) — pub/sub events
- `window.RuntimeDiagnostics` (T033) — DevTools diagnostics
- `window.RuntimeStreaming` (T034) — OPFS streaming v2.0 (10 MB threshold, 4 MB chunks)

---

## Arc 7 — Ultra Performance + Streaming Runtime

**Bundle**: `runtime-arc7.bundle.js` (79 KB, defer)  
**Source files**: 8  
**Purpose**: Large-file performance and GPU acceleration.

**Systems added**:
- `window.GiantFileRouting` — files > 400 MB routed to OPFS streaming
- Giant file telemetry — metrics for large file operations
- GPU fallback validator — WebGPU detection
- Canvas pool — reuses `<canvas>` elements to reduce GC pressure
- Differential processing — only processes changed page regions

---

## Arc 8 — Enterprise Observability + Live Control Plane

**Bundle**: `runtime-arc8.bundle.js` (74 KB, defer)  
**Source files**: 8  
**Purpose**: Real-time observability and live configuration control.

**Systems added**:
- Compare benchmark (tool A vs tool B result comparison)
- Compare runtime (multi-strategy comparison engine)
- Auto-tuning engine (dynamically adjusts DEVICE profile)
- Enterprise memory fabric (cross-session memory statistics)
- Distributed recovery (multi-strategy recovery from failures)

---

## Arc 9 — Autonomous Self-Healing + Distributed Intelligence

**Bundle**: `runtime-arc9.bundle.js` (81 KB, defer)  
**Source files**: 8  
**Purpose**: Self-healing runtime that automatically recovers from failure states.

**Systems added**:
- Autonomous agent (monitors health, triggers recovery)
- Autonomous AI workers (background intelligence tasks)
- Distributed AI orchestrator (coordinates processing strategies)
- Generative AI engine stubs (quality enhancement)
- Hyperscale vector memory/fabric (semantic tool state memory)

---

## Arc 10D — Admin Observability Dashboard

**Bundle**: `runtime-arc10.bundle.js` (83 KB, defer)  
**Source files**: 14  
**Purpose**: Admin observability dashboard with 22 real-time debug panels.

**Files added** (`public/js/debug-panels/` — 22 panels):
- Performance + Health: `panel-control`, `panel-performance`, `panel-timeline`, `panel-traces`, `panel-blackbox`
- Stability: `panel-incidents`, `panel-recovery`, `panel-crash-survival`, `panel-recovery-memory`, `panel-deploy-resilience`
- Infrastructure: `panel-tab-mesh`, `panel-persistent-storage`
- Tool Intelligence: `panel-tool-health`, `panel-tool-insights`, `panel-tool-recovery`, `panel-tool-registry`, `panel-tool-sla`, `panel-tool-circuit-breaker`, `panel-tool-discovery`, `panel-tool-optimizer`, `panel-tool-persistence`, `panel-tool-predictor`

**Routes added**:
- `routes/debug.js` — serves `/debug` admin shell
- `routes/admin.js` — `/admin/login`, `/admin/setup`, `/admin/*`
- `routes/admin-api.js` — `/api/admin/*` CRUD
- `routes/security-dashboard.js` — `/api/security-dashboard/*`
- `routes/security-incidents.js` — `/api/security-incidents/*`
- `routes/threat-feed.js` — `/api/threat-feed/*`

---

## Arc 11 — Distributed Runtime Mesh + Persistent Diagnostics

**Bundle**: `runtime-arc11.bundle.js` (109 KB, defer)  
**Source files**: 13  
**Purpose**: Multi-tab coordination and cross-session persistent diagnostics.

**Systems added**:
- `window.TabMesh` — cross-tab processing coordination via SharedWorker
- Persistent diagnostics — runtime state to IDB for cross-session analysis
- Runtime session recorder — persistent event log (IDB backend)
- Cross-tab worker sharing — workers from one tab usable in another
- Enterprise recovery v2 — multi-tier fallback chains

**Worker added**: `public/workers/shared-cluster-worker.js` — SharedWorker for cross-tab coordination

---

## Arc 12 — Enterprise Tool Intelligence Layer (ETIL)

**Bundle**: `runtime-arc12.bundle.js` (88 KB, defer)  
**Source files**: 14  
**Purpose**: Predictive and reactive tool intelligence.

**Systems added**:
- Tool performance predictor (estimates processing time)
- Tool health heatmap (visual health across all tools)
- Tool SLA enforcement (auto-cancels tasks exceeding SLA)
- Tool circuit breaker (opens after N failures, auto-resets after cooldown)
- Tool insight aggregator (patterns from historical processing)

**Panels updated**: `panel-tool-circuit-breaker`, `panel-tool-predictor`, `panel-tool-health`

---

## Arc 13 — Persistent Tool Intelligence + Circuit Breaker

**Bundle**: `runtime-arc13.bundle.js` (74 KB, defer)  
**Source files**: 14  
**Purpose**: Persist intelligence state across page reloads — circuit breaker state survives refresh.

**Systems added**:
- Per-tool state persisted across sessions (IDB backend)
- Circuit breaker state persistence
- Intelligence replay (replay historical events for training)
- Adaptive circuit breaker thresholds (auto-adjusts from error rates)

---

## Arc 14 — Enterprise Runtime Command Center (ERTCC)

**Bundle**: `runtime-arc14.bundle.js` (85 KB, defer)  
**Source files**: 15  
**Purpose**: Command-and-control plane for live runtime management.

**Systems added**:
- `window.RuntimeCommandAnalytics` — unified analytics bus (**NOTE**: named `RuntimeCommandAnalytics` not `RuntimeAnalytics` to avoid conflict with client analytics bus)
- Command center API — programmatic control of all runtime subsystems
- Live control plane — real-time config changes without page reload
- Tool killswitch — disable specific tools without deployment
- Runtime policy engine precursor

---

## Arc 15 — Enterprise Runtime Automation & Policy Orchestration (ERAPO)

**Bundle**: `runtime-arc15.bundle.js` (98 KB, defer)  
**Source files**: 15  
**Purpose**: Full policy automation — the runtime governs itself.

**Systems added**:
- Policy engine — define rules like "if error_rate > 20% for 5 min, open circuit"
- Automated remediation — policies trigger actions automatically
- SLA policy enforcement — automated violation handling
- Runtime audit log — policy decisions with timestamps
- Policy templates — pre-built for memory pressure, high latency, etc.
- Sitemap clean URL enforcement (added to this Arc)

**Globals added**:
- `window.RuntimePolicy` — `{ define(rule), execute(policy) }`

---

## CI/CD Migration — 2026-06-19

**File changed**: `.github/workflows/deploy.yml`  
**Change**: Migrated Firebase Hosting deployment from deprecated `w9jds/firebase-action@master` to `google-github-actions/auth@v2` + `npx firebase-tools deploy`.

**Before**: `w9jds/firebase-action@master` with `GCP_SA_KEY` env var  
**After**: `google-github-actions/auth@v2` with `credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}`

Secret name corrected from `GCP_SA_KEY` → `FIREBASE_SERVICE_ACCOUNT` (matching the actual GitHub secret that exists in the repository).

---

## Runtime Bundle Summary

| Bundle | Arc/Phase | KB | Files | Key Globals |
|--------|-----------|-----|-------|-------------|
| `runtime-phase6-core` | Phase 6 | 9 | 1 | `AdaptiveRuntime` |
| `runtime-phase6-deferred` | Phase 6 | 151 | 12 | `WorkerPool`, streaming |
| `runtime-phase7` | Phase 7 | 195 | 24 | `RuntimeForensics`, `StabilityMetrics` |
| `runtime-phase8-deferred` | Phase 8 | 68 | 6 | execution tickets, crash recovery |
| `runtime-phase9-infra` | Phase 9 | 28 | 6 | server health, upload management |
| `runtime-arc2` | Arc 2 | 63 | 9 | `WorkerLifecycle`, `CleanupContracts` |
| `runtime-arc3` | Arc 3 | 63 | 9 | tool sandboxes, timeouts |
| `runtime-arc4` | Arc 4 | 80 | 9 | SLA, health scoring, optimizer |
| `runtime-arc5` | Arc 5 | 83 | 9 | hard isolation, output watermarking |
| `runtime-arc6` | Arc 6 | 96 | 15 | **CentralRuntime**, all Runtime* globals |
| `runtime-arc7` | Arc 7 | 79 | 8 | `GiantFileRouting`, GPU validator |
| `runtime-arc8` | Arc 8 | 74 | 8 | auto-tuning, memory fabric |
| `runtime-arc9` | Arc 9 | 81 | 8 | autonomous agent, AI workers |
| `runtime-arc10` | Arc 10D | 83 | 14 | **22 debug panels** |
| `runtime-arc11` | Arc 11 | 109 | 13 | `TabMesh`, persistent diagnostics |
| `runtime-arc12` | Arc 12 | 88 | 14 | circuit breakers, ETIL |
| `runtime-arc13` | Arc 13 | 74 | 14 | persistent circuit breaker state |
| `runtime-arc14` | Arc 14 | 85 | 15 | `RuntimeCommandAnalytics`, killswitch |
| `runtime-arc15` | Arc 15 | 98 | 15 | `RuntimePolicy`, ERAPO |
| **Total** | | **~1.4 MB** | **230** | |
