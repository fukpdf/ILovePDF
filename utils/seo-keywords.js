// utils/seo-keywords.js
// Modular per-tool SEO keyword + FAQ generator.
//
// generateKeywords(roots, options) returns 100+ unique keyword phrases for one
// tool by combining root phrases with safe modifiers / qualifiers. Each tool
// has its own root vocabulary so phrases stay relevant and don't duplicate
// across tools.
//
// getToolSeo(slug) returns { keywords:[], faqs:[{q,a}] } for use by seo.js.

const MODIFIERS = [
  'online', 'free', 'free online', 'best', 'top', 'fast', 'quick', 'instant',
  'secure', 'safe', 'private', 'no signup', 'no registration', 'no email',
  'no download', 'no install', 'no software', 'browser based', 'web based',
  'in browser', 'cloud', 'easy', 'simple', 'professional', 'unlimited',
];

const QUALIFIERS = [
  'without losing quality', 'high quality', 'preserve formatting', 'in seconds',
  'in one click', 'on Mac', 'on Windows', 'on iPhone', 'on Android',
  'for students', 'for business', 'for free', 'large files', 'mobile',
  'desktop', '2026',
];

// Build at least `min` unique phrases from the given roots, modifiers, qualifiers.
// Categories are interleaved (round-robin) so the trimmed list still contains
// all variation types — bare roots, modifier prefixes, qualifier suffixes, and
// modifier+root+qualifier triples — instead of being dominated by one shape.
function generateKeywords(roots, { min = 110, modifiers = MODIFIERS, qualifiers = QUALIFIERS } = {}) {
  // Each "bucket" is a category of phrases, lazily generated.
  const bucketGens = [
    function* bare()      { for (const r of roots) yield r; },
    function* modRoot()   { for (const m of modifiers) for (const r of roots) yield `${m} ${r}`; },
    function* rootMod()   { for (const m of modifiers) for (const r of roots) yield `${r} ${m}`; },
    function* rootQual()  { for (const q of qualifiers) for (const r of roots) yield `${r} ${q}`; },
    function* modRootQ()  { for (const q of qualifiers) for (const m of modifiers) for (const r of roots) yield `${m} ${r} ${q}`; },
  ];

  const iters = bucketGens.map(g => g());
  const set = new Set();
  const cap = Math.max(min, 110);

  // Round-robin pull from each bucket until we've satisfied the cap or all buckets are drained.
  while (set.size < cap) {
    let progressed = false;
    for (const it of iters) {
      const next = it.next();
      if (next.done) continue;
      progressed = true;
      set.add(String(next.value).toLowerCase());
      if (set.size >= cap) break;
    }
    if (!progressed) break;
  }

  return Array.from(set);
}

