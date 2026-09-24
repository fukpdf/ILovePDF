/* Client Processing Kernel — browser-only execution contract */
(function (G) {
  'use strict';
  if (G.ClientProcessingKernel) return;
  const VERSION = '1.4.0';
  const DEFAULT_TIMEOUT = 120000;
  const DEFAULT_CHUNK = 2 * 1024 * 1024;
  const MAX_CHUNK = 8 * 1024 * 1024;
  
  function clampChunkSize(size) {
    const n = Number(size);
    if (!Number.isFinite(n)) return DEFAULT_CHUNK;
    return Math.max(256 * 1024, Math.min(MAX_CHUNK, Math.floor(n)));
  }

  function deviceProfile() {
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 2);
    const memory = Number(navigator.deviceMemory) || 4;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return { cores, memoryGB: memory, saveData: !!(connection && connection.saveData),
      effectiveType: connection && connection.effectiveType || 'unknown' };
  }

  function chooseChunkSize(bytes, options) {
    const p = deviceProfile();
    if (p.saveData || p.memoryGB <= 1 || p.cores <= 2) return 512 * 1024;
    if (bytes > 256 * 1024 * 1024) return 2 * 1024 * 1024;
    if (bytes > 64 * 1024 * 1024) return 4 * 1024 * 1024;
    return clampChunkSize(options && options.chunkSize);
  }

  async function* readChunks(blob, options) {
    if (!(blob instanceof Blob)) throw new TypeError('readChunks expects a Blob/File');
    const size = chooseChunkSize(blob.size, options || {});
    for (let offset = 0; offset < blob.size; offset += size) {
      const end = Math.min(offset + size, blob.size);
      yield { index: Math.floor(offset / size), offset,
        total: Math.ceil(blob.size / size),
        buffer: await blob.slice(offset, end).arrayBuffer() };
    }
  }

  async function* readFileChunks(file, options) { yield* readChunks(file, options); }

  function assertClientOnly(options) {
    if (options && options.allowServerFallback)
      throw new Error('Server fallback is prohibited by ClientProcessingKernel');
  }

  function createWorkerJob(workerUrl, options) {
    assertClientOnly(options);
    if (!workerUrl || !/^\/(workers|engines)\//.test(String(workerUrl)))
      throw new Error('Processing worker must be same-origin under /workers or /engines');
    if (!G.RuntimeWorkerFactory || typeof G.RuntimeWorkerFactory.spawn !== 'function')
      throw new Error('RuntimeWorkerFactory is required for processing workers');
    return G.RuntimeWorkerFactory.spawn(workerUrl);
  }

  function maxInputBytes() {
    // Processing is intentionally not capped by file size. This function is
    // retained as an observability hook; memory safety is handled by adaptive
    // chunking, worker concurrency and backpressure rather than hard rejection.
    return Infinity;
  }

  function validateFile(file) {
    if (!(file instanceof Blob)) throw new TypeError('A File/Blob is required');
  }

  async function processBuffer(workerUrl, file, options) {
    options = options || {};
    validateFile(file, options);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT);
    assertClientOnly(options);
    const callerSignal = options.signal || null;
    const internalController = (typeof AbortController === 'function') ? new AbortController() : null;
    const signal = internalController ? internalController.signal : callerSignal;
    const lifecycleRelease = G.WorkerLifecycle && typeof G.WorkerLifecycle.registerProcessingController === 'function'
      ? G.WorkerLifecycle.registerProcessingController({ abort: function (reason) {
          if (internalController) {
            try { internalController.abort(reason || 'lifecycle-cancel'); } catch (_) {}
          }
        } }) : null;
    let callerAbortRelease = null;
    if (callerSignal && typeof callerSignal.addEventListener === 'function' && internalController) {
      const forwardAbort = () => { try { internalController.abort(callerSignal.reason || 'cancelled'); } catch (_) {} };
      if (callerSignal.aborted) forwardAbort();
      else {
        callerSignal.addEventListener('abort', forwardAbort, { once: true });
        callerAbortRelease = () => callerSignal.removeEventListener('abort', forwardAbort);
      }
    }
    const cancelToken = options.cancelToken || options.token || null;
    if (signal && signal.aborted) throw new Error('processing_cancelled');

    const worker = createWorkerJob(workerUrl, options);
    let bytes = null;
    try {
      bytes = await file.arrayBuffer();
      if (signal && signal.aborted) throw new Error('processing_cancelled');
      if (cancelToken && cancelToken.cancelled) throw new Error('processing_cancelled');
      if (G.ClientFileLifecycle && typeof G.ClientFileLifecycle.trackBuffer === 'function') {
        G.ClientFileLifecycle.trackBuffer(bytes);
      }

      return await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let removeAbort = null;
        let removeToken = null;

        const cleanup = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          if (removeAbort) { try { removeAbort(); } catch (_) {} removeAbort = null; }
          if (removeToken) { try { removeToken(); } catch (_) {} removeToken = null; }
          try { worker.terminate(); } catch (_) {}
          if (G.ClientFileLifecycle && typeof G.ClientFileLifecycle.releaseBuffer === 'function' && bytes instanceof ArrayBuffer) {
            G.ClientFileLifecycle.releaseBuffer(bytes);
          }
          bytes = null;
          if (callerAbortRelease) { try { callerAbortRelease(); } catch (_) {} callerAbortRelease = null; }
          if (lifecycleRelease) { try { lifecycleRelease(); } catch (_) {} }
        };
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };
        const cancel = () => finish(reject, new Error('processing_cancelled'));

        timer = setTimeout(() => finish(reject, new Error('processing_worker_timeout')), timeoutMs);
        if (signal) {
          const onAbort = () => cancel();
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', onAbort);
        }
        if (cancelToken && typeof cancelToken.onCancel === 'function') {
          const onTokenCancel = () => cancel();
          removeToken = cancelToken.onCancel(onTokenCancel) || null;
        }

        worker.onmessage = e => {
          try {
            const data = e.data;
            if (options.validateOutput && G.ClientOutputValidation && data && data.buffer) {
              G.ClientOutputValidation.validate(data.buffer, options.validateOutput === true ? {} : options.validateOutput);
            }
            finish(resolve, data);
          } catch (err) { finish(reject, err); }
        };
        worker.onerror = e => finish(reject, new Error((e && e.message) || 'processing_worker_error'));
        try {
          worker.postMessage({ type: 'process-buffer', buffer: bytes }, [bytes]);
        } catch (err) {
          finish(reject, new Error((err && err.message) || 'processing_worker_postmessage_error'));
        }
      });
    } catch (err) {
      try { worker.terminate(); } catch (_) {}
      if (G.ClientFileLifecycle && typeof G.ClientFileLifecycle.releaseBuffer === 'function' && bytes instanceof ArrayBuffer) {
        G.ClientFileLifecycle.releaseBuffer(bytes);
      }
      if (lifecycleRelease) { try { lifecycleRelease(); } catch (_) {} }
      throw err;
    }
  }

  G.ClientProcessingKernel = Object.freeze({
    VERSION, DEFAULT_CHUNK, MAX_CHUNK, DEFAULT_MAX_INPUT, deviceProfile, chooseChunkSize, maxInputBytes,
    readChunks, readFileChunks, validateFile, assertClientOnly, createWorkerJob, processBuffer
  });
}(window));
