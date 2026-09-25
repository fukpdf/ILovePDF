// Compare PDF Tool App v2.0 — isolated canonical ToolApp boundary
(function(G){
'use strict';
if(G.ComparePdfApp)return;
var inFlight=false;
function process(files,opts){
 if(inFlight)throw new Error('Comparison already in progress');
 if(!Array.isArray(files)||files.length<2)throw new Error('Two PDF files are required for comparison');
 inFlight=true;
 return G.CompareRuntime.execute(files,opts||{}).then(function(result){
  if(!result||!result.blob||!result.blob.size)throw new Error('Compare produced an empty report');
  if(G.RuntimeTelemetry)try{G.RuntimeTelemetry.record('compare:verify',{outputBytes:result.blob.size,files:files.length});}catch(_){}
  return result;
 }).finally(function(){inFlight=false;});
}
function mount(){}
function unmount(){if(G.CompareRuntime&&G.CompareRuntime.cancelActive)G.CompareRuntime.cancelActive('unmount');}
function reset(){if(G.CompareRuntime&&G.CompareRuntime.cancelActive)G.CompareRuntime.cancelActive('reset');}
function recover(){if(G.CompareRuntime&&G.CompareRuntime.cancelActive)G.CompareRuntime.cancelActive('recover');}
function destroy(){if(G.CompareRuntime&&G.CompareRuntime.cancelActive)G.CompareRuntime.cancelActive('destroy');}
function getState(){return{inFlight:inFlight,diagnostics:G.CompareRuntime&&G.CompareRuntime.getDiagnostics?G.CompareRuntime.getDiagnostics():null};}
function register(){if(!G.ToolAppManager)return;G.ToolAppManager.registerTool('compare',function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',register);else register();
G.ComparePdfApp={process:process,getState:getState};
}(window));
