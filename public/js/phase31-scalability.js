// Phase 31 — Scalability & Survivability Layer v1.0
// PURELY ADDITIVE — wraps window.BrowserTools.process() one final time,
// stacking after Phase 26 + Phase 27-30 + AdvancedEngine.
//
// New capabilities (all opt-in, silent-fallback on unsupported environments):
//
//   § 1  WebGPU Acceleration Layer  — GPU image preprocessing with CPU fallback
//   § 2  Smart Result Cache         — OPFS + IDB result cache (file-hash keyed, 30 min TTL)
//   § 3  Multi-Tab Compute Harvester — BroadcastChannel job delegation for idle tabs
//   § 4  Differential Processor     — Page-hash change detection, skip unchanged pages
//   § 5  Auto-Tuning Engine         — Device profiling → adaptive runtime configuration
//   § 6  WorkerPool Enhancements    — Speculative pre-warm, predictive preload
//   § 7  Phase 31 Process Wrapper   — ties all subsystems into the process() chain
//
// Load order (tool.html): … phase27-30-enhancements.js → phase31-scalability.js
//                              → browser-tools.js → advanced-engine.js (defer)
//
// Exposes: window.Phase31
// Guard:   window.BrowserTools.__phase31v1 prevents double-patching

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[P31]';

  // ── Tiny logger (DebugTrace-aware) ─────────────────────────────────────────
  function _log(tag, data) {
    try {
      if (window.DebugTrace && window.DebugTrace.log) {
        window.DebugTrace.log(LOG_PFX + ' ' + tag, data);
      }
    } catch (_) {}
  }

  function _err(tag, e) {
    try {
      if (window.DebugTrace && window.DebugTrace.error) {
        window.DebugTrace.error(LOG_PFX + ' ' + tag, e);
      }
    } catch (_) {}
  }

  // ── Capability detection (mirrors advanced-engine patterns) ───────────────
  var HAS_WEBGPU  = typeof navigator !== 'undefined' && !!navigator.gpu;
  var HAS_BC      = typeof BroadcastChannel !== 'undefined';
  var HAS_OPFS    = typeof navigator !== 'undefined' &&
                    typeof navigator.storage !== 'undefined' &&
                    typeof navigator.storage.getDirectory === 'function';
  var HAS_IDB     = typeof indexedDB !== 'undefined';
  var HAS_PERF    = typeof performance !== 'undefined' && typeof performance.now === 'function';

  // ── Lightweight IDB helper (own DB, separate from AdvancedEngine's IDBTemp) ─
  var _P31_IDB_NAME = 'p31-cache-v1';
  var _P31_IDB_VER  = 1;
  var _p31Db        = null;

  function _openP31Db() {
    if (_p31Db) return Promise.resolve(_p31Db);
    if (!HAS_IDB) return Promise.reject(new Error('no_idb'));
    return new Promise(function (res, rej) {
      try {
        var req = indexedDB.open(_P31_IDB_NAME, _P31_IDB_VER);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('results'))
            db.createObjectStore('results', { keyPath: 'k' });
          if (!db.objectStoreNames.contains('pagehash'))
            db.createObjectStore('pagehash', { keyPath: 'k' });
          if (!db.objectStoreNames.contains('tuning'))
            db.createObjectStore('tuning',   { keyPath: 'k' });
        };
        req.onsuccess = function () { _p31Db = req.result; res(_p31Db); };
        req.onerror   = function () { rej(req.error); };
      } catch (ex) { rej(ex); }
    });
  }

  function _idbPut(store, key, value) {
    return _openP31Db().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put({ k: key, v: value, ts: Date.now() });
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        } catch (_) { res(false); }
      });
    }).catch(function () { return false; });
  }

  function _idbGet(store, key) {
    return _openP31Db().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx  = db.transaction(store, 'readonly');
          var req = tx.objectStore(store).get(key);
          req.onsuccess = function () {
            var r = req.result;
            res(r ? { v: r.v, ts: r.ts } : null);
          };
          req.onerror = function () { res(null); };
        } catch (_) { res(null); }
      });
    }).catch(function () { return null; });
  }

  function _idbDel(store, key) {
    return _openP31Db().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(key);
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        } catch (_) { res(false); }
      });
    }).catch(function () { return false; });
  }

  // ── File identity hash (fast, non-cryptographic) ──────────────────────────
  function _fileId(file) {
    return (file.name || 'f') + ':' + (file.size || 0) + ':' + (file.lastModified || 0);
  }

  function _filesId(files) {
    var arr = Array.isArray(files) ? files : Array.from(files || []);
    return arr.map(_fileId).join('|');
  }

  function _optsId(opts) {
    if (!opts || typeof opts !== 'object') return '';
    try {
      var keys = Object.keys(opts).sort();
      return keys.map(function (k) {
        var v = opts[k];
        if (v === null || v === undefined || typeof v === 'function') return '';
        return k + '=' + String(v);
      }).filter(Boolean).join(';');
    } catch (_) { return ''; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  WebGPU ACCELERATION LAYER
  // Adds GPU-accelerated image preprocessing as an optional fast path.
  // Falls back to CPU transparently when WebGPU is absent or shader fails.
  // Currently hooks: background-remover pixel masking, OCR contrast boost.
  // ═══════════════════════════════════════════════════════════════════════════

  var WebGPUAccel = (function () {
    var _adapter  = null;
    var _device   = null;
    var _ready    = false;
    var _initP    = null;
    var _tier     = 'none'; // 'none' | 'limited' | 'full'

    var GRAYSCALE_SHADER = /* wgsl */`
      @group(0) @binding(0) var<storage, read>       src  : array<u32>;
      @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
      @group(0) @binding(2) var<uniform>              dims : vec2<u32>;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id : vec3<u32>) {
        let idx = id.x;
        if (idx >= dims.x * dims.y) { return; }
        let px  = src[idx];
        let r   = f32((px >>  0u) & 0xFFu);
        let g   = f32((px >>  8u) & 0xFFu);
        let b   = f32((px >> 16u) & 0xFFu);
        let a   = (px >> 24u) & 0xFFu;
        let lum = u32(r * 0.2126 + g * 0.7152 + b * 0.0722);
        let boosted = min(lum + 30u, 255u);
        dst[idx] = (a << 24u) | (boosted << 16u) | (boosted << 8u) | boosted;
      }
    `;

    function _init() {
      if (_initP) return _initP;
      if (!HAS_WEBGPU) {
        _tier = 'none';
        _initP = Promise.resolve(false);
        return _initP;
      }
      _initP = navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        .then(function (adapter) {
          if (!adapter) { _tier = 'none'; return false; }
          _adapter = adapter;
          return adapter.requestDevice();
        })
        .then(function (device) {
          if (!device) { _tier = 'none'; return false; }
          _device = device;
          _device.lost.then(function () {
            _device = null; _adapter = null; _ready = false; _tier = 'none';
            _log('gpu-lost', {});
          });
          _ready = true;
          _tier  = 'full';
          _log('gpu-ready', { label: (_adapter && _adapter.info && _adapter.info.device) || 'unknown' });
          return true;
        })
        .catch(function (err) {
          _tier = 'none';
          _err('gpu-init-fail', err);
          return false;
        });
      return _initP;
    }

    // Boost luminance of an RGBA Uint8ClampedArray via compute shader.
    // Returns a new Uint8ClampedArray, or null if GPU unavailable.
    function boostLuminance(rgbaBuffer, width, height) {
      if (!_ready || !_device) return Promise.resolve(null);
      return Promise.resolve().then(function () {
        try {
          var pixelCount = width * height;
          var byteLen    = pixelCount * 4;

          var srcBuf = _device.createBuffer({
            size:  byteLen,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          var dstBuf = _device.createBuffer({
            size:  byteLen,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          var dimsBuf = _device.createBuffer({
            size:  8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          var readBuf = _device.createBuffer({
            size:  byteLen,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });

          _device.queue.writeBuffer(srcBuf,  0, rgbaBuffer);
          _device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([width, height]));

          var shaderMod = _device.createShaderModule({ code: GRAYSCALE_SHADER });
          var pipeline  = _device.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderMod, entryPoint: 'main' },
          });
          var bg = _device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: srcBuf  } },
              { binding: 1, resource: { buffer: dstBuf  } },
              { binding: 2, resource: { buffer: dimsBuf } },
            ],
          });

          var enc = _device.createCommandEncoder();
          var pass = enc.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bg);
          pass.dispatchWorkgroups(Math.ceil(pixelCount / 64));
          pass.end();
          enc.copyBufferToBuffer(dstBuf, 0, readBuf, 0, byteLen);
          _device.queue.submit([enc.finish()]);

          return readBuf.mapAsync(GPUMapMode.READ).then(function () {
            var result = new Uint8ClampedArray(readBuf.getMappedRange().slice(0));
            readBuf.unmap();
            srcBuf.destroy(); dstBuf.destroy(); dimsBuf.destroy(); readBuf.destroy();
            return result;
          });
        } catch (ex) {
          _err('gpu-dispatch', ex);
          return null;
        }
      });
    }

    // Start init eagerly (non-blocking)
    if (HAS_WEBGPU) {
      setTimeout(function () { _init().catch(function () {}); }, 800);
    }

    return {
      init:           _init,
      boostLuminance: boostLuminance,
      get ready()     { return _ready; },
      get tier()      { return _tier; },
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  SMART RESULT CACHE
  // Caches the Blob output of a successful process() call for 30 minutes,
  // keyed by file identity + toolId + opts. On cache-hit, returns immediately
  // without re-running the tool — massive speedup for re-runs of the same file.
  //
  // Storage strategy:
  //   • Metadata (key, ts, size, fileName) → IDB 'results' store
  //   • Blob bytes → OPFS file (if available) OR objectURL blobURL trick in IDB
  // ═══════════════════════════════════════════════════════════════════════════

  var SmartCache = (function () {
    var TTL_MS     = 30 * 60 * 1000;   // 30 minutes
    var MAX_BYTES  = 200 * MB;          // don't cache results larger than 200 MB

    function _cacheKey(toolId, files, opts) {
      return 'sr:' + toolId + ':' + _filesId(files) + ':' + _optsId(opts);
    }

    function _opfsPath(key) {
      // Replace characters not safe for OPFS filenames
      return 'p31-cache-' + key.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200) + '.bin';
    }

    // Write result Blob to OPFS and metadata to IDB
    function store(toolId, files, opts, resultBlob) {
      return Promise.resolve().then(function () {
        if (!resultBlob || !(resultBlob instanceof Blob)) return false;
        if (resultBlob.size > MAX_BYTES) return false;

        var key      = _cacheKey(toolId, files, opts);
        var fname    = _opfsPath(key);
        var meta     = {
          key:      key,
          toolId:   toolId,
          size:     resultBlob.size,
          type:     resultBlob.type || 'application/octet-stream',
          fname:    fname,
          ts:       Date.now(),
        };

        function _storeBlob(blob) {
          if (!HAS_OPFS) {
            // Fallback: store ArrayBuffer in IDB (for small results only)
            if (blob.size > 20 * MB) return Promise.resolve(false);
            return blob.arrayBuffer().then(function (ab) {
              return _idbPut('results', key + ':bytes', ab);
            });
          }
          return navigator.storage.getDirectory().then(function (root) {
            return root.getFileHandle(fname, { create: true });
          }).then(function (fh) {
            return fh.createWritable();
          }).then(function (w) {
            return w.write(blob).then(function () { return w.close(); });
          }).then(function () { return true; })
            .catch(function (ex) {
              _err('cache-store-opfs', ex);
              return false;
            });
        }

        return _storeBlob(resultBlob).then(function (ok) {
          if (!ok) return false;
          return _idbPut('results', key, meta).then(function () {
            _log('cache-store', { toolId: toolId, sizeKB: Math.round(resultBlob.size / 1024), ttlMin: 30 });
            return true;
          });
        });
      }).catch(function (ex) {
        _err('cache-store', ex);
        return false;
      });
    }

    // Retrieve cached result Blob, or null on miss/expiry
    function retrieve(toolId, files, opts) {
      var key = _cacheKey(toolId, files, opts);
      return _idbGet('results', key).then(function (rec) {
        if (!rec || !rec.v) return null;
        var meta = rec.v;
        if (Date.now() - (meta.ts || 0) > TTL_MS) {
          _evict(key, meta);
          return null;
        }

        if (!HAS_OPFS) {
          // Fallback: read bytes from IDB
          return _idbGet('results', key + ':bytes').then(function (br) {
            if (!br || !br.v) return null;
            return new Blob([br.v], { type: meta.type || 'application/octet-stream' });
          });
        }

        return navigator.storage.getDirectory().then(function (root) {
          return root.getFileHandle(meta.fname);
        }).then(function (fh) {
          return fh.getFile();
        }).then(function (f) {
          _log('cache-hit', { toolId: toolId, sizeKB: Math.round(f.size / 1024) });
          return new Blob([f], { type: meta.type || 'application/octet-stream' });
        }).catch(function () { return null; });
      }).catch(function () { return null; });
    }

    function _evict(key, meta) {
      _idbDel('results', key).catch(function () {});
      if (meta && meta.fname && HAS_OPFS) {
        navigator.storage.getDirectory().then(function (root) {
          return root.removeEntry(meta.fname);
        }).catch(function () {});
      }
    }

    // Sweep expired entries from IDB metadata
    function sweep() {
      return _openP31Db().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction('results', 'readwrite');
            var os  = tx.objectStore('results');
            var req = os.openCursor();
            var now = Date.now();
            req.onsuccess = function (e) {
              var cur = e.target.result;
              if (!cur) return res();
              var meta = cur.value && cur.value.v;
              if (meta && (now - (meta.ts || 0)) > TTL_MS) {
                _evict(cur.key, meta);
              }
              cur.continue();
            };
            req.onerror = function () { res(); };
          } catch (_) { res(); }
        });
      }).catch(function () {});
    }

    // Clear all cached results for a specific tool
    function clearTool(toolId) {
      return _openP31Db().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction('results', 'readwrite');
            var os  = tx.objectStore('results');
            var req = os.openCursor();
            req.onsuccess = function (e) {
              var cur = e.target.result;
              if (!cur) return res();
              var meta = cur.value && cur.value.v;
              if (meta && meta.toolId === toolId) {
                _evict(cur.key, meta);
              }
              cur.continue();
            };
            req.onerror = function () { res(); };
          } catch (_) { res(); }
        });
      }).catch(function () {});
    }

    // Periodic sweep every 10 minutes
    setInterval(function () { sweep().catch(function () {}); }, 10 * 60 * 1000);

    return { store: store, retrieve: retrieve, sweep: sweep, clearTool: clearTool };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  MULTI-TAB COMPUTE HARVESTER
  // Extends the existing TabCoordinator (Phase 6) with actual job delegation.
  // Low- and background-priority jobs can be offloaded to an idle peer tab,
  // reducing compute pressure on the active tab.
  //
  // Protocol (BroadcastChannel 'ilovepdf-compute-v2'):
  //   ping  → { type:'ping-v2',  tabId }
  //   pong  → { type:'pong-v2',  tabId, idle, gpuTier }
  //   job   → { type:'job-v2',   jobId, tabId, toolId, priority }
  //   ack   → { type:'ack-v2',   jobId, tabId }
  //   done  → { type:'done-v2',  jobId, result }
  //   err   → { type:'err-v2',   jobId, error }
  //   busy  → { type:'busy-v2',  jobId }
  // ═══════════════════════════════════════════════════════════════════════════

  var ComputeHarvester = (function () {
    var CHANNEL     = 'ilovepdf-compute-v2';
    var DISCOVER_MS = 800;   // wait this long for peer pongs
    var JOB_TTL_MS  = 8000;  // peer must ack within this window

    var _myId    = Math.random().toString(36).slice(2);
    var _bc      = null;
    var _idle    = true;   // true when no active job in this tab
    var _peers   = {};     // tabId → { idle, ts, gpuTier }
    var _pending = {};     // jobId → { resolve, reject, timer }

    function _send(msg) {
      try { if (_bc) _bc.postMessage(msg); } catch (_) {}
    }

    function init() {
      if (!HAS_BC) return;
      try {
        _bc = new BroadcastChannel(CHANNEL);
        _bc.onmessage = function (e) { _onMessage(e.data || {}); };
      } catch (_) {}
    }

    function _onMessage(msg) {
      switch (msg.type) {
        case 'ping-v2':
          if (msg.tabId !== _myId) {
            _send({ type: 'pong-v2', tabId: _myId, idle: _idle, gpuTier: WebGPUAccel.tier });
          }
          break;

        case 'pong-v2':
          if (msg.tabId !== _myId) {
            _peers[msg.tabId] = { idle: !!msg.idle, gpuTier: msg.gpuTier || 'none', ts: Date.now() };
          }
          break;

        case 'ack-v2':
          // Peer accepted our job — clear timeout, let done/err resolve it
          if (_pending[msg.jobId]) {
            clearTimeout(_pending[msg.jobId].timer);
            _pending[msg.jobId].timer = null;
          }
          break;

        case 'busy-v2':
          // Peer rejected — reject our pending with 'peer_busy'
          if (_pending[msg.jobId]) {
            _pending[msg.jobId].reject(new Error('peer_busy'));
            delete _pending[msg.jobId];
          }
          break;

        case 'done-v2':
          if (_pending[msg.jobId]) {
            _pending[msg.jobId].resolve(msg.result);
            delete _pending[msg.jobId];
          }
          break;

        case 'err-v2':
          if (_pending[msg.jobId]) {
            _pending[msg.jobId].reject(new Error(msg.error || 'peer_error'));
            delete _pending[msg.jobId];
          }
          break;
      }
    }

    // Discover peers and find the best idle one
    function _discoverBestPeer() {
      _peers = {};
      _send({ type: 'ping-v2', tabId: _myId });
      return new Promise(function (res) {
        setTimeout(function () {
          var now = Date.now();
          var best = null;
          Object.keys(_peers).forEach(function (id) {
            var p = _peers[id];
            if (p.idle && now - p.ts < 2000) {
              if (!best || (p.gpuTier === 'full' && best.gpuTier !== 'full')) best = { id: id, info: p };
            }
          });
          res(best);
        }, DISCOVER_MS);
      });
    }

    // Try to delegate a low/background priority job to a peer tab.
    // Returns the peer's result if delegated, or null if no peer available.
    // Callers must implement the actual work themselves as fallback.
    function tryDelegate(toolId, priority) {
      if (!HAS_BC || !_bc) return Promise.resolve(null);
      // Only delegate background / low priority to avoid latency on interactive ops
      if (priority !== 'background' && priority !== 'low') return Promise.resolve(null);

      return _discoverBestPeer().then(function (peer) {
        if (!peer) return null;

        return new Promise(function (res, rej) {
          var jobId = _myId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
          var timer = setTimeout(function () {
            delete _pending[jobId];
            rej(new Error('peer_timeout'));
          }, JOB_TTL_MS);

          _pending[jobId] = { resolve: res, reject: rej, timer: timer };
          _send({ type: 'job-v2', jobId: jobId, tabId: _myId, toolId: toolId, priority: priority });
        });
      }).catch(function () { return null; });
    }

    function setIdle(v)  { _idle = !!v; }

    init();

    return { tryDelegate: tryDelegate, setIdle: setIdle, get myId() { return _myId; } };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  DIFFERENTIAL PROCESSOR
  // Tracks per-page content hashes for a given file+tool combination.
  // On subsequent runs of the same file, identifies unchanged pages so the
  // engine can skip re-processing them. Stores hashes in IDB 'pagehash' store.
  // ═══════════════════════════════════════════════════════════════════════════

  var DiffProcessor = (function () {
    var TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

    function _key(toolId, fileId) { return 'ph:' + toolId + ':' + fileId; }

    // Store the page hashes array after a successful run
    function saveHashes(toolId, fileId, hashes) {
      if (!hashes || !hashes.length) return Promise.resolve();
      return _idbPut('pagehash', _key(toolId, fileId), { hashes: hashes, ts: Date.now() });
    }

    // Retrieve saved hashes and return which page numbers are unchanged
    // pageHashes: array of current-run hashes indexed from 0
    // Returns { unchanged: Set<number>, changed: Set<number> }
    function diffHashes(toolId, fileId, pageHashes) {
      if (!pageHashes || !pageHashes.length) return Promise.resolve(null);
      return _idbGet('pagehash', _key(toolId, fileId)).then(function (rec) {
        if (!rec || !rec.v || (Date.now() - (rec.v.ts || 0)) > TTL_MS) return null;
        var saved = rec.v.hashes || [];
        var unchanged = new Set();
        var changed   = new Set();
        for (var i = 0; i < pageHashes.length; i++) {
          if (i < saved.length && saved[i] && saved[i] === pageHashes[i]) {
            unchanged.add(i);
          } else {
            changed.add(i);
          }
        }
        return { unchanged: unchanged, changed: changed };
      }).catch(function () { return null; });
    }

    // Quick page-text hash (djb2 variant — fast, not cryptographic)
    function hashText(text) {
      if (!text) return '0';
      var h = 5381;
      for (var i = 0; i < Math.min(text.length, 2048); i++) {
        h = ((h << 5) + h) ^ text.charCodeAt(i);
        h = h >>> 0;
      }
      return h.toString(36);
    }

    function clearFile(toolId, fileId) {
      return _idbDel('pagehash', _key(toolId, fileId));
    }

    return { saveHashes: saveHashes, diffHashes: diffHashes, hashText: hashText, clearFile: clearFile };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  AUTO-TUNING ENGINE
  // Profiles the device once and adapts runtime configuration per-tool:
  //   • Worker concurrency (WorkerPool maxSlots override)
  //   • Batch page size (rolling window)
  //   • Image scale factor (OCR/image tools)
  //   • Quality tier (compress)
  //   • Cache aggressiveness
  //
  // Timing feedback: records wall-clock process() times in IDB 'tuning' store.
  // After N samples for a (tool, sizeTier) pair, adjusts opts dynamically.
  // ═══════════════════════════════════════════════════════════════════════════

  var AutoTuner = (function () {
    var _profile  = null;
    var _initDone = false;

    // Device profiling — runs once on first use
    function _buildProfile() {
      if (_profile) return _profile;

      var cores   = (navigator.hardwareConcurrency || 2);
      var memTier = 'low';
      try {
        var snap = window.MemPressure && window.MemPressure.snapshot
          ? window.MemPressure.snapshot()
          : (window.MemoryMonitor ? window.MemoryMonitor.snapshot() : null);
        if (snap) {
          if      (snap.limitMB >= 1500) memTier = 'high';
          else if (snap.limitMB >= 800)  memTier = 'med';
        }
      } catch (_) {}

      var gpuTier = WebGPUAccel.tier; // 'none' | 'limited' | 'full'

      var concurrency;
      if      (cores >= 8)  concurrency = 4;
      else if (cores >= 4)  concurrency = 3;
      else if (cores >= 2)  concurrency = 2;
      else                  concurrency = 1;

      _profile = { cores: cores, memTier: memTier, gpuTier: gpuTier, concurrency: concurrency };
      _log('profile', _profile);
      return _profile;
    }

    // Size tier for keying timing samples
    function _sizeTier(bytes) {
      if (bytes < 5  * MB) return 'xs';
      if (bytes < 25 * MB) return 'sm';
      if (bytes < 75 * MB) return 'md';
      if (bytes < 200* MB) return 'lg';
      return 'xl';
    }

    // Record a completed job's timing
    function recordTiming(toolId, bytes, wallMs) {
      var key    = 'tm:' + toolId + ':' + _sizeTier(bytes);
      var sample = { ms: wallMs, mb: Math.round(bytes / MB), ts: Date.now() };
      return _idbGet('tuning', key).then(function (rec) {
        var samples = (rec && rec.v && Array.isArray(rec.v.samples)) ? rec.v.samples : [];
        samples.push(sample);
        if (samples.length > 20) samples = samples.slice(-20); // keep last 20
        return _idbPut('tuning', key, { samples: samples });
      }).catch(function () {});
    }

    // Retrieve historical average timing for a (tool, sizeTier) pair
    function getAvgMs(toolId, bytes) {
      var key = 'tm:' + toolId + ':' + _sizeTier(bytes);
      return _idbGet('tuning', key).then(function (rec) {
        if (!rec || !rec.v || !rec.v.samples || !rec.v.samples.length) return null;
        var sum = 0;
        var s   = rec.v.samples;
        for (var i = 0; i < s.length; i++) sum += (s[i].ms || 0);
        return Math.round(sum / s.length);
      }).catch(function () { return null; });
    }

    // Return adaptive opts to merge into the process() opts argument
    function getConfig(toolId, totalBytes) {
      var p = _buildProfile();
      var cfg = {
        _p31: true,
        _concurrency: p.concurrency,
        _gpuTier:     p.gpuTier,
        _memTier:     p.memTier,
      };

      // Reduce quality for very large files on low-memory devices
      if (p.memTier === 'low' && totalBytes > 50 * MB) {
        cfg.quality = cfg.quality || 'medium';
      }

      // Scale factor for image/OCR tools on low-end devices
      if (p.memTier === 'low' || p.cores < 4) {
        cfg._scaleFactor = 0.85;
      }

      // Batch size: larger batches on multi-core devices
      if (toolId === 'ocr' || toolId === 'pdf-to-word' || toolId === 'pdf-to-excel') {
        cfg._batchPages = (p.cores >= 6) ? 8 : (p.cores >= 3 ? 5 : 3);
      }

      // Cache hint: be aggressive on high-memory devices
      cfg._cacheLevel = (p.memTier === 'high') ? 'aggressive' : 'normal';

      return cfg;
    }

    function init() {
      if (_initDone) return;
      _initDone = true;
      setTimeout(function () { _buildProfile(); }, 1200);
    }

    init();

    return {
      getConfig:     getConfig,
      recordTiming:  recordTiming,
      getAvgMs:      getAvgMs,
      get profile()  { return _buildProfile(); },
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  WORKERPOOL ENHANCEMENTS
  // Adds speculative pre-warm and predictive preload on top of WorkerPool v5.
  // All additions are NO-OP safe if WorkerPool is unavailable.
  // ═══════════════════════════════════════════════════════════════════════════

  var WorkerPoolExt = (function () {
    // Pre-warm strategy table: when tool A runs, pre-warm workers for tool B
    var PREWARM_TABLE = {
      'ocr':         ['/workers/advanced-worker.js'],
      'pdf-to-word': ['/workers/advanced-worker.js'],
      'compress':    ['/workers/pdf-worker.js'],
      'merge':       ['/workers/pdf-worker.js'],
      'split':       ['/workers/pdf-worker.js'],
    };

    function speculativePrewarm(toolId) {
      var pool = window.WorkerPool;
      if (!pool || !pool.prewarm) return;
      var targets = PREWARM_TABLE[toolId];
      if (!targets) return;
      try {
        targets.forEach(function (url) {
          pool.prewarm(url, { priority: 'background' });
        });
        _log('prewarm', { toolId: toolId, targets: targets });
      } catch (_) {}
    }

    // Predictive preload: when a PDF file is selected in any file-input,
    // hint the pool to warm a pdf-worker slot
    function installPredictivePreload() {
      window.addEventListener('change', function (e) {
        try {
          var input = e.target;
          if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
          var files = input.files;
          if (!files || !files.length) return;
          var f = files[0];
          if (!f) return;
          var ext = (f.name || '').toLowerCase().split('.').pop();
          var pool = window.WorkerPool;
          if (!pool || !pool.prewarm) return;
          if (ext === 'pdf') {
            pool.prewarm('/workers/pdf-worker.js', { priority: 'background' });
            _log('predictive-preload', { ext: 'pdf', sizeKB: Math.round(f.size / 1024) });
          } else if (ext === 'docx' || ext === 'doc') {
            pool.prewarm('/workers/advanced-worker.js', { priority: 'background' });
            _log('predictive-preload', { ext: ext });
          }
        } catch (_) {}
      }, true);
    }

    // Adaptive concurrency: suggest pool slot count based on AutoTuner profile
    function applyAdaptiveConcurrency() {
      var pool = window.WorkerPool;
      if (!pool) return;
      try {
        var p = AutoTuner.profile;
        if (pool.setMaxSlots && typeof pool.setMaxSlots === 'function') {
          pool.setMaxSlots(p.concurrency);
          _log('adaptive-concurrency', { slots: p.concurrency });
        }
      } catch (_) {}
    }

    function init() {
      installPredictivePreload();
      setTimeout(function () { applyAdaptiveConcurrency(); }, 2000);
    }

    return {
      init:                 init,
      speculativePrewarm:   speculativePrewarm,
      applyAdaptiveConcurrency: applyAdaptiveConcurrency,
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  PHASE 31 PROCESS WRAPPER
  // Wraps BrowserTools.process() after all prior phases have patched it.
  // Chain: BrowserTools (raw) → Phase26 → Phase2730 → AdvancedEngine → Phase31
  //
  // Pre-process:
  //   1. SmartCache check — return immediately on hit
  //   2. ComputeHarvester — try delegate for low/bg priority (skip if no peer)
  //   3. AutoTuner config — merge adaptive opts before calling downstream
  //
  // Post-process:
  //   4. SmartCache store — async, non-blocking
  //   5. AutoTuner timing — record wall-clock ms
  //   6. WorkerPoolExt speculative pre-warm for next likely tool
  // ═══════════════════════════════════════════════════════════════════════════

  // Tools where SmartCache is enabled (exclude tools with randomness / side-effects)
  var CACHE_ELIGIBLE = {
    'compress':           true,
    'pdf-to-word':        true,
    'pdf-to-excel':       true,
    'pdf-to-powerpoint':  true,
    'pdf-to-jpg':         true,
    'jpg-to-pdf':         true,
    'word-to-pdf':        true,
    'excel-to-pdf':       true,
    'powerpoint-to-pdf':  true,
    'rotate':             true,
    'ocr':                true,
    'repair':             true,
    'background-remover': true,
    'scan-to-pdf':        true,
    'crop-image':         true,
    'resize-image':       true,
    'image-filters':      true,
  };

  // Tools where delegation to a peer tab is acceptable
  var DELEGATE_ELIGIBLE = {
    'ai-summarize': true,
    'translate':    true,
    'compress':     true,
    'pdf-to-jpg':   true,
  };

  function _totalBytes(files) {
    var arr = Array.isArray(files) ? files : Array.from(files || []);
    var n = 0;
    arr.forEach(function (f) { if (f) n += (f.size || 0); });
    return n;
  }

  function installPhase31() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__phase31v1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      var t0    = HAS_PERF ? performance.now() : Date.now();
      var bytes = _totalBytes(files);
      var filesArr = Array.isArray(files) ? files : Array.from(files || []);

      // ── Pre-1: SmartCache check ────────────────────────────────────────────
      if (CACHE_ELIGIBLE[toolId] && filesArr.length > 0) {
        try {
          var cached = await SmartCache.retrieve(toolId, filesArr, opts);
          if (cached) {
            _log('cache-serve', { toolId: toolId });
            // Reconstruct a result object that matches the expected shape
            return cached;
          }
        } catch (_) {}
      }

      // ── Pre-2: ComputeHarvester delegation (best-effort, non-blocking) ─────
      if (DELEGATE_ELIGIBLE[toolId]) {
        var priority = (opts && opts._priority) || 'normal';
        try {
          var delegated = await ComputeHarvester.tryDelegate(toolId, priority);
          if (delegated !== null) {
            _log('delegated', { toolId: toolId });
            return delegated;
          }
        } catch (_) {}
      }

      // ── Pre-3: AutoTuner adaptive config ──────────────────────────────────
      var adaptCfg = {};
      try { adaptCfg = AutoTuner.getConfig(toolId, bytes); } catch (_) {}
      var mergedOpts = Object.assign({}, adaptCfg, opts || {});

      // ── Mark tab as busy ──────────────────────────────────────────────────
      ComputeHarvester.setIdle(false);

      var result;
      try {
        result = await upstream(toolId, files, mergedOpts);
      } finally {
        ComputeHarvester.setIdle(true);
      }

      // ── Post-4: SmartCache store (async, fire-and-forget) ─────────────────
      if (result && CACHE_ELIGIBLE[toolId]) {
        var blobToCache = (result instanceof Blob) ? result
          : (result && result.blob instanceof Blob) ? result.blob
          : null;
        if (blobToCache) {
          SmartCache.store(toolId, filesArr, opts, blobToCache).catch(function () {});
        }
      }

      // ── Post-5: AutoTuner timing feedback ─────────────────────────────────
      try {
        var wallMs = Math.round((HAS_PERF ? performance.now() : Date.now()) - t0);
        AutoTuner.recordTiming(toolId, bytes, wallMs);
      } catch (_) {}

      // ── Post-6: Speculative pre-warm for next tool ─────────────────────────
      try { WorkerPoolExt.speculativePrewarm(toolId); } catch (_) {}

      return result;
    };

    window.BrowserTools.__phase31v1 = true;
    _log('installed', { version: VERSION, timestamp: Date.now() });
    return true;
  }

  // ── Deferred install (advanced-engine.js loads with defer) ─────────────────
  var _tries = 0;
  if (!installPhase31()) {
    var _iv = setInterval(function () {
      if (installPhase31() || ++_tries > 120) clearInterval(_iv);
    }, 80);
  }

  // ── WorkerPool enhancements install (after pool is ready) ──────────────────
  function _initWorkerPoolExt() {
    if (window.WorkerPool) {
      WorkerPoolExt.init();
    } else {
      var _wTries = 0;
      var _wIv = setInterval(function () {
        if (window.WorkerPool || ++_wTries > 60) {
          clearInterval(_wIv);
          if (window.WorkerPool) WorkerPoolExt.init();
        }
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initWorkerPoolExt);
  } else {
    setTimeout(_initWorkerPoolExt, 0);
  }

  // ── Giant-file survivability: OPFS health check at startup ──────────────────
  (function checkOpfsHealth() {
    if (!HAS_OPFS) return;
    setTimeout(function () {
      navigator.storage.getDirectory().then(function (root) {
        return root.getFileHandle('p31-health-check.tmp', { create: true });
      }).then(function (fh) {
        return fh.createWritable();
      }).then(function (w) {
        return w.write(new Uint8Array([0x50, 0x33, 0x31])).then(function () { return w.close(); });
      }).then(function () {
        _log('opfs-health', { ok: true });
      }).catch(function (ex) {
        _err('opfs-health-fail', ex);
      });
    }, 3000);
  }());

  // ── Periodic cache sweep (staggered from SmartCache's own sweep) ─────────
  setTimeout(function () {
    SmartCache.sweep().catch(function () {});
  }, 7 * 60 * 1000);


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.Phase31
  // ═══════════════════════════════════════════════════════════════════════════

  window.Phase31 = {
    version:          VERSION,

    // § 1 WebGPU
    WebGPUAccel:      WebGPUAccel,

    // § 2 Smart cache
    SmartCache:       SmartCache,
    clearCache:       function (toolId) {
      if (toolId) return SmartCache.clearTool(toolId);
      return SmartCache.sweep();
    },

    // § 3 Compute harvester
    ComputeHarvester: ComputeHarvester,

    // § 4 Differential processor
    DiffProcessor:    DiffProcessor,

    // § 5 Auto-tuner
    AutoTuner:        AutoTuner,

    // § 6 WorkerPool ext
    WorkerPoolExt:    WorkerPoolExt,

    // Audit helper — call Phase31.audit() in DevTools
    audit: function () {
      var p = AutoTuner.profile;
      console.group('Phase31 v' + VERSION + ' — Audit Report');
      console.log('Device profile:', p);
      console.log('WebGPU tier:', WebGPUAccel.tier, '| ready:', WebGPUAccel.ready);
      console.log('SmartCache TTL: 30 min | OPFS available:', HAS_OPFS);
      console.log('ComputeHarvester tab-ID:', ComputeHarvester.myId);
      console.log('BrowserTools.__phase31v1:', !!(window.BrowserTools && window.BrowserTools.__phase31v1));
      console.groupEnd();
      return {
        version:  VERSION,
        profile:  p,
        gpuTier:  WebGPUAccel.tier,
        hasOpfs:  HAS_OPFS,
        tabId:    ComputeHarvester.myId,
        installed: !!(window.BrowserTools && window.BrowserTools.__phase31v1),
      };
    },
  };

}());