// Per-tool root vocabularies — keep these distinct between tools.
const ROOTS = {
  'merge-pdf': [
    'merge PDF', 'combine PDF', 'join PDF', 'merge PDF files', 'combine PDF files',
    'PDF merger', 'PDF combiner', 'merge multiple PDFs', 'concatenate PDF',
    'append PDF', 'merge PDFs into one', 'merge two PDF files',
  ],
  'split-pdf': [
    'split PDF', 'PDF splitter', 'extract PDF pages', 'separate PDF pages',
    'split PDF by page', 'split PDF by range', 'break PDF into pages',
    'divide PDF', 'cut PDF', 'split large PDF', 'extract page range from PDF',
  ],
  'rotate-pdf': [
    'rotate PDF', 'rotate PDF pages', 'PDF page rotator', 'flip PDF pages',
    'turn PDF sideways', 'rotate landscape PDF', 'rotate portrait PDF',
    'rotate PDF 90 degrees', 'rotate PDF clockwise', 'fix PDF orientation',
  ],
  'crop-pdf': [
    'crop PDF', 'PDF cropper', 'trim PDF margins', 'cut PDF margins',
    'remove PDF white space', 'resize PDF page', 'crop PDF pages',
    'PDF margin remover', 'crop scanned PDF',
  ],
  'organize-pdf': [
    'organize PDF', 'reorder PDF pages', 'rearrange PDF', 'PDF page organizer',
    'sort PDF pages', 'delete PDF pages', 'duplicate PDF pages',
    'manage PDF pages', 'PDF page manager',
  ],
  'compress-pdf': [
    'compress PDF', 'reduce PDF size', 'shrink PDF', 'PDF compressor',
    'optimize PDF', 'make PDF smaller', 'compress PDF file', 'pdf size reducer',
    'reduce PDF file size', 'compress PDF for email', 'compress large PDF',
  ],
  'pdf-to-word': [
    'PDF to Word', 'PDF to DOCX', 'convert PDF to Word', 'PDF to Word converter',
    'pdf2word', 'export PDF to Word', 'turn PDF into Word', 'PDF to editable Word',
    'PDF to .doc',
  ],
  'pdf-to-powerpoint': [
    'PDF to PowerPoint', 'PDF to PPT', 'PDF to PPTX', 'convert PDF to PowerPoint',
    'pdf2ppt', 'PDF to slides', 'PDF to PowerPoint converter',
    'export PDF to PowerPoint',
  ],
  'pdf-to-excel': [
    'PDF to Excel', 'PDF to XLSX', 'convert PDF to Excel', 'PDF to spreadsheet',
    'pdf2excel', 'PDF table to Excel', 'extract tables from PDF to Excel',
    'PDF to Excel converter',
  ],
  'pdf-to-jpg': [
    'PDF to JPG', 'PDF to image', 'convert PDF to JPG', 'PDF to JPEG',
    'PDF to PNG', 'pdf2jpg', 'extract images from PDF', 'PDF page to image',
    'PDF to picture',
  ],
  'word-to-pdf': [
    'Word to PDF', 'DOCX to PDF', 'convert Word to PDF', 'Word document to PDF',
    'doc to PDF', 'Word to PDF converter', 'export Word as PDF', 'save Word as PDF',
  ],
  'powerpoint-to-pdf': [
    'PowerPoint to PDF', 'PPT to PDF', 'PPTX to PDF', 'convert PowerPoint to PDF',
    'slides to PDF', 'PowerPoint to PDF converter', 'export slides to PDF',
  ],
  'excel-to-pdf': [
    'Excel to PDF', 'XLSX to PDF', 'convert Excel to PDF', 'spreadsheet to PDF',
    'XLS to PDF', 'Excel to PDF converter', 'export Excel as PDF',
  ],
  'jpg-to-pdf': [
    'JPG to PDF', 'image to PDF', 'convert JPG to PDF', 'JPEG to PDF',
    'PNG to PDF', 'photo to PDF', 'pictures to PDF', 'JPG to PDF converter',
    'combine images into PDF',
  ],
  'html-to-pdf': [
    'HTML to PDF', 'convert HTML to PDF', 'webpage to PDF', 'website to PDF',
    'URL to PDF', 'save webpage as PDF', 'HTML to PDF converter',
  ],
  'edit-pdf': [
    'edit PDF', 'PDF editor', 'modify PDF', 'add text to PDF', 'edit PDF online',
    'edit PDF file', 'change PDF', 'PDF text editor', 'annotate PDF',
  ],
  'watermark-pdf': [
    'watermark PDF', 'add watermark to PDF', 'PDF watermark', 'stamp PDF',
    'image watermark PDF', 'text watermark PDF', 'PDF watermark tool',
    'brand PDF with watermark',
  ],
  'sign-pdf': [
    'sign PDF', 'electronic signature PDF', 'eSign PDF', 'PDF signature',
    'add signature to PDF', 'digital signature PDF', 'sign PDF online',
    'PDF eSign tool',
  ],
  'add-page-numbers': [
    'add page numbers to PDF', 'PDF page numbering', 'page numbers PDF',
    'number PDF pages', 'insert page numbers in PDF', 'PDF pagination',
    'add numbering to PDF',
  ],
  'redact-pdf': [
    'redact PDF', 'PDF redaction', 'black out text in PDF', 'remove sensitive info from PDF',
    'PDF redactor', 'censor PDF', 'hide text in PDF', 'permanently remove text from PDF',
  ],
  'protect-pdf': [
    'protect PDF', 'password protect PDF', 'encrypt PDF', 'lock PDF',
    'add password to PDF', 'PDF password', 'secure PDF with password',
    'PDF encryption tool',
  ],
  'unlock-pdf': [
    'unlock PDF', 'remove PDF password', 'decrypt PDF', 'PDF password remover',
    'unlock protected PDF', 'crack PDF password', 'remove restrictions from PDF',
  ],
  'repair-pdf': [
    'repair PDF', 'fix corrupted PDF', 'PDF repair tool', 'recover PDF',
    'restore damaged PDF', 'fix broken PDF', 'PDF recovery',
  ],
  'scan-pdf': [
    'scan to PDF', 'scanner to PDF', 'scan documents to PDF', 'create PDF from scan',
    'image scanner PDF', 'phone scanner PDF', 'scan paper to PDF',
  ],
  'ocr-pdf': [
    'OCR PDF', 'PDF OCR', 'extract text from PDF', 'searchable PDF',
    'text recognition PDF', 'scanned PDF to text', 'OCR online', 'PDF text extraction',
  ],
  'compare-pdf': [
    'compare PDF', 'PDF diff', 'compare two PDFs', 'PDF comparison tool',
    'find differences in PDFs', 'side by side PDF compare', 'PDF version compare',
  ],
  'ai-summarizer': [
    'AI PDF summarizer', 'summarize PDF', 'PDF summary', 'summarize document with AI',
    'AI document summary', 'TL;DR PDF', 'auto summarize PDF', 'PDF summary generator',
  ],
  'translate-pdf': [
    'translate PDF', 'PDF translator', 'translate document', 'translate PDF online',
    'multilingual PDF', 'PDF language translation', 'translate PDF to English',
    'translate PDF to Spanish',
  ],
  'workflow-builder': [
    'PDF workflow', 'PDF automation', 'PDF batch processing', 'chain PDF tools',
    'PDF workflow builder', 'automate PDF tasks', 'PDF pipeline', 'multi-step PDF',
  ],
  'numbers-to-words': [
    'numbers to words', 'number to word converter', 'spell numbers', 'amount to words',
    'currency in words', 'number spelling', 'digit to text', 'cheque amount in words',
  ],
  'background-remover': [
    'background remover', 'remove image background', 'transparent background',
    'background eraser', 'AI background remover', 'remove bg', 'cut out background',
    'photo background remover',
  ],
  'crop-image': [
    'crop image', 'image cropper', 'crop photo', 'trim image', 'cut image',
    'photo cropper', 'crop picture online', 'image crop tool',
  ],
  'resize-image': [
    'resize image', 'image resizer', 'change image size', 'photo resizer',
    'resize photo', 'scale image', 'image size changer', 'reduce image dimensions',
  ],
  'image-filters': [
    'image filters', 'photo filters', 'apply filters to image', 'photo effects',
    'image effects', 'add filter to picture', 'instagram-like filters',
  ],
};

