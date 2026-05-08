// Phase 35 — Advanced Virtualization Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 35A  TruePageVirtualizer   — viewport-only rendering, rolling thumbnails
// § 35B  PredictiveEviction    — page heat tracking, LRU eviction, GPU cleanup
// § 35C  VirtualAIWindows      — rolling context windows for summarize/translate/compare
//
// Depends on: RollingMemoryWindowManager (Phase32), EvictionManager, MemPressure
// Exposes: window.Phase35

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P35]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  function _yield(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 35A  TRUE PAGE VIRTUALIZER
  // Renders only pages visible in (or near) the current scroll viewport.
  // Pages outside the render window are evicted; thumbnails replace them.
  //
  // Architecture:
  //   • Maintains a DOM container with placeholder <div> elements per page
  //   • Placeholder height = estimated page height (keeps scroll stable)
  //   • IntersectionObserver fires when pages enter/leave viewport
  //   • Visible pages (+2 page lookahead) are rendered at full quality
  //   • Invisible pages are replaced with cached thumbnails or blank placeholders
  // ═══════════════════════════════════════════════════════════════════════════

  var TruePageVirtualizer = (function () {

    // Registry of all active virtualizers (one per viewer instance)
    var _instances = {};
    var _nextId    = 1;

    // Default config
    var DEFAULTS = {
      preRenderAhead:  2,       // pages to pre-render beyond viewport
      thumbnailScale:  0.15,    // thumbnail canvas scale
      placeholderH:    1122,    // A4 page height in pixels at 96dpi
      maxRendered:     8,       // max simultaneously rendered full pages
      debounceMs:      80,      // scroll debounce before re-rendering
    };

    // Create a virtualizer for a scrollable container
    function create(container, pdfDoc, opts) {
      if (!container || !pdfDoc) return null;
      var id  = _nextId++;
      var cfg = Object.assign({}, DEFAULTS, opts || {});

      var inst = {
        id:           id,
        container:    container,
        pdfDoc:       pdfDoc,
        totalPages:   pdfDoc.numPages || 0,
        cfg:          cfg,
        rendered:     {},      // pageNum → { canvas, thumb, element }
        heat:         {},      // pageNum → access count
        renderQueue:  [],
        _observer:    null,
        _scrollTimer: null,
        _destroyed:   false,
      };

      _build(inst);
      _instances[id] = inst;
      _log('created', { id: id, pages: inst.totalPages });
      return { id: id, destroy: function () { _destroy(id); } };
    }

    // Build initial DOM placeholders
    function _build(inst) {
      inst.container.style.cssText += ';position:relative;overflow-y:auto;';
      for (var p = 1; p <= inst.totalPages; p++) {
        var el      = document.createElement('div');
        el.dataset.page = p;
        el.style.cssText = 'width:100%;height:' + inst.cfg.placeholderH + 'px;' +
                           'background:#f8fafc;border-bottom:1px solid #e2e8f0;' +
                           'display:flex;align-items:center;justify-content:center;' +
                           'font-size:12px;color:#94a3b8;box-sizing:border-box;';
        el.textContent = 'Page ' + p;
        inst.container.appendChild(el);
      }

      // IntersectionObserver to detect visible pages
      if (typeof IntersectionObserver !== 'undefined') {
        inst._observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            var pg = parseInt(e.target.dataset.page, 10);
            if (e.isIntersecting) {
              _enqueueRender(inst, pg);
            } else {
              _scheduleEvict(inst, pg);
            }
          });
        }, { root: inst.container, rootMargin: '200px' });

        Array.from(inst.container.children).forEach(function (el) {
          inst._observer.observe(el);
        });
      }
    }

    function _enqueueRender(inst, pageNum) {
      if (inst._destroyed) return;
      if (inst.rendered[pageNum]) {
        inst.heat[pageNum] = (inst.heat[pageNum] || 0) + 1;
        return;
      }
      if (inst.renderQueue.indexOf(pageNum) === -1) {
        inst.renderQueue.push(pageNum);
        // Also enqueue look-ahead pages
        for (var a = 1; a <= inst.cfg.preRenderAhead; a++) {
          var next = pageNum + a;
          if (next <= inst.totalPages && inst.renderQueue.indexOf(next) === -1 && !inst.rendered[next]) {
            inst.renderQueue.push(next);
          }
        }
        _drainQueue(inst);
      }
    }

    async function _drainQueue(inst) {
      if (inst._draining) return;
      inst._draining = true;
      while (inst.renderQueue.length > 0 && !inst._destroyed) {
        // Enforce max rendered limit
        var renderedCount = Object.keys(inst.rendered).length;
        if (renderedCount >= inst.cfg.maxRendered) {
          _evictLRU(inst);
        }
        var pg = inst.renderQueue.shift();
        await _renderPage(inst, pg);
        await _yield(16);
      }
      inst._draining = false;
    }

    async function _renderPage(inst, pageNum) {
      if (inst._destroyed || inst.rendered[pageNum]) return;
      try {
        var page     = await inst.pdfDoc.getPage(pageNum);
        var viewport = page.getViewport({ scale: 1.2 });
        var canvas   = document.createElement('canvas');
        canvas.width  = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        page.cleanup();

        // Render thumbnail
        var tScale   = inst.cfg.thumbnailScale;
        var tCvs     = document.createElement('canvas');
        tCvs.width   = Math.floor(canvas.width  * tScale);
        tCvs.height  = Math.floor(canvas.height * tScale);
        var tCtx     = tCvs.getContext('2d');
        tCtx.drawImage(canvas, 0, 0, tCvs.width, tCvs.height);

        // Find and update the placeholder element
        var el = inst.container.querySelector('[data-page="' + pageNum + '"]');
        if (el) {
          el.style.height = canvas.height + 'px';
          el.innerHTML    = '';
          canvas.style.cssText = 'width:100%;height:auto;display:block;';
          el.appendChild(canvas);
        }

        inst.rendered[pageNum] = { canvas: canvas, thumb: tCvs, element: el };
        inst.heat[pageNum]     = (inst.heat[pageNum] || 0) + 1;
      } catch (ex) {
        _err('render-page', { page: pageNum, err: String(ex && ex.message || ex) });
      }
    }

    function _scheduleEvict(inst, pageNum) {
      // Don't evict recently heated pages
      if ((inst.heat[pageNum] || 0) > 3) return;
      setTimeout(function () {
        if (inst._destroyed) return;
        _evictPage(inst, pageNum);
      }, 2000);
    }

    function _evictPage(inst, pageNum) {
      var r = inst.rendered[pageNum];
      if (!r) return;
      try {
        // Replace canvas with thumbnail to maintain scroll height
        if (r.element && r.thumb) {
          r.element.innerHTML = '';
          var img = new Image();
          img.src = r.thumb.toDataURL('image/jpeg', 0.5);
          img.style.cssText = 'width:100%;height:auto;display:block;opacity:0.7;';
          r.element.appendChild(img);
        }
        // Destroy canvas
        if (r.canvas) { r.canvas.width = 0; r.canvas.height = 0; }
        if (r.thumb)  { r.thumb.width  = 0; r.thumb.height  = 0; }
        r.canvas = null; r.thumb = null;
      } catch (_) {}
      delete inst.rendered[pageNum];
      _log('evicted', { id: inst.id, page: pageNum });
    }

    function _evictLRU(inst) {
      var pages   = Object.keys(inst.rendered).map(Number);
      var heats   = inst.heat;
      var sorted  = pages.sort(function (a, b) { return (heats[a] || 0) - (heats[b] || 0); });
      if (sorted.length > 0) _evictPage(inst, sorted[0]);
    }

    function _destroy(id) {
      var inst = _instances[id];
      if (!inst) return;
      inst._destroyed = true;
      if (inst._observer) { inst._observer.disconnect(); inst._observer = null; }
      Object.keys(inst.rendered).forEach(function (p) { _evictPage(inst, Number(p)); });
      delete _instances[id];
      _log('destroyed', { id: id });
    }

    function getStats() {
      var out = {};
      Object.keys(_instances).forEach(function (id) {
        var inst = _instances[id];
        out[id] = { rendered: Object.keys(inst.rendered).length, total: inst.totalPages };
      });
      return out;
    }

    return { create: create, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 35B  PREDICTIVE EVICTION MANAGER
  // Tracks per-page access "heat" across all open documents and proactively
  // evicts cold pages before memory pressure events occur.
  //
  // Heat model: each page access increments its heat score; scores decay over
  // time. Pages with heat < threshold are candidates for eviction.
  // ═══════════════════════════════════════════════════════════════════════════

  var PredictiveEviction = (function () {
    var DECAY_INTERVAL_MS = 5000;
    var DECAY_FACTOR      = 0.85;   // heat multiplied by this each interval
    var EVICT_THRESHOLD   = 0.3;    // pages with heat < this are evicted first
    var CHECK_INTERVAL_MS = 8000;   // check for eviction candidates every 8s

    // Registry: docId → { pages: { pageNum → heat } }
    var _docs = {};

    function trackAccess(docId, pageNum) {
      if (!_docs[docId]) _docs[docId] = { pages: {} };
      var p = _docs[docId].pages;
      p[pageNum] = Math.min(1, (p[pageNum] || 0) + 0.2);
    }

    function getHeat(docId, pageNum) {
      return (_docs[docId] && _docs[docId].pages[pageNum]) || 0;
    }

    // Returns pages sorted coldest-first (eviction order)
    function evictionOrder(docId) {
      if (!_docs[docId]) return [];
      var pages = _docs[docId].pages;
      return Object.keys(pages).map(Number).sort(function (a, b) {
        return (pages[a] || 0) - (pages[b] || 0);
      });
    }

    // Proactively evict when memory pressure is elevated
    function _checkAndEvict() {
      try {
        var mp = window.MemPressure;
        if (!mp || typeof mp.tier !== 'function') return;
        var tier = mp.tier();
        if (tier !== 'elevated' && tier !== 'high' && tier !== 'danger' && tier !== 'critical') return;

        // Use Phase32's RollingMemoryWindowManager if available
        var rmwm = window.Phase32 && window.Phase32.RollingMemoryWindowManager;

        Object.keys(_docs).forEach(function (docId) {
          var order = evictionOrder(docId);
          var cold  = order.filter(function (p) { return getHeat(docId, p) < EVICT_THRESHOLD; });
          cold.slice(0, 3).forEach(function (p) {
            if (rmwm) rmwm.release(p);
            _log('predictive-evict', { docId: docId, page: p, heat: getHeat(docId, p) });
          });
        });

        // Also flush EvictionManager if available
        if (window.EvictionManager && typeof window.EvictionManager.flush === 'function') {
          window.EvictionManager.flush();
        }
      } catch (ex) {
        _err('check-evict', ex);
      }
    }

    // Decay all heat scores periodically
    function _decay() {
      Object.keys(_docs).forEach(function (docId) {
        var pages = _docs[docId].pages;
        Object.keys(pages).forEach(function (p) {
          pages[p] = pages[p] * DECAY_FACTOR;
          if (pages[p] < 0.01) delete pages[p];
        });
        if (!Object.keys(pages).length) delete _docs[docId];
      });
    }

    function reset(docId) {
      if (docId) delete _docs[docId];
      else _docs = {};
    }

    function getStats() {
      var out = {};
      Object.keys(_docs).forEach(function (id) {
        out[id] = { trackedPages: Object.keys(_docs[id].pages).length };
      });
      return out;
    }

    setInterval(_decay,        DECAY_INTERVAL_MS);
    setInterval(_checkAndEvict, CHECK_INTERVAL_MS);

    return { trackAccess: trackAccess, getHeat: getHeat, evictionOrder: evictionOrder, reset: reset, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 35C  VIRTUAL AI WINDOWS
  // For AI tools (summarize, translate, compare) that process large documents
  // in chunks, maintains a rolling context window that aggregates partial
  // results without retaining all source text in RAM.
  //
  // Features:
  //   • Chunk-level text streaming
  //   • Rolling aggregation (intermediate summaries)
  //   • Partial embedding cache
  //   • Adaptive batch sizing from AutoTuner / MemPressure
  // ═══════════════════════════════════════════════════════════════════════════

  var VirtualAIWindows = (function () {
    // Default context window: last N page-texts kept for next chunk's context
    var DEFAULT_CONTEXT_PAGES = 3;
    var MAX_CHUNK_CHARS       = 4000;

    // Active windows: toolId → WindowState
    var _windows = {};

    function create(toolId, opts) {
      _windows[toolId] = {
        toolId:        toolId,
        contextPages:  (opts && opts.contextPages) || DEFAULT_CONTEXT_PAGES,
        maxChunkChars: (opts && opts.maxChunkChars) || MAX_CHUNK_CHARS,
        pages:         [],        // ring buffer of recent page texts
        chunks:        [],        // completed chunk summaries
        embeddings:    [],        // partial vector embeddings (if applicable)
        totalChars:    0,
        processedPages: 0,
        startedAt:     Date.now(),
      };
      _log('ai-window-create', { toolId: toolId });
      return _windows[toolId];
    }

    // Feed the next page's text into the window
    function feedPage(toolId, pageNum, text) {
      var w = _windows[toolId];
      if (!w) return;
      w.pages.push({ pageNum: pageNum, text: text || '' });
      w.totalChars    += (text || '').length;
      w.processedPages++;
      // Trim ring buffer
      if (w.pages.length > w.contextPages + 2) w.pages.shift();
    }

    // Get the current context window (last N pages) as a single string
    function getContext(toolId) {
      var w = _windows[toolId];
      if (!w) return '';
      return w.pages.slice(-w.contextPages).map(function (p) { return p.text; }).join('\n\n');
    }

    // Build the next AI chunk payload, respecting maxChunkChars
    function buildChunk(toolId, fromPage, toPage) {
      var w = _windows[toolId];
      if (!w) return '';
      var relevant = w.pages.filter(function (p) {
        return p.pageNum >= fromPage && p.pageNum <= toPage;
      });
      var text = relevant.map(function (p) { return p.text; }).join('\n\n');
      // Truncate to maxChunkChars
      return text.length > w.maxChunkChars ? text.slice(0, w.maxChunkChars) + '\u2026' : text;
    }

    // Save a chunk's AI result (intermediate summary / translation)
    function saveChunkResult(toolId, chunkIdx, result) {
      var w = _windows[toolId];
      if (!w) return;
      w.chunks[chunkIdx] = { result: result, ts: Date.now() };
    }

    // Aggregate all chunk results into final output
    function aggregate(toolId, separator) {
      var w = _windows[toolId];
      if (!w) return '';
      sep = separator || '\n\n';
      return w.chunks
        .filter(function (c) { return c && c.result; })
        .map(function (c) { return c.result; })
        .join(sep);
    }

    // Close and clean up a window
    function close(toolId) {
      var w = _windows[toolId];
      if (w) {
        w.pages  = [];
        w.chunks = [];
        delete _windows[toolId];
        _log('ai-window-close', { toolId: toolId });
      }
    }

    function getStats() {
      var out = {};
      Object.keys(_windows).forEach(function (k) {
        var w = _windows[k];
        out[k] = { processedPages: w.processedPages, chunks: w.chunks.length, chars: w.totalChars };
      });
      return out;
    }

    // Adaptive batch size: fewer pages per chunk when memory is low
    function adaptiveBatch(basePages) {
      try {
        var mp = window.MemPressure;
        if (mp && typeof mp.tier === 'function') {
          var t = mp.tier();
          if (t === 'critical') return 1;
          if (t === 'danger')   return 2;
          if (t === 'high')     return 3;
        }
      } catch (_) {}
      return basePages || 5;
    }

    return { create: create, feedPage: feedPage, getContext: getContext, buildChunk: buildChunk,
             saveChunkResult: saveChunkResult, aggregate: aggregate, close: close,
             getStats: getStats, adaptiveBatch: adaptiveBatch };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  window.Phase35 = {
    version: VERSION,

    TruePageVirtualizer: TruePageVirtualizer,
    PredictiveEviction:  PredictiveEviction,
    VirtualAIWindows:    VirtualAIWindows,

    // Create a virtualizer for a PDF viewer container
    createViewer: function (container, pdfDoc, opts) {
      return TruePageVirtualizer.create(container, pdfDoc, opts);
    },

    // Open an AI context window for a tool
    openAIWindow: function (toolId, opts) {
      return VirtualAIWindows.create(toolId, opts);
    },

    audit: function () {
      var report = {
        version:         VERSION,
        viewerInstances: TruePageVirtualizer.getStats(),
        heatTracking:    PredictiveEviction.getStats(),
        aiWindows:       VirtualAIWindows.getStats(),
        hasIntersectionObserver: typeof IntersectionObserver !== 'undefined',
      };
      console.group('Phase35 v' + VERSION + ' — Virtualization Audit');
      console.log('Viewer instances:', report.viewerInstances);
      console.log('Heat tracking:',   report.heatTracking);
      console.log('AI windows:',      report.aiWindows);
      console.groupEnd();
      return report;
    },
  };

}());
