// Worker Pool — manages up to MAX_WORKERS concurrent Web Workers.
// Workers are created on demand, assigned one task, and terminated after completion.
// Excess tasks are queued and dispatched as workers become free.
// Integrates with SharedArrayBuffer when COOP+COEP headers are present.
(function () {
  const MAX_WORKERS     = 4;
  const TASK_TIMEOUT_MS = 90_000; // 90 s hard cap — heavy PDFs can be slow

  let activeCount = 0;
  const taskQueue = [];

  function drainQueue() {
    while (taskQueue.length > 0 && activeCount < MAX_WORKERS) {
      const task = taskQueue.shift();
      _spawnWorker(task);
    }
  }

  function _spawnWorker({ workerUrl, message, transferables, resolve, reject }) {
    activeCount++;
    let settled = false;
    let worker;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { worker && worker.terminate(); } catch (_) {}
      activeCount--;
      drainQueue();
      reject(new Error('Worker task timed out after ' + (TASK_TIMEOUT_MS / 1000) + 's'));
    }, TASK_TIMEOUT_MS);

    function finish() {
      clearTimeout(timer);
      activeCount--;
      drainQueue();
    }

    try {
      // Classic (non-module) worker for maximum browser compatibility and
      // importScripts() support inside the worker script.
      worker = new Worker(workerUrl);
    } catch (e) {
      finish();
      return reject(new Error('Worker creation failed: ' + e.message));
    }

    worker.onmessage = (e) => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch (_) {}
      finish();
      if (e.data && e.data.__error) {
        reject(new Error(e.data.__error));
      } else {
        resolve(e.data);
      }
    };

    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch (_) {}
      finish();
      reject(new Error(e.message || 'Worker script error'));
    };

    // Use transferable ArrayBuffers for zero-copy file passing.
    // If transferables are SharedArrayBuffers (available after COOP+COEP),
    // the worker can read them without copy or transfer semantics.
    try {
      worker.postMessage(message, transferables || []);
    } catch (e) {
      // Structured-clone fallback when transferables list is invalid.
      worker.postMessage(message);
    }
  }

  // Run a task in the pool.
  // workerUrl   — URL of the worker script (e.g. '/workers/pdf-worker.js')
  // message     — object sent to the worker via postMessage
  // transferables — optional array of ArrayBuffers to transfer (zero-copy)
  function run(workerUrl, message, transferables) {
    return new Promise((resolve, reject) => {
      const task = { workerUrl, message, transferables: transferables || [], resolve, reject };
      if (activeCount < MAX_WORKERS) {
        _spawnWorker(task);
      } else {
        taskQueue.push(task);
      }
    });
  }

  function getStats() {
    return { active: activeCount, queued: taskQueue.length, max: MAX_WORKERS };
  }

  window.WorkerPool = { run, getStats, MAX_WORKERS };
})();