// FAQs (4 per tool — kept short so JSON-LD payload stays light).
function defaultFaqs(name) {
  return [
    {
      q: `Is ${name} really free?`,
      a: `Yes. ${name} on ILovePDF is 100% free, with no signup, watermark, or hidden fees. You can use it as often as you like.`,
    },
    {
      q: `Are my files safe when using ${name}?`,
      a: `Absolutely. Files are transferred over HTTPS, processed in an isolated sandbox, and automatically deleted from our servers within minutes after processing.`,
    },
    {
      q: `Do I need to install anything to use ${name}?`,
      a: `No. ${name} runs entirely in your browser on Windows, macOS, Linux, Android, and iOS. There is nothing to download or install.`,
    },
    {
      q: `What is the maximum file size for ${name}?`,
      a: `${name} accepts files up to 100 MB per upload. For larger files, create a free account to unlock higher limits.`,
    },
  ];
}

// Tool-specific FAQ overrides for the most-searched intents.
const FAQS = {
  'merge-pdf': (n) => ([
    { q: `How do I merge multiple PDFs into one file?`, a: `Drop your PDFs into ${n}, drag the thumbnails to set the page order, then click Merge. Your single combined PDF will download in seconds.` },
    { q: `Will ${n} keep the original quality of my files?`, a: `Yes. ${n} preserves the original resolution, fonts, and embedded images of every page — nothing is recompressed.` },
    { q: `How many PDFs can I merge at once?`, a: `You can merge dozens of PDFs in a single operation, as long as the combined upload stays under 100 MB.` },
    { q: `Are my merged PDFs deleted after download?`, a: `Yes. Both the source files and the merged result are wiped from our servers automatically within minutes.` },
  ]),
  'split-pdf': (n) => ([
    { q: `How do I split a PDF into separate pages?`, a: `Upload your file to ${n}, choose “Split by page” or define custom page ranges, then download a ZIP of the resulting PDFs.` },
    { q: `Can I extract a specific range of pages?`, a: `Yes. ${n} accepts ranges like 1-3,7,10-12 to extract exactly the pages you need.` },
    { q: `Does ${n} reduce quality?`, a: `No. ${n} simply slices the original PDF — the extracted pages match the source byte-for-byte.` },
    { q: `Is there a page limit?`, a: `${n} handles PDFs of any page count, up to 100 MB total upload size.` },
  ]),
  'compress-pdf': (n) => ([
    { q: `How much can ${n} reduce my PDF size?`, a: `${n} typically shrinks PDFs by 40–80% depending on content. Image-heavy PDFs compress the most.` },
    { q: `Will ${n} affect text quality?`, a: `No. Text and vector content remain crisp; only image streams are intelligently re-encoded.` },
    { q: `Is ${n} good for email attachments?`, a: `Yes — most users use ${n} to fit large PDFs under email size limits like Gmail's 25 MB cap.` },
    { q: `Can I batch compress PDFs?`, a: `Yes. Drop multiple PDFs and ${n} compresses each one in parallel.` },
  ]),
  'pdf-to-word': (n) => ([
    { q: `Will ${n} preserve my PDF's formatting?`, a: `Yes. Fonts, tables, columns, and images are reproduced in the resulting Word (.docx) document so you can edit immediately.` },
    { q: `Does ${n} work on scanned PDFs?`, a: `For scanned documents, run them through OCR PDF first, then ${n} to get an editable Word file.` },
    { q: `Can I open the result in Google Docs?`, a: `Yes. The .docx output is fully compatible with Microsoft Word, Google Docs, LibreOffice, and Pages.` },
    { q: `Is ${n} free?`, a: `Yes — ${n} is completely free with no signup, watermark, or page limits up to 100 MB.` },
  ]),
  'background-remover': (n) => ([
    { q: `What image formats does ${n} support?`, a: `${n} accepts JPG, PNG, and WebP and returns a transparent PNG.` },
    { q: `How accurate is ${n}?`, a: `${n} uses an AI segmentation model that handles people, products, and animals with edge-accurate results.` },
    { q: `Are my photos saved?`, a: `No. Uploads are processed in memory and deleted within minutes — your images are never stored or shared.` },
    { q: `Can I use ${n} for product photos?`, a: `Yes. ${n} is ideal for e-commerce: drop in a product photo and download a clean cut-out for your store.` },
  ]),
};

