# 09 — RUNTIME ARCHITECTURE

## Overview

The runtime architecture is a layered enterprise system built across Phases 6–9 and Arcs 2–15. All 19 bundles are loaded deferred after first paint. Each bundle is a concatenated, self-contained JavaScript file built by `scripts/build-runtime-bundles.js`.

**Total bundled runtime**: ~1.4 MB (unminified)  
**Load strategy**: `defer` attribute — no blocking of initial render  
**Integrity**: Verified by `scripts/verify-runtime-bundles.js` and `scripts/enterprise-ci-gate.js`

---

## Phase 6 — Advanced Engine Foundation (151 KB deferred + 9 KB core)

**Bundle**: `runtime-phase6-core.bundle.js` + `runtime-phase6-deferred.bundle.js`  
**Files**: 13 total

### Phase 6 Core Systems
| System | Purpose |
|--------|---------|
| Adaptive Runtime | Device profiling (cores, heap) → `full`/`limited`/`minimal` profile |
| Adaptive Degradation | Auto-degrades quality/workers under memory pressure |
| Worker Pool | Manages Web Worker lifecycle, reuse, and load balancing |
| RuntimeStreaming (RSE v2.0) | OPFS-based chunked streaming for files > 200 MB |
| Memory Telemetry | Heap monitoring, GC pressure detection |

**Key global**: `window.AdaptiveRuntime.profile` → `'full' | 'limited' | 'minimal'`

---

## Phase 7 — Zero-Trust Mesh (195 KB, 24 files)

**Bundle**: `runtime-phase7.bundle.js`

Builds a zero-trust security mesh over the runtime:
- Runtime forensics (tamper detection)
- Session recorder (tool usage events)
- Session persistence (IDB cross-navigation)
- Memory vault (short-TTL encrypted local cache)
- Origin validator (cross-frame message validation)
- Incident engine (anomaly → alert pipeline)
- Stability metrics

**Key global**: `window.RuntimeForensics.snapshot(type, ctx)`

---

## Phase 8 — Deferred Hardening (68 KB, 6 files)

**Bundle**: `runtime-phase8-deferred.bundle.js`

Hardens the runtime against edge-case failures:
- Packet validator (API request/response validation)
- Security telemetry (client-side threat reporting)
- Execution tickets (prevents duplicate processing)
- Crash recovery UI (graceful error screens)
- Deadlock monitor

**Key route**: `POST /api/security-telemetry` receives client-side anomaly reports

---

## Phase 9 — Infrastructure Layer (28 KB, 6 files)

**Bundle**: `runtime-phase9-infra.bundle.js`

Low-level infrastructure loaded synchronously (non-deferred):
- Server health monitor (latency, memory, traffic metrics)
- CSP nonce generation and injection
- Upload directory management
- Usage enforcement helpers

**Key endpoint**: `GET /api/server-health` returns runtime snapshot

---

## Arc 2 — Production Hardening (63 KB, 9 files)

**Bundle**: `runtime-arc2.bundle.js`

First production hardening Arc:
- T006: Worker lifecycle normalization (`window.WorkerLifecycle`)
- T007: Download orchestration (`window.DownloadManager`)
- T008: Retry orchestration safety (`window.RetryOrchestrator`)
- T009: Navigation cancellation safety (`window.NavCancel`)
- T010-T015: Adaptive degradation + lifecycle audit (`window.AdaptiveDegradation`, `window.Phase1CAudit`)
- T012: Shared cleanup contracts (`window.CleanupContracts` — 10 built-in contracts)

---

## Arc 3 — Tool Runtime Isolation (63 KB, 9 files)

**Bundle**: `runtime-arc3.bundle.js`

Isolates each tool's runtime from others:
- Per-tool state sandboxes
- Tool-level memory budgets
- Tool-level timeout guards
- Independent processing pipelines per tool

**Key philosophy**: A failure in one tool's runtime cannot cascade to another tool.

---

## Arc 4 — Enterprise Tool Runtime Completion (80 KB, 9 files)

**Bundle**: `runtime-arc4.bundle.js`

Completes the per-tool runtime with enterprise capabilities:
- Tool SLA tracking (expected vs actual processing time)
- Tool health scoring (success rate, latency p50/p95)
- Tool discovery registry (dynamic tool capability detection)
- Tool optimizer (auto-tunes parameters based on device profile)

---

## Arc 5 — True Enterprise Tool Isolation (83 KB, 9 files)

**Bundle**: `runtime-arc5.bundle.js`

Enforces hard isolation boundaries:
- Cross-tool state contamination prevention
- Worker claim exclusivity (a worker processing tool A cannot be hijacked by tool B)
- Output watermarking (result blobs tagged with generation context)
- Tool runtime versioning

---

