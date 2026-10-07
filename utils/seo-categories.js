export const CATEGORIES = {
  'organize-pdf':    { name: 'Organize PDF',     desc: 'Merge, split, rotate and reorder PDF pages' },
  'convert-to-pdf':  { name: 'Convert to PDF',   desc: 'Convert JPG, Word, Excel, PowerPoint to PDF' },
  'convert-from-pdf':{ name: 'Convert from PDF', desc: 'Convert PDF to Word, Excel, PowerPoint, JPG' },
  'edit-pdf':        { name: 'Edit & Optimize',  desc: 'Compress, edit, sign, watermark and crop PDF' },
  'pdf-security':    { name: 'Security',         desc: 'Protect and unlock PDF files' },
  'ai-tools':        { name: 'AI & OCR Tools',   desc: 'AI Summarizer, OCR and document tools' },
  'image-tools':     { name: 'Image Tools',      desc: 'Background remover, filter, resize and crop images' },
};

export function allPublicSlugs() {
  return {
    categories: Object.keys(CATEGORIES),
    tools: [
      'merge-pdf', 'split-pdf', 'compress-pdf', 'pdf-to-word', 'pdf-to-powerpoint',
      'pdf-to-excel', 'word-to-pdf', 'powerpoint-to-pdf', 'excel-to-pdf', 'edit-pdf',
      'pdf-to-jpg', 'jpg-to-pdf', 'sign-pdf', 'watermark-pdf', 'rotate-pdf',
      'html-to-pdf', 'unlock-pdf', 'protect-pdf', 'organize-pdf', 'crop-pdf',
      'repair-pdf', 'scan-pdf', 'ocr-pdf', 'compare-pdf', 'redact-pdf',
      'add-page-numbers', 'background-remover', 'resize-image', 'crop-image',
      'image-filters', 'numbers-to-words', 'currency-converter', 'ai-summarizer'
    ],
    utilities: ['privacy', 'terms', 'disclaimer', 'about', 'tools'],
    blogs: [
      'merge-pdf-guide', 'split-pdf-guide', 'compress-pdf-guide', 'pdf-to-word-guide',
      'pdf-to-excel-guide', 'pdf-to-jpg-guide', 'edit-pdf-guide', 'protect-pdf-guide'
    ],
  };
}
