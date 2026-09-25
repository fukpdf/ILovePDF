// SplitPdfApp v2.0 — Phase 5 standard-tool migration.
(function (G) {
  'use strict';
  var TAG='[SplitPdfApp]', TOOL_ID='split', WORKER='/workers/pdf-worker.js';
  var STREAM_THRESHOLD=10*1024*1024, _inFlight=false, _jobId=0, _cancelToken=null;
  function _log(m,d){console.debug(TAG,m,d!==undefined?d:'');}
  function _warn(m,d){console.warn(TAG,m,d!==undefined?d:'');}
  function _step(){var lf=G.LiveFeed||G.__ae_livefeed;return lf&&typeof lf.update==='function'?function(i,s,p,h){try{lf.update(i,s,p,h);}catch(_){}}:function(){};}
  function _cancel(){if(_cancelToken&&typeof _cancelToken.cancel==='function'){try{_cancelToken.cancel();}catch(_){}}_cancelToken=null;_inFlight=false;}
  async function _runWorker(file,opts,jobId,onStep){
    if(!G.WorkerPool||typeof G.WorkerPool.run!=='function')throw new Error('worker_processing_unavailable');
    _cancelToken=G.WorkerPool.CancelToken?new G.WorkerPool.CancelToken():null;
    var bridge=G.RuntimeStreamBridge;
    if(bridge&&typeof bridge.pipelineStreamToWorker==='function'&&file.size>=STREAM_THRESHOLD){
      var streamed=await bridge.pipelineStreamToWorker(WORKER,file,{tool:TOOL_ID,options:opts||{},jobId:String(jobId)},{token:_cancelToken,onProgress:function(pct,label){onStep(1,'active',Math.max(25,Math.min(84,pct||25)),label||'Splitting pages…');}});
      if(!streamed||!(streamed.buffer instanceof ArrayBuffer))throw new Error('worker_processing_failed');
      return streamed.buffer;
    }
    var buffer=await file.arrayBuffer();
    var result=await G.WorkerPool.run(WORKER,{tool:TOOL_ID,buffers:[buffer],options:opts||{},jobId:String(jobId)},[buffer],{priority:'high',token:_cancelToken});
    if(!result||!(result.buffer instanceof ArrayBuffer))throw new Error('worker_processing_failed');
    return result.buffer;
  }
  function _filename(orig){var base=(orig||'document').replace(/\.[^.]+$/,'');return(base.toLowerCase().startsWith('ilovepdf')?base:'ilovepdf-'+base)+'.pdf';}
  async function process(files,opts){
    if(_inFlight)throw new Error('Split already in progress');if(!files||!files[0])throw new Error('No file provided');
    _inFlight=true;var jobId=++_jobId,file=files[0],onStep=_step();
    try{onStep(0,'active',5,'Reading file…');await Promise.resolve();onStep(0,'done',20);onStep(1,'active',25,'Extracting pages…');
      var resultBuf=await _runWorker(file,opts||{},jobId,onStep);onStep(1,'done',85);onStep(2,'active',90,'Finalizing…');
      var blob=new Blob([resultBuf],{type:'application/pdf'});resultBuf=null;onStep(2,'done',100);
      return{blob:blob,filename:_filename(file.name)};
    }catch(err){_warn('error',{job:jobId,err:err&&err.message});throw err}
    finally{_cancelToken=null;_inFlight=false;}
  }
  function mount(){_log('mounted')} function unmount(){_cancel()} function reset(){_cancel()} function recover(){_cancel()} function destroy(){_cancel()}
  function getState(){return{inFlight:_inFlight,jobId:_jobId,cancellable:!!_cancelToken};}
  function _register(){if(!G.ToolAppManager){_warn('ToolAppManager not available');return}G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',_register);else _register();
  _log('v2.0 ready');
}(window));