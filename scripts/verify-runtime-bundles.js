#!/usr/bin/env node
// scripts/verify-runtime-bundles.js — Phase 9 bundle integrity verifier
// Checks that all bundle files exist, are non-empty, contain their
// expected source modules, and that the manifest is up-to-date.
//
// Exit 0: all bundles healthy
// Exit 1: one or more bundles missing or corrupt
//
// Usage:
//   node scripts/verify-runtime-bundles.js

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'public', 'js', 'bundles');
const MANIFEST   = path.join(BUNDLE_DIR, 'bundle-manifest.json');

let pass = 0, fail = 0, warn = 0;

function ok(check, detail)   { pass++; console.log('  [✓] ' + check + ': ' + detail); }
function bad(check, detail)  { fail++; console.log('  [✗] ' + check + ': ' + detail); }
function warn_(check, detail){ warn++; console.log('  [⚠] ' + check + ': ' + detail); }

// ── Expected bundles + key sentinel modules ────────────────────────────────────
const EXPECTED = [
  {
    file:      'runtime-phase6-core.bundle.js',
    minBytes:  1000,
    sentinels: ['runtime-shadow-runtime'],
  },
  {
    file:      'runtime-phase6-deferred.bundle.js',
    minBytes:  5000,
    sentinels: ['runtime-secure-session', 'runtime-wasm-fortress', 'runtime-anomaly-engine'],
  },
  {
    file:      'runtime-phase7.bundle.js',
    minBytes:  10000,
    sentinels: ['runtime-human-signals', 'runtime-incident-engine', 'runtime-packet-integrity'],
  },
  {
    file:      'runtime-phase8-deferred.bundle.js',
    minBytes:  3000,
    sentinels: ['runtime-csp-enforcer', 'runtime-tab-mesh', 'runtime-memory-vault'],
  },
  {
    file:      'runtime-phase9-infra.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeNetworkState', 'RuntimeMemoryRecovery', 'RuntimeWorkerPrewarm'],
  },
  {
    file:      'runtime-arc2.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeDeploySync', 'RuntimeHydrationScheduler', 'RuntimeCrashTelemetry',
                'RuntimeWorkerCoordinator', 'RuntimeHealthAnalytics'],
  },
  {
    file:      'runtime-arc3.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeToolManifestRegistry', 'RuntimeToolLoader', 'RuntimeHydrationDomains',
                'RuntimeWorkerDomainRegistry', 'RuntimeMemoryIslands',
                'RuntimeAnalyticsDomains', 'RuntimeRecoveryDomains',
                'RuntimeToolBundleSegments', 'RuntimeToolConfigLock'],
  },
  {
    file:      'runtime-arc4.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeWorkerDomainThrottle', 'RuntimeOfflineDomains', 'RuntimeProcessorRegistry',
                'RuntimeBundleGraph', 'RuntimeToolSandbox', 'RuntimeMemoryOrchestrator',
                'RuntimeHealthOrchestrator', 'RuntimeImmutabilityGuard', 'RuntimeMobileHardening'],
  },
  {
    file:      'runtime-arc5.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeToolWorkerMesh', 'RuntimeToolCodeLoader', 'RuntimeMemoryFirewalls',
                'RuntimeRecoveryFirewalls', 'RuntimeToolEventFirewall', 'RuntimeToolConfigSeal',
                'RuntimeToolHealthDomains', 'RuntimeToolBundleIsolation', 'RuntimeToolOfflineFirewalls'],
  },
  {
    file:      'runtime-arc6.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeMergeProcessor', 'RuntimeSplitProcessor', 'RuntimeCompressProcessor',
                'RuntimeOcrProcessor', 'RuntimeImageProcessor', 'RuntimeAiProcessor',
                'RuntimeConvertProcessor', 'RuntimeWatermarkProcessor', 'RuntimeRepairProcessor',
                'RuntimeProcessorLoader', 'RuntimeProcessorMemory', 'RuntimeProcessorWorkers',
                'RuntimeProcessorHydration', 'RuntimeProcessorBundles', 'RuntimeProcessorHealth'],
  },
  {
    file:      'runtime-arc7.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeStreamingHydration', 'RuntimePredictiveLoader', 'RuntimeStreamWorkers',
                'RuntimeTaskOrchestrator', 'RuntimeSmartCache', 'RuntimeStreamTelemetry',
                'RuntimeSelfOptimizer', 'RuntimeMobileExtremeMode'],
  },
  {
    file:      'runtime-arc8.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeControlPlane', 'RuntimeLiveDashboard', 'RuntimeTraceEngine',
                'RuntimeEventTimeline', 'RuntimePerformanceProfiler', 'RuntimeIncidentCenter',
                'RuntimeStateSnapshots', 'RuntimeReplayEngine'],
  },
  {
    file:      'runtime-arc9.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeAutonomousHealing', 'RuntimeWorkloadIntelligence', 'RuntimeSessionStability',
                'RuntimeRecoveryOrchestrator', 'RuntimeAdaptiveAI', 'RuntimeGovernance',
                'RuntimeBlackbox', 'RuntimeAdaptiveBundles'],
  },
  {
    file:      'runtime-arc10.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeDebugSecurity', 'RuntimeDebugState', 'RuntimeDebugStorage',
                'RuntimeDebugRenderer', 'RuntimeDebugMobile', 'RuntimeDebugExport',
                'RuntimeDebugShell', 'PanelIncidents', 'PanelTimeline', 'PanelBlackbox',
                'PanelRecovery', 'PanelPerformance', 'PanelControl', 'PanelTraces'],
  },
  {
    file:      'runtime-arc11.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeTabMesh', 'RuntimeBlackboxStorage', 'RuntimeCrashSurvival',
                'RuntimeSWBridge', 'RuntimeDistributedWorkload', 'RuntimeIncidentCorrelation',
                'RuntimeRecoveryMemory', 'RuntimeDeployResilience',
                'PanelTabMesh', 'PanelPersistentStorage', 'PanelRecoveryMemory',
                'PanelDeployResilience', 'PanelCrashSurvival'],
  },
  {
    file:      'runtime-arc12.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeToolRegistry', 'RuntimeToolHealth', 'RuntimeToolDependencies',
                'RuntimeToolIsolation', 'RuntimeToolPredictor', 'RuntimeToolProfiler',
                'RuntimeToolRecovery', 'RuntimeToolOptimizer', 'RuntimeToolExport',
                'PanelToolRegistry', 'PanelToolHealth', 'PanelToolPredictor',
                'PanelToolRecovery', 'PanelToolOptimizer'],
  },
  {
    file:      'runtime-arc13.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeToolPersistence', 'RuntimeToolCircuitBreaker', 'RuntimeToolSLA',
                'RuntimeToolDiscovery', 'RuntimeToolRanking', 'RuntimeToolAnomaly',
                'RuntimeToolLifecycle', 'RuntimeToolInsights', 'RuntimeToolExportExtended',
                'PanelToolPersistence', 'PanelToolCircuitBreaker', 'PanelToolSLA',
                'PanelToolDiscovery', 'PanelToolInsights'],
  },
  {
    file:      'runtime-arc14.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimeCommandCenter', 'RuntimeTopology', 'RuntimeHeatmaps',
                'RuntimeCommandAnalytics', 'RuntimeAlerts', 'RuntimeFleetManager',
                'RuntimeForecast', 'RuntimeReports', 'RuntimeCommandExport',
                'PanelCommandCenter', 'PanelTopology', 'PanelHeatmaps',
                'PanelAlerts', 'PanelAnalytics', 'PanelFleet'],
  },
  {
    file:      'runtime-arc15.bundle.js',
    minBytes:  5000,
    sentinels: ['RuntimePolicyEngine', 'RuntimeAutomationEngine', 'RuntimeWorkflowEngine',
                'RuntimeDecisionEngine', 'RuntimeResourceOrchestrator', 'RuntimeAutonomousOps',
                'RuntimePolicyAnalytics', 'RuntimePolicyReports', 'RuntimePolicyExport',
                'PanelPolicyEngine', 'PanelAutomationEngine', 'PanelWorkflowEngine',
                'PanelAutonomousOps', 'PanelPolicyAnalytics', 'PanelDecisionEngine'],
  },
];

