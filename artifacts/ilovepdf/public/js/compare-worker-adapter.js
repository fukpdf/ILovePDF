// Compare Worker Adapter v2.0 — canonical RuntimeWorkers
(function(){
'use strict';
if(window.CompareWorkerAdapter)return;
var WORKER_URL='/workers/pdf-worker.js',TIMEOUT_MS=0;
function key(files){
 var a=files&&files[0]||{},b=files&&files[1]||{};
 return 'compare:'+String(a.name||'')+':'+String(a.size||0)+':'+String(a.lastModified||0)+':'+String(b.name||'')+':'+String(b.size||0)+':'+String(b.lastModified||0);
}
async function dispatch(files,opts,onProgress,token){
 if(!Array.isArray(files)||files.length<2)throw new Error('Two PDF files are required for comparison');
 if(!window.RuntimeWorkers||typeof window.RuntimeWorkers.dispatch!=='function')throw new Error('RuntimeWorkers is unavailable — canonical Compare worker runtime cannot dispatch');
 if(token&&token.cancelled)throw new Error('cancelled-before-read');
 onProgress=typeof onProgress==='function'?onProgress:function(){};
 onProgress(5,'Preparing comparison…');
 var buffers=[];
 for(var i=0;i<2;i++){
  var buffer=await files[i].arrayBuffer();
  if(!buffer||!buffer.byteLength)throw new Error('Compare input '+(i+1)+' is empty');
  if(token&&token.cancelled)throw new Error('cancelled-during-read');
  buffers.push(buffer);
  onProgress(i===0?20:35,'Reading document '+(i===0?'A':'B')+'…');
 }
 onProgress(50,'Comparing document structure…');
 var result=await window.RuntimeWorkers.dispatch(WORKER_URL,{tool:'compare',buffers:buffers,options:opts||{}},buffers,{priority:'normal',label:'compare-worker',dedupeKey:key(files),timeoutMs:TIMEOUT_MS,token:token});
 if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Compare worker produced empty output');
 onProgress(100,'Comparison complete');
 return {buffer:result.buffer};
}
window.CompareWorkerAdapter=Object.freeze({dispatch:dispatch,WORKER_URL:WORKER_URL,TIMEOUT_MS:TIMEOUT_MS});
}());
