/**
 * LABA DEEP MEMORY INTELLIGENCE EXTENSION  v3.0
 * window.LabaDeepMemory
 *
 * Extends LabaMemorySystem with:
 * - semantic user memory with relationship graph
 * - long-term preferences
 * - contextual recall
 * - conversation summarization
 * - memory compression & TTL policies
 * - indexed retrieval
 *
 * Non-destructive — adds capabilities to existing memory system.
 */
(function () {
  'use strict';
  if (window.LabaDeepMemory) return;

  var LOG = '[LDMX]';
  function log() { console.log.apply(console, [LOG].concat([].slice.call(arguments))); }

  var STORE_KEY  = 'laba_deep_memory_v1';
  var DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

  // ── Memory Store ──────────────────────────────────────────────────────────
  var _mem = {
    facts:       [],   // { id, text, tags, importance, ts, ttl, accessCount }
    preferences: {},   // key → { value, ts }
    relations:   {},   // entity → [related entities]
    summaries:   [],   // { sessionId, summary, ts }
  };

  function _load() {
    try { var r = localStorage.getItem(STORE_KEY); if (r) _mem = JSON.parse(r); } catch (_) {}
    _prune();
  }
  function _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(_mem)); } catch (_) {}
  }
  function _uid() { return 'dm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,5); }

  // ── TTL Pruner ────────────────────────────────────────────────────────────
  function _prune() {
    var now = Date.now();
    _mem.facts = (_mem.facts || []).filter(function (f) {
      return !f.ttl || (now - f.ts) < f.ttl;
    });
    // Keep only last 20 summaries
    if ((_mem.summaries || []).length > 20) {
      _mem.summaries = _mem.summaries.slice(-20);
    }
  }

  // ── Store Fact ────────────────────────────────────────────────────────────
  function storeFact(text, opts) {
    opts = opts || {};
    var fact = {
      id:          _uid(),
      text:        String(text || '').slice(0, 500),
      tags:        opts.tags || _autoTag(text),
      importance:  opts.importance || 0.5,
      ts:          Date.now(),
      ttl:         opts.ttl || DEFAULT_TTL,
      accessCount: 0,
    };
    _mem.facts.push(fact);
    // Limit total facts
    if (_mem.facts.length > 500) {
      // Remove lowest importance oldest facts
      _mem.facts.sort(function (a, b) { return (b.importance + b.accessCount * 0.1) - (a.importance + a.accessCount * 0.1); });
      _mem.facts = _mem.facts.slice(0, 400);
    }
    _save();
    log('stored fact:', fact.id, fact.text.slice(0, 50));
    return fact.id;
  }

  // ── Auto Tagger ───────────────────────────────────────────────────────────
  function _autoTag(text) {
    var lower = (text || '').toLowerCase();
    var tags = [];
    if (/pdf|document|file/.test(lower)) tags.push('document');
    if (/ocr|text|extract/.test(lower))  tags.push('ocr');
    if (/compress|size/.test(lower))     tags.push('compress');
    if (/weather|mausam/.test(lower))    tags.push('weather');
    if (/code|function|debug/.test(lower)) tags.push('coding');
    if (/email|letter/.test(lower))      tags.push('email');
    return tags;
  }

  // ── Recall ────────────────────────────────────────────────────────────────
  function recall(sessionId, query) {
    _prune();
    var lower = (query || '').toLowerCase();
    var words = lower.split(/\s+/).filter(function (w) { return w.length > 3; });

    var scored = _mem.facts.map(function (f) {
      var score = 0;
      words.forEach(function (w) {
        if (f.text.toLowerCase().indexOf(w) >= 0) score += 1;
        if (f.tags && f.tags.indexOf(w) >= 0)     score += 2;
      });
      score *= f.importance;
      score += f.accessCount * 0.05;
      return { fact: f, score: score };
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.filter(function (s) { return s.score > 0; }).slice(0, 5);

    // Update access count
    top.forEach(function (s) { s.fact.accessCount++; });
    if (top.length) _save();

    if (!top.length) return null;
    return top.map(function (s) { return s.fact.text; }).join('\n');
  }

  // ── Set Preference ────────────────────────────────────────────────────────
  function setPreference(key, value) {
    _mem.preferences[key] = { value: value, ts: Date.now() };
    _save();
  }

  function getPreference(key, defaultVal) {
    var p = (_mem.preferences || {})[key];
    return p ? p.value : defaultVal;
  }

  // ── Relationship Graph ─────────────────────────────────────────────────────
  function addRelation(entity, related) {
    _mem.relations = _mem.relations || {};
    if (!_mem.relations[entity]) _mem.relations[entity] = [];
    if (_mem.relations[entity].indexOf(related) < 0) {
      _mem.relations[entity].push(related);
    }
    _save();
  }

  function getRelations(entity) {
    return (_mem.relations || {})[entity] || [];
  }

  // ── Session Summarization ─────────────────────────────────────────────────
  function summarizeSession(sessionId, turns) {
    if (!turns || !turns.length) return;
    var summary = turns
      .filter(function (t) { return t.role === 'user'; })
      .map(function (t) { return t.text.slice(0, 80); })
      .join(' | ');

    _mem.summaries = _mem.summaries || [];
    _mem.summaries.push({
      sessionId: sessionId,
      summary:   summary,
      ts:        Date.now(),
    });
    _save();
    log('session summarized:', sessionId, summary.slice(0, 60));
  }

  function getSessionSummary(sessionId) {
    return (_mem.summaries || [])
      .filter(function (s) { return s.sessionId === sessionId; })
      .map(function (s) { return s.summary; })
      .join('\n');
  }

  // ── Memory Compression ────────────────────────────────────────────────────
  function compress() {
    _prune();
    var before = _mem.facts.length;
    // Merge near-duplicate facts (simple prefix match)
    var seen = {};
    _mem.facts = _mem.facts.filter(function (f) {
      var key = f.text.slice(0, 40).toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    _save();
    log('memory compressed:', before, '→', _mem.facts.length, 'facts');
    return { before: before, after: _mem.facts.length };
  }

  // ── Extend Base LabaMemorySystem ──────────────────────────────────────────
  function _extendBase() {
    var LMS = window.LabaMemorySystem;
    if (!LMS) return;
    // Inject recall method if not present
    if (!LMS.recall) {
      LMS.recall = recall;
      log('injected recall() into LabaMemorySystem');
    }
  }

  _load();
  // Wait for LabaMemorySystem to be ready
  var _extTimer = setInterval(function () {
    if (window.LabaMemorySystem) {
      clearInterval(_extTimer);
      _extendBase();
    }
  }, 500);
  setTimeout(function () { clearInterval(_extTimer); }, 15000);

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaDeepMemory = {
    version:           '3.0',
    storeFact:         storeFact,
    recall:            recall,
    setPreference:     setPreference,
    getPreference:     getPreference,
    addRelation:       addRelation,
    getRelations:      getRelations,
    summarizeSession:  summarizeSession,
    getSessionSummary: getSessionSummary,
    compress:          compress,
    prune:             _prune,
    stats: function () {
      return { facts: _mem.facts.length, preferences: Object.keys(_mem.preferences || {}).length, summaries: (_mem.summaries || []).length };
    },
  };

  log('v3.0 ready — deep memory intelligence online');
}());
