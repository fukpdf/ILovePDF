// Repair Worker Adapter v2.0 — canonical RuntimeWorkers
(function(){
'use strict';
if(window.RepairWorkerAdapter)return;
var WORKER_URL='/workers/pdf-worker.js',TIMEOUT_MS=0;
function key(file){return 'repair:'+String(file&&file.name||'')+':'+String(file&&file.size||0)+':'+String(file&&file.lastModified||0);}
async function dispatch(file,opts,onProgress,token){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeWorkers||typeof window.RuntimeWorkers.dispatch!=='function')throw new Error('RuntimeWorkers is unavailable — canonical Repair worker runtime cannot dispatch');
 if(token&&token.cancelled)throw new Error('cancelled-before-read');
 onProgress=typeof onProgress==='function'?onProgress:function(){};
 onProgress(5,'Preparing repair…');
 var buffer=await file.arrayBuffer();
 if(!buffer||!buffer.byteLength)throw new Error('Repair input is empty');
 if(token&&token.cancelled)throw new Error('cancelled-after-read');
 onProgress(20,'Rebuilding document…');
 var result=await window.RuntimeWorkers.dispatch(WORKER_URL,{tool:'repair',buffers:[buffer],options:opts||{}},[buffer],{priority:'normal',label:'repair-worker',dedupeKey:key(file),timeoutMs:TIMEOUT_MS,token:token});
 if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Repair worker produced empty output');
 onProgress(100,'Repair complete');
 return {buffer:result.buffer};
}
window.RepairWorkerAdapter=Object.freeze({dispatch:dispatch,WORKER_URL:WORKER_URL,TIMEOUT_MS:TIMEOUT_MS});
}());