# ILovePDF — Free Online PDF & Image Tools

## Overview
ILovePDF is a production-ready platform offering 33 online tools for PDF and image processing. The project aims to provide a comprehensive, user-friendly, and highly available service for document manipulation, targeting a broad user base with both free and premium tiers. Key capabilities include PDF merging, splitting, compression, conversion (to/from Word, PPT, Excel, HTML, JPG), editing, security features, advanced tools like OCR and AI summarization, and a suite of image manipulation tools. The platform emphasizes performance, security, and a seamless user experience across various devices.

## User Preferences
I prefer detailed explanations.
I want an iterative development process.
I want to be asked before major changes are made.

## System Architecture
The application follows a client-server architecture. The frontend is built with pure HTML/CSS/JS, focusing on a responsive and intuitive UI/UX with a distinctive red theme (`#E5322E`). Key UI components include a persistent mega-menu header, a 5-column footer, a dashboard with tool cards, and a dedicated processing overlay.

The backend is an Express.js server handling API requests, file uploads (up to 100 MB), and orchestrating PDF/image processing. Processing logic is distributed:
- **Browser-side processing**: For instant, lightweight operations using `pdf-lib`, `pdfjs`, and canvas.
- **Cloudflare Worker (Queue)**: For heavy, AI-backed, or complex tasks, leveraging Hugging Face Spaces for advanced processing. This provides a scalable, serverless queue system.
- **Direct Express Backend**: As a fallback for browser/queue failures and for specific tools requiring server-side encryption (e.g., PDF Protection).

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