// RuntimeAIGraph v1.0 — Phase 29A-D
// AI pipeline graph visualization + smart OCR routing + AI worker pool +
// extended AI telemetry. PURELY ADDITIVE — does not replace any existing system.
//
// Phase 29A — AI Pipeline Graph: canvas DAG renderer showing OCR → enhance → export
// Phase 29B — Smart OCR Routing: choose WASM/GPU/lightweight/chunked automatically
// Phase 29C — AI Worker Pool: extends RuntimeWorkers with AI-specific acquisition
// Phase 29D — AI Telemetry: inference times, confidence, fallback frequency, GPU usage
//
// Integrates (reads/delegates, never replaces):
//   RuntimeAIScheduler  — device profile + priority queues
//   WebGpuAiPipelines   — GPU OCR enhance, denoise, sharpen pipelines
//   RuntimeWorkers      — worker dispatch
//   RuntimeAIOrchestrator — AI provider chain
//
// Exposed as: window.RuntimeAIGraph

(function (G) {
  'use strict';

  if (G.RuntimeAIGraph) return;

  var VERSION = '1.0';
  var LOG     = '[AG29]';
  var MB      = 1024 * 1024;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _log(m) { console.debug(LOG, m); }

  // ── Pipeline definitions ──────────────────────────────────────────────────
  // Each pipeline is a DAG of stages. Each stage has an id, label, next stages.
  var PIPELINES = {
    ocr: {
      id: 'ocr', label: 'OCR Pipeline',
      stages: [
        { id: 'ingest',    label: 'Ingest',      next: ['preprocess'] },
        { id: 'preprocess',label: 'Preprocess',   next: ['deskew', 'denoise'] },
        { id: 'deskew',    label: 'Deskew',       next: ['ocr-engine'] },
        { id: 'denoise',   label: 'Denoise',      next: ['ocr-engine'] },
        { id: 'ocr-engine',label: 'OCR Engine',   next: ['cleanup'] },
        { id: 'cleanup',   label: 'Text Cleanup', next: ['export'] },
        { id: 'export',    label: 'Export',       next: [] },
      ],
    },
    bgRemove: {
      id: 'bgRemove', label: 'Background Removal',
      stages: [
        { id: 'ingest',    label: 'Ingest',        next: ['resize'] },
        { id: 'resize',    label: 'Resize',         next: ['segment'] },
        { id: 'segment',   label: 'Segment',        next: ['refine'] },
        { id: 'refine',    label: 'Edge Refine',    next: ['composite'] },
        { id: 'composite', label: 'Composite',      next: ['export'] },
        { id: 'export',    label: 'Export PNG',     next: [] },
      ],
    },
    summarize: {
      id: 'summarize', label: 'AI Summarize',
      stages: [
        { id: 'extract',   label: 'Extract Text',  next: ['chunk'] },
        { id: 'chunk',     label: 'Chunk Text',    next: ['embed'] },
        { id: 'embed',     label: 'Embed',         next: ['generate'] },
        { id: 'generate',  label: 'Generate',      next: ['format'] },
        { id: 'format',    label: 'Format Output', next: [] },
      ],
    },
  };

  // ── Canvas Pipeline Renderer ──────────────────────────────────────────────
  function renderPipeline(pipelineId, canvasEl, opts) {
    var pipeline = PIPELINES[pipelineId];
    if (!pipeline || !canvasEl) return;
    opts = opts || {};

    var ctx   = canvasEl.getContext('2d');
    var W     = canvasEl.width  || 600;
    var H     = canvasEl.height || 200;
    var stages = pipeline.stages;
    var n     = stages.length;
    var padX  = 32, padY = 36;
    var boxW  = Math.min(90, (W - padX * 2) / n - 12);
    var boxH  = 36;
    var gapX  = (W - padX * 2 - boxW * n) / Math.max(1, n - 1);
    var theme = {
      bg:       opts.dark ? '#0d1117' : '#ffffff',
      border:   opts.dark ? '#30363d' : '#e2e8f0',
      nodeBase: opts.dark ? '#161b22' : '#f8fafc',
      nodeAct:  opts.dark ? '#7c3aed' : '#6366f1',
      nodeDone: opts.dark ? '#10b981' : '#059669',
      nodeErr:  opts.dark ? '#ef4444' : '#dc2626',
      text:     opts.dark ? '#e6edf3' : '#1e293b',
      arrow:    opts.dark ? '#4b5563' : '#94a3b8',
    };

    var activeId = opts.activeStage || null;
    var doneIds  = new Set(opts.doneStages || []);
    var errorIds = new Set(opts.errorStages || []);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);

    // Draw title
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillStyle = opts.dark ? '#7c3aed' : '#6366f1';
    ctx.fillText(pipeline.label, padX, 20);

    stages.forEach(function (stage, i) {
      var x = padX + i * (boxW + gapX);
      var y = padY + (H - padY * 2 - boxH) / 2;

      // Determine color
      var fill, stroke;
      if (errorIds.has(stage.id)) { fill = theme.nodeErr; stroke = theme.nodeErr; }
      else if (stage.id === activeId) { fill = theme.nodeAct; stroke = theme.nodeAct; }
      else if (doneIds.has(stage.id)) { fill = theme.nodeDone; stroke = theme.nodeDone; }
      else { fill = theme.nodeBase; stroke = theme.border; }

      // Draw arrow to next stage
      if (i < stages.length - 1) {
        var arrowX = x + boxW;
        var arrowY = y + boxH / 2;
        var arrowEnd = arrowX + gapX;
        ctx.strokeStyle = theme.arrow;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(arrowX + 4, arrowY);
        ctx.lineTo(arrowEnd - 4, arrowY);
        ctx.stroke();
        // Arrowhead
        ctx.fillStyle = theme.arrow;
        ctx.beginPath();
        ctx.moveTo(arrowEnd - 4, arrowY - 4);
        ctx.lineTo(arrowEnd, arrowY);
        ctx.lineTo(arrowEnd - 4, arrowY + 4);
        ctx.fill();
      }

      // Draw node box (rounded rect)
      ctx.beginPath();
      var r = 6;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + boxW - r, y);
      ctx.arcTo(x + boxW, y, x + boxW, y + r, r);
      ctx.lineTo(x + boxW, y + boxH - r);
      ctx.arcTo(x + boxW, y + boxH, x + boxW - r, y + boxH, r);
      ctx.lineTo(x + r, y + boxH);
      ctx.arcTo(x, y + boxH, x, y + boxH - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = errorIds.has(stage.id) || stage.id === activeId ? 2 : 1;
      ctx.stroke();

      // Draw label
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = (errorIds.has(stage.id) || stage.id === activeId || doneIds.has(stage.id))
        ? '#ffffff' : theme.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var words = stage.label.split(' ');
      if (words.length === 1) {
        ctx.fillText(stage.label.slice(0, 10), x + boxW / 2, y + boxH / 2);
      } else {
        ctx.fillText(words[0].slice(0, 10), x + boxW / 2, y + boxH / 2 - 6);
        ctx.fillText(words.slice(1).join(' ').slice(0, 10), x + boxW / 2, y + boxH / 2 + 6);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    });
  }

  // ── Smart OCR Routing ─────────────────────────────────────────────────────
  // Automatically selects the best OCR engine based on device + file characteristics.
  var OCR_MODES = {
    WEBGPU:      'webgpu',       // fastest, requires WebGPU
    WASM:        'wasm',         // fast, standard WebAssembly OCR
    LIGHTWEIGHT: 'lightweight',  // conservative, low memory
    CHUNKED:     'chunked',      // giant files, process page-by-page
  };

  function routeOCR(imageFile, opts) {
    opts = opts || {};
    var fileSize = imageFile ? (imageFile.size || 0) : (opts.bytes || 0);
    var profile  = _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getDeviceProfile(); }) || {};
    var tier     = profile.gpuTier || 'cpu';
    var ramTier  = profile.ramTier || 'medium';
    var thermal  = profile.thermal || 'nominal';
    var battery  = profile.battery || { charging: true, level: 1.0 };
    var memTier  = _s(function () { return G.RuntimeMemory && G.RuntimeMemory.getTier(); }, 'NORMAL');

    // Rule-based routing
    // 1. Giant file → chunked (always)
    if (fileSize > 50 * MB) return OCR_MODES.CHUNKED;

    // 2. Emergency memory → lightweight
    if (memTier === 'EMERGENCY' || memTier === 'CRITICAL') return OCR_MODES.LIGHTWEIGHT;

    // 3. Low battery + not charging → lightweight
    if (!battery.charging && battery.level < 0.15) return OCR_MODES.LIGHTWEIGHT;

    // 4. Hot device → avoid GPU (thermal throttle)
    if (thermal === 'hot') return OCR_MODES.WASM;

    // 5. Low RAM → lightweight
    if (ramTier === 'low') return OCR_MODES.LIGHTWEIGHT;

    // 6. WebGPU + medium-large file → WebGPU
    if (tier === 'webgpu' && ramTier !== 'low' && fileSize < 20 * MB) return OCR_MODES.WEBGPU;

    // 7. WebGL or CPU + reasonable file → WASM
    if (fileSize < 30 * MB) return OCR_MODES.WASM;

    // 8. Large file on capable device → chunked
    return OCR_MODES.CHUNKED;
  }

  // Execute OCR using the chosen route
  function executeOCR(file, opts) {
    var mode = routeOCR(file, opts);
    _telRecord('ocr-route', { mode: mode, size: file ? Math.round(file.size / MB * 10) / 10 : 0 });
    _log('OCR route: ' + mode);

    // Delegate to the appropriate engine
    switch (mode) {
      case OCR_MODES.WEBGPU:
        // Prefer WebGpuAiPipelines if available
        if (G.WebGpuAiPipelines && G.WebGpuAiPipelines.AiPipelines) {
          return G.WebGpuAiPipelines.AiPipelines.ocrEnhance(file, opts)
            .then(function (r) {
              _telRecord('ocr-done', { mode: mode, engine: 'webgpu' });
              return r;
            });
        }
        // Fallthrough to WASM
        // falls through
      case OCR_MODES.WASM:
        if (G.BrowserTools && G.BrowserTools.process) {
          return G.BrowserTools.process('ocr', [file], Object.assign({}, opts, { _p29OcrMode: 'wasm' }))
            .then(function (r) {
              _telRecord('ocr-done', { mode: mode, engine: 'wasm' });
              return r;
            });
        }
        return Promise.reject(new Error('No OCR engine available'));
      case OCR_MODES.LIGHTWEIGHT:
        if (G.BrowserTools && G.BrowserTools.process) {
          return G.BrowserTools.process('ocr', [file], Object.assign({}, opts, { _p29OcrMode: 'fast', _p26OcrMode: 'fast' }))
            .then(function (r) {
              _telRecord('ocr-done', { mode: mode, engine: 'lightweight' });
              return r;
            });
        }
        return Promise.reject(new Error('No OCR engine available'));
      case OCR_MODES.CHUNKED:
        // Chunked: delegate to RuntimeAIScheduler with background priority
        return new Promise(function (resolve, reject) {
          var sched = G.RuntimeAIScheduler;
          if (!sched) { reject(new Error('RuntimeAIScheduler not available')); return; }
          var result = sched.schedule('ocr', function (ctx) {
            if (!G.BrowserTools) return Promise.reject(new Error('BrowserTools unavailable'));
            return G.BrowserTools.process('ocr', [file], Object.assign({}, opts, { _p29OcrMode: 'chunked', _p26BatchSize: 2 }));
          }, { priority: 'normal', meta: { route: mode, size: file ? file.size : 0 } });
          result.promise.then(resolve).catch(reject);
          _telRecord('ocr-queued', { mode: mode, taskId: result.taskId });
        });
    }
    return Promise.reject(new Error('Unknown OCR mode: ' + mode));
  }

  // ── AI Worker Pool ─────────────────────────────────────────────────────────
  // Extends RuntimeWorkers with AI-specific semantics.
  var _aiWorkerPool = new Map();   // workerId → { type, acquired, ts }
  var AI_WORKER_TYPES = ['ocr', 'inference', 'bgremove', 'enhance'];
  var MAX_AI_WORKERS  = 3;

  function acquireAIWorker(type) {
    if (!AI_WORKER_TYPES.includes(type)) type = 'inference';
    return new Promise(function (resolve) {
      // Check existing idle AI worker of this type
      var idle = null;
      _aiWorkerPool.forEach(function (w, id) {
        if (!idle && w.type === type && !w.acquired) idle = id;
      });
      if (idle) {
        _aiWorkerPool.get(idle).acquired = true;
        resolve(idle);
        return;
      }
      // Check pool capacity
      if (_aiWorkerPool.size >= MAX_AI_WORKERS) {
        // Wait for a release (poll with timeout)
        var tries = 0;
        var poll = setInterval(function () {
          _aiWorkerPool.forEach(function (w, id) {
            if (!idle && w.type === type && !w.acquired) idle = id;
          });
          if (idle || tries++ > 20) {
            clearInterval(poll);
            if (idle) { _aiWorkerPool.get(idle).acquired = true; resolve(idle); }
            else resolve(null); // timeout
          }
        }, 200);
        return;
      }
      // Allocate new entry
      var id = 'ai_worker_' + type + '_' + Date.now().toString(36);
      _aiWorkerPool.set(id, { type: type, acquired: true, ts: Date.now() });
      resolve(id);
    });
  }

  function releaseAIWorker(workerId) {
    var entry = _aiWorkerPool.get(workerId);
    if (entry) {
      entry.acquired = false;
      // If worker is old, evict it (prevent stale pool)
      if (Date.now() - entry.ts > 300000) { // 5 min
        _aiWorkerPool.delete(workerId);
      }
    }
  }

  // ── AI Telemetry ───────────────────────────────────────────────────────────
  var _telLog = [];
  var MAX_TEL = 100;

  function _telRecord(event, data) {
    _telLog.unshift({ ts: Date.now(), event: event, data: data || null });
    if (_telLog.length > MAX_TEL) _telLog.length = MAX_TEL;
    _s(function () {
      G.RuntimeTelemetry && G.RuntimeTelemetry.record('ai-graph.' + event, data);
    });
    // Feed into RuntimeDiagnosticsCenter timeline
    _s(function () {
      if (G.RuntimeDiagnosticsCenter && event.indexOf('error') !== -1) {
        G.RuntimeDiagnosticsCenter.addTimelineEvent('ai-graph.' + event, data);
      }
    });
  }

  function recordInference(pipelineId, durationMs, confidence, opts) {
    opts = opts || {};
    _telRecord('inference', {
      pipeline:    pipelineId,
      durationMs:  Math.round(durationMs),
      confidence:  confidence !== undefined ? Math.round(confidence * 100) : null,
      gpuUsed:     !!opts.gpuUsed,
      fallback:    !!opts.fallback,
    });
    // Also push into RuntimeAIScheduler if available
    _s(function () {
      var ais = G.RuntimeAIScheduler;
      if (ais && ais.schedule) {
        // Record via telemetry only — don't schedule a new task
      }
    });
  }

  function getTelemetry() {
    var inferences = _telLog.filter(function (e) { return e.event === 'inference'; });
    var routes     = _telLog.filter(function (e) { return e.event === 'ocr-route'; });
    var gpuCount   = inferences.filter(function (e) { return e.data && e.data.gpuUsed; }).length;
    var fbCount    = inferences.filter(function (e) { return e.data && e.data.fallback; }).length;
    var times      = inferences.map(function (e) { return e.data && e.data.durationMs; }).filter(Boolean);
    var avgMs      = times.length ? Math.round(times.reduce(function (a, b) { return a + b; }, 0) / times.length) : 0;
    var confs      = inferences.map(function (e) { return e.data && e.data.confidence; }).filter(function (v) { return v !== null && v !== undefined; });
    var avgConf    = confs.length ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length) : null;
    var ocrRoutes  = {};
    routes.forEach(function (e) { var m = e.data && e.data.mode; if (m) ocrRoutes[m] = (ocrRoutes[m] || 0) + 1; });
    return {
      totalInferences:    inferences.length,
      avgInferenceMs:     avgMs,
      avgConfidencePct:   avgConf,
      gpuAccelerationRate: inferences.length ? gpuCount / inferences.length : 0,
      fallbackRate:        inferences.length ? fbCount / inferences.length : 0,
      ocrRouteCounts:      ocrRoutes,
      workerPoolSize:      _aiWorkerPool.size,
      recentLog:           _telLog.slice(0, 20),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeAIGraph = {
    VERSION:          VERSION,
    PIPELINES:        PIPELINES,
    OCR_MODES:        OCR_MODES,

    renderPipeline:   renderPipeline,
    routeOCR:         routeOCR,
    executeOCR:       executeOCR,
    acquireAIWorker:  acquireAIWorker,
    releaseAIWorker:  releaseAIWorker,
    recordInference:  recordInference,
    getTelemetry:     getTelemetry,

    getWorkerPool: function () {
      var out = {};
      _aiWorkerPool.forEach(function (v, k) { out[k] = { type: v.type, acquired: v.acquired }; });
      return out;
    },

    audit: function () {
      var tel = this.getTelemetry();
      console.group(LOG + ' RuntimeAIGraph audit');
      console.log('Pipelines defined:', Object.keys(PIPELINES));
      console.log('Telemetry:', tel);
      console.log('Worker pool:', this.getWorkerPool());
      console.groupEnd();
      return { tel: tel, pipelines: Object.keys(PIPELINES) };
    },
  };

  G.RuntimeAIGraph = RuntimeAIGraph;
  _log('v' + VERSION + ' ready');

}(window));
