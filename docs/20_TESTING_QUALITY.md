# 20 — TESTING & QUALITY

## Current Test Coverage

There is no formal automated test suite. Quality assurance is maintained through:
1. **Manual testing** by developers on every feature change
2. **Build validation scripts** that verify bundle integrity
3. **Runtime quality scoring** (AdvancedEngine → OutputValidator)
4. **Admin observability** panels (22 debug panels with live metrics)
5. **Circuit breakers** (Arc 12-13) — auto-detect and quarantine broken tools

---

## Build Validation Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `verify-runtime-bundles.js` | Verifies all bundles exist, have correct hash, expected file count |
| `verify-build-integrity.js` | Full build integrity check (files + sizes + structure) |
| `enterprise-ci-gate.js` | CI gate: runs all 4 validation gates (files, size, hash, labels) |
| `enterprise-build-seal.js` | Creates build seal (signs the build manifest) |
| `enterprise-release-audit.js` | Full release audit report |
| `generate-sri-hashes.js` | Generates SRI (Subresource Integrity) hashes for bundles |
| `runtime-consistency-check.js` | Verifies runtime globals are registered correctly |
| `runtime-obfuscation-audit.js` | Checks for accidental global exposure |
| `runtime-attack-simulation.js` | Simulates attack patterns against the runtime |
| `security-audit-report.js` | Generates security audit report |
| `security-regression-check.js` | Checks for security regressions |
| `worker-integrity-check.js` | Verifies Web Worker files |
| `verify-deployment-signature.js` | Verifies production deployment signature |

---

## Runtime Quality Validation

### OutputValidator (`window.OutputValidator`)

After every `processFiles()` call, `OutputValidator.check(toolId, result)` validates:

| Check | Tools | Validation |
|-------|-------|-----------|
| PDF magic bytes | All PDF tools | Result blob starts with `%PDF-` |
| Minimum file size | All | Result > 100 bytes |
| Maximum file size | Compress | Result < input (compression actually happened) |
| Image format | PDF-to-JPG | Result is valid JPEG |
| DOCX format | PDF-to-Word | Result is valid ZIP (DOCX) |
| XLSX format | PDF-to-Excel | Result is valid ZIP (XLSX) |
| Non-empty result | All | Blob size > 0 |

Failed validation → triggers retry (up to 2 retries via AdvancedEngine).  
All retries failed → shows error to user with actionable message.

---

## AdvancedEngine Quality Scoring

After successful processing, AdvancedEngine computes a quality score (0-100):

```javascript
function scoreResult(toolId, input, output, processingTime) {
  let score = 100;

  // Size checks
  if (output.size < 100) score -= 50;  // suspicious
  if (toolId === 'compress' && output.size >= input.size) score -= 30;

  // Time check (too fast = suspicious)
  if (processingTime < 100) score -= 10;

  // Tool-specific checks
  if (toolId === 'merge' && output.size < input[0].size) score -= 20;

  return Math.max(0, score);
}
```

Scores < 50 → logged to `RuntimeTelemetry` + retry attempted.

---

## DebugTrace System

`window.DebugTrace` — per-request tracing:

```javascript
// Created at start of each processFiles() call
const trace = window.DebugTrace.create(toolId);
trace.mark('start');
trace.mark('worker-dispatched');
trace.mark('worker-completed');
trace.mark('output-validated');
trace.end();

// View in admin: panel-traces.js shows timeline + duration per mark
window.DebugTrace.getAll() → [{ traceId, toolId, marks: [...], duration, success }]
```

---

## Arc Validation Gates

The `enterprise-ci-gate.js` script runs 4 gates that must all pass:

### Gate 1: File Count
All 19 bundles must exist. Expected counts:
```
runtime-phase6-core:     1 source file
runtime-phase6-deferred: 12 source files
runtime-phase7:          24 source files
runtime-phase8-deferred: 6 source files
runtime-phase9-infra:    6 source files
runtime-arc2 through arc15: 9-15 files each
```

### Gate 2: Bundle Sizes
Each bundle must be within expected size range (±10%):
```
arc2: 63 KB ± 7 KB
arc15: 98 KB ± 10 KB
... etc
```

