// Phase 40A — Final Memory Leak Audit v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § A1  ResourceTracker      — canvases, bitmaps, workers, blobs, channels, RTCs
// § A2  HeapDeltaMonitor     — JS heap snapshots before/after each job
// § A3  LeakSweeper          — periodic audit + auto-release of orphans
// § A4  TensorLeakGuard      — ONNX tensor accounting
// § A5  GpuLeakGuard         — GPU buffer / texture accounting
//
// Exposes: window.FinalMemoryAudit, window.RunMemoryLeakAudit()

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[FMA]';
  var SWEEP_MS = 30000;

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _warn(t, d) { try { console.warn(LOG_PFX + ' ' + t, d || ''); } catch (_) {} }

  // ═══════════════════════════════════════════════════════════════════════════
  // § A1  RESOURCE TRACKER
  // ═══════════════════════════════════════════════════════════════════════════
  var ResourceTracker = (function () {
    var _reg = {
      canvases:   new Map(),   // id → { canvas, jobId, ts }
      bitmaps:    new Map(),
      workers:    new Map(),
      blobUrls:   new Map(),
      channels:   new Map(),
      rtcConns:   new Map(),
      opfsHandles:new Map(),
    };
    var _nextId = 1;

    function _id() { return _nextId++; }

    function trackCanvas(canvas, jobId) {
      var id = _id();
      _reg.canvases.set(id, { canvas: canvas, jobId: jobId || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseCanvas(id) { _reg.canvases.delete(id); }

    function trackBitmap(bmp, jobId) {
      var id = _id();
      _reg.bitmaps.set(id, { bmp: bmp, jobId: jobId || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseBitmap(id) {
      var e = _reg.bitmaps.get(id);
      if (e && e.bmp && typeof e.bmp.close === 'function') try { e.bmp.close(); } catch (_) {}
      _reg.bitmaps.delete(id);
    }

    function trackWorker(worker, label) {
      var id = _id();
      _reg.workers.set(id, { worker: worker, label: label || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseWorker(id) { _reg.workers.delete(id); }

    function trackBlobUrl(url, jobId) {
      var id = _id();
      _reg.blobUrls.set(id, { url: url, jobId: jobId || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseBlobUrl(id) {
      var e = _reg.blobUrls.get(id);
      if (e) try { URL.revokeObjectURL(e.url); } catch (_) {}
      _reg.blobUrls.delete(id);
    }

    function trackChannel(ch, label) {
      var id = _id();
      _reg.channels.set(id, { ch: ch, label: label || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseChannel(id) {
      var e = _reg.channels.get(id);
      if (e) try { e.ch.close(); } catch (_) {}
      _reg.channels.delete(id);
    }

    function trackRtc(conn, label) {
      var id = _id();
      _reg.rtcConns.set(id, { conn: conn, label: label || 'unknown', ts: Date.now() });
      return id;
    }
    function releaseRtc(id) {
      var e = _reg.rtcConns.get(id);
      if (e) try { e.conn.close(); } catch (_) {}
      _reg.rtcConns.delete(id);
    }

    function snapshot() {
      return {
        canvases:   _reg.canvases.size,
        bitmaps:    _reg.bitmaps.size,
        workers:    _reg.workers.size,
        blobUrls:   _reg.blobUrls.size,
        channels:   _reg.channels.size,
        rtcConns:   _reg.rtcConns.size,
        opfsHandles:_reg.opfsHandles.size,
      };
    }

    // Find orphans: resources alive > maxAgeMs with no active job
    function findOrphans(maxAgeMs) {
      var now    = Date.now();
      var thresh = maxAgeMs || 5 * 60 * 1000;
      var found  = [];
      _reg.canvases.forEach(function (e, id) { if (now - e.ts > thresh) found.push({ type: 'canvas', id: id, age: Math.round((now-e.ts)/1000) + 's' }); });
      _reg.bitmaps.forEach(function (e, id)  { if (now - e.ts > thresh) found.push({ type: 'bitmap', id: id, age: Math.round((now-e.ts)/1000) + 's' }); });
      _reg.blobUrls.forEach(function (e, id) { if (now - e.ts > thresh) found.push({ type: 'blobUrl', id: id, age: Math.round((now-e.ts)/1000) + 's' }); });
      return found;
    }

    return { trackCanvas: trackCanvas, releaseCanvas: releaseCanvas, trackBitmap: trackBitmap, releaseBitmap: releaseBitmap, trackWorker: trackWorker, releaseWorker: releaseWorker, trackBlobUrl: trackBlobUrl, releaseBlobUrl: releaseBlobUrl, trackChannel: trackChannel, releaseChannel: releaseChannel, trackRtc: trackRtc, releaseRtc: releaseRtc, snapshot: snapshot, findOrphans: findOrphans };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A2  HEAP DELTA MONITOR
  // ═══════════════════════════════════════════════════════════════════════════
  var HeapDeltaMonitor = (function () {
    var _baseline = null;
    var _history  = [];   // { tool, beforeMB, afterMB, deltaMB, ts }
    var MAX_HIST  = 50;

    function heapMB() {
      if (window.performance && window.performance.memory) {
        return Math.round(window.performance.memory.usedJSHeapSize / MB);
      }
      return -1;
    }

    function before(toolId) {
      return { toolId: toolId, heapMB: heapMB(), ts: Date.now() };
    }

    function after(snapshot, opts) {
      var now    = Date.now();
      var before = snapshot.heapMB;
      var cur    = heapMB();
      var delta  = cur - before;
      var entry  = { tool: snapshot.toolId, beforeMB: before, afterMB: cur, deltaMB: delta, ms: now - snapshot.ts };
      _history.unshift(entry);
      if (_history.length > MAX_HIST) _history.pop();
      if (delta > 50) _warn('heap-leak', { tool: snapshot.toolId, deltaMB: delta });
      _log('heap-delta', entry);
      return entry;
    }

    function getHistory(toolId) {
      return toolId ? _history.filter(function (h) { return h.tool === toolId; }) : _history.slice();
    }

    function setBaseline() {
      _baseline = { heapMB: heapMB(), ts: Date.now() };
    }

    function getDriftFromBaseline() {
      if (!_baseline) return null;
      return { driftMB: heapMB() - _baseline.heapMB, ageSec: Math.round((Date.now() - _baseline.ts) / 1000) };
    }

    return { before: before, after: after, getHistory: getHistory, setBaseline: setBaseline, getDriftFromBaseline: getDriftFromBaseline, heapMB: heapMB };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A3  LEAK SWEEPER
  // ═══════════════════════════════════════════════════════════════════════════
  var LeakSweeper = (function () {
    var _sweepCount = 0;
    var _lastReport = null;

    function sweep() {
      _sweepCount++;
      var orphans = ResourceTracker.findOrphans(3 * 60 * 1000);   // 3 min old
      var report  = {
        sweepNo:  _sweepCount,
        ts:       Date.now(),
        orphans:  orphans,
        resources: ResourceTracker.snapshot(),
        heap:     HeapDeltaMonitor.heapMB(),
        drift:    HeapDeltaMonitor.getDriftFromBaseline(),
      };
      _lastReport = report;

      if (orphans.length > 0) {
        _warn('sweep-orphans', orphans);
        // Auto-release leaked blob URLs
        orphans.filter(function (o) { return o.type === 'blobUrl'; }).forEach(function (o) {
          ResourceTracker.releaseBlobUrl(o.id);
        });
        // Auto-close leaked bitmaps
        orphans.filter(function (o) { return o.type === 'bitmap'; }).forEach(function (o) {
          ResourceTracker.releaseBitmap(o.id);
        });
      }

      _log('sweep', { orphans: orphans.length, heap: report.heap });
      return report;
    }

    function getLastReport() { return _lastReport; }
    function getSweepCount() { return _sweepCount; }

    var _timer = setInterval(sweep, SWEEP_MS);
    window.addEventListener('beforeunload', function () { clearInterval(_timer); });

    return { sweep: sweep, getLastReport: getLastReport, getSweepCount: getSweepCount };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A4  TENSOR LEAK GUARD
  // ═══════════════════════════════════════════════════════════════════════════
  var TensorLeakGuard = (function () {
    var _allocated = 0;
    var _released  = 0;
    var MAX_LIVE   = 200;

    function onAllocate(count) { _allocated += (count || 1); if (live() > MAX_LIVE) _warn('tensor-leak', { live: live() }); }
    function onRelease(count) { _released += (count || 1); }
    function live() { return Math.max(0, _allocated - _released); }
    function reset() { _allocated = 0; _released = 0; }
    function stats() { return { allocated: _allocated, released: _released, live: live() }; }

    // Hook into OnnxRuntimeManager TensorPool if present
    function install() {
      var orm = window.OnnxRuntimeManager;
      if (!orm || !orm.TensorPool || orm.TensorPool.__fma_hooked) return;
      var origAcq = orm.TensorPool.acquire.bind(orm.TensorPool);
      var origRel = orm.TensorPool.release.bind(orm.TensorPool);
      orm.TensorPool.acquire = function () { onAllocate(1); return origAcq.apply(this, arguments); };
      orm.TensorPool.release = function () { onRelease(1); return origRel.apply(this, arguments); };
      orm.TensorPool.__fma_hooked = true;
    }

    var _tryInstall = setInterval(function () { if (install() !== undefined || window.OnnxRuntimeManager) clearInterval(_tryInstall); }, 500);

    return { onAllocate: onAllocate, onRelease: onRelease, live: live, reset: reset, stats: stats, install: install };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A5  GPU LEAK GUARD
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuLeakGuard = (function () {
    var _buffers  = 0;
    var _textures = 0;
    var SOFT_MAX  = 64;

    function onBuffer()   { _buffers++;   if (_buffers  > SOFT_MAX) _warn('gpu-buf-leak',  { count: _buffers }); }
    function onTexture()  { _textures++;  if (_textures > SOFT_MAX) _warn('gpu-tex-leak',  { count: _textures }); }
    function offBuffer()  { _buffers  = Math.max(0, _buffers  - 1); }
    function offTexture() { _textures = Math.max(0, _textures - 1); }
    function stats() { return { liveBuffers: _buffers, liveTextures: _textures }; }
    function flush() {
      var wgap = window.WebGpuAiPipelines;
      if (wgap && wgap.flush) wgap.flush();
      var p36  = window.Phase36;
      if (p36  && p36.GpuResourceManager && p36.GpuResourceManager.flush) p36.GpuResourceManager.flush();
      _buffers = 0; _textures = 0;
      _log('gpu-flush', {});
    }

    setInterval(function () {
      if (_buffers > SOFT_MAX * 2 || _textures > SOFT_MAX * 2) flush();
    }, 60000);

    return { onBuffer: onBuffer, onTexture: onTexture, offBuffer: offBuffer, offTexture: offTexture, stats: stats, flush: flush };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  HeapDeltaMonitor.setBaseline();

  window.FinalMemoryAudit = {
    version:         VERSION,
    ResourceTracker: ResourceTracker,
    HeapDeltaMonitor: HeapDeltaMonitor,
    LeakSweeper:     LeakSweeper,
    TensorLeakGuard: TensorLeakGuard,
    GpuLeakGuard:    GpuLeakGuard,

    beforeJob: function (toolId) { return HeapDeltaMonitor.before(toolId); },
    afterJob:  function (snap)   { return HeapDeltaMonitor.after(snap); },
    sweep:     function ()       { return LeakSweeper.sweep(); },

    audit: function () {
      return {
        version:   VERSION,
        resources: ResourceTracker.snapshot(),
        heap:      HeapDeltaMonitor.heapMB(),
        drift:     HeapDeltaMonitor.getDriftFromBaseline(),
        tensors:   TensorLeakGuard.stats(),
        gpu:       GpuLeakGuard.stats(),
        sweeps:    LeakSweeper.getSweepCount(),
        lastSweep: LeakSweeper.getLastReport(),
      };
    },
  };

  window.RunMemoryLeakAudit = function () {
    console.group('[FMA] RunMemoryLeakAudit');
    var report = window.FinalMemoryAudit.audit();
    var sweep  = LeakSweeper.sweep();
    console.table(report.resources);
    console.log('Heap:', report.heap, 'MB  Drift:', report.drift);
    console.log('Tensors (live):', report.tensors.live, '  GPU buffers:', report.gpu.liveBuffers, '  textures:', report.gpu.liveTextures);
    console.log('Orphans found in sweep:', sweep.orphans.length);
    if (sweep.orphans.length) console.table(sweep.orphans);
    console.groupEnd();
    return { report: report, sweep: sweep };
  };

  _log('loaded', {});
}());
