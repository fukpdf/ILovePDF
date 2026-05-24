// RuntimeStreamWorkers v1.0 — Arc 7 / Phase C
// =====================================================================
// Chunked processing coordinator. Sits ABOVE RuntimeStreamBridge
// (which handles the byte transport) and RuntimeStreamPipeline
// (which handles backpressure) — this manages EXECUTION SCHEDULING:
//
//   - Micro-batch scheduling: breaks long CPU tasks into yielding chunks
//     using requestIdleCallback + deadline.timeRemaining()
//   - Partial completion checkpoints: saves progress to IDB so a
//     tab-reload or crash can resume from the last checkpoint
//   - Tab suspension detection: pauses on visibilitychange, resumes
//     when the tab becomes visible again
//   - Progressive progress events: streams 0–100% progress so the UI
//     can show live updates without waiting for completion
//   - Continuation tokens: callers get a token to query or cancel
//
// Does NOT replace WorkerPool or StreamBridge — extends them.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamWorkers) return;

  var LOG     = '[StreamWorkers]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var _cores        = navigator.hardwareConcurrency || 2;
  var MICRO_MS      = _cores <= 2 ? 8 : _cores <= 4 ? 12 : 16;
  var YIELD_FREQ    = 5;   // yield every N chunks regardless
  var SUSPEND_PAUSE = true;
  var IDB_TTL_MS    = 4 * 60 * 60 * 1000; // 4 hr checkpoint TTL

  // ── Execution state ───────────────────────────────────────────────
  var _tokens   = {};   // token → { state, onProgress, onComplete, onError, chunks[] }
  var _paused   = false;
  var _metrics  = { tasks: 0, completed: 0, suspended: 0, resumed: 0, checkpoints: 0, errors: 0 };
  var _telemetry = [];

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  function _genToken() {
    return 'swt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ── Checkpoint: save progress to IDB ──────────────────────────────
  var _idbName = 'ilpdf-stream-workers';
  var _idbVer  = 1;
  var _idb     = null;

  function _openIdb() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(_idbName, _idbVer);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore('checkpoints', { keyPath: 'token' });
      };
      req.onsuccess = function () { _idb = req.result; res(_idb); };
      req.onerror   = function () { rej(req.error); };
    });
  }

  function _saveCheckpoint(token, data) {
    _metrics.checkpoints++;
    _openIdb().then(function (db) {
      var tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put({ token: token, ts: Date.now(), data: data });
    }).catch(function () {});
  }

  function _loadCheckpoint(token) {
    return _openIdb().then(function (db) {
      return new Promise(function (res) {
        var tx  = db.transaction('checkpoints', 'readonly');
        var req = tx.objectStore('checkpoints').get(token);
        req.onsuccess = function () {
          var rec = req.result;
          if (!rec || (Date.now() - rec.ts) > IDB_TTL_MS) { res(null); return; }
          res(rec.data);
        };
        req.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }

  function _clearCheckpoint(token) {
    _openIdb().then(function (db) {
      var tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').delete(token);
    }).catch(function () {});
  }

  // ── Micro-batch runner ────────────────────────────────────────────
  function _runBatch(token) {
    var task = _tokens[token];
    if (!task || task.state === 'done' || task.state === 'error') return;
    if (_paused) { task.state = 'suspended'; return; }
    task.state = 'running';

    var run = function (deadline) {
      if (_paused || !_tokens[token]) return;
      var ran = 0;
      while (task.chunks.length > 0) {
        var ok = deadline ? (deadline.timeRemaining() > MICRO_MS) : true;
        if (!ok && ran > 0) break;
        if (ran >= YIELD_FREQ) break;

        var chunk = task.chunks.shift();
        try {
          var result = chunk.fn(chunk.data);
          ran++;
          task.processedBytes += (chunk.bytes || 0);
          task.processedChunks++;

          var pct = task.totalChunks > 0
            ? Math.round((task.processedChunks / task.totalChunks) * 100)
            : -1;
          try { task.onProgress && task.onProgress(pct, result); } catch (_) {}

          // Checkpoint every 10 chunks
          if (task.processedChunks % 10 === 0) {
            _saveCheckpoint(token, { processedChunks: task.processedChunks, totalChunks: task.totalChunks });
          }

          try {
            G.dispatchEvent(new CustomEvent('stream-workers:progress', {
              detail: { token: token, pct: pct, chunk: task.processedChunks, total: task.totalChunks },
            }));
          } catch (_) {}
        } catch (e) {
          task.state = 'error';
          _metrics.errors++;
          try { task.onError && task.onError(e); } catch (_) {}
          _tel('error', { token: token, err: e && e.message });
          return;
        }
      }

      if (task.chunks.length === 0) {
        // All done
        task.state     = 'done';
        task.doneAt    = Date.now();
        task.durationMs = task.doneAt - task.startedAt;
        _metrics.completed++;
        _clearCheckpoint(token);
        try { task.onComplete && task.onComplete(); } catch (_) {}
        _tel('done', { token: token, ms: task.durationMs, chunks: task.processedChunks });
        console.debug(LOG, 'task done:', token, '—', task.durationMs + 'ms |', task.processedChunks, 'chunks');
      } else {
        // More chunks remaining — yield and re-schedule
        if (typeof G.requestIdleCallback === 'function') {
          G.requestIdleCallback(run, { timeout: 2000 });
        } else {
          setTimeout(function () { run(null); }, 16);
        }
      }
    };

    if (typeof G.requestIdleCallback === 'function') {
      G.requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(function () { run(null); }, 0);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  // Submit a chunked task. Returns a continuation token.
  // chunks: [{ fn: Function, data: any, bytes?: number }]
  function submit(spec) {
    var token = _genToken();
    var chunks = spec.chunks || [];
    _tokens[token] = {
      token:           token,
      state:           'queued',
      chunks:          chunks.slice(),
      totalChunks:     chunks.length,
      processedChunks: 0,
      processedBytes:  0,
      totalBytes:      spec.totalBytes || 0,
      startedAt:       Date.now(),
      doneAt:          null,
      durationMs:      null,
      onProgress:      spec.onProgress  || null,
      onComplete:      spec.onComplete  || null,
      onError:         spec.onError     || null,
    };
    _metrics.tasks++;
    _tel('submit', { token: token, chunks: chunks.length });
    setTimeout(function () { _runBatch(token); }, 0);
    return token;
  }

  function cancel(token) {
    var task = _tokens[token];
    if (task) { task.state = 'cancelled'; task.chunks = []; }
    _clearCheckpoint(token);
    delete _tokens[token];
  }

  function getState(token) {
    var task = _tokens[token];
    if (!task) return null;
    return {
      state: task.state, pct: task.totalChunks > 0
        ? Math.round((task.processedChunks / task.totalChunks) * 100) : -1,
      processedChunks: task.processedChunks, totalChunks: task.totalChunks,
    };
  }

  // ── Tab suspension ────────────────────────────────────────────────
  if (SUSPEND_PAUSE) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        _paused = true;
        _metrics.suspended++;
        _tel('suspended', { active: Object.keys(_tokens).length });
        console.debug(LOG, 'suspended — tab hidden');
      } else {
        _paused = false;
        _metrics.resumed++;
        _tel('resumed', {});
        console.debug(LOG, 'resumed — tab visible');
        // Resume all suspended tasks
        Object.keys(_tokens).forEach(function (token) {
          var task = _tokens[token];
          if (task && task.state === 'suspended' && task.chunks.length > 0) {
            _runBatch(token);
          }
        });
      }
    });
  }

  G.RuntimeStreamWorkers = Object.freeze({
    VERSION:      VERSION,
    submit:       submit,
    cancel:       cancel,
    getState:     getState,
    getMetrics:   function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _telemetry.slice(); },
    isPaused:     function () { return _paused; },
    loadCheckpoint: _loadCheckpoint,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — micro-batch chunked execution active | yield:', MICRO_MS + 'ms');

}(window));
