#!/usr/bin/env node
/**
 * Lighthouse-based rendering certification for the assembled homepage and a
 * representative PDF upload route. These are lab gates, not field CWV claims.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.RENDERING_BASE_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'lighthouse-rendering');
fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: 'homepage', url: BASE + '/' },
  { name: 'compress-pdf', url: BASE + '/compress-pdf' },
];
const profiles = [
  { name: 'mobile', desktop: false },
  { name: 'desktop', desktop: true },
];
const lighthouseBin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse');
const chromePath = chromium.executablePath();
const failures = [];
const results = [];
const fail = message => { failures.push(message); console.error('FAIL:', message); };

if (!fs.existsSync(lighthouseBin)) {
  console.error('Lighthouse CLI is missing. Install lighthouse@12.8.2 in the isolated browser QA step.');
  process.exit(1);
}
if (!fs.existsSync(chromePath)) {
  console.error('Playwright Chromium executable is missing: ' + chromePath);
  process.exit(1);
}

for (const target of targets) {
  for (const profile of profiles) {
    const name = target.name + '-' + profile.name;
    const reportPath = path.join(OUT_DIR, name + '.json');
    const args = [
      target.url,
      '--chrome-flags=--headless --no-sandbox',
      '--output=json',
      '--output-path=' + reportPath,
      '--only-categories=performance',
      '--quiet',
    ];
    if (profile.desktop) args.push('--preset=desktop');

    console.log('LIGHTHOUSE_CERTIFICATION_START ' + JSON.stringify({ target: target.name, profile: profile.name, url: target.url }));
    const run = spawnSync(lighthouseBin, args, {
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, CHROME_PATH: chromePath },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error) {
      fail(name + ': Lighthouse process error: ' + run.error.message);
      continue;
    }
    if (run.status !== 0) {
      fail(name + ': Lighthouse exited with status ' + run.status);
      continue;
    }
    if (!fs.existsSync(reportPath)) {
      fail(name + ': Lighthouse report was not written');
      continue;
    }

    let report;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
    catch (error) {
      fail(name + ': invalid Lighthouse JSON: ' + String(error.message || error));
      continue;
    }
    const auditValue = id => {
      const value = report.audits?.[id]?.numericValue;
      return Number.isFinite(value) ? value : null;
    };
    const result = {
      target: target.name,
      profile: profile.name,
      url: report.finalUrl || target.url,
      performanceScore: Number.isFinite(report.categories?.performance?.score)
        ? Math.round(report.categories.performance.score * 100)
        : null,
      fcpMs: auditValue('first-contentful-paint'),
      lcpMs: auditValue('largest-contentful-paint'),
      cls: auditValue('cumulative-layout-shift'),
      speedIndexMs: auditValue('speed-index'),
      tbtMs: auditValue('total-blocking-time'),
      lcpElement: report.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.node?.snippet || null,
      reportPath: path.relative(process.cwd(), reportPath),
    };
    results.push(result);
    console.log('LIGHTHOUSE_CERTIFICATION_RESULT ' + JSON.stringify(result));

    if (result.fcpMs === null || result.fcpMs > 1800) fail(name + ': FCP missing or exceeds 1.8s (' + result.fcpMs + 'ms)');
    if (result.lcpMs === null || result.lcpMs > 2500) fail(name + ': LCP missing or exceeds 2.5s (' + result.lcpMs + 'ms)');
    if (result.cls === null || result.cls > 0.1) fail(name + ': CLS missing or exceeds 0.1 (' + result.cls + ')');
  }
}

console.log('LIGHTHOUSE_CERTIFICATION_SUMMARY ' + JSON.stringify({ runs: results.length, expectedRuns: 4, failures: failures.length, results }));
if (results.length !== 4) fail('Expected 4 Lighthouse reports; got ' + results.length);
if (failures.length) {
  console.error('Lighthouse rendering certification BLOCKED: ' + failures.join('; '));
  process.exit(1);
}
console.log('Lighthouse rendering certification PASSED for homepage and compress-pdf on mobile and desktop.');
