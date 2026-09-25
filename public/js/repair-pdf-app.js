// Repair PDF Tool App v2.0 — isolated canonical ToolApp boundary
(function(G){
'use strict';
if(G.RepairPdfApp)return;
var inFlight=false;
var PDFJS_URL='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
var PDFJS_WORKER='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
function loadPdfJs(){
 if(G.pdfjsLib)return Promise.resolve(G.pdfjsLib);
 if(G.__pdfjsLibPromise)return G.__pdfjsLibPromise;
 G.__pdfjsLibPromise=import(PDFJS_URL).then(function(mod){var lib=mod.default||mod;lib.GlobalWorkerOptions.workerSrc=PDFJS_WORKER;G.pdfjsLib=lib;return lib;});
 return G.__pdfjsLibPromise;
}
async function verify(blob){
 var lib=await loadPdfJs(),buf=await blob.arrayBuffer();
 var doc=await lib.getDocument({data:buf.slice(0),isEvalSupported:false}).promise;
 var pages=doc.numPages;await doc.destroy();
 if(pages<1)throw new Error('Repair produced an empty PDF');
 return pages;
}
async function process(files,opts){
 if(inFlight)throw new Error('Repair already in progress');
 var file=files&&files[0];if(!file)throw new Error('No file provided');
 if(G.memTier&&G.memTier()==='critical')throw new Error('Not enough memory. Please close other tabs.');
 inFlight=true;
 try{
  var result=await G.RepairRuntime.execute(file,opts||{});
  var pages=await verify(result.blob);
  if(G.RuntimeTelemetry)try{G.RuntimeTelemetry.record('repair:verify',{pages:pages,outputBytes:result.blob.size});}catch(_){}
  return result;
 }catch(err){throw err}
 finally{inFlight=false;}
}
function mount(){}
function unmount(){if(G.RepairRuntime&&G.RepairRuntime.cancelActive)G.RepairRuntime.cancelActive('unmount');}
function reset(){if(G.RepairRuntime&&G.RepairRuntime.cancelActive)G.RepairRuntime.cancelActive('reset');}
function recover(){if(G.RepairRuntime&&G.RepairRuntime.cancelActive)G.RepairRuntime.cancelActive('recover');}
function destroy(){if(G.RepairRuntime&&G.RepairRuntime.cancelActive)G.RepairRuntime.cancelActive('destroy');}
function getState(){return{inFlight:inFlight,diagnostics:G.RepairRuntime&&G.RepairRuntime.getDiagnostics?G.RepairRuntime.getDiagnostics():null};}
function register(){if(!G.ToolAppManager)return;G.ToolAppManager.registerTool('repair',function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',register);else register();
G.RepairPdfApp={process:process,getState:getState};
}(window));