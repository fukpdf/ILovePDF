#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const a=x.indexOf('async function _streamViaTransferableStream');
const b=x.indexOf('  // ── PATH B',a);
const t=x.slice(a,b);
const checks=[
 ['transferable runtime finalizer exists',t.includes('function finishTransferRuntimeError')],
 ['transferable fallback finalizer exists',t.includes('function finishTransferFallback')],
 ['security failure uses runtime finalizer',/validateWorkerMessage(msg)[\s\S]*?finishTransferRuntimeError(se)/.test(t)],
 ['worker stream-error uses runtime finalizer',/d\.type === 'stream-error'[\s\S]*?finishTransferRuntimeError/.test(t)],
 ['worker onerror uses runtime finalizer',/w\.onerror = function[\s\S]*?finishTransferRuntimeError/.test(t)],
 ['File.stream unavailable uses fallback finalizer',/file-stream-unavailable/.test(t)&&/finishTransferFallback\('file-stream-unavailable'\)/.test(t)],
 ['postMessage failure uses fallback finalizer',/stream-postmessage-failed[\s\S]*?finishTransferFallback/.test(t)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[7][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 42 transferable error finalization audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
