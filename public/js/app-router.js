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
 * IMPORTANT: this module is purposefully framework-free and side-effect-free
 * so it can be loaded on any page. It DOES NOT touch the DOM. Pages that
 * need a UI for a tool should use tool-page.js instead.
 */
(function () {
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

  function resolveBackendUrl(endpoint) {
    if (typeof window.apiUrl === 'function') return window.apiUrl(endpoint);
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
   */
  async function runTool(toolId, files, options) {
    const tool = lookup(toolId);
    if (!tool) throw new Error('Unknown tool: ' + toolId);

    const fileArray = Array.isArray(files) ? files : (files ? [files] : []);
    if (!fileArray.length) throw new Error('No file provided');
    const opts = options || {};

    if (tool.type === 'browser') {
      if (!window.BrowserTools || !window.BrowserTools.supports(tool.id)) {
        throw new Error('Browser handler not loaded for ' + tool.id);
      }
      return window.BrowserTools.process(tool.id, fileArray, opts);
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
    return fetch(resolveBackendUrl(tool.endpoint), {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
  }

  window.AppRouter = { TOOL_MAP, lookup, runTool };
  // Convenience global aliases that mirror the spec the user asked for.
  window.TOOL_MAP = TOOL_MAP;
  window.runTool  = runTool;
})();
