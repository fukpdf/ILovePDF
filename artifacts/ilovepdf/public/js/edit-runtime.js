// Edit Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function () {
  'use strict';
  if (window.EditRuntime) return;
  var currentToken = null;
  function cleanup(owner, label) {
    if (owner && currentToken && owner !== currentToken) return;
    if (label && window.RuntimeCleanup) { try { window.RuntimeCleanup.run(label); } catch (_) {} }
    if (!owner || owner === currentToken) currentToken = null;
  }
  async function execute(file, opts) {
    opts = opts || {};
    if (!file) throw new Error('No file provided');
    if (!window.RuntimeScheduler || typeof window.RuntimeScheduler.run !== 'function')
      throw new Error('RuntimeScheduler is unavailable — canonical Edit runtime cannot execute');
    if (!window.EditWorkerAdapter || typeof window.EditWorkerAdapter.dispatch !== 'function')
      throw new Error('EditWorkerAdapter is unavailable — canonical worker runtime cannot execute');
    var token = new (window.WorkerPool && window.WorkerPool.CancelToken ? window.WorkerPool.CancelToken :
      function(){this.cancelled=false;this.cancel=function(){this.cancelled=true;};})();
    currentToken = token;
    try {
      var result = await window.RuntimeScheduler.run('edit', async function(taskToken, onProgress) {
        if (taskToken && taskToken.cancelled) throw new Error('cancelled-before-dispatch');
        return window.EditWorkerAdapter.dispatch(file, opts, onProgress, taskToken || token);
      }, {token:token, timeoutMs:0, label:'edit'});
      if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Edit produced empty output');
      var blob = new Blob([result.buffer], {type:'application/pdf'});
      var filename = window.BrowserTools && window.BrowserTools.brandedFilename ?
        window.BrowserTools.brandedFilename(file.name, '.pdf') : 'ILovePDF-edited.pdf';
      cleanup(token, 'edit-success');
      return {blob:blob, filename:filename};
    } catch (err) {
      cleanup(token, 'edit-error');
      try { Object.defineProperty(err, '__editRunToken', {value:token, configurable:true}); } catch (_) {}
      throw err;
    }
  }
  function cancelActive(reason) {
    var token=currentToken;
    if (token && typeof token.cancel==='function') { try { token.cancel(reason || 'cancelled'); } catch (_) {} }
    cleanup(token, 'edit-cancel-' + (reason || 'manual'));
  }
  function getDiagnostics(){return {active:!!currentToken,hasAdapter:!!(window.EditWorkerAdapter&&typeof window.EditWorkerAdapter.dispatch==='function')};}
  window.EditRuntime={execute:execute,cancelActive:cancelActive,getDiagnostics:getDiagnostics};
}());
