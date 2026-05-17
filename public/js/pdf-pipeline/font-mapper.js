// font-mapper.js — PDF Font → Word Font Mapping Engine
// Phase 7 of PDF→Word Fidelity Pipeline
// Preserves typography hierarchy: family, weight, style, size
// Gracefully maps any PDF font name to the closest safe Word equivalent.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  // ── Font family normalization map ─────────────────────────────────────────
  // Keys: normalised PDF font name (lowercase, stripped of spaces/dashes)
  // Values: Word-safe font family string
  const FAMILY_MAP = {
    // Times / Serif
    timesnewroman:'Times New Roman', timesroman:'Times New Roman',
    times:'Times New Roman',         timesmt:'Times New Roman',
    timesnewromanps:'Times New Roman',
    palatino:'Georgia',              palatinolinotype:'Georgia',
    bookman:'Times New Roman',       bookmanoldstyle:'Times New Roman',
    garamond:'Georgia',              ebgaramond:'Georgia',
    centuryschoolbook:'Georgia',     centuryold:'Georgia',
    constantia:'Georgia',            georgia:'Georgia',
    cambria:'Cambria',               cambriamt:'Cambria',
    minionpro:'Times New Roman',     minion:'Times New Roman',
    charter:'Georgia',               utopia:'Times New Roman',
    stix:'Times New Roman',          stixmath:'Cambria Math',
    newcenturyschoolbook:'Georgia',  palatinolt:'Georgia',

    // Helvetica / Arial / Sans
    helvetica:'Arial',               helveticaneue:'Arial',
    helveticalt:'Arial',             helveticainserat:'Arial',
    arial:'Arial',                   arialmt:'Arial',
    arialnarrow:'Arial Narrow',      arialbold:'Arial',
    myriadpro:'Arial',               myriad:'Arial',
    frutiger:'Arial',                franklingothic:'Arial',
    futura:'Arial',                  optima:'Arial',
    gillsans:'Arial',                trebuchet:'Trebuchet MS',
    trebuchetms:'Trebuchet MS',      tahoma:'Tahoma',
    verdana:'Verdana',               lucidagrandepro:'Tahoma',
    segoeui:'Arial',                 corbel:'Calibri',

    // Calibri / Office
    calibri:'Calibri',               calibril:'Calibri',
    candara:'Calibri',               calibrib:'Calibri',

    // Courier / Mono
    courier:'Courier New',           couriernew:'Courier New',
    couriermt:'Courier New',         courierprime:'Courier New',
    consolas:'Courier New',          inconsolata:'Courier New',
    lucidaconsole:'Courier New',     anonymouspro:'Courier New',
    sourcecodepro:'Courier New',     lucidamono:'Courier New',
    dejavusansmono:'Courier New',    ubuntumono:'Courier New',

    // CJK / Multilingual
    simsun:'SimSun',                 simhei:'SimHei',
    microsoftyahei:'Microsoft YaHei',
    notoserif:'Times New Roman',     notosans:'Arial',
    notosanscjk:'Microsoft YaHei',   cjkunipro:'SimSun',

    // Arabic / Hebrew / RTL
    arabictypesetting:'Arial',       scheherazade:'Arial',
    amiri:'Arial',                   nazli:'Arial',
    koodak:'Arial',                  traditionalarabic:'Arial',
    simplifiedarabic:'Arial',        davidmt:'Arial',
    david:'Arial',                   miriam:'Arial',

    // Symbol / Wingdings
    symbol:'Symbol',                 wingdings:'Wingdings',
    webdings:'Wingdings',            zapfdingbats:'Wingdings',

    // Special
    cambriamath:'Cambria Math',      lucidabright:'Georgia',
  };

  // ── Weight / style keywords ───────────────────────────────────────────────
  const BOLD_RE   = /bold|heavy|black|demi|semibold|ultrabold|extrabold|medium|w[5-9]\d{2}|700|800|900/i;
  const ITALIC_RE = /italic|oblique|slanted|inclined/i;
  const LIGHT_RE  = /light|thin|hairline|extralight|ultralight|w[1-3]\d{2}|100|200|300/i;
  const MONO_RE   = /mono|courier|consol|typewriter|inconsolata|sourcecodepro|anonymouspro|ubuntumono|dejavusans.*mono/i;
  const CAPS_RE   = /smallcaps|sc$/i;

  /**
   * Parse a raw PDF fontName into { family, bold, italic, mono, light, smallCaps }
   */
  function parseFont(rawName) {
    if (!rawName) return _defaultFont();

    // Strip common PDF subset prefix (ABCDEF+FontName)
    const stripped = rawName.replace(/^[A-Z]{6}\+/, '').trim();
    const lower    = stripped.toLowerCase();

    const bold      = BOLD_RE.test(stripped);
    const italic    = ITALIC_RE.test(stripped);
    const mono      = MONO_RE.test(lower);
    const light     = LIGHT_RE.test(stripped);
    const smallCaps = CAPS_RE.test(lower);

    // Normalise to key: remove separators and modifiers
    const baseKey = lower
      .replace(/[-_,\s]+/g, '')
      .replace(/bold|heavy|black|demi|semibold|ultrabold|extrabold|medium/g, '')
      .replace(/italic|oblique|slanted/g, '')
      .replace(/light|thin|hairline/g, '')
      .replace(/regular|normal|roman|upright/g, '')
      .replace(/mt$|ps$|lf$|lt$|of$|bf$|condensed|cond|extended|ext|narrow|wide|pro$|std$|offc$|sc$/g, '')
      .trim();

    let family = FAMILY_MAP[baseKey];

    // Fallback: try longest prefix match
    if (!family) {
      let best = '';
      for (const key of Object.keys(FAMILY_MAP)) {
        if ((baseKey.startsWith(key) || key.startsWith(baseKey)) && key.length > best.length) {
          best = key;
        }
      }
      if (best) family = FAMILY_MAP[best];
    }

    // Final fallback: infer from characteristics
    if (!family) {
      if (mono)                        family = 'Courier New';
      else if (/serif/i.test(stripped)) family = 'Times New Roman';
      else if (/sans/i.test(stripped))  family = 'Arial';
      else                              family = 'Calibri';
    }

    return { family, bold, italic, mono, light, smallCaps };
  }

  /** Map PDF font size (points) → OOXML half-points, clamped to sensible range */
  function mapFontSize(pts, basePt) {
    if (!pts || pts <= 0) return Math.round((basePt || 11) * 2);
    return Math.round(Math.max(12, Math.min(192, pts)) * 2); // 6pt–96pt in half-points
  }

  /** Generate OOXML <w:rFonts> element for a family */
  function rFontsXml(family) {
    const f  = family || 'Calibri';
    const cs = /arabic|hebrew|urdu|persian|thai|devanagari|cjk|han|chinese|japanese|korean/i.test(f) ? f : 'Arial';
    return `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${cs}" w:eastAsia="${f}"/>`;
  }

  /** Heading level → brand colour */
  function headingColor(level) {
    return (['1F3864', '2E4057', '404040'])[level - 1] || '374151';
  }

  function _defaultFont() {
    return { family: 'Calibri', bold: false, italic: false, mono: false, light: false, smallCaps: false };
  }

  window.PDFPipeline.FontMapper = { parseFont, mapFontSize, rFontsXml, headingColor };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[FontMapper] v1.0 loaded —', Object.keys(FAMILY_MAP).length, 'font mappings');
  }
})();
