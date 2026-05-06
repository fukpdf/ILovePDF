# ILovePDF — Free Online PDF & Image Tools
ILovePDF is a platform offering 33 online tools for PDF and image processing, providing a comprehensive, user-friendly, and highly available service for document manipulation.

## Run & Operate
- **Run**: `node server.js`
- **Port**: 5000
- **Environment Variables**:
    - `JWT_SECRET`: Required for authentication.
    - `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`: Optional, for Firebase Auth.
    - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`: Optional, for Cloudflare R2 storage.
    - `HF_API_TOKEN`: Informational only (AI tools use local/extractive logic).

## Stack
- **Frontend**: Pure HTML/CSS/JS
- **Backend**: Express.js (Node.js 20)
- **Database**: SQLite (for users, pending signups)
- **ORM**: _Populate as you build_
- **Validation**: Custom validation layers (`validateBlob`, `validateContent`, `analyzeResultQuality`)
- **Build Tool**: _Populate as you build_

## Where things live
- `server.js`: Express entry point, middleware, routes.
- `routes/`: API endpoints for authentication and tool categories.
- `utils/db.js`: SQLite database schema and operations.
- `public/`: All frontend assets (HTML, CSS, JS).
- `public/js/tools-config.js`: Source of truth for all 33 tool definitions.
- `public/css/home.css`: Defines Z-index system and core UI styles.
- `public/laba/`: Laba AI Widget implementation.

## Architecture decisions
- **Browser-side Processing**: All 33 PDF/image tools run 100% in the browser using libraries like pdf-lib, tesseract.js, and canvas APIs, with no server-side fallback for tool processing.
- **Client-Server Split**: A lightweight Express.js server handles authentication and static file serving, while complex document processing is offloaded to the client.
- **Three-Tier Validation Pipeline**: `validateBlob` (size gate) → `validateContent` (per-tool content rules) → `analyzeResultQuality` (enforced score gate). All must pass before download is triggered — no fake success.
- **Quality Score Enforcement (v5.3)**: `analyzeResultQuality()` uses hybrid scoring — 65% output-size ratio + 35% structural metadata (chars, paras, rows, pages, ocrUsed). Score < 0.40 on binary-output tools (`_BINARY_TOOLS` Set) throws `low_quality_output` and blocks download. Score 0.40–0.69 logs a warning only.
- **Universal Fallback Chains**: Every tool follows Worker → CPU inline → alternative logic → clean fail. Background remover: 2-pass retry (original threshold → relaxed by −25); hard fail with user message if no alpha detected. Repair: 2-pass loop + pdfjsLib integrity check after repair.
- **Zero Technical Leakage (Stealth Mode)**: `safeMessage()` intercepts all errors and maps them to user-friendly messages. Internal terms (worker, wasm, OPFS, gpu, thread, SharedArray, chunk, ArrayBuffer) are never exposed.
- **Comprehensive Error Handling**: Internal error types are mapped to clean, non-technical user-facing messages, often guiding users to alternative tools (e.g., OCR for scanned PDFs).
- **Deferred Firebase Init**: Firebase SDK initialization is deferred using `requestIdleCallback` to prioritize initial page load and user experience.

## Product
- 33 online tools for PDF and image processing (merge, split, compress, convert, edit, OCR, AI summarization, image manipulation).
- User tiers: Guest, Free, and Premium with varying file limits and size caps.
- SEO optimized with dynamic canonical URLs, structured data, and a blog system.
- Responsive UI/UX with a distinctive red theme and glassmorphism elements.
- Laba AI Widget for conversational assistance with voice support and contextual suggestions.

## User preferences
I prefer detailed explanations.
I want an iterative development process.
I want to be asked before major changes are made.

## Gotchas
- The `JWT_SECRET` environment variable is critical for authentication.
- Worker-dependent tools require `workerPool.js` to be correctly loaded before `browser-tools.js`.
- Deep compression makes text unselectable; a warning is displayed.
- Translate PDF tool will throw an error if no extractable text is found, guiding users to OCR first.

## Pointers
- **pdf-lib documentation**: [https://pdf-lib.js.org/](https://pdf-lib.js.org/)
- **tesseract.js documentation**: [https://tesseract.projectnaptha.com/](https://tesseract.projectnaptha.com/)
- **Express.js documentation**: [https://expressjs.com/](https://expressjs.com/)
- **Firebase Authentication**: [https://firebase.google.com/docs/auth](https://firebase.google.com/docs/auth)
- **Cloudflare R2 documentation**: [https://developers.cloudflare.com/r2/](https://developers.cloudflare.com/r2/)