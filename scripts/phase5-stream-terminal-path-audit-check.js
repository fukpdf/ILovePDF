#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path = 'public/js/runtime-stream-bridge.js';
const src = fs.readFileSync(path, 'utf8');

function section(start, end) {
  const a = src.indexOf(start);
  if (a < 0) return '';
  const b = end ? src.indexOf(end, a) : src.length;
  return src.slice(a, b < 0 ? src.length : b);
}

const transfer = section('async function _streamViaTransferableStream', 'async function _streamViaChunkAck');
const chunk = section('async function _streamViaChunkAck', 'async function streamToWorkerReadable');
const multi = section('async function streamFilesToWorkerReadable', '// ── Cancel all on pagehide');

const checks = [
  ['transferable has terminal finalizer', transfer.includes('function finishTransferRuntimeError')],
  ['transferable has fallback finalizer', transfer.includes('function finishTransferFallback')],
  ['transferable has worker error handler', transfer.includes('w.onerror = function')],
  ['transferable has messageerror handler', transfer.includes('w.onmessageerror = function')],
  ['chunk has terminal finalizer', chunk.includes('function finishRuntimeError')],
  ['chunk has worker error handler', chunk.includes('w.onerror = function')],
  ['chunk has messageerror handler', chunk.includes('w.onmessageerror = function')],
  ['multi-file has terminal finalizer', multi.includes('function finishError')],
  ['multi-file has worker error handler', multi.includes('w.onerror = function')],
  ['multi-file has messageerror handler', multi.includes('w.onmessageerror = function')],
  ['chunk retry timer is terminal-guarded', /_memRetryTimer = setTimeout\([\s\S]*!entry\.cancelled && !entry\.terminal && !done/.test(chunk)],
  ['chunk prefetch read failures reach finalizer', /catch \(err\) \{[\s\S]*finishRuntimeError\(err\)/.test(chunk)],
  ['multi-file init postMessage is guarded', /try \{\s*w\.postMessage\(initMsg\);\s*\} catch \(initErr\) \{\s*finishError/.test(multi)],
  ['multi-file chunk postMessage is guarded', /try \{\s*w\.postMessage\(chunkMsg, \[buf\]\);[\s\S]*catch \(e\) \{\s*finishError/.test(multi)],
  ['runtime stream bridge syntax', (() => { try { execFileSync(process.execPath, ['--check', path], {stdio:'pipe'}); return true; } catch { return false; } })()]
];

let passed = 0;
for (const [label, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
  if (ok) passed++;
}
console.log(`Unit 45 stream terminal-path audit: ${passed}/${checks.length}`);
if (passed !== checks.length) process.exit(1);