// Public API: returns SEO bundle for a tool slug.
export function getToolSeo(slug, name) {
  const roots = ROOTS[slug] || [name];
  const keywords = generateKeywords(roots);
  const faqBuilder = FAQS[slug];
  const faqs = faqBuilder ? faqBuilder(name) : defaultFaqs(name);
  return { keywords, faqs };
}

// Homepage keyword bundle (broad terms only; relies on tool pages for long-tail).
export function getHomeSeo() {
  const homeRoots = [
    'PDF tools', 'online PDF tools', 'free PDF tools', 'all in one PDF',
    'PDF and image tools', 'PDF editor online', 'PDF converter', 'PDF utilities',
    'edit and convert PDF', 'work with PDF online', 'ilovepdf alternative',
    'best PDF site', 'PDF toolkit', 'document tools online',
  ];
  return {
    keywords: generateKeywords(homeRoots, { min: 140 }),
    faqs: [
      { q: `Is ILovePDF really free?`, a: `Yes. Every tool on ILovePDF is free to use without signup. Optional accounts unlock larger file sizes and history.` },
      { q: `Do I need to install software?`, a: `No. All tools run in your browser. There is nothing to download.` },
      { q: `Are my files private?`, a: `Yes. Files are encrypted in transit and automatically deleted from our servers within minutes after processing.` },
      { q: `Which devices and browsers are supported?`, a: `ILovePDF works on every modern browser across Windows, macOS, Linux, Android, and iOS.` },
    ],
  };
}
