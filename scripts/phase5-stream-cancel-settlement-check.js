#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path='public/js/runtime-stream-bridge.js';
const src=fs.readFileSync(path,'utf8');
const transfer=src.slice(src.indexOf('async function _streamViaTransferableStream'),src.indexOf('async function _streamViaChunkAck'));
const chunk=src.slice(src.indexOf('async function _streamViaChunkAck'),src.indexOf('async function streamToWorkerReadable'));
const multi=src.slice(src.indexOf('async function streamFilesToWorkerReadable'),src.indexOf('// ── Cancel all on pagehide'));
const cancel=src.slice(src.indexOf('function _cancelStream'),src.indexOf('// ── PATH A:'));

const checks=[
 ['central cancel invokes stored reject',/if \(entry\.cancelReject\)[\s\S]*entry\.cancelReject\(new Error\('cancelled'\)\)/.test(cancel)],
 ['transferable stores Promise reject',/cancelReject: reject/.test(transfer)],
 ['chunk stores Promise reject',/cancelReject: reject/.test(chunk)],
 ['multi-file stores Promise reject',/cancelReject: reject/.test(multi)],
 ['transfer token cancellation delegates centrally',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); \}\)/.test(transfer)],
 ['chunk token cancellation delegates centrally',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); \}\)/.test(chunk)],
 ['multi-file token cancellation delegates centrally',/token\.onCancel\(function\(\) \{\s*_cancelStream\(streamId\);\s*\}\)/.test(multi)],
 ['cancel remains terminal before settlement',/entry\.cancelled = true;\s*entry\.terminal = true;/.test(cancel)],
 ['active stream removed after cancellation',/_activeStreams\.delete\(streamId\)/.test(cancel)],
 ['runtime stream bridge syntax',(()=>{try{execFileSync(process.execPath,['--check',path],{stdio:'pipe'});return true;}catch{return false;}})()]
];
let passed=0; for(const [label,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+label);if(ok)passed++;}
console.log(`Unit 47 stream cancellation settlement audit: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exit(1);
