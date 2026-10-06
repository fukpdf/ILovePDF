// Watermark Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function () {
  'use strict';
  if (window.WatermarkRuntime) return;
  var currentToken = null;
  function startSpan(file) {
    try { if (window.RuntimeTelemetry && typeof window.RuntimeTelemetry.startSpan === 'function') return window.RuntimeTelemetry.startSpan('watermark:execute', { name: file.name, size: file.size }); } catch (_) {}
    return null;
  }
  function endSpan(span, status) { try { if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, status); } catch (_) {} }
  function cleanup(owner, label) {
    if (owner && currentToken && owner !== currentToken) return;
    if (label && window.RuntimeCleanup) { try { window.RuntimeCleanup.run(label); } catch (_) {} }
    if (!owner || owner === currentToken) currentToken = null;
  }
  async function execute(file, opts) {
    opts = opts || {};
    if (!file) throw new Error('No file provided');
    if (!window.RuntimeScheduler || typeof window.RuntimeScheduler.run !== 'function') throw new Error('RuntimeScheduler is unavailable — canonical Watermark runtime cannot execute');
    if (!window.WatermarkWorkerAdapter || typeof window.WatermarkWorkerAdapter.dispatch !== 'function') throw new Error('WatermarkWorkerAdapter is unavailable — canonical worker runtime cannot execute');
    var token = new (window.WorkerPool && window.WorkerPool.CancelToken ? window.WorkerPool.CancelToken : function () { this.cancelled = false; this.cancel = function () { this.cancelled = true; }; })();
    currentToken = token;
    var span = startSpan(file);
    try {
      var result = await window.RuntimeScheduler.run('watermark', async function (taskToken, onProgress) {
        if (taskToken && taskToken.cancelled) throw new Error('cancelled-before-dispatch');
        return window.WatermarkWorkerAdapter.dispatch(file, opts, onProgress, taskToken || token);
      }, { token: token, timeoutMs: 0, label: 'watermark' });
      if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Watermark produced empty output');
      var blob = new Blob([result.buffer], { type: 'application/pdf' });
      var filename = window.BrowserTools && window.BrowserTools.brandedFilename ? window.BrowserTools.brandedFilename(file.name, '.pdf') : 'ILovePDF-watermarked.pdf';
      endSpan(span, 'ok'); cleanup(token, 'watermark-success');
      return { blob: blob, filename: filename };
    } catch (err) {
      endSpan(span, 'error'); cleanup(token, 'watermark-error');
      try { Object.defineProperty(err, '__watermarkRunToken', { value: token, configurable: true }); } catch (_) {}
      throw err;
    }
  }
  function cancelActive(reason) {
    var token = currentToken;
    if (token && typeof token.cancel === 'function') { try { token.cancel(reason || 'cancelled'); } catch (_) {} }
    cleanup(token, 'watermark-cancel-' + (reason || 'manual'));
  }
  function getDiagnostics() { return { active: !!currentToken, hasAdapter: !!(window.WatermarkWorkerAdapter && typeof window.WatermarkWorkerAdapter.dispatch === 'function') }; }
  window.WatermarkRuntime = { execute: execute, cancelActive: cancelActive, getDiagnostics: getDiagnostics };
}());