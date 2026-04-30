// utils/seo-categories.js
// Category page metadata + slug membership.
// Each category page is a hub that links to a curated set of tool slugs and
// gets its own SEO meta, JSON-LD, breadcrumbs and intro content.

import { SLUG_MAP, _registerCategoryForSlug } from './seo.js';

// Slug → { name, intro, slugs[], priority }.
// `slugs` is the canonical list of tool URLs surfaced on the category page.
// Tools may legitimately appear in multiple categories (e.g. Redact PDF lives
// in both Edit and Security) — that's normal for hub pages.
export const CATEGORIES = {
  'pdf-tools': {
    name: 'PDF Tools',
    title: 'All PDF Tools — Free Online PDF Toolkit | ILovePDF',
    desc: 'Explore every free PDF tool from ILovePDF: merge, split, compress, convert, edit, watermark, sign, protect, OCR, AI summarize and more. No signup required.',
    intro: `Welcome to the complete <strong>PDF toolkit</strong> from ILovePDF.
      Every tool below runs entirely in your browser, requires no signup, and
      automatically deletes your files within minutes after processing. Whether
      you need to combine documents, shrink a file for email, convert between
      formats, or apply a digital signature, you'll find a free tool below.`,
    priority: 0.9,
    slugs: [
      'merge-pdf','split-pdf','rotate-pdf','crop-pdf','organize-pdf',
      'compress-pdf',
      'pdf-to-word','pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg',
      'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','jpg-to-pdf','html-to-pdf',
      'edit-pdf','watermark-pdf','sign-pdf','add-page-numbers','redact-pdf',
      'protect-pdf','unlock-pdf',
      'repair-pdf','scan-pdf','ocr-pdf','compare-pdf',
      'ai-summarizer','translate-pdf','workflow-builder',
    ],
  },
  'convert-pdf': {
    name: 'Convert PDF',
    title: 'PDF Converter — Convert PDF to/from Word, Excel, PPT, JPG | ILovePDF',
    desc: 'Convert PDFs to and from Word, PowerPoint, Excel, JPG and HTML for free. Fast, accurate, no signup. Files are deleted automatically after processing.',
    intro: `Use these <strong>PDF conversion tools</strong> to switch between
      PDF and any popular document or image format. Conversions preserve
      original layout, fonts and tables wherever possible so you can keep
      working without re-doing your formatting.`,
    priority: 0.9,
    slugs: [
      'pdf-to-word','pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg',
      'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','jpg-to-pdf','html-to-pdf',
    ],
  },
  'edit-pdf': {
    name: 'Edit PDF',
    title: 'Edit PDF Online — Annotate, Watermark, Sign & Number Pages | ILovePDF',
    desc: 'Free online PDF editing tools: edit text, add watermarks, electronically sign, add page numbers, redact and reorganize PDF pages. No signup, no install.',
    intro: `These <strong>PDF editing tools</strong> let you change a PDF
      directly in your browser — add text, watermark, signature, page numbers,
      or rearrange pages. All changes are written to a fresh copy so your
      original file is never modified.`,
    priority: 0.85,
    slugs: [
      'edit-pdf','watermark-pdf','sign-pdf','add-page-numbers','redact-pdf',
      'rotate-pdf','crop-pdf','organize-pdf',
    ],
  },
  'security-tools': {
    name: 'PDF Security',
    title: 'PDF Security Tools — Protect, Unlock & Redact PDFs | ILovePDF',
    desc: 'Protect a PDF with a password, unlock a password-protected PDF, or permanently redact sensitive information. Free, secure, and processed in-browser.',
    intro: `Keep your documents safe with our <strong>PDF security tools</strong>.
      Add password protection, remove restrictions from a PDF you own, or
      permanently black out sensitive text and images before sharing.`,
    priority: 0.8,
    slugs: [
      'protect-pdf','unlock-pdf','redact-pdf','sign-pdf','watermark-pdf',
    ],
  },
  'image-tools': {
    name: 'Image Tools',
    title: 'Free Image Tools — Background Remover, Crop, Resize, Filters | ILovePDF',
    desc: 'Free online image tools by ILovePDF: AI background remover, crop, resize, and image filters. Edit photos in your browser without signup.',
    intro: `Quick, free <strong>image tools</strong> for everyday tasks —
      remove a photo background with AI, crop or resize an image, or apply
      filter effects. All tools work directly in your browser.`,
    priority: 0.85,
    slugs: [
      'background-remover','crop-image','resize-image','image-filters',
      'jpg-to-pdf','pdf-to-jpg',
    ],
  },
  'utilities': {
    name: 'Utilities',
    title: 'PDF Utilities & Smart Tools — OCR, AI Summarizer, Translate & More | ILovePDF',
    desc: 'Smart PDF utilities and converters: OCR, AI summarizer, translate, compare, repair, scan, workflow builder, numbers to words and more — all free.',
    intro: `Smart utilities and <strong>document automation tools</strong> for
      power users — extract text with OCR, summarize long PDFs with AI,
      translate documents into other languages, or compare two versions of a
      file side-by-side.`,
    priority: 0.75,
    slugs: [
      'ocr-pdf','ai-summarizer','translate-pdf','compare-pdf',
      'repair-pdf','scan-pdf','workflow-builder',
      'numbers-to-words','currency-converter',
    ],
  },
};

// Reverse index: slug → category-slug for breadcrumb labelling.
// We pick the first non-broad category for display; the broad "pdf-tools"
// catch-all is only used when nothing more specific matches.
// Registered with seo.js (lazy callback) to break the import cycle.
_registerCategoryForSlug((slug) => categoryForSlug(slug));

export function categoryForSlug(slug) {
  const broad = 'pdf-tools';
  for (const [catSlug, cat] of Object.entries(CATEGORIES)) {
    if (catSlug === broad) continue;
    if (cat.slugs.includes(slug)) return { catSlug, name: cat.name };
  }
  if (CATEGORIES[broad].slugs.includes(slug)) {
    return { catSlug: broad, name: CATEGORIES[broad].name };
  }
  return null;
}

// Helper used by sitemap + indexing endpoints — every public URL on the site.
export function allPublicSlugs() {
  return {
    home: '/',
    tools: Object.keys(SLUG_MAP),
    categories: Object.keys(CATEGORIES),
    utilities: ['privacy', 'terms', 'disclaimer', 'blog'],
    blogs: [
      'merge-pdf-guide','split-pdf-guide','rotate-pdf-guide','crop-pdf-guide','organize-pdf-guide',
      'compress-pdf-guide',
      'pdf-to-word-guide','pdf-to-powerpoint-guide','pdf-to-excel-guide','pdf-to-jpg-guide',
      'word-to-pdf-guide','powerpoint-to-pdf-guide','excel-to-pdf-guide','jpg-to-pdf-guide','html-to-pdf-guide',
      'edit-pdf-guide','watermark-pdf-guide','sign-pdf-guide','add-page-numbers-guide','redact-pdf-guide',
      'protect-pdf-guide','unlock-pdf-guide',
      'repair-pdf-guide','scan-pdf-guide','ocr-pdf-guide','compare-pdf-guide',
      'ai-summarizer-guide','translate-pdf-guide','workflow-builder-guide',
      'numbers-to-words-guide','currency-converter-guide',
      'background-remover-guide','crop-image-guide','resize-image-guide','image-filters-guide',
      'best-pdf-tools',
    ],
  };
}
