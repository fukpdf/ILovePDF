# ILovePDF — Free Online PDF & Image Tools

A production-ready PDF + image processing platform with 33 tools, branded as **ILovePDF** (red theme #E5322E).

## Architecture

```
/
├── server.js                    — Express entry (port 5000, rate limiting, security headers)
├── utils/cleanup.js             — File cleanup + shared response helpers
├── controllers/
│   ├── pdfController.js
│   └── imageController.js
├── routes/                      — All routes accept files up to 100 MB
│   ├── organize.js              — Merge, Split, Rotate, Crop, Organize PDF
│   ├── edit.js                  — Compress, Edit, Watermark, Sign, Page Numbers, Redact
│   ├── convert.js               — JPG↔PDF, Scan, PDF↔Word/PPT/Excel/HTML
│   ├── security.js              — Protect / Unlock PDF
│   ├── advanced.js              — Repair, OCR, Compare, AI Summarizer, Translate, Workflow
│   └── image.js                 — Background Remover, Crop, Resize, Filters
└── public/
    ├── index.html               — Dashboard (mega-menu header, 5-col footer, signup modal, processing overlay)
    ├── tool.html                — Tool page (same persistent layout)
    ├── blog.html, blog/         — Blog
    ├── privacy.html, terms.html, disclaimer.html
    ├── robots.txt, sitemap.xml
    ├── css/styles.css           — Full design system (red theme, mega-menu, footer, processing UI)
    └── js/
        ├── tools-config.js      — All tool definitions + 8 categories (matches header hierarchy)
        ├── sidebar.js           — Sidebar nav with category groupings
        ├── mega-menu.js         — Topbar mega-menu (8 categories with hover/click dropdowns)
        ├── dashboard.js         — Card rendering for the home page
        ├── tool-page.js         — Per-tool UI, drag-drop reorder, rotation, branded download, signup check
        └── shared.js            — Modals, sidebar toggle, cookies, signup-required, processing overlay
```

## Brand & UI

- **Brand**: ILovePDF
- **Primary color**: `#E5322E` (red)
- **Download filenames**: `ILovePDF-[Original-Name].<ext>`
- **Persistent layout**: header (with mega-menu) and 5-column footer present on every page
- **Mega-menu hierarchy** (matches sidebar):
  - Organize PDFs · Compress & Optimize · Convert From PDF · Convert To PDF · Edit & Annotate · Security · Advanced Tools · Image Tools

## Editor Features

- File thumbnails with drag-and-drop reordering (mouse + touch)
- Per-file rotation control (`rotations[]` sent in form data)
- Dedicated full-screen **processing overlay** with animated spinner before download
- 100 MB client-side size guard → opens **Sign Up Required** modal
- 100 MB backend limit (multer) returns `413` → also triggers Sign Up modal

## Tech Stack

- **Backend**: Node.js + Express 5 (ES Modules), multer (100 MB), express-rate-limit, compression
- **PDF processing**: pdf-lib, mammoth, pptxgenjs, exceljs, pdf-parse, JSZip
- **Image processing**: sharp
- **Frontend**: Pure HTML/CSS/JS (no frameworks), Lucide icons, Inter font, fully responsive

## Running

```bash
node server.js   # listens on port 5000
```
