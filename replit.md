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
- **Translate**: MyMemory API, source language selector (26 languages) + 70+ target languages.
- **Background remover**: Enhanced CPU path with border sampling for dark/light background detection, 50px feather, 3×3 neighbourhood smoothing.
- **Size limits**: <50 MB for most tools, <200 MB for compress, <500 MB absolute hard limit. Memory guard aborts before OOM.
- **Sentinel delegators**: word-to-pdf, excel-to-pdf, html-to-pdf, scan-to-pdf throw ERR.ORIG → fall to pre-hook browser handlers (all have real implementations).

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
