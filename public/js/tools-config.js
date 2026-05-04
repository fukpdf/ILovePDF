// URL slug → tool-id (mirrors utils/seo.js SLUG_MAP). Lets the client
// resolve clean URLs like /merge-pdf without needing the server-side
// SEO middleware (essential when the frontend is on Firebase Hosting).
// `special` is a redirect target (only for /n2w.html today).
window.SLUG_MAP = {
  'merge-pdf':         { id:'merge'         },
  'split-pdf':         { id:'split'         },
  'rotate-pdf':        { id:'rotate'        },
  'crop-pdf':          { id:'crop'          },
  'organize-pdf':      { id:'organize'      },
  'compress-pdf':      { id:'compress'      },
  'pdf-to-word':       { id:'pdf-to-word'   },
  'pdf-to-powerpoint': { id:'pdf-to-powerpoint' },
  'pdf-to-excel':      { id:'pdf-to-excel'  },
  'pdf-to-jpg':        { id:'pdf-to-jpg'    },
  'word-to-pdf':       { id:'word-to-pdf'   },
  'powerpoint-to-pdf': { id:'powerpoint-to-pdf' },
  'excel-to-pdf':      { id:'excel-to-pdf'  },
  'jpg-to-pdf':        { id:'jpg-to-pdf'    },
  'html-to-pdf':       { id:'html-to-pdf'   },
  'edit-pdf':          { id:'edit'          },
  'watermark-pdf':     { id:'watermark'     },
  'sign-pdf':          { id:'sign'          },
  'add-page-numbers':  { id:'page-numbers'  },
  'redact-pdf':        { id:'redact'        },
  'protect-pdf':       { id:'protect'       },
  'unlock-pdf':        { id:'unlock'        },
  'repair-pdf':        { id:'repair'        },
  'scan-pdf':          { id:'scan-to-pdf'   },
  'ocr-pdf':           { id:'ocr'           },
  'compare-pdf':       { id:'compare'       },
  'ai-summarizer':     { id:'ai-summarize'  },
  'translate-pdf':     { id:'translate'     },
  'workflow-builder':  { id:'workflow'      },
  'numbers-to-words':  { id:'numbers-to-words',  special:'/numbers-to-words.html' },
  'currency-converter':{ id:'currency-converter', special:'/currency-converter.html' },
  'background-remover':{ id:'background-remover' },
  'crop-image':        { id:'crop-image'    },
  'resize-image':      { id:'resize-image'  },
  'image-filters':     { id:'image-filters' },
};

// Resolve current page URL → tool-id. Falls back through:
//   1. window.__TOOL_ID (injected by Express SEO middleware)
//   2. ?id= query param (legacy /tool.html?id=merge URLs)
//   3. Pathname slug → SLUG_MAP lookup (works on Firebase static)
window.resolveToolIdFromUrl = function () {
  if (typeof window.__TOOL_ID === 'string' && window.__TOOL_ID) return window.__TOOL_ID;
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('id');
  if (fromQuery) return fromQuery;
  const slug = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!slug) return null;
  // Direct slug match
  if (window.SLUG_MAP[slug]) return window.SLUG_MAP[slug].id;
  // Tool-id used directly as path (e.g. /merge)
  return slug;
};

const CATEGORIES = [
  { name: 'Organize PDFs',       color: '#E5322E', icon: 'layers',             group: 'pdf'   },
  { name: 'Compress & Optimize', color: '#10b981', icon: 'zap',                group: 'pdf'   },
  { name: 'Convert From PDF',    color: '#f59e0b', icon: 'arrow-right-circle', group: 'pdf'   },
  { name: 'Convert To PDF',      color: '#8b5cf6', icon: 'arrow-left-circle',  group: 'pdf'   },
  { name: 'Edit & Annotate',     color: '#ec4899', icon: 'edit-3',             group: 'pdf'   },
  { name: 'Security',            color: '#ef4444', icon: 'shield',             group: 'pdf'   },
  { name: 'Advanced Tools',      color: '#6366f1', icon: 'cpu',                group: 'pdf'   },
  { name: 'Image Tools',         color: '#a855f7', icon: 'image',              group: 'image' },
];

