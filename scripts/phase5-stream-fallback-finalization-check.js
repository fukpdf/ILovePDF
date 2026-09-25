#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
  ['transferable File.stream fallback finalizes telemetry',/file-stream-unavailable'[\s\S]*?_endStreamTelemetry\(entry, 'fallback'\)/.test(x)],
  ['transferable postMessage fallback finalizes telemetry',/stream-postmessage-failed:[\s\S]*?_endStreamTelemetry\(entry, 'fallback'\)/.test(x)],
  ['fallback errors are explicitly eligible',/function _fallbackStreamError\(message\)[\s\S]*?err\.streamFallbackEligible = true;/.test(x)],
  ['dispatcher rejects non-eligible transferable errors',/if \(!errA \|\| !errA\.streamFallbackEligible\) throw errA;/.test(x)],
  ['central finalizer remains idempotent',/if \(!entry \|\| entry\.telemetryEnded\) return;[\s\S]*?entry\.removeCancelListener = null;[\s\S]*?entry\.telemetryEnded = true;/.test(x)],
  ['all three stream paths register cancellation cleanup',(x.match(/entry\.removeCancelListener = token\.onCancel/g)||[]).length===3],
  ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[6][1]=false;}
let n=0;
for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 38 transferable fallback finalization audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
