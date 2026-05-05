# ILovePDF — Free Online PDF & Image Tools

## Overview
ILovePDF is a production-ready platform offering 33 online tools for PDF and image processing. The project aims to provide a comprehensive, user-friendly, and highly available service for document manipulation, targeting a broad user base with both free and premium tiers. Key capabilities include PDF merging, splitting, compression, conversion (to/from Word, PPT, Excel, HTML, JPG), editing, security features, advanced tools like OCR and AI summarization, and a suite of image manipulation tools. The platform emphasizes performance, security, and a seamless user experience across various devices.

## User Preferences
I prefer detailed explanations.
I want an iterative development process.
I want to be asked before major changes are made.

## Replit Environment Setup
- **Runtime**: Node.js 20, port 5000
- **Start command**: `node server.js`
- **JWT_SECRET**: Generated and stored as a shared env var
- **Optional integrations** (work without these):
  - Firebase Auth: set `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`
  - Cloudflare R2 storage: set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
  - HuggingFace AI: set `HF_API_TOKEN` (informational only — AI tools use local/extractive logic)

## UI Architecture (current)

### Z-Index System (defined in `public/css/home.css :root`)
| Variable | Value | Usage |
|---|---|---|
| `--z-header` | 1000 | `.site-header` (fixed) |
| `--z-mobile-nav` | 900 | `.mobile-bottom-nav` |
| `--z-dropdown` | 1300 | `.dd`, `.mega` dropdowns |
| `--z-chatbot` | 1200 | Laba launcher + chat window |
| `--z-modal` | 2000 | Auth modal, limit modal |

### Header
- `position: fixed; top: 0; left: 0; right: 0; width: 100%` — always on screen
- `body` has `padding-top: var(--header-h)` (68px) to compensate for fixed layout
- `.site-header` uses `backdrop-filter: blur(12px)` glassmorphism

### Laba AI Widget (`public/laba/`)
- **Voice**: Web Speech API (STT + TTS), multi-language (English / Urdu / Roman Urdu)
- **Session Memory**: `this.session.history` — last 20 turns, capped to 500 chars per entry
- **Smart Suggestions**: Contextual follow-up chips after every bot reply (`SUGGESTIONS` map)
- **Error Logging**: `LabaLogger` → `window.__labaErrors` (capped at 50, available for debugging)
- **Fallback**: Universal fallback pool — always returns a helpful reply
- Mobile: launcher `bottom: calc(80px + env(safe-area-inset-bottom))` above bottom nav

### Dropdown Overflow Fix (`public/js/dropdown-fix.js`)
- Clamps `.dd` and `.mega` using `getBoundingClientRect()` on open
- MutationObserver watches `.is-open` class; hover listener for CSS-only opens
- Resets on close; recomputes on window resize

## System Architecture
The application follows a client-server architecture. The frontend is built with pure HTML/CSS/JS, focusing on a responsive and intuitive UI/UX with a distinctive red theme (`#E5322E`). Key UI components include a persistent mega-menu header, a 5-column footer, a dashboard with tool cards, and a dedicated processing overlay.

The backend is a lightweight Express.js server (auth, static files). All 33 PDF/image tools run 100% in the browser — there is no server fallback for tool processing.

