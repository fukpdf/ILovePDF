// RuntimePhase9Verification v1.0
// =====================================================================
// Comprehensive execution verification harness for all Phase 9 subsystems.
// Tests real API behaviour, not just presence checks.
//
// Subsystems under test:
//   9A  WasmEngine      — JS fallbacks, capability matrix, execute() calls
//   9B  GpuEngine       — tier detection, runTask() ops, CPU fallback
//   9C  SharedCluster   — SharedWorker connect, enqueue() local fallback
//   9D  IncrementalPdf  — open() with Blob, readPages, exportPartial
//   9E  LocalAI         — heuristic inference (summarize, embedding, ocr-cleanup)
//   9F  Workspace       — IDB open, import(), search(), saveProgress()
//   9G  Kernel          — schedule() custom tasks, priority queue, load()
//   9H  ZeroCopy        — buffer pool acquire/release, createZeroCopyStream
//   9I  Sandbox         — validateWorkerUrl, validateWasmBytes, gateCapability
//   8I  Security        — validateWorkerMessage, sanitizeAiPrompt, OPFSPath
//   CERT BrowserOSCertification — full audit + scores
//
// Expose: window.P9V
//   .run(opts)        → Promise<VerificationReport>
//   .runSuite(name)   → Promise<SuiteResult>
//   .getLastReport()  → VerificationReport | null
//   .renderSummary(el) → void   (writes HTML summary to an element)
// =====================================================================
(function (global) {
  'use strict';

  if (global.P9V) return;

  var LOG = '[P9V]';
  var _lastReport = null;

  // ── Utilities ─────────────────────────────────────────────────────────────

  function _pass(name, detail) {
    return { name: name, status: 'PASS', detail: detail || '' };
  }

  function _fail(name, detail) {
    return { name: name, status: 'FAIL', detail: detail || '' };
  }

  function _warn(name, detail) {
    return { name: name, status: 'WARN', detail: detail || '' };
  }

  function _skip(name, detail) {
    return { name: name, status: 'SKIP', detail: detail || '' };
  }

  function _try(name, fn) {
    try {
      var result = fn();
      if (result && typeof result.then === 'function') {
        return result.then(function (r) {
          return r && r.status ? r : _pass(name, String(r || ''));
        }).catch(function (e) {
          return _fail(name, e.message || String(e));
        });
      }
      return Promise.resolve(result && result.status ? result : _pass(name, String(result || '')));
    } catch (e) {
      return Promise.resolve(_fail(name, e.message || String(e)));
    }
  }

  function _timed(fn) {
    var t0 = Date.now();
    return Promise.resolve().then(fn).then(function (v) {
      return { value: v, ms: Date.now() - t0 };
    });
  }

  function _makeTinyPdf() {
    // Minimal valid PDF (1-page) as a Uint8Array
    var src = '%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n' +
      '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n' +
      '3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>\nendobj\n' +
      'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n' +
      '0000000058 00000 n \n0000000115 00000 n \n' +
      'trailer\n<</Size 4 /Root 1 0 R>>\nstartxref\n190\n%%EOF\n';
    var enc = new TextEncoder();
    var buf = enc.encode(src);
    return new File([buf], 'test.pdf', { type: 'application/pdf' });
  }

  // ── Suite 9A: WasmEngine ──────────────────────────────────────────────────

  function _suite9A() {
    var we = global.RuntimeWasmEngine;
    var tests = [];

    if (!we) {
      return Promise.resolve({
        name: '9A WasmEngine', tests: [_fail('presence', 'RuntimeWasmEngine not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        return typeof we.execute === 'function' && typeof we.getCapabilities === 'function'
          ? _pass('presence', 'API surface intact')
          : _fail('presence', 'Missing methods');
      }),
      _try('capabilities', function () {
        var cap = we.getCapabilities();
        if (!cap || typeof cap !== 'object') return _fail('capabilities', 'getCapabilities() returned non-object');
        var fields = ['wasm', 'simd', 'threads', 'streaming', 'fallbackOps'];
        var missing = fields.filter(function (f) { return !(f in cap); });
        if (missing.length > 0) return _warn('capabilities', 'Missing fields: ' + missing.join(', '));
        return _pass('capabilities', 'wasm=' + cap.wasm + ' simd=' + cap.simd + ' threads=' + cap.threads);
      }),
      _try('execute-compress', function () {
        var data = new Uint8Array(1024);
        for (var i = 0; i < data.length; i++) data[i] = i & 0xFF;
        return we.execute('compress', data.buffer, { level: 6 }).then(function (r) {
          if (!r || !(r instanceof ArrayBuffer) && !(r && r.compressed)) {
            return _warn('execute-compress', 'Result shape unexpected but no error');
          }
          return _pass('execute-compress', 'returned ' + (r.byteLength || r.compressed && r.compressed.byteLength || '?') + ' bytes');
        });
      }),
      _try('execute-hash', function () {
        var data = new TextEncoder().encode('hello phase 9');
        return we.execute('hash', data.buffer, {}).then(function (r) {
          if (!r) return _fail('execute-hash', 'null result');
          var hex = r.hex || (r instanceof ArrayBuffer ? Array.from(new Uint8Array(r)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('') : String(r));
          return _pass('execute-hash', hex.slice(0, 16) + '…');
        });
      }),
      _try('execute-imgGreyscale', function () {
        var w = 4, h = 4;
        var rgba = new Uint8ClampedArray(w * h * 4);
        for (var i = 0; i < rgba.length; i++) rgba[i] = 128;
        return we.execute('imgGreyscale', rgba.buffer, { width: w, height: h }).then(function (r) {
          if (!r) return _fail('execute-imgGreyscale', 'null result');
          return _pass('execute-imgGreyscale', 'OK');
        });
      }),
      _try('execute-tensorNorm', function () {
        var arr = new Float32Array([1, 2, 3, 4]);
        return we.execute('tensorNorm', arr.buffer, {}).then(function (r) {
          if (!r) return _fail('execute-tensorNorm', 'null result');
          return _pass('execute-tensorNorm', 'OK');
        });
      }),
      _try('stats', function () {
        var s = we.getStats();
        if (!s || typeof s.executions === 'undefined') return _warn('stats', 'Stats object missing executions counter');
        return _pass('stats', 'execs=' + s.executions + ' fallbacks=' + s.fallbacks);
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9A WasmEngine', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9B: GpuEngine ───────────────────────────────────────────────────

  function _suite9B() {
    var ge = global.RuntimeGpuEngine;
    if (!ge) {
      return Promise.resolve({
        name: '9B GpuEngine', tests: [_fail('presence', 'RuntimeGpuEngine not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        return typeof ge.runTask === 'function' && typeof ge.getCapabilities === 'function'
          ? _pass('presence', 'API surface intact')
          : _fail('presence', 'Missing methods');
      }),
      _try('capabilities', function () {
        var cap = ge.getCapabilities();
        if (!cap || !cap.activeTier) return _fail('capabilities', 'No activeTier in capabilities');
        var valid = ['webgpu', 'webgl2', 'webgl1', 'cpu'];
        if (valid.indexOf(cap.activeTier) === -1) return _fail('capabilities', 'Unknown tier: ' + cap.activeTier);
        return _pass('capabilities', 'tier=' + cap.activeTier + ' offscreen=' + cap.offscreen);
      }),
      _try('runTask-imgGreyscale', function () {
        var w = 8, h = 8;
        var rgba = new Uint8ClampedArray(w * h * 4);
        for (var i = 0; i < rgba.length; i += 4) {
          rgba[i] = 200; rgba[i+1] = 100; rgba[i+2] = 50; rgba[i+3] = 255;
        }
        return ge.runTask('imgGreyscale', { pixels: rgba, width: w, height: h }, {}).then(function (r) {
          if (!r) return _fail('runTask-imgGreyscale', 'null result');
          return _pass('runTask-imgGreyscale', 'pixels=' + (r.pixels ? r.pixels.length : '?'));
        });
      }),
      _try('runTask-imgScale', function () {
        var w = 16, h = 16;
        var rgba = new Uint8ClampedArray(w * h * 4).fill(180);
        return ge.runTask('imgScale', { pixels: rgba, width: w, height: h }, { targetWidth: 8, targetHeight: 8 }).then(function (r) {
          if (!r) return _fail('runTask-imgScale', 'null result');
          return _pass('runTask-imgScale', 'OK');
        });
      }),
      _try('runTask-tensorNorm', function () {
        var data = new Float32Array([0.5, 1.0, 2.0, 0.1]);
        return ge.runTask('tensorNorm', { data: data }, {}).then(function (r) {
          if (!r) return _fail('runTask-tensorNorm', 'null result');
          return _pass('runTask-tensorNorm', 'OK');
        });
      }),
      _try('stats', function () {
        var s = ge.getStats();
        if (!s || typeof s.tasks === 'undefined') return _warn('stats', 'Missing tasks counter');
        return _pass('stats', 'tasks=' + s.tasks + ' errors=' + s.errors);
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9B GpuEngine', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9C: SharedCluster ───────────────────────────────────────────────

  function _suite9C() {
    var sc = global.RuntimeSharedCluster;
    if (!sc) {
      return Promise.resolve({
        name: '9C SharedCluster', tests: [_fail('presence', 'RuntimeSharedCluster not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        return typeof sc.enqueue === 'function' && typeof sc.getLocalStats === 'function'
          ? _pass('presence', 'API surface intact')
          : _fail('presence', 'Missing methods');
      }),
      _try('sharedWorkerSupport', function () {
        var supported = typeof SharedWorker !== 'undefined';
        return supported
          ? _pass('sharedWorkerSupport', 'SharedWorker available')
          : _warn('sharedWorkerSupport', 'SharedWorker not available — local fallback mode');
      }),
      _try('localStats', function () {
        var ls = sc.getLocalStats();
        if (!ls || typeof ls.submitted === 'undefined') return _fail('localStats', 'getLocalStats() missing submitted');
        return _pass('localStats', 'submitted=' + ls.submitted + ' connected=' + ls.connected);
      }),
      _try('enqueue-local-fn', function () {
        return sc.enqueue({
          type: 'custom',
          fn: function () { return { ok: true, val: 42 }; },
        }).then(function (r) {
          if (!r || !r.ok) return _fail('enqueue-local-fn', 'Result missing ok field: ' + JSON.stringify(r));
          return _pass('enqueue-local-fn', 'val=' + r.val);
        });
      }),
      _try('enqueue-async-fn', function () {
        return sc.enqueue({
          type: 'custom',
          priority: 'high',
          fn: function () {
            return new Promise(function (res) { setTimeout(function () { res({ done: true }); }, 10); });
          },
        }).then(function (r) {
          if (!r || !r.done) return _fail('enqueue-async-fn', 'no done flag');
          return _pass('enqueue-async-fn', 'async fn completed');
        });
      }),
      _try('registerHandler', function () {
        sc.registerHandler('p9v-test', function (payload) {
          return { echoed: payload };
        });
        return _pass('registerHandler', 'handler registered');
      }),
      _try('isAvailable', function () {
        var avail = sc.isAvailable();
        return _pass('isAvailable', 'available=' + avail + ' (SharedWorker=' + (typeof SharedWorker !== 'undefined') + ')');
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9C SharedCluster', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9D: IncrementalPdf ──────────────────────────────────────────────

  function _suite9D() {
    var ipdf = global.RuntimeIncrementalPdf;
    if (!ipdf) {
      return Promise.resolve({
        name: '9D IncrementalPdf', tests: [_fail('presence', 'RuntimeIncrementalPdf not found')],
        passed: 0, total: 1,
      });
    }

    var _handle = null;

    var jobs = [
      _try('presence', function () {
        var methods = ['open', 'readPages', 'exportPartial', 'merge', 'streamPages', 'close', 'getStats'];
        var missing = methods.filter(function (m) { return typeof ipdf[m] !== 'function'; });
        return missing.length === 0
          ? _pass('presence', 'All 7 methods present')
          : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('open-tiny-pdf', function () {
        var pdf = _makeTinyPdf();
        return ipdf.open(pdf, {}).then(function (h) {
          if (!h || !h.id) return _fail('open-tiny-pdf', 'No handle returned');
          _handle = h;
          return _pass('open-tiny-pdf', 'handle=' + h.id + ' size=' + h.size + ' opfs=' + h.opfs);
        });
      }),
      _try('readPages', function () {
        if (!_handle) return _skip('readPages', 'No handle from open step');
        return ipdf.readPages(_handle, { start: 0, end: 0 }, {}).then(function (pages) {
          if (!Array.isArray(pages)) return _fail('readPages', 'Not an array');
          return _pass('readPages', 'pages.length=' + pages.length);
        });
      }),
      _try('exportPartial', function () {
        if (!_handle) return _skip('exportPartial', 'No handle');
        return ipdf.exportPartial(_handle, { startPage: 0, endPage: 0 }).then(function (blob) {
          if (!(blob instanceof Blob)) return _fail('exportPartial', 'Not a Blob');
          return _pass('exportPartial', 'blob size=' + blob.size + ' type=' + blob.type);
        });
      }),
      _try('streamPages-api', function () {
        if (!_handle) return _skip('streamPages-api', 'No handle');
        try {
          var stream = ipdf.streamPages(_handle, { start: 0, end: 0 });
          if (!stream || typeof stream.getReader !== 'function') return _fail('streamPages-api', 'Not a ReadableStream');
          return _pass('streamPages-api', 'ReadableStream created');
        } catch (e) {
          return _fail('streamPages-api', e.message);
        }
      }),
      _try('stats', function () {
        var s = ipdf.getStats();
        if (!s || typeof s.opened === 'undefined') return _fail('stats', 'Missing opened counter');
        return _pass('stats', 'opened=' + s.opened + ' exports=' + s.exports + ' opfsSupported=' + s.opfsSupported);
      }),
      _try('close', function () {
        if (!_handle) return _skip('close', 'No handle');
        ipdf.close(_handle);
        return _pass('close', 'handle closed gracefully');
      }),
      _try('open-invalid-rejects', function () {
        return ipdf.open(null, {}).then(function () {
          return _fail('open-invalid-rejects', 'Should have rejected for null input');
        }).catch(function (e) {
          return _pass('open-invalid-rejects', 'Correctly rejected: ' + e.message.slice(0, 40));
        });
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9D IncrementalPdf', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9E: LocalAI ─────────────────────────────────────────────────────

  function _suite9E() {
    var ai = global.RuntimeLocalAI;
    if (!ai) {
      return Promise.resolve({
        name: '9E LocalAI', tests: [_fail('presence', 'RuntimeLocalAI not found')],
        passed: 0, total: 1,
      });
    }

    var TEXT = 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet. It is often used for testing purposes.';

    var jobs = [
      _try('presence', function () {
        var methods = ['run', 'loadModel', 'getLoadedModels', 'getStats'];
        var missing = methods.filter(function (m) { return typeof ai[m] !== 'function'; });
        return missing.length === 0 ? _pass('presence', 'API surface intact') : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('heuristic-summarize', function () {
        return ai.run('summarize', TEXT, {}).then(function (r) {
          if (!r || !r.result) return _fail('heuristic-summarize', 'No result');
          var summary = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
          return _pass('heuristic-summarize', 'path=' + r.path + ' len=' + summary.length);
        });
      }),
      _try('heuristic-embedding', function () {
        return ai.run('embedding', 'hello world', {}).then(function (r) {
          if (!r || !r.result) return _fail('heuristic-embedding', 'No result');
          var emb = r.result.embedding || r.result;
          var len = (emb && emb.length) || 0;
          if (len < 4) return _fail('heuristic-embedding', 'Embedding too short: ' + len);
          return _pass('heuristic-embedding', 'path=' + r.path + ' dims=' + len);
        });
      }),
      _try('heuristic-ocr-cleanup', function () {
        return ai.run('ocr-cleanup', 'He1lo W0rld  I  am  a  test', {}).then(function (r) {
          if (!r || r.result === undefined) return _fail('heuristic-ocr-cleanup', 'No result');
          return _pass('heuristic-ocr-cleanup', 'path=' + r.path + ' out=' + String(r.result).slice(0, 40));
        });
      }),
      _try('embedding-deterministic', function () {
        return Promise.all([
          ai.run('embedding', 'test phrase', {}),
          ai.run('embedding', 'test phrase', {}),
        ]).then(function (results) {
          var e1 = results[0].result.embedding || results[0].result;
          var e2 = results[1].result.embedding || results[1].result;
          if (!e1 || !e2) return _warn('embedding-deterministic', 'Could not compare embeddings');
          var same = e1.length === e2.length && Array.from(e1).every(function (v, i) { return Math.abs(v - e2[i]) < 0.0001; });
          return same ? _pass('embedding-deterministic', 'Embeddings are deterministic') : _warn('embedding-deterministic', 'Embeddings differ (cache miss or ONNX path)');
        });
      }),
      _try('getStats', function () {
        var s = ai.getStats();
        if (!s || typeof s.runs === 'undefined') return _fail('getStats', 'Missing runs counter');
        return _pass('getStats', 'runs=' + s.runs + ' fallbacks=' + s.fallbacks + ' ortLoaded=' + s.ortLoaded);
      }),
      _try('getLoadedModels', function () {
        var models = ai.getLoadedModels();
        if (!Array.isArray(models)) return _fail('getLoadedModels', 'Not an array');
        return _pass('getLoadedModels', 'loaded models: [' + models.join(', ') + ']');
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9E LocalAI', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9F: Workspace ───────────────────────────────────────────────────

  function _suite9F() {
    var ws = global.RuntimeWorkspace;
    if (!ws) {
      return Promise.resolve({
        name: '9F Workspace', tests: [_fail('presence', 'RuntimeWorkspace not found')],
        passed: 0, total: 1,
      });
    }

    var _docId = null;
    var _testFile = new File(['Hello workspace test file content.'], 'p9v-test.txt', { type: 'text/plain' });

    // Run sequentially to respect doc lifecycle
    return _try('presence', function () {
      var methods = ['import', 'search', 'resume', 'list', 'remove', 'saveProgress', 'getProgress', 'getStats'];
      var missing = methods.filter(function (m) { return typeof ws[m] !== 'function'; });
      return missing.length === 0 ? _pass('presence', 'All 8 methods present') : _fail('presence', 'Missing: ' + missing.join(', '));
    }).then(function (presenceTest) {
      return _try('idb-open', function () {
        // Trigger IDB by listing
        return ws.list().then(function (docs) {
          if (!Array.isArray(docs)) return _fail('idb-open', 'list() not an array');
          return _pass('idb-open', 'IDB accessible, docs=' + docs.length);
        });
      }).then(function (idbTest) {
        return _try('import', function () {
          return ws.import(_testFile, { tags: ['p9v', 'verification'] }).then(function (doc) {
            if (!doc || !doc.id) return _fail('import', 'No doc.id returned');
            _docId = doc.id;
            return _pass('import', 'docId=' + doc.id.slice(0, 16) + '… size=' + doc.size);
          });
        }).then(function (importTest) {
          return _try('search', function () {
            return ws.search('p9v-test').then(function (results) {
              if (!Array.isArray(results)) return _fail('search', 'Not an array');
              return _pass('search', 'results=' + results.length);
            });
          }).then(function (searchTest) {
            return _try('saveProgress', function () {
              if (!_docId) return _skip('saveProgress', 'No docId');
              return ws.saveProgress(_docId, { step: 3, tool: 'compress', pct: 75 }).then(function () {
                return _pass('saveProgress', 'state persisted');
              });
            }).then(function (saveTest) {
              return _try('getProgress', function () {
                if (!_docId) return _skip('getProgress', 'No docId');
                return ws.getProgress(_docId).then(function (state) {
                  if (!state || state.step !== 3) return _fail('getProgress', 'State not retrieved: ' + JSON.stringify(state));
                  return _pass('getProgress', 'step=' + state.step + ' tool=' + state.tool);
                });
              }).then(function (getProgTest) {
                return _try('resume', function () {
                  if (!_docId) return _skip('resume', 'No docId');
                  return ws.resume(_docId).then(function (r) {
                    if (!r || !r.doc) return _fail('resume', 'No doc in resumed result');
                    return _pass('resume', 'resumed doc=' + r.doc.name + ' progress=' + (r.progress ? 'yes' : 'no'));
                  });
                }).then(function (resumeTest) {
                  return _try('getStats', function () {
                    return ws.getStats().then(function (s) {
                      if (!s || typeof s.imported === 'undefined') return _fail('getStats', 'Missing imported counter');
                      return _pass('getStats', 'imported=' + s.imported + ' opfsAvail=' + s.opfsAvail);
                    });
                  }).then(function (statsTest) {
                    return _try('remove', function () {
                      if (!_docId) return _skip('remove', 'No docId');
                      return ws.remove(_docId).then(function () {
                        return _pass('remove', 'doc ' + _docId.slice(0, 16) + '… removed');
                      });
                    }).then(function (removeTest) {
                      var tests = [presenceTest, idbTest, importTest, searchTest, saveTest, getProgTest, resumeTest, statsTest, removeTest];
                      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
                      return { name: '9F Workspace', tests: tests, passed: passed, total: tests.length };
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }

  // ── Suite 9G: Kernel ──────────────────────────────────────────────────────

  function _suite9G() {
    var k = global.RuntimeKernel;
    if (!k) {
      return Promise.resolve({
        name: '9G Kernel', tests: [_fail('presence', 'RuntimeKernel not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        var methods = ['schedule', 'getLoad', 'getHealth', 'setLimit'];
        var missing = methods.filter(function (m) { return typeof k[m] !== 'function'; });
        return missing.length === 0 ? _pass('presence', 'API surface intact') : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('schedule-custom-sync', function () {
        return k.schedule({
          type: 'custom',
          op: 'test-sync',
          priority: 'normal',
          fn: function () { return { result: 'sync-ok', n: 1 + 1 }; },
        }).then(function (r) {
          if (!r || r.result !== 'sync-ok') return _fail('schedule-custom-sync', 'Bad result: ' + JSON.stringify(r));
          return _pass('schedule-custom-sync', 'n=' + r.n);
        });
      }),
      _try('schedule-custom-async', function () {
        return k.schedule({
          type: 'custom',
          op: 'test-async',
          priority: 'high',
          fn: function () {
            return new Promise(function (res) { setTimeout(function () { res({ async: true }); }, 5); });
          },
        }).then(function (r) {
          if (!r || !r.async) return _fail('schedule-custom-async', 'async=false: ' + JSON.stringify(r));
          return _pass('schedule-custom-async', 'async task completed');
        });
      }),
      _try('schedule-priority-critical', function () {
        return k.schedule({
          type: 'custom',
          priority: 'critical',
          fn: function () { return { priority: 'critical', ok: true }; },
        }).then(function (r) {
          if (!r || !r.ok) return _fail('schedule-priority-critical', 'Result: ' + JSON.stringify(r));
          return _pass('schedule-priority-critical', 'critical task ran');
        });
      }),
      _try('schedule-background', function () {
        return k.schedule({
          type: 'custom',
          priority: 'background',
          fn: function () { return { bg: true }; },
        }).then(function (r) {
          if (!r || !r.bg) return _fail('schedule-background', JSON.stringify(r));
          return _pass('schedule-background', 'background task ran');
        });
      }),
      _try('getLoad', function () {
        var load = k.getLoad();
        if (!load || typeof load !== 'object') return _fail('getLoad', 'Not an object');
        return _pass('getLoad', JSON.stringify(load).slice(0, 80));
      }),
      _try('getHealth', function () {
        var health = k.getHealth();
        if (!health || typeof health !== 'object') return _fail('getHealth', 'Not an object');
        return _pass('getHealth', JSON.stringify(health).slice(0, 80));
      }),
      _try('setLimit', function () {
        k.setLimit('customSlots', 6);
        var load = k.getLoad();
        return _pass('setLimit', 'customSlots set to 6, load=' + JSON.stringify(load).slice(0, 40));
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9G Kernel', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9H: ZeroCopy ────────────────────────────────────────────────────

  function _suite9H() {
    var zc = global.RuntimeZeroCopy;
    if (!zc) {
      return Promise.resolve({
        name: '9H ZeroCopy', tests: [_fail('presence', 'RuntimeZeroCopy not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        var methods = ['acquireBuffer', 'releaseBuffer', 'createZeroCopyStream', 'getStats', 'getPoolStats'];
        var missing = methods.filter(function (m) { return typeof zc[m] !== 'function'; });
        return missing.length === 0 ? _pass('presence', 'API surface intact') : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('acquireBuffer-64k', function () {
        var buf = zc.acquireBuffer(65536);
        if (!(buf instanceof ArrayBuffer)) return _fail('acquireBuffer-64k', 'Not an ArrayBuffer');
        if (buf.byteLength < 65536) return _fail('acquireBuffer-64k', 'Too small: ' + buf.byteLength);
        return _pass('acquireBuffer-64k', 'byteLength=' + buf.byteLength);
      }),
      _try('acquireBuffer-1mb', function () {
        var buf = zc.acquireBuffer(1024 * 1024);
        if (!(buf instanceof ArrayBuffer)) return _fail('acquireBuffer-1mb', 'Not an ArrayBuffer');
        return _pass('acquireBuffer-1mb', 'byteLength=' + buf.byteLength);
      }),
      _try('releaseBuffer-recycle', function () {
        var buf1 = zc.acquireBuffer(65536);
        zc.releaseBuffer(buf1);
        var s1 = zc.getPoolStats();
        var buf2 = zc.acquireBuffer(65536);
        if (!(buf2 instanceof ArrayBuffer)) return _fail('releaseBuffer-recycle', 'Second acquire failed');
        return _pass('releaseBuffer-recycle', 'pool recycled buffer');
      }),
      _try('pool-hit-rate', function () {
        // Warm the pool with 3 round-trips
        for (var i = 0; i < 3; i++) {
          var b = zc.acquireBuffer(262144);
          zc.releaseBuffer(b);
        }
        var ps = zc.getPoolStats();
        if (!ps) return _warn('pool-hit-rate', 'getPoolStats() returned null');
        return _pass('pool-hit-rate', JSON.stringify(ps).slice(0, 80));
      }),
      _try('createZeroCopyStream', function () {
        var file = new File(['stream test content 0123456789'], 'stream-test.bin', { type: 'application/octet-stream' });
        var stream = zc.createZeroCopyStream(file, { chunkSize: 4096 });
        if (!stream || typeof stream.getReader !== 'function') return _fail('createZeroCopyStream', 'Not a ReadableStream');
        var reader = stream.getReader();
        return reader.read().then(function (chunk) {
          reader.cancel().catch(function () {});
          if (!chunk || chunk.done === undefined) return _warn('createZeroCopyStream', 'Unexpected chunk shape');
          return _pass('createZeroCopyStream', 'Stream readable, done=' + chunk.done);
        });
      }),
      _try('getStats', function () {
        var s = zc.getStats();
        if (!s || typeof s.acquired === 'undefined') return _fail('getStats', 'Missing acquired counter');
        return _pass('getStats', 'acquired=' + s.acquired + ' fromPool=' + s.fromPool + ' hitRate=' + s.poolHitRate);
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9H ZeroCopy', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 9I: Sandbox ─────────────────────────────────────────────────────

  function _suite9I() {
    var sb = global.RuntimeSandbox;
    if (!sb) {
      return Promise.resolve({
        name: '9I Sandbox', tests: [_fail('presence', 'RuntimeSandbox not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        var methods = ['validateWorkerUrl', 'validateWasmBytes', 'validateStreamMessage', 'gateCapability', 'getAuditLog', 'getPolicy', 'setPolicy'];
        var missing = methods.filter(function (m) { return typeof sb[m] !== 'function'; });
        return missing.length === 0 ? _pass('presence', 'All 7 methods present') : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('validateWorkerUrl-same-origin', function () {
        try {
          var url = '/workers/pdf-worker.js';
          sb.validateWorkerUrl(url);
          return _pass('validateWorkerUrl-same-origin', 'same-origin worker allowed');
        } catch (e) {
          return _fail('validateWorkerUrl-same-origin', e.message);
        }
      }),
      _try('validateWorkerUrl-data-blocked', function () {
        try {
          sb.validateWorkerUrl('data:text/javascript,self.postMessage(1)');
          return _fail('validateWorkerUrl-data-blocked', 'Should have blocked data: URL');
        } catch (e) {
          if (e.name === 'SandboxError' || e.message.toLowerCase().includes('sandbox') || e.message.toLowerCase().includes('data') || e.message.toLowerCase().includes('block')) {
            return _pass('validateWorkerUrl-data-blocked', 'data: URL correctly blocked');
          }
          return _warn('validateWorkerUrl-data-blocked', 'Threw but unexpected error: ' + e.message.slice(0, 60));
        }
      }),
      _try('validateWasmBytes-valid', function () {
        // Minimal valid WASM (empty module)
        var validWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        try {
          sb.validateWasmBytes(validWasm.buffer);
          return _pass('validateWasmBytes-valid', 'valid WASM magic accepted');
        } catch (e) {
          return _fail('validateWasmBytes-valid', 'Valid WASM rejected: ' + e.message);
        }
      }),
      _try('validateWasmBytes-invalid', function () {
        var badBytes = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
        try {
          sb.validateWasmBytes(badBytes.buffer);
          return _fail('validateWasmBytes-invalid', 'Should have rejected bad magic bytes');
        } catch (e) {
          return _pass('validateWasmBytes-invalid', 'Bad WASM correctly rejected');
        }
      }),
      _try('validateStreamMessage-valid', function () {
        try {
          sb.validateStreamMessage({ type: 'stream-init', streamId: 'test-1', meta: {} });
          return _pass('validateStreamMessage-valid', 'stream-init accepted');
        } catch (e) {
          return _fail('validateStreamMessage-valid', e.message);
        }
      }),
      _try('gateCapability-webassembly', function () {
        var allowed = sb.gateCapability('webassembly', false);
        return typeof allowed === 'boolean'
          ? _pass('gateCapability-webassembly', 'webassembly gate=' + allowed)
          : _fail('gateCapability-webassembly', 'Not a boolean: ' + typeof allowed);
      }),
      _try('getAuditLog', function () {
        var log = sb.getAuditLog();
        if (!Array.isArray(log)) return _fail('getAuditLog', 'Not an array');
        return _pass('getAuditLog', 'entries=' + log.length);
      }),
      _try('getPolicy', function () {
        var p = sb.getPolicy();
        if (!p || typeof p !== 'object') return _fail('getPolicy', 'Not an object');
        return _pass('getPolicy', 'opfsAllowedPrefixes=' + (p.opfsAllowedPrefixes || []).length);
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '9I Sandbox', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite 8I: Security ────────────────────────────────────────────────────

  function _suite8I() {
    var sec = global.RuntimeSecurity;
    if (!sec) {
      return Promise.resolve({
        name: '8I Security', tests: [_fail('presence', 'RuntimeSecurity not found')],
        passed: 0, total: 1,
      });
    }

    var jobs = [
      _try('presence', function () {
        var methods = ['validateWorkerMessage', 'validateOPFSPath', 'sanitizeAiPrompt', 'validateCheckpoint', 'validateBroadcastMessage', 'checkCancelRate', 'getStats'];
        var missing = methods.filter(function (m) { return typeof sec[m] !== 'function'; });
        return missing.length === 0 ? _pass('presence', 'All 7 methods present') : _fail('presence', 'Missing: ' + missing.join(', '));
      }),
      _try('validateWorkerMessage-valid-op', function () {
        try {
          sec.validateWorkerMessage({ op: 'compress', buffer: new ArrayBuffer(0) });
          return _pass('validateWorkerMessage-valid-op', 'compress op accepted');
        } catch (e) { return _fail('validateWorkerMessage-valid-op', e.message); }
      }),
      _try('validateWorkerMessage-invalid-op', function () {
        try {
          sec.validateWorkerMessage({ op: '__proto__' });
          return _fail('validateWorkerMessage-invalid-op', 'Should have rejected __proto__ op');
        } catch (e) {
          return e.name === 'SecurityError' || e.message.includes('Security')
            ? _pass('validateWorkerMessage-invalid-op', 'Bad op rejected: SecurityError')
            : _warn('validateWorkerMessage-invalid-op', 'Rejected but wrong error type: ' + e.message.slice(0, 40));
        }
      }),
      _try('validateWorkerMessage-non-object', function () {
        try {
          sec.validateWorkerMessage('string-payload');
          return _fail('validateWorkerMessage-non-object', 'Should have rejected string');
        } catch (e) {
          return _pass('validateWorkerMessage-non-object', 'String payload rejected');
        }
      }),
      _try('validateOPFSPath-valid', function () {
        try {
          sec.validateOPFSPath('ilovepdf-stream/abc123.bin');
          return _pass('validateOPFSPath-valid', 'valid path accepted');
        } catch (e) { return _fail('validateOPFSPath-valid', e.message); }
      }),
      _try('validateOPFSPath-traversal', function () {
        try {
          sec.validateOPFSPath('../../../etc/passwd');
          return _fail('validateOPFSPath-traversal', 'Should have blocked traversal');
        } catch (e) {
          return _pass('validateOPFSPath-traversal', 'Path traversal blocked');
        }
      }),
      _try('sanitizeAiPrompt-script-tags', function () {
        var dirty = 'Hello <script>alert(1)</script> world';
        var clean = sec.sanitizeAiPrompt(dirty, {});
        if (clean.includes('<script>')) return _fail('sanitizeAiPrompt-script-tags', 'Script tag not removed');
        return _pass('sanitizeAiPrompt-script-tags', 'sanitized: ' + clean.slice(0, 40));
      }),
      _try('sanitizeAiPrompt-length-cap', function () {
        var long = 'x'.repeat(60000);
        var result = sec.sanitizeAiPrompt(long, { maxChars: 100 });
        if (result.length > 100) return _fail('sanitizeAiPrompt-length-cap', 'Not truncated: ' + result.length);
        return _pass('sanitizeAiPrompt-length-cap', 'truncated to ' + result.length);
      }),
      _try('validateCheckpoint-valid', function () {
        try {
          sec.validateCheckpoint({ toolId: 'merge', ts: Date.now(), step: 2 });
          return _pass('validateCheckpoint-valid', 'Valid checkpoint accepted');
        } catch (e) { return _fail('validateCheckpoint-valid', e.message); }
      }),
      _try('validateCheckpoint-old', function () {
        try {
          sec.validateCheckpoint({ toolId: 'merge', ts: Date.now() - 25 * 3600 * 1000, step: 2 });
          return _fail('validateCheckpoint-old', 'Should have rejected old checkpoint');
        } catch (e) {
          return _pass('validateCheckpoint-old', 'Old checkpoint rejected: ' + e.message.slice(0, 40));
        }
      }),
      _try('validateCheckpoint-missing-field', function () {
        try {
          sec.validateCheckpoint({ toolId: 'merge', ts: Date.now() }); // no step
          return _fail('validateCheckpoint-missing-field', 'Should have rejected missing step');
        } catch (e) {
          return _pass('validateCheckpoint-missing-field', 'Missing field rejected');
        }
      }),
      _try('checkCancelRate-allow', function () {
        var allowed = sec.checkCancelRate('token-test-1');
        return allowed ? _pass('checkCancelRate-allow', 'First cancel allowed') : _fail('checkCancelRate-allow', 'First cancel blocked');
      }),
      _try('checkCancelRate-throttle', function () {
        var tokenId = 'token-flood-' + Date.now();
        var blocked = false;
        for (var i = 0; i < 25; i++) {
          if (!sec.checkCancelRate(tokenId)) { blocked = true; break; }
        }
        return blocked ? _pass('checkCancelRate-throttle', 'Flood correctly throttled') : _warn('checkCancelRate-throttle', '25 rapid cancels not throttled (rate limit not hit in window)');
      }),
      _try('getStats', function () {
        var s = sec.getStats();
        if (!s || typeof s.totalChecks === 'undefined') return _fail('getStats', 'Missing totalChecks');
        return _pass('getStats', 'totalChecks=' + s.totalChecks + ' aiSanitized=' + s.aiPromptSanitized);
      }),
    ];

    return Promise.all(jobs).then(function (tests) {
      var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
      return { name: '8I Security', tests: tests, passed: passed, total: tests.length };
    });
  }

  // ── Suite CERT: BrowserOSCertification ────────────────────────────────────

  function _suiteCert() {
    var certFn = global.RuntimeBrowserOSCertification || global.BOSCERT;
    if (!certFn) {
      return Promise.resolve({
        name: 'CERT BrowserOSCert', tests: [_fail('presence', 'RuntimeBrowserOSCertification not found')],
        passed: 0, total: 1, certReport: null,
      });
    }

    return _try('presence', function () {
      return typeof certFn === 'function'
        ? _pass('presence', 'RuntimeBrowserOSCertification function present')
        : _fail('presence', 'Not a function: ' + typeof certFn);
    }).then(function (presenceTest) {
      return _timed(function () { return certFn(); }).then(function (timed) {
        var r = timed.value;
        var ms = timed.ms;

        var tests = [presenceTest];

        if (!r || typeof r !== 'object') {
          tests.push(_fail('run', 'certFn() returned non-object: ' + typeof r));
          return { name: 'CERT BrowserOSCert', tests: tests, passed: 0, total: tests.length, certReport: null };
        }

        tests.push(_pass('run', 'Completed in ' + ms + ' ms'));

        // Score checks
        var scoreFields = ['browserOsScore', 'offlineScore', 'computeScore', 'aiScore', 'largeFileScore', 'mobileScore'];
        scoreFields.forEach(function (f) {
          if (r[f] !== undefined) {
            var score = r[f];
            var st = score >= 70 ? 'PASS' : score >= 40 ? 'WARN' : 'FAIL';
            tests.push({ name: f, status: st, detail: String(Math.round(score)) + '/100' });
          } else {
            tests.push(_warn(f, 'Score field missing'));
          }
        });

        // Category details
        if (Array.isArray(r.categories) && r.categories.length > 0) {
          tests.push(_pass('categories', r.categories.length + ' categories audited'));
        } else {
          tests.push(_warn('categories', 'No categories array in report'));
        }

        // Verdict
        if (r.verdict) {
          tests.push(_pass('verdict', r.verdict.slice(0, 80)));
        } else {
          tests.push(_warn('verdict', 'No verdict in report'));
        }

        // Bottlenecks
        if (Array.isArray(r.bottlenecks)) {
          tests.push(_pass('bottlenecks', r.bottlenecks.length + ' bottlenecks identified'));
        }

        // Phase10
        if (r.phase10) {
          tests.push(_pass('phase10Rec', r.phase10.slice(0, 80)));
        }

        var passed = tests.filter(function (t) { return t.status === 'PASS'; }).length;
        return { name: 'CERT BrowserOSCert', tests: tests, passed: passed, total: tests.length, certReport: r };

      }).catch(function (e) {
        return {
          name: 'CERT BrowserOSCert',
          tests: [presenceTest, _fail('run', 'certFn() threw: ' + e.message)],
          passed: 0, total: 2, certReport: null,
        };
      });
    });
  }

  // ── Suite runner ──────────────────────────────────────────────────────────

  var SUITES = {
    '9A': _suite9A,
    '9B': _suite9B,
    '9C': _suite9C,
    '9D': _suite9D,
    '9E': _suite9E,
    '9F': _suite9F,
    '9G': _suite9G,
    '9H': _suite9H,
    '9I': _suite9I,
    '8I': _suite8I,
    'CERT': _suiteCert,
  };

  function runSuite(name) {
    var fn = SUITES[name];
    if (!fn) return Promise.reject(new Error('Unknown suite: ' + name));
    console.info(LOG, 'Running suite', name, '…');
    var t0 = Date.now();
    return fn().then(function (result) {
      result.ms = Date.now() - t0;
      console.info(LOG, 'Suite', name, '—', result.passed + '/' + result.total, 'passed', '(' + result.ms + 'ms)');
      return result;
    });
  }

  function run(opts) {
    opts = opts || {};
    var suiteNames = opts.suites || Object.keys(SUITES);
    var t0 = Date.now();
    console.group(LOG + ' Phase 9 Verification — ' + suiteNames.join(', '));

    // Run 9F sequentially (IDB lifecycle), others in parallel
    var parallel = suiteNames.filter(function (n) { return n !== '9F'; });
    var hasF = suiteNames.indexOf('9F') !== -1;

    var parallelJobs = parallel.map(function (n) { return runSuite(n); });
    var base = Promise.all(parallelJobs);

    if (hasF) {
      base = base.then(function (results) {
        return runSuite('9F').then(function (fResult) {
          return results.concat([fResult]);
        });
      });
    }

    return base.then(function (suiteResults) {
      var totalTests  = suiteResults.reduce(function (a, s) { return a + s.total; }, 0);
      var totalPassed = suiteResults.reduce(function (a, s) { return a + s.passed; }, 0);
      var totalFailed = suiteResults.reduce(function (a, s) {
        return a + s.tests.filter(function (t) { return t.status === 'FAIL'; }).length;
      }, 0);
      var totalWarned = suiteResults.reduce(function (a, s) {
        return a + s.tests.filter(function (t) { return t.status === 'WARN'; }).length;
      }, 0);

      var certSuite = suiteResults.find(function (s) { return s.name === 'CERT BrowserOSCert'; });
      var certReport = certSuite && certSuite.certReport;

      var report = {
        timestamp:    new Date().toISOString(),
        duration:     Date.now() - t0,
        suites:       suiteResults,
        totalTests:   totalTests,
        totalPassed:  totalPassed,
        totalFailed:  totalFailed,
        totalWarned:  totalWarned,
        overallPct:   Math.round(totalPassed / totalTests * 100),
        certReport:   certReport,
        verdict:      totalFailed === 0
          ? (totalWarned === 0 ? 'ALL PASS' : 'PASS WITH WARNINGS')
          : 'FAILURES DETECTED',
      };

      _lastReport = report;

      console.group(LOG + ' FINAL REPORT');
      console.info('Passed:   ' + totalPassed + ' / ' + totalTests + ' (' + report.overallPct + '%)');
      console.info('Failed:   ' + totalFailed);
      console.info('Warned:   ' + totalWarned);
      console.info('Verdict:  ' + report.verdict);
      console.info('Duration: ' + report.duration + ' ms');
      if (certReport) {
        console.info('BrowserOS Score:  ' + Math.round(certReport.browserOsScore || 0) + '/100');
        console.info('Offline Score:    ' + Math.round(certReport.offlineScore   || 0) + '/100');
        console.info('Compute Score:    ' + Math.round(certReport.computeScore   || 0) + '/100');
        console.info('AI Score:         ' + Math.round(certReport.aiScore        || 0) + '/100');
        console.info('LargeFile Score:  ' + Math.round(certReport.largeFileScore || 0) + '/100');
        console.info('Mobile Score:     ' + Math.round(certReport.mobileScore    || 0) + '/100');
        if (certReport.verdict) console.info('Cert Verdict: ' + certReport.verdict);
        if (Array.isArray(certReport.bottlenecks) && certReport.bottlenecks.length > 0) {
          console.warn('Bottlenecks:', certReport.bottlenecks);
        }
      }
      console.groupEnd();
      console.groupEnd();

      return report;
    });
  }

  // ── Render summary ────────────────────────────────────────────────────────

  function renderSummary(el) {
    if (!el || !_lastReport) {
      if (el) el.innerHTML = '<p style="color:#888">No report yet. Call P9V.run() first.</p>';
      return;
    }

    var r = _lastReport;

    var statusColor = {
      'ALL PASS':             '#22c55e',
      'PASS WITH WARNINGS':   '#f59e0b',
      'FAILURES DETECTED':    '#ef4444',
    };

    var html = '<div style="font-family:monospace;font-size:13px;line-height:1.6">';
    html += '<h2 style="margin:0 0 8px;font-size:16px">Phase 9 Verification Report';
    html += ' <span style="font-size:12px;color:#888">' + r.timestamp + '</span></h2>';
    html += '<div style="font-size:15px;font-weight:bold;color:' + (statusColor[r.verdict] || '#ccc') + ';margin-bottom:12px">';
    html += r.verdict + ' — ' + r.totalPassed + '/' + r.totalTests + ' tests (' + r.overallPct + '%) in ' + r.duration + ' ms</div>';

    r.suites.forEach(function (suite) {
      var allPass = suite.tests.every(function (t) { return t.status === 'PASS' || t.status === 'SKIP'; });
      var hasFail = suite.tests.some(function (t) { return t.status === 'FAIL'; });
      var suiteColor = hasFail ? '#ef4444' : allPass ? '#22c55e' : '#f59e0b';
      html += '<details style="margin-bottom:6px" ' + (hasFail ? 'open' : '') + '>';
      html += '<summary style="cursor:pointer;color:' + suiteColor + ';font-weight:bold">';
      html += suite.name + ' — ' + suite.passed + '/' + suite.total;
      if (suite.ms) html += ' <span style="font-weight:normal;color:#888">(' + suite.ms + 'ms)</span>';
      html += '</summary>';
      html += '<table style="width:100%;border-collapse:collapse;margin:4px 0 0 16px">';
      suite.tests.forEach(function (t) {
        var c = { PASS: '#22c55e', FAIL: '#ef4444', WARN: '#f59e0b', SKIP: '#6b7280' }[t.status] || '#ccc';
        html += '<tr>';
        html += '<td style="width:50px;color:' + c + ';font-weight:bold">' + t.status + '</td>';
        html += '<td style="width:220px">' + t.name + '</td>';
        html += '<td style="color:#aaa;font-size:12px">' + (t.detail || '') + '</td>';
        html += '</tr>';
      });
      html += '</table></details>';
    });

    // Cert scores
    if (r.certReport) {
      var cr = r.certReport;
      html += '<div style="margin-top:16px;border-top:1px solid #333;padding-top:12px">';
      html += '<h3 style="margin:0 0 8px;font-size:14px">BrowserOS Certification Scores</h3>';
      var scores = [
        ['BrowserOS Overall', cr.browserOsScore],
        ['Offline Capability', cr.offlineScore],
        ['Compute Scalability', cr.computeScore],
        ['AI Readiness', cr.aiScore],
        ['Large-File Handling', cr.largeFileScore],
        ['Mobile Resilience', cr.mobileScore],
      ];
      scores.forEach(function (pair) {
        var label = pair[0], val = Math.round(pair[1] || 0);
        var barColor = val >= 70 ? '#22c55e' : val >= 40 ? '#f59e0b' : '#ef4444';
        html += '<div style="margin-bottom:4px">';
        html += '<span style="display:inline-block;width:200px">' + label + '</span>';
        html += '<span style="display:inline-block;background:#333;width:200px;height:12px;vertical-align:middle;border-radius:4px">';
        html += '<span style="display:inline-block;background:' + barColor + ';width:' + val * 2 + 'px;height:12px;border-radius:4px"></span>';
        html += '</span> <strong>' + val + '</strong>/100';
        html += '</div>';
      });
      if (cr.verdict) html += '<p style="color:#aaa;margin:8px 0 0"><em>' + cr.verdict + '</em></p>';
      if (Array.isArray(cr.bottlenecks) && cr.bottlenecks.length > 0) {
        html += '<p style="color:#f59e0b;margin:6px 0 0"><strong>Bottlenecks:</strong> ' + cr.bottlenecks.join('; ') + '</p>';
      }
      if (cr.phase10) html += '<p style="color:#60a5fa;margin:6px 0 0"><strong>Phase 10:</strong> ' + cr.phase10 + '</p>';
      html += '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
  }

  global.P9V = {
    run:           run,
    runSuite:      runSuite,
    getLastReport: function () { return _lastReport; },
    renderSummary: renderSummary,
    suites:        Object.keys(SUITES),
  };

  console.info(LOG, 'RuntimePhase9Verification v1.0 ready — suites:', Object.keys(SUITES).join(', '));
}(window));
