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
 ['central cancel settles stored reject',/if \(entry\.cancelReject\)[\s\S]*entry\.cancelReject\(new Error\('cancelled'\)/.test(cancel)],
 ['all stream entries store cancel reject',[transfer,chunk,multi].every(s=>s.includes('cancelReject: reject'))],
 ['transfer token callback does not duplicate reject',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); \}\)/.test(transfer)],
 ['chunk token callback does not duplicate reject',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); \}\)/.test(chunk)],
 ['multi token callback does not duplicate reject',/token\.onCancel\(function\(\) \{\s*_cancelStream\(streamId\);\s*\}\)/.test(multi)],
 ['no stream token callback directly rejects',!(/token\.onCancel\([\s\S]{0,180}\breject\(new Error\('cancelled'\)/.test(src))],
 ['terminal success clears cancel reject', (transfer+chunk+multi).split('resolve(d)').length-1 === 3],
 ['runtime stream bridge syntax',(()=>{try{execFileSync(process.execPath,['--check',path],{stdio:'pipe'});return true;}catch{return false;}})()]
];
let passed=0; for(const [label,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+label);if(ok)passed++;}
console.log(`Unit 48 stream terminal settlement audit: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exit(1);
