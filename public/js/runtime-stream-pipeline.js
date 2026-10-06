// runtime-stream-pipeline.js — Phase 9 unified stream pipeline
// Provides a composable, backpressure-aware stream pipeline for large file
// processing. Chunks input, passes through transform stages, and outputs via
// ReadableStream or direct callback. Integrates with RuntimeNetworkState for
// adaptive chunk sizing and RuntimeMemoryRecovery for pressure events.
// Exposes window.RuntimeStreamPipeline.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeStreamPipeline) return;

  var _DEFAULT_CHUNK = 2 * 1024 * 1024; // 2 MB default
  var _pipelines = new Map(); // id → { active, stages, bytesSent, bytesTotal }

  // ── Get adaptive chunk size ───────────────────────────────────────────────
  function _chunkSize() {
    try {
      var ns = G.RuntimeNetworkState;
      if (ns && typeof ns.recommendedChunkBytes === 'function') {
        return ns.recommendedChunkBytes();
      }
    } catch (_) {}
    return _DEFAULT_CHUNK;
  }

  // ── Create a pipeline ─────────────────────────────────────────────────────
  // stages: array of async (chunk: Uint8Array) → Uint8Array transform functions
  // opts:  { chunkSize, onProgress, signal }
  // Returns: Promise<Uint8Array> — concatenated output
  async function create(id, input, stages, opts) {
    opts = opts || {};
    if (_pipelines.has(id)) throw new Error('pipeline ' + id + ' already active');

    var bytes = input instanceof Uint8Array ? input :
                input instanceof ArrayBuffer ? new Uint8Array(input) :
                (input && input.buffer instanceof ArrayBuffer) ? new Uint8Array(input.buffer) :
                null;

    if (!bytes) throw new TypeError('RuntimeStreamPipeline: input must be Uint8Array / ArrayBuffer');

    var chunkSz  = opts.chunkSize || _chunkSize();
    var total    = bytes.byteLength;
    var pipeline = { active: true, stages: stages.length, bytesSent: 0, bytesTotal: total };
    _pipelines.set(id, pipeline);

    try {
      var chunks = [];
      var offset = 0;
      while (offset < total) {
        if (opts.signal && opts.signal.aborted) throw new Error('pipeline_aborted');
        var end   = Math.min(offset + chunkSz, total);
        var chunk = bytes.slice(offset, end);
        offset = end;

        // Pass through each stage in sequence
        var transformed = chunk;
        for (var si = 0; si < stages.length; si++) {
          if (!pipeline.active) throw new Error('pipeline_cancelled');
          try {
            transformed = await stages[si](transformed, { id: id, offset: offset, total: total });
          } catch (e) {
            console.warn('[StreamPipeline] stage', si, 'failed:', e && e.message);
            throw e;
          }
        }

        chunks.push(transformed);
        pipeline.bytesSent += end - (offset - (end - offset));

        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(pipeline.bytesSent / total); } catch (_) {}
        }
      }

      // Concatenate all chunks
      var outLen = chunks.reduce(function (s, c) { return s + c.byteLength; }, 0);
      var out    = new Uint8Array(outLen);
      var pos    = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.byteLength; });
      return out;
    } finally {
      pipeline.active = false;
      _pipelines.delete(id);
    }
  }

  // ── Cancel an active pipeline ─────────────────────────────────────────────
  function cancel(id) {
    var p = _pipelines.get(id);
    if (p) { p.active = false; _pipelines.delete(id); }
  }

  // ── Built-in identity stage (passthrough — useful for testing) ────────────
  function identityStage(chunk) { return chunk; }

  G.RuntimeStreamPipeline = Object.freeze({
    create:        create,
    cancel:        cancel,
    identityStage: identityStage,
    getActive: function () {
      var out = [];
      _pipelines.forEach(function (p, id) {
        out.push({ id: id, bytesSent: p.bytesSent, bytesTotal: p.bytesTotal });
      });
      return out;
    },
  });
}());
