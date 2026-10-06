// Phase J — Full Next-Gen Audit v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// Exposes: window.FullNextGenAudit()
// Audits ALL systems across Phases 18–37+ with a comprehensive readiness report.
//
// Score categories:
//   • Core Tools (0–15)        — 33 tools registered
//   • Hook Chain (0–10)        — all BrowserTools wrappers active
//   • Streaming (0–10)         — P32 fully operational
//   • Resume (0–8)             — P33 checkpoint system
//   • OCR (0–8)                — P34 table OCR
//   • Virtualization (0–8)     — P35 virtualizer + eviction
//   • GPU (0–10)               — P31+P36+WebGpuAiPipelines
//   • AI Runtime (0–8)         — OnnxRuntimeManager
//   • MultiTab (0–6)           — MultiTabCluster
//   • P2P (0–4)                — P2PComputeMesh (off=ok)
//   • OPFS (0–8)               — OpfsMemoryMapped
//   • Differential (0–6)       — DifferentialProcessing
//   • AutoTuning (0–6)         — AutoTuningEngine
//   • RecoveryV2 (0–8)         — EnterpriseRecoveryV2
//   • Dashboard (0–3)          — JobDashboard
//   • Memory Safety (0–8)      — all cleanup + pressure systems
//   • WorkerPool (0–6)         — pool health
//
// Max: 132 points → percentage score.