## Arc 6 — Advanced Engine Full Decomposition (96 KB, 15 files)

**Bundle**: `runtime-arc6.bundle.js`

Decomposes the monolithic Advanced Engine into specialized subsystems:
- T020-T034: Core Runtime bootstrap
- `RuntimeScheduler` (T021): Task scheduling with priority queues
- `RuntimeWorkers` (T022): Worker orchestration with deduplication
- `RuntimeMemory` (T023): Memory controller (NORMAL/WARNING/CRITICAL tiers)
- `RuntimeQueue` (T024): Job queue engine (FIFO + priority)
- `RuntimeCancellation` (T025): Cancellation token system
- `RuntimeProgress` (T026): Progress tracking bus
- `RuntimeCleanup` (T027): Resource cleanup on tool complete/error
- `RuntimeTelemetry` (T028): Telemetry event bus
- `RuntimeAdapters` (T029): Per-tool adapter hook registry
- `RuntimeState` (T030): Shared runtime state
- `RuntimeHealth` (T031): Health monitor (CPU, memory, worker count)
- `RuntimeEventBus` (T032): Pub/sub event bus
- `RuntimeDiagnostics` (T033): DevTools diagnostics (call `RuntimeDiagnostics.print()`)
- `RuntimeStreaming` (T034): OPFS streaming v2.0 (10 MB threshold, 4 MB chunks)
- `CentralRuntime` v2.0.0 (T020): Master bootstrap coordinator

---

## Arc 7 — Ultra Performance + Streaming Runtime (79 KB, 8 files)

**Bundle**: `runtime-arc7.bundle.js`

Performance optimization layer:
- Giant file routing (`window.GiantFileRouting`) — files > 400 MB routed to OPFS streaming
- Giant file telemetry — performance metrics for large file operations
- GPU fallback validator — detects WebGPU availability and capabilities
- Canvas pool — reuses `<canvas>` elements to reduce GC pressure
- Differential processing — processes only changed page regions

---

## Arc 8 — Enterprise Observability + Live Control Plane (74 KB, 8 files)

**Bundle**: `runtime-arc8.bundle.js`

Real-time observability:
- Compare benchmark (tool A vs tool B result comparison)
- Compare runtime (multi-strategy comparison engine)
- Auto-tuning engine (dynamically adjusts DEVICE profile based on observed performance)
- Enterprise memory fabric (cross-session memory statistics)
- Distributed recovery (multi-strategy recovery from processing failures)

---

## Arc 9 — Autonomous Self-Healing + Distributed Intelligence (81 KB, 8 files)

**Bundle**: `runtime-arc9.bundle.js`

Self-healing capabilities:
- Autonomous agent system (monitors runtime health, triggers recovery)
- Autonomous AI workers (background intelligence tasks)
- Distributed AI orchestrator (coordinates multiple processing strategies)
- Generative AI engine (AI-assisted quality enhancement stubs)
- Hyperscale vector memory/fabric (semantic tool state memory)

---

## Arc 10D — Admin Observability Dashboard (83 KB, 14 files)

**Bundle**: `runtime-arc10.bundle.js`  
**Admin route**: `/debug`

The observability shell with **22 debug panels**:

| Panel | Purpose |
|-------|---------|
| `panel-control.js` | Master control panel — enable/disable features |
| `panel-performance.js` | Real-time performance metrics |
| `panel-timeline.js` | Processing event timeline |
| `panel-traces.js` | DebugTrace viewer |
| `panel-incidents.js` | Security + stability incident log |
| `panel-recovery.js` | Recovery action history |
| `panel-crash-survival.js` | Crash survival status |
| `panel-blackbox.js` | Black-box flight recorder |
| `panel-tab-mesh.js` | Cross-tab coordination status |
| `panel-persistent-storage.js` | IDB + OPFS storage status |
| `panel-recovery-memory.js` | Recovery memory state |
| `panel-deploy-resilience.js` | Deployment health |
| `panel-tool-health.js` | Per-tool health scores |
| `panel-tool-insights.js` | Tool usage patterns |
| `panel-tool-recovery.js` | Per-tool recovery events |
| `panel-tool-registry.js` | Registered tool adapters |
| `panel-tool-sla.js` | Per-tool SLA compliance |
| `panel-tool-circuit-breaker.js` | Circuit breaker states |
| `panel-tool-discovery.js` | Tool capability discovery log |
| `panel-tool-optimizer.js` | Auto-tuning recommendations |
| `panel-tool-persistence.js` | Tool state persistence log |
| `panel-tool-predictor.js` | Processing time predictions |

**Access**: Requires admin authentication (`/debug` → adminGuard)

---

## Arc 11 — Distributed Runtime Mesh + Persistent Diagnostics (109 KB, 13 files)

**Bundle**: `runtime-arc11.bundle.js`

