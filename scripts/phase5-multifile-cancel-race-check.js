#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path = 'public/js/runtime-stream-bridge.js';
const src = fs.readFileSync(path, 'utf8');
const start = src.indexOf('async function streamFilesToWorkerReadable');
const end = src.indexOf('// ── Cancel all on pagehide', start);
const multi = src.slice(start, end);
const cancel = src.slice(src.indexOf('function _cancelStream'), src.indexOf('// ── PATH A:'));

const checks = [
  ['multi-file registers active stream', multi.includes('_activeStreams.set(streamId, entry)')],
  ['multi-file cancellation listener calls bridge cancel', /token\.onCancel\(function\(\)\s*\{\s*_cancelStream\(streamId\)/.test(multi)],
  ['multi-file cancellation settles its Promise', /if \(!done\)\s*\{\s*done = true;\s*reject\(new Error\('cancelled'\)\);/.test(multi)],
  ['late arrayBuffer completion checks cancellation', /var buf = await file\.slice\(offset, end\)\.arrayBuffer\(\);\s*if \(entry\.cancelled \|\| done\) return;/.test(multi)],
  ['cancel marks entry terminal before worker termination', /entry\.cancelled = true;\s*entry\.terminal = true;/.test(cancel)],
  ['cancel terminates worker', /entry\.worker\.terminate\(\)/.test(cancel)],
  ['cancel finalizes telemetry/listener lifecycle', /_endStreamTelemetry\(entry, 'cancelled'\)/.test(cancel)],
  ['cancel removes active registry entry', /_activeStreams\.delete\(streamId\)/.test(cancel)],
  ['late worker messages are terminal-guarded', /if \(!d \|\| d\.streamId !== streamId \|\| entry\.terminal\) return;/.test(multi)],
  ['runtime stream bridge syntax', (() => { try { execFileSync(process.execPath, ['--check', path], {stdio:'pipe'}); return true; } catch { return false; } })()]
];

let passed=0;
for (const [label, ok] of checks) { console.log((ok?'PASS':'FAIL')+' — '+label); if(ok) passed++; }
console.log(`Unit 46 multi-file cancellation-race audit: ${passed}/${checks.length}`);
if (passed !== checks.length) process.exit(1);
