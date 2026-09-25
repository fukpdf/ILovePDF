#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const chunk=x.slice(x.indexOf('async function _streamViaChunkAck'),x.indexOf('// ── PRIMARY API'));
const checks=[
 ['chunk runtime finalizer clears retry timer',/function finishRuntimeError[\s\S]*?clearTimeout\(_memRetryTimer\)/.test(chunk)],
 ['chunk runtime finalizer releases prefetch buffer',/function finishRuntimeError[\s\S]*?_prefetchBuf = null;/.test(chunk)],
 ['prefetch read errors are terminal',/catch \(err\)[\s\S]*?finishRuntimeError\(err\)/.test(chunk)],
 ['direct read errors use terminal finalizer',/catch \(readErr\) \{\s*finishRuntimeError\(readErr\);/.test(chunk)],
 ['memory retry timer is single-instance',/if \(_memRetryTimer === null\)[\s\S]*?_memRetryTimer = setTimeout/.test(chunk)],
 ['retry checks terminal state',/!entry\.cancelled && !entry\.terminal && !done/.test(chunk)],
 ['chunk stream has terminal message guard',/if \(!d \|\| d\.streamId !== streamId \|\| entry\.terminal\) return;/.test(chunk)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[7][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 39 chunk stream terminal finalization audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
