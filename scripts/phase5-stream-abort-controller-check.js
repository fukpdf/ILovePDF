#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const path='public/js/runtime-stream-bridge.js';
const src=fs.readFileSync(path,'utf8');
const cancel=src.slice(src.indexOf('function _cancelStream'),src.indexOf('// ── PATH A:'));
const transfer=src.slice(src.indexOf('async function _streamViaTransferableStream'),src.indexOf('async function _streamViaChunkAck'));
const chunk=src.slice(src.indexOf('async function _streamViaChunkAck'),src.indexOf('async function streamToWorkerReadable'));
const multi=src.slice(src.indexOf('async function streamFilesToWorkerReadable'),src.indexOf('// ── Cancel all on pagehide'));

const checks=[
 ['cancel checks abort controller defensively',/if \(entry\.abortController\)\s*\{[\s\S]*entry\.abortController\.abort\(\)/.test(cancel)],
 ['cancel abort occurs before telemetry finalization',cancel.indexOf('entry.abortController.abort()') < cancel.indexOf("_endStreamTelemetry(entry, 'cancelled')")],
 ['transferable declares abort controller slot',transfer.includes('abortController: null')],
 ['chunk path does not falsely claim abort controller ownership',!chunk.includes('abortController: new AbortController')],
 ['multi-file path does not falsely claim abort controller ownership',!multi.includes('abortController: new AbortController')],
 ['cancel remains worker-terminal even without abort controller',/entry\.worker\.terminate\(\)/.test(cancel)],
 ['cancel remains Promise-settling',/entry\.cancelReject\(new Error\('cancelled'\)\)/.test(cancel)],
 ['runtime stream bridge syntax',(()=>{try{execFileSync(process.execPath,['--check',path],{stdio:'pipe'});return true;}catch{return false;}})()]
];
let passed=0; for(const [label,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+label);if(ok)passed++;}
console.log(`Unit 50 stream abort-controller audit: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exit(1);
