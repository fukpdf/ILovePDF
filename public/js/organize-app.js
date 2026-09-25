// OrganizeApp v2.0 — canonical ToolApp boundary
(function (G) {
  'use strict';
  var TAG='[OrganizeApp]', TOOL_ID='organize';
  function runtime(){if(!G.OrganizeRuntime||typeof G.OrganizeRuntime.execute!=='function') throw new Error('OrganizeRuntime is not available');return G.OrganizeRuntime;}
  async function process(files,opts){if(!files||!files.length||!files[0]) throw new Error('No file provided');return runtime().execute(files[0],opts||{});}
  function cancel(reason){if(G.OrganizeRuntime&&typeof G.OrganizeRuntime.cancelActive==='function'){try{return G.OrganizeRuntime.cancelActive(reason);}catch(_){}}return false;}
  function mount(){console.debug(TAG,'mounted — canonical runtime');}
  function unmount(){cancel('tool-unmount');} function reset(){cancel('tool-reset');}
  function recover(level){cancel('tool-recover-'+(level||1));} function destroy(){cancel('tool-destroy');}
  function getState(){if(G.OrganizeRuntime&&typeof G.OrganizeRuntime.getDiagnostics==='function'){try{return G.OrganizeRuntime.getDiagnostics();}}catch(_){} return {runtime:'unavailable'};}
  function register(){if(!G.ToolAppManager){console.warn(TAG,'ToolAppManager unavailable');return;} G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',register); else register();
}(window));