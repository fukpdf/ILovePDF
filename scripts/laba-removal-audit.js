#!/usr/bin/env node
/**
 * Read-only repository inventory for the planned Laba removal.
 * Reports direct references before deletion; it never edits files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const directFiles = [];
const externalRefs = [];
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
    if (/laba|homepage-lazy-loader/i.test(line)) {
      matches.push({ line: index + 1, text: line.trim().slice(0, 200) });
    }
  });
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
console.log('Laba-specific files with references: ' + directFiles.length);
console.log('Other files with Laba references: ' + externalRefs.length);
console.log('\nLaba-specific files:');
for (const item of directFiles) console.log('DEDICATED ' + item.path + ' (' + item.matches + ' refs)');
console.log('\nReferences outside Laba-specific files:');
for (const item of externalRefs) {
  console.log('REFERENCE ' + item.path + ' (' + item.matches + ' refs)');
  for (const example of item.examples) console.log('  L' + example.line + ': ' + example.text);
}
console.log('\nThis report is an inventory only. Do not delete shared files until each external reference is classified.');
