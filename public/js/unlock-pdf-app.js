// Unlock PDF Tool App v2.0 — isolated canonical ToolApp boundary
(function(G){
'use strict';
if(G.UnlockPdfApp)return;
var inFlight=false;
var PDFJS_URL='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
var PDFJS_WORKER='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
function loadPdfJs(){if(G.pdfjsLib)return Promise.resolve(G.pdfjsLib);if(G.__pdfjsLibPromise)return G.__pdfjsLibPromise;G.__pdfjsLibPromise=import(PDFJS_URL).then(function(mod){var lib=mod&&mod.getDocument?mod:(mod&&mod.default&&mod.default.getDocument?mod.default:null);if(!lib)throw new Error('PDF.js unavailable');lib.GlobalWorkerOptions.workerSrc=PDFJS_WORKER;G.pdfjsLib=lib;return lib;});return G.__pdfjsLibPromise;}
async function verify(blob){var lib=await loadPdfJs(),buf=await blob.arrayBuffer();var doc=await lib.getDocument({data:buf.slice(0),isEvalSupported:false}).promise;var pages=doc.numPages;await doc.destroy();if(pages<1)throw new Error('Unlock produced an empty PDF');return pages;}
async function process(files,opts){
 if(inFlight)throw new Error('Unlock already in progress');
 var file=files&&files[0];if(!file)throw new Error('No file provided');
 if(G.memTier&&G.memTier()==='critical')throw new Error('Not enough memory. Please close other tabs.');
 inFlight=true;
 try{var result=await G.UnlockRuntime.execute(file,opts||{});var pages=await verify(result.blob);if(G.RuntimeTelemetry)try{G.RuntimeTelemetry.record('unlock:verify',{pages:pages,outputBytes:result.blob.size});}catch(_){}return result;}
 finally{inFlight=false;}
}
function mount(){}
function unmount(){if(G.UnlockRuntime&&G.UnlockRuntime.cancelActive)G.UnlockRuntime.cancelActive('unmount');}
function reset(){if(G.UnlockRuntime&&G.UnlockRuntime.cancelActive)G.UnlockRuntime.cancelActive('reset');}
function recover(){if(G.UnlockRuntime&&G.UnlockRuntime.cancelActive)G.UnlockRuntime.cancelActive('recover');}
function destroy(){if(G.UnlockRuntime&&G.UnlockRuntime.cancelActive)G.UnlockRuntime.cancelActive('destroy');}
function getState(){return{inFlight:inFlight,diagnostics:G.UnlockRuntime&&G.UnlockRuntime.getDiagnostics?G.UnlockRuntime.getDiagnostics():null};}
function register(){if(!G.ToolAppManager)return;G.ToolAppManager.registerTool('unlock',function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',register);else register();
G.UnlockPdfApp={process:process,getState:getState};
}(window));