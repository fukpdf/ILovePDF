#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const p='public/js/runtime-stream-bridge.js',x=fs.readFileSync(p,'utf8');
const start=x.indexOf('w.onmessage = function(e) {');
const end=x.indexOf('w.onerror = function(e)',start);
const m=x.slice(start,end);
const checks=[
 ['transfer onmessage checks terminal before dispatch',/if \(!d \|\| d\.streamId !== streamId \|\| entry\.terminal\) return;/.test(m)],
 ['progress callback remains guarded by callback presence',/d\.type === 'stream-progress' && onProgress/.test(m)],
 ['done path retains terminal state',/entry\.terminal = true;/.test(m)],
 ['error path retains terminal state',/reject\(new Error\(d\.__error \|\| 'stream-worker-error'\)\)/.test(m)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[4][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 34 late-progress isolation audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);