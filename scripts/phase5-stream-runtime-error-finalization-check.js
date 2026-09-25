#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const p='public/js/runtime-stream-bridge.js',x=fs.readFileSync(p,'utf8');
const checks=[
 ['chunk finishRuntimeError exists',/function finishRuntimeError\(err\)/.test(x)],
 ['runtime error becomes terminal',/entry\.terminal = true;/.test(x)],
 ['runtime error removes active stream',/_activeStreams\.delete\(streamId\);/.test(x)],
 ['runtime error terminates worker',/w\.terminate\(\)/.test(x)],
 ['runtime error closes telemetry',/_endStreamTelemetry\(entry, 'error'\)/.test(x)],
 ['ack-chain errors use finalizer',/\.onmessage[\s\S]*finishRuntimeError\(err\);/.test(x)],
 ['initial send errors use finalizer',/_sendNextChunk\(\)\.catch\(function \(err\) \{\n        finishRuntimeError\(err\);/.test(x)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[7][1]=false;}
let n=0;for(const [a,b] of checks){console.log((b?'PASS ':'FAIL ')+a);if(b)n++;}
console.log('Unit 32 stream runtime-error finalization audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);