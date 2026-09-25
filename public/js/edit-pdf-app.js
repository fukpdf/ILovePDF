// Edit PDF ToolApp v2.0 — canonical isolated runtime boundary
(function (G) {
  'use strict';
  if (G.EditPdfApp && G.EditPdfApp.__canonical) return;
  var TOOL_ID='edit';
  function runtime(){if(!G.EditRuntime||typeof G.EditRuntime.execute!=='function')throw new Error('EditRuntime is unavailable');return G.EditRuntime;}
  function cancel(){try{if(runtime().cancelActive)runtime().cancelActive('lifecycle-cancel');}catch(_){}}
  function process(files,opts){if(!files||!files[0])throw new Error('No file provided');return runtime().execute(files[0],opts||{});}
  function mount(){} function unmount(){cancel();} function reset(){cancel();} function recover(){cancel();} function destroy(){cancel();}
  function getState(){try{return runtime().getDiagnostics?runtime().getDiagnostics():{};}catch(_){return{};}}
  function register(){if(!G.ToolAppManager||typeof G.ToolAppManager.registerTool!=='function')return;G.ToolAppManager.registerTool(TOOL_ID,function(){return{process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',register);else register();
  G.EditPdfApp={__canonical:true,process:process,mount:mount,unmount:unmount,reset:reset,recover:recover,destroy:destroy,getState:getState};
}(window));
