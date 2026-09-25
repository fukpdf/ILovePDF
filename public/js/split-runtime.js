// Split Runtime v3.0 — canonical RuntimeScheduler/RuntimeWorkers path
(function(){
'use strict';
if(window.SplitRuntime)return;
var currentToken=null,currentSpan=null;
function cleanup(reason,owner){
  var owns=arguments.length<2||currentToken===owner;
  if(window.RuntimeTelemetry)try{window.RuntimeTelemetry.record('split:cleanup',{reason:reason});}catch(_){}
  if(owns){currentToken=null;currentSpan=null;}
}
async function execute(file,opts){
  opts=opts||{};
  var token=null,span=null;
  try{
    if(!file)throw new Error('No file provided');
    token=window.RuntimeCancellation&&window.RuntimeCancellation.createScopedToken
      ?window.RuntimeCancellation.createScopedToken('split-pdf',{label:'split-pdf-run',timeoutMs:0}):null;
    currentToken=token;
    if(window.RuntimeTelemetry){span=window.RuntimeTelemetry.startSpan('split:full-run',{name:file.name,size:file.size,range:opts.range||''});currentSpan=span;}
    if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Split execution cannot start');
    if(!window.SplitWorkerAdapter||typeof window.SplitWorkerAdapter.dispatch!=='function')throw new Error('SplitWorkerAdapter is unavailable — canonical Split execution cannot start');
    var result=await window.RuntimeScheduler.run(function(){
      return window.SplitWorkerAdapter.dispatch(file,opts,function(p,msg){
        if(window.showProcessing)try{window.showProcessing('Splitting PDF…',msg||'Extracting pages…');}catch(_){}
      },token);
    },{type:'split',priority:'normal',label:'split-pdf',token:token});
    if(!result||!result.buffer)throw new Error('Split worker returned no output');
    var blob=new Blob([result.buffer],{type:'application/pdf'});
    if(!blob.size)throw new Error('Split output is empty');
    var filename=window.BrowserTools&&window.BrowserTools.brandedFilename
      ?window.BrowserTools.brandedFilename(file.name,'.pdf'):'ILovePDF-split.pdf';
    if(window.RuntimeTelemetry&&span!==null)try{window.RuntimeTelemetry.endSpan(span,'ok');}catch(_){}
    cleanup('success',token);
    return {blob:blob,filename:filename};
  }catch(err){
    if(window.RuntimeTelemetry&&span!==null)try{window.RuntimeTelemetry.endSpan(span,'error');}catch(_){}
    cleanup('error',token);
    try{Object.defineProperty(err,'__splitRunToken',{value:token,configurable:true});}catch(_){}
    throw err;
  }
}
async function runSplitRuntime(file,opts){return execute(file,opts);}
function cancelActive(reason){
  if(currentToken&&!currentToken.cancelled){var t=currentToken;t.cancel(reason||'manual-cancel');cleanup('cancel:'+(reason||'manual-cancel'),t);return true;}
  return false;
}
window.SplitRuntime={execute:execute,runSplitRuntime:runSplitRuntime,cancelActive:cancelActive,getDiagnostics:function(){return{runtimeEnabled:true,activeToken:currentToken?{id:currentToken.id,cancelled:currentToken.cancelled}:null,activeSpan:currentSpan,workerAdapter:!!window.SplitWorkerAdapter};}};
}());
