/**
 * PHASE 2 — LABA AGENT SYSTEM
 * window.LabaAgentSystem
 *
 * AI agent that plans, chains, retries, and reflects on multi-step tasks.
 * Integrates with LabaToolOrchestrator, LabaMemorySystem, LabaWorkflowEngine.
 * Purely additive. Degrades gracefully. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaAgentSystem) return;

  var VERSION  = '2.0';
  var LOG      = '[LAS]';
  var MAX_RETRIES = 3;
  var MAX_STEPS   = 10;
  var CONFIRM_PATTERNS = [/delete/i, /remove\s+all/i, /clear\s+all/i, /overwrite/i];

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function uid()  { return 'las_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  TASK PLANNER
  // Parses natural language into an ordered list of steps.
  // ═══════════════════════════════════════════════════════════════════════════
  var TaskPlanner = (function () {

    // Multi-step pattern recognition
    var CHAIN_SEPARATORS = /\bthen\b|\band\s+then\b|\bafter\s+that\b|\bnext\b|\bfinally\b|\bafterward/gi;
    var TOOL_INTENTS = [
      { id: 'ocr',              rx: /\b(ocr|extract\s+text|read\s+text|scan\s+text|text\s+from\s+(image|pdf))/i },
      { id: 'translate',        rx: /\btranslat/i },
      { id: 'summarize',        rx: /\bsummar/i },
      { id: 'compress',         rx: /\bcompress|reduce\s+size|shrink/i },
      { id: 'merge',            rx: /\bmerge|combin|join.*pdf/i },
      { id: 'split',            rx: /\bsplit|separate|divide/i },
      { id: 'convert',          rx: /\bconvert|change.*format/i },
      { id: 'pdf-to-word',      rx: /\bpdf.*(to|2).*word|\bdocx\b|editable/i },
      { id: 'pdf-to-excel',     rx: /\bpdf.*(to|2).*excel|\bxlsx\b|table.*excel/i },
      { id: 'word-to-pdf',      rx: /\bword.*(to|2).*pdf|docx.*(to|2).*pdf/i },
      { id: 'jpg-to-pdf',       rx: /\bimage.*(to|2).*pdf|jpg.*(to|2).*pdf|png.*(to|2).*pdf/i },
      { id: 'background-remover', rx: /\bremove.*background|background.*remov|bg.*remov/i },
      { id: 'protect',          rx: /\bprotect|password|encrypt|lock/i },
      { id: 'unlock',           rx: /\bunlock|remove.*password|decrypt/i },
      { id: 'watermark',        rx: /\bwatermark|stamp/i },
      { id: 'sign',             rx: /\bsign|signature|esign/i },
      { id: 'rotate',           rx: /\brotat/i },
      { id: 'crop-image',       rx: /\bcrop\s*image|crop\s*photo/i },
      { id: 'resize-image',     rx: /\bresize\s*image|resize\s*photo/i },
      { id: 'image-filters',    rx: /\bfilter|grayscale|sepia|blur/i },
      { id: 'compare',          rx: /\bcompar|\bdiff\b|difference/i },
      { id: 'repair',           rx: /\brepair|fix.*pdf|corrupt/i },
      { id: 'redact',           rx: /\bredact|black.*out|censor|hide.*text/i },
    ];

    function _detectTool(phrase) {
      for (var i = 0; i < TOOL_INTENTS.length; i++) {
        if (TOOL_INTENTS[i].rx.test(phrase)) return TOOL_INTENTS[i].id;
      }
      return null;
    }

    function _extractOptions(phrase) {
      var opts = {};
      var langMatch = phrase.match(/\bto\s+(urdu|arabic|french|spanish|german|chinese|hindi|japanese|korean|russian|turkish|english)\b/i);
      if (langMatch) opts.targetLang = langMatch[1].toLowerCase();
      return opts;
    }

    function plan(request) {
      // Safety check — block dangerous patterns
      for (var k = 0; k < CONFIRM_PATTERNS.length; k++) {
        if (CONFIRM_PATTERNS[k].test(request)) {
          return { safe: false, reason: 'Dangerous operation requires explicit confirmation.' };
        }
      }

      // Split on chaining words
      var phrases = request.split(CHAIN_SEPARATORS).map(function (p) { return p.trim(); }).filter(Boolean);

      // If single phrase — try single-tool plan
      if (phrases.length <= 1) {
        var tool = _detectTool(request);
        if (!tool) return { safe: true, steps: [] }; // no tool detected — conversational
        return {
          safe: true,
          steps: [{ id: uid(), type: tool, label: tool, options: _extractOptions(request), retries: 0 }],
        };
      }

      // Multi-step
      var steps = [];
      phrases.forEach(function (phrase) {
        if (steps.length >= MAX_STEPS) return;
        var tool = _detectTool(phrase);
        if (tool) {
          steps.push({ id: uid(), type: tool, label: tool, options: _extractOptions(phrase), retries: 0 });
        }
      });

      return { safe: true, steps: steps };
    }

    function describeSteps(steps) {
      if (!steps || !steps.length) return '';
      return steps.map(function (s, i) { return (i + 1) + '. ' + s.type; }).join(' → ');
    }

    return { plan: plan, describeSteps: describeSteps };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  STEP EXECUTOR
  // Runs a single step via LabaToolOrchestrator or WorkflowChainEngine.
  // ═══════════════════════════════════════════════════════════════════════════
  var StepExecutor = (function () {

    async function execute(step, files, onProgress) {
      var LTO = sys('LabaToolOrchestrator');
      var WCE = sys('WorkflowChainEngine');
      var BT  = sys('BrowserTools');

      onProgress && onProgress({ step: step.type, status: 'running' });

      // Try WorkflowChainEngine step adapter first
      if (WCE && WCE.executeStep) {
        try {
          var ctx = { files: files, ocrText: null, translated: null, summary: null };
          var result = await WCE.executeStep(step.type, ctx, step.options || {});
          if (result) return { ok: true, result: result, engine: 'wce' };
        } catch (e) { warn('WCE step failed:', e.message); }
      }

      // Try LabaToolOrchestrator
      if (LTO && LTO.executeTool) {
        try {
          var r = await LTO.executeTool(step.type, files, step.options || {}, function (msg) {
            onProgress && onProgress({ step: step.type, status: 'running', message: msg });
          });
          if (r) return { ok: true, result: r, engine: 'lto' };
        } catch (e) { warn('LTO step failed:', e.message); }
      }

      // Try BrowserTools
      if (BT && BT.process) {
        try {
          var br = await BT.process(step.type, files, step.options || {});
          if (br) return { ok: true, result: br, engine: 'browser' };
        } catch (e) { warn('BrowserTools step failed:', e.message); }
      }

      // Server API fallback
      var registry = sys('LabaToolRegistry');
      var toolDef  = registry && registry.findById ? registry.findById(step.type) : null;
      if (toolDef && toolDef.endpoint && files && files.length) {
        try {
          var fd = new FormData();
          if (toolDef.multiple) files.forEach(function (f) { fd.append('files', f); });
          else fd.append('file', files[0]);
          if (step.options) Object.keys(step.options).forEach(function (k) { fd.append(k, step.options[k]); });
          onProgress && onProgress({ step: step.type, status: 'uploading' });
          var resp = await fetch(toolDef.endpoint, { method: 'POST', body: fd });
          if (!resp.ok) throw new Error('Server error ' + resp.status);
          var ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            var json = await resp.json();
            return { ok: true, result: { type: 'json', data: json }, engine: 'server' };
          }
          var blob = await resp.blob();
          var disp = resp.headers.get('content-disposition') || '';
          var fn   = (disp.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)/i) || [])[1] || ('result-' + step.type + '.bin');
          return { ok: true, result: { type: 'file', blob: blob, filename: fn.trim() }, engine: 'server' };
        } catch (e) { warn('server fallback failed:', e.message); }
      }

      return { ok: false, error: 'No executor available for step: ' + step.type };
    }

    return { execute: execute };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  REFLECTION ENGINE
  // Checks if a step result looks valid before moving on.
  // ═══════════════════════════════════════════════════════════════════════════
  var ReflectionEngine = (function () {
    function reflect(step, result) {
      if (!result || !result.ok) return { pass: false, reason: result && result.error || 'Step failed' };
      var r = result.result;
      if (!r)                              return { pass: false, reason: 'Empty result' };
      if (r.type === 'file' && !r.blob)   return { pass: false, reason: 'File result missing blob' };
      if (r.type === 'json' && !r.data)   return { pass: false, reason: 'JSON result missing data' };
      // Text result checks
      if (r.text !== undefined && !r.text && step.type !== 'translate') {
        return { pass: false, reason: 'Text result is empty — may need OCR first' };
      }
      return { pass: true };
    }

    return { reflect: reflect };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  AGENT RUNNER
  // Orchestrates plan → execute → reflect → retry cycle.
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentRunner = (function () {
    var _active = new Map(); // taskId → task

    async function run(taskId, steps, files, onStepComplete, onDone) {
      var task = {
        id:       taskId,
        steps:    steps,
        files:    files || [],
        results:  [],
        status:   'running',
        startedAt: Date.now(),
      };
      _active.set(taskId, task);

      // Track in memory
      var MEM = sys('LabaMemorySystem');
      if (MEM) MEM.setTask('Running: ' + steps.map(function (s) { return s.type; }).join(' → '));

      var lastFiles = files ? files.slice() : [];

      for (var i = 0; i < task.steps.length; i++) {
        var step = task.steps[i];
        step.status = 'running';

        onStepComplete && onStepComplete({
          taskId:    taskId,
          stepIndex: i,
          total:     task.steps.length,
          step:      step.type,
          status:    'running',
        });

        var result = null;
        var retries = 0;

        while (retries <= MAX_RETRIES) {
          result = await StepExecutor.execute(step, lastFiles, function (prog) {
            onStepComplete && onStepComplete({
              taskId: taskId, stepIndex: i, total: task.steps.length,
              step: step.type, status: 'running', message: prog.message,
            });
          });

          var check = ReflectionEngine.reflect(step, result);
          if (check.pass) break;

          retries++;
          if (retries <= MAX_RETRIES) {
            warn('retry', retries, 'for step', step.type, ':', check.reason);
            await new Promise(function (r) { setTimeout(r, 600 * retries); });
          } else {
            result = { ok: false, error: 'Failed after ' + MAX_RETRIES + ' retries: ' + check.reason };
          }
        }

        step.status  = result.ok ? 'done' : 'error';
        step.result  = result;
        step._retries = retries;
        task.results.push({ stepIndex: i, step: step.type, result: result });

        // If step produced a file, use it for the next step
        if (result.ok && result.result && result.result.type === 'file' && result.result.blob) {
          var blobFile = new File([result.result.blob], result.result.filename || 'output.bin',
            { type: result.result.blob.type });
          lastFiles = [blobFile];
        }

        // Record tool usage
        if (MEM) MEM.recordTool(step.type, result.ok);

        onStepComplete && onStepComplete({
          taskId:    taskId,
          stepIndex: i,
          total:     task.steps.length,
          step:      step.type,
          status:    step.status,
          result:    result,
        });

        // Stop on required step failure
        if (!result.ok) {
          task.status = 'error';
          break;
        }

        await new Promise(function (r) { setTimeout(r, 0); }); // yield
      }

      if (task.status !== 'error') task.status = 'done';
      task.completedAt = Date.now();
      _active.set(taskId, task);

      if (MEM) MEM.clearTask();
      onDone && onDone(task);

      return task;
    }

    function getTask(id) { return _active.get(id) || null; }
    function cancelTask(id) {
      var t = _active.get(id);
      if (t) { t.status = 'cancelled'; }
    }

    return { run: run, getTask: getTask, cancelTask: cancelTask };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  CHAT INTEGRATION
  // Hooks into LabaAiChat to intercept multi-step requests.
  // ═══════════════════════════════════════════════════════════════════════════
  function _buildProgressCard(task, stepUpdate) {
    var steps   = task.steps || [];
    var current = stepUpdate && stepUpdate.stepIndex !== undefined ? stepUpdate.stepIndex : -1;
    var lines   = ['<div class="las-card">'];
    lines.push('<div class="las-card-title">🤖 Agent running ' + steps.length + '-step workflow</div>');
    lines.push('<div class="las-steps">');
    steps.forEach(function (s, i) {
      var st = i < current ? '✅' : i === current ? '⏳' : '⬜';
      lines.push('<div class="las-step">' + st + ' ' + (i + 1) + '. ' + s.type + '</div>');
    });
    lines.push('</div></div>');
    return lines.join('');
  }

  function _injectStyles() {
    if (document.getElementById('las-styles')) return;
    var s = document.createElement('style');
    s.id  = 'las-styles';
    s.textContent = [
      '.las-card{background:#f0f4ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;font-size:12px;margin:4px 0;}',
      '.las-card-title{font-weight:700;color:#3730a3;margin-bottom:6px;}',
      '.las-steps{display:flex;flex-direction:column;gap:3px;}',
      '.las-step{color:#374151;padding:2px 0;}',
      '.las-done{background:#f0fdf4;border-color:#bbf7d0;}',
      '.las-error{background:#fef2f2;border-color:#fecaca;}',
    ].join('');
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  _injectStyles();

  window.LabaAgentSystem = {
    version: VERSION,

    plan: function (request) {
      return TaskPlanner.plan(request);
    },

    describeSteps: function (steps) {
      return TaskPlanner.describeSteps(steps);
    },

    run: async function (request, files, onStepComplete, onDone) {
      var plan = TaskPlanner.plan(request);
      if (!plan.safe)   return { error: plan.reason };
      if (!plan.steps || !plan.steps.length) return { skipped: true, reason: 'No tool steps detected' };

      var taskId = uid();
      return AgentRunner.run(taskId, plan.steps, files, onStepComplete, onDone);
    },

    runSteps: function (steps, files, onStepComplete, onDone) {
      var taskId = uid();
      return AgentRunner.run(taskId, steps, files, onStepComplete, onDone);
    },

    getTask:    function (id) { return AgentRunner.getTask(id); },
    cancelTask: function (id) { AgentRunner.cancelTask(id); },

    buildProgressCard: function (task, update) { return _buildProgressCard(task, update); },

    // Quick detect: does this message need agent (multi-step)?
    isMultiStep: function (text) {
      var plan = TaskPlanner.plan(text);
      return plan.safe && plan.steps && plan.steps.length > 1;
    },

    audit: function () { return { version: VERSION }; },
  };

  log('LabaAgentSystem v' + VERSION + ' ready');
}());
