#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
 ['telemetry finalizer removes cancel listener',/function _endStreamTelemetry[\s\S]*?entry\.removeCancelListener[\s\S]*?entry\.removeCancelListener = null;[\s\S]*?entry\.telemetryEnded = true;/.test(x)],
 ['finalizer remains idempotent',/if \(!entry \|\| entry\.telemetryEnded\) return;/.test(x)],
 ['all three stream paths register cleanup',/entry\.removeCancelListener = token\.onCancel/g.test(x) && (x.match(/entry\.removeCancelListener = token\.onCancel/g)||[]).length === 3],
 ['cancel path remains terminal',/entry\.terminal = true;/.test(x)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[4][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 37 central listener finalization audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);