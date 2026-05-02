# ILovePDF — Free Online PDF & Image Tools

## Overview
ILovePDF is a production-ready platform offering 33 online tools for PDF and image processing. The project aims to provide a comprehensive, user-friendly, and highly available service for document manipulation, targeting a broad user base with both free and premium tiers. Key capabilities include PDF merging, splitting, compression, conversion (to/from Word, PPT, Excel, HTML, JPG), editing, security features, advanced tools like OCR and AI summarization, and a suite of image manipulation tools. The platform emphasizes performance, security, and a seamless user experience across various devices.

## User Preferences
I prefer detailed explanations.
I want an iterative development process.
I want to be asked before major changes are made.

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

The backend is an Express.js server handling API requests, file uploads (up to 100 MB), and orchestrating PDF/image processing. Processing logic is distributed:
- **Browser-side processing (primary)**: 26 of 33 tools now run entirely in the browser using `pdf-lib`, `pdfjs-dist`, `mammoth`, `html2pdf.js`, `xlsx`, `tesseract.js`, and canvas APIs. The dispatcher in `tool-page.js` tries browser-side first; any error or size limit triggers transparent server fallback.
- **Direct Express Backend (fallback / server-only)**: Handles files >50 MB (>200 MB for compress), memory-pressured requests, and server-only tools (translate, powerpoint-to-pdf, excel-to-pdf, pdf-to-powerpoint).
- **Size limits**: compress=200 MB browser threshold; all other browser tools=50 MB — enforced in `BrowserTools.process()`.
- **Memory guard**: If JS heap >800 MB, automatically falls back to the server API.

**Core Features & Design Patterns:**
- **Tool Routing**: A sophisticated dispatcher prioritizes browser-side processing, then the Cloudflare queue, and finally direct Express API calls.
- **User Tiers**: Implemented with `utils/usage.js` for guest, free, and premium users, defining daily file limits and per-file size caps.
- **File Management**: Automatic cleanup of temporary local and R2 storage files. User-saved files in R2 are retained until manually deleted.
- **SEO Optimization**: Dynamic generation of canonical URLs, structured data (JSON-LD for Article, BreadcrumbList, FAQPage), and a dedicated blog system with SEO-friendly content and internal linking.
- **Performance**: Firebase SDK initialization is deferred using `requestIdleCallback` to avoid competing with first paint.
- **Tool Prioritization**: Frontend reordering and badging of tools (Instant, Compress, Advanced) based on execution speed to guide user selection.
- **Editor Features**: Drag-and-drop file reordering with thumbnails, per-file rotation, client-side size guards, and a signup-required modal for large files.

## External Dependencies
- **Cloudflare**: Used for Workers (serverless queue), R2 (object storage for uploads and results), and potentially KV storage.
- **Hugging Face**: For AI-powered tools (OCR, AI Summarizer, Translate, advanced compression, background removal) via Hugging Face Spaces.
- **Firebase**: For frontend hosting, user authentication (via Firebase ID tokens), and potentially other Firebase services.
- **pdf-lib**: JavaScript library for browser-side PDF manipulation.
- **mammoth, pptxgenjs, exceljs, pdf-parse, JSZip**: Libraries for various document format conversions and parsing.
- **sharp**: Node.js module for high-performance image processing.
- **Lucide icons**: For vector icons in the UI.
- **Inter font**: Typography.
- **multer**: Node.js middleware for handling `multipart/form-data`, primarily for file uploads.
- **express-rate-limit, compression**: Express middleware for security and performance.
- **Formspree**: Optional integration for feedback forms.