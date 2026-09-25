#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const bridgePath = 'public/js/runtime-stream-bridge.js';
const bridge = fs.readFileSync(bridgePath, 'utf8');
let passed = 0;
const checks = [
  ['cancel helper exists', /function _cancelStream\(streamId\)/.test(bridge)],
  ['cancellation marks terminal', /entry\.terminal = true/.test(bridge)],
  ['cancellation terminates worker', /entry\.worker\.terminate\(\)/.test(bridge)],
  ['cancellation aborts controller', /entry\.abortController\.abort\(\)/.test(bridge)],
  ['cancellation ends telemetry', /_endStreamTelemetry\(entry, 'cancelled'\)/.test(bridge)],
  ['cancellation emits event', /stream:cancelled/.test(bridge)],
  ['telemetry end is idempotent', /entry\.telemetryEnded/.test(bridge)],
  ['transferable entry stores span', /spanId: spanId, abortController/.test(bridge)],
  ['chunk entry stores span', /spanId: spanId \}/.test(bridge)],
  ['message handlers ignore terminal streams', /d\.streamId !== streamId \|\| entry\.terminal/.test(bridge)],
  ['worker error handlers ignore terminal streams', /if \(entry\.terminal\) return;/.test(bridge)],
  ['multi-file cancellation uses shared cancel', /_cancelStream\(streamId\);/.test(bridge)],
  ['multi-file handler marks terminal', /done=true; entry\.terminal=true/.test(bridge)],
  ['bridge parses as JavaScript', true],
];
try { execFileSync(process.execPath, ['--check', bridgePath], { stdio: 'ignore' }); }
catch { checks[13][1] = false; }

for (const [name, ok] of checks) {
  if (ok) { passed++; console.log('PASS', name); }
  else console.log('FAIL', name);
}
console.log(`Phase 5 Unit 28 stream terminal-state audit: ${passed}/${checks.length}`);
if (passed !== checks.length) process.exit(1);
