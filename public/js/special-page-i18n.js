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
  /* Reviewed common controls used across special-page forms. */
  var COMMON_TEXT = {
    'To':'special.to','Download':'special.download_action','Customize':'special.customize',
    'Show':'special.show','Download PNG':'special.download_png','Download SVG':'special.download_svg',
    'Choose a format':'special.choose_format','Enter your data':'special.enter_data',
    'Enter your content':'special.enter_content','Add files':'special.add_files',
    'Add images':'special.add_images','Build ZIP':'special.build_zip_action',
    'Compress':'special.compress_action','Convert':'special.convert_action',
    'Keep original':'special.keep_original','Clear all':'special.clear'
  };
  var COMMON_LOCALE = {
    ur:{'special.to':'تک','special.download_action':'ڈاؤن لوڈ','special.customize':'حسبِ ضرورت بنائیں','special.show':'دکھائیں','special.download_png':'PNG ڈاؤن لوڈ کریں','special.download_svg':'SVG ڈاؤن لوڈ کریں','special.choose_format':'فارمیٹ منتخب کریں','special.enter_data':'اپنا ڈیٹا درج کریں','special.enter_content':'اپنا مواد درج کریں','special.add_files':'فائلیں شامل کریں','special.add_images':'تصاویر شامل کریں','special.build_zip_action':'ZIP بنائیں','special.compress_action':'کمپریس کریں','special.convert_action':'تبدیل کریں','special.keep_original':'اصل برقرار رکھیں','special.clear':'سب صاف کریں'},
    ar:{'special.to':'إلى','special.download_action':'تنزيل','special.customize':'تخصيص','special.show':'إظهار','special.download_png':'تنزيل PNG','special.download_svg':'تنزيل SVG','special.choose_format':'اختر تنسيقًا','special.enter_data':'أدخل بياناتك','special.enter_content':'أدخل المحتوى','special.add_files':'إضافة ملفات','special.add_images':'إضافة صور','special.build_zip_action':'إنشاء ZIP','special.compress_action':'ضغط','special.convert_action':'تحويل','special.keep_original':'الاحتفاظ بالأصل','special.clear':'مسح الكل'},
    fa:{'special.to':'به','special.download_action':'دانلود','special.customize':'سفارشی‌سازی','special.show':'نمایش','special.download_png':'دانلود PNG','special.download_svg':'دانلود SVG','special.choose_format':'یک قالب انتخاب کنید','special.enter_data':'داده‌ها را وارد کنید','special.enter_content':'محتوا را وارد کنید','special.add_files':'افزودن فایل‌ها','special.add_images':'افزودن تصاویر','special.build_zip_action':'ساخت ZIP','special.compress_action':'فشرده‌سازی','special.convert_action':'تبدیل','special.keep_original':'حفظ اصلی','special.clear':'پاک کردن همه'},
    hi:{'special.to':'तक','special.download_action':'डाउनलोड','special.customize':'कस्टमाइज़ करें','special.show':'दिखाएं','special.download_png':'PNG डाउनलोड करें','special.download_svg':'SVG डाउनलोड करें','special.choose_format':'फ़ॉर्मेट चुनें','special.enter_data':'अपना डेटा दर्ज करें','special.enter_content':'अपनी सामग्री दर्ज करें','special.add_files':'फ़ाइलें जोड़ें','special.add_images':'छवियां जोड़ें','special.build_zip_action':'ZIP बनाएं','special.compress_action':'कंप्रेस करें','special.convert_action':'कन्वर्ट करें','special.keep_original':'मूल रखें','special.clear':'सब साफ़ करें'},
    bn:{'special.to':'এতে','special.download_action':'ডাউনলোড','special.customize':'কাস্টমাইজ করুন','special.show':'দেখান','special.download_png':'PNG ডাউনলোড করুন','special.download_svg':'SVG ডাউনলোড করুন','special.choose_format':'ফরম্যাট বাছাই করুন','special.enter_data':'আপনার ডেটা লিখুন','special.enter_content':'আপনার কনটেন্ট লিখুন','special.add_files':'ফাইল যোগ করুন','special.add_images':'ছবি যোগ করুন','special.build_zip_action':'ZIP তৈরি করুন','special.compress_action':'কমপ্রেস করুন','special.convert_action':'রূপান্তর করুন','special.keep_original':'মূলটি রাখুন','special.clear':'সব পরিষ্কার করুন'},
    zh:{'special.to':'到','special.download_action':'下载','special.customize':'自定义','special.show':'显示','special.download_png':'下载 PNG','special.download_svg':'下载 SVG','special.choose_format':'选择格式','special.enter_data':'输入数据','special.enter_content':'输入内容','special.add_files':'添加文件','special.add_images':'添加图片','special.build_zip_action':'创建 ZIP','special.compress_action':'压缩','special.convert_action':'转换','special.keep_original':'保留原图','special.clear':'全部清除'},
    ja:{'special.to':'宛先','special.download_action':'ダウンロード','special.customize':'カスタマイズ','special.show':'表示','special.download_png':'PNGをダウンロード','special.download_svg':'SVGをダウンロード','special.choose_format':'形式を選択','special.enter_data':'データを入力','special.enter_content':'内容を入力','special.add_files':'ファイルを追加','special.add_images':'画像を追加','special.build_zip_action':'ZIPを作成','special.compress_action':'圧縮','special.convert_action':'変換','special.keep_original':'元の画像を保持','special.clear':'すべてクリア'},
    ko:{'special.to':'대상','special.download_action':'다운로드','special.customize':'사용자 지정','special.show':'표시','special.download_png':'PNG 다운로드','special.download_svg':'SVG 다운로드','special.choose_format':'형식 선택','special.enter_data':'데이터 입력','special.enter_content':'콘텐츠 입력','special.add_files':'파일 추가','special.add_images':'이미지 추가','special.build_zip_action':'ZIP 만들기','special.compress_action':'압축','special.convert_action':'변환','special.keep_original':'원본 유지','special.clear':'모두 지우기'},
    tr:{'special.to':'Hedef','special.download_action':'İndir','special.customize':'Özelleştir','special.show':'Göster','special.download_png':'PNG indir','special.download_svg':'SVG indir','special.choose_format':'Biçim seçin','special.enter_data':'Verilerinizi girin','special.enter_content':'İçeriğinizi girin','special.add_files':'Dosya ekle','special.add_images':'Görsel ekle','special.build_zip_action':'ZIP oluştur','special.compress_action':'Sıkıştır','special.convert_action':'Dönüştür','special.keep_original':'Orijinali koru','special.clear':'Tümünü temizle'},
    id:{'special.to':'Ke','special.download_action':'Unduh','special.customize':'Sesuaikan','special.show':'Tampilkan','special.download_png':'Unduh PNG','special.download_svg':'Unduh SVG','special.choose_format':'Pilih format','special.enter_data':'Masukkan data','special.enter_content':'Masukkan konten','special.add_files':'Tambah file','special.add_images':'Tambah gambar','special.build_zip_action':'Buat ZIP','special.compress_action':'Kompres','special.convert_action':'Konversi','special.keep_original':'Pertahankan asli','special.clear':'Hapus semua'},
    ru:{'special.to':'В','special.download_action':'Скачать','special.customize':'Настроить','special.show':'Показать','special.download_png':'Скачать PNG','special.download_svg':'Скачать SVG','special.choose_format':'Выберите формат','special.enter_data':'Введите данные','special.enter_content':'Введите содержимое','special.add_files':'Добавить файлы','special.add_images':'Добавить изображения','special.build_zip_action':'Создать ZIP','special.compress_action':'Сжать','special.convert_action':'Конвертировать','special.keep_original':'Сохранить оригинал','special.clear':'Очистить всё'},
    fr:{'special.to':'Vers','special.download_action':'Télécharger','special.customize':'Personnaliser','special.show':'Afficher','special.download_png':'Télécharger PNG','special.download_svg':'Télécharger SVG','special.choose_format':'Choisir un format','special.enter_data':'Saisissez vos données','special.enter_content':'Saisissez votre contenu','special.add_files':'Ajouter des fichiers','special.add_images':'Ajouter des images','special.build_zip_action':'Créer le ZIP','special.compress_action':'Compresser','special.convert_action':'Convertir','special.keep_original':'Conserver l’original','special.clear':'Tout effacer'},
    de:{'special.to':'Nach','special.download_action':'Herunterladen','special.customize':'Anpassen','special.show':'Anzeigen','special.download_png':'PNG herunterladen','special.download_svg':'SVG herunterladen','special.choose_format':'Format auswählen','special.enter_data':'Daten eingeben','special.enter_content':'Inhalt eingeben','special.add_files':'Dateien hinzufügen','special.add_images':'Bilder hinzufügen','special.build_zip_action':'ZIP erstellen','special.compress_action':'Komprimieren','special.convert_action':'Konvertieren','special.keep_original':'Original beibehalten','special.clear':'Alle löschen'},
    es:{'special.to':'A','special.download_action':'Descargar','special.customize':'Personalizar','special.show':'Mostrar','special.download_png':'Descargar PNG','special.download_svg':'Descargar SVG','special.choose_format':'Elegir formato','special.enter_data':'Introduce tus datos','special.enter_content':'Introduce tu contenido','special.add_files':'Añadir archivos','special.add_images':'Añadir imágenes','special.build_zip_action':'Crear ZIP','special.compress_action':'Comprimir','special.convert_action':'Convertir','special.keep_original':'Conservar original','special.clear':'Borrar todo'},
    pt:{'special.to':'Para','special.download_action':'Baixar','special.customize':'Personalizar','special.show':'Mostrar','special.download_png':'Baixar PNG','special.download_svg':'Baixar SVG','special.choose_format':'Escolher formato','special.enter_data':'Digite seus dados','special.enter_content':'Digite seu conteúdo','special.add_files':'Adicionar arquivos','special.add_images':'Adicionar imagens','special.build_zip_action':'Criar ZIP','special.compress_action':'Comprimir','special.convert_action':'Converter','special.keep_original':'Manter original','special.clear':'Limpar tudo'},
    it:{'special.to':'A','special.download_action':'Scarica','special.customize':'Personalizza','special.show':'Mostra','special.download_png':'Scarica PNG','special.download_svg':'Scarica SVG','special.choose_format':'Scegli formato','special.enter_data':'Inserisci i dati','special.enter_content':'Inserisci il contenuto','special.add_files':'Aggiungi file','special.add_images':'Aggiungi immagini','special.build_zip_action':'Crea ZIP','special.compress_action':'Comprimi','special.convert_action':'Converti','special.keep_original':'Mantieni originale','special.clear':'Cancella tutto'},
    nl:{'special.to':'Naar','special.download_action':'Downloaden','special.customize':'Aanpassen','special.show':'Tonen','special.download_png':'PNG downloaden','special.download_svg':'SVG downloaden','special.choose_format':'Kies een indeling','special.enter_data':'Voer uw gegevens in','special.enter_content':'Voer uw inhoud in','special.add_files':'Bestanden toevoegen','special.add_images':'Afbeeldingen toevoegen','special.build_zip_action':'ZIP maken','special.compress_action':'Comprimeren','special.convert_action':'Converteren','special.keep_original':'Origineel behouden','special.clear':'Alles wissen'},
    pl:{'special.to':'Do','special.download_action':'Pobierz','special.customize':'Dostosuj','special.show':'Pokaż','special.download_png':'Pobierz PNG','special.download_svg':'Pobierz SVG','special.choose_format':'Wybierz format','special.enter_data':'Wpisz dane','special.enter_content':'Wpisz treść','special.add_files':'Dodaj pliki','special.add_images':'Dodaj obrazy','special.build_zip_action':'Utwórz ZIP','special.compress_action':'Kompresuj','special.convert_action':'Konwertuj','special.keep_original':'Zachowaj oryginał','special.clear':'Wyczyść wszystko'}
  };
  Object.keys(COMMON_LOCALE).forEach(function(lang){ if(!EXT[lang]) EXT[lang]={}; Object.keys(COMMON_LOCALE[lang]).forEach(function(key){ EXT[lang][key]=COMMON_LOCALE[lang][key]; }); });
  Object.keys(COMMON_TEXT).forEach(function(text){ EXT.en[COMMON_TEXT[text]]=text; });

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
  var FAQ_TEXT = {
    'Can I use this for travel or shopping?':'special.currency_faq_travel',
    'What can I encode in a QR code?':'special.qr_faq_encode',
    'What error correction level should I use?':'special.qr_faq_error',
    'What is the difference between PNG and SVG output?':'special.qr_faq_png_svg',
    'Can I use a custom color?':'special.qr_faq_color',
    'Is the QR code generator free?':'special.qr_faq_free',
    'Which format should I use for retail products?':'special.barcode_faq_retail',
    'Can I encode letters in a barcode?':'special.barcode_faq_letters',
    'Why is my EAN-13 showing an error?':'special.barcode_faq_ean',
    'What is the best download format for printing?':'special.barcode_faq_print',
    'Is the barcode generator free?':'special.barcode_faq_free',
    'Which formats can I compress?':'special.image_compressor_faq_formats',
    'What quality level should I use?':'special.image_compressor_faq_quality',
    'Are my images uploaded anywhere?':'special.image_faq_uploaded',
    'Can I convert format while compressing?':'special.image_compressor_faq_convert',
    'Is it free?':'special.free_faq',
    'Can I convert multiple images at once?':'special.image_converter_faq_multiple',
    'Will converting PNG to JPEG lose transparency?':'special.image_converter_faq_transparency',
    'What does quality do for PNG?':'special.image_converter_faq_quality',
    'Does ZIP Builder upload my files?':'special.zip_faq_upload',
    'How large can the ZIP archive be?':'special.zip_faq_size',
    'What is the difference between compression levels?':'special.zip_faq_levels',
    'Can I add folders to the ZIP?':'special.zip_faq_folders',
    'Is ZIP Builder free?':'special.zip_faq_free'
  };
  /* Structured FAQ question coverage: these strings are also present in JSON-LD. */
  var STRUCTURED_FAQ_TEXT = {
    'How accurate is the Currency Converter?':'special.currency_faq_accuracy',
    'Which currencies are supported?':'special.currency_faq_currencies',
    'Is the Currency Converter free?':'special.currency_faq_free',
    'Can I use this for travel and shopping?':'special.currency_faq_travel',
    'Can I customize QR code colors?':'special.qr_faq_color',
    'Which barcode formats are supported?':'special.barcode_faq_formats',
    'What is EAN-13 used for?':'special.barcode_faq_ean_use',
    'Can I download the barcode as PNG?':'special.barcode_faq_png',
    'Which image formats can I compress?':'special.image_compressor_faq_formats',
    'Are my images uploaded to a server?':'special.image_faq_uploaded_server',
    'Is Image Compressor free?':'special.image_compressor_faq_free',
    'Which image formats are supported?':'special.image_converter_faq_formats',
    'What quality setting should I use for JPEG and WebP?':'special.image_converter_faq_quality_jpeg',
    'How large can the files be?':'special.zip_faq_size',
    'What compression level should I choose?':'special.zip_faq_levels_choose'
  };
  var STRUCTURED_FAQ_EN = {};
  Object.keys(STRUCTURED_FAQ_TEXT).forEach(function(text){ STRUCTURED_FAQ_EN[STRUCTURED_FAQ_TEXT[text]]=text; });
  Object.keys(STRUCTURED_FAQ_EN).forEach(function(key){ EXT.en[key]=STRUCTURED_FAQ_EN[key]; });

  var FAQ_EN = {};
  Object.keys(FAQ_TEXT).forEach(function(text){ FAQ_EN[FAQ_TEXT[text]]=text; });
  Object.keys(FAQ_EN).forEach(function(key){ EXT.en[key]=FAQ_EN[key]; });
  var BODY_TEXT = {
    'Drop an image to start compressing':'special.image_compressor_drop_title',
    'Drop an image here':'special.image_compressor_drop',
    'Drop images to convert — supports batch processing':'special.image_converter_drop_title',
    'Drop images here':'special.image_converter_drop',
    'Add files, then click Build ZIP to download your archive':'special.zip_drop_title',
    'Drop files here':'special.zip_drop',
    'How it works':'special.how_it_works',
    'Create a free account to unlock 2 GB of cloud storage.':'special.account_cloud'
  };
  var BODY_EN = {};
  Object.keys(BODY_TEXT).forEach(function(text){ BODY_EN[BODY_TEXT[text]]=text; });
  Object.keys(BODY_EN).forEach(function(key){ EXT.en[key]=BODY_EN[key]; });

  var LONG_TEXT = {
    'Free PDF &amp; Image tools online. Files are deleted automatically after processing — your privacy comes first.':'special.related_desc',
    'Create Code128, EAN, UPC barcodes':'special.related_barcode',
    'Convert numbers to readable text':'special.related_n2w',
    'Live exchange rates for 160+ currencies':'special.related_currency',
    'Bundle files into a ZIP archive':'special.related_zip',
    'Convert between JPG, PNG, WebP':'special.related_image_convert',
    'Reduce image file size':'special.related_image_compress',
    'Erase image backgrounds':'special.related_background',
    'Trim images precisely':'special.related_crop',
    'Change image dimensions':'special.related_resize',
    'Apply photo filters':'special.related_filters',
    'Create QR codes for URLs and text':'special.related_qr',
    'Erase image backgrounds':'special.related_background'
  };
  var LONG_EN = {};
  Object.keys(LONG_TEXT).forEach(function(text){ LONG_EN[LONG_TEXT[text]]=text; });
  Object.keys(LONG_EN).forEach(function(key){ EXT.en[key]=LONG_EN[key]; });

  var INSTRUCTION_TEXT = {
    'How to convert currencies':'special.currency_how',
    'Why use our Currency Converter?':'special.currency_why',
    'Popular conversions':'special.currency_popular',
    'How to generate a QR code':'special.qr_how',
    'QR code use cases':'special.qr_use_cases',
    'How to generate a barcode':'special.barcode_how',
    'Barcode formats explained':'special.barcode_formats',
    'How to compress an image':'special.image_compressor_how',
    'Why compress images?':'special.image_compressor_why',
    'How to convert images':'special.image_converter_how',
    'Which format should I use?':'special.format_guide',
    'How to build a ZIP archive':'special.zip_how',
    'Why use ZIP Builder?':'special.zip_why',
    'Frequently asked questions':'special.faq',
    'Related tools':'special.related'
  };
  var INSTRUCTION_EN = {};
  Object.keys(INSTRUCTION_TEXT).forEach(function(text){ INSTRUCTION_EN[INSTRUCTION_TEXT[text]]=text; });
  Object.keys(INSTRUCTION_EN).forEach(function(key){ EXT.en[key]=INSTRUCTION_EN[key]; });

  var PARAGRAPH_TEXT = {
    'Convert large numbers, scientific notation, currency or check-writing format into words.':'special.n2w_desc',
    'Supports up to 300+ digit integers, decimals and scientific notation.':'special.n2w_support',
    'Convert any amount between 160+ world currencies in real time. Rates are pulled from public mid-market sources and refreshed several times a day, so what you see is the same number used by banks and financial apps before they add a margin. No signup, no rate limits, no popups.':'special.currency_desc',
    'We use mid-market rates pulled from public providers, refreshed several times per day. They match what financial apps quote before adding a margin or fee. Real bank or card rates may differ slightly because of those fees.':'special.currency_rates',
    '160+ — every major fiat (USD, EUR, GBP, INR, JPY, CNY, AUD, CAD…) plus regional currencies across Africa, Asia, Latin America and the Middle East. A few precious metals and major cryptocurrencies are also included.':'special.currency_coverage',
    'Create QR codes instantly for any content — URLs, plain text, email addresses, phone numbers, Wi-Fi passwords, and more. Choose your size, colors, and error correction level, then download as PNG or SVG with one click. Runs entirely in your browser with no uploads and no signup.':'special.qr_desc',
    'Create professional barcodes for retail products, books, inventory management, and shipping labels. Supports 12+ formats including Code128, EAN-13, UPC-A, Code39, and ITF-14. Fully customizable — adjust line width, height, font size, and label. Download as SVG or PNG for print or digital use.':'special.barcode_desc',
    'Reduce the file size of your JPG, PNG, and WebP images without visible quality loss. Use the quality slider to find the perfect balance between file size and visual fidelity, then see the before and after sizes side by side before downloading. Everything runs in your browser — your images are never uploaded anywhere.':'special.image_compressor_desc',
    'Convert images between JPG, PNG, and WebP format instantly in your browser. Add multiple images and convert them all at once. WebP typically produces images 25–35% smaller than JPEG at equivalent quality — ideal for web use. PNG preserves transparency. All processing is done locally: your images are never uploaded anywhere.':'special.image_converter_desc',
    'Combine any number of files into a single ZIP archive right in your browser — no uploads, no servers, complete privacy. Drag and drop files, choose a compression level, name your archive, then download it in seconds. Powered by JSZip, a proven open-source library used by millions.':'special.zip_desc',
    'Select URL, Text, Email, Phone, or Wi-Fi from the tabs above.':'special.qr_step_select',
    'Type or paste the information you want to encode into the QR code.':'special.qr_step_type',
    'Choose size, error correction level, and colors to match your brand.':'special.qr_step_options',
    'Click Generate, then download as PNG for photos or SVG for infinite scaling.':'special.qr_step_generate',
    'Select the barcode standard that matches your use case — Code128 for general use, EAN-13 for retail.':'special.barcode_step_select',
    'Type the value you want to encode. EAN and UPC formats have strict digit requirements.':'special.barcode_step_type',
    'Adjust line width, height, font size, colors, and margin to suit your label design.':'special.barcode_step_options',
    'Download SVG for scalable print use, or PNG for digital environments and quick testing.':'special.barcode_step_download',
    'Drop a JPG, PNG, or WebP image onto the tool, or click Browse to select one from your device.':'special.image_compressor_step_select',
    'Use the quality slider — 80 is a great starting point. Lower values = smaller files, less quality.':'special.image_compressor_step_quality',
    'Click Compress to see the before and after side by side with file sizes and savings percentage.':'special.image_compressor_step_compress',
    'Happy with the result? Click Download to save the compressed image to your device.':'special.image_compressor_step_download',
    'Drop one or more JPG, PNG, or WebP images onto the tool, or click Browse to select them.':'special.image_converter_step_select',
    'Select your target format: JPEG for photos, PNG for graphics with transparency, WebP for web.':'special.image_converter_step_format',
    'For JPEG and WebP, quality 80–90 gives excellent results. For PNG, quality has no effect (lossless).':'special.image_converter_step_quality',
    'Click Convert — each image is downloaded individually in the new format, ready to use.':'special.image_converter_step_convert',
    'Drag and drop any files onto the drop zone, or click Browse to select them from your device.':'special.zip_step_select',
    'Give your ZIP file a meaningful name. The .zip extension is added automatically.':'special.zip_step_name',
    'Optimal compresses most, Fast is quicker. None just packages files without shrinking them.':'special.zip_step_compression',
    'Click Build ZIP. The archive is created in your browser and downloaded automatically.':'special.zip_step_build'
  };
  var PARAGRAPH_EN = {};
  Object.keys(PARAGRAPH_TEXT).forEach(function(text){ PARAGRAPH_EN[PARAGRAPH_TEXT[text]]=text; });
  Object.keys(PARAGRAPH_EN).forEach(function(key){ EXT.en[key]=PARAGRAPH_EN[key]; });

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

  /* Generic semantic coverage for static copy not yet assigned a reviewed key.
     This is deliberately fallback-first: it records the original English source text,
     gives it a deterministic key, and lets RuntimeI18n keep English until a reviewed
     locale override exists. It prevents untranslated text from being invisible to the
     localization system while page-specific engines remain untouched. */
  function autoKey(text){
    var s=String(text||'').trim();
    var h=2166136261;
    for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    return 'special.auto_'+(h>>>0).toString(36);
  }
  function autoSemanticCoverage(){
    var nodes=document.querySelectorAll('h1,h2,h3,h4,h5,h6,label,legend,p,button,summary,option,figcaption,a');
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];
      if(el.closest && el.closest('header,footer,nav,.site-header,.footer')) continue;
      if(el.hasAttribute('data-i18n')) continue;
      var source=el.getAttribute('data-special-source')||el.textContent||'';
      source=source.replace(/\\s+/g,' ').trim();
      if(!source || source.length<2 || /^[\\d\\s.,:%+\\-–—/()]+$/.test(source)) continue;
      var key=autoKey(source);
      el.setAttribute('data-special-source',source);
      el.setAttribute('data-i18n',key);
      EXT.en[key]=source;
    }
  }

  function hook(){
    autoSemanticCoverage();
    extend();
    markByText('h1,h3,h4,label,legend,p,span,summary,option,button',PAGE_TEXT);
    markByText('h2,h4,p,summary,button,label,span',SECONDARY_TEXT);
    markByText('h2,h3,h4,p,summary,button,label,span',FAQ_TEXT);
    markByText('h1,h2,h3,h4,p,button,label,span',BODY_TEXT);
    markByText('h2,h3,h4,p,a,button,span',LONG_TEXT);
    markByText('h2,h3,h4,p,summary,button,span',INSTRUCTION_TEXT);
    markByText('p,h2,h3,h4,li',PARAGRAPH_TEXT);

    /* Breadcrumb home and major section headings. */
    markByText('.bc-link',{'Home':'special.home'});
    markByText('h2',{'How it works':'special.how','Frequently asked questions':'special.faq','Related tools':'special.related'});
    markByText('h1,h2,h3,h4,h5,h6,label,legend,p,button,summary,option,span',COMMON_TEXT);

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