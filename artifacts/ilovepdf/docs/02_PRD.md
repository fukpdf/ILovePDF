# 02 — PRODUCT REQUIREMENT DOCUMENT (PRD)

## Vision

ILovePDF is the fastest, most private, and most accessible PDF and image tool suite available online. Every tool runs without an account, runs in the user's browser (zero upload for most tasks), and produces results in seconds. The experience is frictionless: no software, no plugins, no waiting.

---

## Goals

| Goal | Metric |
|------|--------|
| Zero-friction file processing | 90%+ of common operations complete in < 5 seconds |
| Privacy by default | Files auto-deleted; most tools never leave the browser |
| Breadth of coverage | 43+ tool slugs covering all common PDF + image workflows |
| Revenue readiness | AdSense compliant; publisher tag on all pages |
| SEO authority | JSON-LD on all pages; 37 blog articles; top-3 keyword coverage for each tool |
| Mobile-ready | Responsive layout; touch-friendly PageOrganizer |

---

## User Flow

### Standard Tool Flow (3 steps)

```
1. UPLOAD (/merge-pdf)
   User lands on tool page → uploads file(s) via drag-drop or file picker
   → Client validates file type and size
   → PageOrganizer grid mounts for PDF single-file tools
   → User configures options (rotation angle, page range, etc.)

2. PREVIEW (/merge-pdf/preview)
   → LivePreview Engine mounts (where supported)
   → User can reorder/rotate/delete pages in the PageOrganizer grid
   → User clicks "Process" button

3. DOWNLOAD (/merge-pdf/download)
   → BrowserTools.process() (or server API fallback) generates output
   → Success state shows "Your file is ready" + Download button
   → User can download or process another file
```

### Special Tool Flows

- **Numbers to Words** (`/numbers-to-words`): Standalone page, no file upload
- **Currency Converter** (`/currency-converter`): Standalone page, live exchange rates via external API
- **QR Code Generator**: Standalone page, canvas-based QR generation
- **Barcode Generator**: Standalone page
- **ZIP Builder**: Standalone page

---

## Target Audience

| Segment | Need |
|---------|------|
| Office workers | Merge, split, rotate, protect, watermark PDFs |
| Students | Compress, convert PDF to Word/Excel, OCR scanned documents |
| Developers | Quick file manipulation without installing tools |
| Small businesses | Invoice processing, form filling, signature |
| General public | Any file task without installing software |
| International users | Multilingual UI (i18n system), translated content |

---

## Revenue Strategy

1. **Google AdSense** (primary): Publisher ID `ca-pub-3242156405919556`; ad slots present on all tool pages, blog, legal pages, homepage
2. **Premium tier** (planned): Unlimited daily usage, larger file sizes, priority processing; `users.plan` column already exists in SQLite schema
3. **Guest → Free → Premium funnel**: Guests (10 files/day, 60 MB/file) → Free (30 files/day, 200 MB/file) → Premium (unlimited)
4. **Community economy** (stub): `/api/community` endpoint exists for future engagement-based credits

---

## Future Roadmap

| Priority | Feature |
|----------|---------|
| High | Stripe/payment integration for Premium plan |
| High | Email verification flow (verify-signup.html exists, needs email sender) |
| High | Actual ad unit placements (slots already in HTML) |
| Medium | OCR language expansion (currently English-focused) |
| Medium | AI summarizer improvements (currently extractive; HuggingFace token stub present) |
| Medium | Workflow builder tool (slug exists, `working: false`) |
| Medium | PDF translate improvements (currently MyMemory API, text-only) |
| Low | PowerPoint-to-PDF improvements (currently basic) |
| Low | Scan-to-PDF with OCR integration |
| Low | Community features (credits, sharing, collaboration) |
| Low | Mobile app (Cloudflare Worker + R2 already architected) |

---

## User Tiers

| Tier | Files/day | Max file size | Cost |
|------|-----------|---------------|------|
| Guest (anon/IP) | 10 | 60 MB | Free |
| Free (logged in) | 30 | 200 MB | Free |
| Premium | Unlimited | 200 MB (configurable) | Paid (not yet active) |

---

## Content Strategy

- **37 blog articles**: Long-form guides for each major tool (1,500-3,000 words each)
- **FAQ schema**: 5-7 Q&A per tool page (structured data + visible FAQ section)
- **HowTo schema**: 5-step instructions per tool (Google rich results eligible)
- **Tool descriptions**: 300+ word body content on each tool page (injected via `seo.js`)
- **About page**: Company story, mission, trust signals, contact info
