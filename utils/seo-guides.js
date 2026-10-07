export const GUIDES = {
  'how-to-merge-pdf': {
    title: 'How to Merge PDF Files Online',
    desc: 'Step by step tutorial on merging PDF documents easily.',
  },
  'how-to-compress-pdf': {
    title: 'How to Compress PDF Without Losing Quality',
    desc: 'Learn how to shrink PDF file size quickly in your browser.',
  },
};

export function buildGuideIndexHtml() {
  return `<!DOCTYPE html><html><head><title>How-To Guides & Tutorials | ILovePDF</title><meta name="description" content="Helpful guides and tutorials for working with PDF and image files."></head><body><h1>PDF Guides &amp; Tutorials</h1><ul><li><a href="/guides/how-to-merge-pdf">How to Merge PDF</a></li><li><a href="/guides/how-to-compress-pdf">How to Compress PDF</a></li></ul></body></html>`;
}

export function buildGuideHtml(slug) {
  const item = GUIDES[slug] || { title: 'PDF Tutorial Guide', desc: 'Step-by-step PDF instructions' };
  return `<!DOCTYPE html><html><head><title>${item.title} | ILovePDF</title><meta name="description" content="${item.desc}"></head><body><h1>${item.title}</h1><p>${item.desc}</p><p><a href="/">Explore Tools</a></p></body></html>`;
}
