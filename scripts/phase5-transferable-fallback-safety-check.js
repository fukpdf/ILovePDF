#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const p='public/js/runtime-stream-bridge.js';
const s=fs.readFileSync(p,'utf8');
const checks=[
 ['fallback marker helper exists',/function _fallbackStreamError\(message\)/.test(s)],
 ['worker spawn is fallback-eligible',/reject\(_fallbackStreamError\('worker-spawn-failed: ' \+ e\.message\)\)/.test(s)],
 ['missing File.stream is fallback-eligible',/reject\(_fallbackStreamError\('file-stream-unavailable'\)\)/.test(s)],
 ['transfer postMessage failure is fallback-eligible',/reject\(_fallbackStreamError\('stream-postmessage-failed: ' \+ postErr\.message\)\)/.test(s)],
 ['worker processing error is not marked fallback',/reject\(new Error\(d\.__error \|\| 'stream-worker-error'\)\)/.test(s)],
 ['chunk worker processing error remains terminal',/reject\(new Error\(d\.__error \|\| 'stream-chunk-error'\)\)/.test(s)],
 ['fallback requires explicit marker',/if \(!errA \|\| !errA\.streamFallbackEligible\) throw errA;/.test(s)],
 ['fallback telemetry names transport fallback',/stream-bridge:transferable-fallback/.test(s)],
 ['no broad unconditional fallback message remains',!/'transferable stream path failed, falling back to chunk-ack:'.test(s)],
 ['bridge parses as JavaScript',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[9][1]=false;}
let n=0;for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);if(ok)n++;}
console.log('Phase 5 Unit 30 transferable fallback safety audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