const TOOLS = [
  // ── ADVANCED TOOLS — Utilities ────────────────────────────────────────────
  {
    id: 'numbers-to-words', name: 'Numbers to Words',
    icon: 'hash', url: '/numbers-to-words',
    description: 'Convert numbers, currency, or check amounts into words',
    category: 'Advanced Tools', group: 'pdf', badge: 'NEW',
    working: true, options: []
  },
  {
    id: 'currency-converter', name: 'Currency Converter',
    icon: 'dollar-sign', url: '/currency-converter',
    description: 'Live exchange rates for 160+ world currencies',
    category: 'Advanced Tools', group: 'pdf', badge: 'NEW',
    working: true, options: []
  },
  // ── ORGANIZE PDFs ─────────────────────────────────────────────────────────
  {
    id: 'merge', name: 'Merge', icon: 'layers',
    description: 'Combine multiple PDF files into a single document',
    category: 'Organize PDFs', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/merge', acceptedFiles: '.pdf',
    multipleFiles: true, working: true, clientSide: true, options: []
  },
  {
    id: 'split', name: 'Split', icon: 'scissors',
    description: 'Extract specific pages or ranges from a PDF',
    category: 'Organize PDFs', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/split', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'range', label: 'Page Range', type: 'text', placeholder: 'e.g. 1-3, 5, 7-9 (blank = all)' }
    ]
  },
  {
    id: 'rotate', name: 'Rotate', icon: 'rotate-cw',
    description: 'Rotate pages to the correct orientation',
    category: 'Organize PDFs', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/rotate', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'degrees', label: 'Rotation Angle', type: 'select', options: [
        { value: '90', label: '90° Clockwise' },
        { value: '180', label: '180°' },
        { value: '270', label: '270° (Counter-clockwise)' }
      ]},
      { id: 'pages', label: 'Pages (comma-separated or "all")', type: 'text', placeholder: 'all' }
    ]
  },
  {
    id: 'crop', name: 'Crop', icon: 'crop',
    description: 'Trim the margins of PDF pages',
    category: 'Organize PDFs', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/crop', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'cropLeft',   label: 'Crop Left (%)',   type: 'number', placeholder: '0' },
      { id: 'cropRight',  label: 'Crop Right (%)',  type: 'number', placeholder: '0' },
      { id: 'cropTop',    label: 'Crop Top (%)',    type: 'number', placeholder: '0' },
      { id: 'cropBottom', label: 'Crop Bottom (%)', type: 'number', placeholder: '0' }
    ]
  },
  {
    id: 'organize', name: 'Organize PDF', icon: 'move',
    description: 'Reorder the pages of your PDF document',
    category: 'Organize PDFs', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/organize', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'pageOrder', label: 'New Page Order (1-indexed, comma-separated)', type: 'text', placeholder: 'e.g. 3,1,2' }
    ]
  },

  // ── COMPRESS & OPTIMIZE ───────────────────────────────────────────────────
  {
    id: 'compress', name: 'Compress PDF', icon: 'archive',
    description: 'Reduce PDF file size while preserving quality',
    category: 'Compress & Optimize', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/compress', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },

  // ── CONVERT FROM PDF ──────────────────────────────────────────────────────
  {
    id: 'pdf-to-word', name: 'PDF to Word', icon: 'file-text',
    description: 'Convert PDF to editable Word documents',
    category: 'Convert From PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/pdf-to-word', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'pdf-to-powerpoint', name: 'PDF to PowerPoint', icon: 'layout',
    description: 'Transform PDFs into editable presentations',
    category: 'Convert From PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/pdf-to-powerpoint', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'pdf-to-excel', name: 'PDF to Excel', icon: 'table',
    description: 'Extract tables from PDFs into spreadsheets',
    category: 'Convert From PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/pdf-to-excel', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'pdf-to-jpg', name: 'PDF to JPG', icon: 'image', clientSide: true,
    description: 'Convert PDF pages into high-quality JPG images',
    category: 'Convert From PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/pdf-to-jpg', acceptedFiles: '.pdf',
    multipleFiles: false, working: true,
    options: [
      { id: 'quality', label: 'Image Quality', type: 'select', options: [
        { value: 'standard', label: 'Standard (150 DPI)' },
        { value: 'high',     label: 'High (200 DPI)' }
      ]}
    ]
  },

  // ── CONVERT TO PDF ────────────────────────────────────────────────────────
  {
    id: 'word-to-pdf', name: 'Word to PDF', icon: 'file-up',
    description: 'Convert Word documents to PDF format',
    category: 'Convert To PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/word-to-pdf', acceptedFiles: '.doc,.docx',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'powerpoint-to-pdf', name: 'PowerPoint to PDF', icon: 'monitor',
    description: 'Convert presentations to PDF format',
    category: 'Convert To PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/powerpoint-to-pdf', acceptedFiles: '.ppt,.pptx',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'excel-to-pdf', name: 'Excel to PDF', icon: 'grid',
    description: 'Convert Excel spreadsheets to PDF',
    category: 'Convert To PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/excel-to-pdf', acceptedFiles: '.xls,.xlsx',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'jpg-to-pdf', name: 'JPG to PDF', icon: 'file-image', clientSide: true,
    description: 'Convert images (JPG, PNG) into a PDF document',
    category: 'Convert To PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/jpg-to-pdf', acceptedFiles: '.jpg,.jpeg,.png',
    multipleFiles: true, working: true, options: []
  },
  {
    id: 'html-to-pdf', name: 'HTML to PDF', icon: 'globe',
    description: 'Convert HTML files into PDF documents',
    category: 'Convert To PDF', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/html-to-pdf', acceptedFiles: '.html,.htm',
    multipleFiles: false, working: true, clientSide: true, options: []
  },

  // ── EDIT & ANNOTATE ───────────────────────────────────────────────────────
  {
    id: 'edit', name: 'Edit PDF', icon: 'edit-3',
    description: 'Add text annotations and overlays to your PDF',
    category: 'Edit & Annotate', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/edit', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'text',     label: 'Text to Add',              type: 'text',   placeholder: 'Your text here...' },
      { id: 'x',        label: 'X Position (%)',           type: 'number', placeholder: '50' },
      { id: 'y',        label: 'Y Position (%)',           type: 'number', placeholder: '50' },
      { id: 'fontSize', label: 'Font Size',                type: 'number', placeholder: '14' },
      { id: 'page',     label: 'Page (number or "all")',   type: 'text',   placeholder: '1' }
    ]
  },
  {
    id: 'watermark', name: 'Watermark', icon: 'droplets', clientSide: true,
    description: 'Add a text watermark to protect your document',
    category: 'Edit & Annotate', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/watermark', acceptedFiles: '.pdf',
    multipleFiles: false, working: true,
    options: [
      { id: 'text',     label: 'Watermark Text',     type: 'text',   placeholder: 'CONFIDENTIAL' },
      { id: 'opacity',  label: 'Opacity (0.1–0.9)',  type: 'number', placeholder: '0.3' },
      { id: 'position', label: 'Position', type: 'select', options: [
        { value: 'center',       label: 'Center (Diagonal)' },
        { value: 'top-left',     label: 'Top Left' },
        { value: 'top-right',    label: 'Top Right' },
        { value: 'bottom-left',  label: 'Bottom Left' },
        { value: 'bottom-right', label: 'Bottom Right' }
      ]}
    ]
  },
  {
    id: 'sign', name: 'Sign PDF', icon: 'pen-tool',
    description: 'Add a digital text signature to your PDF',
    category: 'Edit & Annotate', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/sign', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'signatureText', label: 'Your Name / Signature', type: 'text',   placeholder: 'John Doe' },
      { id: 'page',          label: 'Page to Sign (blank = last)', type: 'number', placeholder: '' }
    ]
  },
  {
    id: 'page-numbers', name: 'Add Page Numbers', icon: 'hash', clientSide: true,
    description: 'Insert page numbers into your document',
    category: 'Edit & Annotate', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/page-numbers', acceptedFiles: '.pdf',
    multipleFiles: false, working: true,
    options: [
      { id: 'position', label: 'Position', type: 'select', options: [
        { value: 'bottom-center', label: 'Bottom Center' },
        { value: 'bottom-right',  label: 'Bottom Right' },
        { value: 'bottom-left',   label: 'Bottom Left' },
        { value: 'top-center',    label: 'Top Center' },
        { value: 'top-right',     label: 'Top Right' },
        { value: 'top-left',      label: 'Top Left' }
      ]},
      { id: 'startFrom', label: 'Start Numbering From', type: 'number', placeholder: '1' }
    ]
  },
  {
    id: 'redact', name: 'Redact PDF', icon: 'eye-off',
    description: 'Black out sensitive areas of your PDF',
    category: 'Edit & Annotate', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/redact', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'x',      label: 'X Position (%)',  type: 'number', placeholder: '10' },
      { id: 'y',      label: 'Y Position (%)',  type: 'number', placeholder: '40' },
      { id: 'width',  label: 'Width (%)',        type: 'number', placeholder: '30' },
      { id: 'height', label: 'Height (%)',       type: 'number', placeholder: '10' },
      { id: 'pages',  label: 'Pages (number or "all")', type: 'text', placeholder: '1' }
    ]
  },

  // ── SECURITY ──────────────────────────────────────────────────────────────
  {
    id: 'protect', name: 'Protect PDF', icon: 'lock',
    description: 'Encrypt your PDF with a password',
    category: 'Security', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/protect', acceptedFiles: '.pdf',
    multipleFiles: false, working: true,
    /* Browser-only password encryption isn't safe to do with pdf-lib alone,
       so this routes straight to the local Express backend (no HF queue). */
    options: [
      { id: 'password', label: 'Password', type: 'text', placeholder: 'Enter a password' }
    ]
  },
  {
    id: 'unlock', name: 'Unlock PDF', icon: 'unlock', clientSide: true,
    description: 'Remove password protection from a PDF',
    category: 'Security', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/unlock', acceptedFiles: '.pdf',
    multipleFiles: false, working: true,
    options: [
      { id: 'password', label: 'Current Password (if known)', type: 'text', placeholder: 'Leave blank if unsure' }
    ]
  },

  // ── ADVANCED TOOLS ────────────────────────────────────────────────────────
  {
    id: 'repair', name: 'Repair', icon: 'wrench',
    description: 'Fix corrupted or damaged PDF files',
    category: 'Advanced Tools', group: 'pdf', badge: 'Utility',
    apiEndpoint: '/api/repair', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'scan-to-pdf', name: 'Scan', icon: 'scan-line',
    description: 'Convert scanned images into a PDF document',
    category: 'Advanced Tools', group: 'pdf', badge: 'PDF',
    apiEndpoint: '/api/scan-to-pdf', acceptedFiles: '.jpg,.jpeg,.png',
    multipleFiles: true, working: true, clientSide: true, options: []
  },
  {
    id: 'ocr', name: 'OCR', icon: 'type',
    description: 'Extract and copy text from your PDF document',
    category: 'Advanced Tools', group: 'pdf', badge: 'AI',
    apiEndpoint: '/api/ocr', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true, options: []
  },
  {
    id: 'compare', name: 'Compare', icon: 'columns',
    description: 'Find differences between two PDF files',
    category: 'Advanced Tools', group: 'pdf', badge: 'Utility',
    apiEndpoint: '/api/compare', acceptedFiles: '.pdf',
    multipleFiles: true, working: true, clientSide: true, options: []
  },
  {
    id: 'ai-summarize', name: 'AI Summarizer', icon: 'sparkles',
    description: 'Summarize PDF content with smart extraction',
    category: 'Advanced Tools', group: 'pdf', badge: 'AI',
    apiEndpoint: '/api/ai-summarize', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'sentences', label: 'Summary Length (number of key sentences)', type: 'number', placeholder: '7' }
    ]
  },
  {
    id: 'translate', name: 'Translate', icon: 'languages',
    description: 'Translate PDF documents into any language',
    category: 'Advanced Tools', group: 'pdf', badge: 'AI',
    apiEndpoint: '/api/translate', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'targetLang', label: 'Target Language', type: 'select', options: [
        { value: 'es', label: 'Spanish' },
        { value: 'fr', label: 'French' },
        { value: 'de', label: 'German' },
        { value: 'it', label: 'Italian' },
        { value: 'pt', label: 'Portuguese' },
        { value: 'nl', label: 'Dutch' },
        { value: 'ru', label: 'Russian' },
        { value: 'zh', label: 'Chinese' },
        { value: 'ja', label: 'Japanese' },
        { value: 'ar', label: 'Arabic' },
        { value: 'hi', label: 'Hindi' },
        { value: 'ko', label: 'Korean' }
      ]}
    ]
  },
  {
    id: 'workflow', name: 'Workflow Builder', icon: 'git-branch',
    description: 'Chain multiple PDF operations in a single pass',
    category: 'Advanced Tools', group: 'pdf', badge: 'Utility',
    apiEndpoint: '/api/workflow', acceptedFiles: '.pdf',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'step1', label: 'Step 1 — Operation', type: 'select', options: [
        { value: '',           label: '— Select operation —' },
        { value: 'compress',   label: 'Compress' },
        { value: 'rotate-90',  label: 'Rotate 90°' },
        { value: 'rotate-180', label: 'Rotate 180°' },
        { value: 'watermark',  label: 'Add Watermark' },
        { value: 'page-numbers', label: 'Add Page Numbers' },
        { value: 'sign',       label: 'Add Signature' }
      ]},
      { id: 'step1_value', label: 'Step 1 — Text Value (for Watermark / Signature)', type: 'text', placeholder: 'e.g. DRAFT or John Doe' },
      { id: 'step2', label: 'Step 2 — Operation (optional)', type: 'select', options: [
        { value: '',           label: '— None —' },
        { value: 'compress',   label: 'Compress' },
        { value: 'rotate-90',  label: 'Rotate 90°' },
        { value: 'rotate-180', label: 'Rotate 180°' },
        { value: 'watermark',  label: 'Add Watermark' },
        { value: 'page-numbers', label: 'Add Page Numbers' },
        { value: 'sign',       label: 'Add Signature' }
      ]},
      { id: 'step2_value', label: 'Step 2 — Text Value (optional)', type: 'text', placeholder: '' },
      { id: 'step3', label: 'Step 3 — Operation (optional)', type: 'select', options: [
        { value: '',           label: '— None —' },
        { value: 'compress',   label: 'Compress' },
        { value: 'rotate-90',  label: 'Rotate 90°' },
        { value: 'rotate-180', label: 'Rotate 180°' },
        { value: 'watermark',  label: 'Add Watermark' },
        { value: 'page-numbers', label: 'Add Page Numbers' },
        { value: 'sign',       label: 'Add Signature' }
      ]},
      { id: 'step3_value', label: 'Step 3 — Text Value (optional)', type: 'text', placeholder: '' }
    ]
  },

  // ── IMAGE TOOLS ───────────────────────────────────────────────────────────
  {
    id: 'background-remover', name: 'Background Remover', icon: 'image-minus',
    description: 'Remove white or near-white backgrounds from images',
    category: 'Image Tools', group: 'image', badge: 'AI',
    apiEndpoint: '/api/background-remove', acceptedFiles: '.jpg,.jpeg,.png,.webp',
    multipleFiles: false, working: true, clientSide: true,
    options: [
      { id: 'threshold', label: 'Background Threshold (180–255, higher = stricter)', type: 'number', placeholder: '240' }
    ]
  },
  {
    id: 'crop-image', name: 'Crop Image', icon: 'crop', clientSide: true,
    description: 'Crop and trim your images with precision controls',
    category: 'Image Tools', group: 'image', badge: 'Image',
    apiEndpoint: '/api/crop-image', acceptedFiles: '.jpg,.jpeg,.png,.webp',
    multipleFiles: false, working: true,
    options: [
      { id: 'x',      label: 'X Offset (%)',  type: 'number', placeholder: '0'   },
      { id: 'y',      label: 'Y Offset (%)',  type: 'number', placeholder: '0'   },
      { id: 'width',  label: 'Width (%)',      type: 'number', placeholder: '100' },
      { id: 'height', label: 'Height (%)',     type: 'number', placeholder: '100' }
    ]
  },
  {
    id: 'resize-image', name: 'Image Resize', icon: 'maximize-2', clientSide: true,
    description: 'Resize images with presets: 1:1, 16:9, A4, HD, or custom',
    category: 'Image Tools', group: 'image', badge: 'Image',
    apiEndpoint: '/api/resize-image', acceptedFiles: '.jpg,.jpeg,.png,.webp',
    multipleFiles: false, working: true,
    options: [
      { id: 'preset', label: 'Preset', type: 'select', options: [
        { value: 'custom',  label: 'Custom' },
        { value: '1:1',     label: '1:1 Square (1080×1080)' },
        { value: '16:9',    label: '16:9 Widescreen (1920×1080)' },
        { value: 'a4',      label: 'A4 (2480×3508)' },
        { value: 'hd',      label: 'HD (1920×1080)' }
      ]},
      { id: 'width',  label: 'Custom Width (px)',  type: 'number', placeholder: '800' },
      { id: 'height', label: 'Custom Height (px)', type: 'number', placeholder: '600' }
    ]
  },
  {
    id: 'image-filters', name: 'Image Filters', icon: 'sliders', clientSide: true,
    description: 'Apply grayscale, sepia, blur, brightness, contrast and more',
    category: 'Image Tools', group: 'image', badge: 'Image',
    apiEndpoint: '/api/filters', acceptedFiles: '.jpg,.jpeg,.png,.webp',
    multipleFiles: false, working: true,
    options: [
      { id: 'filter', label: 'Filter Effect', type: 'select', options: [
        { value: 'grayscale', label: 'Grayscale' },
        { value: 'sepia',     label: 'Sepia' },
        { value: 'blur',      label: 'Blur' },
        { value: 'brighten',  label: 'Brightness Boost' },
        { value: 'contrast',  label: 'High Contrast' },
        { value: 'sharpen',   label: 'Sharpen' },
        { value: 'invert',    label: 'Invert Colors' }
      ]}
    ]
  },
];
