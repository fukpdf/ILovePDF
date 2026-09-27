#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const failures=[];
const PAGES=[
  ['n2w','public/n2w.html'],['currency-converter','public/currency-converter.html'],
  ['qr-code-generator','public/qr-code-generator.html'],['barcode-generator','public/barcode-generator.html'],
  ['image-compressor','public/image-compressor.html'],['image-converter','public/image-converter.html'],
  ['zip-builder','public/zip-builder.html']
];
const LOCALES=['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const TAG_RE=/<(h1|h2|h3|h4|h5|h6|label|legend|p|button|summary|option|figcaption|a)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ATTR_RE=/<(?:input|textarea|select|button|summary|a)\b[^>]*(?:aria-label|title|placeholder)=(['"])(.*?)\1[^>]*>/gi;
function clean(raw){return raw.replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi,m=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m.toLowerCase()]||' ')).replace(/\s+/g,' ').trim();}
function likelyVisible(t){return t&&t.length>=2&&!/^[\d\s.,:%+\-–—/()]+$/.test(t)&&!/^(JPG|PNG|WebP|JPEG|SVG|URL|SSID|ZIP|PDF)$/i.test(t)&&/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t);}
function collect(html){
  const out=new Set(); let m;
  TAG_RE.lastIndex=0; while((m=TAG_RE.exec(html))){const t=clean(m[2]);if(likelyVisible(t))out.add(t);}
  ATTR_RE.lastIndex=0; while((m=ATTR_RE.exec(html))){const t=clean(m[2]);if(likelyVisible(t))out.add(t);}
  return [...out];
}
const bridge=read('public/js/special-page-i18n.js');
if(!/SpecialPageI18n=Object\.freeze/.test(bridge)) failures.push('SpecialPageI18n export is missing.');
if(!/G\.addEventListener\('i18n:change'/.test(bridge)) failures.push('special-page i18n change listener is missing.');
if(!/function autoSemanticCoverage\(\)/.test(bridge)) failures.push('Deterministic auto semantic coverage function is missing.');
if(!/special\.auto_/.test(bridge)) failures.push('Deterministic auto semantic key namespace is missing.');

const sandbox={window:{},document:{readyState:'loading',addEventListener(){},querySelectorAll(){return[]}},console:{log(){}}};
sandbox.window.addEventListener=function(){};
sandbox.window.RuntimeI18n=null;
let audit;
try{
  const exposed=['PAGE_TEXT','SECONDARY_TEXT','FAQ_TEXT','BODY_TEXT','LONG_TEXT','INSTRUCTION_TEXT','PARAGRAPH_TEXT','UI_TEXT','PAGE_TITLES'];
  const src=bridge.replace(/\}\)\(\);\s*$/,'G.__AUDIT={EXT:EXT,'+exposed.map(n=>n+':(typeof '+n+'!=="undefined"?'+n+':null)').join(',')+'};})();');
  vm.runInNewContext(src,sandbox,{timeout:10000});
  audit=sandbox.window.__AUDIT;
}catch(e){failures.push('special-page-i18n bridge could not be evaluated: '+e.message);}

if(audit&&audit.EXT){
  const maps=['PAGE_TEXT','SECONDARY_TEXT','FAQ_TEXT','BODY_TEXT','LONG_TEXT','INSTRUCTION_TEXT','PARAGRAPH_TEXT'].map(n=>audit[n]).filter(Boolean);
  const mapping=new Map();
  for(const map of maps)for(const [text,key] of Object.entries(map))if(typeof text==='string'&&typeof key==='string'&&!mapping.has(text))mapping.set(text,key);
  let total=0,reviewed=0,auto=0,translated=0;
  for(const [name,rel] of PAGES){
    const candidates=collect(read(rel)); let pageReviewed=0,pageAuto=0,pageTranslated=0;
    for(const text of candidates){
      total++;
      const key=mapping.get(text);
      if(key){reviewed++;pageReviewed++; if(LOCALES.slice(1).every(l=>audit.EXT[l]&&Object.prototype.hasOwnProperty.call(audit.EXT[l],key))){translated++;pageTranslated++;}}
      else {auto++;pageAuto++;}
    }
    console.log(name+': candidates='+candidates.length+' reviewed-mapped='+pageReviewed+' auto-mapped='+pageAuto+' translated-all-locales='+pageTranslated);
  }
  console.log('TOTAL: candidates='+total+' reviewed-mapped='+reviewed+' auto-mapped='+auto+' translated-all-locales='+translated);
  if(total===0) failures.push('No special-page i18n candidates were discovered.');
  if(auto===0) console.log('Reviewed mapping covers every discovered candidate.');
  else console.log('Auto semantic fallback remains for '+auto+' candidate(s); these are NOT counted as reviewed translations.');
  if(auto>0 && process.env.PHASE5_SPECIAL_I18N_STRICT==='1') failures.push(auto+' candidate(s) rely on auto semantic fallback in strict mode.');
}else if(!failures.length) failures.push('No i18n audit surface was exposed by the bridge.');

if(failures.length){
  console.error('[FAIL] Phase 5 special-page i18n gate ('+failures.length+' issue(s))');
  failures.forEach(x=>console.error(' - '+x));
  process.exitCode=1;
}else{
  console.log('Phase 5 special-page i18n gate: PASS (integration verified; auto fallback is reported separately).');
}
