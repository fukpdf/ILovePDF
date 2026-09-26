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
    fr: {'special.home':'Accueil','special.how':'Comment ça marche','special.faq':'Questions fréquentes','special.related':'Outils associés','special.browse':'Parcourir les fichiers','special.browse_image':'Parcourir une image','special.browse_images':'Parcourir les images','special.clear':'Tout effacer','special.download':'Télécharger','special.convert':'Convertir','special.convert_all':'Convertir toutes les images','special.compress':'Compresser','special.build_zip':'Créer le ZIP','special.drop_files':'Déposez les fichiers ici','special.drop_image':'Déposez une image ici','special.drop_images':'Déposez les images ici'},
    de: {'special.home':'Startseite','special.how':'So funktioniert es','special.faq':'Häufig gestellte Fragen','special.related':'Verwandte Tools','special.browse':'Dateien durchsuchen','special.browse_image':'Bild auswählen','special.browse_images':'Bilder auswählen','special.clear':'Alle löschen','special.download':'Herunterladen','special.convert':'Konvertieren','special.convert_all':'Alle Bilder konvertieren','special.compress':'Komprimieren','special.build_zip':'ZIP erstellen','special.drop_files':'Dateien hier ablegen','special.drop_image':'Bild hier ablegen','special.drop_images':'Bilder hier ablegen'},
    es: {'special.home':'Inicio','special.how':'Cómo funciona','special.faq':'Preguntas frecuentes','special.related':'Herramientas relacionadas','special.browse':'Explorar archivos','special.browse_image':'Explorar imagen','special.browse_images':'Explorar imágenes','special.clear':'Borrar todo','special.download':'Descargar','special.convert':'Convertir','special.convert_all':'Convertir todas las imágenes','special.compress':'Comprimir','special.build_zip':'Crear ZIP','special.drop_files':'Suelta los archivos aquí','special.drop_image':'Suelta la imagen aquí','special.drop_images':'Suelta las imágenes aquí'},
    it: {'special.home':'Home','special.how':'Come funziona','special.faq':'Domande frequenti','special.related':'Strumenti correlati','special.browse':'Sfoglia file','special.browse_image':'Sfoglia immagine','special.browse_images':'Sfoglia immagini','special.clear':'Cancella tutto','special.download':'Scarica','special.convert':'Converti','special.convert_all':'Converti tutte le immagini','special.compress':'Comprimi','special.build_zip':'Crea ZIP','special.drop_files':'Trascina qui i file','special.drop_image':'Trascina qui l’immagine','special.drop_images':'Trascina qui le immagini'},
    pt: {'special.home':'Início','special.how':'Como funciona','special.faq':'Perguntas frequentes','special.related':'Ferramentas relacionadas','special.browse':'Procurar arquivos','special.browse_image':'Procurar imagem','special.browse_images':'Procurar imagens','special.clear':'Limpar tudo','special.download':'Baixar','special.convert':'Converter','special.convert_all':'Converter todas as imagens','special.compress':'Comprimir','special.build_zip':'Criar ZIP','special.drop_files':'Solte os arquivos aqui','special.drop_image':'Solte a imagem aqui','special.drop_images':'Solte as imagens aqui'},
    nl: {'special.home':'Home','special.how':'Zo werkt het','special.faq':'Veelgestelde vragen','special.related':'Gerelateerde tools','special.browse':'Bestanden bekijken','special.browse_image':'Afbeelding kiezen','special.browse_images':'Afbeeldingen kiezen','special.clear':'Alles wissen','special.download':'Downloaden','special.convert':'Converteren','special.convert_all':'Alle afbeeldingen converteren','special.compress':'Comprimeren','special.build_zip':'ZIP maken','special.drop_files':'Zet bestanden hier neer','special.drop_image':'Zet de afbeelding hier neer','special.drop_images':'Zet afbeeldingen hier neer'},
    tr: {'special.home':'Ana Sayfa','special.how':'Nasıl çalışır','special.faq':'Sık sorulan sorular','special.related':'İlgili araçlar','special.browse':'Dosyalara göz at','special.browse_image':'Resme göz at','special.browse_images':'Resimlere göz at','special.clear':'Tümünü temizle','special.download':'İndir','special.convert':'Dönüştür','special.convert_all':'Tüm görselleri dönüştür','special.compress':'Sıkıştır','special.build_zip':'ZIP oluştur','special.drop_files':'Dosyaları buraya bırakın','special.drop_image':'Resmi buraya bırakın','special.drop_images':'Resimleri buraya bırakın'},
    ru: {'special.home':'Главная','special.how':'Как это работает','special.faq':'Часто задаваемые вопросы','special.related':'Связанные инструменты','special.browse':'Выбрать файлы','special.browse_image':'Выбрать изображение','special.browse_images':'Выбрать изображения','special.clear':'Очистить всё','special.download':'Скачать','special.convert':'Конвертировать','special.convert_all':'Конвертировать все изображения','special.compress':'Сжать','special.build_zip':'Создать ZIP','special.drop_files':'Перетащите файлы сюда','special.drop_image':'Перетащите изображение сюда','special.drop_images':'Перетащите изображения сюда'},
    ja: {'special.home':'ホーム','special.how':'使い方','special.faq':'よくある質問','special.related':'関連ツール','special.browse':'ファイルを選択','special.browse_image':'画像を選択','special.browse_images':'画像を選択','special.clear':'すべてクリア','special.download':'ダウンロード','special.convert':'変換','special.convert_all':'すべての画像を変換','special.compress':'圧縮','special.build_zip':'ZIPを作成','special.drop_files':'ここにファイルをドロップ','special.drop_image':'ここに画像をドロップ','special.drop_images':'ここに画像をドロップ'},
    ko: {'special.home':'홈','special.how':'사용 방법','special.faq':'자주 묻는 질문','special.related':'관련 도구','special.browse':'파일 찾아보기','special.browse_image':'이미지 찾아보기','special.browse_images':'이미지 찾아보기','special.clear':'모두 지우기','special.download':'다운로드','special.convert':'변환','special.convert_all':'모든 이미지 변환','special.compress':'압축','special.build_zip':'ZIP 만들기','special.drop_files':'여기에 파일을 놓으세요','special.drop_image':'여기에 이미지를 놓으세요','special.drop_images':'여기에 이미지를 놓으세요'},
    zh: {'special.home':'首页','special.how':'使用方法','special.faq':'常见问题','special.related':'相关工具','special.browse':'浏览文件','special.browse_image':'选择图片','special.browse_images':'选择图片','special.clear':'全部清除','special.download':'下载','special.convert':'转换','special.convert_all':'转换所有图片','special.compress':'压缩','special.build_zip':'创建 ZIP','special.drop_files':'将文件拖到这里','special.drop_image':'将图片拖到这里','special.drop_images':'将图片拖到这里'},
    id: {'special.home':'Beranda','special.how':'Cara kerja','special.faq':'Pertanyaan umum','special.related':'Alat terkait','special.browse':'Pilih file','special.browse_image':'Pilih gambar','special.browse_images':'Pilih gambar','special.clear':'Hapus semua','special.download':'Unduh','special.convert':'Konversi','special.convert_all':'Konversi semua gambar','special.compress':'Kompres','special.build_zip':'Buat ZIP','special.drop_files':'Jatuhkan file di sini','special.drop_image':'Jatuhkan gambar di sini','special.drop_images':'Jatuhkan gambar di sini'},
    pl: {'special.home':'Strona główna','special.how':'Jak to działa','special.faq':'Najczęściej zadawane pytania','special.related':'Powiązane narzędzia','special.browse':'Przeglądaj pliki','special.browse_image':'Wybierz obraz','special.browse_images':'Wybierz obrazy','special.clear':'Wyczyść wszystko','special.download':'Pobierz','special.convert':'Konwertuj','special.convert_all':'Konwertuj wszystkie obrazy','special.compress':'Kompresuj','special.build_zip':'Utwórz ZIP','special.drop_files':'Upuść pliki tutaj','special.drop_image':'Upuść obraz tutaj','special.drop_images':'Upuść obrazy tutaj'},
    bn: {'special.home':'হোম','special.how':'কীভাবে কাজ করে','special.faq':'প্রায়শই জিজ্ঞাসিত প্রশ্ন','special.related':'সম্পর্কিত টুল','special.browse':'ফাইল বাছাই করুন','special.browse_image':'ছবি বাছাই করুন','special.browse_images':'ছবিগুলো বাছাই করুন','special.clear':'সব পরিষ্কার করুন','special.download':'ডাউনলোড','special.convert':'রূপান্তর করুন','special.convert_all':'সব ছবি রূপান্তর করুন','special.compress':'কমপ্রেস করুন','special.build_zip':'ZIP তৈরি করুন','special.drop_files':'এখানে ফাইল ছেড়ে দিন','special.drop_image':'এখানে ছবি ছেড়ে দিন','special.drop_images':'এখানে ছবিগুলো ছেড়ে দিন'},
    fa: {'special.home':'خانه','special.how':'نحوه کار','special.faq':'سؤالات متداول','special.related':'ابزارهای مرتبط','special.browse':'مرور فایل‌ها','special.browse_image':'انتخاب تصویر','special.browse_images':'انتخاب تصاویر','special.clear':'پاک کردن همه','special.download':'دانلود','special.convert':'تبدیل','special.convert_all':'تبدیل همه تصاویر','special.compress':'فشرده‌سازی','special.build_zip':'ساخت ZIP','special.drop_files':'فایل‌ها را اینجا رها کنید','special.drop_image':'تصویر را اینجا رها کنید','special.drop_images':'تصاویر را اینجا رها کنید'},
    
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