// OCR Runtime Manager v1.0 — Final Stabilization
// Centralized Tesseract worker lifecycle management:
//   • Single shared worker with idle-TTL teardown (no multiple instances)
//   • Queued request serialization (avoids concurrent OCR OOM on mobile)
//   • Cancellation support per request
//   • Auto-integrate with WorkerLeakDetector
//   • Graceful fallback when Tesseract is unavailable
//
// API: window.OcrRuntimeManager
//   .recognize(imageData, lang, opts)  → Promise<OcrResult>
//   .cancel(requestId)
//   .getStats()
//   .destroy()
(function () {
  'use strict';

  if (window.OcrRuntimeManager) return;

  var TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var IDLE_TTL_MS   = 60 * 1000;   // terminate worker after 60 s idle
  var MAX_QUEUE     = 20;

  var _worker     = null;
  var _workerLang = null;
  var _idleTimer  = null;
  var _queue      = [];
  var _busy       = false;
  var _requestId  = 0;
  var _cancelled  = new Set();

  var _stats = { total: 0, success: 0, failure: 0, cancelled: 0, queued: 0, maxQueue: 0 };

  // ── Load Tesseract ────────────────────────────────────────────────────────
  var _tsPromise = null;
  function _loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (_tsPromise)        return _tsPromise;
    _tsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload  = function () {
        window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract not found after load'));
      };
      s.onerror = function () { reject(new Error('Tesseract script load failed')); };
      document.head.appendChild(s);
    });
    return _tsPromise;
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────────
  async function _ensureWorker(lang) {
    // Re-use existing worker if it matches the requested language
    if (_worker && _workerLang === lang) {
      _resetIdleTimer();
      return _worker;
    }

    // Tear down existing worker before creating a new one
    await _teardown();

    var Tesseract = await _loadTesseract();
    _workerLang = lang;
    _worker = await Tesseract.createWorker(lang, 1, {
      logger: function () {},   // suppress verbose logs
    });

    // Track with WorkerLeakDetector
    if (window.WorkerLeakDetector && _worker && _worker._worker) {
      window.WorkerLeakDetector.track(_worker._worker, 'tesseract-' + lang);
    }

    _resetIdleTimer();
    return _worker;
  }

  function _resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(function () {
      if (!_busy && _queue.length === 0) {
        _teardown();
      }
    }, IDLE_TTL_MS);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerTimeout('OcrRuntimeManager', _idleTimer);
    }
  }

  async function _teardown() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    var w = _worker;
    _worker     = null;
    _workerLang = null;
    if (w) {
      try { await w.terminate(); } catch (_) {}
    }
  }

  // ── Request serialization ─────────────────────────────────────────────────
  async function _processNext() {
    if (_busy || _queue.length === 0) return;
    var item = _queue.shift();

    if (_cancelled.has(item.id)) {
      _cancelled.delete(item.id);
      _stats.cancelled++;
      _processNext();
      return;
    }

    _busy = true;
    var worker;
    try {
      worker = await _ensureWorker(item.lang);

      if (_cancelled.has(item.id)) {
        _cancelled.delete(item.id);
        _stats.cancelled++;
        return;
      }

      if (window.WorkerLeakDetector && worker && worker._worker) {
        window.WorkerLeakDetector.pulse(worker._worker);
      }

      var result = await worker.recognize(item.imageData, {
        tessedit_pageseg_mode: item.opts.psm || '3',
      });

      _stats.success++;
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('ocr-success'); } catch (_) {}
      }
      item.resolve(result.data);

    } catch (err) {
      _stats.failure++;
      console.error('[OcrRuntimeManager] recognize failed:', err);
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('ocr-failure'); } catch (_) {}
      }
      // On error, tear down worker so next request gets a fresh one
      try { await _teardown(); } catch (_) {}
      item.reject(err);

    } finally {
      _busy = false;
      _resetIdleTimer();
      _processNext();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function recognize(imageData, lang, opts) {
    opts = opts || {};
    lang = lang || 'eng';

    if (_queue.length >= MAX_QUEUE) {
      return Promise.reject(new Error('OcrRuntimeManager queue full (' + MAX_QUEUE + ')'));
    }

    _stats.total++;
    _stats.queued++;
    if (_queue.length > _stats.maxQueue) _stats.maxQueue = _queue.length;

    var id = ++_requestId;
    return new Promise(function (resolve, reject) {
      _queue.push({ id: id, imageData: imageData, lang: lang, opts: opts, resolve: resolve, reject: reject });
      _processNext();
    });
  }

  function cancel(requestId) {
    _cancelled.add(requestId);
  }

  function getStats() {
    return Object.assign({}, _stats, { queueLength: _queue.length, busy: _busy, lang: _workerLang });
  }

  function destroy() {
    _queue.forEach(function (item) { item.reject(new Error('OcrRuntimeManager destroyed')); });
    _queue = [];
    _teardown();
  }

  window.addEventListener('pagehide', function () { destroy(); }, { passive: true });

  window.OcrRuntimeManager = { recognize, cancel, getStats, destroy };
  console.debug('[OcrRuntimeManager] ready');
}());
