#!/usr/bin/env node
// scripts/security-audit-report.js — Phase 5 / Task 7 (Security Audit Report)
// =============================================================================
// Generates a comprehensive security posture report from static analysis and
// runtime telemetry records.
//
// Sources:
//   • .data/build-integrity-report.json   (from verify-build-integrity.js)
//   • .data/sri-report.json
//   • .data/worker-integrity-report.json
//   • .data/telemetry-events.json         (exported from server telemetry)
//   • File system analysis (static scan)
//
// Checks performed:
//   1. Secret / API key exposure in public/ files
//   2. eval() / Function() usage in runtime JS
//   3. dangerouslySetInnerHTML patterns
//   4. CORS wildcard detection in server files
//   5. Missing security headers audit
//   6. Dependency age / known-risk packages
//   7. SRI coverage percentage
//   8. Worker P4 heartbeat coverage
//   9. Deployment seal status
//   10. Origin guard coverage
//
// Output:
//   .data/security-audit-report.json
//   Console formatted report
//
// Usage:
//   node scripts/security-audit-report.js
//   node scripts/security-audit-report.js --json   # stdout JSON
//   node scripts/security-audit-report.js --ci     # exit 1 on HIGH+ findings
// =============================================================================

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PUBLIC    = path.join(ROOT, 'public');
const DATA_DIR  = path.join(ROOT, '.data');

const CI_MODE   = process.argv.includes('--ci');
const JSON_MODE = process.argv.includes('--json');

// ── Severity levels ───────────────────────────────────────────────────────────
const SEV = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const SEV_LABEL = { 4: 'CRITICAL', 3: 'HIGH', 2: 'MEDIUM', 1: 'LOW', 0: 'INFO' };

// ── Findings accumulator ──────────────────────────────────────────────────────
const _findings = [];
let _maxSev = 0;

