// utils/seo-comparison.js
// Comparison page builder — "Tool A vs Tool B" or "Format A vs Format B"
// Each page includes: intro, feature table, FAQ, HowTo steps, BreadcrumbList,
// FAQPage + SoftwareApplication JSON-LD, related tools.

import { escAttr, escJsonLd, buildBreadcrumb, adSlot } from './seo-shared.js';

export const COMPARISONS = {
  'pdf-compressor-vs-zip': {
    title:    'PDF Compressor vs ZIP Archiver — Which Should You Use?',
    desc:     'Compare PDF compression and ZIP archiving. Learn when to compress a PDF directly vs packing it in a ZIP, with size benchmarks and use-case guidance.',
    h1:       'PDF Compressor vs ZIP: Which Saves More Space?',
    toolA:    { name: 'PDF Compressor', slug: 'compress-pdf', url: '/compress-pdf' },
    toolB:    { name: 'ZIP Builder',    slug: 'zip-builder',  url: '/zip-builder'  },
    intro: `When you need to reduce the size of a PDF, you have two options: compress the PDF itself to shrink image streams and remove embedded redundancy, or pack it inside a ZIP archive. Both approaches reduce file size, but they work very differently and suit different workflows.`,
    features: [
      { aspect: 'Best for',            a: 'Email attachments, web uploads',   b: 'Bundling multiple files together' },
      { aspect: 'Output format',       a: 'PDF (stays a PDF)',                 b: 'ZIP (must be extracted first)' },
      { aspect: 'Typical size saving', a: '40–80% for image-heavy PDFs',      b: '0–5% for already-compressed PDFs' },
      { aspect: 'Preserves quality',   a: 'Text always sharp; images tunable', b: 'Lossless — no quality loss' },
      { aspect: 'Mobile friendly',     a: 'Yes — result opens directly',       b: 'Requires extraction app on mobile' },
      { aspect: 'Multiple files',      a: 'One PDF at a time',                 b: 'Bundle unlimited files at once' },
      { aspect: 'Free to use',         a: 'Yes',                               b: 'Yes' },
    ],
    faqs: [
      { q: 'Does zipping a PDF make it much smaller?', a: 'Usually not. PDFs already use internal compression for image streams. A ZIP wrapper typically adds only 0–5% extra reduction. For real size savings, use the PDF Compressor which re-encodes image streams.' },
      { q: 'When should I use PDF Compressor instead of ZIP?', a: 'Use PDF Compressor when you need the file to remain a PDF — for email, web uploads, or cloud storage. Use ZIP when you need to bundle multiple documents into one transferable package.' },
      { q: 'Will PDF Compressor affect my text?', a: 'No. Text and vector elements stay pixel-perfect. Only image streams are re-encoded, and you can choose the quality level.' },
      { q: 'Can I compress a PDF and then ZIP it?', a: 'Yes — and this is a common workflow. Compress the PDF first, then add it to a ZIP along with other files if needed.' },
    ],
    related: ['compress-pdf', 'zip-builder', 'merge-pdf', 'protect-pdf'],
  },

  'jpg-vs-png': {
    title:    'JPG vs PNG — Which Image Format Should You Use?',
    desc:     'JPG vs PNG: understand the differences in quality, file size, transparency and use cases. Plus free tools to convert between them instantly.',
    h1:       'JPG vs PNG: Key Differences Explained',
    toolA:    { name: 'Image Converter (to JPG)', slug: 'image-converter', url: '/image-converter' },
    toolB:    { name: 'Image Converter (to PNG)', slug: 'image-converter', url: '/image-converter' },
    intro: `JPG and PNG are the two most common image formats on the web. Choosing the wrong one can mean a file that is 10× larger than it needs to be, or a loss of quality that ruins your design. Here is a clear breakdown of when to use each.`,
    features: [
      { aspect: 'Compression',         a: 'Lossy — smaller files',          b: 'Lossless — larger files' },
      { aspect: 'Transparency',        a: 'Not supported',                  b: 'Full alpha channel' },
      { aspect: 'Best for',            a: 'Photos, gradients',              b: 'Logos, screenshots, UI' },
      { aspect: 'Typical size',        a: '50–200 KB for a photo',          b: '200 KB–2 MB for same photo' },
      { aspect: 'Web performance',     a: 'Faster loading',                 b: 'Slower for photos' },
      { aspect: 'Edit & re-save',      a: 'Quality degrades each save',     b: 'No quality loss on re-save' },
      { aspect: 'Background removal',  a: 'White/colour background',        b: 'Transparent background' },
    ],
    faqs: [
      { q: 'Should I use JPG or PNG for my website?', a: 'Use JPG for photos and complex images with many colours — it gives much smaller file sizes. Use PNG for logos, icons, screenshots, and any image that needs a transparent background.' },
      { q: 'Can I convert a JPG to PNG without quality loss?', a: 'You can convert JPG to PNG, but you cannot recover quality that was already lost in the original JPG compression. The PNG will simply store the already-compressed pixels losslessly from that point forward.' },
      { q: 'Which format is better for printing?', a: 'PNG is generally better for print because it is lossless. However, many professional printers prefer TIFF or PDF. For sharing proofs, PNG at 300 DPI is the common choice.' },
      { q: 'What is the difference between JPG and JPEG?', a: 'Nothing. JPEG is the full name (Joint Photographic Experts Group); JPG is simply a shorter file extension used on older systems limited to 3-character extensions.' },
    ],
    related: ['image-converter', 'image-compressor', 'background-remover', 'jpg-to-pdf'],
  },

  'pdf-to-word-vs-ocr': {
    title:    'PDF to Word vs OCR PDF — What Is the Difference?',
    desc:     'Understand when to use PDF to Word conversion vs OCR. Learn which tool gives editable text from different PDF types, with step-by-step guidance.',
    h1:       'PDF to Word vs OCR: Which Tool Do You Need?',
    toolA:    { name: 'PDF to Word', slug: 'pdf-to-word', url: '/pdf-to-word' },
    toolB:    { name: 'OCR PDF',     slug: 'ocr-pdf',     url: '/ocr-pdf' },
    intro: `Both PDF to Word and OCR (Optical Character Recognition) extract text from PDFs — but they target completely different types of documents. Using the wrong one gives you a file with no editable text at all.`,
    features: [
      { aspect: 'Input type',          a: 'Digital / text-based PDF',        b: 'Scanned / image-based PDF' },
      { aspect: 'How it works',        a: 'Extracts embedded text directly',  b: 'Reads image pixels using AI' },
      { aspect: 'Output',              a: 'Editable .docx with formatting',   b: 'Searchable PDF or plain text' },
      { aspect: 'Accuracy',            a: '99%+ for digital PDFs',           b: '85–97% depending on scan quality' },
      { aspect: 'Preserves layout',    a: 'Yes — tables, columns, images',   b: 'Basic layout only' },
      { aspect: 'Speed',               a: 'Very fast',                        b: 'Slower — AI processing' },
      { aspect: 'Best for',            a: 'Forms, contracts, reports',        b: 'Scanned receipts, old documents' },
    ],
    faqs: [
      { q: 'How do I know if my PDF is scanned or digital?', a: 'Try selecting text in the PDF. If you can highlight words, it is digital — use PDF to Word. If the cursor turns into a crosshair or nothing highlights, the PDF is scanned — use OCR.' },
      { q: 'Can I use PDF to Word on a scanned PDF?', a: 'You can try, but you will get a blank DOCX with only images. Run OCR first to make the PDF text-based, then convert with PDF to Word for the best result.' },
      { q: 'Does OCR work on handwriting?', a: 'Standard OCR is optimized for printed text. Handwriting recognition requires specialized AI models. For casual handwriting, OCR may partially work; for cursive or poor handwriting, accuracy is low.' },
      { q: 'Is OCR free on ILovePDF?', a: 'Yes. OCR PDF runs in your browser using WebAssembly, is 100% free, and requires no account.' },
    ],
    related: ['pdf-to-word', 'ocr-pdf', 'pdf-to-excel', 'translate-pdf'],
  },

  'merge-pdf-vs-organize-pdf': {
    title:    'Merge PDF vs Organize PDF — Which Tool Do You Need?',
    desc:     'Merge PDF combines multiple files into one. Organize PDF lets you reorder, delete, and duplicate pages within a single file. Learn which to use.',
    h1:       'Merge PDF vs Organize PDF: The Key Difference',
    toolA:    { name: 'Merge PDF',    slug: 'merge-pdf',    url: '/merge-pdf' },
    toolB:    { name: 'Organize PDF', slug: 'organize-pdf', url: '/organize-pdf' },
    intro: `Merge PDF and Organize PDF look similar but solve different problems. Merge is for combining separate files; Organize is for rearranging what is already inside a single PDF.`,
    features: [
      { aspect: 'Input',               a: '2+ separate PDF files',           b: '1 PDF file' },
      { aspect: 'Main action',         a: 'Combine into one PDF',            b: 'Reorder, delete, duplicate pages' },
      { aspect: 'Page order control',  a: 'Drag files to set file order',    b: 'Drag individual pages' },
      { aspect: 'Delete pages',        a: 'No',                              b: 'Yes' },
      { aspect: 'Add blank pages',     a: 'No',                              b: 'Yes' },
      { aspect: 'Use case',            a: 'Combining chapters, contracts',   b: 'Cleaning up, removing extras' },
    ],
    faqs: [
      { q: 'Can I use both tools together?', a: 'Absolutely. A common workflow: Organize each PDF individually to remove unwanted pages, then Merge the cleaned PDFs into a final document.' },
      { q: 'Does Merge PDF change the page content?', a: 'No. Merge PDF simply joins pages end-to-end; it does not alter fonts, images, or annotations.' },
      { q: 'Can Organize PDF add pages from another document?', a: 'No — for adding pages from a second file, use Merge PDF. Organize only works within a single document.' },
    ],
    related: ['merge-pdf', 'organize-pdf', 'split-pdf', 'rotate-pdf'],
  },
};

