// Runtime Streaming Hooks v1.0 — Phase 2 (T034)
// Prepares streaming integration points WITHOUT implementing full streaming.
// Marks all current full-file-load patterns, provides chunk routing stubs,
// stream-aware scheduling slots, partial processing hooks, incremental
// rendering hooks, and chunk telemetry hooks.
//
// THIS FILE IS INTENTIONALLY STUB-HEAVY.
// Real streaming will be wired in a future phase (StreamEngine).
// Every stub is a [FUTURE: StreamEngine] marked migration point.
//
// Calling code can use these hooks today and get correct behavior;
// when StreamEngine lands, only the hook bodies change — no callsites.
//
// Integrates: RuntimeTelemetry, RuntimeEventBus, P1 (streamMarker),
//             RuntimeScheduler (future)
//
// [FUTURE: StreamEngine] When activated, replace stub bodies with:
//   - OPFS byte-range parser (phase32)
//   - RollingWindow page streaming (giant-file-routing)
//   - SurvivalMode for huge files (phase32)
//   - Incremental canvas rendering (future)
//
// Exposed as: window.RuntimeStreaming
(function () {
  'use strict';

  if (window.RuntimeStreaming) return;

  var LOG = '[RSH]';

  // ── Stream markers ────────────────────────────────────────────────────────
  // All full-file-load sites should call markFullLoad() so StreamEngine
  // can discover and replace them without grep.
  var _markers = [];

  function markFullLoad(label, opts) {
    var m = { label: label, opts: opts || {}, ts: Date.now() };
    _markers.push(m);
    // Forward to P1.streamMarker for backward compatibility
    if (window.P1 && window.P1.streamMarker) {
      try { window.P1.streamMarker(label, opts); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('stream:marker', { label: label }); } catch (_) {}
    }
    // [FUTURE: StreamEngine] Check if label matches a stream-capable pattern;
    // if so, return a StreamHandle instead of null.
    return null; // stub — StreamEngine returns StreamHandle here
  }

  // ── Chunk routing ─────────────────────────────────────────────────────────
  // [FUTURE: StreamEngine] Route a file through the byte-range chunker.
  // Today: returns null (caller falls back to full-file read).
  // Future: returns AsyncIterable<Uint8Array> chunks.
  function createChunkReader(file, opts) {
    opts = opts || {};
    // [FUTURE: StreamEngine] if file.size > opts.threshold and OPFS available,
    // return an OPFS-backed byte-range reader with adaptive chunk sizing.
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('stream:chunk-read-stub', { size: file && file.size }); } catch (_) {}
    }
    return null; // stub
  }

  // ── Partial processing hook ───────────────────────────────────────────────
  // [FUTURE: StreamEngine] Called when a tool can process page-by-page.
  // Today: runs fn(entireFile) synchronously.
  // Future: runs fn(chunk) for each chunk, aggregating results.
  async function processPartial(file, fn, opts) {
    opts = opts || {};
    // [FUTURE: StreamEngine] Detect page boundaries in PDF stream and call
    // fn() per-page chunk, reporting progress via RuntimeProgress.
    markFullLoad('process-partial:' + (opts.label || 'unknown'), { size: file && file.size });
    return fn(file); // today: full file
  }

  // ── Incremental render hook ───────────────────────────────────────────────
  // [FUTURE: StreamEngine] Called by PDF preview to render pages incrementally.
  // Today: calls fn(pages) with all pages at once.
  // Future: calls fn(page) per page as they arrive from the stream.
  async function renderIncremental(pages, fn, opts) {
    opts = opts || {};
    // [FUTURE: StreamEngine] Wrap pages in an async iterator that yields
    // one page at a time from an OPFS-backed rolling window.
    return fn(pages); // today: all pages at once
  }

  // ── Chunk telemetry hook ──────────────────────────────────────────────────
  // Records chunk metadata for future streaming performance analysis.
  function recordChunk(label, chunkIndex, chunkBytes, totalBytes) {
    if (window.RuntimeTelemetry) {
      try {
        window.RuntimeTelemetry.record('stream:chunk', {
          label: label, chunk: chunkIndex,
          bytes: chunkBytes, total: totalBytes,
          pct:   totalBytes > 0 ? Math.round(chunkBytes / totalBytes * 100) : 0,
        });
      } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try {
        window.RuntimeEventBus.emit('stream:chunk', {
          label: label, chunkIndex: chunkIndex, chunkBytes: chunkBytes, totalBytes: totalBytes,
        });
      } catch (_) {}
    }
  }

  // ── Stream-aware scheduling ───────────────────────────────────────────────
  // [FUTURE: StreamEngine] A stream-aware task will acquire a slot per chunk,
  // releasing between chunks to let other tasks interleave.
  // Today: runs the full task as a single slot.
  function scheduleStreamable(fn, opts) {
    opts = opts || {};
    // [FUTURE: StreamEngine] Wrap fn in a chunk-interleaved scheduler that
    // yields control between page chunks.
    if (window.RuntimeScheduler) {
      return window.RuntimeScheduler.run(fn, {
        type:     opts.type || 'render',
        priority: opts.priority || 'normal',
        label:    opts.label || 'streamable',
        token:    opts.token,
      });
    }
    return fn(function () {});
  }

  // ── OPFS readiness check ──────────────────────────────────────────────────
  // [FUTURE: StreamEngine] Gate: only use OPFS streaming when storage quota
  // allows and the file exceeds the minimum streaming threshold.
  var STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

  async function shouldStream(file) {
    if (!file || file.size < STREAM_THRESHOLD_BYTES) return false;
    var caps = window.P1 ? window.P1.capabilities() : {};
    if (!caps.opfs) return false;
    // [FUTURE: StreamEngine] Check OPFS quota here
    return false; // always false until StreamEngine is implemented
  }

  // ── IndexedDB readiness check ─────────────────────────────────────────────
  // [FUTURE: IDBCache] Gate for result caching in IndexedDB.
  function canUseIDB() {
    var caps = window.P1 ? window.P1.capabilities() : {};
    return !!caps.idb;
    // [FUTURE: IDBCache] Also check if idb-cache.js is loaded
  }

  // ── Stream capability probe ───────────────────────────────────────────────
  function getCapabilities() {
    var caps = window.P1 ? window.P1.capabilities() : {};
    return {
      opfsAvailable:      !!caps.opfs,
      idbAvailable:       !!caps.idb,
      streamEngineActive: false, // set to true when StreamEngine lands
      streamThresholdMB:  Math.round(STREAM_THRESHOLD_BYTES / 1024 / 1024),
      markerCount:        _markers.length,
    };
  }

  // ── Expose markers to P1 ──────────────────────────────────────────────────
  // P1.getStreamMarkers() remains the authoritative list; we extend it.
  var _origGetMarkers = window.P1 && window.P1.getStreamMarkers ? window.P1.getStreamMarkers : null;
  if (window.P1) {
    window.P1.getStreamMarkers = function () {
      var base = _origGetMarkers ? _origGetMarkers() : [];
      return base.concat(_markers);
    };
  }

  window.RuntimeStreaming = {
    markFullLoad:        markFullLoad,
    createChunkReader:   createChunkReader,
    processPartial:      processPartial,
    renderIncremental:   renderIncremental,
    recordChunk:         recordChunk,
    scheduleStreamable:  scheduleStreamable,
    shouldStream:        shouldStream,
    canUseIDB:           canUseIDB,
    getCapabilities:     getCapabilities,
    getMarkers:          function () { return _markers.slice(); },
  };

  console.debug('[RuntimeStreaming] ready — T034 streaming hooks active (StreamEngine: pending)');
}());
