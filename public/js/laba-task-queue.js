/**
 * LABA BACKGROUND TASK QUEUE  v3.0
 * window.LabaTaskQueue
 *
 * Background processing with resumable jobs, queued workflows,
 * notifications, prioritisation, and cancellation support.
 * Purely browser-side using microtask scheduling.
 */
(function () {
  'use strict';
  if (window.LabaTaskQueue) return;

  var LOG = '[LTQ]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Task Store ────────────────────────────────────────────────────────────
  var _tasks  = new Map(); // id → Task
  var _queue  = [];        // sorted by priority (high first)
  var _running = false;
  var _maxConcurrent = 2;
  var _active = 0;
  var _listeners = []; // onTaskUpdate callbacks

  var STATUS = { QUEUED:'queued', RUNNING:'running', DONE:'done', FAILED:'failed', CANCELLED:'cancelled' };

  function _uid() { return 'tq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }

  // ── Task Object ───────────────────────────────────────────────────────────
  function Task(opts) {
    this.id          = opts.id || _uid();
    this.name        = opts.name || 'Task';
    this.priority    = opts.priority || 5;  // 1 (low) – 10 (high)
    this.fn          = opts.fn;             // async () => result
    this.status      = STATUS.QUEUED;
    this.progress    = 0;
    this.result      = null;
    this.error       = null;
    this.createdAt   = Date.now();
    this.startedAt   = null;
    this.completedAt = null;
    this.cancelToken = false;
    this.onProgress  = opts.onProgress || null;
    this.onDone      = opts.onDone || null;
    this.onFail      = opts.onFail || null;
  }

  Task.prototype.cancel = function () {
    if (this.status === STATUS.QUEUED || this.status === STATUS.RUNNING) {
      this.cancelToken = true;
      this.status      = STATUS.CANCELLED;
      _queue = _queue.filter(function (t) { return t.id !== this.id; }.bind(this));
      _notify(this);
      log('cancelled task:', this.id, this.name);
    }
  };

  Task.prototype.setProgress = function (pct, msg) {
    this.progress = Math.min(100, Math.max(0, pct));
    if (this.onProgress) try { this.onProgress(this.progress, msg); } catch (_) {}
    _notify(this);
  };

  // ── Notify Listeners ─────────────────────────────────────────────────────
  function _notify(task) {
    _listeners.forEach(function (cb) { try { cb(task); } catch (_) {} });
  }

  // ── Enqueue ───────────────────────────────────────────────────────────────
  function enqueue(opts) {
    if (typeof opts === 'function') opts = { fn: opts };
    var task = new Task(opts);
    _tasks.set(task.id, task);
    _queue.push(task);
    _queue.sort(function (a, b) { return b.priority - a.priority; }); // high priority first
    log('enqueued:', task.id, task.name, '(priority:', task.priority + ')');
    _notify(task);
    _pump();
    return task;
  }

  // ── Pump Queue ────────────────────────────────────────────────────────────
  function _pump() {
    if (_running && _active >= _maxConcurrent) return;
    _running = true;
    while (_queue.length && _active < _maxConcurrent) {
      var task = _queue.shift();
      if (task.status === STATUS.CANCELLED) continue;
      _run(task);
    }
    if (!_queue.length && !_active) _running = false;
  }

  async function _run(task) {
    if (task.cancelToken) return;
    _active++;
    task.status    = STATUS.RUNNING;
    task.startedAt = Date.now();
    _notify(task);
    log('running:', task.id, task.name);

    try {
      var result = await task.fn(task);
      if (task.cancelToken) { _active--; _pump(); return; }
      task.result      = result;
      task.status      = STATUS.DONE;
      task.progress    = 100;
      task.completedAt = Date.now();
      if (task.onDone) try { task.onDone(result); } catch (_) {}
      _notify(task);
      log('done:', task.id, task.name, '(' + (task.completedAt - task.startedAt) + 'ms)');
    } catch (err) {
      task.error       = err.message;
      task.status      = STATUS.FAILED;
      task.completedAt = Date.now();
      if (task.onFail) try { task.onFail(err); } catch (_) {}
      _notify(task);
      warn('failed:', task.id, task.name, err.message);
    } finally {
      _active--;
      _pump();
    }
  }

  // ── Notification Toast ────────────────────────────────────────────────────
  function _toast(msg, type) {
    try {
      var el = document.createElement('div');
      el.style.cssText = [
        'position:fixed;bottom:' + (window._laba_toast_offset || 90) + 'px;left:50%;transform:translateX(-50%)',
        'background:' + (type === 'error' ? '#ef4444' : '#4f46e5'),
        'color:#fff;padding:8px 16px;border-radius:20px;font-size:13px',
        'z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.2);pointer-events:none',
        'animation:laba-fadein .2s ease',
      ].join(';');
      el.textContent = msg;
      if (!document.getElementById('laba-toast-style')) {
        var st = document.createElement('style');
        st.id = 'laba-toast-style';
        st.textContent = '@keyframes laba-fadein{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%)}}';
        document.head.appendChild(st);
      }
      document.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3500);
    } catch (_) {}
  }

  // ── Auto-Notify on Completion ─────────────────────────────────────────────
  function onUpdate(cb) { _listeners.push(cb); }

  // Built-in listener: toast on done/failed
  onUpdate(function (task) {
    if (task.status === STATUS.DONE && task.notify !== false) {
      _toast('✅ ' + task.name + ' complete!');
    } else if (task.status === STATUS.FAILED && task.notify !== false) {
      _toast('❌ ' + task.name + ' failed', 'error');
    }
  });

  // ── Convenience Helpers ───────────────────────────────────────────────────
  function runTool(toolId, files, opts) {
    return enqueue({
      name:     'Tool: ' + toolId,
      priority: 7,
      fn: async function (task) {
        task.setProgress(10, 'starting...');
        var tool = window.LabaToolRegistry && window.LabaToolRegistry.findById(toolId);
        if (!tool) throw new Error('Unknown tool: ' + toolId);
        task.setProgress(40, 'processing...');
        var LTR = window.LabaToolRouter;
        if (!LTR) throw new Error('LabaToolRouter not available');
        var result = await LTR.executeTool(toolId, files, opts || {});
        task.setProgress(100, 'done');
        return result;
      },
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaTaskQueue = {
    version:   '3.0',
    STATUS:    STATUS,
    enqueue:   enqueue,
    runTool:   runTool,
    cancel:    function (id) { var t = _tasks.get(id); if (t) t.cancel(); },
    getTask:   function (id) { return _tasks.get(id) || null; },
    listTasks: function () { return Array.from(_tasks.values()); },
    pending:   function () { return _queue.length; },
    active:    function () { return _active; },
    onUpdate:  onUpdate,
    clear:     function () { _tasks.clear(); _queue = []; _active = 0; },
  };

  log('v3.0 ready — background task queue online (max concurrent:', _maxConcurrent + ')');
}());
