#!/usr/bin/env node
/**
 * Read-only repository regression scan for the retired Laba feature.
 * Use --assert-clean to fail if dedicated assets or active application references return.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const directFiles = [];
const externalRefs = [];
const remainingDedicatedPaths = files.filter(relative => relative !== 'scripts/laba-removal-audit.js' && (/((^|\/)laba([-/]|\.)|laba-)/i.test(relative) || /(^|\/)homepage-lazy-loader\.js$/i.test(relative)));
const layoutRefs = [];
const hideRefs = [];
let scanned = 0;

for (const relative of files) {
  if (relative.startsWith('.git/')) continue;
  let content;
  try { content = fs.readFileSync(path.resolve(relative), 'utf8'); } catch { continue; }
  if (content.includes('\u0000')) continue;
  scanned++;
  const lines = content.split(/\r?\n/);
  const matches = [];
  lines.forEach((line, index) => {
    if (/style\.display\s*=\s*['"]none|hidden\s*=\s*true|setAttribute\(['"]hidden|querySelectorAll\(['"](?:section|\.home-cat-section)/i.test(line)) {
      hideRefs.push({ path: relative, line: index + 1, text: line.trim().slice(0, 180) });
    }
    if (/cat-image-tools|cat-utilities|home-cat-section|ilpdf-announcement-intro/.test(line)) {
      layoutRefs.push({ path: relative, line: index + 1, text: line.trim().slice(0, 180) });
    }
    if (/\blaba\b|laba[-/]|homepage-lazy-loader/i.test(line)) {
      matches.push({ line: index + 1, text: line.trim().slice(0, 200) });
    }
  });
  if (relative === 'scripts/laba-removal-audit.js') continue;
  if (!matches.length) continue;
  const dedicated = /(^|\/)laba([-/]|\.)|laba-/i.test(relative) ||
    /(^|\/)laba\//i.test(relative) ||
    /(^|\/)homepage-lazy-loader\.js$/i.test(relative);
  const entry = { path: relative, matches: matches.length, examples: matches.slice(0, 8) };
  if (dedicated) directFiles.push(entry);
  else externalRefs.push(entry);
}

console.log('LABA REMOVAL AUDIT — READ ONLY');
console.log('Tracked text files scanned: ' + scanned);
console.log('Remaining dedicated Laba/lazy-loader paths: ' + remainingDedicatedPaths.length);
for (const item of remainingDedicatedPaths) console.log('REMAINING DEDICATED PATH ' + item);
console.log('Laba-specific files with references: ' + directFiles.length);
console.log('Other files with Laba references: ' + externalRefs.length);
console.log('\nLaba-specific files:');
for (const item of directFiles) console.log('DEDICATED ' + item.path + ' (' + item.matches + ' refs)');
console.log('\nReferences outside Laba-specific files:');
for (const item of externalRefs) {
  console.log('REFERENCE ' + item.path + ' (' + item.matches + ' refs)');
  for (const example of item.examples) console.log('  L' + example.line + ': ' + example.text);
}
console.log('\nHomepage category/layout references (for CLS diagnosis):');
for (const item of layoutRefs) console.log('LAYOUT ' + item.path + ':L' + item.line + ': ' + item.text);
console.log('\nPotential generic section-hiding code (first 120 matches):');
for (const item of hideRefs.slice(0, 120)) console.log('HIDE ' + item.path + ':L' + item.line + ': ' + item.text);
console.log('\\nActive application-code references:');
const historicalOrTestPath = relative =>
  relative.startsWith('docs/') ||
  relative.startsWith('scripts/') ||
  relative.startsWith('.github/workflows/') ||
  /\\.(?:md|txt)$/i.test(relative) ||
  relative === 'README.md' ||
  relative === 'CONTRIBUTING.md';
const activeRefs = externalRefs.filter(item => !historicalOrTestPath(item.path));
for (const item of activeRefs) console.log('ACTIVE REFERENCE ' + item.path + ' (' + item.matches + ' refs)');
console.log('\\nRemaining references in docs/tests/removal guards are historical or intentional and should be reviewed separately.');
if (process.argv.includes('--assert-clean')) {
  if (remainingDedicatedPaths.length || directFiles.length || activeRefs.length) {
    console.error('FAIL: retired Laba files or active application references remain');
    process.exitCode = 1;
  } else {
    console.log('PASS: no dedicated Laba assets or active application-code references remain');
  }
}
