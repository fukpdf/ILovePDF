#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const chunk=x.slice(x.indexOf('async function _streamViaChunkAck'),x.indexOf('// ── PRIMARY API'));
const checks=[
 ['init postMessage is guarded',/try \{\s*w\.postMessage\(initMsg\);[\s\S]*?stream-init-postmessage-failed/.test(chunk)],
 ['init failure uses terminal finalizer',/stream-init-postmessage-failed[\s\S]*?finishRuntimeError/.test(chunk)],
 ['security validation failure uses terminal finalizer',/catch \(se\)[\s\S]*?finishRuntimeError\(se\)/.test(chunk)],
 ['chunk postMessage failure uses terminal finalizer',/catch \(postErr\)[\s\S]*?finishRuntimeError\(new Error\('chunk-postmessage-failed/.test(chunk)],
 ['no direct reject remains in chunk transport error paths',!(chunk.match(/reject\((?:se|new Error\('chunk-postmessage-failed)/g)||[]).length],
 ['runtime finalizer is terminal',/entry\.terminal = true;[\s\S]*?_activeStreams\.delete\(streamId\)/.test(chunk)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[6][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 40 chunk stream error finalization audit: '+n+'/'+checks.length);
if(n!==checks.length)process.exit(1);
