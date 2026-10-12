// Page Numbers Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function () {
  'use strict';
  if (window.PageNumbersRuntime) return;
  var currentToken = null;
  function startSpan(file) { try { if (window.RuntimeTelemetry && typeof window.RuntimeTelemetry.startSpan === 'function') return window.RuntimeTelemetry.startSpan('page-numbers:execute', { name: file.name, size: file.size }); } catch (_) {} return null; }
  function endSpan(span, status) { try { if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, status); } catch (_) {} }
  function cleanup(owner, label) {
    if (owner && currentToken && owner !== currentToken) return;
    if (label && window.RuntimeCleanup) { try { window.RuntimeCleanup.run(label); } catch (_) {} }
    if (!owner || owner === currentToken) currentToken = null;
  }
  async function execute(file, opts) {
    opts = opts || {};
    if (!file) throw new Error('No file provided');
    if (!window.RuntimeScheduler || typeof window.RuntimeScheduler.run !== 'function') throw new Error('RuntimeScheduler is unavailable — canonical Page Numbers runtime cannot execute');
    if (!window.PageNumbersWorkerAdapter || typeof window.PageNumbersWorkerAdapter.dispatch !== 'function') throw new Error('PageNumbersWorkerAdapter is unavailable — canonical worker runtime cannot execute');
    var token = new (window.WorkerPool && window.WorkerPool.CancelToken ? window.WorkerPool.CancelToken : function () { this.cancelled = false; this.cancel = function () { this.cancelled = true; }; })();
    currentToken = token;
    var span = startSpan(file);
    try {
      var result = await window.RuntimeScheduler.run('page-numbers', async function (taskToken, onProgress) {
        if (taskToken && taskToken.cancelled) throw new Error('cancelled-before-dispatch');
        return window.PageNumbersWorkerAdapter.dispatch(file, opts, onProgress, taskToken || token);
      }, { token: token, timeoutMs: 0, label: 'page-numbers' });
      if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Page Numbers produced empty output');
      var blob = new Blob([result.buffer], { type: 'application/pdf' });
      var filename = window.BrowserTools && window.BrowserTools.brandedFilename ? window.BrowserTools.brandedFilename(file.name, '.pdf') : 'ILovePDF-numbered.pdf';
      endSpan(span, 'ok'); cleanup(token, 'page-numbers-success');
      return { blob: blob, filename: filename };
    } catch (err) {
      endSpan(span, 'error'); cleanup(token, 'page-numbers-error');
      try { Object.defineProperty(err, '__pageNumbersRunToken', { value: token, configurable: true }); } catch (_) {}
      throw err;
    }
  }
  function cancelActive(reason) {
    var token = currentToken;
    if (token && typeof token.cancel === 'function') { try { token.cancel(reason || 'cancelled'); } catch (_) {} }
    cleanup(token, 'page-numbers-cancel-' + (reason || 'manual'));
  }
  function getDiagnostics() { return { active: !!currentToken, hasAdapter: !!(window.PageNumbersWorkerAdapter && typeof window.PageNumbersWorkerAdapter.dispatch === 'function') }; }
  window.PageNumbersRuntime = { execute: execute, cancelActive: cancelActive, getDiagnostics: getDiagnostics };
}());
