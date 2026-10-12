import { getToolSeo } from './seo-keywords.js';
import { CATEGORIES } from './seo-categories.js';

export const SLUG_MAP = {
  'merge-pdf':         { id:'merge' },
  'split-pdf':         { id:'split' },
  'rotate-pdf':        { id:'rotate' },
  'crop-pdf':          { id:'crop' },
  'organize-pdf':      { id:'organize' },
  'compress-pdf':      { id:'compress' },
  'pdf-to-word':       { id:'pdf-to-word' },
  'pdf-to-powerpoint': { id:'pdf-to-powerpoint' },
  'pdf-to-excel':      { id:'pdf-to-excel' },
  'pdf-to-jpg':        { id:'pdf-to-jpg' },
  'word-to-pdf':       { id:'word-to-pdf' },
  'powerpoint-to-pdf': { id:'powerpoint-to-pdf' },
  'excel-to-pdf':      { id:'excel-to-pdf' },
  'word-to-excel':     { id:'word-to-excel' },
  'jpg-to-pdf':        { id:'jpg-to-pdf' },
  'html-to-pdf':       { id:'html-to-pdf' },
  'edit':              { id:'edit' },
  'edit-pdf':          { id:'edit' },
  'watermark-pdf':     { id:'watermark' },
  'sign-pdf':          { id:'sign' },
  'add-page-numbers':  { id:'page-numbers' },
  'redact-pdf':        { id:'redact' },
  'protect-pdf':       { id:'protect' },
  'unlock-pdf':        { id:'unlock' },
  'repair-pdf':        { id:'repair' },
  'scan-pdf':          { id:'scan-to-pdf' },
  'ocr-pdf':           { id:'ocr' },
  'compare-pdf':       { id:'compare' },
  'translate-pdf':     { id:'translate' },
  'ai-summarizer':     { id:'ai-summarizer' },
  'workflow-builder':  { id:'workflow' },
  'background-remover':{ id:'background-remover' },
  'crop-image':        { id:'crop-image' },
  'resize-image':      { id:'resize-image' },
  'image-filters':     { id:'image-filters' },
  'numbers-to-words':  { id:'numbers-to-words' },
  'currency-converter':{ id:'currency-converter' },
  'qr-code-generator': { id:'qr-code-generator' },
  'barcode-generator': { id:'barcode-generator' },
  'image-compressor':  { id:'image-compressor' },
  'image-converter':   { id:'image-converter' },
  'zip-builder':       { id:'zip-builder' },
};

export function buildCategoryHtml(catSlug) {
  const cat = CATEGORIES[catSlug] || { name: 'PDF Tools', desc: 'Powerful online PDF tools' };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${cat.name} — ILovePDF</title>
  <meta name="description" content="${cat.desc}">
  <link rel="stylesheet" href="/css/styles.css">
  <link rel="stylesheet" href="/css/home.css">
</head>
<body>
  <div class="page" style="padding: 2rem;">
    <h1>${cat.name}</h1>
    <p>${cat.desc}</p>
    <p><a href="/">Return to All Tools</a></p>
  </div>
</body>
</html>`;
}

export function buildHtml(slug, template, step = 'upload') {
  if (!template) return '';
  const tool = SLUG_MAP[slug] || { id: slug };
  const seo = getToolSeo(slug);

  let html = template;
  html = html.replace(/<title>.*?<\/title>/i, `<title>${seo.title}</title>`);
  html = html.replace(/<meta name="description" content=".*?"/i, `<meta name="description" content="${seo.description}"`);

  const injection = `<script>window.__TOOL_ID = ${JSON.stringify(tool.id)}; window.__STEP = ${JSON.stringify(step)}; window.__SLUG = ${JSON.stringify(slug)};</script>`;
  html = html.replace('</head>', `${injection}\n</head>`);

  return html;
}

export function buildHomeHtml(template) {
  return template;
}
