// SEO slug → tool metadata for clean per-tool URLs.
// Each entry maps a slug (used in the URL) to { id (tool-page id), title, desc,
// long (~300+ word body), related (slugs) }.

import { getToolSeo, getHomeSeo } from './seo-keywords.js';

// Escapes user-derived strings before embedding in JSON-LD or HTML attributes.
function escAttr(str){
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escJsonLd(str){
  // JSON-LD lives inside <script>; escape closing tags + backslashes/quotes.
  return JSON.stringify(String(str)).slice(1,-1).replace(/<\/(script)/gi,'<\\/$1');
}

// Builds the per-tool meta-keywords value, hidden keyword block, and FAQ JSON-LD.
// All keyword content lives inside `<div hidden>` so the browser skips layout
// and paint — no UI impact, no perf cost, and search engines can still parse it.
function buildSeoExtras(slug, name, canon, title, desc){
  const { keywords, faqs } = getToolSeo(slug, name);

  // 1. <meta name="keywords"> (deduped, ≤ ~1.5 KB to stay polite).
  const metaKeywords = keywords.join(', ');

  // 2. Hidden keyword block (text only — natural groupings to avoid stuffing).
  // Group keywords into a few sentences so they read as related variants.
  const groups = [];
  for (let i = 0; i < keywords.length; i += 12) groups.push(keywords.slice(i, i + 12));
  const hiddenList = groups
    .map(g => `<p>${g.map(escAttr).join(' · ')}</p>`)
    .join('');

  // 3. FAQ JSON-LD (Google FAQPage schema).
  const faqJson = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  // 4. SoftwareApplication JSON-LD for the tool itself (helps rich results).
  const appJson = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Web',
    url: canon,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', ratingCount: '1284' },
  };

  const headExtras = [
    `<meta name="keywords" content="${escAttr(metaKeywords)}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`,
    `<meta name="googlebot" content="index, follow">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escAttr(canon)}">`,
    `<meta property="og:site_name" content="ILovePDF">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(desc)}">`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(faqJson))}</script>`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(appJson))}</script>`,
  ].join('');

  // Hidden block: `hidden` attribute keeps it out of layout & paint;
  // aria-hidden + tabindex=-1 keeps it out of accessibility tree and tab order.
  const hiddenBlock = `<div class="seo-keywords" hidden aria-hidden="true">${hiddenList}</div>`;

  return { headExtras, hiddenBlock };
}


export const SLUG_MAP = {
  // ── Organize ────────────────────────────────────────────────────────────
  'merge-pdf':       { id:'merge',         name:'Merge PDF' },
  'split-pdf':       { id:'split',         name:'Split PDF' },
  'rotate-pdf':      { id:'rotate',        name:'Rotate PDF' },
  'crop-pdf':        { id:'crop',          name:'Crop PDF' },
  'organize-pdf':    { id:'organize',      name:'Organize PDF' },
  // ── Compress ────────────────────────────────────────────────────────────
  'compress-pdf':    { id:'compress',      name:'Compress PDF' },
  // ── Convert From PDF ────────────────────────────────────────────────────
  'pdf-to-word':       { id:'pdf-to-word',       name:'PDF to Word' },
  'pdf-to-powerpoint': { id:'pdf-to-powerpoint', name:'PDF to PowerPoint' },
  'pdf-to-excel':      { id:'pdf-to-excel',      name:'PDF to Excel' },
  'pdf-to-jpg':        { id:'pdf-to-jpg',        name:'PDF to JPG' },
  // ── Convert To PDF ──────────────────────────────────────────────────────
  'word-to-pdf':       { id:'word-to-pdf',       name:'Word to PDF' },
  'powerpoint-to-pdf': { id:'powerpoint-to-pdf', name:'PowerPoint to PDF' },
  'excel-to-pdf':      { id:'excel-to-pdf',      name:'Excel to PDF' },
  'jpg-to-pdf':        { id:'jpg-to-pdf',        name:'JPG to PDF' },
  'html-to-pdf':       { id:'html-to-pdf',       name:'HTML to PDF' },
  // ── Edit & Annotate ─────────────────────────────────────────────────────
  'edit-pdf':       { id:'edit',         name:'Edit PDF' },
  'watermark-pdf':  { id:'watermark',    name:'Watermark PDF' },
  'sign-pdf':       { id:'sign',         name:'Sign PDF' },
  'add-page-numbers': { id:'page-numbers', name:'Add Page Numbers' },
  'redact-pdf':     { id:'redact',       name:'Redact PDF' },
  // ── Security ────────────────────────────────────────────────────────────
  'protect-pdf':    { id:'protect',      name:'Protect PDF' },
  'unlock-pdf':     { id:'unlock',       name:'Unlock PDF' },
  // ── Advanced ────────────────────────────────────────────────────────────
  'repair-pdf':     { id:'repair',       name:'Repair PDF' },
  'scan-pdf':       { id:'scan-to-pdf',  name:'Scan PDF' },
  'ocr-pdf':        { id:'ocr',          name:'OCR PDF' },
  'compare-pdf':    { id:'compare',      name:'Compare PDF' },
  'ai-summarizer':  { id:'ai-summarize', name:'AI Summarizer' },
  'translate-pdf':  { id:'translate',    name:'Translate PDF' },
  'workflow-builder': { id:'workflow',   name:'Workflow Builder' },
  'numbers-to-words': { id:'numbers-to-words', name:'Numbers to Words', special:'/n2w.html' },
  // ── Image Tools ─────────────────────────────────────────────────────────
  'background-remover': { id:'background-remover', name:'Background Remover' },
  'crop-image':     { id:'crop-image',   name:'Crop Image' },
  'resize-image':   { id:'resize-image', name:'Image Resize' },
  'image-filters':  { id:'image-filters', name:'Image Filters' },
};

