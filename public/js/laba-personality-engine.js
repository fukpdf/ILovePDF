/**
 * LABA PERSONALITY ENGINE  v3.0
 * window.LabaPersonalityEngine
 *
 * Persistent adaptive personality. Learns the user's language style, tone,
 * preferred tools, and communication preferences — then mirrors them.
 * Stored in IndexedDB (survives page refresh).
 */
(function () {
  'use strict';
  if (window.LabaPersonalityEngine) return;

  var LOG = '[LPE]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }

  var DB_NAME = 'laba_personality_v1';
  var _profile = {
    lang:         'auto',       // auto | en | ur | mixed
    tone:         'friendly',   // friendly | professional | concise | developer
    urduRatio:    0,            // 0-1, how often user writes Roman Urdu
    toolHistory:  {},           // tool_id → count
    topTools:     [],           // sorted by frequency
    emojiLike:    true,
    humor:        false,
    verbosity:    'normal',     // short | normal | detailed
    frustrations: 0,
    sessions:     0,
  };
  var _dirty = false;

  // ── IDB Persistence ──────────────────────────────────────────────────────
  function _save() {
    try { localStorage.setItem(DB_NAME, JSON.stringify(_profile)); } catch (_) {}
  }
  function _load() {
    try {
      var raw = localStorage.getItem(DB_NAME);
      if (raw) Object.assign(_profile, JSON.parse(raw));
    } catch (_) {}
  }
  _load();

  // ── Language Detection ───────────────────────────────────────────────────
  var _urduWords = /\b(hai|hain|ho|karo|aur|ya|mein|main|ko|se|ka|ki|ke|jo|yeh|ye|woh|wo|kya|kyun|kaise|kaisa|aaj|kal|ab|phir|bhi|nahi|na|haan|han|theek|thik|accha|pdf|bhai|yaar|ji|ap|aap|mujhe|mujhy|tumhe)\b/i;
  function detectLang(text) {
    var words = (text || '').split(/\s+/).length;
    var urduMatches = (text.match(_urduWords) || []).length;
    var ratio = words > 0 ? urduMatches / words : 0;
    _profile.urduRatio = (_profile.urduRatio * 0.8) + (ratio * 0.2); // EMA
    if (_profile.urduRatio > 0.3) return 'ur';
    if (_profile.urduRatio > 0.1) return 'mixed';
    return 'en';
  }

  // ── Tone Adapter ─────────────────────────────────────────────────────────
  function adaptTone(baseReply, emotion) {
    if (!baseReply) return baseReply;
    var lang = _profile.lang === 'auto' ? (_profile.urduRatio > 0.2 ? 'ur' : 'en') : _profile.lang;

    // Frustrated user → shorter, calmer
    if (emotion === 'frustrated' || _profile.frustrations > 2) {
      baseReply = baseReply.replace(/\n\n[^]+$/, ''); // trim long tails
      if (lang === 'ur') return '👍 Samajh gaya. ' + baseReply.slice(0, 120);
      return '👍 Got it. ' + baseReply.slice(0, 120);
    }

    // Urgent user → concise
    if (emotion === 'urgent') {
      return baseReply.split('\n')[0] + (lang === 'ur' ? ' — abhi karte hain!' : ' — on it now!');
    }

    // Developer tone
    if (_profile.tone === 'developer') {
      return '```\n' + baseReply + '\n```';
    }

    // Concise mode
    if (_profile.verbosity === 'short') {
      return baseReply.split('\n').slice(0, 3).join('\n');
    }

    return baseReply;
  }

  // ── Greeting Personalisation ─────────────────────────────────────────────
  function personalizedGreeting() {
    _profile.sessions++;
    _save();
    var lang = _profile.urduRatio > 0.2 ? 'ur' : 'en';
    if (_profile.sessions === 1) {
      return lang === 'ur'
        ? 'Aoa! Main Laba AI hoon 😊 Kuch bhi poocho ya file upload karo.'
        : 'Hello! I\'m Laba AI. Ask me anything or drop a file to get started.';
    }
    var top = _profile.topTools[0];
    if (top) {
      return lang === 'ur'
        ? 'Wapas aao! 😊 Phir se ' + top + ' use karna hai?'
        : 'Welcome back! 😊 Need to ' + top + ' again?';
    }
    return lang === 'ur' ? 'Aoa wapas! 😊 Kya karna hai?' : 'Welcome back! What can I do for you?';
  }

  // ── Observe User Turn ────────────────────────────────────────────────────
  function observe(text, toolUsed, emotion) {
    // Update language model
    var detectedLang = detectLang(text || '');
    if (_profile.lang === 'auto') {
      // keep auto but update ratio (done inside detectLang)
    }

    // Track frustrations
    if (emotion === 'frustrated') _profile.frustrations++;
    else if (emotion === 'happy') _profile.frustrations = Math.max(0, _profile.frustrations - 1);

    // Track tool usage
    if (toolUsed) {
      _profile.toolHistory[toolUsed] = (_profile.toolHistory[toolUsed] || 0) + 1;
      _profile.topTools = Object.keys(_profile.toolHistory)
        .sort(function (a, b) { return _profile.toolHistory[b] - _profile.toolHistory[a]; })
        .slice(0, 5);
    }

    // Adjust verbosity based on message length
    var words = (text || '').split(/\s+/).length;
    if (words < 5) _profile.verbosity = 'short';
    else if (words > 30) _profile.verbosity = 'detailed';
    else _profile.verbosity = 'normal';

    _save();
  }

  // ── Response Wrapper ─────────────────────────────────────────────────────
  function wrap(reply, emotion) {
    if (!reply) return reply;
    var adapted = adaptTone(reply, emotion || LabaCognitiveBrain_emotion());
    // Add emoji touches if user likes them and reply doesn't already have many
    if (_profile.emojiLike && (adapted.match(/[\u{1F300}-\\u{1FFFF}]/gu) || []).length < 2) {
      // don't double-add, just return as is
    }
    return adapted;
  }

  function LabaCognitiveBrain_emotion() {
    try { return window.LabaCognitiveBrain ? window.LabaCognitiveBrain.getEmotion() : 'neutral'; } catch (_) { return 'neutral'; }
  }

  // ── Suggest Proactive Action ─────────────────────────────────────────────
  function proactiveSuggestion() {
    if (_profile.topTools.length === 0) return null;
    var lang = _profile.urduRatio > 0.2 ? 'ur' : 'en';
    var top = _profile.topTools[0];
    return lang === 'ur'
      ? '💡 Tip: Aap aksar **' + top + '** use karte ho — seedha file drag karo!'
      : '💡 Tip: You often use **' + top + '** — just drag & drop your file!';
  }

  // ── Set Tone / Mode ──────────────────────────────────────────────────────
  function setMode(mode) {
    if (['friendly','professional','concise','developer'].includes(mode)) {
      _profile.tone = mode;
      _save();
      return true;
    }
    return false;
  }

  window.LabaPersonalityEngine = {
    version:             '3.0',
    observe:             observe,
    wrap:                wrap,
    adaptTone:           adaptTone,
    detectLang:          detectLang,
    personalizedGreeting: personalizedGreeting,
    proactiveSuggestion: proactiveSuggestion,
    setMode:             setMode,
    getProfile:          function () { return Object.assign({}, _profile); },
    getLang:             function () { return _profile.urduRatio > 0.25 ? 'ur' : _profile.urduRatio > 0.1 ? 'mixed' : 'en'; },
    isUrdu:              function () { return _profile.urduRatio > 0.2; },
  };

  log('v3.0 ready — adaptive personality engine online');
}());
