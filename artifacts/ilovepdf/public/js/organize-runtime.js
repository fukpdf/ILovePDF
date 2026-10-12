// Organize Runtime v3.0 — canonical RuntimeScheduler/RuntimeWorkers path
(function(){
'use strict';
if(window.OrganizeRuntime)return;
var currentToken=null,currentSpan=null;
function cleanup(reason,owner){
  var owns=arguments.length<2||currentToken===owner;
  if(window.RuntimeTelemetry)try{window.RuntimeTelemetry.record('organize:cleanup',{reason:reason});}catch(_){}
  if(owns){currentToken=null;currentSpan=null;}
}
async function execute(file,opts){
  opts=opts||{};
  var token=null,span=null;
  try{
    if(!file)throw new Error('No file provided');
    token=window.RuntimeCancellation&&window.RuntimeCancellation.createScopedToken
      ?window.RuntimeCancellation.createScopedToken('organize-pdf',{label:'organize-pdf-run',timeoutMs:0}):null;
    currentToken=token;
    if(window.RuntimeTelemetry){span=window.RuntimeTelemetry.startSpan('organize:full-run',{name:file.name,size:file.size,pageOrder:opts.pageOrder||''});currentSpan=span;}
    if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Organize execution cannot start');
    if(!window.OrganizeWorkerAdapter||typeof window.OrganizeWorkerAdapter.dispatch!=='function')throw new Error('OrganizeWorkerAdapter is unavailable — canonical Organize execution cannot start');
    var result=await window.RuntimeScheduler.run(function(){
      return window.OrganizeWorkerAdapter.dispatch(file,opts,function(p,msg){
        if(window.showProcessing)try{window.showProcessing('Organizing PDF…',msg||'Reordering pages…');}catch(_){}
      },token);
    },{type:'organize',priority:'normal',label:'organize-pdf',token:token});
    if(!result||!result.buffer)throw new Error('Organize worker returned no output');
    var blob=new Blob([result.buffer],{type:'application/pdf'});
    if(!blob.size)throw new Error('Organize output is empty');
    var filename=window.BrowserTools&&window.BrowserTools.brandedFilename
      ?window.BrowserTools.brandedFilename(file.name,'.pdf'):'ILovePDF-organized.pdf';
    if(window.RuntimeTelemetry&&span!==null)try{window.RuntimeTelemetry.endSpan(span,'ok');}catch(_){}
    cleanup('success',token);
    return {blob:blob,filename:filename};
  }catch(err){
    if(window.RuntimeTelemetry&&span!==null)try{window.RuntimeTelemetry.endSpan(span,'error');}catch(_){}
    cleanup('error',token);
    try{Object.defineProperty(err,'__organizeRunToken',{value:token,configurable:true});}catch(_){}
    throw err;
  }
}
async function runOrganizeRuntime(file,opts){return execute(file,opts);}
function cancelActive(reason){
  if(currentToken&&!currentToken.cancelled){var t=currentToken;t.cancel(reason||'manual-cancel');cleanup('cancel:'+(reason||'manual-cancel'),t);return true;}
  return false;
}
window.OrganizeRuntime={execute:execute,runOrganizeRuntime:runOrganizeRuntime,cancelActive:cancelActive,getDiagnostics:function(){return{runtimeEnabled:true,activeToken:currentToken?{id:currentToken.id,cancelled:currentToken.cancelled}:null,activeSpan:currentSpan,workerAdapter:!!window.OrganizeWorkerAdapter};}};
}());