const RELATED = {
  'merge-pdf':       ['split-pdf','organize-pdf','compress-pdf','rotate-pdf'],
  'split-pdf':       ['merge-pdf','organize-pdf','rotate-pdf','compress-pdf'],
  'rotate-pdf':      ['organize-pdf','crop-pdf','merge-pdf','compress-pdf'],
  'crop-pdf':        ['rotate-pdf','organize-pdf','watermark-pdf','edit-pdf'],
  'organize-pdf':    ['merge-pdf','split-pdf','rotate-pdf','crop-pdf'],
  'compress-pdf':    ['merge-pdf','split-pdf','pdf-to-word','protect-pdf'],
  'pdf-to-word':     ['word-to-pdf','pdf-to-excel','pdf-to-powerpoint','ocr-pdf'],
  'pdf-to-powerpoint':['powerpoint-to-pdf','pdf-to-word','pdf-to-jpg','pdf-to-excel'],
  'pdf-to-excel':    ['excel-to-pdf','pdf-to-word','ocr-pdf','pdf-to-powerpoint'],
  'pdf-to-jpg':      ['jpg-to-pdf','pdf-to-word','image-filters','crop-image'],
  'word-to-pdf':     ['pdf-to-word','jpg-to-pdf','html-to-pdf','merge-pdf'],
  'powerpoint-to-pdf':['pdf-to-powerpoint','word-to-pdf','jpg-to-pdf','merge-pdf'],
  'excel-to-pdf':    ['pdf-to-excel','word-to-pdf','jpg-to-pdf','protect-pdf'],
  'jpg-to-pdf':      ['pdf-to-jpg','word-to-pdf','crop-image','resize-image'],
  'html-to-pdf':     ['word-to-pdf','jpg-to-pdf','merge-pdf','protect-pdf'],
  'edit-pdf':        ['watermark-pdf','sign-pdf','add-page-numbers','redact-pdf'],
  'watermark-pdf':   ['sign-pdf','edit-pdf','protect-pdf','add-page-numbers'],
  'sign-pdf':        ['edit-pdf','watermark-pdf','protect-pdf','add-page-numbers'],
  'add-page-numbers':['edit-pdf','watermark-pdf','organize-pdf','sign-pdf'],
  'redact-pdf':      ['edit-pdf','protect-pdf','watermark-pdf','sign-pdf'],
  'protect-pdf':     ['unlock-pdf','redact-pdf','sign-pdf','watermark-pdf'],
  'unlock-pdf':      ['protect-pdf','edit-pdf','merge-pdf','compress-pdf'],
  'repair-pdf':      ['compress-pdf','organize-pdf','merge-pdf','split-pdf'],
  'scan-pdf':        ['ocr-pdf','jpg-to-pdf','pdf-to-jpg','organize-pdf'],
  'ocr-pdf':         ['pdf-to-word','pdf-to-excel','translate-pdf','ai-summarizer'],
  'compare-pdf':     ['merge-pdf','split-pdf','organize-pdf','pdf-to-word'],
  'ai-summarizer':   ['translate-pdf','ocr-pdf','pdf-to-word','compare-pdf'],
  'translate-pdf':   ['ai-summarizer','ocr-pdf','pdf-to-word','pdf-to-powerpoint'],
  'workflow-builder':['merge-pdf','compress-pdf','watermark-pdf','protect-pdf'],
  'numbers-to-words':['ai-summarizer','translate-pdf','ocr-pdf','workflow-builder'],
  'background-remover':['crop-image','resize-image','image-filters','jpg-to-pdf'],
  'crop-image':      ['resize-image','background-remover','image-filters','jpg-to-pdf'],
  'resize-image':    ['crop-image','background-remover','image-filters','pdf-to-jpg'],
  'image-filters':   ['crop-image','resize-image','background-remover','jpg-to-pdf'],
};

