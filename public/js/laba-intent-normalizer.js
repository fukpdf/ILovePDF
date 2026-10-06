/**
 * LABA Intent Normalizer v1.0
 * Task 13 — multilingual / natural-language tool intent normalization.
 * Purely client-side. No network, no translation service, no secrets.
 * Converts common multilingual/Roman-Urdu request phrases to canonical English
 * intent tokens before deterministic tool classification/option extraction.
 */
(function (G) {
  'use strict';
  if (G.LabaIntentNormalizer) return;

  var MAP = [
    // Roman Urdu / Urdu-script common action phrases.
    [/\b(?:merge|combine)\s+(?:kar(?:o|do|den|de)|kardo|krdo|krna|karna)\b/gi, ' merge '],
    [/\b(?:mil[a-z]*|j[o]+r)(?:\s+do)?\b/gi, ' merge '],
    [/\b(?:split|separate|divide)\s+(?:kar(?:o|do|den|de)|kardo|krdo|krna|karna)\b/gi, ' split '],
    [/\b(?:compress|size\s+kam)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' compress '],
    [/\b(?:rotate|ghuma|ghuma[oao])\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)?\b/gi, ' rotate '],
    [/\b(?:watermark|stamp)\s+(?:laga|lagao|lagado|kar(?:o|do|den|de)|kardo|krdo)\b/gi, ' watermark '],
    [/\b(?:protect|secure|password\s+laga)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' protect '],
    [/\b(?:unlock|password\s+remove|lock\s+remove)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' unlock '],
    [/\b(?:redact|sensitive\s+text\s+hide)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' redact '],
    [/\b(?:repair|theek|fix)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' repair '],
    [/\b(?:sign|signature)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' sign '],
    [/\b(?:ocr|text\s+n[aik]+al)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' ocr '],
    [/\b(?:background|bg)\s+(?:remove|hata)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)?\b/gi, ' remove background '],
    [/\b(?:crop)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' crop image '],
    [/\b(?:resize|size\s+change)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' resize image '],
    [/\b(?:enhance|filter)\s+(?:kar(?:o|do|den|de)|kardo|krdo|karna|krna)\b/gi, ' filter image '],

    // Additional canonical tool intents.
    [/\b(?:convert|export)\s+(?:to\s+)?word\b/gi, ' pdf to word '],
    [/\b(?:convert|export)\s+(?:to\s+)?powerpoint|pptx?\b/gi, ' pdf to powerpoint '],
    [/\b(?:convert|export)\s+(?:to\s+)?excel|xlsx?\b/gi, ' pdf to excel '],
    [/\b(?:convert|export)\s+(?:to\s+)?pdf\b/gi, ' to pdf '],
    [/\b(?:word|docx)\s+(?:to|mein|me)\s+pdf\b/gi, ' word to pdf '],
    [/\b(?:powerpoint|pptx?)\s+(?:to|mein|me)\s+pdf\b/gi, ' powerpoint to pdf '],
    [/\b(?:excel|xlsx?)\s+(?:to|mein|me)\s+pdf\b/gi, ' excel to pdf '],
    [/\b(?:word|docx)\s+(?:to|mein|me)\s+excel\b/gi, ' word to excel '],
    [/\b(?:jpg|jpeg|image|photo)\s+(?:to|mein|me)\s+pdf\b/gi, ' jpg to pdf '],
    [/\bhtml\s+(?:to|mein|me)\s+pdf\b/gi, ' html to pdf '],
    [/\b(?:edit|modify|change)\s+(?:the\s+)?pdf\b/gi, ' edit pdf '],
    [/\b(?:page\s+numbers?|number\s+pages?)\b/gi, ' page numbers '],
    [/\b(?:summari[sz]e|summary)\b/gi, ' ai summarize '],
    [/\btranslate\b/gi, ' translate '],
    [/\bcompare\b/gi, ' compare '],
    [/\bworkflow\b/gi, ' workflow '],
    [/\b(?:organize|reorder)\s+(?:pages?|pdf)\b/gi, ' organize '],
    [/\b(?:numbers?\s+to\s+words?|amount\s+in\s+words?)\b/gi, ' numbers to words '],
    [/\b(?:currency|exchange\s+rate|convert\s+currency)\b/gi, ' currency converter '],
    [/\bimage\s+compress(?:or|ion)?\b/gi, ' image compressor '],
    [/\bimage\s+convert(?:er|ion)?\b/gi, ' image converter '],
    [/\bqr\s+(?:code\s+)?generator\b/gi, ' qr code generator '],
    [/\bbarcode\s+generator\b/gi, ' barcode generator '],
    [/\bzip\s+(?:builder|maker|creator)\b/gi, ' zip builder '],

    // Urdu script: conservative phrases only; never send this mapping to a server.
    [/ضم کریں/g, ' merge '],
    [/تقسیم کریں/g, ' split '],
    [/کمپریس کریں/g, ' compress '],
    [/گھمائیں/g, ' rotate '],
    [/واٹر مارک لگائیں/g, ' watermark '],
    [/محفوظ کریں/g, ' protect '],
    [/پاسورڈ ہٹائیں/g, ' unlock '],
    [/ریڈیکٹ کریں/g, ' redact '],
    [/مرمت کریں/g, ' repair '],
    [/دستخط کریں/g, ' sign '],
    [/پس منظر ہٹائیں/g, ' remove background ']
  ];

  function normalize(text) {
    var out = String(text || '');
    for (var i = 0; i < MAP.length; i++) out = out.replace(MAP[i][0], MAP[i][1]);
    return out.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  G.LabaIntentNormalizer = { version: '1.0', normalize: normalize };
})(window);
