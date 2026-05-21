/* app-router.js — central per-tool dispatcher.
 *
 * Maps every tool id to either a browser handler (runs locally with pdf-lib,
 * zero upload) or a backend endpoint. The actual UI lives in tool-page.js,
 * which already calls into this same dispatcher; exposing it as window.runTool
 * lets external code, the dashboard "quick action" cards, and any future
 * standalone scripts share one consistent entry point.
 *
 * Behaviour:
 *   - Browser tools → resolved through window.BrowserTools (loaded by
 *     /js/browser-tools.js). Returns a Promise<{ blob, filename }>.
 *   - API tools → POSTs the file as multipart/form-data to the backend
 *     (resolved through window.apiUrl from /js/config.js). Returns a
 *     Promise<Response> for callers that want full control of streaming /
 *     download / json handling.
 *
 * Phase 7J upgrades (Batch J):
 *   - Pre-dispatch behavior analysis gate (automation detection + risk level)
 *   - Session recorder events for every tool dispatch
 *   - Packet integrity header on API fetch calls
 *   - Worker routing registration for browser tool tracking
 *   - Security stream push on dispatch failures
 */
(function () {
  var G = window;

  const browser = (id) => ({ type: 'browser', id });
  const api     = (id, endpoint, field = 'pdf') => ({ type: 'api', id, endpoint, field });

  const TOOL_MAP = {
    // ── Browser tools (pdf-lib, run in the user's tab) ────────────────────
    'merge':         browser('merge'),
    'split':         browser('split'),
    'rotate':        browser('rotate'),
    'crop':          browser('crop'),
    'organize':      browser('organize'),
    'page-numbers':  browser('page-numbers'),
    'watermark':     browser('watermark'),
    'jpg-to-pdf':    browser('jpg-to-pdf'),

    // ── API tools (Express + sharp / pdf-lib / mammoth / HF) ──────────────
    'compress':           api('compress',           '/api/compress'),
    'pdf-to-word':        api('pdf-to-word',        '/api/pdf-to-word'),
    'pdf-to-powerpoint':  api('pdf-to-powerpoint',  '/api/pdf-to-powerpoint'),
    'pdf-to-excel':       api('pdf-to-excel',       '/api/pdf-to-excel'),
    'pdf-to-jpg':         api('pdf-to-jpg',         '/api/pdf-to-jpg'),
    'word-to-pdf':        api('word-to-pdf',        '/api/word-to-pdf'),
    'powerpoint-to-pdf':  api('powerpoint-to-pdf',  '/api/powerpoint-to-pdf'),
    'excel-to-pdf':       api('excel-to-pdf',       '/api/excel-to-pdf'),
    'html-to-pdf':        api('html-to-pdf',        '/api/html-to-pdf'),
    'edit':               api('edit',               '/api/edit'),
    'sign':               api('sign',               '/api/sign'),
    'redact':             api('redact',             '/api/redact'),
    'protect':            api('protect',            '/api/protect'),
    'unlock':             api('unlock',             '/api/unlock'),
    'repair':             api('repair',             '/api/repair'),
    'scan-to-pdf':        api('scan-to-pdf',        '/api/scan-to-pdf', 'images'),
    'ocr':                api('ocr',                '/api/ocr'),
    'compare':            api('compare',            '/api/compare', 'pdfs'),
    'ai-summarize':       api('ai-summarize',       '/api/ai-summarize'),
    'translate':          api('translate',          '/api/translate'),
    'workflow':           api('workflow',           '/api/workflow'),
    'background-remover': api('background-remover', '/api/background-remove', 'image'),
    'crop-image':         api('crop-image',         '/api/crop-image',        'image'),
    'resize-image':       api('resize-image',       '/api/resize-image',      'image'),
    'image-filters':      api('image-filters',      '/api/filters',           'image'),
  };

  // ── Phase 7J: Pre-dispatch behavior analysis gate ─────────────────────────
  // Non-blocking: if Phase 7 systems are not loaded, dispatch proceeds normally.
  // Performs two soft checks and one hard block:
  //   1. Automation detection score > 80 → block + telemetry (hard)
  //   2. Behavior risk CRITICAL → telemetry only (soft, no block)
  //   3. Session recorder → always records every dispatch event (informational)
  function _p7Gate(toolId, fileCount) {
    try {
      // 1. Automation detection — block highly-automated traffic
      var ad = G.RuntimeAutomationDetection;
      if (ad && typeof ad.isAutomated === 'function' && ad.isAutomated()) {
        var autoScore = typeof ad.getScore === 'function' ? ad.getScore() : 100;
        if (autoScore > 80) {
          try {
            if (G.SecurityTelemetry && typeof G.SecurityTelemetry.record === 'function') {
              G.SecurityTelemetry.record('integrity-failure', {
                reason: 'automation-blocked',
                tool: toolId,
                score: autoScore,
              });
            }
            var ss = G.RuntimeSecurityStream;
            if (ss && typeof ss.push === 'function') {
              ss.push('dispatch-blocked', 'app-router', 'WARN',
                'Tool dispatch blocked: automation score ' + autoScore, { toolId: toolId });
            }
          } catch (_) {}
          return false; // hard block for highly-automated sessions
        }
      }

      // 2. Behavior analysis — log CRITICAL risk but do not block tool use
      try {
        var ba = G.RuntimeBehaviorAnalysis;
        if (ba && typeof ba.getRiskLevel === 'function') {
          var risk = ba.getRiskLevel();
          if (risk === 'CRITICAL') {
            if (G.SecurityTelemetry && typeof G.SecurityTelemetry.record === 'function') {
              G.SecurityTelemetry.record('security-anomaly', {
                reason: 'behavior-critical-dispatch',
                tool: toolId,
              });
            }
            var inc = G.RuntimeIncidentEngine;
            if (inc && typeof inc.report === 'function') {
              inc.report('behavior-critical', 70, 'app-router',
                { tool: toolId, risk: risk });
            }
          }
        }
      } catch (_) {}

      // 3. Session recorder — record every tool dispatch for forensic timeline
      try {
        var sr = G.RuntimeSessionRecorder;
        if (sr && typeof sr.record === 'function') {
          sr.record('tool_dispatch', { tool: toolId, files: fileCount, ts: Date.now() });
        }
      } catch (_) {}

    } catch (_) {}
    return true; // allow dispatch by default
  }

  // ── Phase 7J: Packet integrity header injection for API fetch ─────────────
  // Adds an X-Runtime-Packet header containing the signed packet ID so the
  // server can optionally log and correlate client-side execution tickets.
  function _p7WrapFetchOpts(endpoint, fetchOpts) {
    try {
      var pi = G.RuntimePacketIntegrity;
      if (pi && typeof pi.wrap === 'function') {
        var pkt = pi.wrap('api-dispatch', { ep: endpoint.replace(/\?.*/, '') });
        if (pkt && pkt.id) {
          fetchOpts.headers = fetchOpts.headers || {};
          fetchOpts.headers['X-Runtime-Packet'] = pkt.id;
        }
      }
    } catch (_) {}
    return fetchOpts;
  }

  // ── Phase 7J: Worker routing registration for browser tools ───────────────
  // Informs RuntimeWorkerRouting of the capability being used so the mesh
  // can bias future worker allocation toward the in-demand capability.
  function _p7RegisterBrowserDispatch(toolId) {
    try {
      var wr = G.RuntimeWorkerRouting;
      if (wr && typeof wr.route === 'function') {
        wr.route('browser-tool:' + toolId);
      }
    } catch (_) {}
  }

  function resolveBackendUrl(endpoint) {
    if (typeof G.apiUrl === 'function') return G.apiUrl(endpoint);
    return endpoint;
  }

  /** Returns the entry for a tool id, or null. */
  function lookup(toolId) {
    return Object.prototype.hasOwnProperty.call(TOOL_MAP, toolId) ? TOOL_MAP[toolId] : null;
  }

  /**
   * Run a tool by id. Accepts a single File or an array of Files plus an
   * optional options object (passed to BrowserTools handlers, sent as form
   * fields to API handlers).
   *
   * Phase 7J: applies pre-dispatch gate, session recording, packet integrity
   * wrapping, and worker routing registration transparently.
   */
  async function runTool(toolId, files, options) {
    const tool = lookup(toolId);
    if (!tool) throw new Error('Unknown tool: ' + toolId);

    const fileArray = Array.isArray(files) ? files : (files ? [files] : []);
    if (!fileArray.length) throw new Error('No file provided');
    const opts = options || {};

    // Phase 7J: pre-dispatch gate (automation block + behavior log + session record)
    if (!_p7Gate(toolId, fileArray.length)) {
      throw new Error('dispatch_blocked');
    }

    if (tool.type === 'browser') {
      // Phase 7J: register capability with worker routing for mesh telemetry
      _p7RegisterBrowserDispatch(toolId);

      if (!G.BrowserTools || !G.BrowserTools.supports(tool.id)) {
        throw new Error('Browser handler not loaded for ' + tool.id);
      }
      return G.BrowserTools.process(tool.id, fileArray, opts);
    }

    // API path
    const fd = new FormData();
    const field = tool.field || 'pdf';
    if (fileArray.length > 1 || /^(images|pdfs)$/.test(field)) {
      fileArray.forEach((f) => fd.append(field, f));
    } else {
      fd.append(field, fileArray[0]);
    }
    Object.keys(opts).forEach((k) => {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') {
        fd.append(k, opts[k]);
      }
    });

    // Phase 7J: inject packet integrity header into fetch options
    const fetchOpts = _p7WrapFetchOpts(tool.endpoint, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });

    return fetch(resolveBackendUrl(tool.endpoint), fetchOpts);
  }

  G.AppRouter = { TOOL_MAP, lookup, runTool };
  // Convenience global aliases that mirror the spec the user asked for.
  G.TOOL_MAP = TOOL_MAP;
  G.runTool  = runTool;
})();
