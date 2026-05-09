/**
 * LABA PREDICTIVE INTENT ENGINE  v3.0
 * window.LabaPredictiveEngine
 *
 * Predicts next action, suggests tools, detects workflow patterns,
 * and provides proactive assistance based on usage history.
 */
(function () {
  'use strict';
  if (window.LabaPredictiveEngine) return;

  var LOG = '[LPIE]';
  function log() { console.log.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Workflow Pattern Library ──────────────────────────────────────────────
  var _patterns = [
    {
      name:    'OCR → Summarize',
      trigger: ['ocr', 'image-ocr'],
      suggest: ['ai-summarize', 'translate'],
      msg:     'Text extracted! Want me to **summarize** it or **translate** it?',
      msgUr:   'Text nikal aaya! **Summarize** ya **translate** karna hai?',
    },
    {
      name:    'Compress → Share',
      trigger: ['compress'],
      suggest: ['merge', 'protect'],
      msg:     'PDF compressed! Want to **protect** it with a password or **merge** with another file?',
      msgUr:   'PDF compress ho gaya! **Password** lagana hai ya **merge** karna hai?',
    },
    {
      name:    'Convert → Edit',
      trigger: ['pdf-to-word'],
      suggest: ['word-to-pdf', 'ai-summarize'],
      msg:     'Converted to Word! When you\'re done editing, I can convert it **back to PDF**.',
      msgUr:   'Word mein convert ho gaya! Edit ke baad **PDF mein wapas** kar sakta hoon.',
    },
    {
      name:    'Merge → Compress',
      trigger: ['merge'],
      suggest: ['compress', 'protect'],
      msg:     'PDFs merged! Want to **compress** the result to reduce size?',
      msgUr:   'PDFs merge ho gaye! Result ko **compress** karna hai?',
    },
    {
      name:    'Scan → OCR',
      trigger: ['scan-to-pdf'],
      suggest: ['ocr', 'ai-summarize'],
      msg:     'Scan done! Want to **extract text** from the scanned PDF?',
      msgUr:   'Scan complete! Scanned PDF se **text nikalna** hai?',
    },
    {
      name:    'Remove BG → Convert',
      trigger: ['background-remover'],
      suggest: ['jpg-to-pdf', 'resize-image'],
      msg:     'Background removed! Want to **convert to PDF** or **resize** the image?',
      msgUr:   'Background hat gaya! **PDF** ya **resize** karna hai?',
    },
    {
      name:    'Summarize → Translate',
      trigger: ['ai-summarize'],
      suggest: ['translate'],
      msg:     'Summary done! Want to **translate** it to another language?',
      msgUr:   'Summary ready! **Translate** karna hai kisi aur language mein?',
    },
    {
      name:    'Watermark → Protect',
      trigger: ['watermark'],
      suggest: ['protect', 'sign'],
      msg:     'Watermark added! Want to **protect** it with a password or add a **signature**?',
      msgUr:   'Watermark lag gaya! **Password** lagana hai ya **signature** add karna hai?',
    },
  ];

  // ── Session History ───────────────────────────────────────────────────────
  var _history = []; // [{ toolId, ts }] most recent last

  function recordToolUse(toolId) {
    _history.push({ toolId: toolId, ts: Date.now() });
    if (_history.length > 50) _history.splice(0, 10);
  }

  // ── Predict Next ──────────────────────────────────────────────────────────
  function predictNext(lastToolId, lang) {
    lang = lang || 'en';
    var isUr = lang === 'ur';
    var pattern = _patterns.find(function (p) {
      return p.trigger.indexOf(lastToolId) >= 0;
    });
    if (!pattern) return null;
    return {
      pattern:     pattern.name,
      suggestions: pattern.suggest,
      message:     isUr && pattern.msgUr ? pattern.msgUr : pattern.msg,
    };
  }

  // ── Detect Repeated Workflow ──────────────────────────────────────────────
  function detectRepeatWorkflow() {
    if (_history.length < 4) return null;
    var recent = _history.slice(-4);
    var ids    = recent.map(function (h) { return h.toolId; });
    // Check if last 2 tools repeat from 2 turns ago
    if (ids[0] === ids[2] && ids[1] === ids[3]) {
      return {
        tools:   [ids[0], ids[1]],
        message: '💡 I noticed you\'re running **' + ids[0] + ' → ' + ids[1] + '** repeatedly. Want me to automate this as a workflow?',
      };
    }
    return null;
  }

  // ── Proactive Suggestions ─────────────────────────────────────────────────
  function getProactiveSuggestions(context) {
    context = context || {};
    var suggestions = [];
    var LPE = window.LabaPersonalityEngine;
    var topTools = LPE ? LPE.getProfile().topTools : [];

    if (topTools.length) {
      suggestions.push({
        type:    'favorite',
        toolId:  topTools[0],
        message: '⭐ Quick access: your most used tool is **' + topTools[0] + '**',
      });
    }

    // Check for recent doc context
    if (context.docCtx && context.docCtx.length > 100) {
      suggestions.push({
        type:    'doc_ready',
        message: '📄 Document loaded — say **"summarize"**, **"extract data"**, or **"translate"**',
      });
    }

    return suggestions;
  }

  // ── Build Suggestion Chips ────────────────────────────────────────────────
  function buildChips(toolId, lang) {
    var prediction = predictNext(toolId, lang);
    if (!prediction) return [];
    return prediction.suggestions.map(function (id) {
      return { toolId: id, label: id.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) };
    });
  }

  // ── Smart Intent Autocomplete ─────────────────────────────────────────────
  var _completions = [
    { rx:/^comp/i,    full:'compress PDF' },
    { rx:/^merg/i,    full:'merge PDFs' },
    { rx:/^spli/i,    full:'split PDF' },
    { rx:/^ocr/i,     full:'OCR - extract text' },
    { rx:/^summ/i,    full:'summarize document' },
    { rx:/^tran/i,    full:'translate PDF' },
    { rx:/^conv/i,    full:'convert PDF to Word' },
    { rx:/^remo/i,    full:'remove background' },
    { rx:/^wate/i,    full:'watermark PDF' },
    { rx:/^prot/i,    full:'protect with password' },
    { rx:/^sign/i,    full:'sign PDF' },
    { rx:/^resi/i,    full:'resize image' },
    { rx:/^weа/i,    full:'weather forecast' },
    { rx:/^news/i,    full:'latest news' },
  ];

  function autocomplete(partial) {
    if (!partial || partial.length < 2) return [];
    return _completions
      .filter(function (c) { return c.rx.test(partial); })
      .map(function (c) { return c.full; });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaPredictiveEngine = {
    version:               '3.0',
    predictNext:           predictNext,
    recordToolUse:         recordToolUse,
    detectRepeatWorkflow:  detectRepeatWorkflow,
    getProactiveSuggestions: getProactiveSuggestions,
    buildChips:            buildChips,
    autocomplete:          autocomplete,
    history:               function () { return _history.slice(); },
  };

  log('v3.0 ready — predictive intent engine online (' + _patterns.length + ' workflow patterns)');
}());