### Gate 3: Hash Integrity
Bundle content hash must match `bundle-manifest.json` hash field.

### Gate 4: Labels
`bundle-manifest.json` must contain correct `label` for each bundle.

**Pass threshold**: All 4 gates at 0 failures → build is sealed.

---

## Performance Monitoring

### Client-side (`RuntimeHealth`)

Monitors in real-time:
- `performance.memory.jsHeapSizeLimit` — heap limit
- `performance.memory.usedJSHeapSize` — current heap
- `navigator.hardwareConcurrency` — CPU cores
- Tool processing latency (p50, p95, p99)
- Worker spawn time
- CDN library load time

Thresholds:
- Memory `NORMAL` → `WARNING` at 60% heap usage
- Memory `WARNING` → `CRITICAL` at 80% heap usage
- At CRITICAL: auto-cancel current job, GC suggestion

### Server-side (`utils/server-health-monitor.js`)

```javascript
GET /api/server-health
// Returns: memory (heapUsed/Total/RSS), latency percentiles, request counts, uptime
```

`requestTimingMiddleware()` tracks response time for every request, maintains rolling window for percentile calculation.

---

## Error Handling Quality

### Client-side error classification

```javascript
function classifyError(err) {
  if (err.name === 'AbortError') return 'cancelled';
  if (err.aeType === ERR.MEMORY)  return 'memory-error';
  if (err.aeType === ERR.TIMEOUT) return 'timeout';
  if (err.aeType === ERR.WORKER)  return 'worker-crash';
  if (err.aeType === ERR.PARSE)   return 'corrupt-file';
  return 'unexpected';
}
```

User-facing messages:
- `memory-error`: "Your device doesn't have enough memory. Try a smaller file."
- `timeout`: "Processing timed out. Try splitting the file into smaller parts."
- `worker-crash`: "Processing failed. Please try again."
- `corrupt-file`: "This PDF file appears to be damaged or in an unsupported format."

### Server-side error classification

```javascript
function clientErrStatus(err) {
  const msg = (err && err.message) || '';
  // Input validation errors → 400
  if (/no (file|text|page|input)|invalid|not found|empty|corrupt|no text/i.test(msg))
    return 400;
  // Everything else → 500
  return 500;
}
```

---

## Browser Compatibility

Tested and supported:
| Browser | Minimum version | Notes |
|---------|----------------|-------|
| Chrome / Chromium | 90+ | Full feature set |
| Firefox | 88+ | Full feature set |
| Safari | 14+ | No SharedArrayBuffer without COOP/COEP |
| Edge | 90+ | Full feature set |
| Mobile Chrome | Android 9+ | Touch PageOrganizer |
| Mobile Safari | iOS 14+ | Limited Web Worker pool size |

**Graceful degradation for older browsers**:
- OPFS unavailable → falls back to memory processing
- Web Workers unavailable → main thread processing
- IDB unavailable → CDN libraries always fetched from network
- SharedArrayBuffer unavailable → ArrayBuffer copy mode

---

## Known Limitations

| Tool | Limitation | Workaround |
|------|-----------|-----------|
| OCR | English-focused, accuracy varies | Use high-DPI scans |
| PDF-to-Word | Complex layouts lose formatting | Simple text-heavy PDFs work best |
| AI Summarize | Extractive only (not abstractive) | Works well for 5+ page documents |
| Translate | MyMemory API (2500 chars/request) | Long documents chunked; quality varies |
| Compress | May not reduce size if already optimized | Shows "already optimised" message |
| Password-protect | qpdf fallback if not installed | pdf-lib metadata mark (less secure) |

---

## Build Process Quality

### bundle-manifest.json
Generated by `scripts/build-runtime-bundles.js` on each bundle rebuild.
Contains: `buildId`, timestamp, per-bundle details (name, label, files, missing, bytes, hash, path).

**SRI hashes**: `scripts/generate-sri-hashes.js` generates SHA-384 hashes for CDN-loaded resources. Can be used to add `integrity` attributes to `<script>` tags for external CDN scripts.
