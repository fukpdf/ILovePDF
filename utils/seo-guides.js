// utils/seo-guides.js
// Guide / tutorial page builder.
// Each guide is a long-form, beginner-friendly step-by-step article
// with HowTo schema, FAQPage schema, and BreadcrumbList.

import { escAttr, escJsonLd, buildBreadcrumb, adSlot } from './seo-shared.js';

export const GUIDES = {
  'how-to-compress-pdf': {
    title:    'How to Compress a PDF — Step-by-Step Guide (Free, No Signup)',
    desc:     'Learn how to reduce PDF file size without losing quality. This free guide covers the fastest method, best settings, and tips for emails and web uploads.',
    h1:       'How to Compress a PDF File (Free Online Guide)',
    toolSlug: 'compress-pdf',
    intro: `Large PDF files are a common pain point — too big to email, too slow to upload, and rejected by online portals with strict size limits. Compressing a PDF reduces its file size, often by 40–80%, while keeping text and images looking sharp.`,
    steps: [
      { name: 'Open the PDF Compressor',   text: 'Go to the Compress PDF tool on ILovePDF. No signup or software installation is required — it works entirely in your browser.' },
      { name: 'Upload your PDF',           text: 'Click "Select PDF" or drag and drop your file into the upload area. Files up to 100 MB are accepted.' },
      { name: 'Choose a compression level',text: 'Select Recommended for the best balance of quality and size. Use Maximum Compression for the smallest possible file, or Low Compression to preserve near-original quality.' },
      { name: 'Click Compress PDF',        text: 'The tool processes your file in seconds. A progress bar shows the current status.' },
      { name: 'Download your file',        text: 'Click the Download button to save the compressed PDF. The filename is prefixed with "ILovePDF-" for easy identification.' },
    ],
    tips: [
      'Image-heavy PDFs compress the most — sometimes by 70–80%.',
      'Text-only PDFs are already small; compression may only save 5–15%.',
      'Use "Recommended" compression for email attachments — it keeps images readable.',
      'If the result is still too large, try compressing again at a higher level.',
      'Compress before protecting with a password — encrypted files resist compression.',
    ],
    faqs: [
      { q: 'How much smaller will my PDF get?', a: 'It depends on content. Image-heavy PDFs typically shrink 40–80%. Text-only PDFs may only compress 5–15%. Scanned PDFs with high-resolution images can often be reduced by 70% or more.' },
      { q: 'Will compressing a PDF make it blurry?', a: 'Not on the Recommended setting. Text and vector graphics are never affected. Only embedded image streams are re-encoded, and the default setting keeps images sharp enough for screens and most printers.' },
      { q: 'Is the PDF Compressor really free?', a: 'Yes — completely free, no account needed, no watermarks, no page limits. The tool runs in your browser.' },
      { q: 'Can I compress multiple PDFs at once?', a: 'Yes. You can upload multiple PDFs to the Compress PDF tool and they will be processed in parallel.' },
    ],
    related: ['compress-pdf', 'merge-pdf', 'protect-pdf', 'pdf-to-word'],
  },

  'how-to-merge-pdf': {
    title:    'How to Merge PDF Files — Step-by-Step Guide (Free)',
    desc:     'Learn how to combine multiple PDFs into one file in seconds. Free online guide — no software, no signup, works on Windows, Mac, iPhone and Android.',
    h1:       'How to Merge PDF Files Into One (Free Guide)',
    toolSlug: 'merge-pdf',
    intro: `Merging PDFs is one of the most common document tasks — combining a cover page with a report, joining chapters, or assembling a multi-part form into a single file. With ILovePDF, you can combine dozens of PDFs in seconds, right in your browser.`,
    steps: [
      { name: 'Open the Merge PDF tool',   text: 'Navigate to the Merge PDF tool. No login is required.' },
      { name: 'Upload your PDFs',          text: 'Click "Select PDF files" or drag and drop all the PDFs you want to merge. You can add as many as you need.' },
      { name: 'Set the page order',        text: 'Drag the file thumbnails to arrange them in the order you want. The first file will become the first pages in the final PDF.' },
      { name: 'Click Merge PDF',           text: 'The tool combines all files into one PDF, preserving the original quality, fonts, and images of every page.' },
      { name: 'Download the result',       text: 'Click Download to save your merged PDF. Both source files and the result are deleted from our servers within minutes.' },
    ],
    tips: [
      'Rename files before uploading to make the drag-to-reorder step easier.',
      'You can merge PDFs from different sources — scanned pages, digital reports, forms.',
      'If one PDF has a password, use Unlock PDF first, then merge.',
      'Compress the merged PDF after combining to reduce the total file size.',
      'Use the Organize PDF tool if you only want to reorder pages within a single document.',
    ],
    faqs: [
      { q: 'How many PDFs can I merge at once?', a: 'You can merge dozens of files as long as the combined upload is under 100 MB. For larger batches, split into groups and merge the results.' },
      { q: 'Will merging damage the PDF quality?', a: 'No. The Merge PDF tool joins pages without re-encoding them — fonts, images, and annotations are preserved exactly.' },
      { q: 'Can I merge scanned PDFs?', a: 'Yes. Merge PDF works on any PDF regardless of whether it contains digital text or scanned images.' },
      { q: 'How do I merge PDFs on iPhone?', a: 'Open the Merge PDF tool in Safari on your iPhone. The tool works on all mobile browsers — upload your PDFs, set the order, and tap Merge PDF to download the result.' },
    ],
    related: ['merge-pdf', 'split-pdf', 'organize-pdf', 'compress-pdf'],
  },

  'how-to-convert-pdf-to-word': {
    title:    'How to Convert PDF to Word — Step-by-Step Guide (Free)',
    desc:     'Convert any PDF to an editable Word document in seconds. Free guide covering digital PDFs, scanned files, and tips for preserving formatting.',
    h1:       'How to Convert a PDF to Word (Free Guide)',
    toolSlug: 'pdf-to-word',
    intro: `Converting a PDF to Word lets you edit, reformat, or copy text from documents that were previously locked in the PDF format. ILovePDF's PDF to Word converter preserves formatting, tables, and images so your Word document is ready to edit immediately.`,
    steps: [
      { name: 'Check your PDF type',    text: 'Try selecting text in your PDF. If you can highlight it, the PDF is digital — proceed to step 2. If not, it is scanned — run OCR PDF first to make the text extractable.' },
      { name: 'Open PDF to Word',       text: 'Go to the PDF to Word tool. No account needed.' },
      { name: 'Upload your PDF',        text: 'Click to upload or drag your PDF into the tool. Files up to 100 MB are accepted.' },
      { name: 'Click Convert to Word',  text: 'The tool extracts text and layout, rebuilding the document structure in Word format.' },
      { name: 'Download the .docx',     text: 'Download and open in Microsoft Word, Google Docs, or LibreOffice to start editing.' },
    ],
    tips: [
      'For scanned PDFs, use OCR PDF first — then convert to Word for editable text.',
      'PDFs with complex multi-column layouts may need minor reformatting after conversion.',
      'Tables are preserved when the original PDF has proper table structure.',
      'If images are missing, the original PDF may have used embedded fonts as images — try the PDF to JPG tool to extract them.',
      'Save a backup of the original PDF before editing the Word version.',
    ],
    faqs: [
      { q: 'Why is my converted Word document full of images instead of text?', a: 'Your PDF is likely scanned or image-based. Use the OCR PDF tool first to recognize the text, then try the conversion again.' },
      { q: 'Does the converter keep my tables?', a: 'Yes. Tables in digital PDFs with clear grid structure are reconstructed as proper Word tables you can edit.' },
      { q: 'Can I convert multiple PDFs to Word at once?', a: 'Yes — upload multiple PDFs and they will be converted in parallel. Each results in its own .docx file.' },
      { q: 'Is there a page limit?', a: 'No page limit. Any PDF up to 100 MB is supported.' },
    ],
    related: ['pdf-to-word', 'ocr-pdf', 'word-to-pdf', 'pdf-to-excel'],
  },

  'how-to-remove-image-background': {
    title:    'How to Remove an Image Background — Free AI Guide',
    desc:     'Remove any background from a photo or image in seconds using free AI. Step-by-step guide for product photos, portraits, logos, and transparent PNGs.',
    h1:       'How to Remove an Image Background (Free AI Tool)',
    toolSlug: 'background-remover',
    intro: `Removing a background from an image used to require Photoshop skills. With AI-powered background removal, you can cut out people, products, animals, or objects in a single click — no selection tools, no masking, no design experience needed.`,
    steps: [
      { name: 'Open Background Remover',   text: 'Navigate to the Background Remover tool on ILovePDF. No account needed.' },
      { name: 'Upload your image',          text: 'Drag your photo into the tool or click to browse. JPG, PNG, and WebP images are supported.' },
      { name: 'AI processes the image',     text: 'The AI segmentation model automatically identifies the foreground subject and separates it from the background in a few seconds.' },
      { name: 'Preview the result',         text: 'The cut-out is shown against a checkerboard pattern indicating transparency.' },
      { name: 'Download the transparent PNG', text: 'Click Download to save the result as a high-quality transparent PNG, ready for use on any background.' },
    ],
    tips: [
      'Well-lit photos with clear contrast between subject and background give the best results.',
      'Product photos on plain backgrounds (white, grey) cut out with near-perfect accuracy.',
      'For portraits, the AI preserves fine details like hair and wisps.',
      'After removing the background, use Image Filters to add a colour wash or blur effect.',
      'For e-commerce, export as PNG with transparency so the product sits cleanly on any page colour.',
    ],
    faqs: [
      { q: 'What image formats does Background Remover accept?', a: 'JPG, PNG, and WebP are all supported. The output is always a transparent PNG.' },
      { q: 'How accurate is the AI at removing backgrounds?', a: 'The AI uses an advanced semantic segmentation model that handles people, products, animals, and complex edges with high accuracy. Fine details like hair and semi-transparent objects are handled well.' },
      { q: 'Are my photos stored or shared?', a: 'No. Your images are processed in memory and automatically deleted from our servers within minutes. They are never stored, shared, or used to train AI models.' },
      { q: 'Can I use Background Remover for product photography?', a: 'Yes — it is specifically optimized for product cut-outs. Drop in your product photo and get a clean transparent PNG for your store, catalogue, or presentation.' },
    ],
    related: ['background-remover', 'crop-image', 'resize-image', 'image-filters'],
  },

  'how-to-protect-pdf': {
    title:    'How to Password-Protect a PDF — Step-by-Step Guide',
    desc:     'Add a password to any PDF in seconds with this free guide. Learn how to encrypt a PDF, set permissions, and control who can open or edit your document.',
    h1:       'How to Add a Password to a PDF (Free Guide)',
    toolSlug: 'protect-pdf',
    intro: `Adding a password to a PDF protects confidential documents from being opened by the wrong person. Whether it is a contract, tax return, medical record, or personal letter, PDF password protection is the standard way to secure sensitive files before sharing.`,
    steps: [
      { name: 'Open Protect PDF',       text: 'Go to the Protect PDF tool on ILovePDF.' },
      { name: 'Upload your PDF',        text: 'Click to upload or drag your PDF. Up to 100 MB.' },
      { name: 'Set an open password',   text: 'Enter the password that will be required to open the PDF. Use a strong password — at least 12 characters with letters, numbers, and symbols.' },
      { name: 'Set permissions (optional)', text: 'Optionally restrict editing, printing, and copying of content using a separate permissions password.' },
      { name: 'Click Protect PDF',      text: 'The tool encrypts the PDF with AES-128 encryption.' },
      { name: 'Download and verify',    text: 'Download the protected PDF and try opening it to confirm the password works.' },
    ],
    tips: [
      'Write down your password and store it safely — ILovePDF cannot recover it if you forget.',
      'Use a unique password for each sensitive document, not the same one for everything.',
      'Compress the PDF before protecting — encrypted PDFs resist further compression.',
      'If you receive a protected PDF you need to edit, use Unlock PDF (with the correct password).',
      'Share the password via a different channel than the file itself for best security.',
    ],
    faqs: [
      { q: 'What encryption does Protect PDF use?', a: 'ILovePDF uses AES-128 encryption, the industry standard for PDF password protection, compatible with all modern PDF viewers.' },
      { q: 'Can I protect a PDF on iPhone?', a: 'Yes. The Protect PDF tool runs in any mobile browser. Upload your PDF, enter a password, and download the encrypted file directly from your phone.' },
      { q: 'What is the difference between open password and permissions password?', a: 'An open password prevents anyone from opening the file without it. A permissions password allows the file to be opened freely but restricts actions like printing or editing.' },
      { q: 'Can a protected PDF be broken?', a: 'AES-128 encrypted PDFs are computationally secure against brute-force attacks with a strong password. Using a long, random password makes the file effectively uncrackable.' },
    ],
    related: ['protect-pdf', 'unlock-pdf', 'redact-pdf', 'sign-pdf'],
  },

  'how-to-split-pdf': {
    title:    'How to Split a PDF — Step-by-Step Guide (Free)',
    desc:     'Split a PDF into separate pages or custom page ranges in seconds. Free guide — no software, no signup. Works on Mac, Windows, iPhone, Android.',
    h1:       'How to Split a PDF Into Multiple Files (Free Guide)',
    toolSlug: 'split-pdf',
    intro: `Splitting a PDF lets you extract specific pages, separate sections, or divide a large document into smaller, more manageable files. Whether you need a single page from a multi-page report or want to separate chapters, the Split PDF tool handles it in seconds.`,
    steps: [
      { name: 'Open Split PDF',         text: 'Go to the Split PDF tool on ILovePDF.' },
      { name: 'Upload your PDF',        text: 'Click to upload your file or drag it in. Any PDF up to 100 MB.' },
      { name: 'Choose split mode',      text: 'Select "Split all pages" to get every page as a separate PDF, or choose "Custom ranges" to specify exactly which pages to extract — for example "1-3,7,10-12".' },
      { name: 'Click Split PDF',        text: 'The tool divides your PDF and packages the results.' },
      { name: 'Download',               text: 'If you split into multiple files, they are delivered as a ZIP. Single-range extractions download as a single PDF.' },
    ],
    tips: [
      'Use custom ranges for precise extractions — "5-8" extracts pages 5 through 8 as one file.',
      'After splitting, use Compress PDF if individual files are still large.',
      'Combine Split with Merge to restructure documents — split to separate chapters, reorder, then merge.',
      'The Organize PDF tool is better if you want to delete or reorder pages within one document.',
    ],
    faqs: [
      { q: 'Can I extract just one page from a PDF?', a: 'Yes. In custom ranges, enter just the page number (e.g., "5") to extract a single page as its own PDF.' },
      { q: 'Will splitting a PDF reduce quality?', a: 'No. Split PDF simply separates existing pages — no re-encoding occurs and quality is identical to the original.' },
      { q: 'What if I only have a scanned PDF?', a: 'Split PDF works on scanned PDFs too — it separates image-based pages just as it does digital ones.' },
      { q: 'How many pages can I split?', a: 'Any PDF within the 100 MB upload limit is supported, regardless of page count.' },
    ],
    related: ['split-pdf', 'merge-pdf', 'organize-pdf', 'compress-pdf'],
  },

  'how-to-add-watermark-to-pdf': {
    title:    'How to Add a Watermark to a PDF — Free Online Guide',
    desc:     'Stamp text or image watermarks on PDF pages in seconds. Free step-by-step guide — no software needed. Works on all devices.',
    h1:       'How to Add a Watermark to a PDF (Free Guide)',
    toolSlug: 'watermark-pdf',
    intro: `Watermarks protect your PDFs from unauthorized use, mark documents as drafts or confidential, and brand your files before sharing. ILovePDF's Watermark PDF tool lets you add text or image watermarks to every page in seconds.`,
    steps: [
      { name: 'Open Watermark PDF',         text: 'Navigate to the Watermark PDF tool.' },
      { name: 'Upload your PDF',             text: 'Drag your file or click to upload. Up to 100 MB.' },
      { name: 'Choose watermark type',       text: 'Select Text (e.g., "CONFIDENTIAL", "DRAFT", your name) or Image (upload a logo or stamp).' },
      { name: 'Customize position and style',text: 'Adjust the position, rotation angle, opacity, font size, and colour. A preview shows the result in real time.' },
      { name: 'Click Watermark PDF',         text: 'The watermark is applied to every page of the document.' },
      { name: 'Download',                    text: 'Download the watermarked PDF.' },
    ],
    tips: [
      'Set opacity to 15–25% for a subtle background watermark that does not obscure content.',
      'Diagonal placement at 45° is the hardest to remove or crop out.',
      'For branding, use a transparent PNG of your logo as the image watermark.',
      'Protect the watermarked PDF with a password to prevent unauthorized editing.',
      'Use "DRAFT" or "CONFIDENTIAL" text watermarks for internal documents before final approval.',
    ],
    faqs: [
      { q: 'Can I remove a watermark added by ILovePDF?', a: 'Watermarks added by Watermark PDF are embedded in the page content. Removing them requires editing tools; for persistent protection, combine with Protect PDF to restrict editing.' },
      { q: 'Can I add a logo as a watermark?', a: 'Yes. Select "Image" as the watermark type and upload your logo. A transparent PNG gives the cleanest result.' },
      { q: 'Does watermarking change the PDF page content?', a: 'Yes — the watermark is permanently drawn on the PDF pages. If you need a non-destructive watermark, apply it to a copy of the original file.' },
      { q: 'Can I watermark multiple PDFs at once?', a: 'Yes — upload multiple PDFs and the same watermark settings will be applied to all of them.' },
    ],
    related: ['watermark-pdf', 'protect-pdf', 'sign-pdf', 'redact-pdf'],
  },

  'how-to-do-ocr-on-pdf': {
    title:    'How to Use OCR on a PDF — Free Online Guide',
    desc:     'Make scanned PDFs searchable and editable with free OCR. Step-by-step guide to extract text from scanned documents, photos, and image-based PDFs.',
    h1:       'How to Use OCR to Make a Scanned PDF Searchable',
    toolSlug: 'ocr-pdf',
    intro: `OCR (Optical Character Recognition) reads the image pixels of a scanned PDF and converts them into real, selectable, searchable text. Without OCR, a scanned PDF is essentially a collection of photographs — you cannot search, copy, or edit the text inside.`,
    steps: [
      { name: 'Confirm your PDF is scanned', text: 'Open the PDF and try to select text. If the cursor becomes a crosshair instead of an I-beam, the PDF is image-based — OCR is needed.' },
      { name: 'Open OCR PDF',                text: 'Go to the OCR PDF tool on ILovePDF.' },
      { name: 'Upload your scanned PDF',     text: 'Upload the file. Up to 100 MB.' },
      { name: 'Select the document language',text: 'Choose the language the document is written in — OCR accuracy improves significantly when the language is correctly set.' },
      { name: 'Choose output mode',          text: 'Select "Searchable PDF" to keep the original layout with an invisible text layer, or "Text-only" for a plain editable document.' },
      { name: 'Click Apply OCR',             text: 'The tool processes each page using a Tesseract-based OCR engine.' },
      { name: 'Download and verify',         text: 'Open the result and try Ctrl+F to search — if text appears in the results, OCR succeeded.' },
    ],
    tips: [
      'Higher resolution scans (300 DPI or above) give much better OCR accuracy.',
      'Correct the scan orientation first with Rotate PDF — OCR works best on upright text.',
      'After OCR, run PDF to Word to get a fully editable document.',
      'For multilingual documents, OCR each language section separately for best results.',
      'Bold, clean fonts (Times New Roman, Arial) OCR better than decorative or handwritten text.',
    ],
    faqs: [
      { q: 'How accurate is ILovePDF OCR?', a: 'For clean, high-resolution scans of printed text, accuracy is typically 90–97%. Accuracy drops for low-quality scans, unusual fonts, or handwriting.' },
      { q: 'What languages does OCR support?', a: 'Over 40 languages including English, Spanish, French, German, Arabic, Chinese, Japanese, Hindi, Russian, and Portuguese.' },
      { q: 'Does OCR change how the PDF looks?', a: 'In "Searchable PDF" mode, the original page images are preserved and an invisible text layer is added — the visual appearance is unchanged.' },
      { q: 'Can OCR read handwriting?', a: 'Standard OCR is optimized for printed text. Handwriting recognition is partially supported but accuracy is lower, especially for cursive or informal writing.' },
    ],
    related: ['ocr-pdf', 'pdf-to-word', 'rotate-pdf', 'translate-pdf'],
  },
};

