#!/usr/bin/env node
// scripts/build-runtime-bundles.js — Phase 9 runtime bundle builder
// Concatenates groups of Phase 6–8 runtime JS files into minified-style
// bundles so tool.html can load fewer script tags (304 → ≤ 265 target).
//
// Bundles produced:
//   public/js/bundles/runtime-phase6-core.bundle.js      — Phase 6 non-deferred
//   public/js/bundles/runtime-phase6-deferred.bundle.js  — Phase 6 deferred
//   public/js/bundles/runtime-phase7.bundle.js           — Phase 7 all deferred
//   public/js/bundles/runtime-phase8-deferred.bundle.js  — Phase 8 deferred only
//
// Usage:
//   node scripts/build-runtime-bundles.js [--dry-run]

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(ROOT, 'public', 'js', 'bundles');
const DRY_RUN   = process.argv.includes('--dry-run');

const BUILD_ID  = Date.now().toString(36);

// ── Bundle definitions ────────────────────────────────────────────────────────
// Each bundle is an array of public/js relative paths in load order.
// They must all share the same defer status in tool.html to be safe to bundle.

const BUNDLES = [
  {
    name:     'runtime-phase6-core.bundle.js',
    label:    'Phase 6 Non-Deferred Core',
    deferred: false,
    files: [
      'public/js/runtime-shadow-runtime.js',
    ],
  },
  {
    name:     'runtime-phase6-deferred.bundle.js',
    label:    'Phase 6 Deferred',
    deferred: true,
    files: [
      'public/js/runtime-secure-session.js',
      'public/js/runtime-edge-attestation.js',
      'public/js/runtime-hybrid-execution.js',
      'public/js/runtime-capability-manager.js',
      'public/js/runtime-execution-sandbox.js',
      'public/js/runtime-wasm-fortress.js',
      'public/js/runtime-wasm-isolation.js',
      'public/js/runtime-wasm-encrypted-loader.js',
      'public/js/runtime-encrypted-chunks.js',
      'public/js/runtime-tokenized-loader.js',
      'public/js/runtime-threat-correlation.js',
      'public/js/runtime-anomaly-engine.js',
    ],
  },
  {
    name:     'runtime-phase7.bundle.js',
    label:    'Phase 7 Zero-Trust Mesh',
    deferred: true,
    files: [
      'public/js/runtime-human-signals.js',
      'public/js/runtime-automation-detection.js',
      'public/js/runtime-behavior-analysis.js',
      'public/js/runtime-worker-mesh.js',
      'public/js/runtime-worker-auth.js',
      'public/js/runtime-worker-encryption.js',
      'public/js/runtime-worker-routing.js',
      'public/js/runtime-edge-policy.js',
      'public/js/runtime-edge-proof.js',
      'public/js/runtime-edge-runtime.js',
      'public/js/runtime-deployment-registry.js',
      'public/js/runtime-build-chain.js',
      'public/js/runtime-release-channel.js',
      'public/js/runtime-session-keys.js',
      'public/js/runtime-execution-crypto.js',
      'public/js/runtime-packet-integrity.js',
      'public/js/runtime-wasm-mesh.js',
      'public/js/runtime-wasm-scheduler.js',
      'public/js/runtime-wasm-attestation.js',
      'public/js/runtime-incident-engine.js',
      'public/js/runtime-forensics.js',
      'public/js/runtime-session-recorder.js',
      'public/js/runtime-security-stream.js',
      'public/js/runtime-security-visualizer.js',
    ],
  },
  {
    name:     'runtime-phase8-deferred.bundle.js',
    label:    'Phase 8 Deferred Hardening',
    deferred: true,
    files: [
      'public/js/runtime-session-persistence.js',
      'public/js/runtime-forensics-replay.js',
      'public/js/runtime-csp-enforcer.js',
      'public/js/runtime-threat-intel.js',
      'public/js/runtime-tab-mesh.js',
      'public/js/runtime-memory-vault.js',
    ],
  },
  {
    name:     'runtime-phase9-infra.bundle.js',
    label:    'Phase 9 Infrastructure Layer',
    deferred: false,
    files: [
      'public/js/runtime-network-state.js',
      'public/js/runtime-memory-recovery.js',
      'public/js/runtime-lazy-engine-loader.js',
      'public/js/runtime-performance-monitor.js',
      'public/js/runtime-stream-pipeline.js',
      'public/js/runtime-worker-prewarm.js',
    ],
  },
  {
    name:     'runtime-arc2.bundle.js',
    label:    'Arc 2 Production Hardening',
    deferred: true,
    files: [
      'public/js/runtime-deploy-sync.js',
      'public/js/runtime-html-version-guard.js',
      'public/js/runtime-hydration-scheduler.js',
      'public/js/runtime-crash-telemetry.js',
      'public/js/runtime-bundle-registry.js',
      'public/js/runtime-offline-processor.js',
      'public/js/runtime-worker-coordinator.js',
      'public/js/runtime-edge-hints.js',
      'public/js/runtime-health-analytics.js',
    ],
  },
  {
    name:     'runtime-arc3.bundle.js',
    label:    'Arc 3 Tool Runtime Isolation',
    deferred: true,
    files: [
      'public/js/runtime-tool-manifest-registry.js',
      'public/js/runtime-tool-loader.js',
      'public/js/runtime-hydration-domains.js',
      'public/js/runtime-worker-domain-registry.js',
      'public/js/runtime-memory-islands.js',
      'public/js/runtime-analytics-domains.js',
      'public/js/runtime-recovery-domains.js',
      'public/js/runtime-tool-bundle-segments.js',
      'public/js/runtime-tool-config-lock.js',
    ],
  },
  {
    name:     'runtime-arc4.bundle.js',
    label:    'Arc 4 Enterprise Tool Runtime Completion',
    deferred: true,
    files: [
      'public/js/runtime-worker-domain-throttle.js',
      'public/js/runtime-offline-domains.js',
      'public/js/runtime-processor-registry.js',
      'public/js/runtime-bundle-graph.js',
      'public/js/runtime-tool-sandbox.js',
      'public/js/runtime-memory-orchestrator.js',
      'public/js/runtime-health-orchestrator.js',
      'public/js/runtime-immutability-guard.js',
      'public/js/runtime-mobile-hardening.js',
    ],
  },
  {
    name:     'runtime-arc5.bundle.js',
    label:    'Arc 5 True Enterprise Tool Isolation',
    deferred: true,
    files: [
      'public/js/runtime-tool-worker-mesh.js',
      'public/js/runtime-tool-code-loader.js',
      'public/js/runtime-memory-firewalls.js',
      'public/js/runtime-recovery-firewalls.js',
      'public/js/runtime-tool-event-firewall.js',
      'public/js/runtime-tool-config-seal.js',
      'public/js/runtime-tool-health-domains.js',
      'public/js/runtime-tool-bundle-isolation.js',
      'public/js/runtime-tool-offline-firewalls.js',
    ],
  },
  {
    name:     'runtime-arc6.bundle.js',
    label:    'Arc 6 Advanced Engine Full Decomposition',
    deferred: true,
    files: [
      'public/js/processors/merge-processor.js',
      'public/js/processors/split-processor.js',
      'public/js/processors/compress-processor.js',
      'public/js/processors/ocr-processor.js',
      'public/js/processors/image-processor.js',
      'public/js/processors/ai-processor.js',
      'public/js/processors/convert-processor.js',
      'public/js/processors/watermark-processor.js',
      'public/js/processors/repair-processor.js',
      'public/js/runtime-processor-loader.js',
      'public/js/runtime-processor-memory.js',
      'public/js/runtime-processor-workers.js',
      'public/js/runtime-processor-hydration.js',
      'public/js/runtime-processor-bundles.js',
      'public/js/runtime-processor-health.js',
    ],
  },
  {
    name:     'runtime-arc7.bundle.js',
    label:    'Arc 7 Ultra Performance + Streaming Runtime',
    deferred: true,
    files: [
      'public/js/runtime-streaming-hydration.js',
      'public/js/runtime-predictive-loader.js',
      'public/js/runtime-stream-workers.js',
      'public/js/runtime-task-orchestrator.js',
      'public/js/runtime-smart-cache.js',
      'public/js/runtime-stream-telemetry.js',
      'public/js/runtime-self-optimizer.js',
      'public/js/runtime-mobile-extreme.js',
    ],
  },
  {
    name:     'runtime-arc8.bundle.js',
    label:    'Arc 8 Enterprise Observability + Live Control Plane',
    deferred: true,
    files: [
      'public/js/runtime-control-plane.js',
      'public/js/runtime-live-dashboard.js',
      'public/js/runtime-trace-engine.js',
      'public/js/runtime-event-timeline.js',
      'public/js/runtime-performance-profiler.js',
      'public/js/runtime-incident-center.js',
      'public/js/runtime-state-snapshots.js',
      'public/js/runtime-replay-engine.js',
    ],
  },
  {
    name:     'runtime-arc9.bundle.js',
    label:    'Arc 9 Autonomous Self-Healing + Distributed Runtime Intelligence',
    deferred: true,
    files: [
      'public/js/runtime-autonomous-healing.js',
      'public/js/runtime-workload-intelligence.js',
      'public/js/runtime-session-stability.js',
      'public/js/runtime-recovery-orchestrator.js',
      'public/js/runtime-adaptive-ai.js',
      'public/js/runtime-governance.js',
      'public/js/runtime-blackbox.js',
      'public/js/runtime-adaptive-bundles.js',
    ],
  },
  {
    name:     'runtime-arc10.bundle.js',
    label:    'Arc 10D Admin Observability Dashboard',
    deferred: true,
    files: [
      'public/js/runtime-debug-security.js',
      'public/js/runtime-debug-state.js',
      'public/js/runtime-debug-storage.js',
      'public/js/runtime-debug-renderer.js',
      'public/js/runtime-debug-mobile.js',
      'public/js/runtime-debug-export.js',
      'public/js/runtime-debug-shell.js',
      'public/js/debug-panels/panel-incidents.js',
      'public/js/debug-panels/panel-timeline.js',
      'public/js/debug-panels/panel-blackbox.js',
      'public/js/debug-panels/panel-recovery.js',
      'public/js/debug-panels/panel-performance.js',
      'public/js/debug-panels/panel-control.js',
      'public/js/debug-panels/panel-traces.js',
    ],
  },
  {
    name:     'runtime-arc11.bundle.js',
    label:    'Arc 11 Distributed Runtime Mesh + Persistent Diagnostics',
    deferred: true,
    files: [
      // Phase A — Tab Mesh v2.0 (singleton guard prevents double-load with phase8-deferred)
      'public/js/runtime-tab-mesh.js',
      // Phase B — IndexedDB blackbox persistence
      'public/js/runtime-blackbox-storage.js',
      // Phase C — Crash detection + cross-reload recovery
      'public/js/runtime-crash-survival.js',
      // Phase D — Service Worker diagnostics bridge
      'public/js/runtime-sw-bridge.js',
      // Phase E — Cross-tab workload balancing
      'public/js/runtime-distributed-workload.js',
      // Phase F — Cross-tab/session incident correlation
      'public/js/runtime-incident-correlation.js',
      // Phase G — Adaptive recovery strategy memory
      'public/js/runtime-recovery-memory.js',
      // Phase H — Safe deploy transition management
      'public/js/runtime-deploy-resilience.js',
      // Phase I — Arc 11 debug panels (lazy-loaded by debug shell)
      'public/js/debug-panels/panel-tab-mesh.js',
      'public/js/debug-panels/panel-persistent-storage.js',
      'public/js/debug-panels/panel-recovery-memory.js',
      'public/js/debug-panels/panel-deploy-resilience.js',
      'public/js/debug-panels/panel-crash-survival.js',
    ],
  },
];

