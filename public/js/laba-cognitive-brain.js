/**
 * LABA COGNITIVE BRAIN  v3.0
 * window.LabaCognitiveBrain
 *
 * Central reasoning engine — classifies intent, detects ambiguity, plans
 * multi-step responses, maintains thought state, routes to the right
 * sub-system (tool / web / memory / clarification / admin).
 *
 * Purely additive. Slots into the AI pipeline before LabaConversationalAI.
 */
(function () {
  'use strict';
  if (window.LabaCognitiveBrain) return;

  var LOG = '[LCB]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Thought State ────────────────────────────────────────────────────────
  var _thoughtState = {
    lastIntent:     null,
    lastTool:       null,
    pendingClarify: null,
    turnCount:      0,
    userEmotion:    'neutral',   // neutral | happy | frustrated | confused | urgent
    sessionGoal:    null,
    followUpOf:     null,
  };

  // ── Ambiguity Patterns ───────────────────────────────────────────────────
  var _ambiguous = [
    { rx:/\b(halka|chota|chhota|readable|saaf|clean)\b/i,
      options:['compress (size kam karna)', 'OCR / text cleanup', 'optimize for reading'],
      ask:'Aap kya chahte hain — PDF ka size kam karna ya text readable banana?' },
    { rx:/\b(fix|theek|durust)\s*(kar|karo|kro)\b/i,
      options:['repair corrupted PDF', 'fix grammar/text', 'fix layout'],
      ask:'Kya "fix" se aap ka matlab PDF repair hai, ya text grammar fix?' },
    { rx:/\b(convert|badal|badlo)\b(?!.*to\s+\w)/i,
      options:['PDF to Word', 'PDF to Image', 'Word to PDF', 'other format'],
      ask:'Convert kahan karna hai? Word, Excel, JPG, ya kuch aur?' },
    { rx:/\b(extract|nikalo|nikalna)\b(?!.*text|.*page|.*table)/i,
      options:['extract text (OCR)', 'extract pages', 'extract tables'],
      ask:'Kya extract karna hai — text, pages, ya tables?' },
  ];

  // ── Emotion Signals ──────────────────────────────────────────────────────
  var _emotionSignals = [
    { rx:/\b(frustrated|annoyed|ugh|argh|nahi\s*chal|kaam\s*nahi|problem|issue|error)\b/i,       emotion:'frustrated' },
    { rx:/\b(urgent|jaldi|asap|abhi|immediately|right\s*now|emergency)\b/i,                       emotion:'urgent' },
    { rx:/\b(confused|samajh\s*nahi|kya\s*matlab|not\s*sure|confused)\b/i,                       emotion:'confused' },
    { rx:/\b(great|amazing|perfect|shukriya|thank|excellent|love\s*it|awesome)\b/i,              emotion:'happy' },
  ];

  // ── Strategy Router ──────────────────────────────────────────────────────
  // Returns a plan: { strategy, confidence, needsClarify, askUser, emotion, step }
  function reason(rawText, context) {
    context = context || {};
    _thoughtState.turnCount++;

    var lower = rawText.toLowerCase().trim();
    var plan = {
      strategy:      'conversational',  // conversational | tool | web | memory | clarify | admin | dev
      confidence:    0.5,
      needsClarify:  false,
      askUser:       null,
      emotion:       'neutral',
      step:          _thoughtState.turnCount,
      followUpOf:    _thoughtState.lastIntent,
      ambiguityOptions: null,
    };

    // Detect emotion first
    for (var ei = 0; ei < _emotionSignals.length; ei++) {
      if (_emotionSignals[ei].rx.test(lower)) {
        plan.emotion = _emotionSignals[ei].emotion;
        _thoughtState.userEmotion = plan.emotion;
        break;
      }
    }

    // Admin trigger check (delegated to LabaAdminCore if loaded)
    if (window.LabaAdminCore && window.LabaAdminCore.isAdminTrigger(rawText)) {
      plan.strategy   = 'admin';
      plan.confidence = 0.99;
      return _finalise(plan);
    }

    // Dev copilot check
    var devKw = /\b(generate\s*(code|route|component|api)|refactor|debug\s*(this|code)|architecture|git\s*(commit|push|pull)|stack\s*trace|optimize\s*(backend|frontend|bundle))\b/i;
    if (devKw.test(lower)) {
      plan.strategy   = 'dev';
      plan.confidence = 0.82;
      return _finalise(plan);
    }

    // Multi-step workflow detection
    var stepKw = /\b(then|aur\s*phir|phir|after\s*that|then\s*also|step\s*\d|pehle|baad\s*mein)\b/i;
    if (stepKw.test(lower) && lower.split(/\bthen\b|\bphir\b|\baur\b/).length >= 2) {
      plan.strategy   = 'workflow';
      plan.confidence = 0.88;
      _thoughtState.sessionGoal = rawText;
      return _finalise(plan);
    }

    // Web/knowledge detection
    if (/\b(weather|mausam|news|khabar|who\s*is|what\s*is\s*the|live|current|latest|today\s*(price|rate|score))\b/i.test(lower)) {
      plan.strategy   = 'web';
      plan.confidence = 0.85;
      return _finalise(plan);
    }

    // Memory recall
    if (/\b(remember|yaad\s*(hai|karo)|last\s*time|pehle|previously|meri\s*file|woh\s*file|that\s*document)\b/i.test(lower)) {
      plan.strategy   = 'memory';
      plan.confidence = 0.80;
      return _finalise(plan);
    }

    // Tool detection
    var toolKw = /\b(compress|merge|split|ocr|convert|watermark|sign|protect|unlock|rotate|summarize|translate|extract|remove\s*background|resize|crop)\b/i;
    if (toolKw.test(lower)) {
      // Check for ambiguity
      for (var ai = 0; ai < _ambiguous.length; ai++) {
        if (_ambiguous[ai].rx.test(lower) && !_hasFileContext(context)) {
          plan.strategy        = 'clarify';
          plan.needsClarify    = true;
          plan.askUser         = _ambiguous[ai].ask;
          plan.ambiguityOptions = _ambiguous[ai].options;
          plan.confidence      = 0.70;
          _thoughtState.pendingClarify = _ambiguous[ai];
          return _finalise(plan);
        }
      }
      plan.strategy   = 'tool';
      plan.confidence = 0.90;
      return _finalise(plan);
    }

    // Follow-up resolution: if previous turn had a tool, assume reference
    if (_thoughtState.lastTool && /\b(it|this|that|isko|usko|yeh|woh|same|again|dobara)\b/i.test(lower)) {
      plan.strategy   = 'tool';
      plan.confidence = 0.75;
      plan.followUpOf = _thoughtState.lastTool;
      return _finalise(plan);
    }

    return _finalise(plan);
  }

  function _hasFileContext(ctx) {
    return !!(ctx && (ctx.stagedFiles && ctx.stagedFiles.length || ctx.docCtx));
  }

  function _finalise(plan) {
    _thoughtState.lastIntent = plan.strategy;
    if (plan.strategy === 'tool') _thoughtState.lastTool = plan.strategy;
    return plan;
  }

  // ── Clarification Builder ────────────────────────────────────────────────
  function buildClarificationReply(plan) {
    if (!plan.askUser) return null;
    var opts = plan.ambiguityOptions || [];
    var reply = plan.askUser;
    if (opts.length) {
      reply += '\n\n' + opts.map(function (o, i) { return (i + 1) + '. ' + o; }).join('\n');
    }
    return reply;
  }

  // ── Contradiction Detector ───────────────────────────────────────────────
  function detectContradiction(currentText, history) {
    if (!history || !history.length) return false;
    var last = (history[history.length - 1] || {}).text || '';
    if (/compress/i.test(currentText) && /compress/i.test(last) && /no|nahi|dont/i.test(currentText)) {
      return 'You previously asked to compress — did you change your mind?';
    }
    return false;
  }

  // ── Multi-step Planner ───────────────────────────────────────────────────
  function parseMultiStep(rawText) {
    var separators = /\bthen\b|\bphir\b|\baur\s*phir\b|\bafter\s*that\b|\bnext\b|\bstep\s*\d\b/gi;
    var parts = rawText.split(separators).map(function (s) { return s.trim(); }).filter(Boolean);
    return parts.length >= 2 ? parts : null;
  }

  // ── Public API ───────────────────────────────────────────────────────────
  window.LabaCognitiveBrain = {
    version:            '3.0',
    reason:             reason,
    parseMultiStep:     parseMultiStep,
    detectContradiction:detectContradiction,
    buildClarification: buildClarificationReply,
    getThoughtState:    function () { return Object.assign({}, _thoughtState); },
    resetSession:       function () {
      _thoughtState.turnCount = 0;
      _thoughtState.lastIntent = null;
      _thoughtState.lastTool = null;
      _thoughtState.pendingClarify = null;
      _thoughtState.sessionGoal = null;
    },
    setEmotion: function (e) { _thoughtState.userEmotion = e; },
    getEmotion: function () { return _thoughtState.userEmotion; },
  };

  log('v3.0 ready — cognitive reasoning engine online');
}());
