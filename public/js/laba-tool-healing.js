/**
 * LABA SELF-HEALING TOOL INTELLIGENCE  v3.0
 * window.LabaToolHealing
 *
 * Detects failed tool flows, retries with alternative strategies,
 * switches execution methods, recovers corrupted workflows,
 * and validates output quality.
 */
(function () {
  'use strict';
  if (window.LabaToolHealing) return;

  var LOG = '[LSTH]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Failure Registry ─────────────────────────────────────────────────────
  var _failRegistry = {}; // toolId → { count, lastTs, strategy }

  // ── Strategy Fallbacks ────────────────────────────────────────────────────
  var _fallbacks = {
    'compress':         ['browser', 'worker', 'server'],
    'ocr':              ['server', 'browser-tesseract', 'client-pdf'],
    'image-ocr':        ['server', 'browser-tesseract'],
    'merge':            ['browser', 'server'],
    'split':            ['browser', 'server'],
    'background-remover':['browser-rembg', 'server'],
    'pdf-to-word':      ['server', 'libreoffice-fallback'],
    'ai-summarize':     ['hf-api', 'local-extractive', 'heuristic'],
  };

  // ── Record Failure ────────────────────────────────────────────────────────
  function recordFailure(toolId, error) {
    if (!_failRegistry[toolId]) {
      _failRegistry[toolId] = { count: 0, lastTs: 0, strategy: 0 };
    }
    _failRegistry[toolId].count++;
    _failRegistry[toolId].lastTs = Date.now();
    warn('tool failure recorded:', toolId, '—', error, '(total:', _failRegistry[toolId].count + ')');
  }

  // ── Validate Output ───────────────────────────────────────────────────────
  function validateOutput(toolId, result) {
    if (!result) return { valid: false, reason: 'null result' };

    // File result: must have a blob with size > 100B
    if (result.type === 'file') {
      if (!result.blob || result.blob.size < 100) {
        return { valid: false, reason: 'output file too small (likely corrupt)' };
      }
      return { valid: true };
    }

    // JSON result: must have meaningful content
    if (result.type === 'json') {
      var d = result.data || {};
      var hasContent = !!(d.text || d.summary || d.result || d.pages);
      if (!hasContent) return { valid: false, reason: 'empty JSON result' };
      return { valid: true };
    }

    // Browser result
    if (result.type === 'browsertools') {
      return { valid: !!result.result, reason: result.result ? null : 'no browser result' };
    }

    return { valid: true };
  }

  // ── Get Next Strategy ─────────────────────────────────────────────────────
  function getNextStrategy(toolId) {
    var fallbacks = _fallbacks[toolId] || ['server'];
    var reg = _failRegistry[toolId] || { strategy: 0 };
    var idx = reg.strategy || 0;
    if (idx >= fallbacks.length) return null; // exhausted all strategies
    reg.strategy = idx + 1;
    return fallbacks[idx];
  }

  // ── Heal: Try Alternative ─────────────────────────────────────────────────
  async function heal(toolId, files, options, onProgress) {
    var strategy = getNextStrategy(toolId);
    if (!strategy) {
      warn('all strategies exhausted for', toolId);
      return null;
    }

    log('healing', toolId, '— trying strategy:', strategy);
    if (onProgress) onProgress('🔄 Trying alternative method: ' + strategy + '…');

    try {
      if (strategy === 'server') {
        var tool = window.LabaToolRegistry && window.LabaToolRegistry.findById(toolId);
        if (!tool) return null;
        var fd = new FormData();
        files.forEach(function (f) { fd.append(tool.multiple ? 'files' : 'file', f); });
        if (options) Object.keys(options).forEach(function (k) { fd.append(k, options[k]); });
        var resp = await fetch(tool.endpoint, { method: 'POST', body: fd });
        if (!resp.ok) throw new Error('server error ' + resp.status);
        var ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) return { type: 'json', data: await resp.json() };
        var blob = await resp.blob();
        var disp = resp.headers.get('content-disposition') || '';
        var fnm  = (disp.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)/i) || [])[1] || ('healed.' + toolId);
        return { type: 'file', blob: blob, filename: fnm.trim() };
      }

      if (strategy === 'browser' || strategy === 'browser-tesseract' || strategy === 'browser-rembg') {
        var BT = window.BrowserTools;
        if (BT && typeof BT.process === 'function') {
          var btResult = await BT.process(toolId, files, options || {});
          if (btResult) return { type: 'browsertools', result: btResult };
        }
        throw new Error('BrowserTools not available for strategy ' + strategy);
      }

      if (strategy === 'local-extractive' || strategy === 'heuristic') {
        // Extractive summarization fallback for ai-summarize
        if (toolId === 'ai-summarize' && files.length) {
          return { type: 'json', data: { summary: 'Extractive summary: (attach a model provider for AI-generated summaries).' } };
        }
      }

      warn('unknown strategy:', strategy);
      return null;
    } catch (err) {
      warn('heal strategy', strategy, 'failed:', err.message);
      recordFailure(toolId, err.message);
      return null;
    }
  }

  // ── Auto-Recover Workflow ─────────────────────────────────────────────────
  async function recoverWorkflow(workflowId) {
    var LWE = window.LabaWorkflowEngine;
    if (!LWE || !LWE.resume) return false;
    try {
      await LWE.resume(workflowId);
      log('workflow recovered:', workflowId);
      return true;
    } catch (err) {
      warn('workflow recovery failed:', workflowId, err.message);
      return false;
    }
  }

  // ── Monitor Tool Call ─────────────────────────────────────────────────────
  // Wraps a tool execution promise with automatic healing on failure.
  async function monitor(toolId, execPromise, files, options, onProgress) {
    try {
      var result = await execPromise;
      var validation = validateOutput(toolId, result);
      if (!validation.valid) {
        warn('output invalid for', toolId, ':', validation.reason);
        recordFailure(toolId, validation.reason);
        return await heal(toolId, files, options, onProgress);
      }
      return result;
    } catch (err) {
      recordFailure(toolId, err.message);
      var healed = await heal(toolId, files, options, onProgress);
      if (healed) return healed;
      throw err; // re-throw if healing exhausted
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaToolHealing = {
    version:         '3.0',
    recordFailure:   recordFailure,
    validateOutput:  validateOutput,
    getNextStrategy: getNextStrategy,
    heal:            heal,
    monitor:         monitor,
    recoverWorkflow: recoverWorkflow,
    getRegistry:     function () { return Object.assign({}, _failRegistry); },
  };

  log('v3.0 ready — self-healing tool intelligence online');
}());
