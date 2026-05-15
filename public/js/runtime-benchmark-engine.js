// RuntimeBenchmarkEngine v1.0 — Phase 8A
// =====================================================================
// Real, measured throughput benchmarks. Every number here is a real
// timing or throughput measurement — no fakes, no stubs.
//
// Benchmarks:
//   workerSpawn    — spawn + round-trip a Web Worker, measure ms
//   opfsWrite      — write 1 MB to OPFS, measure MB/s
//   opfsRead       — read 1 MB from OPFS, measure MB/s
//   idbLatency     — put + get 64 KB in IndexedDB, measure ms
//   streamPipeline — stream 4 MB through ReadableStream, measure MB/s
//   aiLatency      — time a real AI task (heuristic fallback minimum)
//   memory         — heap snapshot delta around a 2 MB allocation
//   chunkPipeline  — adaptive pipeline chunk-size negotiation latency
//   pdfThroughput  — computed from recent telemetry span log
//
// All results persisted to IndexedDB (store: 'benchmark_results').
// Old results evicted when more than MAX_STORED snapshots exist.
//
// Expose: window.RuntimeBenchmark
//   .runAll(opts?)           → Promise<BenchmarkReport>
//   .run(name, opts?)        → Promise<SingleResult>
//   .report()                → last BenchmarkReport (or null)
//   .compareSnapshots(a, b)  → DeltaReport
//   .history()               → last 10 stored reports from IDB
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeBenchmark) return;

  var LOG = '[BM8A]';
  var DB_NAME    = 'ilovepdf-rt';
  var DB_STORE   = 'benchmark_results';
  var DB_VERSION = 2;       // bump from 1 to add new store
  var MAX_STORED = 10;

  // ── Lazy IDB handle ────────────────────────────────────────────────────────
  var _db = null;
  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function (ev) { _db = ev.target.result; resolve(_db); };
      req.onerror   = function ()   { reject(new Error('BM: IDB open failed')); };
    });
  }

  function _idbPut(store, record) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([store], 'readwrite');
        var req = tx.objectStore(store).put(record);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function _idbGetAll(store) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([store], 'readonly');
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  // ── Timing helpers ────────────────────────────────────────────────────────
  function _now() { return performance.now(); }
  function _elapsed(start) { return Math.round((_now() - start) * 100) / 100; }

  // ── 1. Worker spawn + round-trip ──────────────────────────────────────────
  function _benchWorkerSpawn() {
    return new Promise(function (resolve) {
      var t0 = _now();
      var blob = new Blob([
        'self.onmessage=function(e){self.postMessage({pong:true,ts:e.data.ts})}'
      ], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      var w   = new Worker(url);

      var spawnMs = _elapsed(t0);
      var pingTs  = _now();

      w.onmessage = function (ev) {
        var roundTripMs = _elapsed(pingTs);
        w.terminate();
        URL.revokeObjectURL(url);
        resolve({
          name:        'workerSpawn',
          spawnMs:     spawnMs,
          roundTripMs: roundTripMs,
          totalMs:     _elapsed(t0),
          ok:          ev.data && ev.data.pong === true,
        });
      };
      w.onerror = function () {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve({ name: 'workerSpawn', ok: false, error: 'worker-error', spawnMs: spawnMs });
      };
      w.postMessage({ ts: Date.now() });
    });
  }

  // ── 2. OPFS write + read ──────────────────────────────────────────────────
  function _benchOpfs() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return Promise.resolve({ name: 'opfs', ok: false, error: 'opfs-unavailable' });
    }

    var SIZE = 1 * 1024 * 1024; // 1 MB
    var data = new Uint8Array(SIZE);
    for (var i = 0; i < SIZE; i++) data[i] = i & 0xFF;

    var writeMs = 0, readMs = 0;

    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle('__bm_test__.bin', { create: true });
    }).then(function (fh) {
      var t0 = _now();
      return fh.createWritable().then(function (ws) {
        return ws.write(data.buffer).then(function () {
          return ws.close();
        });
      }).then(function () {
        writeMs = _elapsed(t0);
        return fh.getFile();
      }).then(function (file) {
        var tr = _now();
        return file.arrayBuffer().then(function (buf) {
          readMs = _elapsed(tr);
          return buf;
        });
      }).then(function (buf) {
        // cleanup
        return navigator.storage.getDirectory().then(function (root) {
          return root.removeEntry('__bm_test__.bin').catch(function () {});
        }).then(function () {
          return {
            name:        'opfs',
            ok:          buf.byteLength === SIZE,
            sizeBytes:   SIZE,
            writeMbps:   Math.round((SIZE / 1024 / 1024) / (writeMs / 1000) * 10) / 10,
            readMbps:    Math.round((SIZE / 1024 / 1024) / (readMs / 1000) * 10) / 10,
            writeMs:     writeMs,
            readMs:      readMs,
          };
        });
      });
    }).catch(function (err) {
      return { name: 'opfs', ok: false, error: err.message };
    });
  }

  // ── 3. IDB latency ────────────────────────────────────────────────────────
  function _benchIdb() {
    var SIZE  = 64 * 1024; // 64 KB
    var value = new Uint8Array(SIZE);
    for (var i = 0; i < SIZE; i++) value[i] = i & 0xFF;

    return _openDb().then(function (db) {
      var t0  = _now();
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([DB_STORE], 'readwrite');
        var os  = tx.objectStore(DB_STORE);
        var rec = { ts: Date.now(), type: '__bm__', payload: value.buffer };
        var rp  = os.put(rec);
        rp.onsuccess = function (e) {
          var putMs = _elapsed(t0);
          var id    = e.target.result;
          var tg    = _now();
          var rg    = os.get(id);
          rg.onsuccess = function () {
            var getMs = _elapsed(tg);
            // cleanup
            os.delete(id);
            resolve({
              name:    'idbLatency',
              ok:      true,
              putMs:   putMs,
              getMs:   getMs,
              sizeKB:  SIZE / 1024,
            });
          };
          rg.onerror = function () { reject(rg.error); };
        };
        rp.onerror = function () { reject(rp.error); };
      });
    }).catch(function (err) {
      return { name: 'idbLatency', ok: false, error: err.message };
    });
  }

  // ── 4. ReadableStream pipeline throughput ─────────────────────────────────
  function _benchStream() {
    var SIZE    = 4 * 1024 * 1024; // 4 MB total
    var CHUNK   = 256 * 1024;      // 256 KB chunks
    var chunks  = Math.ceil(SIZE / CHUNK);
    var bytes   = 0;
    var t0      = _now();

    return new Promise(function (resolve) {
      var rs = new ReadableStream({
        pull: function (ctrl) {
          if (bytes >= SIZE) { ctrl.close(); return; }
          var remaining = Math.min(CHUNK, SIZE - bytes);
          var ab = new ArrayBuffer(remaining);
          bytes += remaining;
          ctrl.enqueue(new Uint8Array(ab));
        }
      });

      var reader  = rs.getReader();
      var totalRead = 0;

      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var ms    = _elapsed(t0);
            var mbps  = Math.round((SIZE / 1024 / 1024) / (ms / 1000) * 10) / 10;
            resolve({
              name:      'streamPipeline',
              ok:        totalRead === SIZE,
              sizeBytes: SIZE,
              chunkSz:   CHUNK,
              chunks:    chunks,
              totalMs:   ms,
              throughputMbps: mbps,
            });
            return;
          }
          if (res.value) totalRead += res.value.byteLength;
          return pump();
        });
      }
      pump().catch(function (err) {
        resolve({ name: 'streamPipeline', ok: false, error: err.message });
      });
    });
  }

  // ── 5. AI latency ─────────────────────────────────────────────────────────
  function _benchAi() {
    var text = 'The performance benchmark system measures real throughput. ' +
               'It uses actual browser APIs to gather timing data. ' +
               'Results are stored in IndexedDB for historical comparison.';

    var t0   = _now();
    var aorc = global.RuntimeAIOrchestrator;
    if (!aorc) {
      return Promise.resolve({ name: 'aiLatency', ok: false, error: 'no-orchestrator' });
    }
    return aorc.runAiTask('summarize', { text: text }).then(function (res) {
      return {
        name:       'aiLatency',
        ok:         !!(res && res.result),
        durationMs: _elapsed(t0),
        provider:   (res && res.provider) || 'unknown',
        chars:      text.length,
      };
    }).catch(function (err) {
      return { name: 'aiLatency', ok: false, error: err.message, durationMs: _elapsed(t0) };
    });
  }

  // ── 6. Memory allocation delta ────────────────────────────────────────────
  function _benchMemory() {
    var before = 0, after = 0, delta = 0;
    try {
      var m = performance.memory;
      if (!m) return Promise.resolve({ name: 'memory', ok: false, error: 'performance.memory unavailable' });
      before = m.usedJSHeapSize;
      // Allocate 2 MB and hold reference briefly
      var arr = new Uint8Array(2 * 1024 * 1024);
      arr[0] = 1; // prevent dead-code elimination
      after = m.usedJSHeapSize;
      delta = after - before;
      arr = null; // release
    } catch (e) {
      return Promise.resolve({ name: 'memory', ok: false, error: e.message });
    }
    return Promise.resolve({
      name:       'memory',
      ok:         true,
      beforeMB:   Math.round(before / 1024 / 1024 * 10) / 10,
      afterMB:    Math.round(after  / 1024 / 1024 * 10) / 10,
      deltaMB:    Math.round(delta  / 1024 / 1024 * 10) / 10,
      heapLimitMB: Math.round((performance.memory ? performance.memory.jsHeapSizeLimit : 0) / 1024 / 1024),
    });
  }

  // ── 7. Chunk pipeline negotiation latency ─────────────────────────────────
  function _benchChunkPipeline() {
    if (!global.RuntimeAdaptivePipeline) {
      return Promise.resolve({ name: 'chunkPipeline', ok: false, error: 'RuntimeAdaptivePipeline unavailable' });
    }
    var t0      = _now();
    var profile = global.RuntimeAdaptivePipeline.getProfile();
    var elapsed = _elapsed(t0);
    return Promise.resolve({
      name:        'chunkPipeline',
      ok:          true,
      negotiateMs: elapsed,
      chunkSzMB:   Math.round(profile.chunkSz / 1024 / 1024 * 10) / 10,
      batchSz:     profile.batchSz,
      concurrency: profile.concurrency,
      tier:        profile.tier,
      deviceTier:  profile.deviceTier,
    });
  }

  // ── 8. PDF throughput estimate from telemetry ─────────────────────────────
  function _benchPdfThroughput() {
    if (!global.RuntimeTelemetry) {
      return Promise.resolve({ name: 'pdfThroughput', ok: false, error: 'no-telemetry' });
    }
    var spans   = global.RuntimeTelemetry.getSpanLog(100);
    var pdfSpans = spans.filter(function (s) {
      return s.name && (s.name.indexOf(':file-read') !== -1 || s.name.indexOf('pdf') !== -1) &&
             s.durationMs > 0;
    });
    if (!pdfSpans.length) {
      return Promise.resolve({ name: 'pdfThroughput', ok: false, error: 'no-pdf-spans-yet', note: 'process a PDF first' });
    }
    var total  = pdfSpans.reduce(function (a, s) { return a + s.durationMs; }, 0);
    var avgMs  = Math.round(total / pdfSpans.length);
    return Promise.resolve({
      name:     'pdfThroughput',
      ok:       true,
      samples:  pdfSpans.length,
      avgMs:    avgMs,
      note:     'from telemetry span log — process a file for real data',
    });
  }

  // ── Run all benchmarks ────────────────────────────────────────────────────
  var _lastReport = null;

  function runAll(opts) {
    opts = opts || {};
    var skip = opts.skip || [];
    var ALL  = [
      { name: 'workerSpawn',    fn: _benchWorkerSpawn    },
      { name: 'opfs',           fn: _benchOpfs           },
      { name: 'idbLatency',     fn: _benchIdb            },
      { name: 'streamPipeline', fn: _benchStream         },
      { name: 'aiLatency',      fn: _benchAi             },
      { name: 'memory',         fn: _benchMemory         },
      { name: 'chunkPipeline',  fn: _benchChunkPipeline  },
      { name: 'pdfThroughput',  fn: _benchPdfThroughput  },
    ];
    var tasks = ALL.filter(function (b) { return skip.indexOf(b.name) === -1; });
    var t0    = _now();

    console.info(LOG, 'Running', tasks.length, 'benchmarks…');

    return Promise.all(tasks.map(function (b) {
      return b.fn().catch(function (err) {
        return { name: b.name, ok: false, error: err.message };
      });
    })).then(function (results) {
      var report = {
        ts:         Date.now(),
        totalMs:    _elapsed(t0),
        browserUA:  navigator.userAgent.slice(0, 80),
        results:    results,
      };
      _lastReport = report;

      // Persist to IDB
      return _persistReport(report).then(function () { return report; })
             .catch(function () { return report; });
    });
  }

  function run(name, opts) {
    var MAP = {
      workerSpawn:    _benchWorkerSpawn,
      opfs:           _benchOpfs,
      idbLatency:     _benchIdb,
      streamPipeline: _benchStream,
      aiLatency:      _benchAi,
      memory:         _benchMemory,
      chunkPipeline:  _benchChunkPipeline,
      pdfThroughput:  _benchPdfThroughput,
    };
    var fn = MAP[name];
    if (!fn) return Promise.reject(new Error('Unknown benchmark: ' + name));
    return fn(opts);
  }

  function report() { return _lastReport; }

  function compareSnapshots(a, b) {
    if (!a || !b) return null;
    var delta = {};
    var aMap  = {};
    (a.results || []).forEach(function (r) { aMap[r.name] = r; });
    (b.results || []).forEach(function (r) {
      var old = aMap[r.name];
      if (!old) return;
      delta[r.name] = {};
      ['spawnMs','roundTripMs','writeMs','readMs','putMs','getMs','durationMs','negotiateMs','avgMs','totalMs','throughputMbps','writeMbps','readMbps'].forEach(function (k) {
        if (r[k] !== undefined && old[k] !== undefined) {
          var diff = Math.round((r[k] - old[k]) * 10) / 10;
          var pct  = old[k] !== 0 ? Math.round(diff / old[k] * 1000) / 10 : 0;
          delta[r.name][k] = { before: old[k], after: r[k], diff: diff, pctChange: pct };
        }
      });
    });
    return {
      aTs:       a.ts,
      bTs:       b.ts,
      intervalMs: b.ts - a.ts,
      delta:     delta,
    };
  }

  function history() {
    return _openDb().then(function () {
      return _idbGetAll(DB_STORE);
    }).then(function (rows) {
      return rows.filter(function (r) { return r.type === '__bm_report__'; })
                 .sort(function (a, b) { return b.ts - a.ts; })
                 .slice(0, MAX_STORED);
    }).catch(function () { return []; });
  }

  function _persistReport(report) {
    return _idbGetAll(DB_STORE).then(function (rows) {
      var bmRows = rows.filter(function (r) { return r.type === '__bm_report__'; });
      // Evict oldest if too many
      var toDelete = bmRows.sort(function (a, b) { return a.ts - b.ts; })
                           .slice(0, Math.max(0, bmRows.length - MAX_STORED + 1));
      return _openDb().then(function (db) {
        var tx = db.transaction([DB_STORE], 'readwrite');
        var os = tx.objectStore(DB_STORE);
        toDelete.forEach(function (r) { try { os.delete(r.id); } catch (_) {} });
        return new Promise(function (res, rej) {
          var pr = os.put(Object.assign({ type: '__bm_report__' }, report));
          pr.onsuccess = function () { res(); };
          pr.onerror   = function () { rej(pr.error); };
        });
      });
    });
  }

  // ── Wire into RT ──────────────────────────────────────────────────────────
  function _wireCentralRuntime() {
    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('benchmark', global.RuntimeBenchmark); } catch (_) {}
    }
    // Also expose on RT.benchmark
    if (RT && !RT.benchmark) RT.benchmark = global.RuntimeBenchmark;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_wireCentralRuntime, 200);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_wireCentralRuntime, 200); }, { once: true });
  }

  global.RuntimeBenchmark = {
    runAll:           runAll,
    run:              run,
    report:           report,
    compareSnapshots: compareSnapshots,
    history:          history,
  };

  console.info(LOG, 'RuntimeBenchmarkEngine v1.0 ready — call RuntimeBenchmark.runAll() to benchmark');
}(window));
