// scripts/blog-data.js
// Per-tool blog content metadata. One entry per tool (35 total).
// Used by scripts/generate-blogs.js to produce public/blog/<slug>-guide.html.

export const BLOGS = [

  // ============================================================
  // ORGANIZE PDFs
  // ============================================================

  {
    slug: 'merge-pdf-guide',
    toolSlug: '/merge-pdf',
    toolName: 'Merge PDF',
    icon: 'layers',
    tag: 'Tutorial',
    category: 'Organize PDFs',
    title: 'How to Merge PDF Files Online for Free — Complete Guide',
    description: 'Combine multiple PDF files into one document in seconds. Free, secure, no signup. Our step-by-step Merge PDF guide shows you exactly how.',
    intro: `<p>Whether you're stitching chapters of a report together, bundling invoices for a client, or assembling a portfolio for a job application, <strong>merging PDF files</strong> is one of the most common document tasks at work and at home. The good news is that you don't need Adobe Acrobat, a desktop install, or even an account to do it.</p>
<p>This guide walks you through merging PDFs using the free <a href="/merge-pdf">Merge PDF</a> tool from ILovePDF — start to finish, including pro tips that will save you a re-merge later.</p>`,
    steps: [
      { title: 'Open the Merge PDF tool', body: 'Go to <a href="/merge-pdf">ilovepdf.cyou/merge-pdf</a>. You don\'t need to sign in for files under 100 MB.' },
      { title: 'Upload your PDFs', body: 'Drag and drop two or more PDF files onto the upload area, or click to browse. You can select many files at once.' },
      { title: 'Reorder the files', body: 'Drag the file thumbnails into the exact sequence you want them stitched together. The merged PDF respects this order.' },
      { title: 'Process the merge', body: 'Click <strong>Process Files</strong>. Our server combines every page in order using pdf-lib and prepares your download.' },
      { title: 'Download the result', body: 'The merged file downloads as <code>ILovePDF-merge.pdf</code>. You can re-download from the result screen if your browser blocked the first one.' },
    ],
    benefits: [
      { title: 'No software install', body: 'Runs entirely in the browser. Works on Windows, Mac, Linux, iPhone, Android — anything with a modern browser.' },
      { title: 'Privacy first', body: 'Your files are uploaded over HTTPS, processed in seconds, and automatically deleted from the server within minutes.' },
      { title: 'Unlimited combines', body: 'There\'s no daily cap on free use — merge as many PDFs as you need today and tomorrow.' },
      { title: 'Lossless quality', body: 'pdf-lib preserves the original page content (text, images, vectors) so the merged file looks identical to the inputs.' },
    ],
    useCases: [
      { audience: 'Students', body: 'Combine essay drafts, appendices, and reference sheets into a single submission file before uploading to your course portal.' },
      { audience: 'Freelancers & consultants', body: 'Bundle a proposal, scope of work and rate sheet into one PDF you can email a client without 4 attachments.' },
      { audience: 'Operations & finance', body: 'Stitch together monthly invoices, expense receipts, or contract amendments to keep a clean audit trail.' },
    ],
    tips: [
      { title: 'Order before you upload', body: 'The merged PDF follows the exact upload order, so rename your files <code>01-cover.pdf</code>, <code>02-summary.pdf</code> etc. for predictable sequencing.' },
      { title: 'Compress after merging', body: 'A merged file with lots of images can be huge. Run the result through <a href="/compress-pdf">Compress PDF</a> before emailing.' },
      { title: 'Unlock encrypted PDFs first', body: 'Password-protected PDFs can\'t be merged directly. Run them through <a href="/unlock-pdf">Unlock PDF</a> first if you own them.' },
      { title: 'Standardise orientation', body: 'Mixing portrait and landscape pages can look messy when printed. Use <a href="/rotate-pdf">Rotate PDF</a> on the odd ones first.' },
    ],
    faq: [
      { q: 'Is the Merge PDF tool really free?', a: 'Yes. There is no signup or watermark for files under 100 MB. ILovePDF is supported by privacy-respecting display ads.' },
      { q: 'How many PDFs can I merge at once?', a: 'There is no hard cap on the number of files. Each file just needs to be under 100 MB.' },
      { q: 'Are my files safe?', a: 'Files are transferred over HTTPS, processed in memory, and auto-deleted within minutes. We never read or share document content.' },
      { q: 'Will the merged PDF keep its bookmarks?', a: 'Page content (text, images, vectors) is preserved exactly. Bookmarks may be preserved depending on how they were defined in the source.' },
    ],
    related: ['split-pdf-guide', 'compress-pdf-guide', 'organize-pdf-guide', 'rotate-pdf-guide'],
  },

  {
    slug: 'split-pdf-guide',
    toolSlug: '/split-pdf',
    toolName: 'Split PDF',
    icon: 'scissors',
    tag: 'Tutorial',
    category: 'Organize PDFs',
    title: 'How to Split a PDF Online — Extract Pages or Ranges Free',
    description: 'Split a PDF into separate files or extract specific page ranges in seconds. Free, no signup, no software. Step-by-step guide.',
    intro: `<p>Sending a 200-page report when the recipient only needs chapter 3 wastes everyone's time. <strong>Splitting a PDF</strong> lets you pull out exactly the pages you need — a single page, a range, or every page as its own file — without ever opening Adobe Acrobat.</p>
<p>This guide shows you how to use the free <a href="/split-pdf">Split PDF</a> tool, plus the most common workflows our users follow when slicing large documents.</p>`,
    steps: [
      { title: 'Open Split PDF', body: 'Visit <a href="/split-pdf">ilovepdf.cyou/split-pdf</a>. The tool works directly in the browser — nothing to install.' },
      { title: 'Upload your PDF', body: 'Drag the PDF onto the upload area. The tool reads the page count automatically.' },
      { title: 'Enter the page range', body: 'Type the pages you want, e.g. <code>1-3, 5, 7-9</code>. Leave it blank to split every page into its own file.' },
      { title: 'Click Process', body: 'The tool extracts the requested pages and packages them into a single PDF (or a ZIP of pages, if you split everything).' },
      { title: 'Download the result', body: 'The output downloads as <code>ILovePDF-split.pdf</code>. Need a different range? Just hit Process Another File.' },
    ],
    benefits: [
      { title: 'Surgical precision', body: 'Pull out a single page, several non-consecutive ranges, or every page individually with one comma-separated input.' },
      { title: 'Zero quality loss', body: 'Extracted pages keep the original resolution, fonts, and embedded images — they\'re copied byte-for-byte.' },
      { title: 'No watermark', body: 'The output PDF is clean — we never stamp our brand on your document.' },
      { title: 'Browser-based', body: 'Works on phone, tablet, or desktop. Ideal when you\'re away from your usual machine.' },
    ],
    useCases: [
      { audience: 'Lawyers & paralegals', body: 'Pull a specific exhibit from a 500-page case file and send it as a standalone document for review.' },
      { audience: 'Authors & editors', body: 'Extract one chapter from a book draft to share with a beta reader without revealing the rest.' },
      { audience: 'Students', body: 'Cut a single past-paper question or a chapter of lecture notes from a long PDF for focused study.' },
    ],
    tips: [
      { title: 'Combine with Merge', body: 'Split first, rearrange, then re-merge with <a href="/merge-pdf">Merge PDF</a> for any custom page order.' },
      { title: 'Use OCR if pages are images', body: 'Scanned PDFs split fine, but if you need searchable text, run <a href="/ocr-pdf">OCR PDF</a> on the result.' },
      { title: 'Compress after splitting', body: 'Large extracts can still be heavy. Pass through <a href="/compress-pdf">Compress PDF</a> if you plan to email.' },
      { title: 'Keep originals as backups', body: 'Splitting never modifies your input file, but it\'s still wise to keep an untouched copy archived.' },
    ],
    faq: [
      { q: 'Can I split a password-protected PDF?', a: 'Not directly. Use <a href="/unlock-pdf">Unlock PDF</a> first if you own the file, then split the unlocked copy.' },
      { q: 'Is there a page-count limit?', a: 'No. The only limit is the 100 MB file-size cap on free uploads.' },
      { q: 'Do extracted pages keep links and form fields?', a: 'Static content (text, images, vectors) is preserved exactly. Interactive form fields generally survive but are best double-checked.' },
      { q: 'Can I split into multiple separate files?', a: 'Yes — leave the page range blank to extract every page into its own PDF, packaged as a ZIP.' },
    ],
    related: ['merge-pdf-guide', 'organize-pdf-guide', 'compress-pdf-guide', 'pdf-to-jpg-guide'],
  },

  {
    slug: 'rotate-pdf-guide',
    toolSlug: '/rotate-pdf',
    toolName: 'Rotate PDF',
    icon: 'rotate-cw',
    tag: 'Tutorial',
    category: 'Organize PDFs',
    title: 'How to Rotate PDF Pages Online — Free & Permanent',
    description: 'Rotate a single page or every page of a PDF by 90°, 180° or 270° and save the result permanently. Free online tool, no signup.',
    intro: `<p>Scanning a stack of papers always seems to produce at least one sideways page. Most PDF viewers let you rotate temporarily, but the file itself stays wrong, so the next person you send it to sees the same crooked page.</p>
<p>The <a href="/rotate-pdf">Rotate PDF</a> tool fixes the orientation <em>permanently</em> — saving the rotated version as a fresh PDF you can share with anyone. This guide walks you through it.</p>`,
    steps: [
      { title: 'Open Rotate PDF', body: 'Go to <a href="/rotate-pdf">ilovepdf.cyou/rotate-pdf</a>.' },
      { title: 'Upload the PDF', body: 'Drag and drop the file. Multi-page PDFs are fully supported.' },
      { title: 'Choose the rotation angle', body: 'Pick 90° clockwise, 180°, or 270° (counter-clockwise) from the dropdown.' },
      { title: 'Specify which pages', body: 'Type <code>all</code> to rotate every page, or a comma-separated list like <code>1,3,5</code> for selected pages only.' },
      { title: 'Process and download', body: 'Click Process — the rotated PDF saves as <code>ILovePDF-rotate.pdf</code>.' },
    ],
    benefits: [
      { title: 'Permanent fix', body: 'Unlike viewer-only rotation, the new file is saved with the correct orientation embedded.' },
      { title: 'Per-page control', body: 'Rotate only the pages that need it instead of the entire document.' },
      { title: 'Lossless', body: 'Pages are rotated in metadata — nothing is re-rendered or compressed.' },
      { title: 'Print-ready', body: 'The output prints correctly on any device without anyone needing to manually reorient.' },
    ],
    useCases: [
      { audience: 'Office scanning', body: 'Multi-page receipts and contracts that came out the office scanner sideways become a clean, properly-oriented document.' },
      { audience: 'Smartphone scans', body: 'PDFs created from phone camera scans (CamScanner, Notes app) often have inconsistent orientation. Fix the whole batch in one pass.' },
      { audience: 'Compliance archiving', body: 'Standardise the orientation of records before adding them to a long-term archive so future readers don\'t struggle.' },
    ],
    tips: [
      { title: 'Combine with Crop', body: 'After rotating, use <a href="/crop-pdf">Crop PDF</a> to trim any black borders left by the scanner.' },
      { title: 'Rotate before merging', body: 'If you\'re going to <a href="/merge-pdf">merge multiple PDFs</a>, fix orientations first so the final file is consistent.' },
      { title: 'Use 270° for upside-down scans', body: '180° flips an upside-down page upright; 270° handles pages scanned in the wrong landscape direction.' },
      { title: 'Re-OCR if rotated', body: 'If your PDF was OCR\'d before rotation, run <a href="/ocr-pdf">OCR PDF</a> again — text positions change with rotation.' },
    ],
    faq: [
      { q: 'Will rotating shrink quality?', a: 'No. Pages are reoriented at the metadata level — image pixels and vector data are untouched.' },
      { q: 'Can I rotate by an arbitrary angle?', a: 'Only multiples of 90° are valid in the PDF spec. For arbitrary angles you\'d need to convert to image first using <a href="/pdf-to-jpg">PDF to JPG</a>.' },
      { q: 'Is the rotation reversible?', a: 'Yes — just rotate by the inverse angle (e.g. 270° to undo a 90° rotation).' },
      { q: 'Does it work on encrypted PDFs?', a: 'Use <a href="/unlock-pdf">Unlock PDF</a> first if you own the file, then rotate the unlocked copy.' },
    ],
    related: ['crop-pdf-guide', 'organize-pdf-guide', 'merge-pdf-guide', 'ocr-pdf-guide'],
  },

  {
    slug: 'crop-pdf-guide',
    toolSlug: '/crop-pdf',
    toolName: 'Crop PDF',
    icon: 'crop',
    tag: 'Tutorial',
    category: 'Organize PDFs',
    title: 'How to Crop a PDF Online — Trim Margins for Free',
    description: 'Crop white margins, black scan borders or unwanted edges from any PDF in seconds. Free online tool, no signup needed.',
    intro: `<p>A PDF with bloated white margins or jagged scan borders looks unprofessional and wastes paper when printed. <strong>Cropping</strong> tightens the visible content area without ever touching the original underlying text or images.</p>
<p>This guide shows you how to use the <a href="/crop-pdf">Crop PDF</a> tool to trim every page to a clean, consistent rectangle in just a few clicks.</p>`,
    steps: [
      { title: 'Open Crop PDF', body: 'Go to <a href="/crop-pdf">ilovepdf.cyou/crop-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drop the file in. The tool processes all pages with the same crop values.' },
      { title: 'Set crop percentages', body: 'Enter how much of each side to trim — Left, Right, Top and Bottom — as a percentage (e.g. <code>5</code> for 5%).' },
      { title: 'Process and preview', body: 'Click Process. The cropped PDF generates in seconds.' },
      { title: 'Download', body: 'The result downloads as <code>ILovePDF-crop.pdf</code>. Re-process if you need different values.' },
    ],
    benefits: [
      { title: 'Cleaner output', body: 'Removes scan margins, watermarked footers, and excessive whitespace for a professional look.' },
      { title: 'Smaller file size', body: 'Pages with smaller cropbox areas often render and download faster, especially when re-printed.' },
      { title: 'Print-friendly', body: 'Tighter margins mean less wasted ink and paper when printing PDFs.' },
      { title: 'Consistent with PDF standards', body: 'Crop changes the page CropBox, which every PDF reader respects.' },
    ],
    useCases: [
      { audience: 'Academic papers', body: 'Trim the wide journal margins of a research PDF before printing to save paper and ink.' },
      { audience: 'Scanned books', body: 'Remove the dark scanner shadow on the gutter side of every page in a scanned book.' },
      { audience: 'Mobile reading', body: 'Crop unnecessary whitespace so text renders larger on a phone or e-reader screen.' },
    ],
    tips: [
      { title: 'Start small', body: 'Try 3–5% per side first. Aggressive crops can cut into actual content.' },
      { title: 'Crop after rotating', body: 'If the page needs <a href="/rotate-pdf">rotation</a>, do that first so your crop directions stay correct.' },
      { title: 'Re-export images if cropping a lot', body: 'If you crop heavily, follow up with <a href="/compress-pdf">Compress PDF</a> to actually reduce the file size.' },
      { title: 'Inspect before sharing', body: 'Open the cropped result in your normal viewer to confirm nothing important was clipped.' },
    ],
    faq: [
      { q: 'Does cropping delete content?', a: 'No. Cropping changes only the visible area (CropBox). The underlying content is preserved and could theoretically be restored.' },
      { q: 'Can I crop different pages by different amounts?', a: 'The tool applies one crop to all pages. Split the PDF first if you need per-page values.' },
      { q: 'Will the crop survive in other PDF readers?', a: 'Yes — any spec-compliant viewer respects the new CropBox.' },
      { q: 'Why is my file size still large after cropping?', a: 'CropBox doesn\'t remove image data. Run <a href="/compress-pdf">Compress PDF</a> to reduce size.' },
    ],
    related: ['rotate-pdf-guide', 'compress-pdf-guide', 'organize-pdf-guide', 'pdf-to-jpg-guide'],
  },

  {
    slug: 'organize-pdf-guide',
    toolSlug: '/organize-pdf',
    toolName: 'Organize PDF',
    icon: 'list-ordered',
    tag: 'Tutorial',
    category: 'Organize PDFs',
    title: 'How to Reorder PDF Pages Online — Free Organize PDF Tool',
    description: 'Reorder, rearrange and reorganise the pages of any PDF in seconds. Free online tool, no signup or install required.',
    intro: `<p>You finally finish writing a report, only to realise that the appendix should have been in section 2 and the executive summary needs to come first. Re-exporting the original document is annoying — but rearranging pages of an existing PDF takes about 30 seconds with the right tool.</p>
<p>This guide explains how the <a href="/organize-pdf">Organize PDF</a> tool reshuffles your pages into any order you specify.</p>`,
    steps: [
      { title: 'Open Organize PDF', body: 'Go to <a href="/organize-pdf">ilovepdf.cyou/organize-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drop the file. The tool reads the page count automatically.' },
      { title: 'Specify the new order', body: 'Type the new page sequence as comma-separated 1-indexed numbers, e.g. <code>3,1,2,4</code>. You can repeat or skip pages.' },
      { title: 'Process', body: 'The tool builds a new PDF with pages in your chosen order.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-organize.pdf</code>. The original file is left untouched.' },
    ],
    benefits: [
      { title: 'Total flexibility', body: 'Skip pages, repeat pages, or fully reverse a document — any order is valid.' },
      { title: 'No re-export', body: 'No need to go back to Word/InDesign and re-generate the PDF from scratch.' },
      { title: 'Preserves quality', body: 'Pages are copied lossless — text, images, fonts and vectors are unchanged.' },
      { title: 'Side-by-side preview', body: 'Test different orders quickly without overwriting your original file.' },
    ],
    useCases: [
      { audience: 'Report writers', body: 'Move the executive summary to the front of a long report after reviewers ask for it.' },
      { audience: 'Designers', body: 'Reorder portfolio pages so your strongest work is front-loaded for a client review.' },
      { audience: 'Teachers', body: 'Rearrange a worksheet pack so warm-up exercises come first and assessments come last.' },
    ],
    tips: [
      { title: 'Plan the order first', body: 'Sketch the desired sequence on paper before typing — easier than fixing mistakes after.' },
      { title: 'Combine with Split & Merge', body: 'For complex reorganisations, <a href="/split-pdf">split</a> into single pages then <a href="/merge-pdf">merge</a> in any order.' },
      { title: 'Skip pages by omitting them', body: 'Want to delete page 4? Just leave it out of the order list, e.g. <code>1,2,3,5,6</code>.' },
      { title: 'Repeat pages by listing them twice', body: 'Need a separator page between sections? List it multiple times, e.g. <code>1,7,2,7,3</code>.' },
    ],
    faq: [
      { q: 'Can I drag pages instead of typing numbers?', a: 'The current tool uses the typed-order approach for precision. The drag-to-reorder UI lives inside <a href="/merge-pdf">Merge PDF</a> for combining files.' },
      { q: 'How do I delete pages?', a: 'Just omit those page numbers from the new order. The output PDF will skip them.' },
      { q: 'Is the original file modified?', a: 'No. The reorganised PDF is a new file — your input is left untouched.' },
      { q: 'Does the tool preserve hyperlinks?', a: 'Internal cross-page links may need updating after reordering. External (web) links are preserved.' },
    ],
    related: ['merge-pdf-guide', 'split-pdf-guide', 'rotate-pdf-guide', 'add-page-numbers-guide'],
  },

  // ============================================================
  // COMPRESS & OPTIMIZE
  // ============================================================

  {
    slug: 'compress-pdf-guide',
    toolSlug: '/compress-pdf',
    toolName: 'Compress PDF',
    icon: 'archive',
    tag: 'Guide',
    category: 'Compress & Optimize',
    title: 'How to Compress PDF Without Losing Quality — Full Guide',
    description: 'Reduce PDF file size by up to 80% without visible quality loss. Free online tool, no signup. Step-by-step compression guide.',
    intro: `<p>Email attachment limits, slow uploads, expensive cloud storage — every problem with large PDFs has the same fix: <strong>compression</strong>. A well-compressed PDF can shrink to a fraction of its original size while still looking pixel-perfect on screen and in print.</p>
<p>This guide shows you how to use the free <a href="/compress-pdf">Compress PDF</a> tool to reduce file size, plus the trade-offs to know when picking a compression level.</p>`,
    steps: [
      { title: 'Open Compress PDF', body: 'Go to <a href="/compress-pdf">ilovepdf.cyou/compress-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drop one PDF onto the upload area. Files up to 100 MB are accepted on the free tier.' },
      { title: 'Pick a compression level', body: 'Free users get the strongest compression by default. Logged-in users can choose Low (best quality), Medium (recommended) or High (smallest file).' },
      { title: 'Process', body: 'The tool re-encodes images and removes redundant data. This typically takes 5–20 seconds.' },
      { title: 'Download', body: 'Your smaller PDF saves as <code>ILovePDF-compress.pdf</code>. The original file is untouched.' },
    ],
    benefits: [
      { title: 'Faster sharing', body: 'Smaller files upload, download and email faster — useful on slow or mobile connections.' },
      { title: 'Beats attachment limits', body: 'Most email providers cap attachments at 20–25 MB. Compression often gets you under that line.' },
      { title: 'Cheaper cloud storage', body: 'Compressing before archiving to Google Drive / Dropbox / S3 saves real money over time.' },
      { title: 'Same look, less weight', body: 'Smart image re-encoding keeps documents looking sharp at typical viewing zoom.' },
    ],
    useCases: [
      { audience: 'Job seekers', body: 'Squeeze a portfolio PDF down to under 5 MB so it sails through application portals with strict size limits.' },
      { audience: 'Marketing teams', body: 'Compress a brochure before posting it to a website — visitors get faster page loads and Google rewards you for it.' },
      { audience: 'Legal & finance', body: 'Reduce contract files for archive servers, where storage cost scales linearly with size.' },
    ],
    tips: [
      { title: 'Compress last, not first', body: 'Run compression after merging, cropping, or other edits — otherwise you compress, then re-fluff the file.' },
      { title: 'Test print quality', body: 'If the file will be printed, run a test print at the highest compression level before committing.' },
      { title: 'Image-heavy PDFs shrink most', body: 'Text-only PDFs are already small; the biggest wins come from documents loaded with photos.' },
      { title: 'Combine with OCR carefully', body: 'OCR-generated text layers can be compressed away aggressively — keep a non-compressed copy if searchable text is important.' },
    ],
    faq: [
      { q: 'How much can a PDF be compressed?', a: 'Image-heavy PDFs often shrink 60–80%. Text-only PDFs may only shrink 10–20% because there\'s less to optimise.' },
      { q: 'Will text become blurry?', a: 'No. Text is vector-based and never blurred by compression — only embedded images are re-encoded.' },
      { q: 'Is the compression reversible?', a: 'No — once images are re-encoded, the original pixels are gone. Always keep the source PDF as a backup.' },
      { q: 'Why is my compressed file still large?', a: 'It probably contains many high-resolution images or embedded fonts. Try the High level or convert images first.' },
    ],
    related: ['merge-pdf-guide', 'pdf-to-jpg-guide', 'ocr-pdf-guide', 'best-pdf-tools'],
  },

  // ============================================================
  // CONVERT FROM PDF
  // ============================================================

  {
    slug: 'pdf-to-word-guide',
    toolSlug: '/pdf-to-word',
    toolName: 'PDF to Word',
    icon: 'file-text',
    tag: 'Conversion',
    category: 'Convert From PDF',
    title: 'How to Convert PDF to Word Online for Free — Full Guide',
    description: 'Turn any PDF into a fully editable Microsoft Word .docx document in seconds. Free online converter, no signup, no email required.',
    intro: `<p>You receive a PDF, but you need to <em>edit</em> it. Maybe it's a contract template, a CV you want to update, or a report you need to translate. Re-typing the whole thing is unthinkable, and Adobe\'s converter wants a paid subscription.</p>
<p>The free <a href="/pdf-to-word">PDF to Word</a> tool from ILovePDF turns any PDF into an editable <code>.docx</code> file you can open in Microsoft Word, Google Docs, or LibreOffice — in seconds.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Go to <a href="/pdf-to-word">ilovepdf.cyou/pdf-to-word</a>.' },
      { title: 'Upload the PDF', body: 'Drag and drop the PDF you want to convert. Files up to 100 MB are supported.' },
      { title: 'Process', body: 'Click Process. The tool extracts text, images and basic formatting and rebuilds them into a Word-compatible structure.' },
      { title: 'Download the .docx', body: 'The result downloads as <code>ILovePDF-pdf-to-word.docx</code>.' },
      { title: 'Open and edit', body: 'Open in Word, Google Docs, or any office suite — you can now edit the text directly.' },
    ],
    benefits: [
      { title: 'No signup', body: 'Convert immediately. No email verification, no trial limits, no watermarks.' },
      { title: 'Layout preserved', body: 'Headings, paragraphs, lists and inline images are reconstructed in the Word output.' },
      { title: 'Universal format', body: '.docx opens in Word, Google Docs, Pages, LibreOffice, OpenOffice — basically every modern editor.' },
      { title: 'Edit then re-export', body: 'After editing in Word, save back to PDF using <a href="/word-to-pdf">Word to PDF</a> for a clean round trip.' },
    ],
    useCases: [
      { audience: 'Job seekers', body: 'Receive a CV template as a PDF? Convert it to Word, customise it, and re-export.' },
      { audience: 'Translators', body: 'Convert a foreign-language PDF to Word so a CAT tool or translator can edit the text directly.' },
      { audience: 'Legal teams', body: 'Edit a contract PDF without losing the original layout — track changes work as expected in Word.' },
    ],
    tips: [
      { title: 'OCR scanned PDFs first', body: 'Image-only PDFs need OCR before conversion. Run them through <a href="/ocr-pdf">OCR PDF</a> first.' },
      { title: 'Check tables carefully', body: 'Complex tables may need minor cleanup in Word — review before sending.' },
      { title: 'Re-export to PDF when done', body: 'Use <a href="/word-to-pdf">Word to PDF</a> to lock the edited document back into a final PDF.' },
      { title: 'Use Translate for languages', body: 'For automatic translation, <a href="/translate-pdf">Translate PDF</a> may be faster than Word + Google Translate.' },
    ],
    faq: [
      { q: 'Does the formatting stay perfect?', a: 'Most layouts are preserved well. Highly designed PDFs (magazines, posters) may lose some absolute positioning.' },
      { q: 'Can I convert scanned PDFs?', a: 'Run them through OCR first to extract text, then convert. Otherwise you\'ll get a Word doc full of images.' },
      { q: 'What about images and embedded fonts?', a: 'Images are preserved. Fonts default to standard substitutes if the original isn\'t available on your system.' },
      { q: 'Is there a page-count limit?', a: 'No. The only limit is the 100 MB file-size cap on free uploads.' },
    ],
    related: ['word-to-pdf-guide', 'ocr-pdf-guide', 'pdf-to-excel-guide', 'translate-pdf-guide'],
  },

  {
    slug: 'pdf-to-powerpoint-guide',
    toolSlug: '/pdf-to-powerpoint',
    toolName: 'PDF to PowerPoint',
    icon: 'presentation',
    tag: 'Conversion',
    category: 'Convert From PDF',
    title: 'Convert PDF to PowerPoint Online Free — PDF to PPTX Guide',
    description: 'Turn any PDF into editable PowerPoint slides (.pptx) in seconds. Free converter — no signup, no email, no watermark.',
    intro: `<p>Slide decks have a habit of arriving as PDFs — the safest format for sharing, but useless if you actually want to repurpose a slide for your own deck. The <a href="/pdf-to-powerpoint">PDF to PowerPoint</a> tool converts each PDF page into an editable PowerPoint slide so you can copy, paste, restyle or completely rework them.</p>
<p>Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Go to <a href="/pdf-to-powerpoint">ilovepdf.cyou/pdf-to-powerpoint</a>.' },
      { title: 'Upload your PDF', body: 'Drop the file. Each PDF page becomes one slide.' },
      { title: 'Process', body: 'The tool reconstructs text, images and layout into a .pptx structure.' },
      { title: 'Download', body: 'The result saves as <code>ILovePDF-pdf-to-powerpoint.pptx</code>.' },
      { title: 'Open in PowerPoint', body: 'Open in Microsoft PowerPoint, Keynote, or Google Slides and start editing.' },
    ],
    benefits: [
      { title: 'Editable slides', body: 'Each PDF page becomes a real PowerPoint slide — text boxes are editable, not flattened images.' },
      { title: 'No signup', body: 'Free, immediate, no account required.' },
      { title: 'Universal output', body: '.pptx opens in PowerPoint, Keynote, and Google Slides without conversion.' },
      { title: 'Preserves layout', body: 'Page composition, headings and image positions transfer over for a near-identical look.' },
    ],
    useCases: [
      { audience: 'Sales teams', body: 'Repurpose a customer-shared PDF deck into your own template for a follow-up pitch.' },
      { audience: 'Educators', body: 'Convert lecture slides someone else built into PowerPoint so you can adapt them for your own class.' },
      { audience: 'Consultants', body: 'Edit a PDF report into a slide deck for a board presentation without re-creating the visuals.' },
    ],
    tips: [
      { title: 'Run OCR first if scanned', body: 'For scanned PDFs, run <a href="/ocr-pdf">OCR PDF</a> first so text is extracted as editable text, not images.' },
      { title: 'Use PowerPoint themes', body: 'After import, apply your own theme to unify fonts and colours across all slides.' },
      { title: 'Re-export back to PDF', body: 'Once edited, use <a href="/powerpoint-to-pdf">PowerPoint to PDF</a> to share the final version.' },
      { title: 'Compress images for sharing', body: 'PowerPoint files can be heavy. Compress images inside PowerPoint before sending.' },
    ],
    faq: [
      { q: 'Does it preserve animations or transitions?', a: 'No — PDFs don\'t store animations, so the .pptx output starts with no transitions. You can add your own.' },
      { q: 'Is the layout pixel-perfect?', a: 'Most layouts transfer well. Complex absolute positioning may need minor adjustment.' },
      { q: 'Can I convert image-only PDFs?', a: 'Yes, but text will appear as images. Run OCR first if you want editable text.' },
      { q: 'Is there a slide-count limit?', a: 'No, only the 100 MB file-size cap.' },
    ],
    related: ['powerpoint-to-pdf-guide', 'pdf-to-word-guide', 'ocr-pdf-guide', 'compress-pdf-guide'],
  },

  {
    slug: 'pdf-to-excel-guide',
    toolSlug: '/pdf-to-excel',
    toolName: 'PDF to Excel',
    icon: 'sheet',
    tag: 'Conversion',
    category: 'Convert From PDF',
    title: 'Convert PDF to Excel Online — Free PDF Tables to XLSX',
    description: 'Extract tables from any PDF into an editable Excel spreadsheet. Free, fast, no signup. Perfect for invoices, reports and bank statements.',
    intro: `<p>Bank statements. Invoices. Quarterly reports. They all arrive as PDFs and they all contain tables you wish you could just paste into Excel. Manual re-typing is error-prone and slow — automated extraction is the only sane option.</p>
<p>The <a href="/pdf-to-excel">PDF to Excel</a> tool detects tabular data in your PDF and outputs a clean <code>.xlsx</code> spreadsheet. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Visit <a href="/pdf-to-excel">ilovepdf.cyou/pdf-to-excel</a>.' },
      { title: 'Upload the PDF', body: 'Drop your tabular PDF — invoice, statement or report — onto the upload area.' },
      { title: 'Process', body: 'The tool detects table structure and extracts cell values into a spreadsheet.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-pdf-to-excel.xlsx</code>.' },
      { title: 'Open and review', body: 'Open in Excel, Google Sheets, or LibreOffice Calc and verify the cells match the original.' },
    ],
    benefits: [
      { title: 'Save hours of typing', body: 'Skip manually re-keying data — the tool extracts whole tables in one pass.' },
      { title: 'Editable cells', body: 'Numbers and text become real spreadsheet cells you can sum, filter, and chart.' },
      { title: 'Handles multi-page', body: 'Tables that span multiple PDF pages are stitched together in a single sheet.' },
      { title: 'Universal format', body: '.xlsx opens in Excel, Google Sheets, Numbers, and LibreOffice Calc.' },
    ],
    useCases: [
      { audience: 'Finance teams', body: 'Extract bank statement transactions into Excel for reconciliation and reporting.' },
      { audience: 'Procurement', body: 'Pull line items from supplier invoices into a sheet for budget tracking.' },
      { audience: 'Researchers', body: 'Convert published data tables from research PDFs into spreadsheet form for analysis.' },
    ],
    tips: [
      { title: 'OCR scanned PDFs first', body: 'Image-only PDFs need <a href="/ocr-pdf">OCR PDF</a> before extraction; otherwise tables come through as pictures.' },
      { title: 'Verify number formats', body: 'Currency symbols and thousand-separators may need cleanup — use Excel\'s Find & Replace.' },
      { title: 'Use Excel\'s Tables', body: 'Convert the imported range to an Excel Table for sorting, filtering, and named ranges.' },
      { title: 'Re-export to PDF later', body: 'After analysis, share the result via <a href="/excel-to-pdf">Excel to PDF</a> for a polished read-only output.' },
    ],
    faq: [
      { q: 'Will it extract every table perfectly?', a: 'Most clean tables come through accurately. Heavily merged cells or no-grid layouts may need cleanup.' },
      { q: 'Can I extract tables from a scanned PDF?', a: 'Run OCR first using <a href="/ocr-pdf">OCR PDF</a>. Otherwise the tool sees pixels, not numbers.' },
      { q: 'How are formulas handled?', a: 'PDFs don\'t store formulas — only their computed values. You\'ll need to re-enter formulas in Excel.' },
      { q: 'Does each PDF page become one sheet?', a: 'Tables are merged into the same sheet by default for easier analysis.' },
    ],
    related: ['excel-to-pdf-guide', 'pdf-to-word-guide', 'ocr-pdf-guide', 'compress-pdf-guide'],
  },

  {
    slug: 'pdf-to-jpg-guide',
    toolSlug: '/pdf-to-jpg',
    toolName: 'PDF to JPG',
    icon: 'image',
    tag: 'Conversion',
    category: 'Convert From PDF',
    title: 'Convert PDF to JPG Online — Free High-Quality Image Export',
    description: 'Export every PDF page as a high-quality JPG image. Choose 150 or 200 DPI. Free, no signup, instant download.',
    intro: `<p>Sometimes a PDF needs to become an image — for a slide deck thumbnail, a website preview, an Instagram post, or a chat attachment to someone whose device doesn\'t open PDFs cleanly.</p>
<p>The <a href="/pdf-to-jpg">PDF to JPG</a> tool converts every PDF page into a separate JPG image at your chosen quality. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/pdf-to-jpg">ilovepdf.cyou/pdf-to-jpg</a>.' },
      { title: 'Upload your PDF', body: 'Drag and drop. Multi-page PDFs become multiple JPGs in a ZIP.' },
      { title: 'Pick image quality', body: 'Standard (150 DPI) is fine for screen viewing. High (200 DPI) is better for printing.' },
      { title: 'Process', body: 'The tool renders each page as a JPG using sharp.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-pdf-to-jpg.zip</code> (or single JPG for one-page PDFs).' },
    ],
    benefits: [
      { title: 'High-quality images', body: 'Choose 200 DPI for crisp print-ready images or 150 DPI for fast screen sharing.' },
      { title: 'Universal compatibility', body: 'JPG opens on every device — phones, tablets, browsers, social platforms.' },
      { title: 'Bulk export', body: 'Multi-page PDFs become a clean ZIP of numbered images you can use individually.' },
      { title: 'Privacy-friendly', body: 'Files are processed in seconds and auto-deleted from our servers.' },
    ],
    useCases: [
      { audience: 'Social media managers', body: 'Convert a one-page PDF flyer to JPG for Instagram, where PDFs aren\'t supported.' },
      { audience: 'Web designers', body: 'Generate thumbnail previews of PDF brochures for embedding on a product page.' },
      { audience: 'Print shops', body: 'Convert PDFs to high-DPI JPGs for tools or workflows that prefer raster input.' },
    ],
    tips: [
      { title: 'Use 200 DPI for printing', body: 'Standard quality is fine for screens but can look pixellated when printed. Choose High for any print job.' },
      { title: 'Compress images afterwards', body: 'If file size matters (e.g. uploading to Instagram), compress the JPGs before posting.' },
      { title: 'Convert back to PDF', body: 'Need to recombine? <a href="/jpg-to-pdf">JPG to PDF</a> stitches images back into a single PDF.' },
      { title: 'Use background removal', body: 'For product photos in PDFs, run the JPG through <a href="/background-remover">Background Remover</a> next.' },
    ],
    faq: [
      { q: 'What\'s the difference between 150 and 200 DPI?', a: 'Higher DPI means more pixels per inch — sharper but bigger files. Use 200 DPI for printing, 150 for on-screen use.' },
      { q: 'Can I convert just one page?', a: 'For single-page extraction, run <a href="/split-pdf">Split PDF</a> first, then convert the result.' },
      { q: 'Will the JPGs be watermarked?', a: 'No — output is clean with no branding.' },
      { q: 'Is PNG output available?', a: 'Currently JPG only. JPG is more compact and universally supported. PNG support is on the roadmap.' },
    ],
    related: ['jpg-to-pdf-guide', 'compress-pdf-guide', 'background-remover-guide', 'crop-image-guide'],
  },

  // ============================================================
  // CONVERT TO PDF
  // ============================================================

  {
    slug: 'word-to-pdf-guide',
    toolSlug: '/word-to-pdf',
    toolName: 'Word to PDF',
    icon: 'file-text',
    tag: 'Conversion',
    category: 'Convert To PDF',
    title: 'Convert Word to PDF Online Free — DOCX to PDF Guide',
    description: 'Convert Word documents (.doc, .docx) to PDF in seconds. Preserve fonts, layout and images. Free online tool, no signup.',
    intro: `<p>You finished writing a CV, contract, or report in Word, but the recipient needs a PDF — the universal format that looks the same on every device, that prints predictably, and that no one can accidentally edit.</p>
<p>The <a href="/word-to-pdf">Word to PDF</a> tool converts <code>.doc</code> and <code>.docx</code> files into clean, professional PDFs. Here\'s how.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Visit <a href="/word-to-pdf">ilovepdf.cyou/word-to-pdf</a>.' },
      { title: 'Upload your Word file', body: 'Drag and drop a .docx (or .doc) file onto the upload area.' },
      { title: 'Process', body: 'The tool renders the document while preserving fonts, headings, and inline images.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-word-to-pdf.pdf</code>.' },
      { title: 'Share with confidence', body: 'The PDF will look identical to the Word version on any device or operating system.' },
    ],
    benefits: [
      { title: 'Universal format', body: 'PDF renders identically on every device — no font surprises, no layout shifts.' },
      { title: 'Lock the layout', body: 'Recipients can\'t accidentally edit or reformat the document.' },
      { title: 'Smaller share size', body: 'Word files with embedded media are often larger than the equivalent PDF.' },
      { title: 'Print-ready', body: 'PDF is the standard format for print shops and professional printing.' },
    ],
    useCases: [
      { audience: 'Job applicants', body: 'Convert your CV from .docx to PDF before submitting through an applicant tracking system (ATS).' },
      { audience: 'Contractors', body: 'Send signed contracts as PDFs so clients can\'t accidentally tweak the wording.' },
      { audience: 'Authors', body: 'Export a manuscript chapter to PDF for distribution to beta readers.' },
    ],
    tips: [
      { title: 'Embed your fonts in Word first', body: 'Use Word\'s "Embed fonts in the file" option before exporting if you used a custom font.' },
      { title: 'Compress after converting', body: 'Use <a href="/compress-pdf">Compress PDF</a> if your Word doc has large embedded images.' },
      { title: 'Add watermark or page numbers', body: 'Use <a href="/watermark-pdf">Watermark PDF</a> or <a href="/add-page-numbers">Add Page Numbers</a> for the final touch.' },
      { title: 'Protect with a password', body: 'Lock sensitive PDFs with <a href="/protect-pdf">Protect PDF</a> before emailing.' },
    ],
    faq: [
      { q: 'Will my fonts look the same?', a: 'Standard fonts (Calibri, Times, Arial) are preserved. Custom fonts must be embedded in the source Word file.' },
      { q: 'Are images preserved?', a: 'Yes — embedded images render at full quality in the resulting PDF.' },
      { q: 'Can I convert .doc files (older format)?', a: 'Yes, both .doc and .docx are supported.' },
      { q: 'Does it preserve hyperlinks?', a: 'Yes — clickable hyperlinks survive the conversion.' },
    ],
    related: ['pdf-to-word-guide', 'compress-pdf-guide', 'protect-pdf-guide', 'watermark-pdf-guide'],
  },

  {
    slug: 'powerpoint-to-pdf-guide',
    toolSlug: '/powerpoint-to-pdf',
    toolName: 'PowerPoint to PDF',
    icon: 'presentation',
    tag: 'Conversion',
    category: 'Convert To PDF',
    title: 'Convert PowerPoint to PDF Online Free — PPTX to PDF',
    description: 'Convert PowerPoint presentations (.ppt, .pptx) to clean, shareable PDFs in seconds. Free, no signup, no watermark.',
    intro: `<p>Sharing a PowerPoint deck as a .pptx file is risky: fonts may be missing on the recipient\'s machine, animations might not run, and editable slides invite accidental changes. Converting to <strong>PDF</strong> solves all of that — one read-only file that looks identical everywhere.</p>
<p>The <a href="/powerpoint-to-pdf">PowerPoint to PDF</a> tool handles both .ppt and .pptx files. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Go to <a href="/powerpoint-to-pdf">ilovepdf.cyou/powerpoint-to-pdf</a>.' },
      { title: 'Upload your slide deck', body: 'Drop a .ppt or .pptx file onto the upload area.' },
      { title: 'Process', body: 'Each slide becomes a single PDF page in original order.' },
      { title: 'Download', body: 'The PDF saves as <code>ILovePDF-powerpoint-to-pdf.pdf</code>.' },
      { title: 'Share', body: 'Email or upload the PDF — recipients see exactly what you designed.' },
    ],
    benefits: [
      { title: 'Locked design', body: 'Slide layouts, fonts and visuals stay exactly as designed — no font substitution mishaps.' },
      { title: 'Smaller files', body: 'PDF compression is generally tighter than PowerPoint\'s native format.' },
      { title: 'Universal viewing', body: 'PDFs open on any device without PowerPoint installed.' },
      { title: 'Print-friendly', body: 'PDF is the standard for handouts and conference distribution.' },
    ],
    useCases: [
      { audience: 'Conference speakers', body: 'Convert your deck to PDF and share with the audience as a downloadable handout.' },
      { audience: 'Sales reps', body: 'Send a pitch deck as PDF so prospects can view it on any device, including phones.' },
      { audience: 'Teachers', body: 'Distribute lecture slides as PDFs that students can print or annotate.' },
    ],
    tips: [
      { title: 'Convert speaker notes too', body: 'In PowerPoint, choose "Notes Pages" before exporting if you want notes in the PDF.' },
      { title: 'Add watermarks if confidential', body: 'Run the PDF through <a href="/watermark-pdf">Watermark PDF</a> after conversion.' },
      { title: 'Compress for email', body: 'Decks with high-res images can be huge — pass through <a href="/compress-pdf">Compress PDF</a>.' },
      { title: 'Round-trip with PDF to PowerPoint', body: 'Edits needed later? Use <a href="/pdf-to-powerpoint">PDF to PowerPoint</a> to make slides editable again.' },
    ],
    faq: [
      { q: 'Will animations and transitions be preserved?', a: 'No — PDF is a static format. Only the static appearance of each slide is captured.' },
      { q: 'Can I include speaker notes?', a: 'The default conversion exports slides only. For notes, set the export layout to Notes Pages in PowerPoint first.' },
      { q: 'Does it support old .ppt files?', a: 'Yes, both legacy .ppt and modern .pptx formats convert.' },
      { q: 'Are embedded videos preserved?', a: 'No — video content can\'t be embedded in PDF. A still frame may be inserted in its place.' },
    ],
    related: ['pdf-to-powerpoint-guide', 'compress-pdf-guide', 'watermark-pdf-guide', 'word-to-pdf-guide'],
  },

  {
    slug: 'excel-to-pdf-guide',
    toolSlug: '/excel-to-pdf',
    toolName: 'Excel to PDF',
    icon: 'sheet',
    tag: 'Conversion',
    category: 'Convert To PDF',
    title: 'Convert Excel to PDF Online — Free XLSX to PDF Guide',
    description: 'Turn Excel spreadsheets (.xls, .xlsx) into clean PDF reports. Free online converter — no signup or install required.',
    intro: `<p>Excel is great for crunching numbers but terrible for sharing — the recipient sees rows that span weirdly, columns that don\'t fit, and formulas they can accidentally break. Convert to <strong>PDF</strong> first and you ship a clean, read-only snapshot of exactly what you intend.</p>
<p>The <a href="/excel-to-pdf">Excel to PDF</a> tool turns any .xls or .xlsx file into a print-ready PDF in seconds.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Visit <a href="/excel-to-pdf">ilovepdf.cyou/excel-to-pdf</a>.' },
      { title: 'Upload your spreadsheet', body: 'Drag and drop a .xls or .xlsx file. Multiple sheets are supported.' },
      { title: 'Process', body: 'The tool renders each sheet to one or more PDF pages.' },
      { title: 'Download', body: 'The result saves as <code>ILovePDF-excel-to-pdf.pdf</code>.' },
      { title: 'Review and share', body: 'Open the PDF to confirm columns and rows look right, then share by email or upload.' },
    ],
    benefits: [
      { title: 'Locked output', body: 'Numbers can\'t be accidentally changed once locked into PDF.' },
      { title: 'Print-ready', body: 'Predictable page breaks — no more mystery row chops on the recipient\'s printer.' },
      { title: 'Smaller files', body: 'Workbooks with formulas often shrink dramatically when only the rendered values are stored.' },
      { title: 'Universal viewing', body: 'PDF opens everywhere — Excel doesn\'t.' },
    ],
    useCases: [
      { audience: 'Finance', body: 'Lock a monthly report as PDF before sending to leadership so numbers can\'t be tweaked downstream.' },
      { audience: 'HR', body: 'Distribute payslips and benefit summaries as PDFs to keep the original spreadsheet logic private.' },
      { audience: 'Project management', body: 'Send a Gantt-style schedule as a PDF so the team sees the same view regardless of Excel version.' },
    ],
    tips: [
      { title: 'Set print area in Excel first', body: 'Configure page setup and print area in Excel before exporting for predictable layout.' },
      { title: 'Use landscape for wide tables', body: 'Set orientation to landscape in Excel\'s Page Setup if your spreadsheet is wide.' },
      { title: 'Compress if image-heavy', body: 'For workbooks with charts or images, run through <a href="/compress-pdf">Compress PDF</a>.' },
      { title: 'Round-trip with PDF to Excel', body: 'If edits are needed later, <a href="/pdf-to-excel">PDF to Excel</a> can extract data back.' },
    ],
    faq: [
      { q: 'Are formulas preserved?', a: 'No — PDFs store the computed values, not the underlying formulas. Keep your .xlsx as the master copy.' },
      { q: 'Will every sheet be exported?', a: 'Yes — each visible sheet becomes one or more PDF pages.' },
      { q: 'Can I export hidden sheets?', a: 'Hidden sheets are skipped by default. Unhide them in Excel before converting if needed.' },
      { q: 'How are charts handled?', a: 'Charts are rasterised into the PDF and look identical to the Excel preview.' },
    ],
    related: ['pdf-to-excel-guide', 'compress-pdf-guide', 'word-to-pdf-guide', 'protect-pdf-guide'],
  },

  {
    slug: 'jpg-to-pdf-guide',
    toolSlug: '/jpg-to-pdf',
    toolName: 'JPG to PDF',
    icon: 'image',
    tag: 'Conversion',
    category: 'Convert To PDF',
    title: 'Convert JPG to PDF Online Free — Combine Images Into PDF',
    description: 'Combine multiple JPG, PNG or other images into a single PDF document. Free, fast, no signup. Perfect for receipts, scans and photo books.',
    intro: `<p>Phone cameras have replaced flatbed scanners — but emailing 12 separate JPG attachments is painful for everyone. Combining images into a single PDF makes them easy to share, print and archive.</p>
<p>The <a href="/jpg-to-pdf">JPG to PDF</a> tool stitches any number of images into one tidy PDF. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/jpg-to-pdf">ilovepdf.cyou/jpg-to-pdf</a>.' },
      { title: 'Upload your images', body: 'Drag and drop multiple .jpg, .jpeg, or .png files onto the upload area.' },
      { title: 'Reorder', body: 'Drag the thumbnails into the page order you want them to appear in the PDF.' },
      { title: 'Process', body: 'Each image becomes a single PDF page at original resolution.' },
      { title: 'Download', body: 'The combined PDF saves as <code>ILovePDF-jpg-to-pdf.pdf</code>.' },
    ],
    benefits: [
      { title: 'One file to share', body: 'No more attaching 12 photos — recipients see one clean PDF.' },
      { title: 'Drag-and-drop reordering', body: 'Arrange pages exactly the way you want before exporting.' },
      { title: 'High-quality output', body: 'Original image resolution is preserved — no compression by default.' },
      { title: 'Universal format', body: 'PDF opens on every device, even ones that don\'t handle big JPG batches.' },
    ],
    useCases: [
      { audience: 'Expense reports', body: 'Combine receipt photos into a single PDF to attach to your monthly expense submission.' },
      { audience: 'Phone scans', body: 'Turn a stack of phone-camera "scans" into one searchable PDF after running through <a href="/ocr-pdf">OCR PDF</a>.' },
      { audience: 'Photo portfolios', body: 'Build a quick photo PDF for clients without using design software.' },
    ],
    tips: [
      { title: 'Order matters', body: 'Drag thumbnails into the right sequence before processing — page order matches upload order.' },
      { title: 'Compress before sharing', body: 'High-resolution photos make big PDFs. Run through <a href="/compress-pdf">Compress PDF</a> for email.' },
      { title: 'Add page numbers', body: 'For long photo PDFs, run <a href="/add-page-numbers">Add Page Numbers</a> to make navigation easier.' },
      { title: 'Use OCR for scans', body: 'If photos are of text documents, run the result through <a href="/ocr-pdf">OCR PDF</a> for searchable text.' },
    ],
    faq: [
      { q: 'How many images can I combine?', a: 'There\'s no hard cap on count. Each image just needs to be under 100 MB.' },
      { q: 'Does it support PNG and HEIC?', a: 'JPG, JPEG and PNG are fully supported. HEIC is best converted to JPG first.' },
      { q: 'Will images be cropped?', a: 'No. Each image becomes a single PDF page sized to fit the original aspect ratio.' },
      { q: 'Is the output watermarked?', a: 'No. The PDF is clean — no ILovePDF branding inside the document.' },
    ],
    related: ['pdf-to-jpg-guide', 'compress-pdf-guide', 'add-page-numbers-guide', 'ocr-pdf-guide'],
  },

  {
    slug: 'html-to-pdf-guide',
    toolSlug: '/html-to-pdf',
    toolName: 'HTML to PDF',
    icon: 'code',
    tag: 'Conversion',
    category: 'Convert To PDF',
    title: 'Convert HTML to PDF Online Free — Render Webpages as PDF',
    description: 'Turn HTML files into clean, print-ready PDF documents. Free online converter for developers and writers. No signup required.',
    intro: `<p>Need a print-ready version of an HTML page? Maybe you\'re archiving a webpage, creating a PDF version of an email template, or generating a report from a static site export. <strong>HTML to PDF</strong> is the bridge.</p>
<p>The <a href="/html-to-pdf">HTML to PDF</a> tool renders any uploaded HTML file (with linked styles and images) into a single PDF document.</p>`,
    steps: [
      { title: 'Open the converter', body: 'Visit <a href="/html-to-pdf">ilovepdf.cyou/html-to-pdf</a>.' },
      { title: 'Upload your HTML file', body: 'Drag and drop a .html or .htm file onto the upload area.' },
      { title: 'Process', body: 'The tool renders the HTML and converts it to a structured PDF.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-html-to-pdf.pdf</code>.' },
      { title: 'Verify rendering', body: 'Open the PDF to confirm headings, images and layout came through as expected.' },
    ],
    benefits: [
      { title: 'Archive webpages', body: 'Capture a stable, paginated record of any HTML page for archiving or compliance.' },
      { title: 'Developer-friendly', body: 'Generate report PDFs from server-rendered HTML without spinning up Puppeteer locally.' },
      { title: 'Style-aware', body: 'Inline CSS and basic external styles are respected for accurate visual rendering.' },
      { title: 'Universal format', body: 'PDF is more shareable and printable than raw HTML.' },
    ],
    useCases: [
      { audience: 'Developers', body: 'Convert a static report or invoice template you generated as HTML into a downloadable PDF for users.' },
      { audience: 'Email designers', body: 'Save a copy of a finished email template as a PDF for client approval.' },
      { audience: 'Researchers', body: 'Archive an interesting article as a self-contained PDF you can read offline.' },
    ],
    tips: [
      { title: 'Inline your CSS', body: 'For best fidelity, embed CSS directly in the HTML <code>&lt;style&gt;</code> block before uploading.' },
      { title: 'Use absolute image URLs', body: 'External image references should be absolute URLs so they resolve during rendering.' },
      { title: 'Preview as PDF first', body: 'Use Chrome\'s "Print to PDF" preview locally to spot layout issues before uploading.' },
      { title: 'Compress after converting', body: 'Pages with embedded high-res images can be huge — run through <a href="/compress-pdf">Compress PDF</a>.' },
    ],
    faq: [
      { q: 'Are JavaScript-rendered pages supported?', a: 'The tool renders the HTML as-is. JavaScript-driven content needs to be rendered before upload (e.g. via "Save As" in your browser).' },
      { q: 'Will my fonts work?', a: 'Web-safe fonts and Google Fonts loaded via <code>&lt;link&gt;</code> are supported. Custom local fonts may need embedding.' },
      { q: 'Can I convert a URL directly?', a: 'Currently the tool accepts uploaded files only. To convert a live page, save it as HTML first using your browser.' },
      { q: 'Are page breaks respected?', a: 'CSS <code>page-break-before</code> and <code>page-break-after</code> rules are honoured during rendering.' },
    ],
    related: ['pdf-to-word-guide', 'compress-pdf-guide', 'word-to-pdf-guide', 'best-pdf-tools'],
  },

  // ============================================================
  // EDIT & ANNOTATE
  // ============================================================

  {
    slug: 'edit-pdf-guide',
    toolSlug: '/edit-pdf',
    toolName: 'Edit PDF',
    icon: 'edit-3',
    tag: 'Tutorial',
    category: 'Edit & Annotate',
    title: 'How to Edit a PDF Online Free — Add Text & Annotations',
    description: 'Add text, notes and annotations to any PDF in your browser. Free Edit PDF tool — no signup, no software, no watermark.',
    intro: `<p>You don\'t always need a $20/month PDF editor just to add a single sentence to a contract or fix a typo on a flyer. <strong>Light PDF editing</strong> — text overlays, notes, simple annotations — should be free and instant.</p>
<p>The <a href="/edit-pdf">Edit PDF</a> tool lets you stamp text on any page of a PDF directly from your browser. Here\'s how.</p>`,
    steps: [
      { title: 'Open the editor', body: 'Visit <a href="/edit-pdf">ilovepdf.cyou/edit-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drag and drop the file you want to edit.' },
      { title: 'Enter the text', body: 'Type the text you want to add, then set X / Y position (as a percentage), font size and target page.' },
      { title: 'Process', body: 'The tool overlays your text onto the chosen page(s) without modifying the original content.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-edit.pdf</code>. The original is untouched.' },
    ],
    benefits: [
      { title: 'No software install', body: 'Browser-based editing — works on phone, tablet or laptop.' },
      { title: 'Pixel-precise placement', body: 'Position text using percentage coordinates so it lands exactly where you want.' },
      { title: 'Per-page control', body: 'Apply text to one specific page or to every page in the document.' },
      { title: 'Non-destructive', body: 'The original PDF is never modified — only the new copy carries the edits.' },
    ],
    useCases: [
      { audience: 'Form filling', body: 'Add your name, date and answers to a simple PDF form without printing and re-scanning.' },
      { audience: 'Quick fixes', body: 'Correct a typo or update a date on a PDF without going back to the source file.' },
      { audience: 'Annotations', body: 'Stamp "DRAFT" or "REVIEWED" on a document before sharing internally.' },
    ],
    tips: [
      { title: 'Use percentage coordinates', body: 'X/Y positions are 0–100% — easier to predict than raw points across different page sizes.' },
      { title: 'Test on one page first', body: 'Run a single-page edit before applying to "all" to avoid mass typos.' },
      { title: 'Combine with Sign PDF', body: 'For signature lines, use <a href="/sign-pdf">Sign PDF</a> instead — it\'s optimised for that.' },
      { title: 'Watermark with Watermark PDF', body: 'For diagonal watermarks, use the dedicated <a href="/watermark-pdf">Watermark PDF</a> tool.' },
    ],
    faq: [
      { q: 'Can I edit existing text in the PDF?', a: 'No. The tool overlays new text on top — it doesn\'t modify the underlying text. For full editing, convert to Word with <a href="/pdf-to-word">PDF to Word</a>.' },
      { q: 'How precise is the placement?', a: 'Coordinates use percentages (0–100), so placement is consistent across page sizes.' },
      { q: 'Can I add images?', a: 'The current tool focuses on text. Image overlays are on the roadmap.' },
      { q: 'Does it support multiple text boxes?', a: 'One overlay per run — process the PDF multiple times for multiple text additions.' },
    ],
    related: ['watermark-pdf-guide', 'sign-pdf-guide', 'add-page-numbers-guide', 'pdf-to-word-guide'],
  },

  {
    slug: 'watermark-pdf-guide',
    toolSlug: '/watermark-pdf',
    toolName: 'Watermark PDF',
    icon: 'droplet',
    tag: 'Tutorial',
    category: 'Edit & Annotate',
    title: 'How to Add a Watermark to a PDF Online Free',
    description: 'Stamp custom text watermarks (CONFIDENTIAL, DRAFT, your name) on every page of a PDF. Free, no signup, no install.',
    intro: `<p>A <strong>watermark</strong> protects your document — both legally and visually. It signals ownership, marks drafts, flags confidentiality, or just adds a "do not copy" message that\'s hard to ignore.</p>
<p>The <a href="/watermark-pdf">Watermark PDF</a> tool stamps customisable text watermarks across every page. Here\'s the full walkthrough.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/watermark-pdf">ilovepdf.cyou/watermark-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drag and drop the PDF you want to watermark.' },
      { title: 'Enter watermark text', body: 'Type the text you want stamped, e.g. <code>CONFIDENTIAL</code> or your name.' },
      { title: 'Pick opacity & position', body: 'Choose opacity from 0.1–0.9 (lower is more transparent). Pick a position: centred (diagonal) or one of four corners.' },
      { title: 'Process and download', body: 'The watermark is applied to every page. Save as <code>ILovePDF-watermark.pdf</code>.' },
    ],
    benefits: [
      { title: 'Brand protection', body: 'Visible attribution makes unauthorised reuse obvious and harder to crop out.' },
      { title: 'Draft & status flags', body: 'Stamp DRAFT, FINAL, REVIEWED or CONFIDENTIAL so the document\'s status is always clear.' },
      { title: 'Customisable opacity', body: 'Subtle (0.2) for branding, bold (0.8) for high-visibility status flags.' },
      { title: 'Five position presets', body: 'Centre diagonal, or any of the four corners — covers every common use case.' },
    ],
    useCases: [
      { audience: 'Designers', body: 'Stamp portfolios with your name so clients can\'t crop you out and re-share.' },
      { audience: 'Legal & finance', body: 'Mark every page of a contract draft as DRAFT until the final version is locked.' },
      { audience: 'Education', body: 'Watermark exam papers as CONFIDENTIAL until they\'re officially released.' },
    ],
    tips: [
      { title: 'Lower opacity for branding', body: 'Use 0.2–0.3 opacity for subtle brand watermarks. Use 0.7+ for status messages.' },
      { title: 'Diagonal centred is the strongest', body: 'Centre position rotates the text 45°, the hardest layout to crop out.' },
      { title: 'Watermark before signing', body: 'Apply the watermark first, then run through <a href="/sign-pdf">Sign PDF</a> for the final signature.' },
      { title: 'Combine with Protect PDF', body: 'For maximum security, watermark and then <a href="/protect-pdf">password-protect</a> the PDF.' },
    ],
    faq: [
      { q: 'Can I watermark with an image?', a: 'Currently text watermarks only. Image watermark support is on the roadmap.' },
      { q: 'Will the watermark obscure my content?', a: 'Lower opacity (0.2) keeps content readable. Higher opacity (0.8+) is for high-visibility flags.' },
      { q: 'Can different pages have different watermarks?', a: 'One watermark per run. Split the PDF first if pages need different stamps, then merge again.' },
      { q: 'Is the watermark removable?', a: 'Watermarks are permanently rendered into the PDF — they can\'t be programmatically removed.' },
    ],
    related: ['edit-pdf-guide', 'sign-pdf-guide', 'protect-pdf-guide', 'redact-pdf-guide'],
  },

  {
    slug: 'sign-pdf-guide',
    toolSlug: '/sign-pdf',
    toolName: 'Sign PDF',
    icon: 'pen-tool',
    tag: 'Tutorial',
    category: 'Edit & Annotate',
    title: 'How to Sign a PDF Online for Free — Digital Signature Guide',
    description: 'Add a digital text signature to any PDF in seconds. Free Sign PDF tool — no signup, no software, no watermark.',
    intro: `<p>Printing a contract just to sign it, scanning the signed page, then emailing the resulting PDF — it\'s 2025, and it\'s ridiculous. A <strong>digital signature</strong> can be added in your browser in under a minute, and it\'s legally binding in most jurisdictions for everyday business agreements.</p>
<p>The <a href="/sign-pdf">Sign PDF</a> tool stamps a clean text-based signature onto any page. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/sign-pdf">ilovepdf.cyou/sign-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drag and drop the document you need to sign.' },
      { title: 'Type your signature', body: 'Enter your full name (or signature wording) in the Signature field.' },
      { title: 'Pick the page', body: 'Specify which page to sign. Leave blank to sign the last page (the most common spot).' },
      { title: 'Process and download', body: 'The signed PDF saves as <code>ILovePDF-sign.pdf</code>.' },
    ],
    benefits: [
      { title: 'Save trees and time', body: 'No printing, no scanning, no postage — sign and send in 60 seconds.' },
      { title: 'Legally usable', body: 'Typed signatures are accepted under e-signature laws like ESIGN (US) and eIDAS (EU) for most everyday agreements.' },
      { title: 'Mobile-friendly', body: 'Sign right from your phone or tablet — no app install required.' },
      { title: 'Non-destructive', body: 'Original PDF is never modified — your signature is added to a new copy.' },
    ],
    useCases: [
      { audience: 'Freelancers', body: 'Sign client contracts without printing, scanning, or driving to the post office.' },
      { audience: 'HR', body: 'Sign onboarding paperwork digitally and email it back the same day.' },
      { audience: 'Real estate', body: 'Initial agreements and addendums on the go without breaking the deal\'s momentum.' },
    ],
    tips: [
      { title: 'Sign the last page by default', body: 'Most contracts have signature lines on the final page — leave the page field blank to default to it.' },
      { title: 'Add the date too', body: 'Use <a href="/edit-pdf">Edit PDF</a> to overlay a date next to your signature.' },
      { title: 'Lock with a password', body: 'After signing, run through <a href="/protect-pdf">Protect PDF</a> for tamper-evident delivery.' },
      { title: 'Keep a signed copy', body: 'Always save the signed PDF in your records — cloud + local backup is best practice.' },
    ],
    faq: [
      { q: 'Is a typed signature legally valid?', a: 'For most everyday agreements (employment, freelance, NDAs), typed signatures are accepted under ESIGN and eIDAS laws. High-stakes contracts may require certified e-signatures.' },
      { q: 'Can I draw my signature?', a: 'Currently text-based only. Drawn signature support is on the roadmap.' },
      { q: 'Where on the page is the signature placed?', a: 'It\'s anchored near the bottom of the chosen page by default — the typical signature line location.' },
      { q: 'Can multiple people sign?', a: 'Run the tool again on the signed file to add a second signature on a different page.' },
    ],
    related: ['edit-pdf-guide', 'watermark-pdf-guide', 'protect-pdf-guide', 'add-page-numbers-guide'],
  },

  {
    slug: 'add-page-numbers-guide',
    toolSlug: '/add-page-numbers',
    toolName: 'Add Page Numbers',
    icon: 'hash',
    tag: 'Tutorial',
    category: 'Edit & Annotate',
    title: 'How to Add Page Numbers to a PDF Online Free',
    description: 'Insert page numbers into any PDF — choose position and starting number. Free, no signup, no software install.',
    intro: `<p>Long PDFs without page numbers are unnavigable. Try discussing "page 47" of a 120-page report with a colleague when neither of you knows which physical page that corresponds to. <strong>Page numbers</strong> fix that in seconds.</p>
<p>The <a href="/add-page-numbers">Add Page Numbers</a> tool stamps clean, customisable page numbers on every page. Here\'s the walkthrough.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/add-page-numbers">ilovepdf.cyou/add-page-numbers</a>.' },
      { title: 'Upload the PDF', body: 'Drop the file. Multi-page documents are required (page numbers don\'t make sense for one page!).' },
      { title: 'Pick the position', body: 'Choose from 6 positions — bottom centre/left/right or top centre/left/right.' },
      { title: 'Set the starting number', body: 'Default is 1, but you can start anywhere — useful when adding to the second part of a multi-volume document.' },
      { title: 'Process and download', body: 'The numbered PDF saves as <code>ILovePDF-page-numbers.pdf</code>.' },
    ],
    benefits: [
      { title: 'Better navigation', body: 'Recipients can jump to specific pages and refer to them in conversation.' },
      { title: 'Flexible position', body: 'Six common positions cover every standard layout, from academic to corporate.' },
      { title: 'Custom start number', body: 'Continue numbering from a previous volume by setting any starting number.' },
      { title: 'Lossless', body: 'Numbers are added as a new layer — original page content is untouched.' },
    ],
    useCases: [
      { audience: 'Authors', body: 'Add page numbers to a manuscript before sending to beta readers or print.' },
      { audience: 'Researchers', body: 'Number a thesis or dissertation that\'s being assembled from multiple chapters.' },
      { audience: 'Legal teams', body: 'Number every page of a discovery document for unambiguous reference in court.' },
    ],
    tips: [
      { title: 'Use bottom-centre for most cases', body: 'Bottom centre is the universal default for books, reports and academic papers.' },
      { title: 'Use bottom-right for spiral-bound', body: 'For documents that\'ll be spiral-bound on the left, bottom-right keeps numbers visible.' },
      { title: 'Add page numbers last', body: 'Apply numbering after merging or reordering — adding earlier means renumbering later.' },
      { title: 'Combine with watermark', body: 'For draft documents, add both page numbers and a <a href="/watermark-pdf">DRAFT watermark</a>.' },
    ],
    faq: [
      { q: 'Can I skip page numbering on certain pages?', a: 'Currently the tool numbers every page. Split off pages you want unnumbered before processing.' },
      { q: 'Can I use Roman numerals?', a: 'Arabic numerals only at the moment. Roman numeral support is planned.' },
      { q: 'Will the numbers be in colour?', a: 'Black is the default and works for every layout. Colour customisation is on the roadmap.' },
      { q: 'Does it overwrite existing page numbers?', a: 'It adds a new layer — existing numbers from the original PDF stay where they are.' },
    ],
    related: ['watermark-pdf-guide', 'edit-pdf-guide', 'organize-pdf-guide', 'merge-pdf-guide'],
  },

  {
    slug: 'redact-pdf-guide',
    toolSlug: '/redact-pdf',
    toolName: 'Redact PDF',
    icon: 'eye-off',
    tag: 'Security',
    category: 'Edit & Annotate',
    title: 'How to Redact a PDF Online Free — Black Out Sensitive Info',
    description: 'Permanently black out sensitive text, names or amounts in any PDF. Free, secure, no signup. Step-by-step redaction guide.',
    intro: `<p>Sharing a contract publicly but need to hide the dollar figures? Sending a court document where personal details must be obscured? Highlighting in your PDF reader doesn\'t cut it — anyone can remove a highlight. <strong>Redaction</strong> permanently covers content with an opaque rectangle that can\'t be unmasked.</p>
<p>The <a href="/redact-pdf">Redact PDF</a> tool stamps black rectangles over any region you specify. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/redact-pdf">ilovepdf.cyou/redact-pdf</a>.' },
      { title: 'Upload the PDF', body: 'Drop the file. The tool reads dimensions automatically.' },
      { title: 'Set redaction area', body: 'Enter X/Y position and width/height as percentages, e.g. X=10, Y=40, W=30, H=10.' },
      { title: 'Choose pages', body: 'Type a page number (e.g. <code>1</code>) or <code>all</code> to redact every page.' },
      { title: 'Process and download', body: 'The redacted PDF saves as <code>ILovePDF-redact.pdf</code>.' },
    ],
    benefits: [
      { title: 'Permanent', body: 'Redacted areas are filled with opaque rectangles — they can\'t be uncovered by reader tricks.' },
      { title: 'Per-page targeting', body: 'Redact one specific page or apply the same redaction to all pages in one pass.' },
      { title: 'Compliance-friendly', body: 'Useful for GDPR, HIPAA and litigation-discovery workflows that mandate redaction.' },
      { title: 'Non-destructive on original', body: 'Your input PDF is never modified — only the new redacted copy carries the rectangles.' },
    ],
    useCases: [
      { audience: 'Legal teams', body: 'Redact privileged information before producing a discovery PDF for opposing counsel.' },
      { audience: 'HR', body: 'Black out salary and SSN data when sharing employee records for an audit.' },
      { audience: 'Journalists', body: 'Protect source identities by redacting names and locations in leaked documents.' },
    ],
    tips: [
      { title: 'Test on a copy', body: 'Always redact on a duplicate file — never on the only copy of the original.' },
      { title: 'Use precise percentages', body: 'Measure the target area in your viewer and translate to percentage of page width/height.' },
      { title: 'Combine with OCR removal', body: 'For text-searchable PDFs, also rasterise via <a href="/pdf-to-jpg">PDF to JPG</a> then back to PDF to remove residual text.' },
      { title: 'Verify before sharing', body: 'Always open the redacted PDF in a fresh viewer and try to copy the redacted area to confirm nothing remains.' },
    ],
    faq: [
      { q: 'Can the redaction be reversed?', a: 'No. The black rectangles are rendered into the page — they can\'t be peeled away.' },
      { q: 'Does it remove the underlying text from the PDF stream?', a: 'The rectangle covers the visible content. For maximum security against text-extraction tools, also <a href="/pdf-to-jpg">rasterise the PDF</a> after redacting.' },
      { q: 'Can I use a colour other than black?', a: 'Currently black only. Colour customisation is planned.' },
      { q: 'Can I redact multiple areas at once?', a: 'One area per run. Process the file multiple times for multiple redactions.' },
    ],
    related: ['protect-pdf-guide', 'watermark-pdf-guide', 'edit-pdf-guide', 'unlock-pdf-guide'],
  },

  // ============================================================
  // SECURITY
  // ============================================================

  {
    slug: 'protect-pdf-guide',
    toolSlug: '/protect-pdf',
    toolName: 'Protect PDF',
    icon: 'lock',
    tag: 'Security',
    category: 'Security',
    title: 'How to Password-Protect a PDF Online Free — Encryption Guide',
    description: 'Encrypt a PDF with a password so only authorised viewers can open it. Free, no signup, no install. Strong industry-standard encryption.',
    intro: `<p>Email is leaky. Cloud links get forwarded. Even a stolen laptop can expose every PDF on the disk. The simplest defence for sensitive documents is a strong <strong>password</strong> embedded in the PDF itself — without the password, the file is unopenable.</p>
<p>The <a href="/protect-pdf">Protect PDF</a> tool encrypts any PDF with a password of your choice. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/protect-pdf">ilovepdf.cyou/protect-pdf</a>.' },
      { title: 'Upload the PDF', body: 'Drop the file you want to lock down.' },
      { title: 'Enter a strong password', body: 'Use 12+ characters mixing letters, numbers and symbols. Avoid dictionary words.' },
      { title: 'Process', body: 'The PDF is encrypted using PDF\'s industry-standard password mechanism.' },
      { title: 'Download', body: 'Save the protected PDF as <code>ILovePDF-protect.pdf</code>. Share it — no one can open it without the password.' },
    ],
    benefits: [
      { title: 'Privacy', body: 'Only people with the password can open the document — even if it\'s leaked.' },
      { title: 'Industry-standard', body: 'Uses PDF\'s native password encryption, supported by every major reader.' },
      { title: 'Universal', body: 'Works with Adobe Reader, Foxit, macOS Preview, Chrome PDF viewer — every reader respects PDF passwords.' },
      { title: 'No signup', body: 'Encrypt and download in under a minute, no account required.' },
    ],
    useCases: [
      { audience: 'Lawyers', body: 'Send privileged client communications with a password shared via a separate channel (phone or text).' },
      { audience: 'Finance', body: 'Email a tax return or financial statement to a client without exposing it if the email is forwarded.' },
      { audience: 'HR', body: 'Send offer letters and contracts with passwords known only to the recipient.' },
    ],
    tips: [
      { title: 'Use a strong password', body: 'At least 12 characters with mixed case, numbers and symbols. Skip names and dates.' },
      { title: 'Share password separately', body: 'Send the PDF over email but the password via SMS or phone — never both in the same message.' },
      { title: 'Consider a password manager', body: 'Use a password manager to generate and store the encryption password — never reuse passwords.' },
      { title: 'Combine with watermark', body: 'Add a <a href="/watermark-pdf">watermark</a> with the recipient\'s name to discourage forwarding.' },
    ],
    faq: [
      { q: 'How strong is the encryption?', a: 'PDFs use AES-128 or AES-256 encryption depending on the spec version. Both are extremely difficult to brute-force with a strong password.' },
      { q: 'Can I remove the password later?', a: 'Yes — use <a href="/unlock-pdf">Unlock PDF</a> if you know the password.' },
      { q: 'What if I forget the password?', a: 'There\'s no recovery mechanism — that\'s the point of encryption. Always save the password in a manager.' },
      { q: 'Does it work on every PDF reader?', a: 'Yes — every spec-compliant reader prompts for the password before opening.' },
    ],
    related: ['unlock-pdf-guide', 'redact-pdf-guide', 'watermark-pdf-guide', 'sign-pdf-guide'],
  },

  {
    slug: 'unlock-pdf-guide',
    toolSlug: '/unlock-pdf',
    toolName: 'Unlock PDF',
    icon: 'unlock',
    tag: 'Security',
    category: 'Security',
    title: 'How to Unlock a Password-Protected PDF Online Free',
    description: 'Remove the password from a PDF you own. Free Unlock PDF tool — no signup, no install, secure in-browser processing.',
    intro: `<p>Password-protected PDFs are great until you\'re the one constantly being prompted for the password. If you own the document and know the password, removing the lock saves you (and your team) repeated friction.</p>
<p>The <a href="/unlock-pdf">Unlock PDF</a> tool strips the password from a PDF you own. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/unlock-pdf">ilovepdf.cyou/unlock-pdf</a>.' },
      { title: 'Upload the locked PDF', body: 'Drop the file. The tool detects whether it\'s encrypted automatically.' },
      { title: 'Enter the password', body: 'Type the password you used when the PDF was protected.' },
      { title: 'Process', body: 'The encryption is stripped and a clean unlocked copy is generated.' },
      { title: 'Download', body: 'Save as <code>ILovePDF-unlock.pdf</code>. The new file opens without a password prompt.' },
    ],
    benefits: [
      { title: 'No more prompts', body: 'Open the PDF in any reader without typing the password every time.' },
      { title: 'Editable downstream', body: 'Once unlocked, the PDF works with merge, split, compress, and edit tools.' },
      { title: 'Browser-based', body: 'No software install or trip to Adobe Reader settings.' },
      { title: 'Bulk unlock for personal archives', body: 'Easier to manage long-term archives without remembering 50 different passwords.' },
    ],
    useCases: [
      { audience: 'Personal archives', body: 'Strip passwords from old bank statements before consolidating into a single PDF archive.' },
      { audience: 'Office automation', body: 'Unlock a recurring vendor invoice once so your accounting tooling can ingest it without password handling.' },
      { audience: 'Legal teams', body: 'Unlock client-supplied PDFs before processing through review platforms that don\'t accept encrypted files.' },
    ],
    tips: [
      { title: 'Only unlock files you own', body: 'Removing a password from someone else\'s PDF without permission may violate copyright or privacy law.' },
      { title: 'Re-encrypt before sharing', body: 'If the unlocked file leaves your device, run <a href="/protect-pdf">Protect PDF</a> with a new password.' },
      { title: 'Combine with merge', body: 'Unlock multiple files first, then run <a href="/merge-pdf">Merge PDF</a> on the unlocked copies.' },
      { title: 'Save the original locked copy', body: 'Keep the encrypted version archived in case you need to re-share with the original protection.' },
    ],
    faq: [
      { q: 'Do I need to know the password?', a: 'Yes. The tool requires the correct password — it doesn\'t crack or guess unknown passwords.' },
      { q: 'Is it legal to unlock a PDF?', a: 'Yes, if you own the document or have explicit permission. Removing protection from copyrighted PDFs without permission may violate law.' },
      { q: 'What happens to the original file?', a: 'It\'s untouched — the unlocked copy is a fresh file.' },
      { q: 'Does it work for all encryption types?', a: 'Standard PDF password encryption is supported. Specialised DRM systems are not.' },
    ],
    related: ['protect-pdf-guide', 'merge-pdf-guide', 'edit-pdf-guide', 'compress-pdf-guide'],
  },

  // ============================================================
  // ADVANCED TOOLS
  // ============================================================

  {
    slug: 'repair-pdf-guide',
    toolSlug: '/repair-pdf',
    toolName: 'Repair PDF',
    icon: 'wrench',
    tag: 'Utility',
    category: 'Advanced Tools',
    title: 'How to Repair a Corrupted PDF Online Free',
    description: 'Recover content from a damaged or unreadable PDF file. Free Repair PDF tool — no signup, no install, fast in-browser processing.',
    intro: `<p>That sinking moment when an important PDF refuses to open — "format error", "damaged file", a blank screen — usually means file corruption from a partial download, an old hard drive, or a buggy export. Sometimes the file is recoverable.</p>
<p>The <a href="/repair-pdf">Repair PDF</a> tool tries to rebuild the internal structure of a damaged PDF and recover as much content as possible. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/repair-pdf">ilovepdf.cyou/repair-pdf</a>.' },
      { title: 'Upload the broken PDF', body: 'Drop the file. The tool inspects the structure and identifies recoverable parts.' },
      { title: 'Process', body: 'A repair pass rebuilds the PDF\'s internal cross-reference table and re-links surviving objects.' },
      { title: 'Download', body: 'Save the repaired file as <code>ILovePDF-repair.pdf</code>.' },
      { title: 'Verify in a viewer', body: 'Open in your normal PDF reader to see how much was recovered. Some content may still be missing if corruption was severe.' },
    ],
    benefits: [
      { title: 'Recover the unreadable', body: 'Get content back from PDFs your reader refuses to open.' },
      { title: 'No data sent to third-parties', body: 'Files are processed and deleted within minutes, never stored long-term.' },
      { title: 'Free, immediate', body: 'No signup or wait queue — repair attempt completes in seconds.' },
      { title: 'Works on most corruption types', body: 'Effective for cross-reference table issues, truncated downloads and minor structural damage.' },
    ],
    useCases: [
      { audience: 'IT support', body: 'First line of triage when a colleague reports a "file won\'t open" — try a repair before escalating.' },
      { audience: 'Backup recovery', body: 'Recover PDFs from old hard drives where some sectors have started to fail.' },
      { audience: 'Email attachments', body: 'Fix PDFs that arrived truncated due to email gateway interference.' },
    ],
    tips: [
      { title: 'Save backup copies regularly', body: 'Recovery is best-effort — the only sure protection is regular backups.' },
      { title: 'Re-download if possible', body: 'If the original PDF lives online, re-downloading may be faster than repair.' },
      { title: 'Try in different readers', body: 'Some readers (Adobe Reader, Foxit, Chrome) tolerate damage better than others — try a few before declaring the file broken.' },
      { title: 'Compress the repaired file', body: 'Repaired files can have orphan objects; <a href="/compress-pdf">Compress PDF</a> cleans them up.' },
    ],
    faq: [
      { q: 'Can it recover any damaged PDF?', a: 'It works on most cases of structural corruption. PDFs with missing or overwritten content data may not be fully recoverable.' },
      { q: 'Will all content come back?', a: 'Often yes for minor damage. Severe corruption may lose specific pages or images.' },
      { q: 'Is it safe to use?', a: 'Yes — files are processed in memory and deleted within minutes.' },
      { q: 'What if it can\'t repair the file?', a: 'Try downloading the original again, opening in a different PDF reader, or use OCR on a printed copy as last resort.' },
    ],
    related: ['compress-pdf-guide', 'ocr-pdf-guide', 'merge-pdf-guide', 'best-pdf-tools'],
  },

  {
    slug: 'scan-pdf-guide',
    toolSlug: '/scan-pdf',
    toolName: 'Scan to PDF',
    icon: 'scan-line',
    tag: 'Tutorial',
    category: 'Advanced Tools',
    title: 'How to Scan to PDF Online — Convert Image Scans to PDF',
    description: 'Turn phone photos or scanner images into a clean searchable PDF document. Free, fast, no signup. Step-by-step scan-to-PDF guide.',
    intro: `<p>Your phone camera is a perfectly good scanner — for receipts, contracts, sticky notes, whiteboards, anything. But sharing 12 individual JPG photos is annoying. Combining them into a single, properly-oriented PDF is the right format for archiving and sharing.</p>
<p>The <a href="/scan-pdf">Scan to PDF</a> tool converts a batch of scanned images (.jpg, .jpeg, .png) into a single PDF. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/scan-pdf">ilovepdf.cyou/scan-pdf</a>.' },
      { title: 'Upload your scan images', body: 'Drag and drop multiple .jpg/.png files. They become PDF pages in upload order.' },
      { title: 'Reorder pages', body: 'Drag the thumbnails into the right sequence before processing.' },
      { title: 'Process', body: 'Each image becomes a single PDF page at original resolution.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-scan-to-pdf.pdf</code>.' },
    ],
    benefits: [
      { title: 'Phone-friendly', body: 'Take photos with your phone, upload them in the browser, get a tidy PDF.' },
      { title: 'Single shareable file', body: 'Email or upload one PDF instead of attaching 10 separate images.' },
      { title: 'Print-friendly', body: 'PDFs print correctly with clear page breaks; loose JPGs don\'t.' },
      { title: 'Searchable later', body: 'Combine with <a href="/ocr-pdf">OCR PDF</a> to make scan PDFs full-text searchable.' },
    ],
    useCases: [
      { audience: 'Expense reports', body: 'Photograph 8 restaurant receipts on a business trip and combine into one PDF for HR.' },
      { audience: 'Real estate', body: 'Scan signed contracts and addendums on the go without going to the office.' },
      { audience: 'Students', body: 'Photograph whiteboard notes from a lecture and turn them into a study PDF.' },
    ],
    tips: [
      { title: 'Use natural light', body: 'Phone "scans" turn out best in even, bright lighting. Avoid harsh shadows.' },
      { title: 'Crop and rotate first', body: 'Use <a href="/crop-image">Crop Image</a> and <a href="/rotate-pdf">Rotate PDF</a> as needed for clean output.' },
      { title: 'OCR for searchable text', body: 'Run the result through <a href="/ocr-pdf">OCR PDF</a> to add a searchable text layer.' },
      { title: 'Compress before emailing', body: 'High-res phone photos make heavy PDFs. Run through <a href="/compress-pdf">Compress PDF</a>.' },
    ],
    faq: [
      { q: 'How many images can I scan?', a: 'No hard cap on count. Each image just needs to be under 100 MB.' },
      { q: 'Can I make the PDF text-searchable?', a: 'Yes — run the resulting PDF through <a href="/ocr-pdf">OCR PDF</a> to extract text.' },
      { q: 'What image formats are supported?', a: 'JPG, JPEG and PNG. HEIC photos should be converted to JPG first.' },
      { q: 'Will quality be lost?', a: 'No. Images are embedded at their original resolution into the PDF.' },
    ],
    related: ['ocr-pdf-guide', 'jpg-to-pdf-guide', 'compress-pdf-guide', 'rotate-pdf-guide'],
  },

  {
    slug: 'ocr-pdf-guide',
    toolSlug: '/ocr-pdf',
    toolName: 'OCR PDF',
    icon: 'type',
    tag: 'AI',
    category: 'Advanced Tools',
    title: 'How to OCR a PDF Online Free — Make Scanned PDFs Searchable',
    description: 'Run OCR on any scanned PDF to extract searchable, copyable text. Free AI-powered OCR — no signup, no install, no watermark.',
    intro: `<p>A scanned PDF is just a stack of images — you can\'t search inside it, copy text from it, or get a screen reader to read it aloud. <strong>OCR (Optical Character Recognition)</strong> fixes that by recognising the printed text in those images and adding a searchable text layer to the PDF.</p>
<p>The <a href="/ocr-pdf">OCR PDF</a> tool extracts text from any scanned PDF in seconds. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/ocr-pdf">ilovepdf.cyou/ocr-pdf</a>.' },
      { title: 'Upload the scanned PDF', body: 'Drop your image-based PDF. The tool detects whether OCR is needed automatically.' },
      { title: 'Process', body: 'Each page is analysed and text is extracted using OCR.' },
      { title: 'Download', body: 'The result saves as <code>ILovePDF-ocr.pdf</code> — a searchable PDF with the extracted text.' },
      { title: 'Search and copy', body: 'Open the OCR\'d PDF in any reader and use <kbd>Ctrl+F</kbd> to search for text.' },
    ],
    benefits: [
      { title: 'Searchable scans', body: 'Find any word in a 200-page scan instantly with a single text search.' },
      { title: 'Copy-paste enabled', body: 'Select and copy text directly from a previously image-only PDF.' },
      { title: 'Accessibility', body: 'Screen readers can finally narrate scanned documents for visually impaired users.' },
      { title: 'Powers other tools', body: 'OCR\'d PDFs work better with <a href="/translate-pdf">Translate</a>, <a href="/ai-summarizer">AI Summarizer</a> and <a href="/pdf-to-word">PDF to Word</a>.' },
    ],
    useCases: [
      { audience: 'Researchers', body: 'OCR a stack of scanned journal articles so you can search them by keyword.' },
      { audience: 'Legal discovery', body: 'Make decades-old scanned contracts text-searchable for litigation review.' },
      { audience: 'Personal archives', body: 'OCR family documents, recipes, or letters so they\'re findable in cloud storage.' },
    ],
    tips: [
      { title: 'Higher scan resolution = better OCR', body: '300 DPI scans typically OCR more accurately than 150 DPI scans.' },
      { title: 'Rotate first if needed', body: 'OCR works best on upright pages. Use <a href="/rotate-pdf">Rotate PDF</a> first if any pages are sideways.' },
      { title: 'Crop borders', body: 'Use <a href="/crop-pdf">Crop PDF</a> to trim scan margins before OCR for cleaner text extraction.' },
      { title: 'Combine with AI Summarizer', body: 'After OCR, run <a href="/ai-summarizer">AI Summarizer</a> to extract key points from the recovered text.' },
    ],
    faq: [
      { q: 'How accurate is the OCR?', a: 'Typically 95%+ on clean scans of standard fonts. Handwriting and stylised fonts may have lower accuracy.' },
      { q: 'What languages are supported?', a: 'English is the default. Multi-language support is on the roadmap.' },
      { q: 'Will it modify my original PDF?', a: 'No. The OCR\'d copy is a new file with an added text layer.' },
      { q: 'Is the text 100% editable?', a: 'OCR adds an invisible text layer over images — for full editing convert to Word with <a href="/pdf-to-word">PDF to Word</a>.' },
    ],
    related: ['scan-pdf-guide', 'pdf-to-word-guide', 'ai-summarizer-guide', 'translate-pdf-guide'],
  },

  {
    slug: 'compare-pdf-guide',
    toolSlug: '/compare-pdf',
    toolName: 'Compare PDF',
    icon: 'columns',
    tag: 'Utility',
    category: 'Advanced Tools',
    title: 'How to Compare Two PDFs Online — Find Differences Free',
    description: 'Compare two PDF files side-by-side and highlight differences. Free, fast, no signup. Perfect for contract revisions and document audits.',
    intro: `<p>Two contracts that look identical at a glance often differ in a single critical clause. Eyeballing a 40-page document for changes is error-prone — automated <strong>PDF comparison</strong> catches every difference in seconds.</p>
<p>The <a href="/compare-pdf">Compare PDF</a> tool diffs two PDFs and highlights what changed. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/compare-pdf">ilovepdf.cyou/compare-pdf</a>.' },
      { title: 'Upload both PDFs', body: 'Drop the original and the revised version. Order matters — the first is treated as the baseline.' },
      { title: 'Process', body: 'The tool extracts text from both files and identifies differences page by page.' },
      { title: 'Review the diff', body: 'Download the comparison report — additions, deletions, and changes are clearly marked.' },
      { title: 'Act on the changes', body: 'Use the report to validate revisions, approve changes, or push back on unwanted edits.' },
    ],
    benefits: [
      { title: 'Catch every change', body: 'Surfaces additions, deletions and modifications across the full document.' },
      { title: 'Faster than manual review', body: 'Compares 100 pages in seconds — vs hours of human reading.' },
      { title: 'Audit trail', body: 'The diff report becomes a permanent record of what changed between versions.' },
      { title: 'Works on any text PDF', body: 'For scanned PDFs, run <a href="/ocr-pdf">OCR PDF</a> on both first.' },
    ],
    useCases: [
      { audience: 'Legal teams', body: 'Confirm that a counterparty\'s "minor revision" of a contract really is minor before signing.' },
      { audience: 'Editors', body: 'Compare two versions of a manuscript to track which sections an author has rewritten.' },
      { audience: 'Compliance', body: 'Audit policy revisions across versions to confirm only approved changes were made.' },
    ],
    tips: [
      { title: 'OCR scanned PDFs first', body: 'Comparison works on text content. Image-only PDFs need <a href="/ocr-pdf">OCR PDF</a> first.' },
      { title: 'Compare same-format files', body: 'Two PDFs exported from the same source compare more cleanly than mixed origins.' },
      { title: 'Combine with merge for archive', body: 'Save both versions plus the diff report into one archive PDF using <a href="/merge-pdf">Merge PDF</a>.' },
      { title: 'Re-export if format mismatch', body: 'If one PDF is a scan and one is digital, normalise both first for fair comparison.' },
    ],
    faq: [
      { q: 'Does it compare images?', a: 'The current version focuses on text comparison. Image-level diff is on the roadmap.' },
      { q: 'How are differences shown?', a: 'A summary report lists additions, deletions and changes per page.' },
      { q: 'Can I compare more than two PDFs?', a: 'One pair at a time. For three-way comparison, run two pair comparisons sequentially.' },
      { q: 'Does it work on scanned PDFs?', a: 'OCR them first using <a href="/ocr-pdf">OCR PDF</a> so the tool has text to compare.' },
    ],
    related: ['ocr-pdf-guide', 'merge-pdf-guide', 'pdf-to-word-guide', 'translate-pdf-guide'],
  },

  {
    slug: 'ai-summarizer-guide',
    toolSlug: '/ai-summarizer',
    toolName: 'AI Summarizer',
    icon: 'sparkles',
    tag: 'AI',
    category: 'Advanced Tools',
    title: 'How to Summarize a PDF with AI — Free Online Summary Tool',
    description: 'Turn a 100-page PDF into a clear executive summary in seconds with AI. Free, no signup, no install — choose your summary length.',
    intro: `<p>Reading a 100-page report cover-to-cover is rarely the best use of your time. The 21st-century alternative: feed the PDF to an <strong>AI summariser</strong> that reads it for you and surfaces the key points in seconds.</p>
<p>The <a href="/ai-summarizer">AI Summarizer</a> extracts the most important sentences from any text PDF, customisable to the length of summary you want.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/ai-summarizer">ilovepdf.cyou/ai-summarizer</a>.' },
      { title: 'Upload your PDF', body: 'Drop the document. The tool reads the text content automatically.' },
      { title: 'Pick summary length', body: 'Set the number of key sentences (default 7). Use 3 for an ultra-brief summary, 15 for a richer one.' },
      { title: 'Process', body: 'AI scores every sentence by importance and selects the top N for the summary.' },
      { title: 'Download or copy', body: 'The summary is shown on screen and downloadable as a plain text file.' },
    ],
    benefits: [
      { title: 'Save hours', body: 'Get the gist of a long PDF in 10 seconds — perfect for triage before deciding what to read deeply.' },
      { title: 'Customisable length', body: 'Pick anywhere from 3 to 30+ sentences depending on how much depth you need.' },
      { title: 'Works on any PDF', body: 'Reports, research papers, contracts, books — anything with extractable text.' },
      { title: 'Privacy-friendly', body: 'Files are processed and deleted in minutes — your documents aren\'t stored or trained on.' },
    ],
    useCases: [
      { audience: 'Executives', body: 'Skim 50-page board packs as 5-sentence summaries before the meeting.' },
      { audience: 'Researchers', body: 'Triage 30 candidate papers by summary before deciding which 5 to read in full.' },
      { audience: 'Lawyers', body: 'Get a fast snapshot of unfamiliar opposing-side documents during early case review.' },
    ],
    tips: [
      { title: 'OCR scans first', body: 'Summarisation works on text. For image-only PDFs, run <a href="/ocr-pdf">OCR PDF</a> first.' },
      { title: 'Adjust length to need', body: 'Use 3–5 for quick triage, 10–15 for executive summaries, 20+ for detailed digests.' },
      { title: 'Combine with translation', body: 'Summarise first, then <a href="/translate-pdf">translate</a> the shorter summary if needed.' },
      { title: 'Verify critical points', body: 'For high-stakes decisions, always verify the summary against the original — AI is a triage aid, not a replacement.' },
    ],
    faq: [
      { q: 'Is the AI training on my files?', a: 'No. Files are processed in memory and deleted within minutes. We don\'t retain or train on your content.' },
      { q: 'Does it work on long PDFs?', a: 'Yes — long documents are sectioned and summarised efficiently.' },
      { q: 'What if my PDF is scanned?', a: 'Run <a href="/ocr-pdf">OCR PDF</a> first to extract text, then summarise.' },
      { q: 'How accurate is the summary?', a: 'AI extracts the highest-scoring sentences from the original text, so accuracy reflects the source. It works best on well-structured prose.' },
    ],
    related: ['ocr-pdf-guide', 'translate-pdf-guide', 'pdf-to-word-guide', 'compare-pdf-guide'],
  },

  {
    slug: 'translate-pdf-guide',
    toolSlug: '/translate-pdf',
    toolName: 'Translate PDF',
    icon: 'languages',
    tag: 'AI',
    category: 'Advanced Tools',
    title: 'How to Translate a PDF Online — Free AI Translation Tool',
    description: 'Translate PDFs into Spanish, French, German, Chinese, Japanese and more. Free AI translator — no signup, fast, accurate.',
    intro: `<p>You receive an important PDF in a language you don\'t speak. Maybe it\'s a contract from an overseas supplier, a research paper in another language, or a manual for a product you bought abroad. Manual translation is slow and expensive — <strong>AI translation</strong> handles it in seconds.</p>
<p>The <a href="/translate-pdf">Translate PDF</a> tool converts the text content of any PDF into 12+ supported languages.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/translate-pdf">ilovepdf.cyou/translate-pdf</a>.' },
      { title: 'Upload your PDF', body: 'Drop the document you need translated.' },
      { title: 'Pick the target language', body: 'Choose from Spanish, French, German, Italian, Portuguese, Dutch, Russian, Chinese, Japanese, Arabic, Hindi or Korean.' },
      { title: 'Process', body: 'The tool extracts text from the PDF and translates it page by page.' },
      { title: 'Download', body: 'Save the translated output. Use <a href="/word-to-pdf">Word to PDF</a> later if you want to re-style the result.' },
    ],
    benefits: [
      { title: '12+ languages', body: 'Spanish, French, German, Italian, Portuguese, Dutch, Russian, Chinese, Japanese, Arabic, Hindi, Korean.' },
      { title: 'Fast turnaround', body: 'Most documents translate in under a minute — no need to wait days for a human translator.' },
      { title: 'Free', body: 'No per-page or per-word charges. Translate as many PDFs as you need.' },
      { title: 'Privacy-friendly', body: 'Files are deleted within minutes — never stored or used to train models.' },
    ],
    useCases: [
      { audience: 'International business', body: 'Translate vendor contracts and supplier docs from Chinese or German to English in seconds.' },
      { audience: 'Researchers', body: 'Read non-English research papers without waiting for a journal\'s official translation.' },
      { audience: 'Travel & immigration', body: 'Translate forms, leases or property documents when relocating to a new country.' },
    ],
    tips: [
      { title: 'OCR scanned PDFs first', body: 'Image-only PDFs need <a href="/ocr-pdf">OCR PDF</a> first to extract text for translation.' },
      { title: 'Verify critical content', body: 'For legal or medical documents, always have a human reviewer verify AI output.' },
      { title: 'Translate, then summarise', body: 'For long documents, translate first then run <a href="/ai-summarizer">AI Summarizer</a> on the result.' },
      { title: 'Re-export to PDF', body: 'After translation, use <a href="/word-to-pdf">Word to PDF</a> to lock the result back into PDF form.' },
    ],
    faq: [
      { q: 'How accurate is AI translation?', a: 'Modern AI translation is excellent for most languages and contexts. Idiomatic and legal text may need human review.' },
      { q: 'Does it preserve formatting?', a: 'Text content is translated; layout may shift slightly because translated text rarely matches original length.' },
      { q: 'Can I translate scanned PDFs?', a: 'Run them through <a href="/ocr-pdf">OCR PDF</a> first to extract text, then translate.' },
      { q: 'Is the original PDF altered?', a: 'No — your input file is never modified. Translation produces a separate output.' },
    ],
    related: ['ai-summarizer-guide', 'ocr-pdf-guide', 'pdf-to-word-guide', 'compare-pdf-guide'],
  },

  {
    slug: 'workflow-builder-guide',
    toolSlug: '/workflow-builder',
    toolName: 'Workflow Builder',
    icon: 'git-branch',
    tag: 'Utility',
    category: 'Advanced Tools',
    title: 'PDF Workflow Builder — Chain Multiple Operations in One Pass',
    description: 'Compress, watermark and add page numbers to a PDF in a single click. Free Workflow Builder — chain up to 3 PDF operations.',
    intro: `<p>Most PDF prep involves the same sequence of steps every time — compress, watermark, add page numbers, then send. Doing them one at a time means uploading and downloading the same file three or four times. The <strong>Workflow Builder</strong> chains those operations into a single one-click pipeline.</p>
<p>The <a href="/workflow-builder">Workflow Builder</a> tool lets you stack up to three operations on one upload. Here\'s how.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/workflow-builder">ilovepdf.cyou/workflow-builder</a>.' },
      { title: 'Upload your PDF', body: 'Drop the file you want to process through multiple operations.' },
      { title: 'Pick Step 1', body: 'Choose from Compress, Rotate (90/180), Watermark, Add Page Numbers, or Sign. Provide a text value for Watermark/Sign.' },
      { title: 'Optionally pick Steps 2 and 3', body: 'Stack up to two more operations to run in order on the same file.' },
      { title: 'Process and download', body: 'The tool runs all three steps on the upload in sequence and gives you the final PDF.' },
    ],
    benefits: [
      { title: 'One upload, many operations', body: 'Save time and bandwidth by processing once instead of three times.' },
      { title: 'Predictable order', body: 'Operations always run in the order you specify, top to bottom.' },
      { title: 'Repeatable', body: 'Build the same workflow each time you have a similar batch of files.' },
      { title: 'Free', body: 'No paywall or "premium tier" — chain operations on every file you upload.' },
    ],
    useCases: [
      { audience: 'Marketing', body: 'Compress, watermark with brand name, then add page numbers to every brochure before publishing.' },
      { audience: 'Finance', body: 'Compress, sign, then password-protect monthly reports in one pass.' },
      { audience: 'Project management', body: 'Watermark "DRAFT", add page numbers, then compress before circulating revised plans.' },
    ],
    tips: [
      { title: 'Order matters', body: 'Compress last to ensure the smallest file size — earlier operations might add overhead.' },
      { title: 'Test each step alone first', body: 'Verify each operation works on the file individually before chaining.' },
      { title: 'Save the original', body: 'Workflows are destructive across multiple steps. Always keep an unmodified copy of the source file.' },
      { title: 'Combine with merge', body: 'Run the workflow on the merged output of <a href="/merge-pdf">Merge PDF</a> for batch processing.' },
    ],
    faq: [
      { q: 'How many steps can I chain?', a: 'Up to 3 operations per workflow run.' },
      { q: 'Can I save a workflow as a preset?', a: 'Saved presets are on the roadmap. For now, set it up each time.' },
      { q: 'Does each step run on the output of the previous?', a: 'Yes — operations are sequential, with each step receiving the previous step\'s output.' },
      { q: 'Can I run different operations than the listed ones?', a: 'Currently the listed five — Compress, Rotate, Watermark, Page Numbers, Sign. More operations are planned.' },
    ],
    related: ['compress-pdf-guide', 'watermark-pdf-guide', 'add-page-numbers-guide', 'sign-pdf-guide'],
  },

  // ============================================================
  // UTILITIES (Numbers to Words, Currency Converter)
  // ============================================================

  {
    slug: 'numbers-to-words-guide',
    toolSlug: '/numbers-to-words',
    toolName: 'Numbers to Words',
    icon: 'hash',
    tag: 'Utility',
    category: 'Advanced Tools',
    title: 'Numbers to Words Converter — Free Online Number Spelling',
    description: 'Convert any number into written words or currency text instantly. Perfect for cheques, contracts, and invoices. Free, no signup.',
    intro: `<p>Writing a cheque, drafting a contract, or filling out a legal form often requires numbers spelled out as words — "<strong>One Thousand Two Hundred Fifty Dollars and 00/100</strong>" instead of "$1,250.00". Doing this by hand is slow and error-prone, especially for large amounts.</p>
<p>The <a href="/numbers-to-words">Numbers to Words</a> tool converts any number into words instantly, with options for case style and currency formatting.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/numbers-to-words">ilovepdf.cyou/numbers-to-words</a>.' },
      { title: 'Enter your number', body: 'Type the number — integer or decimal, e.g. <code>12345.67</code>.' },
      { title: 'Choose Words or Currency', body: 'Words gives you "twelve thousand three hundred forty-five point six seven". Currency gives you "Twelve Thousand Three Hundred Forty-Five Dollars and 67/100".' },
      { title: 'Pick a case', body: 'Lowercase, uppercase, title case or sentence case — to match the formatting of your document.' },
      { title: 'Copy and paste', body: 'Hit Convert, then copy the result straight into your cheque, contract or invoice.' },
    ],
    benefits: [
      { title: 'Error-free', body: 'No more manual spelling mistakes when writing out large amounts on legal documents.' },
      { title: 'Currency-ready', body: 'The Currency mode matches the format expected on cheques and formal contracts.' },
      { title: 'Multiple cases', body: 'Lowercase, uppercase, title case, sentence case — match your document\'s style.' },
      { title: 'Instant', body: 'Converts in real-time as you type. No upload, no processing wait.' },
    ],
    useCases: [
      { audience: 'Personal finance', body: 'Write cheques or money orders without second-guessing how to spell large amounts.' },
      { audience: 'Legal contracts', body: 'Spell out figures in contracts so the written and numeric forms match perfectly.' },
      { audience: 'Invoicing', body: 'Add the words version of an invoice total for international clients or formal requirements.' },
    ],
    tips: [
      { title: 'Use Currency mode for cheques', body: 'Currency mode formats the result as "<strong>Amount Dollars and XX/100</strong>" — exactly what banks expect.' },
      { title: 'Title Case for formal docs', body: 'Title case looks most professional in formal contract language.' },
      { title: 'Verify large amounts twice', body: 'For very large numbers, sanity-check the digit count before relying on the words form.' },
      { title: 'Combine with Excel to PDF', body: 'For batch invoice generation, build numbers in Excel then export with <a href="/excel-to-pdf">Excel to PDF</a>.' },
    ],
    faq: [
      { q: 'What\'s the largest number supported?', a: 'Numbers up to trillions are supported. Decimals work too.' },
      { q: 'Can I use other currencies?', a: 'The default is Dollars. Generic Words mode works for any currency context.' },
      { q: 'Does it work for negative numbers?', a: 'Yes — negatives are prefixed with "negative" or "minus" as appropriate.' },
      { q: 'Is there an API?', a: 'Currently a UI tool only. API access is on the roadmap for businesses needing batch conversions.' },
    ],
    related: ['currency-converter-guide', 'pdf-to-excel-guide', 'excel-to-pdf-guide', 'best-pdf-tools'],
  },

  {
    slug: 'currency-converter-guide',
    toolSlug: '/currency-converter',
    toolName: 'Currency Converter',
    icon: 'dollar-sign',
    tag: 'Utility',
    category: 'Advanced Tools',
    title: 'Free Online Currency Converter — Live Rates for 160+ Currencies',
    description: 'Convert between 160+ world currencies using live exchange rates. Free, fast, no signup or registration required.',
    intro: `<p>Travelling abroad, paying an international invoice, or pricing a product for a foreign market? You need fast, accurate <strong>currency conversion</strong> — and ideally, live exchange rates rather than figures from last month.</p>
<p>The <a href="/currency-converter">Currency Converter</a> tool gives you instant conversion across 160+ world currencies using up-to-date rates.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/currency-converter">ilovepdf.cyou/currency-converter</a>.' },
      { title: 'Enter the amount', body: 'Type the source amount — defaults to 1 if you just want to see the rate.' },
      { title: 'Pick the From currency', body: 'Choose your source currency from the dropdown — every major and most minor currencies are listed.' },
      { title: 'Pick the To currency', body: 'Choose your target currency for conversion.' },
      { title: 'Read the result', body: 'The converted amount displays instantly along with the current exchange rate.' },
    ],
    benefits: [
      { title: '160+ currencies', body: 'From USD/EUR/GBP to less common currencies — comprehensive global coverage.' },
      { title: 'Live rates', body: 'Exchange rates are kept current so conversions reflect today\'s market.' },
      { title: 'Instant', body: 'Conversion happens in real-time as you type — no submit button needed.' },
      { title: 'Free', body: 'No subscription, no rate-limit, no signup. Convert as often as you need.' },
    ],
    useCases: [
      { audience: 'Travellers', body: 'Sanity-check restaurant bills, taxi fares and hotel room rates while abroad.' },
      { audience: 'Online shoppers', body: 'Convert prices on international websites before deciding whether the deal is genuinely good.' },
      { audience: 'Freelancers', body: 'Quote international clients in their currency, then convert what you\'ll receive in yours.' },
    ],
    tips: [
      { title: 'Use mid-market rates as benchmark', body: 'Live rates are mid-market — banks and cards usually charge a margin on top.' },
      { title: 'Save common pairs in a spreadsheet', body: 'For frequent invoicing, log monthly average rates in Excel and export with <a href="/excel-to-pdf">Excel to PDF</a>.' },
      { title: 'Combine with Numbers to Words', body: 'For formal invoices, run the converted amount through <a href="/numbers-to-words">Numbers to Words</a>.' },
      { title: 'Re-check before payments', body: 'Rates fluctuate by the second — re-check immediately before authorising a large transfer.' },
    ],
    faq: [
      { q: 'How fresh are the rates?', a: 'Rates are pulled from public market sources and refreshed regularly throughout the day.' },
      { q: 'Are these the rates I\'ll get from my bank?', a: 'No. Banks and cards typically apply a margin (1–4%) on top of mid-market rates. The tool shows mid-market figures.' },
      { q: 'Does it support cryptocurrencies?', a: 'Currently fiat currencies only. Crypto support is on the roadmap.' },
      { q: 'Can I see historical rates?', a: 'The tool shows current rates only. Historical rate history is planned.' },
    ],
    related: ['numbers-to-words-guide', 'excel-to-pdf-guide', 'pdf-to-excel-guide', 'best-pdf-tools'],
  },

  // ============================================================
  // IMAGE TOOLS
  // ============================================================

  {
    slug: 'background-remover-guide',
    toolSlug: '/background-remover',
    toolName: 'Background Remover',
    icon: 'image-minus',
    tag: 'Image Tools',
    category: 'Image Tools',
    title: 'Remove Image Backgrounds Online Free — Background Remover Guide',
    description: 'Get a clean, transparent background on any product photo, portrait or logo in seconds. Free AI background remover — no signup.',
    intro: `<p>You\'ve got a product photo, a profile portrait, or a logo screenshot — and the background is wrong. Maybe it\'s a busy room, a watermark, or just plain white when you need transparent. Manually erasing backgrounds in Photoshop is tedious and the results are inconsistent.</p>
<p>The <a href="/background-remover">Background Remover</a> tool strips backgrounds from images automatically using AI. Here\'s how to use it.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/background-remover">ilovepdf.cyou/background-remover</a>.' },
      { title: 'Upload your image', body: 'Drag and drop a .jpg, .jpeg, .png or .webp file.' },
      { title: 'Adjust threshold (optional)', body: 'For white-background images, increase the threshold to be stricter (default 240). Use lower values to remove darker backgrounds.' },
      { title: 'Process', body: 'The tool detects the background and replaces it with transparency.' },
      { title: 'Download', body: 'Save the result as <code>ILovePDF-background-remover.png</code> with a transparent background.' },
    ],
    benefits: [
      { title: 'Instant transparency', body: 'No selection brushes, no layer masking — clean transparent PNG in 5 seconds.' },
      { title: 'Threshold control', body: 'Adjust strictness for white, near-white, or coloured backgrounds.' },
      { title: 'High quality', body: 'Smooth edges around hair and complex shapes thanks to AI segmentation.' },
      { title: 'Free, no signup', body: 'Process images instantly without an account or trial limits.' },
    ],
    useCases: [
      { audience: 'E-commerce', body: 'Remove studio backgrounds from product photos for a uniform white-bg or transparent-bg catalog.' },
      { audience: 'Designers', body: 'Strip backgrounds from stock photos before placing them in compositions.' },
      { audience: 'LinkedIn profiles', body: 'Get a clean transparent or solid-color background for headshots.' },
    ],
    tips: [
      { title: 'Use high-contrast images', body: 'Images where the subject contrasts clearly with the background work best.' },
      { title: 'Tweak the threshold', body: 'Default 240 works for white backgrounds. Lower (200–220) handles light grey or off-white.' },
      { title: 'Use PNG, not JPG', body: 'Save the output as PNG to preserve transparency. JPG flattens transparency to white.' },
      { title: 'Compose with other images', body: 'Use the transparent PNG in <a href="/jpg-to-pdf">JPG to PDF</a> or any layout tool.' },
    ],
    faq: [
      { q: 'Will it work on photos with hair or fur?', a: 'AI segmentation handles complex edges much better than hard threshold tools.' },
      { q: 'What output format do I get?', a: 'PNG with transparency — the only common format that supports it.' },
      { q: 'Can I adjust the threshold?', a: 'Yes — the threshold (180–255) controls how strict the background detection is.' },
      { q: 'Is the original image kept?', a: 'No — only the processed transparent version is generated. Keep your source image as a backup.' },
    ],
    related: ['crop-image-guide', 'resize-image-guide', 'image-filters-guide', 'jpg-to-pdf-guide'],
  },

  {
    slug: 'crop-image-guide',
    toolSlug: '/crop-image',
    toolName: 'Crop Image',
    icon: 'crop',
    tag: 'Image Tools',
    category: 'Image Tools',
    title: 'How to Crop an Image Online Free — Precise Image Cropping',
    description: 'Crop any image to exact percentage offsets. Perfect for social media, profile photos and product shots. Free, no signup.',
    intro: `<p>Cropping an image used to mean opening Photoshop, or fighting with phone gallery sliders. The <strong>Crop Image</strong> tool lets you crop to precise percentage values straight from your browser — no software, no signup.</p>
<p>Use it for cropping product photos, profile pictures, social-media banners, or anything else where exact dimensions matter.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/crop-image">ilovepdf.cyou/crop-image</a>.' },
      { title: 'Upload your image', body: 'Drag and drop a .jpg, .jpeg, .png or .webp file.' },
      { title: 'Set crop offsets', body: 'Enter X offset, Y offset, width and height as percentages of the original image.' },
      { title: 'Process', body: 'The tool slices out the requested region.' },
      { title: 'Download', body: 'Save the cropped image as <code>ILovePDF-crop-image.png</code>.' },
    ],
    benefits: [
      { title: 'Pixel precision', body: 'Percentage-based cropping is portable across image sizes and resolutions.' },
      { title: 'Lossless', body: 'Cropping doesn\'t recompress — the kept region retains original quality.' },
      { title: 'Browser-based', body: 'Works on phone, tablet or laptop without installing software.' },
      { title: 'Free', body: 'No watermark, no signup, unlimited crops.' },
    ],
    useCases: [
      { audience: 'Social media', body: 'Crop a portrait to 1:1 for Instagram or 9:16 for Stories without thinking in pixel coordinates.' },
      { audience: 'E-commerce', body: 'Tighten product shots to remove distracting backgrounds before adding to your store.' },
      { audience: 'Profile photos', body: 'Crop a headshot to a perfect square for LinkedIn, Twitter or company directory.' },
    ],
    tips: [
      { title: 'Use 100% width and height for centring', body: 'Set width=100 and height=100 with X/Y offsets to use the full canvas as a starting point.' },
      { title: 'Combine with resize', body: 'After cropping, run through <a href="/resize-image">Image Resize</a> for exact pixel dimensions.' },
      { title: 'Remove background after', body: 'For product photos, follow with <a href="/background-remover">Background Remover</a> for a clean transparent result.' },
      { title: 'Apply filters last', body: '<a href="/image-filters">Image Filters</a> work best on the final cropped composition.' },
    ],
    faq: [
      { q: 'Will it preserve image quality?', a: 'Yes. Cropping is lossless — the kept region matches the original pixel-for-pixel.' },
      { q: 'Can I crop multiple images?', a: 'One image per run. Repeat for batch cropping.' },
      { q: 'Does it work for very large images?', a: 'Yes, up to the 100 MB upload limit.' },
      { q: 'Can I undo a crop?', a: 'Cropping outputs a new file — the original is preserved on your device.' },
    ],
    related: ['resize-image-guide', 'background-remover-guide', 'image-filters-guide', 'jpg-to-pdf-guide'],
  },

  {
    slug: 'resize-image-guide',
    toolSlug: '/resize-image',
    toolName: 'Image Resize',
    icon: 'maximize-2',
    tag: 'Image Tools',
    category: 'Image Tools',
    title: 'How to Resize an Image Online — Free Resize Tool with Presets',
    description: 'Resize images to 1:1, 16:9, A4, HD or any custom size. Perfect for social, print and web. Free, no signup, instant download.',
    intro: `<p>Sometimes an image is too big — for an upload limit, an email, a website. Sometimes it\'s the wrong shape — square for Instagram, widescreen for YouTube. <strong>Resizing</strong> handles both at once.</p>
<p>The <a href="/resize-image">Image Resize</a> tool lets you scale any image to a preset (1:1 square, 16:9 widescreen, A4, HD) or to exact custom pixel dimensions.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/resize-image">ilovepdf.cyou/resize-image</a>.' },
      { title: 'Upload your image', body: 'Drag and drop a .jpg, .jpeg, .png or .webp file.' },
      { title: 'Pick a preset or Custom', body: '1:1 (1080×1080), 16:9 (1920×1080), A4 (2480×3508), HD (1920×1080), or Custom.' },
      { title: 'Set custom dimensions (if Custom)', body: 'Enter exact width and height in pixels.' },
      { title: 'Process and download', body: 'Save the resized image as <code>ILovePDF-resize-image.png</code>.' },
    ],
    benefits: [
      { title: 'Common presets', body: '1:1, 16:9, A4 and HD cover 90% of resize needs.' },
      { title: 'Custom dimensions', body: 'Exact pixel sizing for anything outside the presets.' },
      { title: 'Quality preserved', body: 'Sharp\'s built-in resizing produces clean, anti-aliased output.' },
      { title: 'Free', body: 'No watermark, no signup, unlimited resizes.' },
    ],
    useCases: [
      { audience: 'Social media', body: 'Quickly resize a portrait to 1080×1080 for Instagram without learning Photoshop.' },
      { audience: 'Web design', body: 'Generate hero images at exact pixel dimensions for predictable page layouts.' },
      { audience: 'Print', body: 'Resize images to A4 for printing posters, flyers and one-page documents.' },
    ],
    tips: [
      { title: 'Crop first for aspect ratio', body: 'Use <a href="/crop-image">Crop Image</a> first if your source aspect ratio doesn\'t match the target.' },
      { title: 'Don\'t upscale heavily', body: 'Going from 100×100 to 4000×4000 will look pixellated. Resize within reasonable bounds.' },
      { title: 'Combine with filters', body: 'Apply <a href="/image-filters">Image Filters</a> after resizing for best visual consistency.' },
      { title: 'Compress for web', body: 'After resizing, lighten the file with <a href="/compress-pdf">image compression workflows</a>.' },
    ],
    faq: [
      { q: 'Will it stretch my image?', a: 'Yes — exact width/height resizes ignore the original aspect ratio. Crop first to maintain proportion.' },
      { q: 'Can I batch resize?', a: 'One image per run. Repeat for batches.' },
      { q: 'What\'s the max output size?', a: 'Up to roughly print resolution (4000×4000+). Very large outputs may take longer.' },
      { q: 'Does it preserve transparency?', a: 'Yes for PNG inputs/outputs. JPG outputs flatten transparency to white.' },
    ],
    related: ['crop-image-guide', 'background-remover-guide', 'image-filters-guide', 'jpg-to-pdf-guide'],
  },

  {
    slug: 'image-filters-guide',
    toolSlug: '/image-filters',
    toolName: 'Image Filters',
    icon: 'sliders',
    tag: 'Image Tools',
    category: 'Image Tools',
    title: 'Apply Free Image Filters Online — Grayscale, Sepia, Blur & More',
    description: 'Apply grayscale, sepia, blur, brightness, contrast, sharpen and invert filters to any image. Free, fast, no signup needed.',
    intro: `<p>Sometimes an image needs a quick stylistic touch — a vintage sepia tone, a moody black-and-white, a slight blur for backgrounds, or just a brightness boost. You don\'t need a $20/month editor for that.</p>
<p>The <a href="/image-filters">Image Filters</a> tool applies one of seven popular effects to any uploaded image in one click.</p>`,
    steps: [
      { title: 'Open the tool', body: 'Visit <a href="/image-filters">ilovepdf.cyou/image-filters</a>.' },
      { title: 'Upload your image', body: 'Drag and drop a .jpg, .jpeg, .png or .webp file.' },
      { title: 'Pick a filter', body: 'Choose from grayscale, sepia, blur, brightness boost, high contrast, sharpen, or invert colours.' },
      { title: 'Process', body: 'The filter is applied to the image using the sharp imaging library.' },
      { title: 'Download', body: 'Save the filtered image as <code>ILovePDF-image-filters.png</code>.' },
    ],
    benefits: [
      { title: 'Seven popular effects', body: 'Grayscale, sepia, blur, brighten, contrast, sharpen, invert — covers the most common needs.' },
      { title: 'High-quality output', body: 'Filters use sharp\'s optimised pipeline for clean, artefact-free results.' },
      { title: 'Browser-based', body: 'Works on any device with a modern browser.' },
      { title: 'Free, no signup', body: 'No trial limits, no watermarks, no account required.' },
    ],
    useCases: [
      { audience: 'Social media', body: 'Apply a sepia or grayscale filter for a vintage feed aesthetic.' },
      { audience: 'Product photos', body: 'Brightness and sharpening to make ecommerce shots pop.' },
      { audience: 'Designers', body: 'Quick blur for hero-image overlays where you need text-readable backgrounds.' },
    ],
    tips: [
      { title: 'Sharpen subtly', body: 'Sharpen on already sharp images can over-enhance — use only on slightly soft inputs.' },
      { title: 'Combine in sequence', body: 'Apply filters one at a time across multiple runs for layered effects.' },
      { title: 'Crop and resize first', body: 'Get the composition right with <a href="/crop-image">Crop Image</a> and <a href="/resize-image">Image Resize</a> before filtering.' },
      { title: 'Remove background after', body: 'Apply colour filters first, then run <a href="/background-remover">Background Remover</a> for clean composites.' },
    ],
    faq: [
      { q: 'Can I adjust filter strength?', a: 'Filters apply at preset intensities. Custom intensity sliders are on the roadmap.' },
      { q: 'Can I combine multiple filters?', a: 'Apply one at a time across multiple runs. Stacked filters in one pass are coming.' },
      { q: 'Will my image look pixellated?', a: 'No. Sharp\'s pipeline preserves quality through filter operations.' },
      { q: 'Does it work on transparent PNGs?', a: 'Yes. Transparency is preserved through colour-affecting filters.' },
    ],
    related: ['crop-image-guide', 'resize-image-guide', 'background-remover-guide', 'jpg-to-pdf-guide'],
  },

];
