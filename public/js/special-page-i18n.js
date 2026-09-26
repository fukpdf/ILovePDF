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
    ar: {
      'special.home':'الرئيسية','special.how':'طريقة الاستخدام','special.faq':'الأسئلة الشائعة',
      'special.related':'أدوات ذات صلة','special.browse':'تصفح الملفات','special.browse_image':'تصفح صورة',
      'special.browse_images':'تصفح الصور','special.clear':'مسح الكل','special.download':'تنزيل',
      'special.convert':'تحويل','special.convert_all':'تحويل كل الصور','special.compress':'ضغط',
      'special.build_zip':'إنشاء ZIP','special.drop_files':'أسقط الملفات هنا','special.drop_image':'أسقط الصورة هنا',
      'special.drop_images':'أسقط الصور هنا'
    }
  };

  /* Core page titles are translated in every supported locale. Longer SEO prose
     deliberately remains fallback English until a reviewed translation exists. */
  var PAGE_TITLES = {
    en:{n2w:'Numbers to Words Converter',cur:'Live Currency Converter',qr:'QR Code Generator',bar:'Barcode Generator',ic:'Image Compressor',iv:'Image Converter',zip:'ZIP Builder'},
    ur:{n2w:'نمبروں کو الفاظ میں تبدیل کرنے والا',cur:'لائیو کرنسی کنورٹر',qr:'کیو آر کوڈ جنریٹر',bar:'بارکوڈ جنریٹر',ic:'امیج کمپریسر',iv:'امیج کنورٹر',zip:'ZIP بلڈر'},
    ar:{n2w:'محول الأرقام إلى كلمات',cur:'محول العملات المباشر',qr:'مولد رمز QR',bar:'مولد الباركود',ic:'ضاغط الصور',iv:'محول الصور',zip:'منشئ ZIP'},
    fa:{n2w:'تبدیل اعداد به حروف',cur:'مبدل ارز زنده',qr:'مولد کد QR',bar:'مولد بارکد',ic:'فشرده‌ساز تصویر',iv:'مبدل تصویر',zip:'سازنده ZIP'},
    hi:{n2w:'संख्याओं को शब्दों में बदलें',cur:'लाइव मुद्रा कन्वर्टर',qr:'QR कोड जनरेटर',bar:'बारकोड जनरेटर',ic:'इमेज कंप्रेसर',iv:'इमेज कन्वर्टर',zip:'ZIP बिल्डर'},
    bn:{n2w:'সংখ্যা থেকে শব্দ রূপান্তরকারী',cur:'লাইভ কারেন্সি কনভার্টার',qr:'QR কোড জেনারেটর',bar:'বারকোড জেনারেটর',ic:'ইমেজ কমপ্রেসর',iv:'ইমেজ কনভার্টার',zip:'ZIP বিল্ডার'},
    zh:{n2w:'数字转文字转换器',cur:'实时货币转换器',qr:'二维码生成器',bar:'条码生成器',ic:'图片压缩器',iv:'图片转换器',zip:'ZIP 创建器'},
    ja:{n2w:'数字を文字に変換',cur:'リアルタイム通貨コンバーター',qr:'QRコードジェネレーター',bar:'バーコードジェネレーター',ic:'画像圧縮ツール',iv:'画像変換ツール',zip:'ZIPビルダー'},
    ko:{n2w:'숫자를 단어로 변환',cur:'실시간 통화 변환기',qr:'QR 코드 생성기',bar:'바코드 생성기',ic:'이미지 압축기',iv:'이미지 변환기',zip:'ZIP 빌더'},
    tr:{n2w:'Sayıdan Kelimeye Dönüştürücü',cur:'Canlı Para Birimi Dönüştürücü',qr:'QR Kod Oluşturucu',bar:'Barkod Oluşturucu',ic:'Görsel Sıkıştırıcı',iv:'Görsel Dönüştürücü',zip:'ZIP Oluşturucu'},
    id:{n2w:'Konverter Angka ke Kata',cur:'Konverter Mata Uang Langsung',qr:'Generator Kode QR',bar:'Generator Barcode',ic:'Kompresor Gambar',iv:'Konverter Gambar',zip:'Pembuat ZIP'},
    ru:{n2w:'Конвертер чисел в слова',cur:'Конвертер валют в реальном времени',qr:'Генератор QR-кодов',bar:'Генератор штрихкодов',ic:'Сжатие изображений',iv:'Конвертер изображений',zip:'Создатель ZIP'},
    fr:{n2w:'Convertisseur de nombres en lettres',cur:'Convertisseur de devises en direct',qr:'Générateur de QR codes',bar:'Générateur de codes-barres',ic:'Compresseur d’images',iv:'Convertisseur d’images',zip:'Créateur de ZIP'},
    de:{n2w:'Zahlen-in-Wörter-Konverter',cur:'Live-Währungsrechner',qr:'QR-Code-Generator',bar:'Barcode-Generator',ic:'Bildkomprimierer',iv:'Bildkonverter',zip:'ZIP-Ersteller'},
    es:{n2w:'Convertidor de números a palabras',cur:'Conversor de divisas en tiempo real',qr:'Generador de códigos QR',bar:'Generador de códigos de barras',ic:'Compresor de imágenes',iv:'Convertidor de imágenes',zip:'Creador de ZIP'},
    pt:{n2w:'Conversor de números para palavras',cur:'Conversor de moedas em tempo real',qr:'Gerador de códigos QR',bar:'Gerador de códigos de barras',ic:'Compressor de imagens',iv:'Conversor de imagens',zip:'Criador de ZIP'},
    it:{n2w:'Convertitore da numeri a parole',cur:'Convertitore di valute in tempo reale',qr:'Generatore di codici QR',bar:'Generatore di codici a barre',ic:'Compressore di immagini',iv:'Convertitore di immagini',zip:'Creatore di ZIP'},
    nl:{n2w:'Getallen naar woorden converter',cur:'Live valutaomrekenaar',qr:'QR-codegenerator',bar:'Barcodegenerator',ic:'Afbeeldingscompressor',iv:'Afbeeldingsconverter',zip:'ZIP-maker'},
    pl:{n2w:'Konwerter liczb na słowa',cur:'Przelicznik walut na żywo',qr:'Generator kodów QR',bar:'Generator kodów kreskowych',ic:'Kompresor obrazów',iv:'Konwerter obrazów',zip:'Kreator ZIP'}
  };
  /* High-value control/section labels. These are short UI strings only;
     long SEO prose continues to use the reviewed English fallback. */
  var UI_TEXT = {
    'Enter a number':'special.enter_number','Conversion type':'special.conversion_type','Words':'special.words',
    'Currency':'special.currency','Check Writing':'special.check_writing','Suffix':'special.suffix','Letter Case':'special.letter_case',
    'Clear':'special.clear_short','Result':'special.result','Copy':'special.copy',
    'Mid-market rates · 160+ currencies':'special.currency_rates','Amount':'special.amount','From':'special.from','Convert':'special.convert',
    'Content type':'special.content_type','URL':'special.url','Text':'special.text','Email':'special.email','Phone':'special.phone',
    'Wi-Fi':'special.wifi','Subject':'special.subject','Body (optional)':'special.body_optional','Network Name (SSID)':'special.network_name',
    'Security':'special.security','Password':'special.password','Hidden':'special.hidden','Size (px)':'special.size_px',
    'Error Correction':'special.error_correction','Foreground':'special.foreground','Background':'special.background','Generate QR Code':'special.generate_qr',
    'Barcode data':'special.barcode_data','Format':'special.format','Line width':'special.line_width','Height (px)':'special.height_px',
    'Font size':'special.font_size','Margin':'special.margin','Show text':'special.show_text','Bar color':'special.bar_color','Generate Barcode':'special.generate_barcode',
    'Quality: 80':'special.quality_80','Output format':'special.output_format','Browse image':'special.browse_image',
    'Convert to':'special.convert_to','Quality (JPEG / WebP): 85':'special.quality_85','Browse images':'special.browse_images',
    'Clear all':'special.clear','Archive name':'special.archive_name','Compression':'special.compression',
    'Optimal (max)':'special.optimal','Balanced':'special.balanced','Fast (min)':'special.fast','None (no compression)':'special.none_compression',
    'Browse files':'special.browse'
  };
  var UI_LOCALE = {
  'ur': {
    'special.enter_number': "نمبر درج کریں",
    'special.conversion_type': "تبدیلی کی قسم",
    'special.amount': "رقم",
    'special.from': "سے",
    'special.convert': "تبدیل کریں",
    'special.content_type': "مواد کی قسم",
    'special.format': "فارمیٹ",
    'special.output_format': "آؤٹ پٹ فارمیٹ",
    'special.archive_name': "آرکائیو کا نام",
    'special.compression': "کمپریشن"
  },
  'hi': {
    'special.enter_number': "संख्या दर्ज करें",
    'special.conversion_type': "रूपांतरण प्रकार",
    'special.amount': "राशि",
    'special.from': "से",
    'special.convert': "कन्वर्ट करें",
    'special.content_type': "सामग्री प्रकार",
    'special.format': "फ़ॉर्मेट",
    'special.output_format': "आउटपुट फ़ॉर्मेट",
    'special.archive_name': "आर्काइव नाम",
    'special.compression': "कंप्रेशन"
  },
  'ar': {
    'special.enter_number': "أدخل رقمًا",
    'special.conversion_type': "نوع التحويل",
    'special.amount': "المبلغ",
    'special.from': "من",
    'special.convert': "تحويل",
    'special.content_type': "نوع المحتوى",
    'special.format': "التنسيق",
    'special.output_format': "تنسيق الإخراج",
    'special.archive_name': "اسم الأرشيف",
    'special.compression': "الضغط"
  },
  'fa': {
    'special.enter_number': "یک عدد وارد کنید",
    'special.conversion_type': "نوع تبدیل",
    'special.amount': "مبلغ",
    'special.from': "از",
    'special.convert': "تبدیل",
    'special.content_type': "نوع محتوا",
    'special.format': "قالب",
    'special.output_format': "قالب خروجی",
    'special.archive_name': "نام آرشیو",
    'special.compression': "فشرده‌سازی"
  },
  'fr': {
    'special.enter_number': "Saisissez un nombre",
    'special.conversion_type': "Type de conversion",
    'special.amount': "Montant",
    'special.from': "De",
    'special.convert': "Convertir",
    'special.content_type': "Type de contenu",
    'special.format': "Format",
    'special.output_format': "Format de sortie",
    'special.archive_name': "Nom de l’archive",
    'special.compression': "Compression"
  },
  'de': {
    'special.enter_number': "Zahl eingeben",
    'special.conversion_type': "Konvertierungsart",
    'special.amount': "Betrag",
    'special.from': "Von",
    'special.convert': "Konvertieren",
    'special.content_type': "Inhaltstyp",
    'special.format': "Format",
    'special.output_format': "Ausgabeformat",
    'special.archive_name': "Archivname",
    'special.compression': "Komprimierung"
  },
  'es': {
    'special.enter_number': "Introduce un número",
    'special.conversion_type': "Tipo de conversión",
    'special.amount': "Importe",
    'special.from': "De",
    'special.convert': "Convertir",
    'special.content_type': "Tipo de contenido",
    'special.format': "Formato",
    'special.output_format': "Formato de salida",
    'special.archive_name': "Nombre del archivo",
    'special.compression': "Compresión"
  },
  'pt': {
    'special.enter_number': "Digite um número",
    'special.conversion_type': "Tipo de conversão",
    'special.amount': "Valor",
    'special.from': "De",
    'special.convert': "Converter",
    'special.content_type': "Tipo de conteúdo",
    'special.format': "Formato",
    'special.output_format': "Formato de saída",
    'special.archive_name': "Nome do arquivo",
    'special.compression': "Compressão"
  },
  'it': {
    'special.enter_number': "Inserisci un numero",
    'special.conversion_type': "Tipo di conversione",
    'special.amount': "Importo",
    'special.from': "Da",
    'special.convert': "Converti",
    'special.content_type': "Tipo di contenuto",
    'special.format': "Formato",
    'special.output_format': "Formato di output",
    'special.archive_name': "Nome archivio",
    'special.compression': "Compressione"
  },
  'nl': {
    'special.enter_number': "Voer een getal in",
    'special.conversion_type': "Conversietype",
    'special.amount': "Bedrag",
    'special.from': "Van",
    'special.convert': "Converteren",
    'special.content_type': "Inhoudstype",
    'special.format': "Indeling",
    'special.output_format': "Uitvoerindeling",
    'special.archive_name': "Archiefnaam",
    'special.compression': "Compressie"
  },
  'tr': {
    'special.enter_number': "Bir sayı girin",
    'special.conversion_type': "Dönüştürme türü",
    'special.amount': "Tutar",
    'special.from': "Kaynak",
    'special.convert': "Dönüştür",
    'special.content_type': "İçerik türü",
    'special.format': "Biçim",
    'special.output_format': "Çıktı biçimi",
    'special.archive_name': "Arşiv adı",
    'special.compression': "Sıkıştırma"
  },
  'ru': {
    'special.enter_number': "Введите число",
    'special.conversion_type': "Тип преобразования",
    'special.amount': "Сумма",
    'special.from': "Из",
    'special.convert': "Конвертировать",
    'special.content_type': "Тип содержимого",
    'special.format': "Формат",
    'special.output_format': "Формат вывода",
    'special.archive_name': "Имя архива",
    'special.compression': "Сжатие"
  },
  'ja': {
    'special.enter_number': "数値を入力",
    'special.conversion_type': "変換タイプ",
    'special.amount': "金額",
    'special.from': "変換元",
    'special.convert': "変換",
    'special.content_type': "コンテンツの種類",
    'special.format': "形式",
    'special.output_format': "出力形式",
    'special.archive_name': "アーカイブ名",
    'special.compression': "圧縮"
  },
  'ko': {
    'special.enter_number': "숫자 입력",
    'special.conversion_type': "변환 유형",
    'special.amount': "금액",
    'special.from': "변환 전",
    'special.convert': "변환",
    'special.content_type': "콘텐츠 유형",
    'special.format': "형식",
    'special.output_format': "출력 형식",
    'special.archive_name': "아카이브 이름",
    'special.compression': "압축"
  },
  'zh': {
    'special.enter_number': "输入数字",
    'special.conversion_type': "转换类型",
    'special.amount': "金额",
    'special.from': "来源",
    'special.convert': "转换",
    'special.content_type': "内容类型",
    'special.format': "格式",
    'special.output_format': "输出格式",
    'special.archive_name': "压缩包名称",
    'special.compression': "压缩"
  },
  'id': {
    'special.enter_number': "Masukkan angka",
    'special.conversion_type': "Jenis konversi",
    'special.amount': "Jumlah",
    'special.from': "Dari",
    'special.convert': "Konversi",
    'special.content_type': "Jenis konten",
    'special.format': "Format",
    'special.output_format': "Format keluaran",
    'special.archive_name': "Nama arsip",
    'special.compression': "Kompresi"
  },
  'pl': {
    'special.enter_number': "Wpisz liczbę",
    'special.conversion_type': "Typ konwersji",
    'special.amount': "Kwota",
    'special.from': "Z",
    'special.convert': "Konwertuj",
    'special.content_type': "Typ treści",
    'special.format': "Format",
    'special.output_format': "Format wyjściowy",
    'special.archive_name': "Nazwa archiwum",
    'special.compression': "Kompresja"
  },
  'bn': {
    'special.enter_number': "একটি সংখ্যা লিখুন",
    'special.conversion_type': "রূপান্তরের ধরন",
    'special.amount': "পরিমাণ",
    'special.from': "থেকে",
    'special.convert': "রূপান্তর করুন",
    'special.content_type': "কনটেন্টের ধরন",
    'special.format': "ফরম্যাট",
    'special.output_format': "আউটপুট ফরম্যাট",
    'special.archive_name': "আর্কাইভের নাম",
    'special.compression': "কমপ্রেশন"
  }
};
  Object.keys(UI_LOCALE).forEach(function(lang){ if(!EXT[lang]) EXT[lang]={}; Object.keys(UI_LOCALE[lang]).forEach(function(key){ EXT[lang][key]=UI_LOCALE[lang][key]; }); });

  var UI_EN = {};
  Object.keys(UI_TEXT).forEach(function(text){ UI_EN[UI_TEXT[text]]=text; });
  Object.keys(UI_EN).forEach(function(key){ EXT.en[key]=UI_EN[key]; });

  Object.keys(PAGE_TITLES).forEach(function(lang){
    if(!EXT[lang]) EXT[lang]={};
    EXT[lang]['special.n2w_title']=PAGE_TITLES[lang].n2w;
    EXT[lang]['special.currency_title']=PAGE_TITLES[lang].cur;
    EXT[lang]['special.qr_title']=PAGE_TITLES[lang].qr;
    EXT[lang]['special.barcode_title']=PAGE_TITLES[lang].bar;
    EXT[lang]['special.image_compressor_title']=PAGE_TITLES[lang].ic;
    EXT[lang]['special.image_converter_title']=PAGE_TITLES[lang].iv;
    EXT[lang]['special.zip_title']=PAGE_TITLES[lang].zip;
  });

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

    var PAGE_TEXT = {
      'Numbers to Words Converter':'special.n2w_title',
      'Convert large numbers, scientific notation, currency or check-writing format into words.':'special.n2w_desc',
      'Enter a number':'special.enter_number','Supports up to 300+ digit integers, decimals and scientific notation.':'special.n2w_support',
      'Conversion type':'special.conversion_type','Words':'special.words','Currency':'special.currency','Check Writing':'special.check_writing',
      'Suffix':'special.suffix','Letter Case':'special.letter_case','Clear':'special.clear_short','Result':'special.result','Copy':'special.copy',
      'Live Currency Converter':'special.currency_title','Mid-market rates · 160+ currencies':'special.currency_rates','Amount':'special.amount','From':'special.from',
      'How to convert currencies':'special.currency_how','Why use our Currency Converter?':'special.currency_why','Popular conversions':'special.currency_popular',
      'QR Code Generator':'special.qr_title','Enter your content below and click Generate':'special.qr_intro','Content type':'special.content_type','URL':'special.url','Text':'special.text','Email':'special.email','Phone':'special.phone','Wi-Fi':'special.wifi','Subject':'special.subject','Body (optional)':'special.body_optional','Network Name (SSID)':'special.network_name','Security':'special.security','Password':'special.password','Hidden':'special.hidden','Size (px)':'special.size_px','Error Correction':'special.error_correction','Foreground':'special.foreground','Background':'special.background','Generate QR Code':'special.generate_qr','How to generate a QR code':'special.qr_how','QR code use cases':'special.qr_use_cases',
      'Barcode Generator':'special.barcode_title','Generate professional barcodes instantly':'special.barcode_intro','Barcode data':'special.barcode_data','Format':'special.format','Line width':'special.line_width','Height (px)':'special.height_px','Font size':'special.font_size','Margin':'special.margin','Show text':'special.show_text','Bar color':'special.bar_color','Generate Barcode':'special.generate_barcode','How to generate a barcode':'special.barcode_how','Barcode formats explained':'special.barcode_formats',
      'Image Compressor':'special.image_compressor_title','Drop an image to start compressing':'special.image_compressor_intro','Quality: 80':'special.quality_80','Output format':'special.output_format','How to compress an image':'special.image_compressor_how','Why compress images?':'special.image_compressor_why',
      'Image Converter':'special.image_converter_title','Drop images to convert — supports batch processing':'special.image_converter_intro','Convert to':'special.convert_to','Quality (JPEG / WebP): 85':'special.quality_85','How to convert images':'special.image_converter_how','Which format should I use?':'special.format_guide',
      'ZIP Builder':'special.zip_title','Add files, then click Build ZIP to download your archive':'special.zip_intro','Archive name':'special.archive_name','Compression':'special.compression','Optimal (max)':'special.optimal','Balanced':'special.balanced','Fast (min)':'special.fast','None (no compression)':'special.none_compression','How to build a ZIP archive':'special.zip_how','Why use ZIP Builder?':'special.zip_why'
    };
    var PAGE_EN = {};
    Object.keys(PAGE_TEXT).forEach(function(text){ PAGE_EN[PAGE_TEXT[text]]=text; });
    Object.keys(PAGE_EN).forEach(function(key){ EXT.en[key]=PAGE_EN[key]; });

  /* Secondary visible labels shared across the special pages. */
  var SECONDARY_TEXT = {
    'How to convert currencies':'special.currency_how','Why use our Currency Converter?':'special.currency_why','Popular conversions':'special.currency_popular',
    'How to generate a QR code':'special.qr_how','QR code use cases':'special.qr_use_cases',
    'How to generate a barcode':'special.barcode_how','Barcode formats explained':'special.barcode_formats',
    'How to compress an image':'special.image_compressor_how','Why compress images?':'special.image_compressor_why',
    'How to convert images':'special.image_converter_how','Which format should I use?':'special.format_guide',
    'How to build a ZIP archive':'special.zip_how','Why use ZIP Builder?':'special.zip_why',
    'Related tools':'special.related','Frequently asked questions':'special.faq',
    'Generate QR Code':'special.generate_qr','Generate Barcode':'special.generate_barcode',
    'Quality: 80':'special.quality_80','Quality (JPEG / WebP): 85':'special.quality_85',
    'Convert to':'special.convert_to','Output format':'special.output_format',
    'Archive name':'special.archive_name','Compression':'special.compression'
  };
  var SECONDARY_EN = {};
  Object.keys(SECONDARY_TEXT).forEach(function(text){ SECONDARY_EN[SECONDARY_TEXT[text]]=text; });
  Object.keys(SECONDARY_EN).forEach(function(key){ EXT.en[key]=SECONDARY_EN[key]; });
  Object.keys(EXT).forEach(function(lang){
    if(lang==='en') return;
    if(!EXT[lang]) EXT[lang]={};
    /* Reuse already-reviewed generic section labels where applicable. */
    EXT[lang]['special.related']=EXT[lang]['special.related']||EXT.en['special.related'];
    EXT[lang]['special.faq']=EXT[lang]['special.faq']||EXT.en['special.faq'];
  });

  function hook(){
    extend();
    markByText('h1,h3,h4,label,legend,p,span,summary,option,button',PAGE_TEXT);
    markByText('h2,h4,p,summary,button,label,span',SECONDARY_TEXT);

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