console.log('\n[VerifyBundles] ════════════════════════════════');
console.log('[VerifyBundles] Phase 9 Bundle Integrity Check');
console.log('[VerifyBundles] ────────────────────────────────\n');

// ── Check bundle directory ────────────────────────────────────────────────────
if (!fs.existsSync(BUNDLE_DIR)) {
  bad('bundle-dir', 'Missing directory: ' + path.relative(ROOT, BUNDLE_DIR) +
    ' — run: node scripts/build-runtime-bundles.js');
  console.log('\n[VerifyBundles] Result: FAIL | Pass:', pass, '| Fail:', fail, '| Warn:', warn);
  process.exit(1);
}
ok('bundle-dir', path.relative(ROOT, BUNDLE_DIR) + ' exists');

// ── Check manifest ────────────────────────────────────────────────────────────
let manifest = null;
if (fs.existsSync(MANIFEST)) {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const age = Math.floor((Date.now() - manifest.ts) / 60000);
    ok('manifest', 'bundle-manifest.json present (age: ' + age + ' min, buildId: ' + manifest.buildId + ')');
  } catch (e) {
    warn_('manifest', 'bundle-manifest.json parse error: ' + e.message);
  }
} else {
  warn_('manifest', 'bundle-manifest.json missing — run build first');
}