// ── HTML builder ──────────────────────────────────────────────────────────────
function _stepsHtml(steps) {
  const items = steps.map((s, i) => `
    <div class="guide-step">
      <div class="guide-step-num">${i + 1}</div>
      <div class="guide-step-body">
        <strong>${escAttr(s.name)}</strong>
        <p>${escAttr(s.text)}</p>
      </div>
    </div>`).join('');
  return `<div class="guide-steps">${items}</div>`;
}

function _tipsHtml(tips) {
  const items = tips.map(t => `<li>${escAttr(t)}</li>`).join('');
  return `<ul class="guide-tips">${items}</ul>`;
}

function _faqHtml(faqs) {
  const items = faqs.map((f, i) => `
    <details class="faq-item" ${i === 0 ? 'open' : ''}>
      <summary class="faq-q">${escAttr(f.q)}</summary>
      <div class="faq-a"><p>${escAttr(f.a)}</p></div>
    </details>`).join('');
  return `<section class="faq-section" aria-label="FAQs"><h2>Frequently Asked Questions</h2>${items}</section>`;
}

export function buildGuideHtml(guideSlug, baseHtml) {
  const guide = GUIDES[guideSlug];
  if (!guide) return null;

  const canon = `https://ilovepdf.cyou/guides/${guideSlug}`;

  const bc = buildBreadcrumb([
    { name: 'Home',   url: '/' },
    { name: 'Guides', url: '/guides' },
    { name: guide.h1, url: null },
  ]);

  // HowTo JSON-LD
  const howToLd = {
    '@context': 'https://schema.org', '@type': 'HowTo',
    name: guide.h1,
    description: guide.desc,
    step: guide.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
    tool: [{ '@type': 'HowToTool', name: 'ILovePDF — free online PDF tools' }],
  };

  // FAQPage JSON-LD
  const faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: guide.faqs.map(f => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const RELATED_NAMES = {
    'compress-pdf':'Compress PDF','merge-pdf':'Merge PDF','protect-pdf':'Protect PDF',
    'pdf-to-word':'PDF to Word','split-pdf':'Split PDF','organize-pdf':'Organize PDF',
    'background-remover':'Background Remover','crop-image':'Crop Image',
    'resize-image':'Resize Image','image-filters':'Image Filters',
    'unlock-pdf':'Unlock PDF','redact-pdf':'Redact PDF','sign-pdf':'Sign PDF',
    'watermark-pdf':'Watermark PDF','ocr-pdf':'OCR PDF','rotate-pdf':'Rotate PDF',
    'word-to-pdf':'Word to PDF','pdf-to-excel':'PDF to Excel','translate-pdf':'Translate PDF',
  };

  const relatedCards = guide.related.map(s =>
    `<a class="related-card" href="/${s}"><span class="related-name">${RELATED_NAMES[s]||s}</span><span class="related-arrow">→</span></a>`
  ).join('');

  const headExtras = [
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escAttr(canon)}">`,
    `<meta property="og:site_name" content="ILovePDF">`,
    `<meta property="og:title" content="${escAttr(guide.title)}">`,
    `<meta property="og:description" content="${escAttr(guide.desc)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escAttr(guide.title)}">`,
    `<meta name="twitter:description" content="${escAttr(guide.desc)}">`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(howToLd))}</script>`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(faqLd))}</script>`,
    bc.jsonLd,
  ].join('');

  const body = `
    ${bc.html}
    ${adSlot('below-tool')}
    <section class="seo-block" aria-label="Guide">
      <div class="seo-inner">
        <h1 class="seo-h1">${escAttr(guide.h1)}</h1>
        <p class="guide-intro">${escAttr(guide.intro)}</p>

        <h2>Step-by-Step Instructions</h2>
        ${_stepsHtml(guide.steps)}

        <a class="guide-cta-btn" href="/${guide.toolSlug}">Open ${escAttr(guide.h1.split(' to ')[1] || guide.toolSlug)} →</a>

        ${adSlot('mid-content')}

        <h2>Pro Tips</h2>
        ${_tipsHtml(guide.tips)}

        ${_faqHtml(guide.faqs)}

        <h2>Related tools</h2>
        <div class="related-grid">${relatedCards}</div>
      </div>
      ${adSlot('sidebar', { desktopOnly: true })}
    </section>`;

  let html = baseHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(guide.title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${escAttr(guide.desc)}">`)
    .replace(/<meta\s+name="keywords"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    .replace(/<\/head>/, `<link rel="canonical" href="${escAttr(canon)}">${headExtras}</head>`)
    .replace(/<\/main>/, `${body}</main>`)
    .replace('</body>', `<script>window.__CATEGORY_PAGE=true;window.__GUIDE_SLUG=${JSON.stringify(guideSlug)};</script></body>`);

  return html;
}

// Index page for /guides
export function buildGuideIndexHtml(baseHtml) {
  const canon = 'https://ilovepdf.cyou/guides';
  const title = 'Free PDF & Image Tool Guides — ILovePDF';
  const desc  = 'Step-by-step tutorials for every ILovePDF tool. Learn how to compress, merge, split, convert, OCR, and protect PDFs plus image editing guides.';

  const cards = Object.keys(GUIDES).map(slug => {
    const g = GUIDES[slug];
    return `<a class="cat-card" href="/guides/${slug}">
      <span class="cat-card-name">${escAttr(g.h1)}</span>
      <span class="cat-card-arrow">→</span>
    </a>`;
  }).join('');

  const bc = buildBreadcrumb([{ name: 'Home', url: '/' }, { name: 'Guides', url: null }]);

  const headExtras = [
    `<meta name="robots" content="index, follow">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta property="og:url" content="${escAttr(canon)}">`,
    `<meta property="og:site_name" content="ILovePDF">`,
    bc.jsonLd,
  ].join('');

  const body = `
    ${bc.html}
    ${adSlot('below-tool')}
    <section class="seo-block" aria-label="Guides">
      <div class="seo-inner">
        <h1 class="seo-h1">Free PDF & Image Guides</h1>
        <p>Step-by-step tutorials for every ILovePDF tool. Whether you're a first-time user or a power user looking for tips, these guides walk you through every major workflow.</p>
        <div class="related-grid cat-grid">${cards}</div>
      </div>
    </section>`;

  return baseHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${escAttr(desc)}">`)
    .replace(/<meta\s+name="keywords"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    .replace(/<\/head>/, `<link rel="canonical" href="${escAttr(canon)}">${headExtras}</head>`)
    .replace(/<\/main>/, `${body}</main>`)
    .replace('</body>', `<script>window.__CATEGORY_PAGE=true;</script></body>`);
}
