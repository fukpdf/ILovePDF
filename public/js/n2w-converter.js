// Numbers-to-Words converter — supports 300+ digit integers, decimals, scientific
// notation, multiple currencies, check-writing format, and case styles.

const ONES = ['', 'one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

// Scales — supports up to 10^102 (centillion). For larger numbers we synthesise
// a generic name like "10^N units".
const SCALES = [
  '', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion',
  'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion', 'undecillion',
  'duodecillion', 'tredecillion', 'quattuordecillion', 'quindecillion',
  'sexdecillion', 'septendecillion', 'octodecillion', 'novemdecillion',
  'vigintillion', 'unvigintillion', 'duovigintillion', 'tresvigintillion',
  'quattuorvigintillion', 'quinvigintillion', 'sesvigintillion', 'septemvigintillion',
  'octovigintillion', 'novemvigintillion', 'trigintillion', 'untrigintillion',
  'duotrigintillion', 'centillion'
];

const CURRENCIES = {
  USD: { major: 'dollar',  minor: 'cent',     symbol: '$' },
  EUR: { major: 'euro',    minor: 'cent',     symbol: '€' },
  GBP: { major: 'pound',   minor: 'penny',    minorPlural: 'pence', symbol: '£' },
  INR: { major: 'rupee',   minor: 'paisa',    minorPlural: 'paise', symbol: '₹' },
  JPY: { major: 'yen',     minor: 'sen',      symbol: '¥' },
  CNY: { major: 'yuan',    minor: 'fen',      symbol: '¥' },
  AUD: { major: 'dollar',  minor: 'cent',     symbol: 'A$' },
  CAD: { major: 'dollar',  minor: 'cent',     symbol: 'C$' },
};

// ── Public API ─────────────────────────────────────────────────────────────
function convertNumberToWords(rawInput, opts = {}) {
  const mode      = opts.mode      || 'words';      // words | currency | check
  const currency  = opts.currency  || 'USD';
  const suffix    = opts.suffix    || 'exactly';    // exactly | only
  const letter    = opts.letterCase|| 'lowercase';  // lowercase | UPPERCASE | Title Case | Sentence Case

  const parsed = parseInputNumber(rawInput);
  if (!parsed) return { error: 'Please enter a valid number.' };

  let text;
  if (mode === 'currency' || mode === 'check') {
    text = formatCurrency(parsed, currency, mode === 'check', suffix);
  } else {
    text = formatNumberWords(parsed);
  }
  return { text: applyCase(text, letter) };
}

// ── Input parsing — handles plain ints, decimals, scientific notation ─────
function parseInputNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim().replace(/[, _]/g, '');
  if (!str) return null;

  // Scientific notation, e.g. "1.23e10" or "5E-4"
  const sciMatch = /^(-?)(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/.exec(str);
  if (sciMatch) {
    const sign = sciMatch[1] === '-' ? '-' : '';
    const mantissa = sciMatch[2];
    const exp = parseInt(sciMatch[3], 10);
    const expanded = expandScientific(mantissa, exp);
    return splitDecimal(sign + expanded);
  }

  // Plain integer / decimal
  if (!/^-?\d+(\.\d+)?$/.test(str)) return null;
  return splitDecimal(str);
}

function splitDecimal(str) {
  const negative = str.startsWith('-');
  const body = negative ? str.slice(1) : str;
  const [intPart, fracPart = ''] = body.split('.');
  return {
    negative,
    intPart: intPart.replace(/^0+(?=\d)/, '') || '0',
    fracPart,
  };
}

function expandScientific(mantissa, exp) {
  let [intPart, fracPart = ''] = mantissa.split('.');
  if (exp >= 0) {
    if (fracPart.length <= exp) {
      return intPart + fracPart + '0'.repeat(exp - fracPart.length);
    }
    return intPart + fracPart.slice(0, exp) + '.' + fracPart.slice(exp);
  } else {
    const shift = -exp;
    if (intPart.length > shift) {
      return intPart.slice(0, intPart.length - shift) + '.' + intPart.slice(intPart.length - shift) + fracPart;
    }
    return '0.' + '0'.repeat(shift - intPart.length) + intPart + fracPart;
  }
}

// ── Number → words ─────────────────────────────────────────────────────────
function intToWords(intStr) {
  intStr = intStr.replace(/^0+(?=\d)/, '') || '0';
  if (intStr === '0') return 'zero';

  // Split into groups of 3 from right
  const groups = [];
  for (let i = intStr.length; i > 0; i -= 3) {
    groups.unshift(intStr.slice(Math.max(0, i - 3), i));
  }
  // Highest scale we need = groups.length - 1
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const n = parseInt(groups[i], 10);
    if (n === 0) continue;
    const scaleIdx = groups.length - 1 - i;
    const scaleName = scaleIdx < SCALES.length
      ? SCALES[scaleIdx]
      : `times ten to the ${scaleIdx * 3}th power`;
    const chunk = chunkUnder1000(n);
    out.push(scaleName ? `${chunk} ${scaleName}` : chunk);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function chunkUnder1000(n) {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
  }
  const h = Math.floor(n / 100), rest = n % 100;
  return rest ? `${ONES[h]} hundred ${chunkUnder1000(rest)}` : `${ONES[h]} hundred`;
}

function formatNumberWords({ negative, intPart, fracPart }) {
  let txt = intToWords(intPart);
  if (fracPart && /[1-9]/.test(fracPart)) {
    // Speak fractional digit-by-digit ("point two three")
    const digitWords = fracPart.split('').map(d => ONES[parseInt(d, 10)] || 'zero');
    txt += ' point ' + digitWords.join(' ');
  }
  if (negative) txt = 'negative ' + txt;
  return txt;
}

// ── Currency / check formatting ────────────────────────────────────────────
function formatCurrency({ negative, intPart, fracPart }, code, checkStyle, suffix) {
  const cur = CURRENCIES[code] || CURRENCIES.USD;
  const minorPlural = cur.minorPlural || (cur.minor + 's');
  const majorPlural = cur.major + 's';

  // Round/pad fractional to 2 digits
  let cents = 0;
  if (fracPart) {
    const padded = (fracPart + '00').slice(0, 2);
    cents = parseInt(padded, 10);
    // Banker round if there's a 3rd digit ≥5
    if (fracPart.length > 2 && parseInt(fracPart[2], 10) >= 5) cents += 1;
    if (cents === 100) {
      cents = 0;
      intPart = addOneToBigInt(intPart);
    }
  }
  const majorWord = (intPart === '1') ? cur.major : majorPlural;
  const minorWord = (cents === 1) ? cur.minor : minorPlural;

  if (checkStyle) {
    // Standard check format: "One thousand two hundred and 34/100 dollars only"
    const intWords = intToWords(intPart);
    const centsStr = String(cents).padStart(2, '0');
    let body = `${intWords} and ${centsStr}/100 ${majorWord}`;
    if (suffix === 'only')   body += ' only';
    if (suffix === 'exactly' && cents === 0) body += ' exactly';
    return (negative ? 'negative ' : '') + body;
  }

  let body = `${intToWords(intPart)} ${majorWord}`;
  if (cents > 0) body += ` and ${intToWords(String(cents))} ${minorWord}`;
  if (suffix === 'only')                       body += ' only';
  if (suffix === 'exactly' && cents === 0)     body += ' exactly';
  return (negative ? 'negative ' : '') + body;
}

function addOneToBigInt(s) {
  const arr = s.split('').map(d => parseInt(d, 10));
  let carry = 1;
  for (let i = arr.length - 1; i >= 0 && carry; i--) {
    const sum = arr[i] + carry;
    arr[i] = sum % 10;
    carry = Math.floor(sum / 10);
  }
  if (carry) arr.unshift(carry);
  return arr.join('');
}

// ── Letter casing ──────────────────────────────────────────────────────────
function applyCase(text, mode) {
  switch (mode) {
    case 'UPPERCASE':    return text.toUpperCase();
    case 'Title Case':   return text.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
    case 'Sentence Case':return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    case 'lowercase':
    default:             return text.toLowerCase();
  }
}

window.convertNumberToWords = convertNumberToWords;
