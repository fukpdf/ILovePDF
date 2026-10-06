/**
 * PHASE 43 — TRUE DISTRIBUTED COMPUTE
 * window.DistributedAiOrchestrator
 *
 * Purely additive. P2P is opt-in / disabled by default.
 * Integrates with existing WorkerPool, MultiTabCluster, P2PComputeMesh.
 * Degrades gracefully to local compute when peers are unavailable.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[DAO]', ...a); }
  function warn(...a) { console.warn('[DAO]', ...a); }

  const CHECKPOINT_DB = 'dao_checkpoints_v1';
  const TASK_TIMEOUT_MS = 60_000;
  const MAX_RETRIES = 3;

  // ─────────────────────────────────────────────────────────────
  // IDB checkpoint store
  // ─────────────────────────────────────────────────────────────
  const CheckpointStore = (() => {
    let _db = null;
    async function open() {
      if (_db) return _db;
      return new Promise((res, rej) => {
        const req = indexedDB.open(CHECKPOINT_DB, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          ['tasks','chunks','owners'].forEach(s => {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
          });
        };
        req.onsuccess = e => { _db = e.target.result; res(_db); };
        req.onerror   = () => rej(req.error);
      });
    }
    async function put(store, obj) {
      try { const db = await open(); new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete=r; }); } catch {}
    }
    async function getAll(store) {
      try { const db = await open(); return new Promise(r => { const req = db.transaction(store,'readonly').objectStore(store).getAll(); req.onsuccess=()=>r(req.result||[]); req.onerror=()=>r([]); }); } catch { return []; }
    }
    async function del(store, id) {
      try { const db = await open(); new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete=r; }); } catch {}
    }
    return { put, getAll, del };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. PeerReliabilityScoring
  // ─────────────────────────────────────────────────────────────
  const PeerReliabilityScoring = (() => {
    const _peers = new Map(); // peerId → stats

    function _ensure(peerId) {
      if (!_peers.has(peerId)) {
        _peers.set(peerId, { peerId, success: 0, fail: 0, latencies: [], disconnects: 0, retries: 0, score: 0.5 });
      }
      return _peers.get(peerId);
    }

    function record(peerId, { success = false, latencyMs = 0, disconnect = false, retry = false } = {}) {
      const p = _ensure(peerId);
      if (success)    { p.success++; p.latencies.push(latencyMs); if (p.latencies.length > 50) p.latencies.shift(); }
      if (!success)   p.fail++;
      if (disconnect) p.disconnects++;
      if (retry)      p.retries++;
      _recompute(p);
    }

    function _recompute(p) {
      const total = p.success + p.fail;
      const successRate = total ? p.success / total : 0.5;
      const avgLatency  = p.latencies.length ? p.latencies.reduce((a,b)=>a+b,0)/p.latencies.length : 500;
      const latencyScore = Math.max(0, 1 - avgLatency / 5000);
      p.score = successRate * 0.6 + latencyScore * 0.3 + (1 - Math.min(p.disconnects/10,1)) * 0.1;
    }

    function getScore(peerId) { return _peers.get(peerId)?.score ?? 0.5; }

    function rankPeers(peerIds) {
      return [...peerIds].sort((a, b) => getScore(b) - getScore(a));
    }

    function stats(peerId) { return _peers.get(peerId) || null; }
    function allStats() { return [..._peers.values()]; }

    return { record, getScore, rankPeers, stats, allStats };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. DistributedCheckpointing
  // ─────────────────────────────────────────────────────────────
  const DistributedCheckpointing = (() => {
    async function saveTask(task) {
      await CheckpointStore.put('tasks', { id: task.id, ...task, ts: Date.now() });
    }

    async function saveChunk(chunk) {
      await CheckpointStore.put('chunks', { id: chunk.id, ...chunk, ts: Date.now() });
    }

    async function claimChunk(chunkId, workerId) {
      await CheckpointStore.put('owners', { id: chunkId, workerId, claimedAt: Date.now() });
    }

    async function releaseChunk(chunkId) {
      await CheckpointStore.del('owners', chunkId);
    }

    async function getOwner(chunkId) {
      const owners = await CheckpointStore.getAll('owners');
      return owners.find(o => o.id === chunkId) || null;
    }

    async function getPendingChunks(taskId) {
      const chunks = await CheckpointStore.getAll('chunks');
      return chunks.filter(c => c.taskId === taskId && c.status !== 'done');
    }

    async function markChunkDone(chunkId) {
      const chunks = await CheckpointStore.getAll('chunks');
      const chunk = chunks.find(c => c.id === chunkId);
      if (chunk) { chunk.status = 'done'; await CheckpointStore.put('chunks', chunk); }
    }

    return { saveTask, saveChunk, claimChunk, releaseChunk, getOwner, getPendingChunks, markChunkDone };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. DistributedChunkScheduler
  // ─────────────────────────────────────────────────────────────
  const DistributedChunkScheduler = (() => {
    async function schedule(taskId, chunks, workers) {
      const ranked = PeerReliabilityScoring.rankPeers(workers.map(w => w.id));
      const assignments = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk  = chunks[i];
        const worker = workers.find(w => w.id === ranked[i % ranked.length]) || workers[0];
        const assignment = { chunkId: chunk.id, taskId, workerId: worker?.id || 'local', chunk };
        assignments.push(assignment);
        await DistributedCheckpointing.saveChunk({ id: chunk.id, taskId, status: 'pending', workerId: worker?.id || 'local' });
        await DistributedCheckpointing.claimChunk(chunk.id, worker?.id || 'local');
      }

      return assignments;
    }

    async function reassign(chunkId, taskId, workers) {
      await DistributedCheckpointing.releaseChunk(chunkId);
      const available = workers.filter(w => w.available);
      if (!available.length) return null;
      const best = PeerReliabilityScoring.rankPeers(available.map(w => w.id))[0];
      await DistributedCheckpointing.claimChunk(chunkId, best);
      return best;
    }

    return { schedule, reassign };
  })();

  // ─────────────────────────────────────────────────────────────
  // 1. ClusterCoordinator — local + multi-tab + P2P (opt-in)
  // ─────────────────────────────────────────────────────────────
  const ClusterCoordinator = (() => {
    let _p2pEnabled = false; // DISABLED BY DEFAULT — opt-in only

    function enableP2P() {
      if (!window.P2PComputeMesh) { warn('P2PComputeMesh not available'); return false; }
      _p2pEnabled = true;
      log('P2P compute enabled (opt-in)');
      return true;
    }

    function disableP2P() { _p2pEnabled = false; log('P2P compute disabled'); }

    function getAvailableWorkers() {
      const workers = [];

      // Local WorkerPool
      if (window.WorkerPool?.workers) {
        const wp = window.WorkerPool.workers();
        workers.push(...(Array.isArray(wp) ? wp : []).map(w => ({ id: `local_${w.id||Math.random()}`, type:'local', worker:w, available:true })));
      }
      if (!workers.length) workers.push({ id: 'local_main', type: 'local', available: true });

      // Multi-tab cluster
      if (window.MultiTabCluster?.getWorkers) {
        const tabs = window.MultiTabCluster.getWorkers() || [];
        workers.push(...tabs.map(t => ({ id: `tab_${t.tabId||Math.random()}`, type:'tab', tab:t, available:true })));
      }

      // P2P (only if explicitly enabled)
      if (_p2pEnabled && window.P2PComputeMesh?.getPeers) {
        const peers = window.P2PComputeMesh.getPeers() || [];
        workers.push(...peers.map(p => ({ id: `p2p_${p.peerId}`, type:'p2p', peer:p, available:p.connected })));
      }

      return workers;
    }

    async function dispatch(worker, chunk, taskType) {
      const start = Date.now();
      try {
        let result;
        if (worker.type === 'local' || !worker.type) {
          result = await _localExecute(chunk, taskType);
        } else if (worker.type === 'tab' && window.MultiTabCluster?.send) {
          result = await window.MultiTabCluster.send(worker.tab, { chunk, taskType });
        } else if (worker.type === 'p2p' && _p2pEnabled && window.P2PComputeMesh?.send) {
          result = await window.P2PComputeMesh.send(worker.peer, { chunk, taskType });
        } else {
          result = await _localExecute(chunk, taskType);
        }
        PeerReliabilityScoring.record(worker.id, { success: true, latencyMs: Date.now()-start });
        await DistributedCheckpointing.markChunkDone(chunk.id);
        return result;
      } catch (e) {
        PeerReliabilityScoring.record(worker.id, { success: false, latencyMs: Date.now()-start });
        throw e;
      }
    }

    async function _localExecute(chunk, taskType) {
      // Delegates to existing systems
      switch (taskType) {
        case 'ocr':
          return window.BrowserTools?.process?.('ocr-pdf', [chunk.data], {}) || { text: '' };
        case 'translate':
          return window.RealAiTranslationModels?.translate?.(chunk.data, chunk.srcLang, chunk.tgtLang) || chunk.data;
        case 'ai':
          return window.OnnxRuntimeManager?.run?.(chunk) || {};
        default:
          return { processed: true, chunkId: chunk.id };
      }
    }

    return { enableP2P, disableP2P, getAvailableWorkers, dispatch };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. BackgroundTaskEngine
  // ─────────────────────────────────────────────────────────────
  const BackgroundTaskEngine = (() => {
    const _queue   = [];   // { task, resolve, reject, priority }
    const _running = new Set();
    let _maxConcurrent = 2;
    let _idle = false;

    function enqueue(task, priority = 5) {
      return new Promise((resolve, reject) => {
        _queue.push({ task, resolve, reject, priority });
        _queue.sort((a,b) => a.priority - b.priority); // lower = higher priority
        _pump();
      });
    }

    function _pump() {
      if (_running.size >= _maxConcurrent) return;
      const next = _queue.shift();
      if (!next) return;
      _running.add(next);

      const run = async () => {
        try {
          const result = await _execute(next.task);
          next.resolve(result);
        } catch (e) {
          next.reject(e);
        } finally {
          _running.delete(next);
          await new Promise(r => setTimeout(r, 0));
          _pump();
        }
      };

      run();
    }

    async function _execute(task) {
      const workers = ClusterCoordinator.getAvailableWorkers();
      const chunkSize = task.chunkSize || 1;
      const chunks = Array.isArray(task.data)
        ? task.data
        : [{ id: `${task.id}_0`, data: task.data, taskId: task.id }];

      const assignments = await DistributedChunkScheduler.schedule(task.id, chunks, workers);
      const results = await Promise.all(
        assignments.map(a => _dispatchWithRetry(a, task.type, workers))
      );
      return { taskId: task.id, results };
    }

    async function _dispatchWithRetry(assignment, taskType, workers) {
      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          const worker = workers.find(w => w.id === assignment.workerId) || workers[0];
          return await ClusterCoordinator.dispatch(worker, assignment.chunk, taskType);
        } catch (e) {
          retries++;
          if (retries >= MAX_RETRIES) throw e;
          const newWorker = await DistributedChunkScheduler.reassign(assignment.chunkId, assignment.taskId, workers);
          if (newWorker) assignment.workerId = newWorker;
          await new Promise(r => setTimeout(r, 200 * retries));
        }
      }
    }

    // Idle-time processing using requestIdleCallback when available
    function startIdleProcessor() {
      const idle = window.requestIdleCallback || (cb => setTimeout(cb, 100));
      const loop = (deadline) => {
        while ((deadline.timeRemaining?.() > 5 || deadline.didTimeout) && _queue.length && _running.size < _maxConcurrent) {
          _pump();
        }
        idle(loop);
      };
      idle(loop);
      log('idle processor started');
    }

    function setConcurrency(n) { _maxConcurrent = Math.max(1, n); }

    return { enqueue, startIdleProcessor, setConcurrency, queueLength: () => _queue.length };
  })();

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const DistributedAiOrchestrator = {
    version: '43.1.0',
    ClusterCoordinator,
    DistributedChunkScheduler,
    PeerReliabilityScoring,
    DistributedCheckpointing,
    BackgroundTaskEngine,

    enableP2P()  { return ClusterCoordinator.enableP2P(); },
    disableP2P() { ClusterCoordinator.disableP2P(); },

    async submit(taskId, type, data, options = {}) {
      const task = { id: taskId || `task_${Date.now()}`, type, data, ...options };
      return BackgroundTaskEngine.enqueue(task, options.priority || 5);
    },

    workers() { return ClusterCoordinator.getAvailableWorkers(); },

    peerStats() { return PeerReliabilityScoring.allStats(); },

    status() {
      return {
        workers: ClusterCoordinator.getAvailableWorkers().length,
        queuedTasks: BackgroundTaskEngine.queueLength(),
        p2pEnabled: false, // always false until explicitly enabled
        workerPoolAvailable: !!(window.WorkerPool),
        multiTabAvailable:   !!(window.MultiTabCluster),
        p2pAvailable:        !!(window.P2PComputeMesh),
      };
    },
  };

  BackgroundTaskEngine.startIdleProcessor();

  window.DistributedAiOrchestrator = DistributedAiOrchestrator;
  log('Phase 43 ready — P2P disabled by default (opt-in via enableP2P())');
})();
