// Unlock Runtime v3.0 — canonical RuntimeScheduler + RuntimeWorkers
(function(){
'use strict';
if(window.UnlockRuntime)return;
var currentToken=null;
async function execute(file,opts){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Unlock runtime cannot execute');
 if(!window.UnlockWorkerAdapter||typeof window.UnlockWorkerAdapter.dispatch!=='function')throw new Error('UnlockWorkerAdapter is unavailable — canonical Unlock worker runtime cannot execute');
 var token=new(window.WorkerPool&&window.WorkerPool.CancelToken?window.WorkerPool.CancelToken:function(){this.cancelled=false;this.cancel=function(){this.cancelled=true;};})();
 currentToken=token;
 try{
  var result=await window.RuntimeScheduler.run('unlock',function(taskToken,onProgress){return window.UnlockWorkerAdapter.dispatch(file,opts,onProgress,taskToken||token);},{token:token,timeoutMs:0,label:'unlock'});
  if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Unlock produced empty output');
  var blob=new Blob([result.buffer],{type:'application/pdf'});
  var filename=window.BrowserTools&&window.BrowserTools.brandedFilename?window.BrowserTools.brandedFilename(file.name,'.pdf'):'ILovePDF-unlocked.pdf';
  return {blob:blob,filename:filename};
 }finally{if(currentToken===token)currentToken=null;}
}
function cancelActive(reason){if(currentToken&&typeof currentToken.cancel==='function')currentToken.cancel(reason||'cancelled');}
function getDiagnostics(){return{active:!!currentToken,hasAdapter:!!(window.UnlockWorkerAdapter&&typeof window.UnlockWorkerAdapter.dispatch==='function')};}
window.UnlockRuntime={execute:execute,cancelActive:cancelActive,getDiagnostics:getDiagnostics};
}());