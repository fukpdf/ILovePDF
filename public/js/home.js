/* Homepage-only logic — tools grid, calculators, mobile toggle, currency converter.
   Header + drawer + auth modal live in chrome.js (loaded on every page). */

// All in-app navigation uses /tool.html?id=<internal-id>. This works both on
// the Node backend and on Firebase Hosting (which serves tool.html directly).
const homeToolUrl = t => `/tool.html?id=${t.tid}`;

/* ----------------------- render tools grid ----------------------- */
function renderTools(){
  const root = document.getElementById('tools-root');
  if (!root || !window.TOOL_GROUPS) return;
  root.innerHTML = window.TOOL_GROUPS.map(g => `
    <section class="cat-block" id="cat-${g.key}">
      <div class="cat-title">${g.title}</div>
      <div class="tools-grid">
        ${g.items.map(t => `
          <a class="tool" data-cat="${g.key}" href="${homeToolUrl(t)}">
            <span class="tool-ico"><i data-lucide="${t.icon}"></i></span>
            <h4>${t.name}</h4>
            <p>${t.desc}</p>
          </a>
        `).join('')}
      </div>
    </section>
  `).join('');
}

/* ----------------------- mobile calculator toggle ----------------------- */
function wireCalcToggle(){
  const btn  = document.getElementById('calc-toggle');
  const slot = document.getElementById('calc-mobile-slot');
  const sticky = document.querySelector('.rail-sticky');
  if (!btn || !slot || !sticky) return;
  btn.addEventListener('click', () => {
    const open = !btn.classList.contains('open');
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) Array.from(sticky.children).forEach(c => slot.appendChild(c));
    else      Array.from(slot.children).forEach(c => sticky.appendChild(c));
  });
}

/* ----------------------- numbers-to-words calculator ----------------------- */
function wireCalc(){
  const input    = document.getElementById('calc-input');
  const btn      = document.getElementById('calc-go');
  const out      = document.getElementById('calc-out');
  const currency = document.getElementById('calc-currency');
  const modes    = document.querySelectorAll('.calc-mode');
  if (!input || !btn) return;

  const caseSel = document.getElementById('calc-case');
  const wrap    = document.getElementById('calc-out-wrap');
  const copyBtn = document.getElementById('calc-copy');

  let mode = 'words';
  let lastNumber = '';

  modes.forEach(m => {
    m.addEventListener('click', () => {
      modes.forEach(x => x.classList.remove('active'));
      m.classList.add('active');
      mode = m.dataset.mode;
      currency.classList.toggle('show', mode === 'currency');
    });
  });

  const run = () => {
    const val = (input.value || '').trim();
    out.classList.remove('err');
    if (wrap) wrap.hidden = false;
    if (!val) { out.textContent = 'Please enter a number.'; out.classList.add('err'); return; }
    if (typeof window.convertNumberToWords !== 'function') {
      out.textContent = 'Converter is loading…'; out.classList.add('err'); return;
    }
    lastNumber = val;
    const res = window.convertNumberToWords(val, {
      mode, currency: currency.value,
      letterCase: caseSel ? caseSel.value : 'lowercase',
    });
    if (res.error) { out.textContent = res.error; out.classList.add('err'); return; }
    // Always append " Only" so it's part of both display and copy.
    out.textContent = res.text.replace(/\s+$/, '') + ' Only';
  };

  btn.addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  // Re-apply case INSTANTLY when dropdown changes (no Convert click required)
  if (caseSel) {
    caseSel.addEventListener('change', () => { if (lastNumber) run(); });
  }

  // Copy button
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = out.textContent || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      const span = copyBtn.querySelector('span');
      const orig = span.textContent;
      span.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { span.textContent = orig; copyBtn.classList.remove('copied'); }, 1400);
    });
  }
}

