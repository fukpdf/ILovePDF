// Protect Worker Adapter v2.0 — canonical RuntimeWorkers
(function(){
'use strict';
if(window.ProtectWorkerAdapter)return;
var WORKER_URL='/workers/pdf-worker.js',TIMEOUT_MS=0;
function key(file,opts){var password=String(opts&&opts.password||''),h=2166136261;for(var i=0;i<password.length;i++){h^=password.charCodeAt(i);h=Math.imul(h,16777619);}return 'protect:'+String(file&&file.name||'')+':'+String(file&&file.size||0)+':'+String(file&&file.lastModified||0)+':'+(h>>>0).toString(16);}
async function dispatch(file,opts,onProgress,token){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeWorkers||typeof window.RuntimeWorkers.dispatch!=='function')throw new Error('RuntimeWorkers is unavailable — canonical Protect worker runtime cannot dispatch');
 if(token&&token.cancelled)throw new Error('cancelled-before-read');
 onProgress=typeof onProgress==='function'?onProgress:function(){};
 var options=opts||{},password=String(options.password||'').trim();
 if(!password)throw new Error('Please enter a password to protect the PDF');
 onProgress(5,'Preparing protection…');
 var buffer=await file.arrayBuffer();
 if(!buffer||!buffer.byteLength)throw new Error('Protect input is empty');
 if(token&&token.cancelled)throw new Error('cancelled-after-read');
 onProgress(20,'Applying password protection…');
 var result=await window.RuntimeWorkers.dispatch(WORKER_URL,{tool:'protect',buffers:[buffer],options:options},[buffer],{priority:'normal',label:'protect-worker',dedupeKey:key(file,options),timeoutMs:TIMEOUT_MS,token:token});
 if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Protect worker produced empty output');
 onProgress(100,'Protection complete');
 return {buffer:result.buffer};
}
window.ProtectWorkerAdapter=Object.freeze({dispatch:dispatch,WORKER_URL:WORKER_URL,TIMEOUT_MS:TIMEOUT_MS});
}());