// ── HTML builder ─────────────────────────────────────────────────────────────
function _featureTable(features, nameA, nameB) {
  const rows = features.map(f => `
    <tr>
      <td class="comp-aspect">${escAttr(f.aspect)}</td>
      <td class="comp-a">${escAttr(f.a)}</td>
      <td class="comp-b">${escAttr(f.b)}</td>
    </tr>`).join('');
  return `
    <div class="comp-table-wrap" role="region" aria-label="Feature comparison">
      <table class="comp-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th class="comp-a-head">${escAttr(nameA)}</th>
            <th class="comp-b-head">${escAttr(nameB)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _faqHtml(faqs) {
  const items = faqs.map((f, i) => `
    <details class="faq-item" ${i === 0 ? 'open' : ''}>
      <summary class="faq-q">${escAttr(f.q)}</summary>
      <div class="faq-a"><p>${escAttr(f.a)}</p></div>
    </details>`).join('');
  return `<section class="faq-section" aria-label="FAQs"><h2>Frequently Asked Questions</h2>${items}</section>`;
}

function _relatedHtml(slugs) {
  const NAMES = {
    'compress-pdf':'Compress PDF','zip-builder':'ZIP Builder','merge-pdf':'Merge PDF',
    'protect-pdf':'Protect PDF','image-converter':'Image Converter',
    'image-compressor':'Image Compressor','background-remover':'Background Remover',
    'jpg-to-pdf':'JPG to PDF','pdf-to-word':'PDF to Word','ocr-pdf':'OCR PDF',
    'pdf-to-excel':'PDF to Excel','translate-pdf':'Translate PDF',
    'organize-pdf':'Organize PDF','split-pdf':'Split PDF','rotate-pdf':'Rotate PDF',
  };
  return slugs.map(s => `<a class="related-card" href="/${s}"><span class="related-name">${NAMES[s]||s}</span><span class="related-arrow">→</span></a>`).join('');
}

export function buildComparisonHtml(compSlug, baseHtml) {
  const cmp = COMPARISONS[compSlug];
  if (!cmp) return null;

  const canon = `https://ilovepdf.cyou/compare/${compSlug}`;

  const bc = buildBreadcrumb([
    { name: 'Home',        url: '/' },
    { name: 'Compare',     url: '/compare' },
    { name: cmp.h1,        url: null },
  ]);

  // FAQPage JSON-LD
  const faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: cmp.faqs.map(f => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  // BreadcrumbList already in bc.jsonLd
  const headExtras = [
    `<meta name="robots" content="index, follow, max-image-preview:large">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escAttr(canon)}">`,
    `<meta property="og:site_name" content="ILovePDF">`,
    `<meta property="og:title" content="${escAttr(cmp.title)}">`,
    `<meta property="og:description" content="${escAttr(cmp.desc)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escAttr(cmp.title)}">`,
    `<meta name="twitter:description" content="${escAttr(cmp.desc)}">`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(faqLd))}</script>`,
    bc.jsonLd,
  ].join('');

  const body = `
    ${bc.html}
    ${adSlot('below-tool')}
    <section class="seo-block" aria-label="Comparison">
      <div class="seo-inner">
        <h1 class="seo-h1">${escAttr(cmp.h1)}</h1>
        <p>${escAttr(cmp.intro)}</p>

        <h2>Side-by-Side Comparison</h2>
        ${_featureTable(cmp.features, cmp.toolA.name, cmp.toolB.name)}

        <div class="comp-cta-row">
          <a class="comp-cta-btn" href="${escAttr(cmp.toolA.url)}">Try ${escAttr(cmp.toolA.name)} →</a>
          <a class="comp-cta-btn comp-cta-btn--b" href="${escAttr(cmp.toolB.url)}">Try ${escAttr(cmp.toolB.name)} →</a>
        </div>

        ${adSlot('mid-content')}

        ${_faqHtml(cmp.faqs)}

        <h2>Related tools</h2>
        <div class="related-grid">${_relatedHtml(cmp.related)}</div>
      </div>
      ${adSlot('sidebar', { desktopOnly: true })}
    </section>`;

  let html = baseHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(cmp.title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${escAttr(cmp.desc)}">`)
    .replace(/<meta\s+name="keywords"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    .replace(/<\/head>/, `<link rel="canonical" href="${escAttr(canon)}">${headExtras}</head>`)
    .replace(/<\/main>/, `${body}</main>`)
    .replace('</body>', `<script>window.__CATEGORY_PAGE=true;window.__COMP_SLUG=${JSON.stringify(compSlug)};</script></body>`);

  return html;
}

// Index page for /compare listing all comparisons
export function buildCompareIndexHtml(baseHtml) {
  const canon = 'https://ilovepdf.cyou/compare';
  const title = 'PDF Tool Comparisons — ILovePDF';
  const desc  = 'Compare PDF tools, image formats, and conversion methods side-by-side. Make the right choice for your workflow with our free tool comparison guides.';

  const cards = Object.keys(COMPARISONS).map(slug => {
    const c = COMPARISONS[slug];
    return `<a class="cat-card" href="/compare/${slug}">
      <span class="cat-card-name">${escAttr(c.h1)}</span>
      <span class="cat-card-arrow">→</span>
    </a>`;
  }).join('');

  const bc = buildBreadcrumb([{ name: 'Home', url: '/' }, { name: 'Compare', url: null }]);

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
    <section class="seo-block" aria-label="Tool Comparisons">
      <div class="seo-inner">
        <h1 class="seo-h1">PDF Tool Comparisons</h1>
        <p>Not sure which tool to use? These side-by-side guides compare ILovePDF tools and popular document formats so you always pick the right one for your workflow.</p>
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
