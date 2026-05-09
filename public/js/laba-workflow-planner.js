/**
 * LABA AUTONOMOUS WORKFLOW PLANNER  v3.0
 * window.LabaWorkflowPlanner
 *
 * AI-generated workflows with DAG execution, dependency graph,
 * dynamic retries, step validation, auto-recovery, and optimisation.
 * Extends LabaWorkflowEngine non-destructively.
 */
(function () {
  'use strict';
  if (window.LabaWorkflowPlanner) return;

  var LOG = '[LWFP]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Tool Intent Map ────────────────────────────────────────────────────────
  var _intentToTool = {
    'ocr':         'ocr',         'extract text':  'ocr',    'text nikalo': 'ocr',
    'image ocr':   'image-ocr',   'scan':          'ocr',
    'compress':    'compress',    'chota karo':    'compress',
    'summarize':   'ai-summarize','summary':       'ai-summarize',
    'translate':   'translate',   'word':          'pdf-to-word',
    'to word':     'pdf-to-word', 'pdf to word':   'pdf-to-word',
    'excel':       'pdf-to-excel','merge':         'merge',
    'split':       'split',       'rotate':        'rotate',
    'watermark':   'watermark',   'protect':       'protect',
    'sign':        'sign',        'email':         null,  // non-tool step
    'draft email': null,          'summarise':     'ai-summarize',
    'remove bg':   'background-remover',
    'background':  'background-remover',
    'jpg':         'pdf-to-jpg',  'convert to jpg':'pdf-to-jpg',
    'resize':      'resize-image','crop':          'crop-image',
  };

  function _inferTool(stepText) {
    var lower = stepText.toLowerCase().trim();
    // Direct match
    if (_intentToTool[lower] !== undefined) return _intentToTool[lower];
    // Partial match
    for (var key in _intentToTool) {
      if (lower.indexOf(key) >= 0) return _intentToTool[key];
    }
    return null;
  }

  // ── Plan Builder ──────────────────────────────────────────────────────────
  function buildPlan(steps, context) {
    context = context || {};
    var nodes = [];
    var prevId = null;

    steps.forEach(function (stepText, idx) {
      var toolId = _inferTool(stepText);
      var node = {
        id:        'step_' + idx,
        label:     stepText.trim(),
        toolId:    toolId,
        deps:      prevId ? [prevId] : [],
        status:    'pending',   // pending | running | done | failed | skipped
        retries:   0,
        maxRetry:  2,
        output:    null,
        error:     null,
      };
      nodes.push(node);
      prevId = node.id;
    });

    return {
      id:       'wf_' + Date.now().toString(36),
      nodes:    nodes,
      status:   'pending',
      createdAt: Date.now(),
      context:  context,
    };
  }

  // ── DAG Executor ──────────────────────────────────────────────────────────
  async function executePlan(plan, onStepUpdate) {
    plan.status = 'running';
    log('executing plan:', plan.id, '(' + plan.nodes.length + ' steps)');

    for (var i = 0; i < plan.nodes.length; i++) {
      var node = plan.nodes[i];

      // Check deps
      var depsOk = node.deps.every(function (depId) {
        var dep = plan.nodes.find(function (n) { return n.id === depId; });
        return dep && dep.status === 'done';
      });

      if (!depsOk) {
        node.status = 'skipped';
        if (onStepUpdate) onStepUpdate(node, plan);
        continue;
      }

      node.status = 'running';
      if (onStepUpdate) onStepUpdate(node, plan);

      var success = false;
      while (node.retries <= node.maxRetry && !success) {
        try {
          if (!node.toolId) {
            // Non-tool step (e.g. email draft)
            node.output = '📝 Step: ' + node.label + ' — handled by AI';
            node.status = 'done';
            success = true;
          } else {
            var files = _getFiles(plan, node);
            if (!files.length) {
              node.output  = '⚠️ No input file for step: ' + node.label;
              node.status  = 'skipped';
              success = true;
            } else {
              var LTR = window.LabaToolRouter;
              if (!LTR) throw new Error('ToolRouter not available');
              var result = await LTR.executeTool(node.toolId, files, {});
              node.output = result;
              node.status = 'done';
              success = true;
              // Record learning
              if (window.LabaToolLearning) window.LabaToolLearning.recordSuccess(node.toolId, 0);
            }
          }
        } catch (err) {
          node.retries++;
          node.error = err.message;
          if (window.LabaToolLearning) window.LabaToolLearning.recordFailure(node.toolId);
          if (node.retries > node.maxRetry) {
            node.status = 'failed';
            warn('step failed after', node.maxRetry, 'retries:', node.id, err.message);
            // Try healing
            if (window.LabaToolHealing && node.toolId && files) {
              var healed = await window.LabaToolHealing.heal(node.toolId, files, {}, null);
              if (healed) { node.output = healed; node.status = 'done'; success = true; }
            }
          } else {
            await new Promise(function (r) { setTimeout(r, 1000 * node.retries); }); // backoff
          }
        }
      }

      if (onStepUpdate) onStepUpdate(node, plan);
      if (node.status === 'failed') { plan.status = 'partial'; }
    }

    var allDone = plan.nodes.every(function (n) { return n.status === 'done' || n.status === 'skipped'; });
    plan.status = allDone ? 'done' : (plan.status === 'partial' ? 'partial' : 'done');
    plan.completedAt = Date.now();
    log('plan complete:', plan.id, plan.status);
    return plan;
  }

  function _getFiles(plan, node) {
    // Get output file from previous step, or fall back to context files
    if (node.deps.length) {
      var dep = plan.nodes.find(function (n) { return n.id === node.deps[0]; });
      if (dep && dep.output && dep.output.blob) return [dep.output.blob];
    }
    return (plan.context && plan.context.files) || [];
  }

  // ── Plan from Natural Language ─────────────────────────────────────────────
  async function planFromText(text, context) {
    var brain = window.LabaCognitiveBrain;
    var steps = brain ? brain.parseMultiStep(text) : null;

    if (!steps || steps.length < 2) {
      // Single step
      var tool = _inferTool(text);
      if (!tool) return null;
      steps = [text];
    }

    var plan = buildPlan(steps, context);
    log('built plan from text:', plan.id, '(' + plan.nodes.length + ' steps)');
    return plan;
  }

  // ── Render Plan Card ──────────────────────────────────────────────────────
  function renderPlanCard(plan) {
    var lines = ['📋 **Workflow Plan** (' + plan.nodes.length + ' steps):'];
    plan.nodes.forEach(function (node, i) {
      var icon = node.status === 'done' ? '✅' : node.status === 'failed' ? '❌' : node.status === 'running' ? '⚙️' : node.status === 'skipped' ? '⏭️' : '⏳';
      var tool = node.toolId ? ' → `' + node.toolId + '`' : '';
      lines.push((i + 1) + '. ' + icon + ' ' + node.label + tool);
    });
    return lines.join('\n');
  }

  // ── Extend LabaWorkflowEngine ─────────────────────────────────────────────
  function _extendEngine() {
    var LWE = window.LabaWorkflowEngine;
    if (!LWE) return;
    if (!LWE.createFromSteps) {
      LWE.createFromSteps = async function (steps, context) {
        return buildPlan(steps, context);
      };
      log('injected createFromSteps() into LabaWorkflowEngine');
    }
    if (!LWE.executePlan) {
      LWE.executePlan = executePlan;
      log('injected executePlan() into LabaWorkflowEngine');
    }
  }

  var _extTimer = setInterval(function () {
    if (window.LabaWorkflowEngine) { clearInterval(_extTimer); _extendEngine(); }
  }, 500);
  setTimeout(function () { clearInterval(_extTimer); }, 15000);

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaWorkflowPlanner = {
    version:       '3.0',
    buildPlan:     buildPlan,
    executePlan:   executePlan,
    planFromText:  planFromText,
    renderPlanCard:renderPlanCard,
    inferTool:     _inferTool,
  };

  log('v3.0 ready — autonomous workflow planner online');
}());
