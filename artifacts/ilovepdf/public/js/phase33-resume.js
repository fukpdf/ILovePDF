// Phase 33 — Session Resume & Crash Recovery v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 33A  CheckpointEngine    — page-level checkpoint storage (OPFS + IDB)
// § 33B  CrashRecovery       — detects interrupted jobs on reload, offers resume
// § 33C  MultiDayProcessing  — long-running job orchestration, stale cleanup
//
// Depends on: OPFSManager, LargeFileStreaming.CheckpointStore, MemPressure
// Exposes: window.Phase33

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[P33]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ── IDB helpers (own DB 'p33-resume-v1') ─────────────────────────────────
  var _DB_NAME = 'p33-resume-v1';
  var _DB_VER  = 1;
  var _db      = null;

  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      try {
        var req = indexedDB.open(_DB_NAME, _DB_VER);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('jobs'))
            db.createObjectStore('jobs', { keyPath: 'jobId' });
          if (!db.objectStoreNames.contains('pages'))
            db.createObjectStore('pages', { keyPath: 'k' });
        };
        req.onsuccess = function () { _db = req.result; res(_db); };
        req.onerror   = function () { rej(req.error); };
      } catch (ex) { rej(ex); }
    });
  }

  function _dbPut(store, rec) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(rec);
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        } catch (_) { res(false); }
      });
    }).catch(function () { return false; });
  }

  function _dbGet(store, key) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx  = db.transaction(store, 'readonly');
          var req = tx.objectStore(store).get(key);
          req.onsuccess = function () { res(req.result || null); };
          req.onerror   = function () { res(null); };
        } catch (_) { res(null); }
      });
    }).catch(function () { return null; });
  }

  function _dbGetAll(store) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx  = db.transaction(store, 'readonly');
          var req = tx.objectStore(store).getAll();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror   = function () { res([]); };
        } catch (_) { res([]); }
      });
    }).catch(function () { return []; });
  }

  function _dbDel(store, key) {
    return _openDb().then(function (db) {
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


  // ═══════════════════════════════════════════════════════════════════════════
  // § 33A  CHECKPOINT ENGINE
  // Saves granular processing state so jobs can resume after crash/close.
  // Each checkpoint stores: completed pages, failed pages, OCR confidence,
  // partial output refs, memory tier, worker states, chunk state.
  //
  // Checkpoint ID: toolId + ':' + fileHash
  //   fileHash: name:size:lastModified
  // ═══════════════════════════════════════════════════════════════════════════

  var CheckpointEngine = (function () {
    // How often to auto-save checkpoint (ms)
    var AUTO_SAVE_MS   = 12000;
    // Max age before a checkpoint is considered stale (7 days)
    var STALE_MS       = 7 * 24 * 60 * 60 * 1000;
    // Max checkpoints to retain
    var MAX_CHECKPOINTS = 20;

    var _active = {};   // jobId → live state being accumulated

    function _fileHash(file) {
      return (file && file.name ? file.name : 'f') + ':' +
             (file && file.size ? file.size : 0) + ':' +
             (file && file.lastModified ? file.lastModified : 0);
    }

    function _jobId(toolId, files) {
      var arr = Array.isArray(files) ? files : Array.from(files || []);
      return toolId + ':' + arr.map(_fileHash).join('|');
    }

    // Create or reset a live checkpoint for a job
    function startJob(toolId, files, meta) {
      var jid = _jobId(toolId, files);
      _active[jid] = {
        jobId:          jid,
        toolId:         toolId,
        fileHashes:     (Array.isArray(files) ? files : Array.from(files || [])).map(_fileHash),
        startedAt:      Date.now(),
        updatedAt:      Date.now(),
        totalPages:     meta && meta.totalPages  ? meta.totalPages  : 0,
        completedPages: [],
        failedPages:    [],
        ocrConfidence:  {},       // pageNum → confidence score
        partialOutputs: [],       // OPFS keys for partial output blobs
        memoryTier:     _currentMemTier(),
        renderScale:    meta && meta.renderScale ? meta.renderScale : 1.0,
        chunkState:     {},       // arbitrary chunk progress data
        state:          'running',
      };

      // Persist immediately
      _save(jid);

      // Schedule auto-saves
      _active[jid]._autoSave = setInterval(function () {
        if (_active[jid]) _save(jid);
      }, AUTO_SAVE_MS);

      _log('job-start', { jid: jid, tool: toolId });
      return jid;
    }

    // Update a running checkpoint
    function updatePage(jid, pageNum, result) {
      var cp = _active[jid];
      if (!cp) return;
      if (result && result.error) {
        if (cp.failedPages.indexOf(pageNum) === -1) cp.failedPages.push(pageNum);
      } else {
        if (cp.completedPages.indexOf(pageNum) === -1) cp.completedPages.push(pageNum);
        if (result && typeof result.confidence === 'number') {
          cp.ocrConfidence[pageNum] = result.confidence;
        }
      }
      cp.updatedAt  = Date.now();
      cp.memoryTier = _currentMemTier();
    }

    function updateChunk(jid, chunkKey, data) {
      var cp = _active[jid];
      if (!cp) return;
      cp.chunkState[chunkKey] = data;
      cp.updatedAt = Date.now();
    }

    function addPartialOutput(jid, opfsKey) {
      var cp = _active[jid];
      if (!cp) return;
      if (cp.partialOutputs.indexOf(opfsKey) === -1) cp.partialOutputs.push(opfsKey);
    }

    // Mark job complete and persist final state
    function completeJob(jid) {
      var cp = _active[jid];
      if (!cp) return Promise.resolve();
      clearInterval(cp._autoSave);
      cp.state     = 'completed';
      cp.updatedAt = Date.now();
      var p = _save(jid);
      delete _active[jid];
      _log('job-complete', { jid: jid });
      return p;
    }

    // Mark job failed
    function failJob(jid, reason) {
      var cp = _active[jid];
      if (cp) {
        clearInterval(cp._autoSave);
        cp.state     = 'failed';
        cp.reason    = reason || 'unknown';
        cp.updatedAt = Date.now();
        _save(jid);
        delete _active[jid];
      }
      _log('job-fail', { jid: jid, reason: reason });
    }

    // Persist current state to IDB
    function _save(jid) {
      var cp = _active[jid];
      if (!cp) return Promise.resolve();
      var rec = Object.assign({}, cp);
      delete rec._autoSave;
      return _dbPut('jobs', rec);
    }

    // Load checkpoint from IDB (for resume)
    function loadCheckpoint(toolId, files) {
      var jid = _jobId(toolId, files);
      return _dbGet('jobs', jid).then(function (rec) {
        if (!rec) return null;
        if (Date.now() - (rec.updatedAt || 0) > STALE_MS) {
          _dbDel('jobs', jid);
          return null;
        }
        if (rec.state === 'completed') return null;  // completed — no resume needed
        return rec;
      });
    }

    // Get all pending (resumable) checkpoints
    function getAllPending() {
      return _dbGetAll('jobs').then(function (all) {
        var now = Date.now();
        return all.filter(function (r) {
          return r.state !== 'completed' && (now - (r.updatedAt || 0)) < STALE_MS;
        });
      });
    }

    // Clear a checkpoint
    function clearCheckpoint(toolId, files) {
      var jid = _jobId(toolId, files);
      delete _active[jid];
      return _dbDel('jobs', jid);
    }

    // Sweep stale checkpoints
    function sweepStale() {
      return _dbGetAll('jobs').then(function (all) {
        var now  = Date.now();
        var cuts = all.filter(function (r) { return now - (r.updatedAt || 0) > STALE_MS; });
        return Promise.all(cuts.map(function (r) { return _dbDel('jobs', r.jobId); })).then(function () {
          _log('sweep', { removed: cuts.length });
          return cuts.length;
        });
      }).catch(function () { return 0; });
    }

    function _currentMemTier() {
      try {
        var mp = window.MemPressure;
        if (mp && typeof mp.tier === 'function') return mp.tier();
      } catch (_) {}
      return 'unknown';
    }

    // Auto-sweep stale checkpoints every 30 min
    setInterval(function () { sweepStale().catch(function () {}); }, 30 * 60 * 1000);

    return {
      startJob:        startJob,
      updatePage:      updatePage,
      updateChunk:     updateChunk,
      addPartialOutput: addPartialOutput,
      completeJob:     completeJob,
      failJob:         failJob,
      loadCheckpoint:  loadCheckpoint,
      getAllPending:    getAllPending,
      clearCheckpoint: clearCheckpoint,
      sweepStale:      sweepStale,
      jobId:           _jobId,
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 33B  CRASH RECOVERY
  // On page load, scans IDB for interrupted (running/failed) jobs and offers
  // the user a resume banner. Resume continues from the last saved page.
  // ═══════════════════════════════════════════════════════════════════════════

  var CrashRecovery = (function () {
    var _pendingJobs    = [];   // detected interrupted jobs
    var _resumeCallbacks = {};  // jobId → fn() that starts resume

    // Call this after the page is ready; shows resume banners for pending jobs
    function scanAndOffer() {
      return CheckpointEngine.getAllPending().then(function (jobs) {
        if (!jobs.length) return [];
        _pendingJobs = jobs;
        _log('pending-jobs', { count: jobs.length });
        jobs.forEach(function (job) { _offerResume(job); });
        return jobs;
      }).catch(function () { return []; });
    }

    function _offerResume(job) {
      // Don't show banner if job is older than 24 hours
      if (Date.now() - (job.updatedAt || 0) > 24 * 60 * 60 * 1000) return;
      if (document.getElementById('p33-resume-' + job.jobId)) return;

      var pct     = job.totalPages > 0
        ? Math.round((job.completedPages.length / job.totalPages) * 100)
        : 0;
      var toolLbl = job.toolId ? job.toolId.replace(/-/g, ' ') : 'job';
      var age     = _fmtAge(Date.now() - (job.updatedAt || 0));

      var banner  = document.createElement('div');
      banner.id   = 'p33-resume-' + job.jobId;
      banner.setAttribute('role', 'alert');
      banner.style.cssText = [
        'position:fixed;bottom:' + (16 + 70 * _pendingJobs.indexOf(job)) + 'px;',
        'left:50%;transform:translateX(-50%);z-index:10001;',
        'background:#0f172a;color:#f1f5f9;padding:12px 16px;border-radius:10px;',
        'display:flex;align-items:center;gap:12px;font-family:inherit;font-size:13px;',
        'box-shadow:0 8px 32px rgba(0,0,0,.4);max-width:520px;width:94%;',
        'border-left:3px solid #7c3aed;',
      ].join('');

      banner.innerHTML =
        '<span style="flex:1">' +
        '<strong style="color:#a78bfa">' + toolLbl.charAt(0).toUpperCase() + toolLbl.slice(1) + '</strong>' +
        ' was interrupted ' + age + ' ago — ' + job.completedPages.length + ' of ' +
        (job.totalPages || '?') + ' pages done (' + pct + '%).<br>' +
        '<small style="opacity:.65">Upload the same file to continue from where you left off.</small></span>' +
        '<button data-jid="' + job.jobId + '" class="p33-yes" style="background:#7c3aed;color:#fff;border:none;' +
        'padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">Resume</button>' +
        '<button data-jid="' + job.jobId + '" class="p33-no" style="background:transparent;color:#64748b;' +
        'border:none;padding:6px 8px;cursor:pointer;font-size:18px;line-height:1">\u00d7</button>';

      document.body.appendChild(banner);

      banner.querySelector('.p33-yes').onclick = function () {
        banner.remove();
        var cb = _resumeCallbacks[job.jobId];
        if (cb) cb(job); else _log('no-resume-cb', { jid: job.jobId });
      };
      banner.querySelector('.p33-no').onclick = function () {
        banner.remove();
        CheckpointEngine.clearCheckpoint(job.toolId, null).catch(function () {});
        _dbDel('jobs', job.jobId).catch(function () {});
      };

      // Auto-dismiss after 30 s
      setTimeout(function () { if (banner.parentNode) banner.remove(); }, 30000);
    }

    function _fmtAge(ms) {
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      return Math.floor(s / 3600) + 'h';
    }

    // Register a callback for a specific job's resume action
    function registerResumeCallback(jobId, fn) {
      _resumeCallbacks[jobId] = fn;
    }

    // Build resume context from a checkpoint (tells engine which pages to skip)
    function buildResumeContext(checkpoint) {
      if (!checkpoint) return null;
      var done = new Set(checkpoint.completedPages || []);
      var fail = new Set(checkpoint.failedPages   || []);
      return {
        jobId:          checkpoint.jobId,
        resumeFromPage: _firstIncomplete(checkpoint),
        completedPages: done,
        failedPages:    fail,
        partialOutputs: checkpoint.partialOutputs || [],
        ocrConfidence:  checkpoint.ocrConfidence  || {},
        shouldSkipPage: function (pageNum) { return done.has(pageNum); },
        shouldRetryPage: function (pageNum) { return fail.has(pageNum); },
      };
    }

    function _firstIncomplete(cp) {
      var done = new Set(cp.completedPages || []);
      for (var i = 1; i <= (cp.totalPages || 9999); i++) {
        if (!done.has(i)) return i;
      }
      return 1;
    }

    function getPendingJobs() { return _pendingJobs.slice(); }

    return {
      scanAndOffer:            scanAndOffer,
      registerResumeCallback:  registerResumeCallback,
      buildResumeContext:      buildResumeContext,
      getPendingJobs:          getPendingJobs,
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 33C  MULTI-DAY PROCESSING ORCHESTRATOR
  // Manages long-running jobs that may span multiple sessions (days/weeks).
  // Adds orphan detection, stale output cleanup, and progress persistence.
  // ═══════════════════════════════════════════════════════════════════════════

  var MultiDayProcessing = (function () {
    // A "long job" is one estimated to take > 5 minutes
    var LONG_JOB_THRESHOLD_MS = 5 * 60 * 1000;
    // Orphan: job that started > 48 hours ago and never completed
    var ORPHAN_AGE_MS = 48 * 60 * 60 * 1000;

    var _registry = {};  // jobId → { startedAt, estimatedMs, segments }

    // Register a job as long-running
    function registerLongJob(jobId, estimatedMs, opts) {
      _registry[jobId] = {
        jobId:       jobId,
        startedAt:   Date.now(),
        estimatedMs: estimatedMs || 0,
        segments:    [],
        opts:        opts || {},
      };
      return _dbPut('jobs', Object.assign({ multiDay: true }, _registry[jobId]));
    }

    // Record completion of a processing segment (chunk of pages)
    function recordSegment(jobId, segmentOpts) {
      if (!_registry[jobId]) return;
      _registry[jobId].segments.push(Object.assign({ ts: Date.now() }, segmentOpts || {}));
    }

    // Detect orphaned jobs and schedule cleanup of their OPFS artifacts
    function cleanupOrphans() {
      return CheckpointEngine.getAllPending().then(function (jobs) {
        var now     = Date.now();
        var orphans = jobs.filter(function (j) {
          return (now - (j.startedAt || 0)) > ORPHAN_AGE_MS;
        });

        return Promise.all(orphans.map(function (j) {
          _log('orphan-cleanup', { jid: j.jobId, age: Math.round((now - j.startedAt) / 3600000) + 'h' });
          // Remove OPFS partial outputs
          if (j.partialOutputs && j.partialOutputs.length && window.OPFSManager) {
            j.partialOutputs.forEach(function (k) {
              try { window.OPFSManager.remove && window.OPFSManager.remove(k); } catch (_) {}
            });
          }
          return _dbDel('jobs', j.jobId);
        }));
      }).catch(function () { return []; });
    }

    // Estimate remaining time based on checkpoint progress
    function estimateRemaining(checkpoint, elapsedMs) {
      if (!checkpoint || !checkpoint.totalPages || !checkpoint.completedPages) return null;
      var done    = checkpoint.completedPages.length;
      var total   = checkpoint.totalPages;
      var remaining = total - done;
      if (done === 0) return null;
      var msPerPage = elapsedMs / done;
      return Math.round(msPerPage * remaining);
    }

    // Nightly cleanup of orphans
    setInterval(function () { cleanupOrphans().catch(function () {}); }, 6 * 60 * 60 * 1000);
    // Initial sweep after a short delay
    setTimeout(function () { cleanupOrphans().catch(function () {}); }, 15000);

    return {
      registerLongJob:   registerLongJob,
      recordSegment:     recordSegment,
      cleanupOrphans:    cleanupOrphans,
      estimateRemaining: estimateRemaining,
    };
  }());


  // ── Integration hook: wrap BrowserTools.process to auto-checkpoint ─────────
  function installPhase33() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__phase33v1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      var arr   = Array.isArray(files) ? files : Array.from(files || []);
      var bytes = arr.reduce(function (s, f) { return s + (f ? f.size : 0); }, 0);

      // Only auto-checkpoint for large or long-running tools
      var CHECKPOINT_TOOLS = {
        'ocr': true, 'ai-summarize': true, 'translate': true,
        'compress': true, 'pdf-to-word': true, 'pdf-to-excel': true,
        'pdf-to-powerpoint': true, 'compare': true, 'repair': true, 'scan-to-pdf': true,
      };

      var jid = null;
      if (CHECKPOINT_TOOLS[toolId] && bytes > 5 * MB) {
        jid = CheckpointEngine.startJob(toolId, arr, { totalPages: opts && opts._totalPages });
      }

      try {
        var result = await upstream(toolId, files, opts);
        if (jid) CheckpointEngine.completeJob(jid).catch(function () {});
        return result;
      } catch (err) {
        if (jid) CheckpointEngine.failJob(jid, err && err.message);
        throw err;
      }
    };

    window.BrowserTools.__phase33v1 = true;
    _log('installed', { version: VERSION });
    return true;
  }

  var _tries = 0;
  if (!installPhase33()) {
    var _iv = setInterval(function () {
      if (installPhase33() || ++_tries > 120) clearInterval(_iv);
    }, 80);
  }

  // Scan for pending jobs after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () { CrashRecovery.scanAndOffer().catch(function () {}); }, 2500);
    });
  } else {
    setTimeout(function () { CrashRecovery.scanAndOffer().catch(function () {}); }, 2500);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  window.Phase33 = {
    version:            VERSION,
    CheckpointEngine:   CheckpointEngine,
    CrashRecovery:      CrashRecovery,
    MultiDayProcessing: MultiDayProcessing,

    // Convenience: check if a job can be resumed before calling process()
    canResume: function (toolId, files) {
      return CheckpointEngine.loadCheckpoint(toolId, files);
    },

    // Build a resume context for an engine to consume
    buildResumeContext: CrashRecovery.buildResumeContext.bind(CrashRecovery),

    audit: function () {
      return CheckpointEngine.getAllPending().then(function (jobs) {
        var report = {
          version:        VERSION,
          installed:      !!(window.BrowserTools && window.BrowserTools.__phase33v1),
          pendingJobs:    jobs.length,
          jobSummaries:   jobs.map(function (j) {
            return {
              tool:      j.toolId,
              pages:     j.completedPages ? j.completedPages.length : 0,
              total:     j.totalPages,
              state:     j.state,
              ageMin:    Math.round((Date.now() - (j.updatedAt || 0)) / 60000),
            };
          }),
        };
        console.group('Phase33 v' + VERSION + ' — Resume Audit');
        console.table(report.jobSummaries.length ? report.jobSummaries : [{ none: 'no pending jobs' }]);
        console.groupEnd();
        return report;
      });
    },
  };

}());
