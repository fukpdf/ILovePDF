// Compare Runtime v3.0 — canonical RuntimeScheduler + RuntimeWorkers
(function(){
'use strict';
if(window.CompareRuntime)return;
var currentToken=null;
async function execute(files,opts){
 if(!Array.isArray(files)||files.length<2)throw new Error('Two PDF files are required for comparison');
 if(!window.RuntimeScheduler||typeof window.RuntimeScheduler.run!=='function')throw new Error('RuntimeScheduler is unavailable — canonical Compare runtime cannot execute');
 if(!window.CompareWorkerAdapter||typeof window.CompareWorkerAdapter.dispatch!=='function')throw new Error('CompareWorkerAdapter is unavailable — canonical Compare worker runtime cannot execute');
 var token=new(window.WorkerPool&&window.WorkerPool.CancelToken?window.WorkerPool.CancelToken:function(){this.cancelled=false;this.cancel=function(){this.cancelled=true;};})();
 currentToken=token;
 try{
  var result=await window.RuntimeScheduler.run('compare',function(taskToken,onProgress){return window.CompareWorkerAdapter.dispatch(files,opts,onProgress,taskToken||token);},{token:token,timeoutMs:0,label:'compare'});
  if(!result||!result.buffer||!result.buffer.byteLength)throw new Error('Compare produced empty output');
  var blob=new Blob([result.buffer],{type:'application/pdf'});
  var base=files[0]&&files[0].name||'comparison';
  var filename=window.BrowserTools&&window.BrowserTools.brandedFilename?window.BrowserTools.brandedFilename(base.replace(/\.pdf$/i,'')+'-comparison.pdf','.pdf'):'ILovePDF-comparison.pdf';
  return {blob:blob,filename:filename};
 }finally{if(currentToken===token)currentToken=null;}
}
function cancelActive(reason){if(currentToken&&typeof currentToken.cancel==='function')currentToken.cancel(reason||'cancelled');}
function getDiagnostics(){return{active:!!currentToken,hasAdapter:!!(window.CompareWorkerAdapter&&typeof window.CompareWorkerAdapter.dispatch==='function')};}
window.CompareRuntime={execute:execute,cancelActive:cancelActive,getDiagnostics:getDiagnostics};
}());