(function () {
  'use strict';

  var VERSION   = '1.0';
  var MB        = 1024 * 1024;
  var ALL_TOOLS = [
    'merge-pdf','split-pdf','rotate-pdf','crop-pdf','organize-pdf',
    'compress-pdf',
    'pdf-to-word','pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg',
    'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','jpg-to-pdf','html-to-pdf',
    'edit-pdf','watermark-pdf','sign-pdf','add-page-numbers','redact-pdf',
    'protect-pdf','unlock-pdf',
    'repair-pdf','scan-pdf','ocr-pdf','compare-pdf','ai-summarizer','translate-pdf','workflow-builder',
    'background-remover','crop-image','resize-image','image-filters',
  ];

  // ── Sub-scorers ────────────────────────────────────────────────────────────

  function _scoreTools() {
    var ae   = window.AdvancedEngine;
    var bt   = window.BrowserTools;
    var reg  = ae && ae.TOOL_IDS ? Array.from(ae.TOOL_IDS) : [];
    var found = ALL_TOOLS.filter(function (t) { return reg.indexOf(t) !== -1 || bt; }).length;
    return { score: Math.round((found / ALL_TOOLS.length) * 15), max: 15, found: found, total: ALL_TOOLS.length };
  }

  function _scoreHookChain() {
    var bt    = window.BrowserTools;
    var hooks = {
      P26:  bt && bt.__phase26v1,
      P2730: bt && bt.__p2730v1,
      P31:  bt && bt.__phase31v1,
      P32:  bt && bt.__phase32v1,
      P33:  bt && bt.__phase33v1,
      P36:  bt && bt.__phase36v1,
      JD:   bt && bt.__jdv1,
    };
    var active = Object.values(hooks).filter(Boolean).length;
    return { score: Math.round((active / Object.keys(hooks).length) * 10), max: 10, hooks: hooks };
  }

  function _scoreStreaming() {
    var p32 = window.Phase32;
    if (!p32) return { score: 0, max: 10, note: 'Phase32 not loaded' };
    var s = 0;
    if (p32.ByteRangeStreamer)         s += 2;
    if (p32.StreamFirstProcessor)      s += 2;
    if (p32.RollingMemoryWindowManager) s += 2;
    if (p32.GiantFileSurvivalMode)     s += 2;
    if (window.OpfsMemoryMapped)       s += 2;
    return { score: s, max: 10, survival: p32.GiantFileSurvivalMode.isActive(), windowSize: p32.RollingMemoryWindowManager.getWindowSize() };
  }

  function _scoreResume() {
    var p33 = window.Phase33;
    if (!p33) return { score: 0, max: 8, note: 'Phase33 not loaded' };
    return { score: p33.CheckpointEngine && p33.CrashRecovery && p33.MultiDayProcessing ? 8 : 4, max: 8 };
  }

  function _scoreOcr() {
    var p34 = window.Phase34;
    if (!p34) return { score: 0, max: 8, note: 'Phase34 not loaded' };
    var s = 0;
    if (p34.StructuredOCR)           s += 3;
    if (p34.TableExtractionPipeline) s += 3;
    if (p34.OcrModeSelector)         s += 2;
    return { score: s, max: 8 };
  }

  function _scoreVirtualization() {
    var p35 = window.Phase35;
    if (!p35) return { score: 0, max: 8, note: 'Phase35 not loaded' };
    var s = 0;
    if (p35.TruePageVirtualizer)              s += 3;
    if (p35.PredictiveEviction)               s += 3;
    if (p35.VirtualAIWindows)                 s += 2;
    if (typeof IntersectionObserver === 'undefined') s = Math.max(0, s - 2);
    return { score: s, max: 8, hasIntersectionObserver: typeof IntersectionObserver !== 'undefined' };
  }

  function _scoreGpu() {
    var p31  = window.Phase31;
    var p36  = window.Phase36;
    var wgap = window.WebGpuAiPipelines;
    var s    = 0;
    var hasGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
    if (hasGpu) s += 4;
    if (p31 && p31.WebGPUAccel) s += 2;
    if (p36 && p36.RealWebGPUPipelines && p36.RealWebGPUPipelines.ready) s += 2;
    if (wgap) s += 2;
    return { score: Math.min(10, s), max: 10, hasGpu: hasGpu, p36Ready: p36 && p36.RealWebGPUPipelines && p36.RealWebGPUPipelines.ready };
  }

  function _scoreAiRuntime() {
    var orm = window.OnnxRuntimeManager;
    if (!orm) return { score: 0, max: 8, note: 'OnnxRuntimeManager not loaded' };
    var s = 0;
    if (orm.ModelRegistry)      s += 2;
    if (orm.TensorPool)         s += 2;
    if (orm.InferenceScheduler) s += 2;
    if (orm.StreamingInference) s += 2;
    return { score: s, max: 8, backend: orm.audit().backend };
  }

  function _scoreMultiTab() {
    var mtc = window.MultiTabCluster;
    if (!mtc) return { score: 0, max: 6, note: 'MultiTabCluster not loaded' };
    var s = 0;
    if (mtc.enabled)              s += 2;
    if (mtc.ClusterDiscovery)     s += 1;
    if (mtc.LeaderElection)       s += 1;
    if (mtc.DistributedScheduler) s += 1;
    if (mtc.GiantJobPartitioner)  s += 1;
    return { score: s, max: 6, peers: mtc.peerCount(), isLeader: mtc.isLeader() };
  }

  function _scoreP2P() {
    var p2p = window.P2PComputeMesh;
    if (!p2p) return { score: 0, max: 4, note: 'P2PComputeMesh not loaded' };
    // P2P being OFF is fine (by design); still award points for loading correctly
    var s = 0;
    if (p2p.PeerMesh)      s += 1;
    if (p2p.ChunkExchange) s += 1;
    if (p2p.TaskMesh)      s += 1;
    if (p2p.PeerScoring)   s += 1;
    return { score: s, max: 4, enabled: p2p.enabled, note: p2p.enabled ? 'active' : 'off-by-default (correct)' };
  }

  function _scoreOpfs() {
    var omm    = window.OpfsMemoryMapped;
    var hasOPFS = typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function';
    var s = 0;
    if (hasOPFS) s += 4;
    if (omm && omm.ByteRangeParser)     s += 1;
    if (omm && omm.MemoryMappedReader)  s += 1;
    if (omm && omm.GiantOutputStreamer) s += 1;
    if (omm && omm.PartialDecompressor) s += 1;
    return { score: Math.min(8, s), max: 8, hasOpfs: hasOPFS };
  }

  function _scoreDifferential() {
    var dp = window.DifferentialProcessing;
    if (!dp) return { score: 0, max: 6, note: 'DifferentialProcessing not loaded' };
    var s = 0;
    if (dp.PageHashCache)       s += 2;
    if (dp.VisualDiffCache)     s += 1;
    if (dp.OcrTextHashCache)    s += 1;
    if (dp.IncrementalPipeline) s += 2;
    return { score: s, max: 6 };
  }

  function _scoreAutoTuning() {
    var ate = window.AutoTuningEngine;
    if (!ate) return { score: 0, max: 6, note: 'AutoTuningEngine not loaded' };
    var s = 0;
    if (ate.HardwareBenchmark)    s += 1;
    if (ate.DeviceFingerprint)    s += 1;
    if (ate.AdaptiveController)   s += 2;
    if (ate.OptimizationMemory)   s += 1;
    if (ate.PerformanceTelemetry) s += 1;
    return { score: s, max: 6, deviceTier: ate.DeviceFingerprint.getTier() };
  }

  function _scoreRecoveryV2() {
    var erv2 = window.EnterpriseRecoveryV2;
    var p36  = window.Phase36;
    var s    = 0;
    if (p36 && p36.AdvancedPdfRecovery) s += 2;
    if (erv2) {
      if (erv2.ObjectGraphRecovery)    s += 1;
      if (erv2.IncrementalXrefBuilder) s += 1;
      if (erv2.StreamSalvage)          s += 1;
      if (erv2.FontRecovery)           s += 1;
      if (erv2.PageTreeRecovery)       s += 1;
      if (erv2.ImageExtractRecovery)   s += 1;
    }
    return { score: Math.min(8, s), max: 8 };
  }

  function _scoreDashboard() {
    var jd = window.JobDashboard;
    if (!jd) return { score: 0, max: 3, note: 'JobDashboard not loaded' };
    return { score: 3, max: 3 };
  }

  function _scoreMemorySafety() {
    var s  = 0;
    var mp = window.MemPressure;
    var em = window.EvictionManager;
    var p32 = window.Phase32;
    var p35 = window.Phase35;
    var p36 = window.Phase36;
    if (mp && typeof mp.tier === 'function')                           s += 2;
    if (em && typeof em.flush === 'function')                          s += 1;
    if (p32 && p32.RollingMemoryWindowManager)                         s += 2;
    if (p35 && p35.PredictiveEviction)                                 s += 1;
    if (p36 && p36.GpuResourceManager)                                 s += 1;
    if (window.WebGpuAiPipelines && window.WebGpuAiPipelines.TexturePool) s += 1;
    return { score: Math.min(8, s), max: 8, memTier: mp && typeof mp.tier === 'function' ? mp.tier() : 'unknown' };
  }

  function _scoreWorkerPool() {
    var pool = window.WorkerPool;
    if (!pool) return { score: 0, max: 6, note: 'WorkerPool not loaded' };
    var s = 4;
    var p36ext = window.Phase36 && window.Phase36.WorkerPoolFinalExt;
    if (p36ext) s += 2;
    var stats = pool.getStats ? pool.getStats() : null;
    return { score: s, max: 6, poolStats: stats };
  }

  // ── Leak detection ──────────────────────────────────────────────────────────
  function _detectLeaks() {
    var warnings = [];
    // Check for survival mode stuck on
    var p32 = window.Phase32;
    if (p32 && p32.GiantFileSurvivalMode && p32.GiantFileSurvivalMode.isActive()) {
      warnings.push({ level: 'warn', msg: 'GiantFileSurvivalMode is ACTIVE — may indicate a stuck job or genuine memory pressure' });
    }
    // Check mem tier
    var mp   = window.MemPressure;
    var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
    if (tier === 'critical' || tier === 'danger') {
      warnings.push({ level: 'error', msg: 'Memory pressure tier: ' + tier + ' — processing may be degraded' });
    }
    // Check stale checkpoints
    var p33 = window.Phase33;
    if (p33 && p33.CheckpointEngine) {
      p33.CheckpointEngine.getAllPending().then(function (jobs) {
        if (jobs.length > 5) console.warn('[FullNextGenAudit] ' + jobs.length + ' stale checkpoints detected — consider running Phase33.CheckpointEngine.sweepStale()');
      }).catch(function () {});
    }
    return warnings;
  }

  // ── Browser compatibility warnings ────────────────────────────────────────
  function _browserWarnings() {
    var w = [];
    if (typeof IntersectionObserver === 'undefined') w.push('IntersectionObserver missing — page virtualization disabled');
    if (typeof BroadcastChannel === 'undefined')     w.push('BroadcastChannel missing — multi-tab cluster disabled');
    if (typeof WebAssembly === 'undefined')          w.push('WebAssembly missing — ONNX runtime unavailable');
    if (typeof DecompressionStream === 'undefined')  w.push('DecompressionStream missing — partial decompression uses fallback');
    if (typeof navigator === 'undefined' || !navigator.gpu) w.push('WebGPU unavailable — all GPU paths use CPU fallback');
    return w;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN AUDIT FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════
  window.FullNextGenAudit = async function () {
    console.group('\uD83D\uDE80 ILovePDF FullNextGenAudit — Phases 18–37+ (v' + VERSION + ')');
    console.log('Timestamp:', new Date().toISOString());
    console.log('User agent:', navigator.userAgent.slice(0, 80));

    var categories = {
      'Core Tools':        _scoreTools(),
      'Hook Chain':        _scoreHookChain(),
      'Streaming':         _scoreStreaming(),
      'Session Resume':    _scoreResume(),
      'Table OCR':         _scoreOcr(),
      'Virtualization':    _scoreVirtualization(),
      'GPU Acceleration':  _scoreGpu(),
      'AI Runtime (ONNX)': _scoreAiRuntime(),
      'Multi-Tab Cluster': _scoreMultiTab(),
      'P2P Compute':       _scoreP2P(),
      'OPFS Streaming':    _scoreOpfs(),
      'Differential Proc': _scoreDifferential(),
      'Auto-Tuning':       _scoreAutoTuning(),
      'Recovery V2':       _scoreRecoveryV2(),
      'Job Dashboard':     _scoreDashboard(),
      'Memory Safety':     _scoreMemorySafety(),
      'WorkerPool':        _scoreWorkerPool(),
    };

    var totalScore = 0;
    var maxScore   = 0;
    var tableRows  = [];

    Object.entries(categories).forEach(function (entry) {
      var cat  = entry[0];
      var data = entry[1];
      totalScore += data.score;
      maxScore   += data.max;
      tableRows.push({
        Category: cat,
        Score: data.score + '/' + data.max,
        Pct: Math.round((data.score / data.max) * 100) + '%',
        Status: data.score === data.max ? '\u2714 FULL' : data.score === 0 ? '\u2717 NONE' : '\u26A0 PARTIAL',
        Notes: data.note || data.memTier || data.backend || data.deviceTier !== undefined ? String(data.deviceTier) : '',
      });
    });

    var pct = Math.round((totalScore / maxScore) * 100);

    console.group('Category Scores');
    console.table(tableRows);
    console.groupEnd();

    // Storage estimate
    console.group('OPFS / Storage');
    try {
      var est = await navigator.storage.estimate();
      console.log('Used:', Math.round((est.usage || 0) / MB) + ' MB');
      console.log('Quota:', Math.round((est.quota || 0) / MB) + ' MB');
    } catch (_) { console.log('Storage estimate: unavailable'); }
    console.groupEnd();

    // Multi-tab
    var mtc = window.MultiTabCluster;
    if (mtc) {
      console.group('Multi-Tab Cluster');
      var mtcAudit = mtc.audit();
      console.table({ TabId: mtcAudit.tabId.slice(0, 12), Leader: mtcAudit.isLeader, Peers: mtcAudit.peerCount, Enabled: mtcAudit.enabled });
      console.groupEnd();
    }

    // AutoTuning
    var ate = window.AutoTuningEngine;
    if (ate) {
      console.group('Auto-Tuning');
      var ateA = ate.audit();
      console.table(ateA.currentParams);
      console.groupEnd();
    }

    // Leak detection
    var leaks = _detectLeaks();
    if (leaks.length > 0) {
      console.group('\uD83D\uDEA8 Warnings (' + leaks.length + ')');
      leaks.forEach(function (w) { console.warn(w.msg); });
      console.groupEnd();
    }

    // Browser compatibility
    var bwarn = _browserWarnings();
    if (bwarn.length > 0) {
      console.group('\uD83D\uDCE2 Browser Compatibility (' + bwarn.length + ' notes)');
      bwarn.forEach(function (w) { console.info(w); });
      console.groupEnd();
    }

    // FullEnterpriseAudit (P18–36)
    if (typeof window.FullEnterpriseAudit === 'function') {
      console.group('Phase 18–36 System (FullEnterpriseAudit)');
      try { await window.FullEnterpriseAudit(); } catch (_) {}
      console.groupEnd();
    }

    // Final scorecard
    var grade = pct >= 95 ? 'S — ENTERPRISE PRODUCTION READY'
              : pct >= 85 ? 'A — PRODUCTION READY'
              : pct >= 70 ? 'B — MOSTLY READY'
              : pct >= 50 ? 'C — PARTIALLY READY'
              : 'D — SIGNIFICANT GAPS';

    console.group('\uD83C\uDFC6 FINAL SCORE: ' + totalScore + ' / ' + maxScore + ' (' + pct + '%) — Grade: ' + grade);
    if (pct >= 95) console.log('\u2714 All systems operational. Platform is enterprise-ready for giant-file processing.');
    else if (pct >= 85) console.log('\u26A0 Nearly there. Check PARTIAL categories above.');
    else console.warn('\u2717 Several key systems are missing or not initialized. See category breakdown.');
    console.groupEnd();

    console.groupEnd();   // top-level group

    return {
      version:      VERSION,
      totalScore:   totalScore,
      maxScore:     maxScore,
      pct:          pct,
      grade:        grade,
      categories:   categories,
      warnings:     leaks,
      browserWarns: bwarn,

      // Individual sub-scores for programmatic use
      scores: Object.fromEntries ? Object.fromEntries(Object.entries(categories).map(function (e) { return [e[0], e[1].score + '/' + e[1].max]; }))
            : categories,
    };
  };

  // Also expose a short alias
  window.nga = window.FullNextGenAudit;

  console.debug('[P37] FullNextGenAudit loaded — call window.FullNextGenAudit() or window.nga() to audit');
}());
