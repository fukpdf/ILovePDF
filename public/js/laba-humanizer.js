/**
 * LABA HUMANIZER  v3.0
 * window.LabaHumanizer
 *
 * Adaptive human interaction layer.
 * Dynamically adjusts tone, simulates typing delay, adds contextual empathy,
 * handles clarification, and provides follow-up questions.
 */
(function () {
  'use strict';
  if (window.LabaHumanizer) return;

  var LOG = '[LHM]';
  function log() { console.log.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Emotion → Response Style Map ─────────────────────────────────────────
  var _styleMap = {
    neutral:    { delay: 0.8, prefix: '',          maxWords: 999 },
    happy:      { delay: 0.5, prefix: '😊 ',       maxWords: 999 },
    frustrated: { delay: 0.3, prefix: '',           maxWords: 60  },
    urgent:     { delay: 0.2, prefix: '⚡ ',        maxWords: 40  },
    confused:   { delay: 1.0, prefix: '🤔 ',        maxWords: 120 },
  };

  // ── Empathy Prefixes ──────────────────────────────────────────────────────
  var _empathy = {
    frustrated: [
      'Samajh gaya, let\'s sort this out.',
      'No worries, I\'ve got you.',
      'Koi baat nahi — let\'s fix this together.',
      'Got it. Let\'s take it step by step.',
    ],
    confused: [
      'Let me clarify that for you.',
      'Good question — here\'s how it works:',
      'Acha, main explain karta hoon:',
    ],
    urgent: [
      'Right away!',
      'Abhi karte hain!',
      'On it!',
    ],
  };

  function _rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── Apply Style ───────────────────────────────────────────────────────────
  function applyStyle(text, emotion) {
    emotion = emotion || 'neutral';
    var style = _styleMap[emotion] || _styleMap.neutral;
    var words = (text || '').split(/\s+/);

    // Truncate if needed
    var truncated = words.length > style.maxWords
      ? words.slice(0, style.maxWords).join(' ') + '…'
      : text;

    // Add empathy prefix
    var empathy = _empathy[emotion] ? _rand(_empathy[emotion]) + ' ' : '';

    return empathy + style.prefix + truncated;
  }

  // ── Typing Simulation Delay ───────────────────────────────────────────────
  // Returns ms to wait before starting to "type" (simulates thinking)
  function thinkDelay(text, emotion) {
    var style = _styleMap[emotion || 'neutral'] || _styleMap.neutral;
    var words = (text || '').split(/\s+/).length;
    var base  = style.delay * 800; // 200-800ms base
    var perWord = Math.min(words * 12, 600); // reading speed simulation
    return Math.round(base + perWord);
  }

  // ── Clarification Engine ──────────────────────────────────────────────────
  var _clarifyTemplates = {
    ur: [
      'Ek cheez clear karein — {question}',
      'Thoda aur batao — {question}',
      'Samjha nahi — {question}',
    ],
    en: [
      'Just to clarify — {question}',
      'Could you tell me — {question}',
      'One quick question — {question}',
    ],
  };

  function buildClarification(question, lang) {
    lang = lang || 'en';
    var templates = _clarifyTemplates[lang] || _clarifyTemplates.en;
    return _rand(templates).replace('{question}', question);
  }

  // ── Follow-up Generator ───────────────────────────────────────────────────
  var _followUps = {
    compress:   ['Want me to convert it to Word after compressing?', 'Compress ke baad share karna hai?'],
    ocr:        ['Want me to summarize the extracted text?', 'Text translate karna hai?'],
    'image-ocr':['Want me to summarize what was extracted?', 'Kya yeh invoice/document hai — analyze karoon?'],
    merge:      ['Want me to compress the merged file?', 'Merged PDF compress karna hai?'],
    summarize:  ['Want me to translate this summary?', 'Key points nikalne hain aur?'],
    translate:  ['Want to summarize the translated text?', 'Aur kuch translate karna hai?'],
  };

  function suggestFollowUp(toolId, lang) {
    var suggestions = _followUps[toolId];
    if (!suggestions || !suggestions.length) return null;
    var idx = lang === 'ur' ? Math.min(1, suggestions.length - 1) : 0;
    return '💡 ' + suggestions[idx];
  }

  // ── Concise Mode ──────────────────────────────────────────────────────────
  function concise(text, maxSentences) {
    maxSentences = maxSentences || 2;
    var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    return sentences.slice(0, maxSentences).join(' ').trim();
  }

  // ── Wrap AI Response ──────────────────────────────────────────────────────
  function wrap(text, context) {
    context = context || {};
    var emotion  = context.emotion || 'neutral';
    var verbosity = context.verbosity || 'normal';
    var lang     = context.lang || 'en';

    var result = applyStyle(text, emotion);

    if (verbosity === 'short') result = concise(result, 2);

    return result;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.LabaHumanizer = {
    version:           '3.0',
    wrap:              wrap,
    applyStyle:        applyStyle,
    thinkDelay:        thinkDelay,
    buildClarification:buildClarification,
    suggestFollowUp:   suggestFollowUp,
    concise:           concise,
  };

  log('v3.0 ready — adaptive humanizer online');
}());