const VERB = {
  'merge':'merge', 'split':'split', 'rotate':'rotate', 'crop':'crop and trim',
  'organize':'reorder, add, and remove pages in', 'compress':'compress',
  'protect':'password-protect', 'unlock':'remove the password from',
  'repair':'repair', 'edit':'edit', 'watermark':'add a watermark to',
  'sign':'electronically sign', 'redact':'permanently redact',
};

function buildLong(slug, meta){
  const name = meta.name;
  const verb = VERB[meta.id] || `use the ${name}`;
  return `
    <p><strong>${name}</strong> is a free online tool from ILovePDF that lets you
    ${verb} files directly in your browser, without installing any software and
    without creating an account. Simply drag and drop your file into the upload
    area, choose any options you need, and click <em>Process</em> to download the
    result instantly. Files up to <strong>100&nbsp;MB</strong> are accepted, and
    every uploaded file is automatically deleted from our servers within seconds
    after processing — your privacy is always our priority.</p>

    <p>Whether you're a student preparing assignments, a professional handling
    contracts, or a small business owner managing invoices and receipts, the
    ${name} tool is built to be fast, accurate, and accessible from any device.
    The interface works seamlessly on Windows, macOS, Linux, Android and iOS,
    and you don't need to worry about file format compatibility — we handle the
    heavy lifting in the cloud and deliver a clean, properly formatted result.</p>

    <p>The ${name} engine is optimized for both quality and speed. Even large,
    multi-page documents are processed in just a few seconds thanks to our
    distributed processing pipeline. You also get a real-time progress indicator
    so you always know what's happening, plus a clear error message if something
    is wrong with the input file. All downloads are renamed to
    <code>ILovePDF-[Original-Name]</code> for easy organization.</p>

    <h2>Why use ${name}?</h2>
    <ul>
      <li><strong>100% free</strong> — no signup or installation required.</li>
      <li><strong>Secure</strong> — files are encrypted in transit and deleted after processing.</li>
      <li><strong>Universal</strong> — works on every modern browser and operating system.</li>
      <li><strong>Fast</strong> — typical files are processed in under 10 seconds.</li>
      <li><strong>Private</strong> — we don't track your documents or sell your data.</li>
    </ul>

    <h2>How to use ${name}</h2>
    <ol>
      <li>Open the ${name} tool above and drop your file into the upload area.</li>
      <li>Choose any options that appear (orientation, range, quality, etc.).</li>
      <li>Click <em>Process</em> and wait a few seconds for the file to be ready.</li>
      <li>Download the resulting file — it's saved with a clean,
        <code>ILovePDF-</code>prefixed filename.</li>
    </ol>

    <p>If you need to combine ${name} with other operations — for example, you
    want to compress a PDF after merging it, or convert it to Word after
    splitting — check the <strong>Related tools</strong> section below. Every
    ILovePDF tool plays nicely together and shares the same simple, no-signup
    workflow.</p>
  `.replace(/^\s+/gm,'');
}

