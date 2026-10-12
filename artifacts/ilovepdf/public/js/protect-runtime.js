// Protect Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function(){
'use strict';
if(window.ProtectRuntime)return;
var currentToken=null;
async function execute(file,opts){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Protect runtime cannot execute');
 if(!window.ProtectWorkerAdapter||typeof window.ProtectWorkerAdapter.dispatch!=='function')throw new Error('ProtectWorkerAdapter is unavailable — canonical Protect worker runtime cannot execute');
 var token=new(window.WorkerPool&&window.WorkerPool.CancelToken?window.WorkerPool.CancelToken:function(){this.cancelled=false;this.cancel=function(){this.cancelled=true;};})();
 currentToken=token;
 try{
  var result=await window.RuntimeScheduler.run('protect',function(taskToken,onProgress){return window.ProtectWorkerAdapter.dispatch(file,opts,onProgress,taskToken||token);},{token:token,timeoutMs:0,label:'protect'});
  if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Protect produced empty output');
  var blob=new Blob([result.buffer],{type:'application/pdf'});
  var filename=window.BrowserTools&&window.BrowserTools.brandedFilename?window.BrowserTools.brandedFilename(file.name,'.pdf'):'ILovePDF-protected.pdf';
  return {blob:blob,filename:filename};
 }finally{if(currentToken===token)currentToken=null;}
}
function cancelActive(reason){if(currentToken&&typeof currentToken.cancel==='function')currentToken.cancel(reason||'cancelled');}
function getDiagnostics(){return{active:!!currentToken,hasAdapter:!!(window.ProtectWorkerAdapter&&typeof window.ProtectWorkerAdapter.dispatch==='function')};}
window.ProtectRuntime={execute:execute,cancelActive:cancelActive,getDiagnostics:getDiagnostics};
}());