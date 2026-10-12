// Workflow Worker Adapter v2.0 — canonical RuntimeWorkers, no legacy fallback
(function () {
  'use strict';
  if (window.WorkflowWorkerAdapter) return;
  var WORKER_URL = '/workers/pdf-worker.js', TIMEOUT_MS = 0;
  function key(file, opts) {
    opts = opts || {};
    return 'workflow:' + String(file && file.name || '') + ':' + String(file && file.size || 0) + ':' +
      String(file && file.lastModified || 0) + ':' +
      [opts.step1,opts.step1_value,opts.step2,opts.step2_value,opts.step3,opts.step3_value].map(function(v){return String(v||'');}).join('|');
  }
  async function dispatch(file, opts, onProgress, token) {
    opts=opts||{}; onProgress=typeof onProgress==='function'?onProgress:function(){};
    if(!file) throw new Error('No file provided');
    if(token&&token.cancelled) throw new Error('cancelled-before-read');
    if(!window.RuntimeWorkers||typeof window.RuntimeWorkers.dispatch!=='function')
      throw new Error('RuntimeWorkers is unavailable — canonical Workflow worker runtime cannot dispatch');
    onProgress(5,'Preparing workflow…');
    var buffer=await file.arrayBuffer();
    if(!buffer||!buffer.byteLength) throw new Error('Workflow input is empty');
    if(token&&token.cancelled) throw new Error('cancelled-after-read');
    onProgress(15,'Running workflow…');
    var result=await window.RuntimeWorkers.dispatch(
      WORKER_URL,{tool:'workflow',buffers:[buffer],options:opts},[buffer],
      {priority:'normal',label:'workflow-worker',dedupeKey:key(file,opts),timeoutMs:TIMEOUT_MS,token:token}
    );
    if(!result||!result.buffer||!result.buffer.byteLength) throw new Error('Workflow worker produced empty output');
    onProgress(100,'Done!');
    return {buffer:result.buffer};
  }
  window.WorkflowWorkerAdapter=Object.freeze({dispatch:dispatch,WORKER_URL:WORKER_URL,TIMEOUT_MS:TIMEOUT_MS});
}());
