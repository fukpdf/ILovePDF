/**
 * LABA SAFE EXECUTOR  v3.0
 * window.LabaSafeExecutor
 *
 * Prevents dangerous execution patterns.
 * Validates commands, sanitizes prompts, checks tool permissions,
 * rate-limits expensive actions, and blocks injections.
 */
(function () {
  'use strict';
  if (window.LabaSafeExecutor) return;

  var LOG = '[LSE]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Dangerous Patterns ────────────────────────────────────────────────────
  var _dangerous = [
    // Prompt injection attempts
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompt|context)/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /pretend\s+(to\s+be|you\s+are)/i,
    /jailbreak|DAN\s*mode|developer\s*mode\s*enabled/i,
    /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i,
    // XSS attempts
    /<script[\s>]/i,
    /javascript:/i,
    /on(load|error|click|mouseover|focus)\s*=/i,
    // SQL injection patterns in filenames
    /['";\-]{2,}/,
    /union\s+select/i,
    /drop\s+table/i,
  ];

  // ── Filename Sanitizer ────────────────────────────────────────────────────
  function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return 'upload';
    return name
      .replace(/[^a-zA-Z0-9._\-\s]/g, '_')  // allow safe chars only
      .replace(/\.{2,}/g, '.')                // no ..
      .replace(/^\.+/, '')                    // no leading dots
      .slice(0, 128)                          // max 128 chars
      .trim() || 'upload';
  }

  // ── Prompt Sanitizer ──────────────────────────────────────────────────────
  function sanitizePrompt(text) {
    if (!text || typeof text !== 'string') return '';
    // Strip HTML tags
    var out = text.replace(/<[^>]*>/g, '');
    // Limit length
    out = out.slice(0, 4000);
    // Normalise whitespace
    out = out.replace(/\s{3,}/g, ' ').trim();
    return out;
  }

  // ── Dangerous Check ───────────────────────────────────────────────────────
  function isDangerous(text) {
    if (!text) return false;
    return _dangerous.some(function (rx) { return rx.test(text); });
  }

  // ── Tool Permission Map ───────────────────────────────────────────────────
  var _permissions = {
    // Public tools — always allowed
    'compress':true,'merge':true,'split':true,'rotate':true,
    'watermark':true,'protect':true,'unlock':true,'repair':true,
    'ocr':true,'image-ocr':true,'compare':true,'ai-summarize':true,
    'translate':true,'pdf-to-word':true,'pdf-to-excel':true,'pdf-to-powerpoint':true,
    'pdf-to-jpg':true,'word-to-pdf':true,'powerpoint-to-pdf':true,'excel-to-pdf':true,
    'jpg-to-pdf':true,'html-to-pdf':true,'background-remover':true,
    'crop-image':true,'resize-image':true,'image-filters':true,
    'sign':true,'redact':true,'page-numbers':true,'edit':true,'organize':true,
    'crop':true,'scan-to-pdf':true,
    // Admin-only tools
    '_admin_':false,
    '_execute_code_':false,
  };

  function hasPermission(toolId, elevated) {
    if (elevated) return true; // admin can do anything
    return _permissions[toolId] !== false; // default allow if not explicitly blocked
  }

  // ── Rate Limiter ──────────────────────────────────────────────────────────
  var _rateLimits = {}; // key → { count, windowStart }
  var _limits = {
    default:    { max: 20, windowMs: 60000 },
    'ai-summarize': { max: 5,  windowMs: 60000 },
    'translate':    { max: 8,  windowMs: 60000 },
    'ocr':          { max: 10, windowMs: 60000 },
    'image-ocr':    { max: 10, windowMs: 60000 },
    'web-search':   { max: 15, windowMs: 60000 },
  };

  function checkRateLimit(key) {
    var limit = _limits[key] || _limits.default;
    var now   = Date.now();
    if (!_rateLimits[key] || now - _rateLimits[key].windowStart > limit.windowMs) {
      _rateLimits[key] = { count: 1, windowStart: now };
      return { ok: true };
    }
    _rateLimits[key].count++;
    if (_rateLimits[key].count > limit.max) {
      warn('rate limit exceeded for', key);
      return { ok: false, retryAfter: Math.ceil((limit.windowMs - (now - _rateLimits[key].windowStart)) / 1000) };
    }
    return { ok: true };
  }

  // ── Full Validation ───────────────────────────────────────────────────────
  function validate(opts) {
    opts = opts || {};
    var text    = opts.text    || '';
    var toolId  = opts.toolId  || null;
    var files   = opts.files   || [];
    var elevated = opts.elevated || false;

    // 1. Prompt injection check
    if (isDangerous(text)) {
      warn('blocked dangerous prompt:', text.slice(0, 80));
      return { ok: false, reason: 'Message contains restricted patterns.' };
    }

    // 2. Tool permission check
    if (toolId && !hasPermission(toolId, elevated)) {
      return { ok: false, reason: 'This tool requires admin elevation.' };
    }

    // 3. Rate limit
    if (toolId) {
      var rl = checkRateLimit(toolId);
      if (!rl.ok) return { ok: false, reason: 'Rate limit reached. Try again in ' + rl.retryAfter + 's.' };
    }

    // 4. File validation
    var MAX_SIZE = 100 * 1024 * 1024; // 100 MB
    var ALLOWED_TYPES = /\.(pdf|docx?|pptx?|xlsx?|jpg|jpeg|png|webp|gif|html?|txt|csv|zip)$/i;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size > MAX_SIZE) return { ok: false, reason: 'File "' + sanitizeFilename(f.name) + '" exceeds 100 MB limit.' };
      if (!ALLOWED_TYPES.test(f.name)) return { ok: false, reason: 'File type not allowed: ' + sanitizeFilename(f.name) };
    }

    return { ok: true, sanitizedText: sanitizePrompt(text) };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaSafeExecutor = {
    version:         '3.0',
    validate:        validate,
    sanitizePrompt:  sanitizePrompt,
    sanitizeFilename:sanitizeFilename,
    isDangerous:     isDangerous,
    hasPermission:   hasPermission,
    checkRateLimit:  checkRateLimit,
  };

  log('v3.0 ready — safe execution sandbox online');
}());