/* ----------------------- live currency converter (160+ currencies) ----------------------- */
const FX_LIST = [
  ['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['JPY','Japanese Yen'],
  ['CNY','Chinese Yuan'],['INR','Indian Rupee'],['PKR','Pakistani Rupee'],
  ['AED','UAE Dirham'],['SAR','Saudi Riyal'],['QAR','Qatari Riyal'],
  ['KWD','Kuwaiti Dinar'],['BHD','Bahraini Dinar'],['OMR','Omani Rial'],
  ['JOD','Jordanian Dinar'],['LBP','Lebanese Pound'],['SYP','Syrian Pound'],
  ['IRR','Iranian Rial'],['IQD','Iraqi Dinar'],['YER','Yemeni Rial'],
  ['AFN','Afghan Afghani'],['CAD','Canadian Dollar'],['AUD','Australian Dollar'],
  ['NZD','New Zealand Dollar'],['CHF','Swiss Franc'],['SEK','Swedish Krona'],
  ['NOK','Norwegian Krone'],['DKK','Danish Krone'],['ISK','Icelandic Krona'],
  ['PLN','Polish Zloty'],['CZK','Czech Koruna'],['HUF','Hungarian Forint'],
  ['RON','Romanian Leu'],['BGN','Bulgarian Lev'],['HRK','Croatian Kuna'],
  ['RSD','Serbian Dinar'],['UAH','Ukrainian Hryvnia'],['BYN','Belarusian Ruble'],
  ['RUB','Russian Ruble'],['TRY','Turkish Lira'],['ILS','Israeli Shekel'],
  ['EGP','Egyptian Pound'],['MAD','Moroccan Dirham'],['DZD','Algerian Dinar'],
  ['TND','Tunisian Dinar'],['LYD','Libyan Dinar'],['SDG','Sudanese Pound'],
  ['ETB','Ethiopian Birr'],['KES','Kenyan Shilling'],['UGX','Ugandan Shilling'],
  ['TZS','Tanzanian Shilling'],['NGN','Nigerian Naira'],['GHS','Ghanaian Cedi'],
  ['ZAR','South African Rand'],['BWP','Botswana Pula'],['NAD','Namibian Dollar'],
  ['MUR','Mauritian Rupee'],['XOF','CFA Franc BCEAO'],['XAF','CFA Franc BEAC'],
  ['SGD','Singapore Dollar'],['MYR','Malaysian Ringgit'],['THB','Thai Baht'],
  ['IDR','Indonesian Rupiah'],['VND','Vietnamese Dong'],['PHP','Philippine Peso'],
  ['HKD','Hong Kong Dollar'],['TWD','Taiwan Dollar'],['KRW','South Korean Won'],
  ['MNT','Mongolian Tugrik'],['KZT','Kazakhstani Tenge'],['UZS','Uzbekistani Som'],
  ['AZN','Azerbaijani Manat'],['GEL','Georgian Lari'],['AMD','Armenian Dram'],
  ['BDT','Bangladeshi Taka'],['LKR','Sri Lankan Rupee'],['NPR','Nepalese Rupee'],
  ['MMK','Myanmar Kyat'],['KHR','Cambodian Riel'],['LAK','Lao Kip'],
  ['BND','Brunei Dollar'],['MOP','Macanese Pataca'],['MVR','Maldivian Rufiyaa'],
  ['BRL','Brazilian Real'],['MXN','Mexican Peso'],['ARS','Argentine Peso'],
  ['CLP','Chilean Peso'],['COP','Colombian Peso'],['PEN','Peruvian Sol'],
  ['UYU','Uruguayan Peso'],['VES','Venezuelan Bolivar'],['BOB','Bolivian Boliviano'],
  ['PYG','Paraguayan Guarani'],['CRC','Costa Rican Colon'],['GTQ','Guatemalan Quetzal'],
  ['HNL','Honduran Lempira'],['NIO','Nicaraguan Cordoba'],['PAB','Panamanian Balboa'],
  ['DOP','Dominican Peso'],['CUP','Cuban Peso'],['JMD','Jamaican Dollar'],
  ['TTD','Trinidad Dollar'],['BBD','Barbados Dollar'],['BSD','Bahamian Dollar'],
  ['XCD','East Caribbean Dollar'],['HTG','Haitian Gourde'],
  ['ALL','Albanian Lek'],['MKD','Macedonian Denar'],['BAM','Bosnia Mark'],
  ['MDL','Moldovan Leu'],['ZMW','Zambian Kwacha'],['MWK','Malawian Kwacha'],
  ['AOA','Angolan Kwanza'],['MZN','Mozambican Metical'],['MGA','Malagasy Ariary'],
  ['SCR','Seychellois Rupee'],['RWF','Rwandan Franc'],['BIF','Burundian Franc'],
  ['CDF','Congolese Franc'],['DJF','Djiboutian Franc'],['SOS','Somali Shilling'],
  ['SLL','Sierra Leone Leone'],['LRD','Liberian Dollar'],['GMD','Gambian Dalasi'],
  ['CVE','Cape Verde Escudo'],['STN','São Tomé Dobra'],['SZL','Swazi Lilangeni'],
  ['LSL','Lesotho Loti'],['ZWL','Zimbabwean Dollar'],
  ['FJD','Fijian Dollar'],['PGK','Papua New Guinea Kina'],['SBD','Solomon Islands Dollar'],
  ['VUV','Vanuatu Vatu'],['WST','Samoan Tala'],['TOP','Tongan Paʻanga'],
  ['XPF','CFP Franc'],['ANG','Netherlands Antillean Guilder'],['AWG','Aruban Florin'],
  ['SRD','Suriname Dollar'],['GYD','Guyanese Dollar'],['BZD','Belize Dollar'],
  ['KGS','Kyrgyzstani Som'],['TJS','Tajikistani Somoni'],['TMT','Turkmenistani Manat'],
  ['BTN','Bhutanese Ngultrum'],
  ['XAU','Gold (oz)'],['XAG','Silver (oz)'],['XDR','IMF SDR'],
  ['BTC','Bitcoin'],['ETH','Ethereum'],['USDT','Tether'],['BNB','BNB'],['XRP','XRP'],
];

/* Static fallback (rates per 1 USD, approx). Used only if all APIs fail. */
const FX_STATIC = {
  usd:1, eur:0.92, gbp:0.79, jpy:155.0, chf:0.88, cad:1.36, aud:1.52, nzd:1.65,
  cny:7.25, hkd:7.82, twd:32.0, krw:1370, sgd:1.34, myr:4.7, thb:36.0, idr:15800,
  vnd:25400, php:57.0, inr:83.4, pkr:278.0, bdt:117, lkr:300.0, npr:133.0, mmk:2100,
  khr:4100, lak:21000, bnd:1.34, mop:8.06, mvr:15.4, btn:83.4,
  aed:3.67, sar:3.75, qar:3.64, kwd:0.307, bhd:0.376, omr:0.385, jod:0.709,
  lbp:89500, syp:13000, irr:42000, iqd:1310, yer:250, afn:71.0, ils:3.7, try:32.5,
  egp:48.5, mad:9.95, dzd:134.0, tnd:3.13, lyd:4.85, sdg:601, etb:57.0, kes:129,
  ugx:3760, tzs:2680, ngn:1480, ghs:14.5, zar:18.6, bwp:13.6, nad:18.6, mur:46.0,
  xof:603, xaf:603, sek:10.6, nok:10.8, dkk:6.85, isk:139, pln:3.95, czk:23.2,
  huf:362, ron:4.58, bgn:1.80, hrk:6.93, rsd:108, uah:39.5, byn:3.27, rub:92.0,
  mnt:3380, kzt:475, uzs:12700, azn:1.70, gel:2.70, amd:388, kgs:88.5, tjs:10.9, tmt:3.5,
  brl:5.05, mxn:17.1, ars:870, clp:945, cop:4080, pen:3.78, uyu:39.5, ves:36.5,
  bob:6.91, pyg:7300, crc:512, gtq:7.78, hnl:24.7, nio:36.7, pab:1, dop:58.5,
  cup:24, jmd:155, ttd:6.78, bbd:2, bsd:1, xcd:2.7, htg:132, ang:1.79, awg:1.8,
  srd:33.5, gyd:209, bzd:2.01,
  all:93.8, mkd:56.7, bam:1.80, mdl:17.5, zmw:25.8, mwk:1730, aoa:830, mzn:63.9,
  mga:4500, scr:13.6, rwf:1300, bif:2860, cdf:2780, djf:178, sos:571, sll:22000,
  lrd:188, gmd:67.5, cve:101, stn:22.6, szl:18.6, lsl:18.6, zwl:13.5,
  fjd:2.25, pgk:3.92, sbd:8.4, vuv:120, wst:2.74, top:2.36, xpf:109,
  xau:0.00043, xag:0.034, xdr:0.755,
  btc:0.0000156, eth:0.00033, usdt:1.0, bnb:0.0017, xrp:1.96
};

let FX_RATES = null;
let FX_FALLBACK_USED = false;

const fetchTimeout = (url, ms = 5000) => new Promise((resolve, reject) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, ms);
  fetch(url, { cache:'no-cache', signal: ctrl.signal })
    .then(r => { clearTimeout(timer); r.ok ? resolve(r) : reject(new Error(r.status)); })
    .catch(err => { clearTimeout(timer); reject(err); });
});

