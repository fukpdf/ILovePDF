#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path='public/js/runtime-stream-bridge.js';
const src=fs.readFileSync(path,'utf8');
const transfer=src.slice(src.indexOf('async function _streamViaTransferableStream'),src.indexOf('async function _streamViaChunkAck'));
const chunk=src.slice(src.indexOf('async function _streamViaChunkAck'),src.indexOf('async function streamToWorkerReadable'));
const multi=src.slice(src.indexOf('async function streamFilesToWorkerReadable'),src.indexOf('// ── Cancel all on pagehide'));

const checks=[
 ['transferable startup checks cancellation before work',transfer.includes("if (token && token.cancelled) throw new Error('cancelled-before-stream');")],
 ['transferable memdefense startup closes telemetry',/if \(_streamsPaused\)[\s\S]*endSpan\(spanId, 'paused'\)/.test(transfer)],
 ['transferable worker spawn failure closes telemetry',/catch \(e\) \{[\s\S]*endSpan\(spanId, 'error'\)[\s\S]*reject\(_fallbackStreamError/.test(transfer)],
 ['chunk startup checks cancellation before work',chunk.includes("if (token && token.cancelled) throw new Error('cancelled-before-stream');")],
 ['chunk worker spawn failure closes telemetry',/catch \(e\) \{[\s\S]*endSpan\(spanId, 'error'\)[\s\S]*reject\(new Error\('worker-spawn-failed/.test(chunk)],
 ['multi-file validates input before worker creation',/if \(!files \|\| !files\.length\) throw new Error\('no-files-to-stream'\);/.test(multi)],
 ['multi-file checks cancellation before worker creation',multi.includes("if (token && token.cancelled) throw new Error('cancelled-before-stream');")],
 ['multi-file worker creation precedes telemetry span',multi.indexOf('try { w = new Worker(workerUrl);') < multi.indexOf("startSpan('stream-bridge:multi-file'")],
 ['multi-file worker spawn failure rejects immediately',/try \{ w = new Worker\(workerUrl\); \} catch \(e\) \{\s*reject\(new Error\('worker-spawn-failed: ' \+ e\.message\)\); return;\s*\}/.test(multi)],
 ['runtime stream bridge syntax',(()=>{try{execFileSync(process.execPath,['--check',path],{stdio:'pipe'});return true;}catch{return false;}})()]
];
let passed=0; for(const [label,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+label);if(ok)passed++;}
console.log(`Unit 49 stream startup failure audit: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exit(1);
