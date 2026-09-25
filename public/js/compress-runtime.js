// Compress Runtime v2.0 — canonical RuntimeScheduler + RuntimeWorkers
(function () {
  'use strict';
  if (window.CompressRuntime) return;

  var currentToken = null;

  function cleanup(owner, label) {
    if (owner && currentToken && owner !== currentToken) return;
    if (label && window.RuntimeCleanup) {
      try { window.RuntimeCleanup.run(label); } catch (_) {}
    }
    if (!owner || owner === currentToken) currentToken = null;
  }

  async function execute(file, opts) {
    opts = opts || {};
    if (!file) throw new Error('No file provided');
    if (!window.RuntimeScheduler || typeof window.RuntimeScheduler.run !== 'function') {
      throw new Error('RuntimeScheduler is unavailable — canonical Compress runtime cannot execute');
    }
    if (!window.CompressWorkerAdapter || typeof window.CompressWorkerAdapter.dispatch !== 'function') {
      throw new Error('CompressWorkerAdapter is unavailable — canonical worker runtime cannot execute');
    }

    var token = new (window.WorkerPool && window.WorkerPool.CancelToken
      ? window.WorkerPool.CancelToken
      : function () {
          this.cancelled = false;
          this.cancel = function () { this.cancelled = true; };
        })();
    currentToken = token;

    try {
      var result = await window.RuntimeScheduler.run(
        'compress',
        async function (taskToken, onProgress) {
          if (taskToken && taskToken.cancelled) throw new Error('cancelled-before-dispatch');
          return window.CompressWorkerAdapter.dispatch(
            file,
            opts,
            onProgress,
            taskToken || token
          );
        },
        { token: token, timeoutMs: 0, label: 'compress' }
      );

      if (!result || !result.buffer || !result.buffer.byteLength) {
        throw new Error('Compress produced empty output');
      }

      var blob = new Blob([result.buffer], { type: 'application/pdf' });
      var alreadyOptimized = blob.size >= file.size;
      var filename = window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(file.name, '.pdf')
        : 'ILovePDF-compressed.pdf';

      cleanup(token, 'compress-success');
      return {
        blob: blob,
        filename: filename,
        alreadyOptimized: alreadyOptimized
      };
    } catch (err) {
      cleanup(token, 'compress-error');
      try {
        Object.defineProperty(err, '__compressRunToken', {
          value: token,
          configurable: true
        });
      } catch (_) {}
      throw err;
    }
  }

  function cancelActive(reason) {
    var token = currentToken;
    if (token && typeof token.cancel === 'function') {
      try { token.cancel(reason || 'cancelled'); } catch (_) {}
    }
    cleanup(token, 'compress-cancel-' + (reason || 'manual'));
  }

  function getDiagnostics() {
    return {
      active: !!currentToken,
      hasAdapter: !!(
        window.CompressWorkerAdapter &&
        typeof window.CompressWorkerAdapter.dispatch === 'function'
      )
    };
  }

  window.CompressRuntime = {
    execute: execute,
    cancelActive: cancelActive,
    getDiagnostics: getDiagnostics
  };
}());