Processing logic:
- **Browser-side (all tools)**: pdf-lib, pdfjs-dist, mammoth, html2pdf.js, xlsx, tesseract.js v5, canvas APIs. `tool-page.js` processFile() tries the browser path only; errors show user-friendly messages.
- **Server fallback removed**: Queue path and server fetch block are gone from processFile(). Errors are caught and displayed in plain language.
- **Compress pipeline**: basic (pdf-lib object streams + metadata strip) → shows result + "Try deep compression" CTA → render-based deep compress (pdfjs→JPEG canvas→pdf-lib at ~110 DPI, 0.72 quality). Always returns a valid file; shows "Already optimised" when no improvement.
- **Protect**: Browser-side visual lock overlay (pdf-lib doesn't support AES — overlay signals protection visually). Password hint embedded in file.
- **OCR**: tesseract.js v5.1.1, page-by-page, with canvas cleanup per page.
- **Translate**: MyMemory API, source language selector (26 languages) + 70+ target languages. Sentence-boundary–aware chunk splitting (≤450 chars/segment, splits at ". !?"), retryWithBackoff(3, 800ms, 12s).
- **Background remover**: Enhanced CPU path with border sampling for dark/light background detection, 50px feather, 3×3 neighbourhood smoothing.
- **Size limits**: <50 MB for most tools, <200 MB for compress, <500 MB absolute hard limit. Memory guard aborts before OOM.
- **Sentinel delegators**: word-to-pdf, excel-to-pdf, html-to-pdf, scan-to-pdf throw ERR.ORIG → fall to pre-hook browser handlers (all have real implementations).

**Production Hardening (v4.2 — May 2026) — 12 Phases:**
- **Phase 1 — DebugTrace**: New `public/js/debug-trace.js` sets `window.DebugTrace` with `log/error/result/getLogs/dump/report`. Added to `tool.html` before workerPool.js. `DT()` accessor in advanced-engine.js. Call `DebugTrace.dump()` in DevTools for full audit. 500-entry capped ring buffer.
- **Phase 2 — Strict Output Validation**: `validateOutput(toolId, blob)` with per-tool minimum sizes (DOCX/XLSX/PPTX ≥1000 bytes, PDF ≥200 bytes, TXT ≥20 bytes). Applied in `runTool()` BEFORE any download trigger.
- **Phase 3 — Auto-OCR Trigger**: `autoOcrFallback(file, onStep, stepBase, stepIdx)` shared helper runs Tesseract page-by-page and returns `[{pageNum, text}]`. Applied in: `pdf-to-word` (sparse text triggers OCR → DOCX), `pdf-to-excel` (empty sheets → OCR text as rows), `ai-summarize` (no text → OCR → TF-IDF), `translate` (no text → OCR → MyMemory API).
- **Phase 4 — AI Document Parser**: Enhanced `extractStructuredParagraphs()` heading detection — uses font size threshold (>1.35× median) AND ALL-CAPS short-line detection.
- **Phase 5 — Tool-Specific Fixes**: Background Remover now has CPU fallback (`removeBgInline()`) when worker fails. PDF→Word/Excel/PPT/OCR all have ERR.ORIG fallbacks.
- **Phase 6 — Retry System**: `retryWithBackoff(fn, maxRetries, baseMs, timeoutMs)` already present.
- **Phase 7 — Memory + Size Guard**: `shouldFallbackMem()` + 500MB hard limit + OPFS staging already present.
- **Phase 8 — Stealth System**: `safeMessage()` updated with `invalid_output` and `no_readable_text` handlers. Zero technical terms ever reach the UI.
- **Phase 9 — UI Trust**: Download only triggered after `validateOutput()` passes. No pre-created blob URLs.
- **Phase 12 — Audit**: `AdvancedEngine.audit()` in DevTools shows all registered tools, trace entries, errors, results, WorkerPool stats, memory tier.

**Critical Bug Fixes (v4.1 — May 2026):**
- **WorkerPool script loading**: Added `<script src="/workers/workerPool.js"></script>` to `tool.html` before `browser-tools.js`. This was the root cause of all worker-dependent tools failing with `pool_unavailable` — `window.WorkerPool` was never initialized.
- **Tools fixed by WorkerPool fix**: PDF→Word, PDF→PowerPoint, PDF→Excel, Background Remover, AI Summarizer (all use `runAdvancedWorker`), Repair PDF, Compress (uses `runPdfWorker`).
- **Repair PDF fallback**: Changed from hard error to `ERR.ORIG` fallback → now falls through to browser-tools.js `repairPdf` (pdf-lib based) when worker is unavailable.
- **PDF→Word/PowerPoint/Excel fallbacks**: Each now wraps `runAdvancedWorker` in try-catch and throws `ERR.ORIG` on failure, falling back to browser-tools.js implementations.
- **OCR output changed to DOCX**: Both the fast path (native text extraction) and the Tesseract path now output `.docx` via `runAdvancedWorker({op:'build-docx'})` instead of `.txt`. Fallback to `.txt` retained if worker fails.
- **AI Summarizer inline fallback**: Added inline TF-IDF scoring fallback when `runAdvancedWorker` is unavailable, so the tool always produces output.
- **Translate PDF empty output**: Added check — if all translated pages are empty (PDF has no extractable text), throws a helpful error guiding users to OCR tool first.
- **Output validation updated**: Removed `ocr` from `_TEXT_TOOLS` (min 1 byte) since OCR now returns DOCX (always >50 bytes); standard minimum of 50 bytes now applies.

**Production Guards (v4.0):**
- **Output Validation Layer** (`OutputValidator` in tool-page.js): validates every result before download — checks blob size against per-MIME minimums and strips whitespace-only text outputs. Applied in both the browser-side and advanced-engine paths.
- **Tool Execution Guard + Retry** (`tryWithRetry` in tool-page.js): wraps all browser-side processing in up to 2 attempts. Terminal errors (file too large, user-correctable) skip retry.
- **OCR Auto-trigger** (pdf-to-word, pdf-to-excel): detects sparse/zero extracted text and throws a user-friendly error guiding users to the OCR tool instead of silently producing an empty file.
- **Deep Compression Warning**: "Text will not be selectable after deep compression" shown in the `appendCompressAdvancedLink` CTA.
- **safeMessage() comprehensive mapping** (advanced-engine.js): maps all internal error types to clean user-facing messages with no technical jargon (no Worker, WASM, OPFS, chunk, ArrayBuffer). Also guides scanned-PDF users to the OCR tool.
- **Per-tool minimum output sizes** (browser-tools.js): pdf-to-word/excel/pptx require ≥800 bytes, images require ≥100 bytes, fallback is 200 bytes.

**Core Features & Design Patterns:**
- **Tool Routing**: Dispatcher uses browser-only path. No queue, no server fetch.
- **User Tiers**: Implemented with `utils/usage.js` for guest, free, and premium users, defining daily file limits and per-file size caps.
- **File Management**: Automatic cleanup of temporary local and R2 storage files. User-saved files in R2 are retained until manually deleted.
- **SEO Optimization**: Dynamic generation of canonical URLs, structured data (JSON-LD for Article, BreadcrumbList, FAQPage), and a dedicated blog system with SEO-friendly content and internal linking.
- **Performance**: Firebase SDK initialization is deferred using `requestIdleCallback` to avoid competing with first paint.
- **Tool Prioritization**: Frontend reordering and badging of tools (Instant, Compress, Advanced) based on execution speed to guide user selection.
- **Editor Features**: Drag-and-drop file reordering with thumbnails, per-file rotation, client-side size guards, and a signup-required modal for large files.

## Authentication
The app uses a custom JWT-based auth system stored in SQLite (`utils/db.js`). Users sign up/log in via `/api/auth/*` endpoints. JWT tokens are issued as HttpOnly cookies (`ilovepdf_token`). Firebase Auth is an optional secondary login provider — if `FIREBASE_API_KEY` and related env vars are set, users can also log in with Google/Firebase.

## Key Files
- `server.js` — Express entry point, middleware, routes
- `routes/auth.js` — Signup, login, logout, JWT cookie management
- `routes/organize.js`, `edit.js`, `convert.js`, `security.js`, `advanced.js`, `image.js` — Tool API endpoints
- `utils/db.js` — SQLite database (users, pending_signups)
- `utils/usage.js` — Per-IP and per-user daily quotas
- `utils/r2.js` — Cloudflare R2 storage (optional)
- `utils/firebase-admin.js` — Firebase token verification (optional)
- `public/` — Frontend HTML/CSS/JS
- `public/js/tools-config.js` — All 33 tool definitions

## External Dependencies
- **Cloudflare R2**: Optional object storage for uploads and results (S3-compatible)
- **Firebase**: Optional user authentication via Firebase ID tokens and Google login
- **pdf-lib**: JavaScript library for browser-side PDF manipulation
- **mammoth, pptxgenjs, exceljs, pdf-parse, JSZip**: Libraries for document format conversions
- **sharp**: Node.js module for high-performance image processing
- **Lucide icons**: Vector icons in the UI
- **Inter font**: Typography
- **multer**: Node.js middleware for file uploads
- **express-rate-limit, compression**: Express middleware for security and performance