Distributed mesh capabilities:
- Tab mesh (`window.TabMesh`): Coordinates processing across browser tabs
- Persistent diagnostics: Saves runtime state to IDB for cross-session analysis
- Runtime session recorder: Persistent event log with IDB backend
- Cross-tab worker sharing: Workers spawned in one tab usable from another
- Enterprise recovery v2: Multi-tier recovery with fallback chains

---

## Arc 12 — Enterprise Tool Intelligence Layer (ETIL) (88 KB, 14 files)

**Bundle**: `runtime-arc12.bundle.js`

Tool intelligence:
- Tool performance predictor (estimates processing time from file size + type)
- Tool health heatmap (visual health across all tools)
- Tool SLA enforcement (auto-cancels tasks that exceed SLA)
- Tool circuit breaker (opens after N consecutive failures, auto-resets)
- Tool insight aggregator (patterns from historical processing)

---

## Arc 13 — Persistent Tool Intelligence + Circuit Breaker (74 KB, 14 files)

**Bundle**: `runtime-arc13.bundle.js`

Persistent intelligence:
- Per-tool state persisted across sessions (IDB backend)
- Circuit breaker state persistence (survives page reload)
- Intelligence replay (replays historical events for training)
- Adaptive circuit breaker thresholds (auto-adjusts based on error rates)

---

## Arc 14 — Enterprise Runtime Command Center (ERTCC) (85 KB, 15 files)

**Bundle**: `runtime-arc14.bundle.js`

Command-and-control:
- `RuntimeCommandAnalytics` (`window.RuntimeCommandAnalytics`): Unified analytics bus
- Command center API: Programmatic control of all runtime subsystems
- Live control plane: Real-time configuration changes without page reload
- Tool killswitch: Disable specific tools without deployment
- Runtime policy engine (precursor to Arc 15)

**Note**: Named `RuntimeCommandAnalytics` (not `RuntimeAnalytics`) to avoid conflict with Phase 27 client analytics bus.

---

## Arc 15 — Enterprise Runtime Automation & Policy Orchestration (ERAPO) (98 KB, 15 files)

**Bundle**: `runtime-arc15.bundle.js`

Full policy automation:
- Policy engine: Define rules like "if error_rate > 20% for 5 min, open circuit"
- Automated remediation: Policies trigger actions (restart worker, flush cache, notify admin)
- SLA policy enforcement: Automated SLA violation handling
- Runtime audit log: Policy decisions recorded with timestamps
- Policy templates: Pre-built policies for common scenarios (memory pressure, high latency, etc.)
- Sitemap clean URL enforcement (added to this Arc)

**Key global**: `window.RuntimePolicy` — define + execute runtime policies

---

## Runtime Globals Reference

```javascript
// Core processing
window.BrowserTools        // Direct tool processing (browser-tools.js)
window.AdvancedEngine      // Wrapped processing with retry/guards (advanced-engine.js)

// Arc runtime systems
window.RuntimeWorkers      // Web Worker pool + orchestration
window.RuntimeScheduler    // Task priority scheduler
window.RuntimeMemory       // Memory pressure monitor
window.RuntimeQueue        // Job queue
window.RuntimeCancellation // Cancellation tokens
window.RuntimeProgress     // Progress bus
window.RuntimeCleanup      // Cleanup contracts
window.RuntimeTelemetry    // Telemetry bus
window.RuntimeState        // Shared state
window.RuntimeHealth       // Health monitor
window.RuntimeEventBus     // Pub/sub events
window.RuntimeAdapters     // Tool adapters
window.RuntimeDiagnostics  // DevTools diagnostics
window.RuntimeStreaming     // OPFS streaming engine
window.CentralRuntime      // Master coordinator

// Tool-specific runtimes
window.RotateRuntime       // Rotate PDF lifecycle
window.CompressRuntime     // Compress PDF lifecycle
window.EditRuntime         // Edit PDF lifecycle
window.CompareRuntime      // Compare PDF lifecycle
// ... etc per tool

// UI systems
window.PageOrganizer       // { shouldHandle, open, PAGE_LEVEL_TOOLS }
window.LivePreview         // { mount, supported }
window.PdfPreview          // PDF page thumbnail renderer

// Infrastructure
window.IDBCache            // IndexedDB CDN script cache
window.ToolState           // Session + IDB state persistence
window.UsageLimit          // Client-side usage tracking
window.OutputValidator     // Result quality validation
window.AdaptiveRuntime     // Device profile

// Observability
window.RuntimeForensics    // Tamper detection + snapshots
window.RuntimeSessionRecorder  // Event recording
window.RuntimeSessionPersistence // IDB persistence
window.RuntimeMemoryVault  // Short-TTL secure cache
window.StabilityMetrics    // Stability scoring
```