// ── Build ─────────────────────────────────────────────────────────────────────
let totalIn  = 0;
let totalOut = 0;

if (!DRY_RUN && !fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('[bundle] Created output dir:', OUT_DIR);
}

const manifest = [];

for (const bundle of BUNDLES) {
  const parts = [];
  let missingCount = 0;

  parts.push(
    '// ── ' + bundle.label + ' — Phase 9 build bundle ──────────────────────────\n' +
    '// Generated: ' + new Date().toISOString() + '  BUILD_ID: ' + BUILD_ID + '\n' +
    '// Files: ' + bundle.files.length + '\n\n'
  );

  for (const relFile of bundle.files) {
    const absFile = path.join(ROOT, relFile);
    if (!fs.existsSync(absFile)) {
      console.warn('[bundle]   MISSING:', relFile);
      missingCount++;
      continue;
    }
    const src = fs.readFileSync(absFile, 'utf8');
    totalIn += src.length;
    parts.push('// ── SOURCE: ' + relFile + ' ──\n');
    parts.push(src);
    parts.push('\n');
  }

  const content  = parts.join('');
  const byteSize = Buffer.byteLength(content, 'utf8'); // actual on-disk bytes
  const hash     = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  const outPath  = path.join(OUT_DIR, bundle.name);

  if (!DRY_RUN) {
    fs.writeFileSync(outPath, content, 'utf8');
  }

  totalOut += byteSize;
  const rel = path.relative(ROOT, outPath);

  manifest.push({
    name:     bundle.name,
    label:    bundle.label,
    deferred: bundle.deferred,
    files:    bundle.files.length,
    missing:  missingCount,
    bytes:    byteSize,
    hash:     hash,
    path:     rel,
  });

  const status = missingCount > 0 ? '⚠' : '✓';
  console.log('[bundle] ' + status + ' ' + bundle.name +
    '  ' + bundle.files.length + ' files  ' +
    (byteSize / 1024).toFixed(1) + ' KB' +
    (missingCount ? '  (' + missingCount + ' missing)' : ''));
}

// Write manifest
if (!DRY_RUN) {
  const manifestPath = path.join(OUT_DIR, 'bundle-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ buildId: BUILD_ID, ts: Date.now(), bundles: manifest }, null, 2));
  console.log('[bundle] Manifest written to:', path.relative(ROOT, manifestPath));
}

const ratio = totalIn > 0 ? (totalOut / totalIn * 100).toFixed(1) : '—';
console.log('\n[bundle] Done. Input:', (totalIn / 1024).toFixed(1),
  'KB → Output:', (totalOut / 1024).toFixed(1), 'KB  ratio:', ratio + '%');
console.log('[bundle] Bundles saved to:', path.relative(ROOT, OUT_DIR));
if (DRY_RUN) console.log('[bundle] DRY-RUN — no files written.');