// ── Check each bundle ─────────────────────────────────────────────────────────
let allOk = true;
for (const spec of EXPECTED) {
  const absPath = path.join(BUNDLE_DIR, spec.file);
  const rel     = path.relative(ROOT, absPath);

  if (!fs.existsSync(absPath)) {
    bad('bundle:' + spec.file, 'FILE MISSING — run: node scripts/build-runtime-bundles.js');
    allOk = false;
    continue;
  }

  const stat = fs.statSync(absPath);
  if (stat.size < spec.minBytes) {
    bad('bundle:' + spec.file, 'Too small (' + stat.size + ' bytes < ' + spec.minBytes + ' min)');
    allOk = false;
    continue;
  }
  ok('bundle:' + spec.file, stat.size + ' bytes (' + (stat.size / 1024).toFixed(1) + ' KB)');

  // Sentinel checks — verify source modules are concatenated inside
  const src = fs.readFileSync(absPath, 'utf8');
  for (const sentinel of spec.sentinels) {
    if (src.includes(sentinel)) {
      ok('sentinel:' + sentinel, 'found in ' + spec.file);
    } else {
      bad('sentinel:' + sentinel, 'NOT FOUND in ' + spec.file + ' — bundle may be stale or corrupt');
      allOk = false;
    }
  }
}

// ── Cross-check manifest vs actual files ──────────────────────────────────────
if (manifest && Array.isArray(manifest.bundles)) {
  for (const b of manifest.bundles) {
    const absPath = path.join(BUNDLE_DIR, b.name);
    if (fs.existsSync(absPath)) {
      const stat = fs.statSync(absPath);
      if (Math.abs(stat.size - b.bytes) > 100) {
        warn_('manifest-size:' + b.name,
          'size mismatch (manifest=' + b.bytes + ' actual=' + stat.size + ') — rebuild?');
      }
    }
    if (b.missing > 0) {
      warn_('bundle-missing:' + b.name, b.missing + ' source file(s) were missing during last build');
    }
  }
}

// ── Arc 15 integrity: debug.html reference ────────────────────────────────────
const _arc15DebugHtmlPath = path.join(ROOT, 'public', 'debug.html');
console.log('\n[VerifyBundles] Arc 15 integrity checks:');
if (fs.existsSync(_arc15DebugHtmlPath)) {
  const _dh15 = fs.readFileSync(_arc15DebugHtmlPath, 'utf8');
  if (_dh15.includes('runtime-arc15.bundle.js')) {
    ok('arc15-debug-ref', 'runtime-arc15.bundle.js referenced in debug.html');
  } else {
    warn_('arc15-debug-ref', 'runtime-arc15.bundle.js NOT referenced in debug.html');
  }
} else {
  warn_('arc15-debug-ref', 'debug.html not found');
}

