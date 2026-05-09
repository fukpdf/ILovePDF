/**
 * LABA DEVELOPER COPILOT  v3.0
 * window.LabaDevCopilot
 *
 * Hidden elevated AI mode for admin/owner.
 * NEVER activates for normal users.
 * Activation requires LabaAdminCore elevation.
 */
(function () {
  'use strict';
  if (window.LabaDevCopilot) return;

  var LOG = '[LDC]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }

  var _active    = false;
  var _auditLog  = [];

  function _audit(cmd) {
    _auditLog.push({ ts: Date.now(), cmd: cmd.slice(0, 120) });
    if (_auditLog.length > 200) _auditLog.splice(0, 50);
  }

  // ── Command Registry ──────────────────────────────────────────────────────
  var _cmds = [
    { rx:/analyze.*architecture|show.*structure/i,
      fn: function () {
        return '🏗️ **Project Architecture:**\n\n```\nStack: Node.js 20 + Express 5 (ES modules)\nFrontend: Vanilla HTML/CSS/JS (no framework)\nDB: SQLite (better-sqlite3)\nStorage: Cloudflare R2 (optional)\nAuth: JWT/bcrypt\nAI: HuggingFace (optional), browser WASM\n\nKey routes:\n  /api/compress   /api/merge    /api/split\n  /api/ocr        /api/translate /api/ai-summarize\n  /api/auth/*     /api/web-search\n  /live-intel/*   (Phase 3)\n\nFrontend modules: 70+ JS files in public/js/\nPhase 3: 15 new cognitive AI modules\n```';
      }},
    { rx:/generate.*route|create.*api.*route|new.*endpoint/i,
      fn: function (task) {
        var match = task.match(/route\s+(?:for\s+)?[\/]?([\w\-]+)/i);
        var name  = match ? match[1] : 'new-feature';
        return '📝 **Route Template for** `/' + name + '`:\n\n```javascript\n// routes/' + name + '.js\nimport express from \'express\';\nimport multer  from \'multer\';\nimport { UPLOAD_DIR } from \'../utils/upload.js\';\n\nconst router = express.Router();\nconst upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50*1024*1024 } });\n\nrouter.post(\'/' + name + '\', upload.single(\'file\'), async (req, res) => {\n  try {\n    const { file } = req;\n    if (!file) return res.status(400).json({ error: \'No file\' });\n    // TODO: implement logic\n    res.json({ success: true });\n  } catch (err) {\n    res.status(500).json({ error: err.message });\n  }\n});\n\nexport default router;\n```\n\nAdd to **server.js**:\n```javascript\nimport ' + name + 'Router from \'./routes/' + name + '.js\';\napp.use(\'/api\', ' + name + 'Router);\n```';
      }},
    { rx:/generate.*component|create.*component/i,
      fn: function (task) {
        var match = task.match(/component\s+(?:for\s+|called\s+)?(\w+)/i);
        var name  = match ? match[1] : 'MyComponent';
        return '📝 **Component Template:**\n\n```javascript\n// public/js/laba-' + name.toLowerCase() + '.js\n(function () {\n  \'use strict\';\n  if (window.Laba' + name + ') return;\n\n  function init() {\n    // TODO: implement\n  }\n\n  window.Laba' + name + ' = { version: \'1.0\', init: init };\n  console.log(\'[L' + name.slice(0,2).toUpperCase() + '] v1.0 ready\');\n}());\n```';
      }},
    { rx:/fix.*mobile|mobile.*responsiv/i,
      fn: function () {
        return '📱 **Mobile Responsiveness Checklist:**\n\n```css\n/* 1. Use dvh for viewport height */\nheight: calc(100dvh - var(--header-height));\n\n/* 2. Safe area insets (iPhone notch) */\npadding-bottom: env(safe-area-inset-bottom, 0px);\n\n/* 3. Touch targets ≥ 44px */\nmin-height: 44px; min-width: 44px;\n\n/* 4. No fixed pixel heights on chat panels */\n/* Use flex: 1 + overflow-y: auto */\n\n/* 5. Test at 375px (iPhone SE) */\n@media (max-width: 480px) { ... }\n```';
      }},
    { rx:/optimize.*bundle|bundle.*size/i,
      fn: function () {
        return '⚡ **Bundle Optimisation Tips:**\n\n1. **Lazy load** — defer non-critical scripts\n2. **Code split** — separate vendor from app code\n3. **Tree shake** — remove unused imports\n4. **Compress** — enable gzip/brotli on server (already done via `compression` middleware)\n5. **Cache** — set long Cache-Control headers for hashed assets\n6. **Audit** — run `npx bundlephobia` on heavy deps\n\nCurrent stack uses vanilla JS (no bundler) — minimal overhead by design.';
      }},
    { rx:/generate.*middleware|create.*middleware/i,
      fn: function () {
        return '📝 **Express Middleware Template:**\n\n```javascript\n// middleware/myMiddleware.js\nexport function myMiddleware(req, res, next) {\n  try {\n    // Add logic here\n    next();\n  } catch (err) {\n    res.status(500).json({ error: err.message });\n  }\n}\n```';
      }},
    { rx:/git.*commit|write.*commit/i,
      fn: function (task) {
        return '📝 **Commit Message Template:**\n\n```\nfeat(phase3): add autonomous agent supervisor\n\n- Implement 10 specialised agents (Document, OCR, Research, Coding, ...)\n- Add supervisor for intelligent routing\n- Graceful degradation on missing dependencies\n\nCloses #XX\n```\n\nFollow **Conventional Commits**: `feat|fix|docs|style|refactor|test|chore(scope): message`';
      }},
  ];

  // ── Assist ────────────────────────────────────────────────────────────────
  async function assist(task, context) {
    if (!_active) {
      return '🔒 Developer Copilot requires admin elevation. Use the admin command to activate.';
    }
    _audit(task);

    for (var i = 0; i < _cmds.length; i++) {
      if (_cmds[i].rx.test(task)) {
        var result = _cmds[i].fn(task, context);
        return result;
      }
    }

    // Generic coding help
    return '💻 **Developer Copilot active.**\n\nTry:\n- "analyze current architecture"\n- "generate production route for /api/X"\n- "generate component for X"\n- "fix mobile responsiveness"\n- "optimize bundle size"\n- "generate API middleware"\n- "generate git commit message"';
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────────
  function activate() { _active = true;  log('activated — dev copilot online'); }
  function deactivate(){ _active = false; log('deactivated'); }

  window.LabaDevCopilot = {
    version:    '3.0',
    isActive:   function () { return _active; },
    activate:   activate,
    deactivate: deactivate,
    assist:     assist,
    auditLog:   function () { return _auditLog.slice(); },
  };

  log('v3.0 ready — dev copilot standby (requires admin elevation)');
}());
