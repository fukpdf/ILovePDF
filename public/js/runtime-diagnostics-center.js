// RuntimeDiagnosticsCenter v1.0 — Phase 27A-D
// Enterprise runtime diagnostics center.
// EXTENDS window.RuntimeDiagnostics (Phase 2) — does NOT replace it.
//
// New capabilities added (no existing code removed):
//   Phase 27A — Full snapshot with Phase 23-26+ subsystems
//   Phase 27B — Live admin panel injected into any container element
//   Phase 27C — Export as runtime-report.json / runtime-report.txt
//   Phase 27D — IDB-persisted event timeline (crashes, updates, AI spikes, etc.)
//
// Integrates (reads, never writes):
//   RuntimePerf, RuntimeRecovery, RuntimeUpdater, RuntimeAIScheduler,
//   RuntimeOffline, RuntimeCredits, RuntimeSavings, RuntimeGovernor,
//   RuntimeHealth, RuntimeWorkers, RuntimeDiagnostics, WebGpuAiPipelines
//
// Exposed as: window.RuntimeDiagnosticsCenter

(function (G) {
  'use strict';

  if (G.RuntimeDiagnosticsCenter) return;

  var VERSION = '1.0';
  var LOG     = '[RDC27]';

  var IDB_DB      = 'iplv-diagnostics';
  var IDB_VER     = 1;
  var IDB_STORE   = 'timeline';
  var MAX_TIMELINE = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _log(m) { console.debug(LOG, m); }

  // ── IDB Timeline ───────────────────────────────────────────────────────────
  var _db = null;
  var _timelineCache = [];   // in-memory mirror (last MAX_TIMELINE events)

  function _openIDB() {
    return new Promise(function (resolve) {
      if (!('indexedDB' in window)) { resolve(null); return; }
      var req = indexedDB.open(IDB_DB, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var s = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts',   'ts',   { unique: false });
          s.createIndex('type', 'type', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function () { resolve(null); };
    });
  }

  function addTimelineEvent(type, detail) {
    var entry = { ts: Date.now(), type: type, detail: detail || null };
    _timelineCache.unshift(entry);
    if (_timelineCache.length > MAX_TIMELINE) _timelineCache.length = MAX_TIMELINE;
    if (!_db) return;
    try {
      var tx = _db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      store.add(entry);
      // Prune old entries
      store.count().onsuccess = function (e) {
        var n = e.target.result;
        if (n > MAX_TIMELINE) {
          store.index('ts').openCursor().onsuccess = function (ce) {
            var cursor = ce.target.result;
            if (cursor && n-- > MAX_TIMELINE) { cursor.delete(); cursor.continue(); }
          };
        }
      };
    } catch (_) {}
  }

  function getTimeline() {
    return _timelineCache.slice();
  }

  // ── Section getters ────────────────────────────────────────────────────────

  function getVitals() {
    return {
      source:   'RuntimePerf',
      vitals:   _s(function () { return G.RuntimePerf && G.RuntimePerf.getVitals(); }),
      ratings:  _s(function () { return G.RuntimePerf && G.RuntimePerf.getRatings(); }),
      fps:      _s(function () { return G.RuntimePerf && G.RuntimePerf.getFPS(); }),
      heap:     _s(function () { return G.RuntimePerf && G.RuntimePerf.getHeap(); }),
      longTasks:_s(function () { return G.RuntimePerf && G.RuntimePerf.getLongTasks(); }, []).length,
      workerLatencyMs: _s(function () { return G.RuntimePerf && G.RuntimePerf.getWorkerLatency(); }),
    };
  }

  function getGPU() {
    return {
      webGPUAvailable:  !!(navigator.gpu),
      tier:             _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getDeviceProfile().gpuTier; }, 'unknown'),
      score:            _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getDeviceProfile().score; }),
      thermal:          _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getDeviceProfile().thermal; }, 'unknown'),
      webGpuPipelines:  !!G.WebGpuAiPipelines,
      gpuEngine:        !!G.RuntimeGpuEngine,
      quality:          _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getQuality(); }),
    };
  }

  function getWorkers() {
    return {
      runtimeWorkers:   _s(function () { return G.RuntimeWorkers && G.RuntimeWorkers.getStats(); }),
      workerPool:       _s(function () { return G.WorkerPool && G.WorkerPool.getStats(); }),
      orchestrator:     _s(function () { return G.RuntimeWorkerOrchestrator && G.RuntimeWorkerOrchestrator.getStats && G.RuntimeWorkerOrchestrator.getStats(); }),
      deadlock:         _s(function () { return G.DeadlockMonitor && G.DeadlockMonitor.getStats && G.DeadlockMonitor.getStats(); }),
    };
  }

  function getCaches() {
    // Async SW cache stats
    var swPromise = new Promise(function (resolve) {
      try {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { resolve(null); return; }
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) { resolve(e.data); };
        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STATS' }, [ch.port2]);
        setTimeout(function () { resolve(null); }, 2000);
      } catch (_) { resolve(null); }
    });
    return {
      swCachePromise: swPromise,
      opfs:           !!(G.OPFSManager && G.OPFSManager.available && G.OPFSManager.available()),
    };
  }

  function getMemory() {
    return {
      heap:        _s(function () { return G.RuntimePerf && G.RuntimePerf.getHeap(); }),
      tier:        _s(function () { return G.RuntimeMemory && G.RuntimeMemory.getTier(); }, 'NORMAL'),
      memPressure: _s(function () { return G.MemPressure && G.MemPressure.stats && G.MemPressure.stats(); }),
      adaptive:    _s(function () { return G.AdaptiveDegradation && G.AdaptiveDegradation.getStats && G.AdaptiveDegradation.getStats(); }),
      deviceMemGB: navigator.deviceMemory || null,
    };
  }

  function getScheduler() {
    return {
      runtime:    _s(function () { return G.RuntimeScheduler && G.RuntimeScheduler.getStats(); }),
      aiScheduler:_s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getQueueStats(); }),
      aiTelemetry:_s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getTelemetry(); }),
      taskScheduler: _s(function () { return G.TaskScheduler && G.TaskScheduler.stats && G.TaskScheduler.stats(); }),
      kernel:     _s(function () { return G.RuntimeKernel && G.RuntimeKernel.getLoad && G.RuntimeKernel.getLoad(); }),
    };
  }

  function getRecovery() {
    return {
      recovery:   _s(function () { return G.RuntimeRecovery && G.RuntimeRecovery.getStats(); }),
      recentLog:  _s(function () { return G.RuntimeRecovery && G.RuntimeRecovery.getLog && G.RuntimeRecovery.getLog().slice(0, 10); }, []),
      selfHealing:_s(function () { return G.SelfHealingRecovery && G.SelfHealingRecovery.getStats && G.SelfHealingRecovery.getStats(); }),
      hardening:  _s(function () { return G.RuntimeHardening && G.RuntimeHardening.getStatus && G.RuntimeHardening.getStatus(); }),
    };
  }

  function getOffline() {
    return {
      status:     _s(function () { return G.RuntimeOffline && G.RuntimeOffline.status(); }),
      queueSize:  _s(function () { return G.RuntimeOffline && G.RuntimeOffline.queueSize(); }, 0),
      swVersion:  _s(function () { return G.RuntimeUpdater && G.RuntimeUpdater.getVersion(); }, 'unknown'),
      updaterState: _s(function () { return G.RuntimeUpdater && G.RuntimeUpdater.getState(); }, 'idle'),
    };
  }

  function getEconomy() {
    return {
      credits:  _s(function () { return G.RuntimeCredits && G.RuntimeCredits.getCredits(); }),
      savings:  _s(function () { return G.RuntimeSavings && { today: G.RuntimeSavings.getToday(), lifetime: G.RuntimeSavings.getLifetime() }; }),
      identity: _s(function () { return G.RuntimeIdentity && G.RuntimeIdentity.get && G.RuntimeIdentity.get(); }),
    };
  }

  function getErrors() {
    var tel = _s(function () {
      return G.RuntimeTelemetry && G.RuntimeTelemetry.getRecentEvents && G.RuntimeTelemetry.getRecentEvents(50);
    }, []);
    var errorEvents = tel.filter(function (e) { return e && e.name && (e.name.indexOf('error') !== -1 || e.name.indexOf('crash') !== -1 || e.name.indexOf('fail') !== -1); });
    return {
      recentErrors: errorEvents.slice(0, 20),
      errorCount:   _s(function () { return G.RuntimeRecovery && G.RuntimeRecovery.getStats().errorCount; }, 0),
      securityStats:_s(function () { return G.RuntimeSecurity && G.RuntimeSecurity.getStats(); }),
    };
  }

  // ── Full snapshot ─────────────────────────────────────────────────────────
  function snapshot() {
    var snap = {
      ts:         Date.now(),
      version:    VERSION,
      userAgent:  navigator.userAgent.slice(0, 120),
      url:        location.href.slice(0, 200),
      vitals:     getVitals(),
      gpu:        getGPU(),
      workers:    getWorkers(),
      memory:     getMemory(),
      scheduler:  getScheduler(),
      recovery:   getRecovery(),
      offline:    getOffline(),
      economy:    getEconomy(),
      errors:     getErrors(),
      timeline:   getTimeline().slice(0, 30),
      // Legacy RuntimeDiagnostics snapshot (existing system)
      legacy:     _s(function () { return G.RuntimeDiagnostics && G.RuntimeDiagnostics.snapshot(); }),
    };
    return snap;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function exportJSON() {
    var data = snapshot();
    // Remove un-serializable promise
    if (data.caches) data.caches.swCachePromise = '(async — use getCaches().swCachePromise)';
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    _download(blob, 'runtime-report-' + _tsStr() + '.json');
  }

  function exportTXT() {
    var snap = snapshot();
    var lines = [
      '=== ILovePDF Runtime Report ===',
      'Generated: ' + new Date(snap.ts).toISOString(),
      'URL: ' + snap.url,
      'UA: ' + snap.userAgent,
      '',
      '-- VITALS --',
      'LCP: ' + _f(snap.vitals.vitals && snap.vitals.vitals.lcp) + 'ms',
      'FCP: ' + _f(snap.vitals.vitals && snap.vitals.vitals.fcp) + 'ms',
      'CLS: ' + _f(snap.vitals.vitals && snap.vitals.vitals.cls, 3),
      'INP: ' + _f(snap.vitals.vitals && snap.vitals.vitals.inp) + 'ms',
      'FPS: ' + (snap.vitals.fps || 'n/a'),
      'Heap: ' + (snap.vitals.heap ? snap.vitals.heap.used + '/' + snap.vitals.heap.total + ' MB' : 'n/a'),
      '',
      '-- GPU --',
      'Tier: ' + snap.gpu.tier,
      'Score: ' + snap.gpu.score,
      'Thermal: ' + snap.gpu.thermal,
      'WebGPU: ' + snap.gpu.webGPUAvailable,
      '',
      '-- MEMORY --',
      'Tier: ' + snap.memory.tier,
      'Device RAM: ' + (snap.memory.deviceMemGB || '?') + ' GB',
      '',
      '-- SCHEDULER --',
      'AI Queue: ' + JSON.stringify(_s(function () { return snap.scheduler.aiScheduler && snap.scheduler.aiScheduler.depths; })),
      'AI GPU ratio: ' + _f(_s(function () { return snap.scheduler.aiTelemetry && (snap.scheduler.aiTelemetry.gpuRatio * 100); })) + '%',
      '',
      '-- RECOVERY --',
      'Error count: ' + snap.errors.errorCount,
      'Watchdog: ' + (snap.recovery.recovery && snap.recovery.recovery.watchdog ? 'active' : 'off'),
      '',
      '-- OFFLINE --',
      'SW version: ' + snap.offline.swVersion,
      'Queue size: ' + snap.offline.queueSize,
      '',
      '-- ECONOMY --',
      'Credits remaining: ' + _s(function () { return snap.economy.credits && snap.economy.credits.remaining; }, '?'),
      'Savings today: ' + _s(function () { return snap.economy.savings && snap.economy.savings.today && snap.economy.savings.today.total; }, '?'),
      '',
      '-- TIMELINE (last 20 events) --',
    ];
    snap.timeline.slice(0, 20).forEach(function (e) {
      lines.push('[' + new Date(e.ts).toISOString().slice(11, 23) + '] ' + e.type + (e.detail ? ' ' + JSON.stringify(e.detail).slice(0, 80) : ''));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    _download(blob, 'runtime-report-' + _tsStr() + '.txt');
  }

  function _f(v, d) {
    if (v === null || v === undefined) return 'n/a';
    return d ? Number(v).toFixed(d) : v;
  }

  function _tsStr() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  function _download(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a   = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
    } catch (_) {}
  }

  // ── Live Admin Panel ────────────────────────────────────────────────────────
  var _panelTimer = null;

  function mountPanel(containerEl) {
    if (!containerEl) return;
    _injectPanelCSS();
    containerEl.innerHTML = _buildPanelHTML();
    _updatePanel(containerEl);
    clearInterval(_panelTimer);
    _panelTimer = setInterval(function () { _updatePanel(containerEl); }, 2000);

    // Wire export buttons
    var btnJSON = containerEl.querySelector('#rdc-export-json');
    if (btnJSON) btnJSON.addEventListener('click', function () { exportJSON(); });
    var btnTXT = containerEl.querySelector('#rdc-export-txt');
    if (btnTXT) btnTXT.addEventListener('click', function () { exportTXT(); });
  }

  function _injectPanelCSS() {
    if (document.getElementById('rdc-css')) return;
    var s = document.createElement('style');
    s.id = 'rdc-css';
    s.textContent = [
      '.rdc{font-family:ui-monospace,"Cascadia Code","Fira Code",monospace;font-size:12px;color:#e6edf3;background:#0d1117;height:100%;overflow-y:auto;padding:16px;}',
      '.rdc-hdr{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #21262d;}',
      '.rdc-hdr h2{margin:0;font-size:15px;font-weight:700;color:#7c3aed;flex:1;}',
      '.rdc-btn{padding:6px 14px;border-radius:6px;border:none;font-size:11px;font-weight:600;cursor:pointer;background:#21262d;color:#c9d1d9;}',
      '.rdc-btn:hover{background:#30363d;}',
      '.rdc-btn.primary{background:#7c3aed;color:#fff;}',
      '.rdc-btn.primary:hover{background:#6d28d9;}',
      '.rdc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-bottom:16px;}',
      '.rdc-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px 14px;}',
      '.rdc-card h3{font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;}',
      '.rdc-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);}',
      '.rdc-row:last-child{border-bottom:none;}',
      '.rdc-lbl{color:#8b949e;font-size:11px;}',
      '.rdc-val{font-size:11px;font-weight:600;color:#e6edf3;}',
      '.rdc-good{color:#10b981!important;}.rdc-warn{color:#f59e0b!important;}.rdc-bad{color:#ef4444!important;}',
      '.rdc-tl{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px 14px;}',
      '.rdc-tl h3{font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;}',
      '.rdc-tl-list{max-height:180px;overflow-y:auto;font-size:11px;}',
      '.rdc-tl-list::-webkit-scrollbar{width:4px;}.rdc-tl-list::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;}',
      '.rdc-ev{padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:8px;align-items:flex-start;}',
      '.rdc-ev-ts{color:#6e7681;flex-shrink:0;}.rdc-ev-type{color:#7c3aed;flex-shrink:0;font-weight:600;}',
      '.rdc-ev-detail{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    ].join('');
    document.head.appendChild(s);
  }

  function _buildPanelHTML() {
    return [
      '<div class="rdc">',
        '<div class="rdc-hdr">',
          '<h2>Runtime Diagnostics Center v' + VERSION + '</h2>',
          '<button class="rdc-btn" id="rdc-export-txt">Export TXT</button>',
          '<button class="rdc-btn primary" id="rdc-export-json">Export JSON</button>',
        '</div>',
        '<div class="rdc-grid" id="rdc-grid">',
          '<div class="rdc-card" id="rdc-vitals"><h3>Web Vitals</h3></div>',
          '<div class="rdc-card" id="rdc-gpu"><h3>GPU &amp; AI</h3></div>',
          '<div class="rdc-card" id="rdc-workers"><h3>Workers</h3></div>',
          '<div class="rdc-card" id="rdc-memory"><h3>Memory</h3></div>',
          '<div class="rdc-card" id="rdc-sched"><h3>Scheduler</h3></div>',
          '<div class="rdc-card" id="rdc-recovery"><h3>Recovery</h3></div>',
          '<div class="rdc-card" id="rdc-offline"><h3>Offline &amp; SW</h3></div>',
          '<div class="rdc-card" id="rdc-economy"><h3>Economy</h3></div>',
        '</div>',
        '<div class="rdc-tl"><h3>Timeline</h3><div class="rdc-tl-list" id="rdc-tl"></div></div>',
      '</div>',
    ].join('');
  }

  function _row(label, value, cls) {
    return '<div class="rdc-row"><span class="rdc-lbl">' + label + '</span><span class="rdc-val' + (cls ? ' ' + cls : '') + '">' + (value !== null && value !== undefined ? value : 'n/a') + '</span></div>';
  }

  function _ratingClass(rating) {
    if (rating === 'good') return 'rdc-good';
    if (rating === 'needs-improvement') return 'rdc-warn';
    if (rating === 'poor') return 'rdc-bad';
    return '';
  }

  function _updatePanel(el) {
    var vt = getVitals();
    var vEl = el.querySelector('#rdc-vitals');
    if (vEl) {
      var v = vt.vitals || {};
      var r = vt.ratings || {};
      vEl.innerHTML = '<h3>Web Vitals</h3>' +
        _row('LCP', (v.lcp || 'n/a') + 'ms', _ratingClass(r.lcp)) +
        _row('FCP', (v.fcp || 'n/a') + 'ms', _ratingClass(r.fcp)) +
        _row('CLS', v.cls !== undefined ? Number(v.cls).toFixed(3) : 'n/a', _ratingClass(r.cls)) +
        _row('INP', (v.inp || 'n/a') + 'ms', _ratingClass(r.inp)) +
        _row('FPS', vt.fps || 'n/a', (vt.fps >= 50) ? 'rdc-good' : (vt.fps >= 30) ? 'rdc-warn' : 'rdc-bad') +
        _row('Heap', vt.heap ? vt.heap.used + '/' + vt.heap.total + ' MB (' + vt.heap.pct + '%)' : 'n/a',
          vt.heap ? (vt.heap.pct < 70 ? 'rdc-good' : vt.heap.pct < 90 ? 'rdc-warn' : 'rdc-bad') : '') +
        _row('Long Tasks', vt.longTasks);
    }

    var gpuD = getGPU();
    var gEl = el.querySelector('#rdc-gpu');
    if (gEl) {
      var qt = _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getTelemetry(); }) || {};
      gEl.innerHTML = '<h3>GPU &amp; AI</h3>' +
        _row('GPU Tier', gpuD.tier, gpuD.tier === 'webgpu' ? 'rdc-good' : gpuD.tier === 'webgl' ? 'rdc-warn' : '') +
        _row('Score', gpuD.score) +
        _row('Thermal', gpuD.thermal, gpuD.thermal === 'hot' ? 'rdc-bad' : gpuD.thermal === 'warm' ? 'rdc-warn' : 'rdc-good') +
        _row('GPU ratio', qt.gpuRatio !== undefined ? Math.round(qt.gpuRatio * 100) + '%' : 'n/a') +
        _row('Avg inference', qt.avgInferenceMs !== undefined ? qt.avgInferenceMs + 'ms' : 'n/a') +
        _row('AI tasks total', qt.total !== undefined ? qt.total : 'n/a') +
        _row('Failure rate', qt.failureRate !== undefined ? (qt.failureRate * 100).toFixed(1) + '%' : 'n/a',
          qt.failureRate > 0.1 ? 'rdc-bad' : 'rdc-good');
    }

    var wkD = getWorkers();
    var wEl = el.querySelector('#rdc-workers');
    if (wEl) {
      var rw = wkD.runtimeWorkers || {};
      wEl.innerHTML = '<h3>Workers</h3>' +
        _row('In-flight', rw.inflight) +
        _row('Cooldowns', rw.cooldowns, rw.cooldowns > 0 ? 'rdc-warn' : 'rdc-good') +
        _row('AI scheduler', _s(function () { var q = G.RuntimeAIScheduler.getQueueStats(); return q.running + ' running / ' + q.maxConcurrent + ' max'; })) +
        _row('Hardening', _s(function () { return G.RuntimeHardening && G.RuntimeHardening.getStatus && G.RuntimeHardening.getStatus().escalationLevel; }, 0));
    }

    var memD = getMemory();
    var mEl = el.querySelector('#rdc-memory');
    if (mEl) {
      var mp = memD.memPressure || {};
      mEl.innerHTML = '<h3>Memory</h3>' +
        _row('Tier', memD.tier, memD.tier === 'NORMAL' ? 'rdc-good' : memD.tier === 'LOW' ? 'rdc-warn' : 'rdc-bad') +
        _row('Device RAM', (memD.deviceMemGB || '?') + ' GB') +
        _row('Used', mp.usedMB ? mp.usedMB + '/' + mp.limitMB + ' MB (' + mp.pct + '%)' : 'n/a') +
        _row('Adaptive tier', memD.adaptive && memD.adaptive.tier);
    }

    var schedD = getScheduler();
    var scEl = el.querySelector('#rdc-sched');
    if (scEl) {
      var kl = schedD.kernel || {};
      var ai = schedD.aiScheduler || {};
      scEl.innerHTML = '<h3>Scheduler</h3>' +
        _row('AI running', ai.running) +
        _row('AI high queue', ai.depths && ai.depths.high) +
        _row('AI normal queue', ai.depths && ai.depths.normal) +
        _row('AI bg queue', ai.depths && ai.depths.background) +
        _row('Kernel workers', kl.workers) +
        _row('Kernel AI tasks', kl.ai);
    }

    var recD = getRecovery();
    var rcEl = el.querySelector('#rdc-recovery');
    if (rcEl) {
      var rr = recD.recovery || {};
      rcEl.innerHTML = '<h3>Recovery</h3>' +
        _row('Error count', rr.errorCount, rr.errorCount > 3 ? 'rdc-bad' : rr.errorCount > 0 ? 'rdc-warn' : 'rdc-good') +
        _row('Watchdog', rr.watchdog ? 'active' : 'off', rr.watchdog ? 'rdc-good' : 'rdc-warn') +
        _row('Recovering', rr.recovering ? 'yes' : 'no', rr.recovering ? 'rdc-warn' : 'rdc-good') +
        _row('Log entries', rr.logLength) +
        _row('SelfHealing', recD.selfHealing ? 'loaded' : 'n/a');
    }

    var offD = getOffline();
    var ofEl = el.querySelector('#rdc-offline');
    if (ofEl) {
      var os = offD.status || {};
      ofEl.innerHTML = '<h3>Offline &amp; SW</h3>' +
        _row('Online', os.online ? 'yes' : 'offline', os.online ? 'rdc-good' : 'rdc-bad') +
        _row('SW version', offD.swVersion) +
        _row('Updater', offD.updaterState, offD.updaterState === 'update-available' ? 'rdc-warn' : 'rdc-good') +
        _row('Queue size', offD.queueSize, offD.queueSize > 0 ? 'rdc-warn' : 'rdc-good') +
        _row('PWA installed', os.pwaInstalled ? 'yes' : 'no');
    }

    var ecoD = getEconomy();
    var ecEl = el.querySelector('#rdc-economy');
    if (ecEl) {
      var cr = ecoD.credits || {};
      var sv = ecoD.savings || {};
      ecEl.innerHTML = '<h3>Economy</h3>' +
        _row('Credits', cr.remaining + ' / ' + cr.dailyLimit) +
        _row('Used today', cr.used) +
        _row('Savings today', sv.today && sv.today.total ? sv.today.currency + sv.today.total : 'n/a') +
        _row('Lifetime savings', sv.lifetime && sv.lifetime.total ? sv.lifetime.currency + sv.lifetime.total : 'n/a');
    }

    var tl = getTimeline();
    var tlEl = el.querySelector('#rdc-tl');
    if (tlEl) {
      if (!tl.length) { tlEl.innerHTML = '<div style="color:#6e7681;padding:4px 0;">No events yet</div>'; }
      else {
        tlEl.innerHTML = tl.slice(0, 40).map(function (e) {
          return '<div class="rdc-ev">' +
            '<span class="rdc-ev-ts">' + new Date(e.ts).toISOString().slice(11, 23) + '</span>' +
            '<span class="rdc-ev-type">' + e.type + '</span>' +
            '<span class="rdc-ev-detail">' + (e.detail ? JSON.stringify(e.detail).slice(0, 60) : '') + '</span>' +
            '</div>';
        }).join('');
      }
    }
  }

  // ── Auto-populate timeline from events ────────────────────────────────────
  function _hookEvents() {
    // RuntimeRecovery recovery events
    _s(function () {
      if (G.RuntimeRecovery && G.RuntimeRecovery.getLog) {
        // snapshot existing log
        G.RuntimeRecovery.getLog().forEach(function (e) {
          addTimelineEvent(e.type, e.detail);
        });
      }
    });

    // RuntimeEventBus subscription
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb || !eb.on) return;
      var types = ['recovery:*', 'memory:tier-change', 'worker:zombie', 'ai-scheduler.*'];
      // EventBus may not support wildcards — subscribe to known event names
      var evNames = ['recovery:recover-all-done', 'recovery:unhandled-error', 'memory:tier-change', 'worker:zombie'];
      evNames.forEach(function (name) {
        eb.on(name, function (data) { addTimelineEvent(name.replace(':', '.'), data); });
      });
    });

    // SW update
    _s(function () {
      var ru = G.RuntimeUpdater;
      if (ru && ru.subscribe) {
        ru.subscribe(function (state, version) {
          addTimelineEvent('sw-update', { state: state, version: version });
        });
      }
    });

    // RuntimePerf: LCP ready
    _s(function () {
      var rp = G.RuntimePerf;
      if (rp && rp.subscribe) {
        rp.subscribe(function (vitals) {
          if (vitals.lcp && !_timelineCache.some(function (e) { return e.type === 'lcp-ready'; })) {
            addTimelineEvent('lcp-ready', { ms: vitals.lcp });
          }
        });
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  _openIDB().then(function (db) {
    _db = db;
    // Load existing timeline events from IDB into memory cache
    if (!db) return;
    try {
      var tx  = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).index('ts').openCursor(null, 'prev');
      var loaded = 0;
      req.onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor && loaded < MAX_TIMELINE) {
          _timelineCache.push(cursor.value);
          loaded++;
          cursor.continue();
        }
      };
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_hookEvents, 500); }, { once: true });
  } else {
    setTimeout(_hookEvents, 500);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeDiagnosticsCenter = {
    VERSION: VERSION,
    snapshot:         snapshot,
    exportJSON:       exportJSON,
    exportTXT:        exportTXT,
    getVitals:        getVitals,
    getGPU:           getGPU,
    getWorkers:       getWorkers,
    getCaches:        getCaches,
    getMemory:        getMemory,
    getScheduler:     getScheduler,
    getRecovery:      getRecovery,
    getOffline:       getOffline,
    getEconomy:       getEconomy,
    getErrors:        getErrors,
    mountPanel:       mountPanel,
    addTimelineEvent: addTimelineEvent,
    getTimeline:      getTimeline,
  };

  G.RuntimeDiagnosticsCenter = RuntimeDiagnosticsCenter;

  // Extend existing RuntimeDiagnostics with new methods (additive, no overwrite)
  if (G.RuntimeDiagnostics) {
    if (!G.RuntimeDiagnostics.enterprise) {
      G.RuntimeDiagnostics.enterprise = RuntimeDiagnosticsCenter;
    }
    if (!G.RuntimeDiagnostics.export) {
      G.RuntimeDiagnostics.export = exportJSON;
    }
  }

  _log('v' + VERSION + ' ready');

}(window));