// ── Arc 14 integrity: debug.html reference ────────────────────────────────────
const _arc14DebugHtmlPath = path.join(ROOT, 'public', 'debug.html');
console.log('\n[VerifyBundles] Arc 14 integrity checks:');
if (fs.existsSync(_arc14DebugHtmlPath)) {
  const _dh14 = fs.readFileSync(_arc14DebugHtmlPath, 'utf8');
  if (_dh14.includes('runtime-arc14.bundle.js')) {
    ok('arc14-debug-ref', 'runtime-arc14.bundle.js referenced in debug.html');
  } else {
    warn_('arc14-debug-ref', 'runtime-arc14.bundle.js NOT referenced in debug.html');
  }
} else {
  warn_('arc14-debug-ref', 'debug.html not found');
}

// ── Arc 13 integrity: debug.html reference ────────────────────────────────────
const _arc13DebugHtmlPath = path.join(ROOT, 'public', 'debug.html');
console.log('\n[VerifyBundles] Arc 13 integrity checks:');
if (fs.existsSync(_arc13DebugHtmlPath)) {
  const _dh13 = fs.readFileSync(_arc13DebugHtmlPath, 'utf8');
  if (_dh13.includes('runtime-arc13.bundle.js')) {
    ok('arc13-debug-ref', 'runtime-arc13.bundle.js referenced in debug.html');
  } else {
    warn_('arc13-debug-ref', 'runtime-arc13.bundle.js NOT referenced in debug.html');
  }
} else {
  warn_('arc13-debug-ref', 'debug.html not found');
}

// ── Arc 12 integrity: debug.html reference ────────────────────────────────────
const _arc12DebugHtmlPath = path.join(ROOT, 'public', 'debug.html');
console.log('\n[VerifyBundles] Arc 12 integrity checks:');
if (fs.existsSync(_arc12DebugHtmlPath)) {
  const _dh12 = fs.readFileSync(_arc12DebugHtmlPath, 'utf8');
  if (_dh12.includes('runtime-arc12.bundle.js')) {
    ok('arc12-debug-ref', 'runtime-arc12.bundle.js referenced in debug.html');
  } else {
    warn_('arc12-debug-ref', 'runtime-arc12.bundle.js NOT referenced in debug.html');
  }
} else {
  warn_('arc12-debug-ref', 'debug.html not found');
}

// ── Arc 11 integrity: debug.html reference + tab mesh v2.0 ────────────────────
console.log('\n[VerifyBundles] Arc 11 integrity checks:');
const debugHtmlPath = path.join(ROOT, 'public', 'debug.html');
if (fs.existsSync(debugHtmlPath)) {
  const debugHtml = fs.readFileSync(debugHtmlPath, 'utf8');
  if (debugHtml.includes('runtime-arc11.bundle.js')) {
    ok('arc11-debug-ref', 'runtime-arc11.bundle.js referenced in debug.html');
  } else {
    warn_('arc11-debug-ref', 'runtime-arc11.bundle.js NOT referenced in debug.html');
  }
} else {
  warn_('arc11-debug-ref', 'debug.html not found');
}

const arc11BundlePath = path.join(BUNDLE_DIR, 'runtime-arc11.bundle.js');
if (fs.existsSync(arc11BundlePath)) {
  const arc11Src = fs.readFileSync(arc11BundlePath, 'utf8');
  if (arc11Src.includes('RuntimeTabMesh') && /VERSION\s*=\s*'2\.0'/.test(arc11Src)) {
    ok('arc11-tabmesh-v2', 'RuntimeTabMesh v2.0 confirmed in arc11 bundle');
  } else {
    warn_('arc11-tabmesh-v2', 'RuntimeTabMesh v2.0 marker not found in arc11 bundle');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n[VerifyBundles] ────────────────────────────────');
console.log('[VerifyBundles] Result:', fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : 'PASS',
  '| Pass:', pass, '| Fail:', fail, '| Warn:', warn);
console.log('[VerifyBundles] ════════════════════════════════\n');

process.exit(fail > 0 ? 1 : 0);
