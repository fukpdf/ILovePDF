/* Shared special-page i18n bridge. Page engines remain independent.
   Special pages use semantic hooks here so their static UI participates in the
   same RuntimeI18n language switch without touching processing engines. */
(function(){
  'use strict';
  var G=window;

  /* High-value labels shared by the seven standalone/special pages.  English
     remains the canonical fallback; locale-specific additions can be extended
     centrally without coupling translations to any page engine. */
  var EXT = {
    en: {
      'special.home':'Home','special.how':'How it works','special.faq':'Frequently asked questions',
      'special.related':'Related tools','special.browse':'Browse files','special.browse_image':'Browse image',
      'special.browse_images':'Browse images','special.clear':'Clear all','special.download':'Download',
      'special.convert':'Convert','special.convert_all':'Convert all images','special.compress':'Compress',
      'special.build_zip':'Build ZIP','special.drop_files':'Drop files here','special.drop_image':'Drop an image here',
      'special.drop_images':'Drop images here'
    },
    ur: {
      'special.home':'ہوم','special.how':'یہ کیسے کام کرتا ہے','special.faq':'اکثر پوچھے گئے سوالات',
      'special.related':'متعلقہ ٹولز','special.browse':'فائلیں منتخب کریں','special.browse_image':'تصویر منتخب کریں',
      'special.browse_images':'تصاویر منتخب کریں','special.clear':'سب صاف کریں','special.download':'ڈاؤن لوڈ',
      'special.convert':'تبدیل کریں','special.convert_all':'تمام تصاویر تبدیل کریں','special.compress':'کمپریس کریں',
      'special.build_zip':'ZIP بنائیں','special.drop_files':'فائلیں یہاں چھوڑیں','special.drop_image':'تصویر یہاں چھوڑیں',
      'special.drop_images':'تصاویر یہاں چھوڑیں'
    },
    hi: {
      'special.home':'होम','special.how':'यह कैसे काम करता है','special.faq':'अक्सर पूछे जाने वाले प्रश्न',
      'special.related':'संबंधित टूल','special.browse':'फ़ाइलें चुनें','special.browse_image':'छवि चुनें',
      'special.browse_images':'छवियां चुनें','special.clear':'सब साफ़ करें','special.download':'डाउनलोड',
      'special.convert':'कन्वर्ट करें','special.convert_all':'सभी छवियां कन्वर्ट करें','special.compress':'कंप्रेस करें',
      'special.build_zip':'ZIP बनाएं','special.drop_files':'फ़ाइलें यहां छोड़ें','special.drop_image':'छवि यहां छोड़ें',
      'special.drop_images':'छवियां यहां छोड़ें'
    },
    ar: {
      'special.home':'الرئيسية','special.how':'طريقة الاستخدام','special.faq':'الأسئلة الشائعة',
      'special.related':'أدوات ذات صلة','special.browse':'تصفح الملفات','special.browse_image':'تصفح صورة',
      'special.browse_images':'تصفح الصور','special.clear':'مسح الكل','special.download':'تنزيل',
      'special.convert':'تحويل','special.convert_all':'تحويل كل الصور','special.compress':'ضغط',
      'special.build_zip':'إنشاء ZIP','special.drop_files':'أسقط الملفات هنا','special.drop_image':'أسقط الصورة هنا',
      'special.drop_images':'أسقط الصور هنا'
    }
  };

  function extend(){
    if(!G.RuntimeI18n || typeof G.RuntimeI18n.extend!=='function') return;
    Object.keys(EXT).forEach(function(lang){ G.RuntimeI18n.extend(lang,EXT[lang]); });
  }

  function attr(el,key){ if(el && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n',key); }

  function markByText(selector,map){
    document.querySelectorAll(selector).forEach(function(el){
      var raw=(el.textContent||'').trim();
      Object.keys(map).some(function(k){
        if(raw===k){ attr(el,map[k]); return true; }
        return false;
      });
    });
  }

  function hook(){
    extend();

    /* Breadcrumb home and major section headings. */
    markByText('.bc-link',{'Home':'special.home'});
    markByText('h2',{'How it works':'special.how','Frequently asked questions':'special.faq','Related tools':'special.related'});

    /* Buttons/controls common to the special upload tools. */
    markByText('button',{
      'Browse files':'special.browse','Browse image':'special.browse_image',
      'Browse images':'special.browse_images','Clear all':'special.clear',
      'Download':'special.download','Compress':'special.compress',
      'Convert all images':'special.convert_all','Build ZIP':'special.build_zip'
    });

    markByText('.ilpdf-special-dropzone p',{
      'Drop files here':'special.drop_files','Drop an image here':'special.drop_image',
      'Drop images here':'special.drop_images'
    });

    patch();
  }

  function patch(){
    if(G.RuntimeI18n && typeof G.RuntimeI18n.patch==='function') G.RuntimeI18n.patch(document);
  }

  function start(){
    hook();
    G.addEventListener('i18n:change',function(){
      hook();
    });
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();

  G.SpecialPageI18n=Object.freeze({patch:patch,hook:hook});
})();