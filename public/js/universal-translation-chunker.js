// Phase 41B — Universal Smart Chunk Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 41B-1  LanguageAwareChunker       — script-aware safe text splitting
// § 41B-2  AdaptiveChunkSizer         — dynamic chunk size by language + device
// § 41B-3  QueryOverflowProtector     — prevent API overflow and memory spikes
// § 41B-4  StreamingTranslationQueue  — queue-based progressive chunk translation
// § 41B-5  ResumeSafeChunkState       — IDB-backed chunk state for crash recovery
//
// Exposes: window.UniversalTranslationChunker

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41B]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41B-2  ADAPTIVE CHUNK SIZER
  // Dynamic chunk sizing based on language complexity and device tier.
  // ═══════════════════════════════════════════════════════════════════════════

  var AdaptiveChunkSizer = (function () {

    // Language-specific chunk size limits (chars) — CJK tokens are shorter per char
    var LANG_LIMITS = {
      cjk:    300,  // CJK: 1 char ≈ 1 token; smaller chunks for API safety
      arabic: 350,  // Arabic: right-to-left, morphologically complex
      hebrew: 350,
      indic:  380,  // Indic: complex script, medium chunks
      thai:   350,  // Thai: no word breaks
      cyril:  450,  // Cyrillic: similar token density to Latin
      latin:  490,  // Latin: standard
      default: 450,
    };

    var MIN_CHUNK  = 80;
    var MAX_CHUNK  = 2000;
    var MYMEMORY_LIMIT = 490; // MyMemory API hard limit ~500 chars

    function getDeviceTier() {
      try {
        if (window.Phase31 && window.Phase31.AutoTuner && window.Phase31.AutoTuner.profile) {
          return window.Phase31.AutoTuner.profile.tier || 'medium';
        }
        var cores = navigator.hardwareConcurrency || 2;
        if (cores <= 2) return 'low';
        if (cores <= 4) return 'medium';
        return 'high';
      } catch (_) { return 'medium'; }
    }

    function getMemPressure() {
      try {
        if (window.MemPressure) return window.MemPressure.tier();
        var mem = performance && performance.memory;
        if (mem && mem.usedJSHeapSize > 700 * 1024 * 1024) return 'low';
        return 'normal';
      } catch (_) { return 'normal'; }
    }

    function computeChunkSize(script, apiTarget) {
      // API-bound: never exceed API limit
      var base = LANG_LIMITS[script] || LANG_LIMITS.default;
      var limit = apiTarget ? Math.min(base, MYMEMORY_LIMIT) : base;

      // Device tier adjustment
      var tier = getDeviceTier();
      if (tier === 'low')    limit = Math.round(limit * 0.7);
      if (tier === 'medium') limit = Math.round(limit * 0.85);

      // Memory pressure adjustment
      var mem = getMemPressure();
      if (mem === 'low' || mem === 'critical') limit = Math.round(limit * 0.6);

      return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, limit));
    }

    return { computeChunkSize: computeChunkSize, MYMEMORY_LIMIT: MYMEMORY_LIMIT, MIN_CHUNK: MIN_CHUNK, MAX_CHUNK: MAX_CHUNK };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41B-1  LANGUAGE-AWARE CHUNKER
  // Splits text into translation-safe chunks respecting script boundaries.
  // ═══════════════════════════════════════════════════════════════════════════

  var LanguageAwareChunker = (function () {

    // Unicode grapheme cluster awareness: never split inside combining sequences
    var COMBINING = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/;

    // CJK sentence terminators (CJK fullstop, ideographic period, etc.)
    var CJK_TERMINATORS = /[。！？；\u3002\uFF01\uFF1F\uFF1B]/g;

    // Arabic sentence terminators
    var ARABIC_TERMINATORS = /[.!?؟،\n]/g;

    // Thai has no spaces — split by sentence-like patterns or length
    var THAI_RANGE = /[\u0E00-\u0E7F]/;

    function detectScript(text) {
      if (!text) return 'latin';
      var sample = text.slice(0, 300);
      var cjk    = (sample.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
      var arabic = (sample.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
      var hebrew = (sample.match(/[\u0590-\u05FF]/g) || []).length;
      var thai   = (sample.match(/[\u0E00-\u0E7F]/g) || []).length;
      var indic  = (sample.match(/[\u0900-\u0D7F]/g) || []).length;
      var cyril  = (sample.match(/[\u0400-\u04FF]/g) || []).length;
      var latin  = (sample.match(/[a-zA-Z\u00C0-\u024F]/g) || []).length;
      var total  = cjk + arabic + hebrew + thai + indic + cyril + latin || 1;
      if (cjk / total    > 0.15) return 'cjk';
      if (arabic / total > 0.15) return 'arabic';
      if (hebrew / total > 0.15) return 'hebrew';
      if (thai / total   > 0.15) return 'thai';
      if (indic / total  > 0.15) return 'indic';
      if (cyril / total  > 0.15) return 'cyril';
      return 'latin';
    }

    // Split CJK text: chunk by sentence terminators, then by length
    function splitCjk(text, maxLen) {
      var chunks = [];
      var parts  = text.split(CJK_TERMINATORS);
      var cur    = '';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        var candidate = cur ? cur + p : p;
        if (candidate.length > maxLen && cur) {
          chunks.push(cur.trim());
          cur = p;
        } else {
          cur = candidate;
        }
      }
      if (cur.trim()) chunks.push(cur.trim());
      // Further split any oversized chunks by character count
      var final = [];
      for (var j = 0; j < chunks.length; j++) {
        if (chunks[j].length > maxLen) {
          var sub = hardSplit(chunks[j], maxLen);
          for (var k = 0; k < sub.length; k++) final.push(sub[k]);
        } else {
          final.push(chunks[j]);
        }
      }
      return final;
    }

    // Split Arabic/Hebrew RTL text: sentence-aware
    function splitRtl(text, maxLen) {
      var parts = text.split(/([.!?؟،\n]+)/);
      return buildChunksFromParts(parts, maxLen);
    }

    // Split Thai: no word boundaries, split on newline or length
    function splitThai(text, maxLen) {
      var lines = text.split(/\n+/);
      var chunks = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        if (line.length <= maxLen) {
          chunks.push(line);
        } else {
          // Hard split at maxLen, respecting Thai grapheme clusters
          var sub = hardSplit(line, maxLen);
          for (var j = 0; j < sub.length; j++) chunks.push(sub[j]);
        }
      }
      return chunks;
    }

    // Standard Latin/Cyrillic/Indic: sentence-aware splitting
    function splitLatin(text, maxLen) {
      var sents = text.match(/[^.!?\n]{3,}[.!?]+(?:\s|$)|[^.!?\n]{10,}(?:\n|$)|[^.!?\n]{3,}/g) || [text];
      return buildChunksFromParts(sents, maxLen);
    }

    function buildChunksFromParts(parts, maxLen) {
      var chunks = [];
      var cur    = '';
      for (var i = 0; i < parts.length; i++) {
        var p = (parts[i] || '').trim();
        if (!p) continue;
        var candidate = cur ? cur + ' ' + p : p;
        if (candidate.length > maxLen && cur) {
          chunks.push(cur.trim());
          cur = p.length > maxLen ? hardSplit(p, maxLen)[0] : p;
          // If p was oversized, append remaining sub-chunks
          if (p.length > maxLen) {
            var sub = hardSplit(p, maxLen);
            chunks.push(sub[0]);
            cur = sub.slice(1).join(' ');
          }
        } else {
          cur = candidate;
        }
      }
      if (cur.trim()) chunks.push(cur.trim());
      return chunks;
    }

    // Hard-split at maxLen, being careful not to break surrogate pairs or combining marks
    function hardSplit(text, maxLen) {
      var chunks = [];
      var start  = 0;
      while (start < text.length) {
        var end = Math.min(start + maxLen, text.length);
        // Don't break inside a surrogate pair
        if (end < text.length) {
          var c = text.charCodeAt(end - 1);
          if (c >= 0xD800 && c <= 0xDBFF) end--; // high surrogate at boundary
          // Don't break before a combining char
          while (end > start && COMBINING.test(text[end])) end--;
        }
        if (end <= start) end = start + maxLen; // safety: advance anyway
        chunks.push(text.slice(start, end).trim());
        start = end;
      }
      return chunks.filter(function (c) { return c.length > 0; });
    }

    function chunk(text, opts) {
      opts = opts || {};
      if (!text || typeof text !== 'string') return [];

      var script  = opts.script || detectScript(text);
      var maxLen  = opts.maxLen || AdaptiveChunkSizer.computeChunkSize(script, opts.apiTarget !== false);
      var chunks;

      switch (script) {
        case 'cjk':    chunks = splitCjk(text, maxLen);   break;
        case 'arabic':
        case 'hebrew': chunks = splitRtl(text, maxLen);   break;
        case 'thai':   chunks = splitThai(text, maxLen);  break;
        default:       chunks = splitLatin(text, maxLen); break;
      }

      // Filter empty chunks
      chunks = chunks.filter(function (c) { return c && c.trim().length > 0; });

      _log('chunks-created', { script: script, maxLen: maxLen, count: chunks.length, totalChars: text.length });
      return chunks;
    }

    return { chunk: chunk, detectScript: detectScript, hardSplit: hardSplit };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41B-3  QUERY OVERFLOW PROTECTOR
  // Prevents API overflow and browser memory spikes from giant documents.
  // ═══════════════════════════════════════════════════════════════════════════

  var QueryOverflowProtector = (function () {

    var API_HARD_LIMIT = 490;  // MyMemory absolute max
    var MEMORY_WARN_MB = 500;  // Warn if chunks would occupy > 500 MB equivalent

    function isOverLimit(chunk, limit) {
      return (chunk || '').length > (limit || API_HARD_LIMIT);
    }

    function truncateSafe(chunk, limit) {
      limit = limit || API_HARD_LIMIT;
      if (!chunk || chunk.length <= limit) return chunk;
      // Find last safe break point (space/newline/sentence end) before limit
      var cut = limit;
      while (cut > limit * 0.7) {
        var c = chunk[cut];
        if (!c) break;
        if (c === ' ' || c === '\n' || c === '.' || c === '?' || c === '!') break;
        cut--;
      }
      return chunk.slice(0, cut).trim();
    }

    function protect(chunks, opts) {
      opts = opts || {};
      var limit   = opts.limit || API_HARD_LIMIT;
      var maxChunks = opts.maxChunks || 5000; // cap number of API calls
      var result  = [];

      for (var i = 0; i < chunks.length && result.length < maxChunks; i++) {
        var c = chunks[i];
        if (isOverLimit(c, limit)) {
          // Recursively split oversized chunk
          var sub = LanguageAwareChunker.hardSplit(c, limit);
          for (var j = 0; j < sub.length && result.length < maxChunks; j++) {
            if (sub[j].trim()) result.push(sub[j].trim());
          }
        } else if (c && c.trim()) {
          result.push(c.trim());
        }
      }

      if (chunks.length > maxChunks) {
        _log('overflow-protected', { originalCount: chunks.length, cappedTo: maxChunks });
      }

      return result;
    }

    return { protect: protect, isOverLimit: isOverLimit, truncateSafe: truncateSafe, API_HARD_LIMIT: API_HARD_LIMIT };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41B-4  STREAMING TRANSLATION QUEUE
  // Queue-based progressive chunk translation with main-thread yielding.
  // ═══════════════════════════════════════════════════════════════════════════

  var StreamingTranslationQueue = (function () {

    var YIELD_INTERVAL = 5;   // yield to main thread every N chunks
    var BATCH_DELAY_MS = 10;  // ms delay between batches

    function yieldToMain() {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    function delay(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms || BATCH_DELAY_MS); });
    }

    // Process all chunks through translateFn, yielding every YIELD_INTERVAL chunks.
    // translateFn(chunk, index, total) → Promise<string>
    // onProgress(done, total, chunk) — optional progress callback
    async function process(chunks, translateFn, opts) {
      opts = opts || {};
      var results   = new Array(chunks.length).fill(null);
      var failCount = 0;
      var retryMap  = opts.retryMap || {};

      for (var i = 0; i < chunks.length; i++) {
        // Yield to main thread periodically
        if (i > 0 && i % YIELD_INTERVAL === 0) {
          await yieldToMain();
          await delay(opts.batchDelayMs || BATCH_DELAY_MS);
        }

        // Check memory pressure before each chunk
        try {
          if (window.MemPressure && (window.MemPressure.tier() === 'critical' || window.MemPressure.tier() === 'abort')) {
            _log('queue-memory-pause', { index: i, tier: window.MemPressure.tier() });
            await delay(500);
          }
        } catch (_) {}

        var chunk  = chunks[i];
        var retries = retryMap[i] || 0;
        var translated = null;

        // Attempt translation with retries
        for (var attempt = 0; attempt <= retries + 1; attempt++) {
          try {
            translated = await translateFn(chunk, i, chunks.length);
            break;
          } catch (err) {
            if (attempt < retries) {
              await delay(300 * (attempt + 1));
            } else {
              _err('chunk-translate-fail', { index: i, attempt: attempt, err: String(err && err.message || err) });
              translated = null;
              failCount++;
            }
          }
        }

        results[i] = translated !== null ? translated : chunk; // fallback to original

        if (opts.onProgress) {
          try { opts.onProgress(i + 1, chunks.length, chunk); } catch (_) {}
        }

        // Checkpoint if available
        if (opts.jobId && window.Phase33 && window.Phase33.CheckpointEngine) {
          try {
            window.Phase33.CheckpointEngine.savePageCheckpoint(opts.jobId, i, { translated: results[i] }).catch(function () {});
          } catch (_) {}
        }
      }

      _log('queue-complete', { total: chunks.length, failCount: failCount });
      return { results: results, failCount: failCount };
    }

    return { process: process, yieldToMain: yieldToMain };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41B-5  RESUME-SAFE CHUNK STATE
  // IDB-backed persistent chunk state for giant document resume.
  // ═══════════════════════════════════════════════════════════════════════════

  var ResumeSafeChunkState = (function () {

    var DB_NAME = 'p41b-chunk-state-v1';
    var STORE   = 'chunks';
    var TTL_MS  = 4 * 60 * 60 * 1000; // 4-hour TTL
    var _db     = null;

    function _open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        try {
          var req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = function (e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(STORE))
              db.createObjectStore(STORE, { keyPath: 'k' });
          };
          req.onsuccess = function () { _db = req.result; res(_db); };
          req.onerror   = function () { rej(req.error); };
        } catch (ex) { rej(ex); }
      });
    }

    function _put(key, data) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ k: key, d: data, ts: Date.now() });
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    function _get(key) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).get(key);
            req.onsuccess = function () {
              var r = req.result;
              if (!r || Date.now() - r.ts > TTL_MS) return res(null);
              res(r.d);
            };
            req.onerror = function () { res(null); };
          } catch (_) { res(null); }
        });
      }).catch(function () { return null; });
    }

    function _del(key) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    // Save state for a translation job
    function saveState(jobId, chunkIndex, data) {
      var key = 'job_' + jobId + '_chunk_' + chunkIndex;
      return _put(key, data);
    }

    // Load state for a chunk (returns null if not found / expired)
    function loadState(jobId, chunkIndex) {
      var key = 'job_' + jobId + '_chunk_' + chunkIndex;
      return _get(key);
    }

    // Clear all state for a job
    function clearJob(jobId) {
      // We clear by prefix — iterate all entries
      return _open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction(STORE, 'readwrite');
            var req = tx.objectStore(STORE).openCursor();
            req.onsuccess = function (e) {
              var cur = e.target.result;
              if (!cur) return res(true);
              if (cur.key.indexOf('job_' + jobId + '_') === 0) cur.delete();
              cur.continue();
            };
            req.onerror = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    // Hash a chunk to detect changes between sessions
    function hashChunk(text) {
      if (!text) return '0';
      var h = 0;
      for (var i = 0; i < Math.min(text.length, 200); i++) {
        h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16);
    }

    return { saveState: saveState, loadState: loadState, clearJob: clearJob, hashChunk: hashChunk };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.UniversalTranslationChunker
  // ═══════════════════════════════════════════════════════════════════════════

  window.UniversalTranslationChunker = {
    version:                 VERSION,
    LanguageAwareChunker:    LanguageAwareChunker,
    AdaptiveChunkSizer:      AdaptiveChunkSizer,
    QueryOverflowProtector:  QueryOverflowProtector,
    StreamingTranslationQueue: StreamingTranslationQueue,
    ResumeSafeChunkState:    ResumeSafeChunkState,

    // Convenience: chunk + protect in one call
    chunkText: function (text, opts) {
      var chunks = LanguageAwareChunker.chunk(text, opts);
      return QueryOverflowProtector.protect(chunks, opts);
    },

    // Convenience: run streaming translation
    translateChunks: function (chunks, translateFn, opts) {
      return StreamingTranslationQueue.process(chunks, translateFn, opts);
    },

    audit: function () {
      console.group('UniversalTranslationChunker v' + VERSION);
      console.log('LanguageAwareChunker:  ready');
      console.log('AdaptiveChunkSizer:    MYMEMORY_LIMIT=' + AdaptiveChunkSizer.MYMEMORY_LIMIT);
      console.log('QueryOverflowProtector: API_HARD_LIMIT=' + QueryOverflowProtector.API_HARD_LIMIT);
      console.log('StreamingTranslationQueue: yield_interval=5');
      console.log('ResumeSafeChunkState:  IDB-backed, 4h TTL');
      console.groupEnd();
    },
  };

  _log('ready', { version: VERSION });

}());
