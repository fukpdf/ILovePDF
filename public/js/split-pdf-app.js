// SplitPdfApp v1.1 — canonical ToolApp boundary
(function (G) {
  'use strict';
  var TAG='[SplitPdfApp]', TOOL_ID='split';
  function runtime(){if(!G.SplitRuntime||typeof G.SplitRuntime.execute!=='function') throw new Error('SplitRuntime is not available');return G.SplitRuntime;}
  async function process(files,opts){if(!files||!files.length||!files[0]) throw new Error('No file provided');return runtime().execute(files[0],opts||{});}
  function cancel(reason){if(G.SplitRuntime&&typeof G.SplitRuntime.cancelActive==='function'){try{return G.SplitRuntime.cancelActive(reason);}catch(_){}}return false;}
  function mount(){console.debug(TAG,'mounted — canonical runtime');}
  function unmount(){cancel('tool-unmount');} function reset(){cancel('tool-reset');}
  function recover(level){cancel('tool-recover-'+(level||1));} function destroy(){cancel('tool-destroy');}
  function getState(){if(G.SplitRuntime&&typeof G.SplitRuntime.getDiagnostics==='function'){try{return G.SplitRuntime.getDiagnostics();}catch(_){}}
    return {runtime:'unavailable'};}
  function register(){if(!G.ToolAppManager){console.warn(TAG,'ToolAppManager unavailable');return;}
    G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',register); else register();
}(window));