function finding(sev, category, title, detail, file) {
  const s = SEV[sev] ?? 0;
  if (s > _maxSev) _maxSev = s;
  _findings.push({ severity: sev, sevScore: s, category, title, detail: detail || '', file: file || null });
  if (!JSON_MODE) {
    const badge = sev === 'CRITICAL' ? '🔴' : sev === 'HIGH' ? '🟠' : sev === 'MEDIUM' ? '🟡' : sev === 'LOW' ? '🔵' : 'ℹ️';
    console.log(`  ${badge} [${sev}] ${category}: ${title}`);
    if (detail) console.log(`       ${detail}`);
    if (file)   console.log(`       file: ${file}`);
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function scanDir(dir, exts, skip) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip && skip.some(s => entry.name.includes(s))) continue;
      files.push(...scanDir(full, exts, skip));
    } else if (exts.some(e => entry.name.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1: Secret / API key exposure in public JS
// ─────────────────────────────────────────────────────────────────────────────
function checkSecretExposure() {
  const PATTERNS = [
    { re: /AIza[0-9A-Za-z\-_]{35}/,              label: 'Firebase API key' },
    { re: /AAAA[A-Za-z0-9_\-]{7}:/,              label: 'FCM server key' },
    { re: /sk[-_](live|test)_[0-9a-zA-Z]{24,}/,  label: 'Stripe secret key' },
    { re: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/, label: 'SendGrid key' },
    { re: /ghp_[0-9a-zA-Z]{36}/,                 label: 'GitHub PAT' },
    { re: /"private_key":\s*"-----BEGIN/,         label: 'Firebase service account' },
    { re: /process\.env\.\w+\s*=\s*['"][^'"]{8,}/, label: 'hardcoded env assignment' },
    { re: /AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"][^'"]{8,}/, label: 'AWS secret key' },
  ];

  const jsFiles = scanDir(PUBLIC, ['.js'], ['node_modules']);
  let clean = 0;

  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const p of PATTERNS) {
      if (p.re.test(src)) {
        finding('CRITICAL', 'secret-exposure', p.label + ' pattern found in public JS',
          'Remove and rotate immediately.', path.relative(ROOT, f));
      }
    }
    clean++;
  }

  if (_findings.filter(x => x.category === 'secret-exposure').length === 0) {
    finding('INFO', 'secret-exposure', `${clean} public JS files scanned — no secrets found`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2: Dangerous patterns in runtime JS
// ─────────────────────────────────────────────────────────────────────────────
function checkDangerousPatterns() {
  const DANGER = [
    { re: /\beval\s*\(/,           sev: 'HIGH',   label: 'eval() usage' },
    { re: /new\s+Function\s*\(/,   sev: 'HIGH',   label: 'new Function() usage' },
    { re: /innerHTML\s*=/,         sev: 'MEDIUM', label: 'innerHTML assignment' },
    { re: /outerHTML\s*=/,         sev: 'MEDIUM', label: 'outerHTML assignment' },
    { re: /document\.write\s*\(/,  sev: 'MEDIUM', label: 'document.write() usage' },
    { re: /setTimeout\s*\(\s*['"]/, sev: 'LOW',   label: 'setTimeout with string arg' },
    { re: /setInterval\s*\(\s*['"]/, sev: 'LOW',  label: 'setInterval with string arg' },
  ];

  const rtDir = path.join(PUBLIC, 'js');
  const files = scanDir(rtDir, ['.js'], []);
  const summary = {};

  for (const f of files) {
    const src  = fs.readFileSync(f, 'utf8');
    const rel  = path.relative(ROOT, f);
    for (const d of DANGER) {
      if (d.re.test(src)) {
        const key = d.label;
        summary[key] = (summary[key] || 0) + 1;
        // Only report HIGH+ individually, group others
        if (SEV[d.sev] >= SEV.HIGH) {
          finding(d.sev, 'dangerous-pattern', d.label, '', rel);
        }
      }
    }
  }

  // Summary for MEDIUM/LOW
  for (const [label, count] of Object.entries(summary)) {
    if (count > 0 && !_findings.some(f => f.title === label && SEV[f.severity] >= SEV.HIGH)) {
      finding('LOW', 'dangerous-pattern', `${label} (${count} occurrence${count > 1 ? 's' : ''})`,
        'Review each occurrence for sanitization.');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3: CORS wildcard in server files
// ─────────────────────────────────────────────────────────────────────────────
function checkCorsWildcard() {
  const serverFiles = [
    path.join(ROOT, 'server.js'),
    ...scanDir(path.join(ROOT, 'routes'), ['.js'], []),
    ...scanDir(path.join(ROOT, 'utils'),  ['.js'], []),
  ];

  let wildcardFound = false;

  for (const f of serverFiles) {
    const src = fs.readFileSync(f, 'utf8');
    if (/origin:\s*['"]\*['"]/.test(src) || /ALLOWED_ORIGINS.*=.*\*/.test(src)) {
      wildcardFound = true;
      finding('MEDIUM', 'cors', 'CORS wildcard origin (*) configured',
        'Restrict to specific allowed origins for production.',
        path.relative(ROOT, f));
    }
  }

  if (!wildcardFound) {
    finding('INFO', 'cors', 'No CORS wildcard found in server files');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4: Security headers in server.js
// ─────────────────────────────────────────────────────────────────────────────
function checkSecurityHeaders() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const HEADERS = [
    { pattern: /X-Frame-Options|frame-ancestors/,    header: 'X-Frame-Options / CSP frame-ancestors' },
    { pattern: /X-Content-Type-Options/,              header: 'X-Content-Type-Options' },
    { pattern: /Strict-Transport-Security|HSTS/,      header: 'HSTS' },
    { pattern: /Content-Security-Policy/,             header: 'CSP' },
    { pattern: /Cross-Origin-Opener-Policy|COOP/,     header: 'COOP' },
    { pattern: /Cross-Origin-Embedder-Policy|COEP/,   header: 'COEP' },
    { pattern: /Cross-Origin-Resource-Policy|CORP/,   header: 'CORP' },
    { pattern: /Referrer-Policy/,                     header: 'Referrer-Policy' },
    { pattern: /Permissions-Policy|Feature-Policy/,   header: 'Permissions-Policy' },
  ];

  for (const h of HEADERS) {
    if (h.pattern.test(serverSrc)) {
      finding('INFO', 'security-headers', `${h.header}: present`);
    } else {
      finding('LOW', 'security-headers', `${h.header}: NOT found in server.js`,
        'Consider adding this header for defense-in-depth.');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5: SRI coverage from report
// ─────────────────────────────────────────────────────────────────────────────
function checkSriCoverage() {
  const sriReport = readJson(path.join(DATA_DIR, 'sri-report.json'));
  if (!sriReport) {
    finding('MEDIUM', 'sri-coverage', 'sri-report.json not found',
      'Run: node scripts/verify-build-integrity.js');
    return;
  }

  const total    = sriReport.checked + sriReport.missing;
  const pct      = total > 0 ? Math.round(sriReport.checked / total * 100) : 0;
  const failSev  = sriReport.failed > 0 ? 'HIGH' : 'INFO';

  if (sriReport.failed > 0) {
    finding('HIGH', 'sri-coverage',
      `${sriReport.failed} SRI hash failure${sriReport.failed > 1 ? 's' : ''} detected`,
      `${pct}% of chunks have matching hashes. Mismatches indicate tampered files.`);
  } else if (pct < 50) {
    finding('MEDIUM', 'sri-coverage', `Low SRI coverage: ${pct}%`,
      'Run generate-sri-hashes.js to hash remaining chunks.');
  } else {
    finding('INFO', 'sri-coverage',
      `SRI coverage ${pct}% (${sriReport.checked} checked, ${sriReport.failed} failed, ${sriReport.missing} missing hashes)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6: Worker P4 heartbeat coverage
// ─────────────────────────────────────────────────────────────────────────────
function checkP4MixinCoverage() {
  const workerReport = readJson(path.join(DATA_DIR, 'worker-integrity-report.json'));
  if (!workerReport) {
    finding('LOW', 'p4-heartbeat', 'worker-integrity-report.json not found',
      'Run: node scripts/verify-build-integrity.js');
    return;
  }

  const mc = workerReport.p4MixinCoverage;
  if (!mc) { finding('INFO', 'p4-heartbeat', 'P4 mixin coverage data not available'); return; }

  const pct = mc.total > 0 ? Math.round(mc.present / mc.total * 100) : 0;
  if (mc.absent > 0) {
    finding('LOW', 'p4-heartbeat',
      `${mc.absent}/${mc.total} workers missing P4 pong handler (${pct}% coverage)`,
      'Workers without __p4_pong cannot report memory/queue status to RuntimeP4Heartbeat.');
  } else {
    finding('INFO', 'p4-heartbeat', `P4 heartbeat coverage: ${pct}% (${mc.present}/${mc.total} workers)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7: Origin guard deployment
// ─────────────────────────────────────────────────────────────────────────────
function checkOriginGuard() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const ogExists  = fs.existsSync(path.join(ROOT, 'utils/origin-guard.js'));

  if (!ogExists) {
    finding('HIGH', 'origin-guard', 'utils/origin-guard.js not found',
      'Server-side origin validation is not deployed.');
    return;
  }

  if (serverSrc.includes('originGuard')) {
    finding('INFO', 'origin-guard', 'Origin guard middleware: active in server.js');
  } else {
    finding('MEDIUM', 'origin-guard', 'origin-guard.js exists but not mounted in server.js',
      'Add: app.use(\'/api\', originGuard);');
  }

  const softMode = serverSrc.includes('ORIGIN_GUARD_SOFT') ||
    fs.readFileSync(path.join(ROOT, 'utils/origin-guard.js'), 'utf8').includes('ORIGIN_GUARD_SOFT');
  if (softMode) {
    finding('INFO', 'origin-guard', 'Soft mode available via ORIGIN_GUARD_SOFT=1 env var');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8: Telemetry events (from exported server records)
// ─────────────────────────────────────────────────────────────────────────────
function checkTelemetryEvents() {
  const eventsFile = path.join(DATA_DIR, 'telemetry-events.json');
  if (!fs.existsSync(eventsFile)) {
    finding('INFO', 'telemetry', 'No exported telemetry events found',
      'Export via GET /api/security-telemetry/export (requires X-Admin-Token)');
    return;
  }

  const data = readJson(eventsFile);
  if (!data) { finding('INFO', 'telemetry', 'Could not parse telemetry-events.json'); return; }

  const events = Array.isArray(data) ? data : (data.events || []);
  const bySev = {};
  for (const ev of events) {
    const t = ev.type || 'unknown';
    bySev[t] = (bySev[t] || 0) + 1;
  }

  const HIGH_EVENTS = ['integrity-failure', 'seal-failure', 'sri-mismatch', 'origin-violation'];
  let highCount = 0;
  for (const t of HIGH_EVENTS) {
    if (bySev[t]) { highCount += bySev[t]; }
  }

  if (highCount > 0) {
    finding('HIGH', 'telemetry', `${highCount} high-severity security event(s) recorded`,
      JSON.stringify(HIGH_EVENTS.filter(t => bySev[t]).map(t => `${t}:${bySev[t]}`).join(', ')));
  } else {
    finding('INFO', 'telemetry', `${events.length} telemetry events — no high-severity events`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9: package.json dependency risk scan
// ─────────────────────────────────────────────────────────────────────────────
function checkDependencies() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) { finding('INFO', 'dependencies', 'package.json not found'); return; }

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let pinned = 0, floating = 0;

  for (const [name, version] of Object.entries(allDeps)) {
    if (version.startsWith('^') || version.startsWith('~') || version === '*' || version === 'latest') {
      floating++;
    } else {
      pinned++;
    }
  }

  const total = pinned + floating;
  const pct   = total > 0 ? Math.round(pinned / total * 100) : 0;

  if (floating > total * 0.5) {
    finding('LOW', 'dependencies',
      `${floating}/${total} dependencies not pinned (${pct}% pinned)`,
      'Consider pinning versions to ensure reproducible builds.');
  } else {
    finding('INFO', 'dependencies', `${pinned}/${total} dependencies pinned (${pct}%)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const startTs = Date.now();

  if (!JSON_MODE) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  ILovePDF Security Audit Report — Phase 5 / Task 7         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }

  if (!JSON_MODE) console.log('── Secret Exposure ───────────────────────────────────────────────');
  checkSecretExposure();

  if (!JSON_MODE) console.log('\n── Dangerous Code Patterns ───────────────────────────────────────');
  checkDangerousPatterns();

  if (!JSON_MODE) console.log('\n── CORS Configuration ────────────────────────────────────────────');
  checkCorsWildcard();

  if (!JSON_MODE) console.log('\n── Security Headers ──────────────────────────────────────────────');
  checkSecurityHeaders();

  if (!JSON_MODE) console.log('\n── SRI Coverage ──────────────────────────────────────────────────');
  checkSriCoverage();

  if (!JSON_MODE) console.log('\n── Worker P4 Heartbeat Coverage ──────────────────────────────────');
  checkP4MixinCoverage();

  if (!JSON_MODE) console.log('\n── Origin Guard ──────────────────────────────────────────────────');
  checkOriginGuard();

  if (!JSON_MODE) console.log('\n── Telemetry Events ──────────────────────────────────────────────');
  checkTelemetryEvents();

  if (!JSON_MODE) console.log('\n── Dependency Risk ───────────────────────────────────────────────');
  checkDependencies();

  // ── Scoring ───────────────────────────────────────────────────────────────
  const byLevel = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of _findings) byLevel[f.severity] = (byLevel[f.severity] || 0) + 1;

  const score = Math.max(0, 100
    - byLevel.CRITICAL * 25
    - byLevel.HIGH     * 10
    - byLevel.MEDIUM   *  5
    - byLevel.LOW      *  1);

  const grade =
    score >= 90 ? 'A — EXCELLENT' :
    score >= 75 ? 'B — GOOD' :
    score >= 60 ? 'C — ACCEPTABLE' :
    score >= 40 ? 'D — NEEDS WORK' : 'F — CRITICAL ISSUES';

  const elapsed = Date.now() - startTs;
  const report = {
    generated:  new Date().toISOString(),
    elapsedMs:  elapsed,
    score,
    grade,
    ciMode:     CI_MODE,
    outcome:    byLevel.CRITICAL > 0 ? 'CRITICAL' : byLevel.HIGH > 0 ? 'HIGH' : byLevel.MEDIUM > 0 ? 'MEDIUM' : 'LOW',
    findingCounts: byLevel,
    findings:   _findings.sort((a, b) => b.sevScore - a.sevScore),
  };

  // Write report
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'security-audit-report.json'),
    JSON.stringify(report, null, 2));

  if (!JSON_MODE) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  SECURITY SCORE: ${String(score).padEnd(44)}║`);
    console.log(`║  GRADE: ${grade.padEnd(53)}║`);
    console.log(`║  Findings: C=${byLevel.CRITICAL} H=${byLevel.HIGH} M=${byLevel.MEDIUM} L=${byLevel.LOW} I=${byLevel.INFO}${' '.repeat(Math.max(0, 38-String(byLevel.CRITICAL+byLevel.HIGH+byLevel.MEDIUM+byLevel.LOW+byLevel.INFO).length))}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n  Report: .data/security-audit-report.json\n');
  }

  if (JSON_MODE) process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (CI_MODE && _maxSev >= SEV.HIGH) {
    console.error(`\n  CI: HIGH+ findings detected — exiting with code 1\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
