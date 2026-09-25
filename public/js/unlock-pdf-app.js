// UnlockPdfApp v2.0 — shared browser-worker runtime adapter.
(function(G){
'use strict';
var TAG='[UnlockPdfApp]',TOOL_ID='unlock',_inFlight=false,_jobId=0,_cancelToken=null;
function log(m,d){console.debug(TAG,m,d!==undefined?d:'');}
function cleanup(label){if(label)log('cleanup',label);if(_cancelToken){try{_cancelToken.cancel();}catch(_){}_cancelToken=null;}_inFlight=false;}
function filename(orig){var base=String(orig||'document').replace(/\.[^.]+$/,'');return(base.toLowerCase().startsWith('ilovepdf')?base:'ilovepdf-'+base)+'.pdf';}
async function process(files,opts){
 if(_inFlight)throw new Error('Unlock already in progress');
 if(!files||!files[0])throw new Error('No file provided');
 if(!G.BrowserTools||typeof G.BrowserTools.process!=='function')throw new Error('Shared BrowserTools runtime unavailable');
 _inFlight=true;var job=++_jobId,token=(G.WorkerPool&&G.WorkerPool.CancelToken)?new G.WorkerPool.CancelToken():null;_cancelToken=token;
 try{var o=Object.assign({},opts||{});if(token)o.cancelToken=token;log('start',{job:job,file:files[0].name});var result=await G.BrowserTools.process(TOOL_ID,files,o);if(!result||!result.blob||result.blob.size<500)throw new Error('Unlock produced an invalid PDF.');if(!result.filename)result.filename=filename(files[0].name);log('done',{job:job,size:result.blob.size});return result;}
 finally{if(_cancelToken===token)_cancelToken=null;_inFlight=false;}
}
function mount(){log('mounted');}function unmount(){cleanup('unmount');}function reset(){cleanup('reset');}function recover(){cleanup('recover');}function destroy(){cleanup('destroy');}function getState(){return{inFlight:_inFlight,jobId:_jobId,hasCancellation:!!_cancelToken};}
function register(){if(!G.ToolAppManager)return;G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',register);else register();
}(window));
