/**
 * PHASE 61 — AUTONOMOUS AI WORKERS
 * window.AutonomousAiWorkers
 *
 * 61A AutonomousPlanner          — NL goal → DAG task graph
 * 61B DynamicExecutionManager    — adaptive scheduling, GPU/CPU routing
 * 61C SelfLearningMemory         — IDB workflow history, adaptive optimization
 * 61D LongRunningWorkerRuntime   — checkpoint, crash/refresh recovery, resume
 * 61E AgentDelegationSystem      — sub-worker spawning, merge, quorum
 *
 * Purely additive. Extends AutonomousAgentSystem without replacing it.
 * Degrades gracefully. P2P remains OFF. Never blocks main thread.
 */
(function () {
  'use strict';

  var VERSION    = '1.0';
  var LOG        = '[AAW]';
  var DB_NAME    = 'aaw_workers_v1';
  var CKPT_MS    = 30000;   // checkpoint every 30 s
  var MAX_DEPTH  = 8;       // max sub-worker delegation depth
  var STEP_TOUT  = 90000;   // 90 s per step timeout

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'aaw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7); }
  function now()  { return Date.now(); }
  function sleep(ms) { return new Promise(function(r){setTimeout(r,ms);}); }
  function frame()   { return new Promise(function(r){ (requestAnimationFrame || setTimeout)(r, 0); }); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § SHARED: IDB STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkerDb = (function () {
    var _db = null;
    var STORES = ['plans','tasks','memory','checkpoints','history','delegation'];
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e){
          var db = e.target.result;
          STORES.forEach(function(s){
            if (!db.objectStoreNames.contains(s))
              db.createObjectStore(s, {keyPath:'id'});
          });
        };
        req.onsuccess = function(e){ _db=e.target.result; res(_db); };
        req.onerror   = function(){ rej(req.error); };
      });
    }
    function put(store, obj)  { return open().then(function(db){ return new Promise(function(r){ var tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    function get(store, id)   { return open().then(function(db){ return new Promise(function(r){ var req=db.transaction(store,'readonly').objectStore(store).get(id); req.onsuccess=function(){r(req.result||null);}; req.onerror=function(){r(null);}; }); }).catch(function(){return null;}); }
    function getAll(store)    { return open().then(function(db){ return new Promise(function(r){ var req=db.transaction(store,'readonly').objectStore(store).getAll(); req.onsuccess=function(){r(req.result||[]);}; req.onerror=function(){r([]);}; }); }).catch(function(){return [];}); }
    function del(store, id)   { return open().then(function(db){ return new Promise(function(r){ var tx=db.transaction(store,'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    return { put:put, get:get, getAll:getAll, del:del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 61A  AUTONOMOUS PLANNER
  // ═══════════════════════════════════════════════════════════════════════════
  var AutonomousPlanner = (function () {

    function _estimateCost(task) {
      var text = (task.description || '').toLowerCase();
      var fileSize = task.fileSizeBytes || 0;
      var complexity = text.length / 100 + (fileSize / (1024*1024));
      return {
        estimatedMs:  Math.min(300000, Math.max(500, complexity * 1000)),
        estimatedMb:  Math.min(512,   Math.max(4,   complexity * 2)),
        estimatedTokens: Math.min(32000, Math.max(256, text.length * 2)),
        strategy: complexity > 50 ? 'distributed' : complexity > 10 ? 'streaming' : 'local'
      };
    }

    function _buildDag(goal, steps) {
      // Build a dependency graph from ordered steps
      var nodes = steps.map(function(s, i){
        return { id: 'step_' + i, description: s, deps: i > 0 ? ['step_' + (i-1)] : [], status: 'pending' };
      });
      return { goal: goal, nodes: nodes, createdAt: now() };
    }

    async function plan(goal, opts) {
      opts = opts || {};
      var planId = uid();
      var fileSize = opts.fileSizeBytes || 0;
      var giantFile = fileSize > 50 * 1024 * 1024;

      // Use RGI or existing agent to decompose goal
      var steps = [];
      try {
        var RGI = sys('RealGenerativeIntelligence');
        var AAS = sys('AutonomousAgentSystem');
        if (RGI && RGI.reason) {
          var result = await RGI.reason(
            'Decompose this goal into 3-5 concrete steps. List one per line.\nGoal: ' + goal.slice(0, 400),
            { giantFile: giantFile }
          );
          steps = (result.answer || '').split(/\n+/).filter(Boolean).slice(0, 5);
        } else if (AAS && AAS.SelfPlanningEngine) {
          var plan = await AAS.SelfPlanningEngine.plan(goal, opts);
          steps = (plan.steps || []).map(function(s){ return s.description || s; });
        }
      } catch (e) { warn('plan generation failed:', e.message); }

      if (steps.length === 0) {
        steps = ['Analyze input', 'Process document', 'Generate output'];
      }

      var dag = _buildDag(goal, steps);
      var cost = _estimateCost({ description: goal, fileSizeBytes: fileSize });

      var planObj = { id: planId, goal: goal, dag: dag, cost: cost,
                      giantFile: giantFile, status: 'ready', ts: now() };
      await WorkerDb.put('plans', planObj);
      return planObj;
    }

    function estimateCost(task) { return _estimateCost(task); }

    return { plan: plan, estimateCost: estimateCost };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 61B  DYNAMIC EXECUTION MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var DynamicExecutionManager = (function () {
    var _queue    = [];    // { id, task, priority, addedAt }
    var _running  = 0;
    var _maxConcurrent = 2;
    var _thermal  = 'normal'; // normal | warm | hot
    var _paused   = false;

    function _detectThermal() {
      // Use memory pressure as a proxy for thermal state
      var mp = sys('MemPressure') || sys('MemoryPressureMonitor');
      if (mp) {
        var tier = (mp.tier && mp.tier()) || 'normal';
        if (tier === 'critical') { _thermal = 'hot'; _maxConcurrent = 1; }
        else if (tier === 'high') { _thermal = 'warm'; _maxConcurrent = 2; }
        else { _thermal = 'normal'; _maxConcurrent = 3; }
      }
    }

    function _selectExecution(task) {
      _detectThermal();
      var nav = navigator || {};
      var mem = nav.deviceMemory || 4;
      var hasGpu = !!(nav.gpu);
      var fileSize = task.fileSizeBytes || 0;
      var giantFile = fileSize > 50 * 1024 * 1024;

      // Low battery or hot: force CPU local
      var dev = (sys('RealGenerativeIntelligence') || {}).DeviceProbe;
      var probe = dev ? dev.probe() : {};
      if (probe.lowBattery || _thermal === 'hot') return 'cpu_local';

      // Giant file: streaming
      if (giantFile) return 'streaming_local';

      // High memory device + GPU: use GPU
      if (mem >= 8 && hasGpu) return 'gpu_local';

      // Low RAM: minimal local
      if (mem < 2) return 'cpu_minimal';

      return 'cpu_local';
    }

    function enqueue(task, priority) {
      var item = { id: uid(), task: task, priority: priority || 5, addedAt: now() };
      _queue.push(item);
      _queue.sort(function(a,b){ return a.priority - b.priority; });
      _drain();
      return item.id;
    }

    function _drain() {
      if (_paused) return;
      while (_running < _maxConcurrent && _queue.length > 0) {
        var item = _queue.shift();
        _running++;
        _execute(item).finally(function(){ _running--; _drain(); });
      }
    }

    async function _execute(item) {
      var task = item.task;
      var mode = _selectExecution(task);
      var t0 = now();
      try {
        await frame(); // never block UI on task start
        var fn = task.fn || task.execute;
        if (typeof fn === 'function') {
          await Promise.race([
            fn(mode),
            new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('timeout')); }, STEP_TOUT); })
          ]);
        }
        await SelfLearningMemory.record(task.type || 'generic', true, now() - t0, mode);
      } catch (e) {
        warn('task', item.id, 'failed:', e.message);
        await SelfLearningMemory.record(task.type || 'generic', false, now() - t0, mode);
      }
    }

    function pause() { _paused = true; }
    function resume() { _paused = false; _drain(); }
    function queueLength() { return _queue.length; }
    function status() { return { running: _running, queued: _queue.length, thermal: _thermal, maxConcurrent: _maxConcurrent }; }

    return { enqueue: enqueue, pause: pause, resume: resume, queueLength: queueLength, status: status };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 61C  SELF-LEARNING MEMORY
  // ═══════════════════════════════════════════════════════════════════════════
  var SelfLearningMemory = (function () {
    var _cache = {};  // taskType → { successes, failures, bestMode, avgMs }

    async function record(taskType, success, ms, mode) {
      var key = taskType || 'generic';
      if (!_cache[key]) _cache[key] = { successes:0, failures:0, modes:{}, avgMs:0, calls:0 };
      var r = _cache[key];
      r.calls++;
      if (success) r.successes++; else r.failures++;
      r.avgMs = r.avgMs ? (r.avgMs * 0.8 + ms * 0.2) : ms;
      r.modes[mode] = (r.modes[mode] || 0) + (success ? 1 : 0);
      r.bestMode = Object.keys(r.modes).sort(function(a,b){ return r.modes[b]-r.modes[a]; })[0];

      await WorkerDb.put('history', { id: key, data: r, ts: now() });

      // Also tell VectorMemoryEngine about it
      try {
        var VME = sys('VectorMemoryEngine');
        if (VME && VME.index) {
          await VME.index([{
            text: 'task:' + key + ' success:' + success + ' mode:' + mode + ' ms:' + ms,
            meta: { type:'worker_history', taskType: key, success: success }
          }], 'worker_' + key);
        }
      } catch(_){}
    }

    async function getBestMode(taskType) {
      var key = taskType || 'generic';
      if (_cache[key] && _cache[key].bestMode) return _cache[key].bestMode;
      var stored = await WorkerDb.get('history', key);
      if (stored && stored.data && stored.data.bestMode) return stored.data.bestMode;
      return null;
    }

    async function getStats(taskType) {
      var key = taskType || 'generic';
      var stored = await WorkerDb.get('history', key);
      return (stored && stored.data) || _cache[key] || null;
    }

    return { record: record, getBestMode: getBestMode, getStats: getStats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 61D  LONG-RUNNING WORKER RUNTIME
  // ═══════════════════════════════════════════════════════════════════════════
  var LongRunningWorkerRuntime = (function () {
    var _workers = new Map(); // workerId → state

    function _stateKey(id) { return 'lrwr_' + id; }

    async function _loadCheckpoint(workerId) {
      return WorkerDb.get('checkpoints', _stateKey(workerId));
    }

    async function _saveCheckpoint(workerId, state) {
      await WorkerDb.put('checkpoints', {
        id: _stateKey(workerId),
        state: state,
        ts: now()
      });
    }

    async function start(workerId, steps, opts) {
      opts = opts || {};
      var ckpt = await _loadCheckpoint(workerId);
      var startStep = 0;
      var partialResults = [];

      if (ckpt && ckpt.state) {
        startStep = ckpt.state.nextStep || 0;
        partialResults = ckpt.state.results || [];
        log('resuming worker', workerId, 'from step', startStep);
      }

      var state = { workerId: workerId, nextStep: startStep, results: partialResults,
                    status: 'running', startedAt: now() };
      _workers.set(workerId, state);

      var timer = setInterval(function(){
        var s = _workers.get(workerId);
        if (s) _saveCheckpoint(workerId, s);
      }, CKPT_MS);

      try {
        for (var i = startStep; i < steps.length; i++) {
          var step = steps[i];
          state.nextStep = i;
          await frame();

          var result = null;
          try {
            result = await Promise.race([
              (typeof step === 'function' ? step(state) : Promise.resolve(step)),
              new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('step timeout')); }, STEP_TOUT); })
            ]);
          } catch (e) {
            warn('worker', workerId, 'step', i, 'failed:', e.message);
            result = { error: e.message };
          }

          state.results.push(result);
          state.nextStep = i + 1;
          await _saveCheckpoint(workerId, state);
        }
        state.status = 'complete';
      } catch (e) {
        state.status = 'failed';
        state.error = e.message;
        warn('worker', workerId, 'fatal:', e.message);
      } finally {
        clearInterval(timer);
        await _saveCheckpoint(workerId, state);
        _workers.delete(workerId);
      }

      return state;
    }

    async function cancel(workerId) {
      var s = _workers.get(workerId);
      if (s) { s.status = 'cancelled'; await _saveCheckpoint(workerId, s); _workers.delete(workerId); }
    }

    async function resume(workerId, steps, opts) {
      return start(workerId, steps, opts);
    }

    function status(workerId) {
      return _workers.get(workerId) || null;
    }

    return { start: start, cancel: cancel, resume: resume, status: status };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 61E  AGENT DELEGATION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentDelegationSystem = (function () {
    var _graph = new Map(); // parentId → [childId]
    var _depth = new Map(); // workerId → depth

    async function delegate(parentId, subtasks, opts) {
      opts = opts || {};
      var parentDepth = _depth.get(parentId) || 0;
      if (parentDepth >= MAX_DEPTH) {
        warn('max delegation depth reached for', parentId);
        return { error: 'max_depth', results: [] };
      }

      var children = [];
      var results = [];

      for (var i = 0; i < subtasks.length; i++) {
        var childId = uid();
        _depth.set(childId, parentDepth + 1);

        var existing = _graph.get(parentId) || [];
        existing.push(childId);
        _graph.set(parentId, existing);

        await WorkerDb.put('delegation', { id: childId, parentId: parentId, subtask: subtasks[i], depth: parentDepth+1, ts: now() });
        children.push(childId);
      }

      // Execute subtasks (concurrently up to 2)
      var BATCH = 2;
      for (var j = 0; j < children.length; j += BATCH) {
        var batch = children.slice(j, j + BATCH);
        var batchResults = await Promise.all(batch.map(function(cid, idx){
          var subtask = subtasks[j + idx];
          return _runSubtask(cid, subtask, opts).catch(function(e){ return { error: e.message }; });
        }));
        results = results.concat(batchResults);
        await frame();
      }

      // Quorum validation: if >50% succeed, proceed
      var successes = results.filter(function(r){ return !r.error; }).length;
      var quorum = successes / results.length >= 0.5;

      return {
        parentId: parentId,
        childCount: children.length,
        results: results,
        quorum: quorum,
        merged: _merge(results)
      };
    }

    async function _runSubtask(workerId, subtask, opts) {
      await frame();
      var RGI = sys('RealGenerativeIntelligence');
      if (RGI && RGI.reason) {
        return RGI.reason(subtask.goal || subtask.description || String(subtask), opts);
      }
      // Fallback: return subtask description as result
      return { answer: subtask.goal || subtask.description || String(subtask), confidence: 0.5 };
    }

    function _merge(results) {
      // Merge text answers from all successful sub-workers
      return results
        .filter(function(r){ return !r.error && r.answer; })
        .map(function(r){ return r.answer; })
        .join('\n\n---\n\n');
    }

    function getGraph(parentId) {
      return _graph.get(parentId) || [];
    }

    return { delegate: delegate, getGraph: getGraph };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.AutonomousAiWorkers = {
    VERSION: VERSION,
    AutonomousPlanner:       AutonomousPlanner,
    DynamicExecutionManager: DynamicExecutionManager,
    SelfLearningMemory:      SelfLearningMemory,
    LongRunningWorkerRuntime: LongRunningWorkerRuntime,
    AgentDelegationSystem:   AgentDelegationSystem,
    // Convenience API
    plan:     function(goal, opts) { return AutonomousPlanner.plan(goal, opts); },
    run:      function(id, steps, opts) { return LongRunningWorkerRuntime.start(id, steps, opts); },
    delegate: function(pid, tasks, opts) { return AgentDelegationSystem.delegate(pid, tasks, opts); },
  };

  log('v' + VERSION + ' ready');

  // Restore any interrupted workers on boot
  setTimeout(function(){
    WorkerDb.getAll('checkpoints').then(function(rows){
      var interrupted = rows.filter(function(r){ return r.state && r.state.status === 'running'; });
      if (interrupted.length) log('found', interrupted.length, 'interrupted worker(s) — call .run(id, steps) to resume');
    }).catch(function(){});
  }, 500);

})();
