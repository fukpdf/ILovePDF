#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path = 'public/js/runtime-stream-bridge.js';
const src = fs.readFileSync(path, 'utf8');
const checks = [
  ['transferable messageerror finalizes with transfer finalizer',
    /finishTransferRuntimeError\(new Error\('stream-worker-message-error'\)\)/.test(src)],
  ['chunk messageerror finalizes with chunk finalizer',
    /finishRuntimeError\(new Error\('stream-worker-message-error'\)\)/.test(src)],
  ['multi-file messageerror finalizes with multi-file finalizer',
    /w\.onmessageerror\s*=\s*function\(\)\s*\{\s*finishError\(new Error\('stream-worker-message-error'\)\);/.test(src)],
  ['transferable messageerror is terminal-guarded',
    /w\.onmessageerror = function \(\) \{\s*if \(entry\.terminal\) return;\s*finishTransferRuntimeError/.test(src)],
  ['chunk messageerror is terminal-guarded',
    /w\.onmessageerror = function \(\) \{\s*if \(entry\.terminal\) return;\s*finishRuntimeError/.test(src)],
  ['multi-file messageerror exists',
    /w\.onmessageerror\s*=\s*function\(\)\s*\{\s*finishError/.test(src)],
  ['runtime stream bridge syntax',
    (() => { try { execFileSync(process.execPath, ['--check', path], {stdio:'pipe'}); return true; } catch { return false; } })()]
];

let passed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
  if (ok) passed++;
}
console.log(`Unit 44 stream messageerror finalization audit: ${passed}/${checks.length}`);
if (passed !== checks.length) process.exit(1);
