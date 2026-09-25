#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const start=x.indexOf('function _endStreamTelemetry');
const chunk=x.slice(x.indexOf('async function _streamViaChunkAck'),x.indexOf('// ── PRIMARY API'));
const checks=[
 ['central telemetry finalizer invokes transient cleanup',x.slice(start,start+700).includes('entry.cleanupTransientResources')],
 ['chunk registers transient cleanup hook',chunk.includes('entry.cleanupTransientResources = function')],
 ['cleanup clears memory retry timer',/cleanupTransientResources = function \(\)[\s\S]*?clearTimeout\(_memRetryTimer\)/.test(chunk)],
 ['cleanup clears prefetch buffer',/cleanupTransientResources = function \(\)[\s\S]*?_prefetchBuf = null/.test(chunk)],
 ['stream-error uses terminal finalizer',/d\.type === 'stream-error'[\s\S]*?finishRuntimeError\(new Error\(d\.__error/.test(chunk)],
 ['worker onerror uses terminal finalizer',/w\.onerror = function[\s\S]*?finishRuntimeError\(new Error/.test(chunk)],
 ['no direct stream-error reject path',!/_endStreamTelemetry\(entry, 'error'\);\s*reject\(new Error\(d\.__error/.test(chunk)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[7][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 41 chunk cancel/transient cleanup audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
