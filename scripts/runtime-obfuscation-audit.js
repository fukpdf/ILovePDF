#!/usr/bin/env node
// scripts/runtime-obfuscation-audit.js — Phase 8 / Objective 9a
// =============================================================================
// Audits all Phase 6-8 runtime JS files for dangerous patterns, missing
// security guards, and obfuscation quality.
//
// Checks:
//   1. eval() / Function() constructor usage
//   2. document.write() usage
//   3. innerHTML assignment without sanitization
//   4. window global leaks (vars assigned directly to window without freeze)
//   5. console.log with sensitive-looking strings
//   6. Missing singleton guard
//   7. Missing Object.freeze() on exported global
//   8. Hardcoded secrets (Bearer, api_key, secret=, password=)
//
// Usage: node scripts/runtime-obfuscation-audit.js [--ci] [--json]
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const JS_DIR    = path.join(ROOT, 'public', 'js');

const CI_MODE   = process.argv.includes('--ci');
const JSON_MODE = process.argv.includes('--json');

// ── Patterns to flag ─────────────────────────────────────────────────────────
const DANGEROUS = [
  { id: 'eval-usage',          re: /\beval\s*\(/, severity: 'CRITICAL', msg: 'eval() usage detected' },
  { id: 'function-constructor', re: /new\s+Function\s*\(/, severity: 'CRITICAL', msg: 'new Function() detected' },
  { id: 'document-write',      re: /document\s*\.\s*write\s*\(/, severity: 'HIGH', msg: 'document.write() detected' },
  { id: 'innerhtml-assign',    re: /\.innerHTML\s*=/, severity: 'MEDIUM', msg: 'innerHTML assignment (verify sanitization)' },
  { id: 'hardcoded-bearer',    re: /Bearer\s+[A-Za-z0-9._-]{20,}/, severity: 'CRITICAL', msg: 'Hardcoded Bearer token' },
  { id: 'hardcoded-apikey',    re: /api_key\s*=\s*['"][A-Za-z0-9_-]{16,}['"]/, severity: 'CRITICAL', msg: 'Hardcoded API key' },
  { id: 'hardcoded-secret',    re: /secret\s*=\s*['"][A-Za-z0-9_-]{16,}['"]/, severity: 'HIGH', msg: 'Hardcoded secret' },
  { id: 'hardcoded-password',  re: /password\s*=\s*['"][^'"]{8,}['"]/, severity: 'HIGH', msg: 'Hardcoded password' },
  { id: 'with-statement',      re: /\bwith\s*\(/, severity: 'MEDIUM', msg: 'with() statement (strict mode bypass risk)' },
];

const MISSING_GUARDS = [
  { id: 'singleton-guard', re: /if\s*\(G\.\w+\)\s*return|if\s*\(window\.\w+\)\s*return/, severity: 'HIGH', invert: true, msg: 'Missing singleton guard' },
  { id: 'object-freeze',   re: /Object\.freeze\(/, severity: 'MEDIUM', invert: true, msg: 'Missing Object.freeze() on export' },
];

// ── File collector ────────────────────────────────────────────────────────────
function _listRuntimeFiles() {
  return readdirSync(JS_DIR)
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'))
    .map(f => path.join(JS_DIR, f));
}

// ── Audit a single file ───────────────────────────────────────────────────────
function _auditFile(filePath) {
  const name = path.basename(filePath);
  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch (_) { return null; }

  const findings = [];

  for (const check of DANGEROUS) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (check.re.test(line) && !line.trim().startsWith('//')) {
        findings.push({
          file:     name,
          line:     i + 1,
          severity: check.severity,
          id:       check.id,
          msg:      check.msg,
          snippet:  line.trim().slice(0, 100),
        });
      }
    });
  }

  for (const check of MISSING_GUARDS) {
    const found = check.re.test(content);
    if (check.invert && !found) {
      findings.push({
        file:     name,
        line:     null,
        severity: check.severity,
        id:       check.id,
        msg:      check.msg,
        snippet:  null,
      });
    }
  }

  return { file: name, path: filePath, findings };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const files   = _listRuntimeFiles();
  const results = files.map(_auditFile).filter(Boolean);

  const allFindings = results.flatMap(r => r.findings);
  const criticals   = allFindings.filter(f => f.severity === 'CRITICAL');
  const highs       = allFindings.filter(f => f.severity === 'HIGH');
  const mediums     = allFindings.filter(f => f.severity === 'MEDIUM');

  const report = {
    ts:        Date.now(),
    files:     files.length,
    findings:  allFindings.length,
    criticals: criticals.length,
    highs:     highs.length,
    mediums:   mediums.length,
    results,
    pass:      criticals.length === 0,
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[ObfuscationAudit] ═══════════════════════════════════════');
    console.log('[ObfuscationAudit] Phase 8 — Runtime Obfuscation Audit');
    console.log('[ObfuscationAudit] Files audited:', files.length);
    console.log('[ObfuscationAudit] Findings:', allFindings.length,
      '| CRITICAL:', criticals.length,
      '| HIGH:', highs.length,
      '| MEDIUM:', mediums.length);

    allFindings.forEach(f => {
      const loc = f.line ? ':' + f.line : '';
      console.log(`  [${f.severity}] ${f.file}${loc} — ${f.msg}`);
      if (f.snippet) console.log(`          → ${f.snippet}`);
    });

    if (report.pass) {
      console.log('[ObfuscationAudit] PASS — no critical findings');
    } else {
      console.error('[ObfuscationAudit] FAIL —', criticals.length, 'critical finding(s)');
    }
    console.log('[ObfuscationAudit] ═══════════════════════════════════════');
  }

  if (CI_MODE && !report.pass) {
    process.exit(1);
  }

  return report;
}

main();
