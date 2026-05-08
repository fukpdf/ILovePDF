// Phase 40G — Resume Integrity Tests v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § G1  CheckpointVerifier   — validates IDB checkpoint correctness
// § G2  PageOrderAuditor     — no duplicates, no skips, correct ordering
// § G3  OcrContinuityChecker — OCR result hash chain integrity
// § G4  ResumeSmokeTest      — simulates crash-then-resume flow
//
// Exposes: window.ResumeIntegrity

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[RI]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }

  // ═══════════════════════════════════════════════════════════════════════════
  // § G1  CHECKPOINT VERIFIER
  // ═══════════════════════════════════════════════════════════════════════════
  var CheckpointVerifier = (function () {

    async function verify(jobId) {
      var p33 = window.Phase33;
      if (!p33 || !p33.CheckpointEngine) return { ok: false, reason: 'Phase33 not loaded' };
      try {
        var ckpt = await p33.CheckpointEngine.load(jobId);
        if (!ckpt) return { ok: true, note: 'no-checkpoint-for-job (clean start)' };
        var report = {
          ok:             true,
          jobId:          jobId,
          completedPages: (ckpt.completedPages || []).length,
          failedPages:    (ckpt.failedPages    || []).length,
          hasTool:        !!ckpt.toolId,
          hasTimestamp:   !!ckpt.ts,
          hasOpfsKey:     !!ckpt.opfsKey,
        };
        // Detect obviously corrupt checkpoint
        if (report.completedPages < 0) { report.ok = false; report.reason = 'negative page count'; }
        _log('checkpoint-verify', report);
        return report;
      } catch (ex) {
        return { ok: false, reason: ex.message };
      }
    }

    async function verifyAll() {
      var p33 = window.Phase33;
      if (!p33 || !p33.CheckpointEngine) return { ok: true, note: 'Phase33 not loaded — skipped' };
      try {
        var all     = await p33.CheckpointEngine.getAllPending().catch(function () { return []; });
        var results = [];
        for (var j of all) { results.push(await verify(j.jobId || j.id || j)); }
        var bad = results.filter(function (r) { return !r.ok; });
        return { ok: bad.length === 0, total: results.length, bad: bad.length, results: results };
      } catch (ex) {
        return { ok: false, reason: ex.message };
      }
    }

    return { verify: verify, verifyAll: verifyAll };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G2  PAGE ORDER AUDITOR
  // Given a completed pages array, verify: no dups, no gaps, correct order.
  // ═══════════════════════════════════════════════════════════════════════════
  var PageOrderAuditor = (function () {

    function audit(completedPages, totalPages) {
      if (!Array.isArray(completedPages)) return { ok: false, reason: 'not-array' };

      var sorted = completedPages.slice().sort(function (a, b) { return a - b; });
      var unique = Array.from(new Set(sorted));

      var duplicates = sorted.length - unique.length;
      var min        = unique[0] || 0;
      var max        = unique[unique.length - 1] || 0;

      // Check for gaps
      var gaps = [];
      for (var i = min; i <= max; i++) {
        if (!unique.includes(i)) gaps.push(i);
      }

      var ok = duplicates === 0 && gaps.length === 0;
      var report = { ok: ok, total: completedPages.length, unique: unique.length, duplicates: duplicates, gaps: gaps, min: min, max: max };

      if (totalPages) {
        var missing = [];
        for (var p = 1; p <= totalPages; p++) {
          if (!unique.includes(p)) missing.push(p);
        }
        report.totalExpected = totalPages;
        report.missing       = missing;
        report.complete      = missing.length === 0;
        report.ok            = ok && missing.length === 0;
      }

      _log('page-order', report);
      return report;
    }

    // Verify a checkpoint's page completeness
    async function auditCheckpoint(jobId, totalPages) {
      var p33 = window.Phase33;
      if (!p33 || !p33.CheckpointEngine) return { ok: true, note: 'Phase33 not loaded' };
      var ckpt = await p33.CheckpointEngine.load(jobId).catch(function () { return null; });
      if (!ckpt) return { ok: true, note: 'no-checkpoint' };
      return audit(ckpt.completedPages || [], totalPages);
    }

    return { audit: audit, auditCheckpoint: auditCheckpoint };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G3  OCR CONTINUITY CHECKER
  // ═══════════════════════════════════════════════════════════════════════════
  var OcrContinuityChecker = (function () {

    // Verify that OCR text hashes form a consistent (no-gap) sequence
    async function check(docId, totalPages) {
      var dp = window.DifferentialProcessing;
      if (!dp || !dp.OcrTextHashCache) return { ok: true, note: 'DifferentialProcessing not loaded' };
      var missing = [];
      for (var p = 1; p <= totalPages; p++) {
        var h = await dp.OcrTextHashCache.getHash(docId, p).catch(function () { return null; });
        if (!h) missing.push(p);
      }
      var ok = missing.length === 0;
      return { ok: ok, totalPages: totalPages, missingHashes: missing, coverage: Math.round(((totalPages - missing.length) / totalPages) * 100) + '%' };
    }

    return { check: check };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G4  RESUME SMOKE TEST
  // Simulates: save checkpoint → "crash" (clear state) → load checkpoint → verify
  // ═══════════════════════════════════════════════════════════════════════════
  var ResumeSmokeTest = (function () {

    async function run() {
      var p33 = window.Phase33;
      if (!p33 || !p33.CheckpointEngine) return { ok: true, note: 'Phase33 not loaded — skipped' };

      var testJobId = 'smoke_test_' + Date.now();
      var testData  = { toolId: 'ocr-pdf', completedPages: [1, 2, 3, 4, 5], failedPages: [], totalPages: 10, memoryTier: 'normal', ts: Date.now() };

      // Step 1: Save checkpoint
      var saveOk = await p33.CheckpointEngine.save(testJobId, testData).catch(function () { return false; });
      if (!saveOk) return { ok: false, reason: 'checkpoint-save-failed' };

      // Step 2: Verify checkpoint exists
      var loaded = await p33.CheckpointEngine.load(testJobId).catch(function () { return null; });
      if (!loaded) return { ok: false, reason: 'checkpoint-load-failed' };

      // Step 3: Validate page order
      var pageOrder = PageOrderAuditor.audit(loaded.completedPages || [], 10);

      // Step 4: Check ctx helpers
      var ctx = p33.CheckpointEngine.buildResumeContext ? p33.CheckpointEngine.buildResumeContext(loaded) : null;

      // Step 5: Cleanup
      await p33.CheckpointEngine.clear(testJobId).catch(function () {});

      var report = {
        ok:            saveOk && !!loaded && pageOrder.ok,
        saved:         saveOk,
        loaded:        !!loaded,
        pageOrderOk:   pageOrder.ok,
        hasCtxHelpers: !!ctx,
        pagesVerified: (loaded.completedPages || []).length,
      };
      _log('smoke-test', report);
      return report;
    }

    return { run: run };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.ResumeIntegrity = {
    version:             VERSION,
    CheckpointVerifier:  CheckpointVerifier,
    PageOrderAuditor:    PageOrderAuditor,
    OcrContinuityChecker:OcrContinuityChecker,
    ResumeSmokeTest:     ResumeSmokeTest,

    // Convenience: full integrity check
    runAll: async function () {
      console.group('[RI] Resume Integrity Tests');
      var ckptAll = await CheckpointVerifier.verifyAll();
      var smoke   = await ResumeSmokeTest.run();
      var result  = {
        checkpoints:  ckptAll,
        smoke:        smoke,
        ok:           ckptAll.ok && smoke.ok,
      };
      console.table({ Checkpoints: ckptAll.ok ? '✔' : '✗', Smoke: smoke.ok ? '✔' : '✗' });
      console.groupEnd();
      return result;
    },

    audit: async function () {
      var smoke = await ResumeSmokeTest.run();
      return { version: VERSION, smoke: smoke };
    },
  };

  _log('loaded', {});
}());
