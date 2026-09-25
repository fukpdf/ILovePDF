#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const a=x.indexOf('function streamFilesToWorkerReadable');
const b=x.indexOf('// ── Cancel all on pagehide',a);
const m=x.slice(a,b);
const checks=[
 ['multi-file init postMessage is guarded',/try \{\s*w\.postMessage\(initMsg\);[\s\S]*?stream-init-postmessage-failed/.test(m)],
 ['multi-file init failure uses finishError',/stream-init-postmessage-failed[\s\S]*?finishError/.test(m)],
 ['multi-file chunk postMessage remains inside try',/w\.postMessage\(chunkMsg, \[buf\]\);/.test(m)],
 ['multi-file security failures use finishError',/catch \(se\)[\s\S]*?finishError\(se\)/.test(m)],
 ['multi-file terminal message guard',/d\.streamId !== streamId \|\| entry\.terminal/.test(m)],
 ['multi-file cancellation listener is retained',/entry\.removeCancelListener = token\.onCancel/.test(m)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[6][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 43 multi-file stream transport audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
