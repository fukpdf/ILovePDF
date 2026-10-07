export const COMPARISONS = {
  'ilovepdf-vs-smallpdf': {
    title: 'ILovePDF vs Smallpdf Comparison',
    desc: 'Compare ILovePDF and Smallpdf features, limits, and speed.',
  },
  'ilovepdf-vs-adobe-acrobat': {
    title: 'ILovePDF vs Adobe Acrobat',
    desc: 'Discover why free online browser tools from ILovePDF compare favorably with Adobe Acrobat.',
  },
};

export function buildCompareIndexHtml() {
  return `<!DOCTYPE html><html><head><title>PDF Tool Comparisons | ILovePDF</title><meta name="description" content="Compare ILovePDF with other popular PDF tools."></head><body><h1>PDF Tool Comparisons</h1><ul><li><a href="/compare/ilovepdf-vs-smallpdf">ILovePDF vs Smallpdf</a></li><li><a href="/compare/ilovepdf-vs-adobe-acrobat">ILovePDF vs Adobe Acrobat</a></li></ul></body></html>`;
}

export function buildComparisonHtml(slug) {
  const item = COMPARISONS[slug] || { title: 'PDF Tool Comparison', desc: 'Detailed comparison' };
  return `<!DOCTYPE html><html><head><title>${item.title} | ILovePDF</title><meta name="description" content="${item.desc}"></head><body><h1>${item.title}</h1><p>${item.desc}</p><p><a href="/">Back to all tools</a></p></body></html>`;
}
