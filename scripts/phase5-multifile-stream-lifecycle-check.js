#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const p='public/js/runtime-stream-bridge.js';
const s=fs.readFileSync(p,'utf8');
const checks=[
 ['multi-file path starts telemetry span',/stream-bridge:multi-file/.test(s)],
 ['multi-file entry stores span id',/terminal: false, telemetryEnded: false, spanId: spanId/.test(s)],
 ['multi-file emits started telemetry',/_telStream\('started', \{ streamId: streamId, tool: message && message.tool/.test(s)],
 ['multi-file success closes telemetry',/_endStreamTelemetry\(entry, 'ok'\)/.test(s)],
 ['multi-file success emits done telemetry',/_telStream\('done', \{ streamId: streamId \}\)/.test(s)],
 ['multi-file error closes telemetry',/_endStreamTelemetry\(entry, 'error'\)/.test(s)],
 ['multi-file cancellation uses terminal boundary',/_cancelStream\(streamId\)/.test(s)],
 ['multi-file terminal messages are ignored',/d\.streamId !== streamId \|\| entry\.terminal/.test(s)],
 ['multi-file finishError is terminal-safe',/if \(done \|\| entry\.terminal\) return;/.test(s)],
 ['multi-file worker is terminated on finishError',/function finishError[\s\S]*?w\.terminate\(\)/.test(s)],
 ['idempotent telemetry helper remains present',/function _endStreamTelemetry[\s\S]*?telemetryEnded/.test(s)],
 ['bridge parses as JavaScript',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[11][1]=false;}
let n=0; for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);if(ok)n++;}
console.log('Phase 5 Unit 29 multi-file stream lifecycle audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
