/**
 * LABA AUTONOMOUS MULTI-AGENT SYSTEM  v3.0
 * window.LabaAgentSupervisor
 *
 * 10 specialised agents + central supervisor.
 * Each agent has capability registry, confidence scoring, retry logic,
 * reflection, and self-validation.
 */
(function () {
  'use strict';
  if (window.LabaAgentSupervisor) return;

  var LOG = '[LMAS]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Base Agent ────────────────────────────────────────────────────────────
  function Agent(name, capabilities) {
    this.name         = name;
    this.capabilities = capabilities || [];
    this.callCount    = 0;
    this.failCount    = 0;
    this.confidence   = 0.8;
  }

  Agent.prototype.canHandle = function (task) {
    return this.capabilities.some(function (cap) { return cap.test(task); });
  };

  Agent.prototype.run = async function (task, context) {
    this.callCount++;
    try {
      var result = await this._execute(task, context);
      this._reflect(result);
      return result;
    } catch (err) {
      this.failCount++;
      warn(this.name, 'failed:', err.message);
      return { ok: false, error: err.message, agent: this.name };
    }
  };

  Agent.prototype._execute = async function (task, context) {
    return { ok: true, agent: this.name, output: 'No implementation', task: task };
  };

  Agent.prototype._reflect = function (result) {
    if (result && result.ok) {
      this.confidence = Math.min(0.99, this.confidence + 0.01);
    } else {
      this.confidence = Math.max(0.2, this.confidence - 0.05);
    }
  };

  // ── Document Agent ────────────────────────────────────────────────────────
  var DocumentAgent = new Agent('DocumentAgent', [
    /summar|summarize|key.*point|brief|overview|synopsis/i,
    /legal.*risk|clause|contract.*analysis/i,
    /extract.*data|table|entity/i,
    /explain.*document/i,
  ]);
  DocumentAgent._execute = async function (task, ctx) {
    var docCtx = (ctx && ctx.docCtx) || '';
    if (!docCtx) return { ok: false, error: 'No document loaded', agent: this.name };

    var lower = task.toLowerCase();
    if (/legal|risk|clause/i.test(lower)) {
      var legalKw = (docCtx.match(/\b(shall|must|obligation|liability|warranty|indemnif|terminat|breach|clause|agree)\b/gi) || []);
      var unique = Array.from(new Set(legalKw.map(function (k) { return k.toLowerCase(); }))).slice(0, 12);
      return { ok: true, agent: this.name, type: 'legal',
        output: unique.length
          ? '⚖️ **Legal keywords found:** ' + unique.join(', ') + '\n\n_Configure a model for full clause analysis._'
          : 'No obvious legal clauses found in the document.' };
    }

    var lines = docCtx.split('\n').filter(Boolean).slice(0, 10);
    return { ok: true, agent: this.name, type: 'summary',
      output: '📄 **Document Summary:**\n\n' + lines.join('\n') + '\n\n_Attach a model provider for AI-generated summaries._' };
  };

  // ── OCR Agent ─────────────────────────────────────────────────────────────
  var OcrAgent = new Agent('OcrAgent', [
    /\bocr\b|extract.*text|text.*from.*image|scan|nikalo/i,
  ]);
  OcrAgent._execute = async function (task, ctx) {
    var files = (ctx && ctx.stagedFiles) || [];
    if (!files.length) return { ok: false, error: 'No file staged for OCR', agent: this.name };
    var LTR = window.LabaToolRouter;
    if (!LTR) return { ok: false, error: 'ToolRouter not available', agent: this.name };
    var isImage = /\.(jpg|jpeg|png|webp)/i.test(files[0].name);
    var toolId  = isImage ? 'image-ocr' : 'ocr';
    return { ok: true, agent: this.name, type: 'tool_redirect', toolId: toolId, files: files };
  };

  // ── Research Agent ────────────────────────────────────────────────────────
  var ResearchAgent = new Agent('ResearchAgent', [
    /who\s*is|what\s*is|history\s*of|explain|when\s*(was|did)|latest.*news|current.*event/i,
    /weather|mausam|news|khabar|search\s*for|look\s*up/i,
  ]);
  ResearchAgent._execute = async function (task, ctx) {
    var LCAI = window.LabaConversationalAI;
    if (!LCAI) return { ok: false, error: 'ConversationalAI not available', agent: this.name };
    var result = await LCAI.respond(task, ctx || {});
    return result
      ? { ok: true, agent: this.name, type: 'research', output: result.answer }
      : { ok: false, error: 'No result from research', agent: this.name };
  };

  // ── Coding Agent ──────────────────────────────────────────────────────────
  var CodingAgent = new Agent('CodingAgent', [
    /\b(code|function|debug|error|javascript|python|html|css|sql|bug|program|script|algorithm|refactor|optimize)\b/i,
  ]);
  CodingAgent._execute = async function (task, ctx) {
    var copilot = window.LabaDevCopilot;
    if (copilot && copilot.isActive()) {
      return { ok: true, agent: this.name, type: 'dev', output: await copilot.assist(task, ctx) };
    }
    return { ok: true, agent: this.name, type: 'code_hint',
      output: '💻 I can help with code! For best results, describe the problem:\n- What language?\n- What error are you seeing?\n- Paste the relevant snippet\n\n_(Enable Developer Mode for full copilot.)_' };
  };

  // ── Workflow Agent ────────────────────────────────────────────────────────
  var WorkflowAgent = new Agent('WorkflowAgent', [
    /then|phir|after\s*that|step\s*\d|first.*then|pehle.*baad/i,
  ]);
  WorkflowAgent._execute = async function (task, ctx) {
    var brain = window.LabaCognitiveBrain;
    var steps = brain ? brain.parseMultiStep(task) : null;
    if (!steps) return { ok: false, error: 'Could not parse steps', agent: this.name };
    var LWE = window.LabaWorkflowEngine;
    if (LWE && LWE.createFromSteps) {
      var wf = await LWE.createFromSteps(steps, ctx);
      return { ok: true, agent: this.name, type: 'workflow', workflow: wf };
    }
    return { ok: true, agent: this.name, type: 'workflow_plan',
      output: '📋 **Planned steps:**\n' + steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n') };
  };

  // ── Search Agent ──────────────────────────────────────────────────────────
  var SearchAgent = new Agent('SearchAgent', [
    /search|look\s*up|find\s*out|google|bing|results\s*for/i,
  ]);
  SearchAgent._execute = async function (task, ctx) {
    var LCAI = window.LabaConversationalAI;
    if (!LCAI) return { ok: false, error: 'No search available', agent: this.name };
    var data = await LCAI.fetchSearch(task);
    return data
      ? { ok: true, agent: this.name, type: 'search', data: data }
      : { ok: false, error: 'Search failed', agent: this.name };
  };

  // ── Memory Agent ──────────────────────────────────────────────────────────
  var MemoryAgent = new Agent('MemoryAgent', [
    /remember|yaad|last\s*time|previously|pehle|woh\s*file|that\s*document|my\s*preference/i,
  ]);
  MemoryAgent._execute = async function (task, ctx) {
    var LMS = window.LabaMemorySystem;
    if (!LMS) return { ok: false, error: 'Memory system not available', agent: this.name };
    var sessId = ctx && ctx.sessionId;
    var recalled = LMS.recall ? await LMS.recall(sessId, task) : null;
    return recalled
      ? { ok: true, agent: this.name, type: 'memory', output: recalled }
      : { ok: true, agent: this.name, type: 'memory', output: 'No relevant memory found for this query.' };
  };

  // ── QA Agent ──────────────────────────────────────────────────────────────
  var QaAgent = new Agent('QaAgent', [
    /\?(question|q:|is\s+(it|this|that)|are\s+there|does\s+it|can\s+I|should\s+I)\b/i,
    /\?$/,
  ]);
  QaAgent._execute = async function (task, ctx) {
    var docCtx = (ctx && ctx.docCtx) || '';
    if (!docCtx) {
      return { ok: true, agent: this.name, type: 'qa',
        output: 'Upload a document first — then I can answer questions about its content!' };
    }
    var relevant = docCtx.slice(0, 1000);
    return { ok: true, agent: this.name, type: 'qa',
      output: '**Based on the document:**\n\n' + relevant + '\n\n_For precise Q&A, configure a language model provider._' };
  };

  // ── Translation Agent ─────────────────────────────────────────────────────
  var TranslationAgent = new Agent('TranslationAgent', [
    /translat|urdu\s*(mein|main)|english\s*(mein|main)|anuvad|tarjuma|in\s+(urdu|english|arabic|french|spanish|german|hindi)/i,
  ]);
  TranslationAgent._execute = async function (task, ctx) {
    return { ok: true, agent: this.name, type: 'tool_redirect', toolId: 'translate',
      output: 'To translate your document, upload it 📎 and I\'ll route to the translation engine.\n\nOr use [Translate PDF](/translate-pdf) directly.' };
  };

  // ── Email Agent ───────────────────────────────────────────────────────────
  var EmailAgent = new Agent('EmailAgent', [
    /write.*email|draft.*email|compose.*email|email.*likhni|email.*banao/i,
  ]);
  EmailAgent._execute = async function (task, ctx) {
    var LCAI = window.LabaConversationalAI;
    var result = LCAI ? await LCAI.respond(task, ctx) : null;
    return result
      ? { ok: true, agent: this.name, type: 'email', output: result.answer }
      : { ok: true, agent: this.name, type: 'email',
          output: 'Tell me more:\n1. **Purpose** — resignation, job application, complaint, follow-up?\n2. **Tone** — formal or casual?\n3. **Key details** to include' };
  };

  var _AGENTS = [
    DocumentAgent, OcrAgent, ResearchAgent, CodingAgent, WorkflowAgent,
    SearchAgent, MemoryAgent, QaAgent, TranslationAgent, EmailAgent,
  ];

  // ── Supervisor ────────────────────────────────────────────────────────────
  async function supervise(task, context) {
    context = context || {};
    var matched = _AGENTS.filter(function (a) { return a.canHandle(task); });
    if (!matched.length) {
      log('no agent matched for task:', task.slice(0, 50));
      return null;
    }
    // Sort by confidence, pick best
    matched.sort(function (a, b) { return b.confidence - a.confidence; });
    var primary = matched[0];
    log('routing to', primary.name, '(conf:', primary.confidence.toFixed(2) + ')');
    var result = await primary.run(task, context);

    // If primary fails, try secondary
    if (!result.ok && matched.length > 1) {
      warn('primary failed, trying', matched[1].name);
      result = await matched[1].run(task, context);
    }
    return result;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.LabaAgentSupervisor = {
    version:    '3.0',
    supervise:  supervise,
    agents:     _AGENTS,
    getAgent:   function (name) { return _AGENTS.find(function (a) { return a.name === name; }) || null; },
    listAgents: function () { return _AGENTS.map(function (a) { return { name: a.name, calls: a.callCount, fails: a.failCount, confidence: a.confidence }; }); },
  };

  log('v3.0 ready — 10 agents online:', _AGENTS.map(function (a) { return a.name; }).join(', '));
}());
