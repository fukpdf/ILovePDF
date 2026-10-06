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
  'currency-converter': [
    'currency converter', 'live currency converter', 'exchange rate calculator',
    'currency exchange', 'forex calculator', 'foreign exchange', 'money converter',
    'USD to EUR', 'currency converter online', 'real time exchange rates',
    '160 currencies converter', 'travel currency calculator',
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
  'currency-converter': (n) => ([
    { q: `How accurate is ${n}?`, a: `${n} pulls live mid-market exchange rates from public providers and refreshes them several times per day. Rates are accurate to four decimal places.` },
    { q: `Which currencies does ${n} support?`, a: `${n} supports 160+ world currencies — every major fiat including USD, EUR, GBP, INR, JPY, CNY, AUD, CAD plus regional currencies across Africa, Asia, Latin America and the Middle East.` },
    { q: `Is ${n} free to use?`, a: `Yes. ${n} is 100% free with unlimited conversions, no signup, no rate limits, and no ads inside the converter.` },
    { q: `Can I use ${n} for travel and shopping?`, a: `Absolutely. ${n} is ideal for trip budgets, online purchases, freelance invoices and quick price comparisons across countries.` },
  ]),
  'numbers-to-words': (n) => ([
    { q: `What number formats does ${n} accept?`, a: `${n} accepts plain integers, decimals, scientific notation, and very large numbers up to 10^102 (centillion). Commas, spaces and underscores in your input are ignored.` },
    { q: `Can ${n} write cheque amounts?`, a: `Yes. Switch to "Currency" or "Cheque" mode and ${n} produces bank-ready text like "One Thousand Two Hundred Fifty Dollars and Seventy-Five Cents Only".` },
    { q: `Which currencies does ${n} support?`, a: `${n} writes amounts in USD, EUR, GBP, INR, JPY, CNY, AUD and CAD with the correct major and minor unit names (dollars/cents, pounds/pence, rupees/paise, etc.).` },
    { q: `Is ${n} free?`, a: `Yes — ${n} is completely free, runs in your browser, and has no usage limits or signup.` },
  ]),
  'background-remover': (n) => ([
    { q: `What image formats does ${n} support?`, a: `${n} accepts JPG, PNG, and WebP and returns a transparent PNG.` },
    { q: `How accurate is ${n}?`, a: `${n} uses an AI segmentation model that handles people, products, and animals with edge-accurate results.` },
    { q: `Are my photos saved?`, a: `No. Uploads are processed in memory and deleted within minutes — your images are never stored or shared.` },
    { q: `Can I use ${n} for product photos?`, a: `Yes. ${n} is ideal for e-commerce: drop in a product photo and download a clean cut-out for your store.` },
  ]),

  'rotate-pdf': (n) => ([
    { q: `How do I rotate just one page in a PDF?`, a: `Upload your file to ${n}, select the specific page thumbnail, choose the rotation angle (90°, 180°, or 270°), then download. You can rotate any combination of individual pages independently.` },
    { q: `Will ${n} save the rotation permanently?`, a: `Yes. ${n} saves the rotation permanently into the PDF — the pages open in the correct orientation in every PDF reader.` },
    { q: `Can I rotate all pages at once?`, a: `Yes. Select all pages and apply the rotation in one click. All pages rotate simultaneously.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup, no watermark, works on all devices.` },
  ]),

  'crop-pdf': (n) => ([
    { q: `What is ${n} used for?`, a: `${n} is used to remove unwanted margins, white space, or headers/footers from PDF pages. It is ideal for cleaning up scanned documents or adjusting the visible area of a page.` },
    { q: `Does ${n} delete the hidden content?`, a: `${n} adjusts the crop box of each page, hiding the content outside the crop area. In most PDF viewers the hidden content is gone, though some tools can reveal it. For permanent removal, combine with a PDF flattening step.` },
    { q: `Can I crop different pages to different sizes?`, a: `Yes. ${n} lets you set per-page crop boxes so each page can have a different visible area.` },
    { q: `Will cropping change the text quality?`, a: `No. ${n} only adjusts the page boundaries — no re-encoding occurs and text remains fully crisp.` },
  ]),

  'organize-pdf': (n) => ([
    { q: `Can I delete specific pages with ${n}?`, a: `Yes. Select any page thumbnail and click Delete to remove it permanently. You can delete multiple pages in one operation.` },
    { q: `Can ${n} add blank pages to a PDF?`, a: `Yes. ${n} lets you insert blank pages at any position in the document, useful for separating sections or adding signature spaces.` },
    { q: `How do I reorder pages with ${n}?`, a: `Upload your PDF to ${n} and drag the page thumbnails into the desired order. The final PDF reflects the order shown on screen.` },
    { q: `Is there a page limit for ${n}?`, a: `${n} handles PDFs of any page count within the 100 MB upload size limit. For very long documents, use Split PDF first, organize each section, then Merge.` },
  ]),

  'pdf-to-powerpoint': (n) => ([
    { q: `Will ${n} keep my slide layouts intact?`, a: `Yes. ${n} reconstructs each PDF page as a PowerPoint slide, preserving text blocks, images, and approximate layout so you can edit immediately.` },
    { q: `Can I edit the text in the PowerPoint after conversion?`, a: `Yes. Text is extracted into editable text boxes. Fonts that are embedded in the PDF are reproduced as closely as possible.` },
    { q: `Does ${n} work on scanned PDFs?`, a: `For scanned PDFs, run OCR PDF first to recognize the text, then use ${n} to get an editable presentation.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'pdf-to-excel': (n) => ([
    { q: `Can ${n} extract tables from a PDF?`, a: `Yes. ${n} identifies table structures in your PDF and reconstructs them as Excel rows and columns so you can edit the data directly.` },
    { q: `What if my PDF has multiple tables per page?`, a: `${n} detects and extracts multiple tables per page. Each table becomes its own region in the spreadsheet.` },
    { q: `Does ${n} work on scanned PDFs?`, a: `For scanned PDFs, run OCR PDF first to add a text layer, then ${n} can extract the table data.` },
    { q: `Is the output compatible with Google Sheets?`, a: `Yes. The .xlsx output opens in Microsoft Excel, Google Sheets, LibreOffice Calc, and Numbers.` },
  ]),

  'pdf-to-jpg': (n) => ([
    { q: `What resolution does ${n} use?`, a: `${n} converts each PDF page to a high-resolution JPG (150 DPI by default, up to 300 DPI on request). The result is sharp enough for screen display and light print use.` },
    { q: `Does ${n} give me one image per page?`, a: `Yes. Each page of your PDF becomes a separate JPG file, all packaged in a ZIP for easy download.` },
    { q: `Can ${n} convert a single page only?`, a: `Split the PDF to the desired page first, then run ${n} to get a JPG of that specific page.` },
    { q: `Is ${n} free?`, a: `Yes — no signup, no watermark, unlimited use within the 100 MB file size limit.` },
  ]),

  'word-to-pdf': (n) => ([
    { q: `Will ${n} preserve fonts and formatting?`, a: `Yes. ${n} converts the document layout, fonts, tables, images, and spacing faithfully to PDF. The result looks identical to the original Word document.` },
    { q: `Can ${n} convert .doc files as well as .docx?`, a: `Yes. ${n} accepts both older .doc and modern .docx Word formats.` },
    { q: `Does ${n} work on Mac and iPhone?`, a: `Yes. ${n} runs entirely in your browser — open it in Safari on Mac, iPhone, or iPad and convert without installing anything.` },
    { q: `Is there a page limit?`, a: `No page limit. Any Word file up to 100 MB is supported.` },
  ]),

  'powerpoint-to-pdf': (n) => ([
    { q: `Will ${n} keep my animations and transitions?`, a: `PDF is a static format — animations and transitions are not preserved. Each slide becomes a single static page. To keep animations, share the original .pptx file.` },
    { q: `Does ${n} preserve speaker notes?`, a: `Standard conversion does not include speaker notes in the output. The PDF contains the visible slide content only.` },
    { q: `Can I convert .ppt files (not just .pptx)?`, a: `Yes. ${n} accepts both the older .ppt and the modern .pptx PowerPoint formats.` },
    { q: `Is ${n} free?`, a: `Completely free — no signup, no watermark.` },
  ]),

  'excel-to-pdf': (n) => ([
    { q: `Will ${n} keep all my spreadsheet rows and columns?`, a: `Yes. ${n} converts each Excel worksheet to a PDF page, preserving column widths, row heights, cell formatting, borders, and data.` },
    { q: `What if my spreadsheet has multiple sheets?`, a: `Each worksheet becomes a separate page in the PDF. All sheets are included in the output by default.` },
    { q: `Does ${n} handle formulas correctly?`, a: `${n} converts the displayed values — the formula results you see in Excel — not the formulas themselves. The PDF shows the calculated numbers.` },
    { q: `Can I convert .xls files?`, a: `Yes. ${n} accepts both .xls (older format) and .xlsx (modern format).` },
  ]),

  'word-to-excel': (n) => ([
    { q: `What data does ${n} extract from a Word document?`, a: `${n} extracts tables and structured data from Word documents and maps them to Excel rows and columns. Paragraphs of body text are not converted.` },
    { q: `What if my Word document has no tables?`, a: `If the document has no table markup, ${n} will produce a spreadsheet with the plain text content. For best results, ensure your data is in Word table format before converting.` },
    { q: `Is ${n} free?`, a: `Yes — completely free with no signup required.` },
    { q: `Can the output be opened in Google Sheets?`, a: `Yes. The .xlsx output opens in Google Sheets, Microsoft Excel, and LibreOffice Calc.` },
  ]),

  'jpg-to-pdf': (n) => ([
    { q: `Can I combine multiple images into one PDF with ${n}?`, a: `Yes. Upload multiple JPG, PNG, or WebP files and ${n} merges them into a single multi-page PDF. Drag the thumbnails to set the page order.` },
    { q: `Does ${n} compress my images?`, a: `${n} embeds your images in the PDF at their original quality. If you need a smaller file, run Compress PDF on the result.` },
    { q: `Does ${n} support PNG and WebP images too?`, a: `Yes. Despite the name, ${n} accepts JPG, JPEG, PNG, and WebP images.` },
    { q: `What page size does the PDF use?`, a: `By default, each image fills the entire page at A4 size. You can choose from Letter, A4, and fit-to-image sizing options.` },
  ]),

  'html-to-pdf': (n) => ([
    { q: `Can ${n} convert a live URL?`, a: `Yes. Enter any public URL and ${n} fetches and renders the page, then converts it to PDF — useful for capturing web articles, invoices, or dashboards.` },
    { q: `Does ${n} capture images and styles?`, a: `Yes. ${n} renders the full HTML including CSS, inline images, and web fonts, so the PDF matches the visual appearance of the page.` },
    { q: `Can I convert a local HTML file?`, a: `Yes. Upload an .html file directly and ${n} converts it. Note that local file references (relative image paths) may not load correctly — embed images as base64 or use absolute URLs.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'edit-pdf': (n) => ([
    { q: `Can I add text to an existing PDF with ${n}?`, a: `Yes. ${n} lets you place new text boxes anywhere on the PDF pages. You can choose the font, size, colour, and position.` },
    { q: `Can ${n} edit existing text in a PDF?`, a: `${n} can add new text and annotations on top of existing content. For full text editing of the original content, use PDF to Word to convert first, edit in Word, then convert back.` },
    { q: `Can I add images or shapes with ${n}?`, a: `Yes. ${n} supports adding images, lines, rectangles, and other shapes on top of PDF pages.` },
    { q: `Does ${n} support annotations and highlights?`, a: `Yes — you can add highlights, underlines, comments, and sticky notes to any PDF page.` },
  ]),

  'watermark-pdf': (n) => ([
    { q: `Can I add a logo as a watermark with ${n}?`, a: `Yes. Select "Image" as the watermark type, upload your logo PNG (transparent background works best), and position it as needed.` },
    { q: `Can I make the watermark semi-transparent?`, a: `Yes. ${n} has an opacity slider — reduce it to 15–30% for a subtle background stamp that doesn't obscure content.` },
    { q: `Will the watermark appear on every page?`, a: `Yes. ${n} applies the watermark to every page of the document by default.` },
    { q: `Can ${n} add watermarks to multiple PDFs at once?`, a: `Yes — upload multiple PDFs and the same watermark is applied to all of them simultaneously.` },
  ]),

  'sign-pdf': (n) => ([
    { q: `Is an electronic signature from ${n} legally binding?`, a: `Electronic signatures created with ${n} can be legally binding in many jurisdictions under e-signature laws (eIDAS in the EU, ESIGN/UETA in the US). Check your local regulations for your specific use case.` },
    { q: `How do I create my signature in ${n}?`, a: `You can draw your signature with a mouse or finger, upload an image of your handwritten signature, or type your name and choose a signature font.` },
    { q: `Can multiple people sign the same PDF?`, a: `${n} handles single-session signing. For multi-party workflows, download the signed PDF and pass it to the next signer.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'add-page-numbers': (n) => ([
    { q: `Where can I position the page numbers with ${n}?`, a: `${n} lets you choose from six positions: top-left, top-center, top-right, bottom-left, bottom-center, bottom-right.` },
    { q: `Can I start numbering from a specific page or number?`, a: `Yes. You can set the starting page (e.g., start numbering from page 3) and the starting number (e.g., begin at number 1 or 100).` },
    { q: `Can I customize the font and size of the numbers?`, a: `Yes. ${n} offers font, size, colour, and margin customization for the page number text.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'redact-pdf': (n) => ([
    { q: `Is redaction with ${n} permanent?`, a: `Yes. ${n} permanently removes the selected content from the PDF and replaces it with a solid black box. The original text or image cannot be recovered once the redacted PDF is saved.` },
    { q: `Can ${n} find and redact specific words automatically?`, a: `Yes. Use the search-and-redact feature: type the word or phrase and ${n} highlights all occurrences for one-click redaction.` },
    { q: `Can I redact images as well as text?`, a: `Yes. ${n} can black out any rectangular area on a PDF page, whether it contains text, images, or a mix.` },
    { q: `Why should I use ${n} instead of just drawing a black rectangle?`, a: `Drawing a black rectangle in a PDF editor may only cover the text visually — the underlying text remains in the file and can be copied or revealed. ${n} permanently removes the content from the PDF structure.` },
  ]),

  'protect-pdf': (n) => ([
    { q: `What encryption standard does ${n} use?`, a: `${n} uses AES-128 encryption, the PDF industry standard. The resulting file is compatible with Adobe Acrobat, Preview, and all modern PDF readers.` },
    { q: `Can I set a separate permissions password?`, a: `Yes. You can set an owner password that restricts printing, copying, and editing independently of the open password.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup, no watermark.` },
    { q: `What happens if I forget the password?`, a: `ILovePDF cannot recover your password. If you forget the open password, you will be locked out of the file. Always store your password in a secure password manager.` },
  ]),

  'unlock-pdf': (n) => ([
    { q: `Can ${n} remove the password if I don't know it?`, a: `No. ${n} requires the correct password to unlock a PDF. Attempting to remove a password without authorization may violate the document owner's rights. Only use ${n} on files you own or have permission to unlock.` },
    { q: `What types of PDF restrictions can ${n} remove?`, a: `${n} removes the open password (requiring entry to view) and owner restrictions (preventing printing, copying, or editing), provided you supply the correct password.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
    { q: `Will unlocking change the PDF content?`, a: `No. ${n} only removes the password protection — the text, images, and layout of the PDF are unchanged.` },
  ]),

  'repair-pdf': (n) => ([
    { q: `What kinds of damage can ${n} fix?`, a: `${n} can recover PDFs with corrupted headers, broken cross-reference tables, incomplete downloads, or minor structural errors. Severely overwritten or fragmented files may not be fully recoverable.` },
    { q: `What if ${n} cannot fix my PDF?`, a: `If the file is too corrupted, ${n} will indicate the repair failed. In that case, try recovering from the original source — cloud backup, email attachment, or file history — as a last resort.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
    { q: `Will ${n} change any content in the PDF?`, a: `${n} only fixes structural file damage. Valid content — text, images, annotations — is preserved exactly as in the original.` },
  ]),

  'scan-pdf': (n) => ([
    { q: `Can I scan directly from my phone with ${n}?`, a: `${n} is a browser-based tool — you upload images you have already captured. For direct scanning, take photos with your phone camera, save them, then upload to ${n} to convert to PDF.` },
    { q: `What image formats does ${n} accept?`, a: `${n} accepts JPG, PNG, and WebP images (the typical output of phone cameras and scanners).` },
    { q: `How do I get good quality scans for ${n}?`, a: `Use good lighting, hold the camera parallel to the document, and aim for at least 300 DPI resolution. Avoid shadows and ensure all four page edges are visible.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'ocr-pdf': (n) => ([
    { q: `How do I know if my PDF needs OCR?`, a: `Open the PDF and try to select text. If you cannot highlight any text, the PDF is image-based and needs OCR. If text highlights correctly, OCR is not needed.` },
    { q: `What languages does ${n} support?`, a: `${n} supports 40+ languages including English, Spanish, French, German, Arabic, Chinese, Japanese, Hindi, Russian, Portuguese, and many more.` },
    { q: `How accurate is ${n}?`, a: `For clean, high-resolution printed text, ${n} achieves 90–97% accuracy. Accuracy drops for low-quality scans, unusual fonts, or handwriting.` },
    { q: `Does ${n} change how the PDF looks?`, a: `In Searchable PDF mode, the visual appearance is unchanged. An invisible text layer is added beneath the original page images so you can search and copy text without altering the layout.` },
  ]),

  'compare-pdf': (n) => ([
    { q: `How does ${n} highlight differences?`, a: `${n} overlays the two PDFs and marks added, removed, or changed content with colour-coded highlights so you can spot every difference at a glance.` },
    { q: `Can ${n} compare scanned PDFs?`, a: `Yes. ${n} can compare image-based PDFs, though running OCR first on both files improves text-change detection accuracy.` },
    { q: `Is ${n} suitable for legal or contract reviews?`, a: `Yes. ${n} is commonly used to verify that a contract was not altered between drafts. For critical legal use, confirm that all detected changes are reviewed by a legal professional.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'ai-summarizer': (n) => ([
    { q: `How long can the input PDF be for ${n}?`, a: `${n} processes PDFs up to 100 MB. Very long documents (200+ pages) are summarized at a higher level — key themes and main points — rather than per-section detail.` },
    { q: `Does ${n} work on scanned PDFs?`, a: `For scanned PDFs, run OCR PDF first to add a text layer, then ${n} can summarize the recognized text.` },
    { q: `What languages does ${n} support?`, a: `${n} works best on English documents. Partial support exists for Spanish, French, German, and other major European languages.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required. AI processing uses server-side models so no local AI hardware is needed.` },
  ]),

  'translate-pdf': (n) => ([
    { q: `Which languages can ${n} translate to?`, a: `${n} supports 30+ language pairs including English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Chinese, Japanese, Korean, Arabic, and Hindi.` },
    { q: `Does ${n} preserve the PDF layout?`, a: `${n} outputs the translated text in a clean, readable format. Complex multi-column or table layouts may need reformatting after translation.` },
    { q: `Does ${n} work on scanned PDFs?`, a: `For scanned PDFs, run OCR PDF first to extract the text, then ${n} can translate it.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'workflow-builder': (n) => ([
    { q: `What is ${n} used for?`, a: `${n} lets you chain multiple PDF operations into a single automated pipeline — for example: compress → watermark → protect, all applied to a batch of PDFs in one run.` },
    { q: `How many steps can a workflow have in ${n}?`, a: `You can chain up to 10 operations in a single workflow. Common workflows include compress + protect, watermark + sign, and split + OCR.` },
    { q: `Does ${n} work on multiple PDFs at once?`, a: `Yes. Drop multiple PDFs into ${n} and the entire workflow is applied to every file in the batch.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'crop-image': (n) => ([
    { q: `What aspect ratios does ${n} support?`, a: `${n} supports free-form cropping plus preset ratios: 1:1 (square), 4:3, 16:9, 3:2, and portrait presets for social media. You can also enter custom pixel dimensions.` },
    { q: `Does ${n} reduce image quality?`, a: `${n} uses lossless cropping where possible. For JPG output, a high-quality re-encode is used to preserve sharpness.` },
    { q: `Can I crop multiple images at once?`, a: `Yes. Upload multiple images and apply the same crop frame or ratio to all of them in one operation.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'resize-image': (n) => ([
    { q: `Can ${n} resize to exact pixel dimensions?`, a: `Yes. Enter the exact width and height in pixels. Enable "Lock aspect ratio" to prevent distortion.` },
    { q: `Can ${n} resize by percentage?`, a: `Yes. Enter a percentage (e.g., 50%) and ${n} scales the image proportionally.` },
    { q: `Does ${n} upscale images?`, a: `${n} can increase image dimensions, but upscaling cannot add detail that was not in the original. For AI-enhanced upscaling, use a dedicated super-resolution tool.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'image-filters': (n) => ([
    { q: `What kinds of filters does ${n} offer?`, a: `${n} includes brightness, contrast, saturation, sharpness, blur, grayscale, sepia, invert, and vintage effects — all adjustable with real-time preview.` },
    { q: `Can I apply multiple filters at once with ${n}?`, a: `Yes. Stack multiple filter adjustments and see the combined result in the preview before downloading.` },
    { q: `Does ${n} work on PNG files?`, a: `Yes. ${n} accepts JPG, PNG, and WebP and preserves the original format (or converts to PNG for transparency-preserving filters).` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'image-compressor': (n) => ([
    { q: `How much does ${n} reduce image file size?`, a: `${n} typically reduces JPEG images by 40–80% and PNG images by 20–60% using intelligent compression that balances quality and size.` },
    { q: `Does ${n} reduce image dimensions?`, a: `No — ${n} reduces file size without changing pixel dimensions. Sharpness and detail are preserved at the chosen quality level.` },
    { q: `Can I compress multiple images at once with ${n}?`, a: `Yes. Upload multiple images and ${n} compresses them all in parallel, then provides a ZIP download.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'image-converter': (n) => ([
    { q: `What formats does ${n} convert between?`, a: `${n} converts between JPG, PNG, WebP, GIF, BMP, and TIFF. Popular conversions include PNG to JPG (smaller size) and JPG to PNG (transparent background support).` },
    { q: `Will converting from PNG to JPG remove transparency?`, a: `Yes. JPG does not support transparency, so transparent areas in your PNG will be filled with a white background in the converted JPG.` },
    { q: `Can I batch-convert images with ${n}?`, a: `Yes. Upload multiple images and convert them all to the same target format in one operation.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'qr-code-generator': (n) => ([
    { q: `What content types can ${n} encode?`, a: `${n} encodes URLs, plain text, email addresses, phone numbers, Wi-Fi credentials, vCards (contact info), and SMS messages.` },
    { q: `What formats does ${n} export QR codes in?`, a: `${n} exports QR codes as high-resolution PNG and SVG. SVG is recommended for printing — it scales to any size without losing sharpness.` },
    { q: `Can I customize the colour of QR codes with ${n}?`, a: `Yes. ${n} lets you set the foreground (module) colour and background colour. Ensure sufficient contrast for reliable scanning.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required, unlimited QR codes.` },
  ]),

  'barcode-generator': (n) => ([
    { q: `What barcode formats does ${n} support?`, a: `${n} generates Code 128, Code 39, EAN-13, EAN-8, UPC-A, UPC-E, ITF, and QR Code barcodes.` },
    { q: `Can I download barcodes as SVG for printing?`, a: `Yes. ${n} exports barcodes as SVG (vector, print-quality) and PNG. SVG is the best choice for packaging and print workflows.` },
    { q: `What should I enter as the barcode value?`, a: `Enter the number or alphanumeric string you want encoded. For EAN/UPC barcodes, use the standard product code format. For Code 128/39, any text string is accepted.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
  ]),

  'zip-builder': (n) => ([
    { q: `What file types can I add to a ZIP with ${n}?`, a: `${n} accepts any file type — PDFs, images, Word documents, spreadsheets, videos, and more. You can mix different file types in one archive.` },
    { q: `Is there a file size or count limit for ${n}?`, a: `${n} accepts up to 100 MB total per archive and has no per-file type restriction. For very large archives, consider splitting them into multiple ZIPs.` },
    { q: `Does ${n} offer password-protected ZIPs?`, a: `Currently ${n} creates standard ZIPs. For password-protected archives, use the Protect PDF tool on individual PDFs before adding them to the ZIP.` },
    { q: `Is ${n} free?`, a: `Yes — completely free, no signup required.` },
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