async function loadRates(){
  const sources = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    'https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/usd.json'
  ];
  for (const url of sources) {
    try {
      const r = await fetchTimeout(url, 5000);
      const data = await r.json();
      if (data && data.usd && typeof data.usd === 'object') return data.usd;
    } catch (e) { /* try next */ }
  }
  FX_FALLBACK_USED = true;
  return FX_STATIC;
}

function fxConvert(amount, from, to){
  if (!FX_RATES) return null;
  const fromR = from === 'USD' ? 1 : FX_RATES[from.toLowerCase()];
  const toR   = to   === 'USD' ? 1 : FX_RATES[to.toLowerCase()];
  if (!fromR || !toR) return null;
  return (amount / fromR) * toR;
}
function fmtMoney(v, code){
  try { return new Intl.NumberFormat(undefined, { style:'currency', currency:code, maximumFractionDigits:4 }).format(v); }
  catch { return v.toFixed(4) + ' ' + code; }
}

async function wireFx(){
  const amount = document.getElementById('fx-amount');
  const from   = document.getElementById('fx-from');
  const to     = document.getElementById('fx-to');
  const swap   = document.getElementById('fx-swap');
  const goBtn  = document.getElementById('fx-go');
  const result = document.getElementById('fx-result');
  const rate   = document.getElementById('fx-rate');
  if (!amount || !from || !to) return;

  // Populate dropdowns IMMEDIATELY (independent of rate fetch).
  const opts = FX_LIST.map(([c,n]) => `<option value="${c}">${c} — ${n}</option>`).join('');
  from.innerHTML = opts; to.innerHTML = opts;
  from.value = 'USD'; to.value = 'EUR';

  const update = () => {
    const a = parseFloat(amount.value);
    if (!isFinite(a) || a < 0) { result.textContent = '—'; rate.textContent = 'Enter a valid amount.'; return; }
    if (!FX_RATES) { result.textContent = '—'; rate.textContent = 'Loading rates…'; return; }
    const v = fxConvert(a, from.value, to.value);
    if (v === null) { result.textContent = '—'; rate.textContent = 'Rate unavailable for this pair.'; return; }
    result.textContent = fmtMoney(v, to.value);
    const one = fxConvert(1, from.value, to.value);
    const note = FX_FALLBACK_USED ? '  (offline rates)' : '';
    rate.textContent = `1 ${from.value} = ${one.toFixed(4)} ${to.value}${note}`;
  };

  [amount, from, to].forEach(el => el.addEventListener('input', update));
  [from, to].forEach(el => el.addEventListener('change', update));
  swap.addEventListener('click', () => { const t = from.value; from.value = to.value; to.value = t; update(); });
  goBtn && goBtn.addEventListener('click', update);

  rate.textContent = 'Loading rates…';
  const timeout = new Promise(res => setTimeout(() => { FX_FALLBACK_USED = true; res(FX_STATIC); }, 6000));
  FX_RATES = await Promise.race([loadRates(), timeout]);
  update();
}

document.addEventListener('DOMContentLoaded', () => {
  renderTools();
  wireCalc();
  wireCalcToggle();
  wireFx();
  const tryIcons = () => window.lucide && window.lucide.createIcons && window.lucide.createIcons();
  tryIcons();
  setTimeout(tryIcons, 150);
  setTimeout(tryIcons, 700);
});
