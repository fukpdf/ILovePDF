#!/usr/bin/env node
/**
 * Regression guard for the homepage's first-paint bootstrap.
 * The catalogue is server-rendered; this helper may signal readiness but must
 * never invoke a second render or replace/refresh the initial DOM itself.
 */
import fs from 'node:fs';

const fastBoot = fs.readFileSync('public/js/home-fast-boot.js', 'utf8');
const home = fs.readFileSync('public/js/home.js', 'utf8');
const failures = [];
const pass = message => console.log('PASS:', message);
const fail = message => { failures.push(message); console.error('FAIL:', message); };

if (!/if\s*\(G\.__HOME_FAST_BOOT__\)\s*return/.test(fastBoot)) {
  fail('fast boot must have an idempotent guard');
} else pass('fast boot is idempotent');

for (const [label, pattern] of [
  ['category renderer', /G\.renderCategorySections\s*\(/],
  ['recent-tools renderer', /G\.renderRecentUse\s*\(/],
  ['icon repair hook', /G\.ensureHomepageToolCardIcons\s*\(/],
  ['Lucide DOM replacement', /G\.lucide\s*&&[\s\S]{0,100}createIcons\s*\(/],
  ['interval polling', /setInterval\s*\(/],
]) {
  if (pattern.test(fastBoot)) fail('fast boot must not invoke ' + label);
  else pass('fast boot does not invoke ' + label);
}

const readinessDispatches = (fastBoot.match(/ilovepdf:tool-groups-ready/g) || []).length;
if (readinessDispatches !== 1) fail('expected one readiness-event dispatch site, found ' + readinessDispatches);
else pass('one readiness-event dispatch site');

if (!/function\s+renderCategorySections\s*\(/.test(home) ||
    !/function\s+renderRecentUse\s*\(/.test(home) ||
    !/function\s+bootHomePage\s*\(/.test(home)) {
  fail('home.js must retain the authoritative render and boot functions');
} else pass('home.js retains authoritative rendering and boot sequence');

if (!/renderRecentUse\(\);[\s\S]*renderCategorySections\(\);/.test(home)) {
  fail('home.js boot must continue to own homepage rendering');
} else pass('homepage rendering remains owned by home.js');

if (failures.length) {
  console.error('Homepage fast-boot audit: BLOCKED (' + failures.length + ' failure(s))');
  process.exit(1);
}
console.log('Homepage fast-boot audit: PASS');
