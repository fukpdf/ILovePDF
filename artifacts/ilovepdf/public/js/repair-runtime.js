// Repair Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function(){
'use strict';
if(window.RepairRuntime)return;
var currentToken=null;
async function execute(file,opts){
 if(!file)throw new Error('No file provided');
 if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Repair runtime cannot execute');
 if(!window.RepairWorkerAdapter||typeof window.RepairWorkerAdapter.dispatch!=='function')throw new Error('RepairWorkerAdapter is unavailable — canonical Repair worker runtime cannot execute');
 var token=new(window.WorkerPool&&window.WorkerPool.CancelToken?window.WorkerPool.CancelToken:function(){this.cancelled=false;this.cancel=function(){this.cancelled=true;};})();
 currentToken=token;
 try{
  var result=await window.RuntimeScheduler.run('repair',function(taskToken,onProgress){
   return window.RepairWorkerAdapter.dispatch(file,opts,onProgress,taskToken||token);
  },{token:token,timeoutMs:0,label:'repair'});
  if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Repair produced empty output');
  var blob=new Blob([result.buffer],{type:'application/pdf'});
  var filename=window.BrowserTools&&window.BrowserTools.brandedFilename?window.BrowserTools.brandedFilename(file.name,'.pdf'):'ILovePDF-repaired.pdf';
  return {blob:blob,filename:filename};
 }finally{if(currentToken===token)currentToken=null;}
}
function cancelActive(reason){if(currentToken&&typeof currentToken.cancel==='function')currentToken.cancel(reason||'cancelled');}
function getDiagnostics(){return{active:!!currentToken,hasAdapter:!!(window.RepairWorkerAdapter&&typeof window.RepairWorkerAdapter.dispatch==='function')};}
window.RepairRuntime={execute:execute,cancelActive:cancelActive,getDiagnostics:getDiagnostics};
}());