// Phase 26 Enhancements v1.0 — Per-Tool Deep Enhancement + Giant File Stabilization
// Wraps window.BrowserTools.process with a thin outer shell AFTER advanced-engine.js
// has already patched it. PURELY ADDITIVE — zero modifications to any existing file.
//
// Activates:
//   — Pre-flight memory eviction (EvictionManager)
//   — Adaptive opts injection (RollingProcessor + MemPressure)
//   — GiantFileRouting memory-budget gate (canAffordWorker)
//   — OPFS warm-staging for giant files (LargeFileStreaming.stageGiantFile, fire-and-forget)
//   — GiantFileTelemetry event recording at job start/end/error
//   — Post-processing resource cleanup
//
// Exposes: window.Phase26
// Depends on: MemPressure, EvictionManager, RollingProcessor, GiantFileRouting,
//             LargeFileStreaming, GiantFileTelemetry (all Phase 25)

(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Giant file threshold ────────────────────────────────────────────────────
  // Files above this size get enhanced treatment (eviction flush, OPFS staging,
  // routing isolation hints). Deliberately lower than advanced-engine's 200 MB
  // OPFS_THRESHOLD so we act before the engine hits its own boundary.
  var GIANT_BYTES = 150 * MB;

  // ── Tools that benefit from rolling-window / batch-mode processing ──────────
  var ROLLING_TOOLS = {
    'ocr':               true,
    'compare':           true,
    'repair':            true,
    'compress':          true,
    'pdf-to-word':       true,
    'pdf-to-excel':      true,
    'pdf-to-powerpoint': true,
    'pdf-to-jpg':        true,
    'jpg-to-pdf':        true,
    'image-filters':     true,
    'background-remover':true,
    'translate':         true,
    'ai-summarize':      true,
    'workflow':          true,
  };

  // ── Tools eligible for OPFS warm-staging ────────────────────────────────────
  var OPFS_ELIGIBLE = {
    'ocr':               true,
    'compress':          true,
    'repair':            true,
    'compare':           true,
    'pdf-to-word':       true,
    'pdf-to-excel':      true,
    'pdf-to-powerpoint': true,
  };

  // ── Utility: total bytes across a FileList / Array ──────────────────────────
  function totalBytes(files) {
    var n = 0;
    var arr = Array.from(files || []);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i]) n += (arr[i].size || 0);
    }
    return n;
  }

  function isGiant(bytes) { return bytes >= GIANT_BYTES; }

  // ── Telemetry helpers ───────────────────────────────────────────────────────
  function telRecord(event, data) {
    try {
      if (window.GiantFileTelemetry && window.GiantFileTelemetry.record) {
        window.GiantFileTelemetry.record('phase26.' + event, data || {});
      }
    } catch (_) {}
  }

  function telStart(toolId, byteCount, giant) {
    telRecord('job-start', { toolId: toolId, mb: Math.round(byteCount / MB), giant: giant });
    try {
      if (giant) window.GiantFileTelemetry && window.GiantFileTelemetry.recordMemSample();
    } catch (_) {}
  }

  function telEnd(toolId, byteCount, success) {
    telRecord('job-end', { toolId: toolId, mb: Math.round(byteCount / MB), success: success });
    try {
      window.GiantFileTelemetry && window.GiantFileTelemetry.recordMemSample();
    } catch (_) {}
  }

  function telError(toolId, err) {
    telRecord('error', {
      toolId: toolId,
      msg: String((err && err.message) || err || '').slice(0, 200),
    });
  }

  // ── Pre-flight eviction ──────────────────────────────────────────────────────
  // Releases accumulated GPU/canvas/bitmap resources before starting a new tool.
  function preFlightEviction(toolId, byteCount, giant) {
    try {
      var EM = window.EvictionManager;
      if (!EM) return;

      if (giant) {
        // Giant file: full emergency flush before we begin
        EM.emergencyPressureFlush();
        telRecord('preflight-flush', { mode: 'emergency', toolId: toolId });
      } else if (window.MemPressure) {
        var t = window.MemPressure.tier();
        if (t === 'critical' || t === 'abort') {
          EM.emergencyPressureFlush();
          telRecord('preflight-flush', { mode: 'emergency-pressure', toolId: toolId, tier: t });
        } else if (t === 'low') {
          EM.selectivePressureFlush();
          telRecord('preflight-flush', { mode: 'selective', toolId: toolId, tier: t });
        } else {
          EM.cleanOrphanCanvases();
        }
      }

      // Always sweep stale OPFS files at job start (non-blocking)
      if (window.OPFSManager && window.OPFSManager.sweep) {
        window.OPFSManager.sweep().catch(function () {});
      }
    } catch (_) {}
  }

  // ── OPFS warm-staging ────────────────────────────────────────────────────────
  // For giant files on eligible tools, stage the file to OPFS in the background.
  // This is fire-and-forget — it warms the OPFS cache while the processor runs,
  // so subsequent chunks read from OPFS instead of RAM.
  function kickOPFSStaging(toolId, files, byteCount) {
    if (!OPFS_ELIGIBLE[toolId]) return;
    if (!isGiant(byteCount)) return;

    var LS = window.LargeFileStreaming;
    if (!LS || !LS.stageGiantFile) return;

    // OPFS must be available
    if (!window.OPFSManager || !window.OPFSManager.available || !window.OPFSManager.available()) return;

    var fileArr = Array.from(files || []);
    for (var i = 0; i < fileArr.length; i++) {
      var f = fileArr[i];
      if (!f || f.size < GIANT_BYTES) continue;
      (function (file, idx) {
        var key = 'p26_stage_' + toolId + '_' + idx + '_' + Date.now();
        LS.stageGiantFile(key, file, null).then(function (result) {
          telRecord('opfs-staged', {
            toolId: toolId,
            mb: Math.round(file.size / MB),
            key: key,
            strictStreaming: !!(result && result.strictStreaming),
          });
          // Cleanup the staging URL immediately — we only needed the OPFS warm pass
          if (result && typeof result.cleanup === 'function') {
            result.cleanup();
          }
        }).catch(function () {
          // Non-critical — processor will work without staging
        });
      }(f, i));
    }
  }

  // ── Memory budget gate ───────────────────────────────────────────────────────
  // Returns true if we have enough memory to start this tool.
  // Logs a telemetry warning but does NOT throw — lets the upstream processor
  // make the final call (it has its own shouldFallbackMem check).
  function checkMemoryBudget(toolId, byteCount) {
    try {
      var GFR = window.GiantFileRouting;
      if (!GFR || !GFR.canAffordWorker) return true;
      var filesz = byteCount;
      // Rough page estimate: 1 page per 15 KB for typical PDFs
      var estPages = Math.max(1, Math.round(filesz / (15 * 1024)));
      var affordable = GFR.canAffordWorker(toolId, filesz, estPages);
      if (!affordable) {
        telRecord('mem-budget-warn', {
          toolId:   toolId,
          mb:       Math.round(filesz / MB),
          estPages: estPages,
          tier:     window.MemPressure ? window.MemPressure.tier() : 'unknown',
        });
      }
      return affordable;
    } catch (_) {
      return true; // never block on error
    }
  }

  // ── Adaptive opts injection ──────────────────────────────────────────────────
  // Merges memory-tier-aware hints into opts for downstream processors that read
  // the _p26* keys (advanced-engine processors can optionally honour them).
  function buildAdaptiveOpts(toolId, byteCount, existingOpts) {
    var patch = {};
    try {
      // Batch size hint
      if (ROLLING_TOOLS[toolId] && window.RollingProcessor) {
        var estPages = Math.max(1, Math.round(byteCount / (15 * 1024)));
        patch._p26BatchSize = window.RollingProcessor.computeAdaptiveBatchSize(
          toolId, byteCount, estPages
        );
      }

      // Memory pressure hints
      if (window.MemPressure) {
        var tier = window.MemPressure.tier();
        patch._p26MemTier = tier;

        // OCR mode hint for tools that run OCR internally
        if (toolId === 'ocr' || toolId === 'pdf-to-word' ||
            toolId === 'pdf-to-excel' || toolId === 'pdf-to-powerpoint') {
          patch._p26OcrMode = window.MemPressure.ocrMode();
        }

        // PDF render scale hint
        patch._p26RenderScale = window.MemPressure.renderScale('pdf');

        // Image render scale hint for image tools
        if (toolId === 'image-filters' || toolId === 'background-remover' ||
            toolId === 'crop-image'    || toolId === 'resize-image') {
          patch._p26ImgScale = window.MemPressure.renderScale('img');
        }
      }

      // Giant-mode flag
      if (isGiant(byteCount)) {
        patch._p26GiantMode  = true;
        patch._p26TotalBytes = byteCount;
        // Routing isolation hint
        if (window.GiantFileRouting && window.GiantFileRouting.estimateTaskMemoryMB) {
          patch._p26EstMemMB = window.GiantFileRouting.estimateTaskMemoryMB(
            toolId, byteCount, Math.max(1, Math.round(byteCount / (15 * 1024)))
          );
        }
      }
    } catch (_) {}

    return Object.assign({}, existingOpts || {}, patch);
  }

  // ── Post-processing cleanup ──────────────────────────────────────────────────
  function postCleanup(toolId, giant) {
    try {
      var EM = window.EvictionManager;
      if (!EM) return;

      if (giant) {
        // After a giant job completes, do a full flush and sweep
        EM.emergencyPressureFlush();
        // Sweep LFS orphans
        if (window.LargeFileStreaming && window.LargeFileStreaming.recoverOrphans) {
          window.LargeFileStreaming.recoverOrphans().catch(function () {});
        }
        telRecord('post-cleanup', { mode: 'full', toolId: toolId });
      } else {
        // For normal jobs, just clean orphaned canvases
        EM.cleanOrphanCanvases();
      }
    } catch (_) {}
  }

  // ── Prewarm OCR lane on page load for OCR-adjacent tools ───────────────────
  function maybePrewarmOcr() {
    try {
      if (window.GiantFileRouting && window.GiantFileRouting.prewarmOcrLane) {
        var slug = (window.location.pathname || '').replace(/^\//, '').split('/')[0];
        var ocrTools = { 'ocr': 1, 'ocr-pdf': 1, 'scan-to-pdf': 1, 'pdf-to-word': 1 };
        if (ocrTools[slug]) {
          window.GiantFileRouting.prewarmOcrLane();
          telRecord('prewarm-ocr', { slug: slug });
        }
      }
    } catch (_) {}
  }

  // ── Main wrapper installer ───────────────────────────────────────────────────
  function installPhase26() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__phase26V1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      var bytes  = totalBytes(files);
      var giant  = isGiant(bytes);
      var result, success;

      // 1. Telemetry: record job start + memory sample
      telStart(toolId, bytes, giant);

      // 2. Pre-flight eviction — release pressure before heavy processing
      if (ROLLING_TOOLS[toolId] || giant) {
        preFlightEviction(toolId, bytes, giant);
      }

      // 3. Memory budget warning (non-blocking)
      if (ROLLING_TOOLS[toolId]) {
        checkMemoryBudget(toolId, bytes);
      }

      // 4. OPFS warm-staging for giant files (fire-and-forget)
      if (giant) {
        kickOPFSStaging(toolId, files, bytes);
      }

      // 5. Build adaptive opts patch
      var mergedOpts = buildAdaptiveOpts(toolId, bytes, opts);

      // 6. Call upstream (advanced-engine.js → browser-tools.js fallback)
      success = false;
      try {
        result  = await upstream(toolId, files, mergedOpts);
        success = true;
      } catch (err) {
        telError(toolId, err);
        postCleanup(toolId, giant);
        telEnd(toolId, bytes, false);
        throw err;
      }

      // 7. Post-processing cleanup
      postCleanup(toolId, giant);

      // 8. Telemetry: record job end
      telEnd(toolId, bytes, true);

      return result;
    };

    window.BrowserTools.__phase26V1 = true;
    telRecord('installed', { timestamp: Date.now() });
    return true;
  }

  // ── Deferred install ─────────────────────────────────────────────────────────
  // advanced-engine.js loads with defer, so BrowserTools may not be ready yet.
  if (!installPhase26()) {
    var _tries = 0;
    var _iv = setInterval(function () {
      if (installPhase26() || _tries++ > 100) clearInterval(_iv);
    }, 80);
  }

  // Prewarm OCR lane after a short delay (after WorkerPool is ready)
  setTimeout(maybePrewarmOcr, 1500);

  // ── PUBLIC API ────────────────────────────────────────────────────────────────
  window.Phase26 = {
    version:          '1.0',
    GIANT_THRESHOLD_MB: GIANT_BYTES / MB,
    ROLLING_TOOLS:    Object.keys(ROLLING_TOOLS),
    OPFS_ELIGIBLE:    Object.keys(OPFS_ELIGIBLE),
    // Utilities (usable externally)
    preFlightEviction:  preFlightEviction,
    postCleanup:        postCleanup,
    buildAdaptiveOpts:  buildAdaptiveOpts,
    checkMemoryBudget:  checkMemoryBudget,
    // Audit
    audit: function () {
      var stats = {
        version:          '1.0',
        hooked:           !!(window.BrowserTools && window.BrowserTools.__phase26V1),
        memTier:          window.MemPressure ? window.MemPressure.tier()        : 'unavailable',
        memAvailMB:       window.MemPressure ? Math.round(window.MemPressure.memAvail() / MB) : -1,
        giantThresholdMB: GIANT_BYTES / MB,
        rollingTools:     Object.keys(ROLLING_TOOLS),
        opfsEligible:     Object.keys(OPFS_ELIGIBLE),
        modules: {
          MemPressure:       !!window.MemPressure,
          EvictionManager:   !!window.EvictionManager,
          LargeFileStreaming: !!window.LargeFileStreaming,
          VirtualPageManager: !!window.VirtualPageManager,
          RollingProcessor:   !!window.RollingProcessor,
          GiantFileRouting:   !!window.GiantFileRouting,
          GiantFileTelemetry: !!window.GiantFileTelemetry,
          OPFSManager:        !!(window.OPFSManager && window.OPFSManager.available && window.OPFSManager.available()),
        },
      };

      if (window.EvictionManager && window.EvictionManager.getStats) {
        stats.eviction = window.EvictionManager.getStats();
      }
      if (window.GiantFileRouting && window.GiantFileRouting.getStats) {
        stats.routing = window.GiantFileRouting.getStats();
      }
      if (window.GiantFileTelemetry && window.GiantFileTelemetry.getLog) {
        var log = window.GiantFileTelemetry.getLog();
        stats.p26Events = log.filter(function (e) {
          return e && e.event && e.event.indexOf('phase26.') === 0;
        }).length;
      }

      console.group('Phase26 v1.0 — Audit');
      console.log('Hooked:', stats.hooked);
      console.log('Memory tier:', stats.memTier, '| Available:', stats.memAvailMB + ' MB');
      console.log('Giant threshold:', stats.giantThresholdMB + ' MB');
      console.log('Modules:', stats.modules);
      if (stats.eviction) console.log('Eviction stats:', stats.eviction);
      if (stats.routing)  console.log('Routing stats:', stats.routing);
      console.log('Phase26 telemetry events this session:', stats.p26Events || 0);
      console.groupEnd();
      return stats;
    },
  };

}());
