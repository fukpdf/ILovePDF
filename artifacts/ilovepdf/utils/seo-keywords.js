export function getToolSeo(slug, defaultName = '') {
  const cleanName = defaultName || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    title: `${cleanName} Online Free — Fast & Secure | ILovePDF`,
    description: `Free online ${cleanName} tool. No signup or installation required. Process ${cleanName.toLowerCase()} directly in your browser with high quality and speed.`,
    h1: cleanName,
    keywords: `${slug}, ${cleanName.toLowerCase()}, free online pdf tools, ilovepdf`,
    faqs: [
      { q: `Is ${cleanName} free to use?`, a: `Yes, ${cleanName} is 100% free with no account or registration required.` },
      { q: `Are my files safe?`, a: `Yes, files are processed directly in your browser or automatically deleted from our server after processing.` },
      { q: `What file formats are supported?`, a: `We support PDF documents and all standard image formats.` },
    ],
    benefits: [
      'No installation needed',
      'Client-first private processing',
      'High speed & lossless quality',
      'Works on all mobile and desktop browsers'
    ],
  };
}