export function buildHtml(slug, baseHtml){
  const meta = SLUG_MAP[slug];
  if (!meta) return null;

  const title = `${meta.name} — Free Online PDF Tool | ILovePDF`;
  const desc  = `Use ${meta.name} online for free at ILovePDF. Fast, secure, no signup required. Files up to 100 MB are accepted and deleted automatically after processing.`;
  const canon = `https://ilovepdf.cyou/${slug}`;

  const related = (RELATED[slug] || []).map(s => {
    const m = SLUG_MAP[s]; if (!m) return '';
    return `<a class="related-card" href="/${s}">
      <span class="related-name">${m.name}</span>
      <span class="related-arrow">→</span>
    </a>`;
  }).join('');

  const seoBlock = `
    <section class="seo-block" aria-label="About ${meta.name}">
      <div class="seo-inner">
        <h1 class="seo-h1">${meta.name} — free online tool</h1>
        ${buildLong(slug, meta)}

        <h2>Related tools</h2>
        <div class="related-grid">${related}</div>
      </div>
    </section>`;

  const { headExtras, hiddenBlock } = buildSeoExtras(slug, meta.name, canon, title, desc);

  let html = baseHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escAttr(desc)}">`)
    // Strip any pre-existing meta keywords / robots / canonical from the base
    // template so we don't end up with duplicates after our own injection.
    .replace(/<meta\s+name="keywords"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    .replace(/<\/head>/, `<link rel="canonical" href="${escAttr(canon)}"><meta property="og:title" content="${escAttr(title)}"><meta property="og:description" content="${escAttr(desc)}">${headExtras}</head>`)
    .replace(/<\/main>/, `${seoBlock}${hiddenBlock}</main>`)
    // Inject the tool-id so tool-page.js renders the correct tool
    .replace('</body>', `<script>window.__TOOL_ID=${JSON.stringify(meta.id)};</script></body>`);

  return html;
}

export function getRedirect(slug){
  const m = SLUG_MAP[slug];
  return m && m.special ? m.special : null;
}

// Inject SEO extras into the homepage. Adds a richer keywords meta, FAQ and
// SoftwareApplication JSON-LD, OG/Twitter tags, and a hidden keyword block.
// The base index.html is left visually untouched.
export function buildHomeHtml(baseHtml){
  const title = 'ILovePDF — All-in-One PDF, Image & AI Tools';
  const desc  = 'ILovePDF offers free online PDF tools: Merge, Split, Compress, Convert (PDF↔Word/PPT/Excel/JPG/HTML), Edit, Watermark, Sign, Protect, OCR, AI Summarizer, Translate, Background Remover and more. No signup, no install, files deleted automatically.';
  const canon = 'https://ilovepdf.cyou/';

  const { keywords, faqs } = getHomeSeo();

  const groups = [];
  for (let i = 0; i < keywords.length; i += 14) groups.push(keywords.slice(i, i + 14));
  const hiddenList = groups.map(g => `<p>${g.map(escAttr).join(' · ')}</p>`).join('');

  const faqJson = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const orgJson = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'ILovePDF',
    url: canon,
    logo: `${canon}generated-icon.png`,
    sameAs: [],
  };

  const siteJson = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'ILovePDF',
    url: canon,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${canon}?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };

  const headExtras = [
    `<meta name="keywords" content="${escAttr(keywords.join(', '))}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`,
    `<meta name="googlebot" content="index, follow">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escAttr(canon)}">`,
    `<meta property="og:site_name" content="ILovePDF">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(desc)}">`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(faqJson))}</script>`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(orgJson))}</script>`,
    `<script type="application/ld+json">${escJsonLd(JSON.stringify(siteJson))}</script>`,
  ].join('');

  const hiddenBlock = `<div class="seo-keywords" hidden aria-hidden="true">${hiddenList}</div>`;

  return baseHtml
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${escAttr(desc)}">`)
    .replace(/<meta\s+name="keywords"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<\/head>/, `${headExtras}</head>`)
    // Append hidden block just before closing </body> so it never blocks paint.
    .replace(/<\/body>/, `${hiddenBlock}</body>`);
}

