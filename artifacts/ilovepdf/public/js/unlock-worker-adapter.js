// Unlock Worker Adapter v2.0 — canonical RuntimeWorkers
(function(){
'use strict';
if(window.UnlockWorkerAdapter)return;
var WORKER_URL='/workers/pdf-worker.js',TIMEOUT_MS=0;
function key(file){return 'unlock:'+String(file&&file.name||'')+':'+String(file&&file.size||0)+':'+String(file&&file.lastModified||0);}
async function dispatch(file,opts,onProgress,token){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeWorkers||typeof window.RuntimeWorkers.dispatch!=='function')throw new Error('RuntimeWorkers is unavailable — canonical Unlock worker runtime cannot dispatch');
 if(token&&token.cancelled)throw new Error('cancelled-before-read');
 onProgress=typeof onProgress==='function'?onProgress:function(){};
 onProgress(5,'Preparing unlock…');
 var buffer=await file.arrayBuffer();
 if(!buffer||!buffer.byteLength)throw new Error('Unlock input is empty');
 if(token&&token.cancelled)throw new Error('cancelled-after-read');
 onProgress(20,'Removing encryption…');
 var result=await window.RuntimeWorkers.dispatch(WORKER_URL,{tool:'unlock',buffers:[buffer],options:opts||{}},[buffer],{priority:'normal',label:'unlock-worker',dedupeKey:key(file),timeoutMs:TIMEOUT_MS,token:token});
 if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Unlock worker produced empty output');
 onProgress(100,'Unlock complete');
 return {buffer:result.buffer};
}
window.UnlockWorkerAdapter=Object.freeze({dispatch:dispatch,WORKER_URL:WORKER_URL,TIMEOUT_MS:TIMEOUT_MS});
}());