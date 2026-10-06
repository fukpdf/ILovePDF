/**
 * Laba AI — Structured Tool Options & Clarification Engine (Task 11)
 *
 * Converts natural-language tool requests into validated, bounded options.
 * Pure client-side utility; never logs sensitive option values.
 */
(function (G) {
  'use strict';
  if (G.LabaToolOptions) return;

  var SCHEMAS = {
    rotate: { fields: {
      degrees: { type:'enum', values:['90','180','270'], required:true },
      pages: { type:'pages', default:'all' }
    }},
    split: { fields: { range:{type:'range', default:'all'} } },
    watermark: { fields: {
      text:{type:'text', required:true, max:120},
      opacity:{type:'number', min:0.1, max:0.9, default:0.3},
      position:{type:'enum', values:['center','top-left','top-right','bottom-left','bottom-right'], default:'center'}
    }},
    sign: { fields: {
      signatureText:{type:'text', required:true, max:120},
      page:{type:'positiveInt', optional:true}
    }},
    protect: { fields: { password:{type:'secret', required:true, min:4, max:128} } },
    unlock: { fields: { password:{type:'secret', optional:true, max:128} } },
    edit: { fields: {
      text:{type:'text', required:true, max:500}, x:{type:'number', min:0, max:100, default:50},
      y:{type:'number', min:0, max:100, default:50}, fontSize:{type:'number', min:4, max:144, default:14}, page:{type:'pages', default:'1'}
    }},
    redact: { fields: {
      x:{type:'number',min:0,max:100,default:10}, y:{type:'number',min:0,max:100,default:40},
      width:{type:'number',min:0.1,max:100,default:30}, height:{type:'number',min:0.1,max:100,default:10}, pages:{type:'pages',default:'1'}
    }},
    'page-numbers': { fields: {
      position:{type:'enum',values:['bottom-center','bottom-right','bottom-left','top-center','top-right','top-left'],default:'bottom-center'},
      startFrom:{type:'positiveInt',default:1}
    }},
    'pdf-to-word': { fields: {
      structureMode:{type:'enum',values:['preserve-layout','simple-text'],default:'preserve-layout'},
      ocrMode:{type:'enum',values:['auto','force'],default:'auto'}
    }},
    'pdf-to-powerpoint': { fields: {
      layout:{type:'enum',values:['16x9','4x3','wide','a4'],default:'16x9'},
      contentStrategy:{type:'enum',values:['smart','preserve','minimal','executive'],default:'smart'},
      theme:{type:'enum',values:['modern','corporate','minimal','dark','pitch','white'],default:'modern'},
      slideDensity:{type:'enum',values:['balanced','compact','spacious'],default:'balanced'},
      tableHandling:{type:'enum',values:['editable','split','image'],default:'editable'},
      ocrMode:{type:'enum',values:['auto','force','off'],default:'auto'}
    }},
    'pdf-to-jpg': { fields: { quality:{type:'enum',values:['standard','high'],default:'standard'} } },
    'powerpoint-to-pdf': { fields: {
      pageSize:{type:'enum',values:['presentation','A4','Letter','Legal','Tabloid'],default:'presentation'},
      margins:{type:'enum',values:['none','narrow','normal','wide'],default:'normal'},
      quality:{type:'enum',values:['balanced','print','small','retina'],default:'balanced'},
      handoutMode:{type:'enum',values:['1','2','4','6'],default:'1'},
      speakerNotes:{type:'enum',values:['ignore','append','below'],default:'ignore'},
      watermark:{type:'enum',values:['none','confidential','draft','do-not-copy'],default:'none'}
    }},
    'excel-to-pdf': { fields: {
      pageSize:{type:'enum',values:['A4','Letter','A3'],default:'A4'}, orientation:{type:'enum',values:['','portrait','landscape'],default:''},
      margins:{type:'enum',values:['normal','narrow','none'],default:'normal'}, scaling:{type:'enum',values:['fit-page','fit-width','actual'],default:'fit-page'}
    }},
    'html-to-pdf': { fields: {
      pageSize:{type:'enum',values:['a4','letter','a3','a5','legal','tabloid'],default:'a4'}, orientation:{type:'enum',values:['portrait','landscape'],default:'portrait'},
      margins:{type:'enum',values:['none','narrow','normal','wide'],default:'normal'}, printMode:{type:'enum',values:['exact','compact','ink-saver','presentation','book'],default:'exact'},
      background:{type:'enum',values:['on','off'],default:'on'}, pageBreak:{type:'enum',values:['smart','auto','avoid-all'],default:'smart'}, dpi:{type:'enum',values:['150','200','250'],default:'150'}
    }},
    'scan-to-pdf': { fields: {
      outputFormat:{type:'enum',values:['pdf','searchable-pdf','docx','txt'],default:'pdf'},
      ocrMode:{type:'enum',values:['balanced','fast','accurate','table-priority'],default:'balanced'},
      enhancement:{type:'enum',values:['auto','strong','contrast','table','light','none'],default:'auto'},
      language:{type:'enum',values:['eng','fra','deu','spa','ara','urd','chi_sim','jpn'],default:'eng'}
    }},
    ocr: { fields: {
      ocrMode:{type:'enum',values:['balanced','fast','accurate','layout-preserve','table-priority'],default:'balanced'},
      language:{type:'enum',values:['eng','fra','deu','spa','ita','por','rus','chi_sim','jpn','ara'],default:'eng'},
      outputFormat:{type:'enum',values:['docx','searchable-pdf','txt'],default:'searchable-pdf'},
      preprocessing:{type:'enum',values:['auto','contrast','bw','none'],default:'auto'}
    }},
    'ai-summarize': { fields: {
      summaryType:{type:'enum',values:['short','detailed','bullets','insights','executive'],default:'short'},
      outputFormat:{type:'enum',values:['txt','docx'],default:'txt'}
    }},
    translate: { fields: {
      outputFormat:{type:'enum',values:['pdf','txt','docx'],default:'pdf'},
      sourceLang:{type:'lang',default:'auto'}
    }},
    repair: { fields: {
      repairDepth:{type:'enum',values:['standard','fast','deep','maximum'],default:'standard'},
      outputMode:{type:'enum',values:['preserve','compatibility','print-safe','reduce-size'],default:'preserve'}
    }}
  };

  function norm(s) { return String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim(); }
  function textAfter(text, patterns) {
    for (var i=0;i<patterns.length;i++) { var m=text.match(patterns[i]); if(m && m[1]) return norm(m[1]); }
    return '';
  }
  function parsePages(s) {
    s=norm(s).toLowerCase();
    if (!s || s==='all' || s==='every page' || s==='all pages') return 'all';
    if (!/^(?:\d+\s*(?:-\s*\d+)?)(?:\s*,\s*\d+\s*(?:-\s*\d+)?)*$/.test(s)) return null;
    return s.replace(/\s+/g,'');
  }
  function parseRange(s) {
    s=norm(s).toLowerCase(); if(!s || s==='all') return 'all';
    if(!/^(?:\d+\s*(?:-\s*\d+)?)(?:\s*,\s*\d+\s*(?:-\s*\d+)?)*$/.test(s)) return null;
    return s.replace(/\s+/g,'');
  }
  function numberIn(v, f) { var n=Number(v); return Number.isFinite(n) && n>=f.min && n<=f.max ? n : null; }
  function enumValue(v,f) { v=norm(v).toLowerCase(); for(var i=0;i<f.values.length;i++) if(String(f.values[i]).toLowerCase()===v) return f.values[i]; return null; }

  function normalizeMultilingualOptionText(text) {
    var out = norm(text);
    out = out.replace(/(?:صفحے|صفحات|پیجز|پیج)\s*(?:نمبر|کی)?\s*(?:[:=]|میں|کے)?\s*/gi, ' pages: ');
    out = out.replace(/(\d+)\s*(?:سے|تا)\s*(\d+)/g, '$1-$2');
    out = out.replace(/(\d+)\s+se\s+(\d+)/gi, '$1-$2');
    out = out.replace(/(?:ڈگری|درجے|degree|degrees)\b/gi, ' degrees ');
    out = out.replace(/(?:watermark|stamp)\s+(?:ka|ki|ke)\s+(?:text|matn)\s*[:=]?\s*/gi, ' watermark text: ');
    out = out.replace(/(?:واٹر\s*مارک|واٹرمارک|پانی\s*کا\s*نشان)\s*(?:کا|کی|کے)?\s*(?:متن|ٹیکسٹ|text)?\s*(?:[:=]|ہے|لگائیں|لگاؤ)?\s*/gi, ' watermark text: ');
    out = out.replace(/(?:پاس\s*ورڈ|پاسورڈ|پاس کوڈ|password|passcode)\s*(?:[:=]|ہے|رکھیں|لگائیں|لگاؤ)?\s*/gi, ' password: ');
    out = out.replace(/(?:signature|sign)\s+(?:ka|ki|ke)\s+(?:naam|text)\s+(?:se|say)?\s*[:=]?\s*/gi, ' signature: ');
    out = out.replace(/دستخط\s+کے\s+نام\s+سے\s*[:=]?\s*/g, ' signature: ');
    out = out.replace(/دستخط\s+کے\s+ساتھ\s*[:=]?\s*/g, ' signature: ');
    out = out.replace(/(?:دستخط|سگنیچر)\s*(?:[:=])?\s*/gi, ' signature: ');
    out = out.replace(/signature\s+(?:as|with)\s*/gi, ' signature: ');
    out = out.replace(/signature\s*[:=]\s*/gi, ' signature: ');
    out = out.replace(/(?:گھمائیں|گھماو|گھماؤ)\s*/gi, ' rotate ');
    out = out.replace(/(?:محفوظ|لاک|قفل)\s*(?:کریں|کرنا|کر دو|لگائیں|لگاؤ)?/gi, ' protect ');
    out = out.replace(/(?:ہٹائیں|ہٹاؤ|مٹائیں|مٹاؤ)\s*(?:پاسورڈ|پاس\s*ورڈ)/gi, ' unlock ');
    out = out.replace(/(?:انگریزی|انگلش|english)/gi, ' eng ');
    out = out.replace(/(?:اردو|urdu)/gi, ' urd ');
    out = out.replace(/(?:عربی|عربى|arabic)/gi, ' ara ');
    out = out.replace(/(?:فرانسیسی|فرینچ|french)/gi, ' fra ');
    out = out.replace(/(?:جرمن|german)/gi, ' deu ');
    out = out.replace(/(?:ہسپانوی|سپینش|spanish)/gi, ' spa ');
    out = out.replace(/(?:اطالوی|اٹالین|italian)/gi, ' ita ');
    out = out.replace(/(?:پرتگالی|portuguese)/gi, ' por ');
    out = out.replace(/(?:روسی|russian)/gi, ' rus ');
    out = out.replace(/(?:چینی|chinese)/gi, ' chi_sim ');
    out = out.replace(/(?:جاپانی|japanese)/gi, ' jpn ');
    out = out.replace(/(?:پورٹریٹ|portrait)/gi, ' portrait ');
    out = out.replace(/(?:لینڈ اسکیپ|landscape)/gi, ' landscape ');
    out = out.replace(/(?:افقی|horizontal)/gi, ' landscape ');
    out = out.replace(/(?:عمودی|vertical)/gi, ' portrait ');
    out = out.replace(/(?:درمیان|center|centre)/gi, ' center ');
    return norm(out);
  }

  function extract(tool, text) {
    var t=normalizeMultilingualOptionText(text), o={}, missing=[];
    var normalizer = G.LabaIntentNormalizer;
    if (normalizer && typeof normalizer.normalize === 'function') t = normalizer.normalize(t);
    if (tool==='rotate') {
      var deg=t.match(/(?:^|\s)(90|180|270)\s*(?:degrees?|°)?(?:\s|$)/i); if(deg)o.degrees=deg[1];
      var pg=textAfter(t,[/\bpages?\s*[:=]?\s*([0-9,\- ]+|all(?: pages)?)\b/i]); if(pg)o.pages=parsePages(pg);
    }
    if (tool==='split') { var rg=textAfter(t,[/\bpages?\s*[:=]?\s*([0-9,\- ]+|all)\b/i, /\b(?:range|from)\s+([0-9,\- ]+)\b/i]); if(rg)o.range=parseRange(rg); }
    if (tool==='watermark') o.text=textAfter(t,[/\b(?:watermark|stamp)\s*(?:text)?\s*[:=]\s*["']?(.+?)["']?$/i,/\bwatermark\s+["']([^"']+)["']/i]);
    if (tool==='sign') o.signatureText=textAfter(t,[/\b(?:signature|sign)\b\s*(?:as|with|:)?\s*["']?([^"']+)["']?$/i]);
    if (tool==='protect') o.password=textAfter(t,[/\b(?:password|passcode|pin)\s*[:=]\s*["']?([^"']+)["']?/i]);
    if (tool==='unlock') o.password=textAfter(t,[/\b(?:password|passcode)\s*[:=]\s*["']?([^"']+)["']?/i]);
    if (tool==='edit') o.text=textAfter(t,[/\b(?:add|insert)\s+(?:text|note)\s*[:=]?\s*["']?(.+?)["']?$/i]);
    if (tool==='redact') { var p=textAfter(t,[/\bpages?\s*[:=]\s*([0-9,\- ]+|all)\b/i]); if(p)o.pages=parsePages(p); }
    return o;
  }

  function validate(tool, raw) {
    var schema=SCHEMAS[tool]; if(!schema) return {ok:true, options:{}, missing:[]};
    var src=raw||{}, out={}, missing=[], errors=[];
    Object.keys(schema.fields).forEach(function(k){
      var f=schema.fields[k], v=src[k];
      if(v===undefined || v===null || v==='') {
        if(f.required) missing.push(k); else if(f.default!==undefined) out[k]=f.default;
        return;
      }
      if(f.type==='text'||f.type==='secret'){
        v=norm(v);
        var validText=true;
        if(f.min && v.length<f.min){ errors.push({key:k,reason:'minimum length is '+f.min}); validText=false; }
        if(f.max && v.length>f.max){ errors.push({key:k,reason:'maximum length is '+f.max}); validText=false; }
        if(validText) out[k]=v;
      }
      else if(f.type==='enum'){ var ev=enumValue(v,f); if(ev===null)errors.push(k);else out[k]=ev; }
      else if(f.type==='number'){ var n=numberIn(v,f); if(n===null)errors.push(k);else out[k]=n; }
      else if(f.type==='positiveInt'){ var n2=Number(v); if(!Number.isInteger(n2)||n2<1)errors.push(k);else out[k]=n2; }
      else if(f.type==='pages'){ var p=parsePages(v); if(p===null)errors.push(k);else out[k]=p; }
      else if(f.type==='range'){ var r=parseRange(v); if(r===null)errors.push(k);else out[k]=r; }
      else if(f.type==='lang'){ var l=norm(v).toLowerCase(); if(!/^[a-z]{2,8}(?:-[a-z]{2,8})?$/.test(l))errors.push(k);else out[k]=l; }
    });
    return {ok:!missing.length&&!errors.length, options:out, missing:missing, errors:errors};
  }

  function plan(tool,text,files) {
    var extracted=extract(tool,text), checked=validate(tool,extracted);
    var needs=[];
    if(checked.missing.length) {
      checked.missing.forEach(function(k){
        if(k==='password') needs.push(tool==='protect'?'Please provide the password to use for protection.':'If the current password is known, provide it; otherwise I can try the tool without one.');
        else if(k==='degrees') needs.push('What rotation angle should I use: 90°, 180°, or 270°?');
        else if(k==='signatureText') needs.push('Please tell me the name or signature text to place on the PDF.');
        else if(k==='text') needs.push(tool==='watermark'?'What watermark text should I use?':'What text should I add?');
        else needs.push('Please provide a valid value for '+k+'.');
      });
    }
    if(checked.errors.length) {
      checked.errors.forEach(function(err){
        var key = typeof err === 'string' ? err : err.key;
        var reason = typeof err === 'string' ? 'the supplied value is invalid' : err.reason;
        if(key==='password') needs.push('The password is invalid: '+reason+'. Please provide a valid password.');
        else if(key==='degrees') needs.push('The rotation angle is invalid. Please use 90°, 180°, or 270°.');
        else needs.push('The value for '+key+' is invalid: '+reason+'. Please provide a valid value.');
      });
    }
    return {ok:checked.ok, tool:tool, options:checked.options, missing:checked.missing, errors:checked.errors, clarification:needs.length?needs.join(' '):null};
  }

  G.LabaToolOptions={version:'1.0', schemas:SCHEMAS, extract:extract, validate:validate, plan:plan};
})(window);
