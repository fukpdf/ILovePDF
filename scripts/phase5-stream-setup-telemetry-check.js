#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const p='public/js/runtime-stream-bridge.js', x=fs.readFileSync(p,'utf8');
const checks=[
 ['paused transferable span closes',/if \(global\.RuntimeTelemetry && spanId\) global\.RuntimeTelemetry\.endSpan\(spanId, 'paused'\)/.test(x)],
 ['transfer worker spawn closes span',/worker-spawn-failed:[\s\S]{0,180}endSpan\(spanId, 'error'\)/.test(x)],
 ['transfer security failure closes telemetry',/validateWorkerMessage\(msg\)[\s\S]{0,220}_endStreamTelemetry\(entry, 'error'\)/.test(x)],
 ['chunk worker spawn closes span',/worker-spawn-failed:[\s\S]{0,500}endSpan\(spanId, 'error'\)/.test(x)],
 ['chunk read failure closes telemetry',/reject\(readErr\)[\s\S]{0,80}_endStreamTelemetry\(entry, 'error'\)/.test(x)],
 ['chunk security failure closes telemetry',/validateWorkerMessage\(chunkMsg\)[\s\S]{0,220}_endStreamTelemetry\(entry, 'error'\)/.test(x)],
 ['chunk postMessage failure closes telemetry',/chunk-postmessage-failed:[\s\S]{0,80}_endStreamTelemetry\(entry, 'error'\)/.test(x)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[7][1]=false;}
let n=0;for(const [a,b] of checks){console.log((b?'PASS ':'FAIL ')+a);if(b)n++;}
console.log('Unit 31 stream setup telemetry audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);