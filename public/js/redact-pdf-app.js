// RedactPdfApp v2.0 — shared runtime adapter with security-isolated worker family.
(function (G) {
  'use strict';
  var TAG='[RedactPdfApp]', TOOL_ID='redact', _inFlight=false, _jobId=0, _cancelToken=null;
  function _log(m,d){console.debug(TAG,m,d!==undefined?d:'');}
  function _warn(m,d){console.warn(TAG,m,d!==undefined?d:'');}
  function _cancel(label){
    if(_cancelToken){try{_cancelToken.cancel();}catch(_){}_cancelToken=null;}
    _inFlight=false;if(label)_log('cleanup',label);
  }
  function _filename(orig){
    var base=String(orig||'document').replace(/\.[^.]+$/,'');
    return (base.toLowerCase().startsWith('ilovepdf')?base:'ilovepdf-'+base)+'.pdf';
  }
  async function process(files,opts){
    if(_inFlight)throw new Error('Redact already in progress');
    if(!files||!files[0])throw new Error('No file provided');
    if(!G.BrowserTools||typeof G.BrowserTools.process!=='function')throw new Error('Shared BrowserTools runtime unavailable');
    _inFlight=true;var jobId=++_jobId;
    var token=(G.WorkerPool&&G.WorkerPool.CancelToken)?new G.WorkerPool.CancelToken():null;_cancelToken=token;
    try{
      var options=Object.assign({},opts||{});if(token)options.cancelToken=token;
      _log('start',{job:jobId,file:files[0].name,pages:options.pages});
      var result=await G.BrowserTools.process(TOOL_ID,files,options);
      if(!result||!result.blob||result.blob.size<500)throw new Error('Redaction produced an invalid PDF.');
      if(!result.filename)result.filename=_filename(files[0].name);
      _log('done',{job:jobId,size:result.blob.size});return result;
    }finally{if(_cancelToken===token)_cancelToken=null;_inFlight=false;}
  }
  function mount(){_log('mounted');}function unmount(){_cancel('unmount');}function reset(){_cancel('reset');}
  function recover(){_cancel('recover');}function destroy(){_cancel('destroy');}
  function getState(){return{inFlight:_inFlight,jobId:_jobId,hasCancellation:!!_cancelToken};}
  function _register(){
    if(!G.ToolAppManager){_warn('ToolAppManager not available');return;}
    G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',_register);else _register();
}(window));
