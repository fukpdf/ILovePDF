/**
 * LABA CONVERSATIONAL INTELLIGENCE  v1.0
 * window.LabaConversationalAI
 *
 * Phase 1 — Multilingual conversational AI layer.
 * Handles: English · Roman Urdu · typo tolerance · weather · news ·
 *          intent classification · text utilities · tool guidance.
 *
 * Purely additive — slots into laba-ai-chat.js AiQueryEngine pipeline.
 * No existing modules are modified.
 */
(function () {
  'use strict';

  if (window.LabaConversationalAI) return;

  var VERSION = '1.0';
  var LOG = '[LCAI]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }
  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 1  ROMAN URDU NORMALIZER
  // Maps Roman Urdu / Hinglish phrases → English equivalents so the
  // downstream intent engine can match them with standard patterns.
  // ═══════════════════════════════════════════════════════════════════
  var RomanUrduNorm = (function () {
    var _map = [
      // Greetings — English, Roman Urdu, Pakistani
      { rx:/\b(assalam\s*o?\s*alaikum|aslam\s*o\s*alaikum|assalamualaikum|aolokom|walaikum\s*salam|adaab|adab)\b/i, en:'hello' },
      { rx:/^(aoa|a\.o\.a|ao\s*bhai|ao\s*ji|aa\s*gaye|agaye|aagaye)\b/i, en:'hello' },
      { rx:/\b(kaise\s*ho|kaisi\s*ho|kia\s*haal|kya\s*haal|kaisa\s*hai|ap\s*kaisy\s*hain|aap\s*kaise|kiya\s*hal|kia\s*hal|kya\s*hal|kiya\s*haal|kia\s*haal\s*hai)\b/i, en:'how are you' },
      { rx:/\b(kya\s*scene|kia\s*scene|kya\s*chal\s*raha|kia\s*ho\s*rha|kia\s*ho\s*raha|kuch\s*khaas|sab\s*(theek|thik)|koi\s*kaam)\b/i, en:'how are you what is up' },
      { rx:/\b(shukriya|shukrya|shukria|shukar|dhanyawad|meherbani|shukriya\s*bhai)\b/i, en:'thank you' },
      { rx:/\b(theek|theak|thik)\s*(hai|hain|ho)?\b/i, en:'fine good' },
      { rx:/\b(acha|accha|achha)\b/i, en:'good okay' },
      { rx:/\b(ye\s*kaam\s*(nahi|nhi)|yeh\s*kaam\s*(nahi|nhi)|kaam\s*(nhi|nahi)\s*chal|nhi\s*(chal|ho)\s*(rha|raha)|problem\s*(aa|ho)\s*(rhi|raha))\b/i, en:'this is not working problem' },
      { rx:/\b(joke|mazaak|mazak|funny\s*(baat|sunao|karo)|hasao\s*mujhe)\b/i, en:'tell me a joke' },

      // PDF tool intents — file size
      { rx:/\bpdf\s*(chota|chhota|chotay|chhota)\s*(kar|kr|karo|krdo|karna|krna)\b/i, en:'compress pdf' },
      { rx:/\b(chota|chhota|chotay)\s*(kar|kr|karo|krdo|karna|krna)\b/i, en:'compress' },
      { rx:/\bcompress\s*(kar|karo|krdo|krna)\b/i, en:'compress' },
      { rx:/\bsize\s*(kam|choti|chhoti)\s*(kar|karo|krdo)\b/i, en:'compress reduce size' },

      // Merge / join
      { rx:/\b(joro|jodo|mila|milao|milado|combine\s*karo)\b/i, en:'merge combine' },

      // Split / separate
      { rx:/\b(alag|alag\s*karo|tukre|kata|cut\s*karo)\b/i, en:'split separate' },

      // Convert
      { rx:/\b(word|word\s*mein|word\s*main)\s*(convert|badal|badlo|tabd|kar)\b/i, en:'convert to word' },
      { rx:/\b(convert|badal|badlo|tabd)\s*(word\s*(mein|main|me)|word)\b/i, en:'convert to word' },
      { rx:/\b(convert|badal|badlo)\s*(pdf\s*(mein|main|me)|pdf)\b/i, en:'convert to pdf' },
      { rx:/\b(pdf\s*(se|sy)\s*(word|excel|image|jpg))\b/i, en:'convert pdf to word' },
      { rx:/\b(word\s*(se|sy)\s*pdf)\b/i, en:'word to pdf' },
      { rx:/\b(convert|badal|badlo|tabd)\s*(karo|kro|krdo|karna|krna)\b/i, en:'convert' },

      // OCR / text extract
      { rx:/\b(text\s*(nikalo|nikalna|nikaalo|bahar\s*(nikalo|karo)))\b/i, en:'extract text ocr' },
      { rx:/\b(scan\s*(paro|parho|karke\s*text))\b/i, en:'ocr scan text' },

      // Summarize
      { rx:/\b(khulasa|khulasa\s*(karo|kro|banao)|summary\s*(banao|karo))\b/i, en:'summarize summary' },

      // Translate
      { rx:/\b(anuvad|tarjuma|translate)\s*(karo|kro|krdo|krna)\b/i, en:'translate' },
      { rx:/\b(urdu\s*(mein|main|me)\s*(likho|convert|translate|badlo))\b/i, en:'translate to urdu' },
      { rx:/\b(english\s*(mein|main|me)\s*(likho|convert|translate|badlo))\b/i, en:'translate to english' },

      // Watermark / stamp
      { rx:/\b(watermark|marka)\s*(lagao|laga|dalo|add\s*karo)\b/i, en:'add watermark' },

      // Protect / password
      { rx:/\b(password|lock)\s*(lagao|laga|rakho|dalo)\b/i, en:'protect password' },

      // Sign
      { rx:/\b(sign\s*(karo|kro|krdo|krna)|dastakhat)\b/i, en:'sign pdf' },

      // Background remove
      { rx:/\b(background|bg|pichla|peechla)\s*(hatao|hata|nikalo|remove|delete)\b/i, en:'remove background' },

      // Weather
      { rx:/\b(mausam|mosam)\b/i, en:'weather' },
      { rx:/\b(garmi|garm)\b/i, en:'weather hot temperature' },
      { rx:/\b(thand|thanda)\b/i, en:'weather cold temperature' },
      { rx:/\b(barish|barsaat|baarish)\b/i, en:'weather rain' },
      { rx:/\b(lahore|karachi|islamabad|rawalpindi|peshawar|quetta|multan|faisalabad)\s*(ka|ki|ke|mein|main)?\s*(mausam|mosam|temperature|temp)\b/i,
         en: function(m) { return 'weather in ' + m[1]; } },

      // News
      { rx:/\b(khabar|khabren|taza\s*khabar|tazah\s*khabr|akhbar|aaj\s*ki\s*khabar)\b/i, en:'news headlines' },
      { rx:/\b(aaj\s*(ki|ka)\s*(khabar|news))\b/i, en:'today news' },

      // General queries
      { rx:/\b(kya\s*kar\s*sakta|kya\s*ker\s*skty|kia\s*ker\s*skte|kia\s*kar\s*sak)\b/i, en:'what can you do' },
      { rx:/\b(madad|help\s*karo|help\s*chahiye|mujhe\s*madad)\b/i, en:'help me' },

      // Writing utilities
      { rx:/\b(email\s*(likho|likhni|likhna|banao|draft))\b/i, en:'write email' },
      { rx:/\b(grammar\s*(sahi|theek|fix|durust)\s*(karo|kro|krdo))\b/i, en:'fix grammar' },
      { rx:/\b(dobara\s*likho|naya\s*(karo|likho)|rewrite\s*(karo|kro))\b/i, en:'rewrite text' },
      { rx:/\b(samjhao|samjhana|explain\s*(karo|kro)|wazahat)\b/i, en:'explain' },

      // Calculations
      { rx:/\b(hisab|hisaab|gintri|calculate\s*(karo|kro))\b/i, en:'calculate math' },

      // Time / date
      { rx:/\b(aaj\s*(ki\s*)?tarikh|aj\s*(ki\s*)?date|aj\s*konsi\s*tarikh)\b/i, en:'what is today date' },
      { rx:/\b(waqt\s*(kya|batao)|time\s*(kya\s*hai|batao))\b/i, en:'what is the time' },
      { rx:/\b(kal\s*kya)\b/i, en:'tomorrow forecast' },
    ];

    function normalize(text) {
      var out = text;
      for (var i = 0; i < _map.length; i++) {
        var entry = _map[i];
        if (typeof entry.en === 'function') {
          out = out.replace(entry.rx, function (match) {
            var args = [match].concat([].slice.call(arguments));
            return entry.en(args);
          });
        } else {
          out = out.replace(entry.rx, entry.en);
        }
      }
      return out;
    }

    var _urduDetect = /\b(hai|hain|ho|karo|karo|aur|ya|mein|main|ko|se|ka|ki|ke|jo|yeh|ye|woh|wo|kya|kyun|kaise|kaisa|aaj|kal|ab|phir|bhi|nahi|na|haan|han|theek|thik|accha|pdf|file|document|bhai|yaar|ji|ap|aap|mujhe|mujhy|tumhe|hamara)\b/i;
    function isRomanUrdu(text) { return _urduDetect.test(text); }

    return { normalize: normalize, isRomanUrdu: isRomanUrdu };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 2  TYPO CORRECTOR
  // Dictionary of common misspellings + Levenshtein fuzzy matching.
  // ═══════════════════════════════════════════════════════════════════
  var TypoCorrector = (function () {
    var _dict = {
      'cnvrt':'convert','covernt':'convert','convrt':'convert','converty':'convert',
      'compres':'compress','comress':'compress','cmprs':'compress','cmpress':'compress',
      'sumrize':'summarize','sumarize':'summarize','summrize':'summarize','summerise':'summarize','sumarise':'summarize',
      'translat':'translate','tranlate':'translate','traslate':'translate','transalte':'translate',
      'mergr':'merge','merg':'merge','mrge':'merge',
      'splitt':'split','splt':'split','spit':'split',
      'rotat':'rotate','rtate':'rotate',
      'pasword':'password','passowrd':'password','passwd':'password',
      'signn':'sign','sgin':'sign',
      'waht':'what','whta':'what','wtha':'what','wath':'what',
      'teh':'the','adn':'and','fo':'of',
      'hwo':'how','hoe':'how',
      'taht':'that','thta':'that',
      'cna':'can','nad':'and',
      'weahter':'weather','wetaher':'weather','weathr':'weather','wheather':'weather','wether':'weather',
      'newws':'news','nwes':'news','nees':'news',
      'todya':'today','toady':'today','tday':'today','toady':'today',
      'helpp':'help','hlep':'help','hepl':'help',
      'wrtie':'write','wirte':'write','wirte':'write',
      'eamil':'email','emali':'email','emial':'email',
      'grammer':'grammar','gramer':'grammar','gramr':'grammar',
      'calcualte':'calculate','claculate':'calculate','clculate':'calculate',
      'explian':'explain','explan':'explain','expain':'explain',
      'reomve':'remove','remov':'remove','rmove':'remove',
      'backgrond':'background','backround':'background','backgroud':'background',
      'docuemnt':'document','documnet':'document','documet':'document',
      'downlod':'download','dwnload':'download','dwonload':'download',
      'uploaad':'upload','uplod':'upload','uplaod':'upload',
      'sumarize':'summarize','summrise':'summarize',
      'ocr':'ocr',
      'disss':'this','dis':'this','tis':'this',
      'u':'you','ur':'your','r':'are','y':'why','2':'to','4':'for',
    };

    function correct(text) {
      return text.replace(/\b(\w+)\b/g, function (word) {
        var lower = word.toLowerCase();
        return _dict[lower] !== undefined ? _dict[lower] : word;
      });
    }

    function levenshtein(a, b) {
      var m = a.length, n = b.length, dp = [], i, j;
      for (i = 0; i <= m; i++) { dp[i] = [i]; }
      for (j = 0; j <= n; j++) { dp[0][j] = j; }
      for (i = 1; i <= m; i++) {
        for (j = 1; j <= n; j++) {
          dp[i][j] = a[i-1] === b[j-1]
            ? dp[i-1][j-1]
            : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
      }
      return dp[m][n];
    }

    return { correct: correct, levenshtein: levenshtein };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 3  INTENT ENGINE
  // Returns { intent, confidence, entities, requires_web, requires_tool,
  //           suggested_tool, normalized }
  // ═══════════════════════════════════════════════════════════════════
  var IntentEngine = (function () {
    var _defs = [
      { id:'greeting',
        patterns:[/^(hi|hello|hey|howdy|yo|sup|hiya|heya|salaam|salam|adab|namaste|bonjour|hola|ciao|merhaba|ahlan|shalom|aoa|slm|helo|hellow|hullo|salam\s*bhai|hey\s*bhai)\b/i,
                  /\b(good\s*(morning|afternoon|evening|night|day))\b/i,
                  /^(aoa|assalam|salam\.?\s*alaikum|walaikum|walikum)\b/i] },

      { id:'how_are_you',
        patterns:[/\b(how\s*are\s*you|how\s*r\s*u|u\s*ok|you\s*ok|you\s*good|you\s*alright|all\s*good|how are you doing)\b/i,
                  /\b(kiya\s*hal|kia\s*haal|kya\s*haal|kaisy\s*ho|kaise\s*ho|what.*up|whats\s*up)\b/i] },

      { id:'small_talk',
        patterns:[/\b(kya\s*scene|kia\s*scene|kya\s*chal\s*raha|kia\s*ho\s*rha|kuch\s*khaas|what.*up|wazzup|sup\b|koi\s*baat|koi\s*kaam|sab\s*theek)\b/i,
                  /\b(bhai\s*(kya|kia)\s*(chal|ho)|yaar\s*(kya|kia)|dost\s*(kya|kia))\b/i] },

      { id:'frustration',
        patterns:[/\b(ye\s*kaam\s*nahi|nhi\s*chal\s*rha|problem\s*aa\s*rhi|is\s*not\s*working|not\s*working|doesn.*work|broken|nhi\s*ho\s*rha|kuch\s*nahi\s*ho\s*rha|kaam\s*nahi)\b/i,
                  /\b(why\s*(is|isn.?t)\s*(it|this)\s*(not\s*)?working|kyun\s*nahi|kyon\s*nahi)\b/i] },

      { id:'joke',
        patterns:[/\b(tell.*joke|joke.*sunao|funny|make.*laugh|hasao|joke\s*(do|batao|sunao|please|suna))\b/i] },

      { id:'identity',
        patterns:[/\b(who\s*are\s*you|what\s*are\s*you|your\s*name|introduce\s*yourself|tum\s*kaun|aap\s*kaun|tell\s*me\s*about\s*yourself)\b/i] },

      { id:'capabilities',
        patterns:[/\b(what\s*can\s*you\s*do|your\s*(features|capabilities|functions|abilities)|how\s*do\s*you\s*work|what\s*do\s*you\s*support|kya\s*kar\s*sak)\b/i,
                  /\b(help\s*me|show\s*me\s*what|what\s*(tools|features)\s*(do\s*you\s*have|are\s*available))\b/i] },

      { id:'thanks',
        patterns:[/^(thanks?|thank\s*you|thx|ty|thnx|shukriya|dhanyawad|meherbani)\b/i] },

      { id:'bye',
        patterns:[/^(bye|goodbye|see\s*ya|see\s*you|later|ttyl|take\s*care|khuda\s*hafiz|allah\s*hafiz|alvida)\b/i] },

      { id:'weather', requires_web:true,
        patterns:[/\b(weather|temperature|temp|forecast|humid|rain(ing)?|sunny|cloudy|wind(y)?|mausam|mosam|garmi|thand|barish|baarish)\b/i,
                  /\b(will\s*it\s*rain|is\s*it\s*(hot|cold|raining|sunny|snowing)|how\s*(hot|cold)\s*is\s*it)\b/i,
                  /\b(what\s*(is|'s)\s*the\s*(weather|temperature|temp|forecast))\b/i] },

      { id:'news', requires_web:true,
        patterns:[/\b(latest\s*news|breaking\s*news|top\s*news|headlines|taza\s*khabar|khabren|aaj\s*ki\s*news)\b/i,
                  /\b(what\s*(is|'s)\s*happening|current\s*events|today\s*news|recent\s*news)\b/i] },

      { id:'web_search', requires_web:true,
        patterns:[/\b(search\s*for|look\s*up|find\s*out|who\s*is|what\s*is\s*(the\s*)?(latest|current|new)|realtime|right\s*now|live\s*score)\b/i,
                  /\b(who\s*won|what\s*happened|when\s*(is|was|did)|trending|viral)\b/i] },

      { id:'datetime',
        patterns:[/\b(what\s*(time|date)|today('s)?\s*(date|day)|current\s*(time|date)|what\s*day\s*is\s*it|time\s*now)\b/i,
                  /\b(aaj\s*(ki|ka)\s*(tarikh|din|date)|waqt\s*(kya|batao))\b/i] },

      { id:'calculation',
        patterns:[/\b(calculat|compute|what\s*is\s+\d[\d\s\+\-\*\/\.]+|\d+\s*[\+\-\*×÷\/]\s*\d+|hisab|math)\b/i] },

      { id:'grammar', suggested_tool:null,
        patterns:[/\b(fix\s*(my|this|the)\s*(grammar|spelling|text|sentence|writing)|correct\s*(this|my|the)\s*(text|grammar|sentence)|proofread|check\s*(grammar|spelling)|grammar\s*(check|sahi|fix))\b/i,
                  /\b(make\s*(it|this)\s*(better|professional|formal|casual|clearer)|improve\s*(my|this)\s*(writing|text|email))\b/i,
                  /\b(rewrite\s*(this|my)|rephrase\s*(this|my))\b/i] },

      { id:'write_email',
        patterns:[/\b(write\s*(an?\s*)?email|draft\s*(an?\s*)?(email|letter|message)|compose\s*(an?\s*)?(email|letter)|email\s*(likhni|banao|draft))\b/i] },

      { id:'translate', requires_tool:true, suggested_tool:'translate',
        patterns:[/\b(translat(e|ion)|convert\s*to\s*(urdu|arabic|french|spanish|german|chinese|hindi|japanese|korean|russian|turkish|english))\b/i,
                  /\b(in\s+(urdu|arabic|french|spanish|german|hindi|japanese|korean)|urdu\s*(mein|main)|english\s*(mein|main))\b/i] },

      { id:'summarize', requires_tool:true, suggested_tool:'ai-summarize',
        patterns:[/\b(summar(ize|ise|y)|tldr|tl;dr|key\s*point|brief|overview|synopsis|main\s*point|khulasa)\b/i] },

      { id:'compress', requires_tool:true, suggested_tool:'compress',
        patterns:[/\b(compress|shrink|reduce\s*(size|file\s*size)|make\s*(it\s*)?(smaller|tiny)|chota|chhota)\b/i] },

      { id:'merge', requires_tool:true, suggested_tool:'merge',
        patterns:[/\b(merge|combin(e|ing)|join\s*(pdf|files?)|concat(enate)?|joro|jodo|milao|together)\b/i] },

      { id:'split', requires_tool:true, suggested_tool:'split',
        patterns:[/\b(split|separat(e|ing)|extract.*page|divide|cut.*page|alag)\b/i] },

      { id:'rotate', requires_tool:true, suggested_tool:'rotate',
        patterns:[/\b(rotat(e|ing)|turn.*page|flip.*page|upside.*down|orientation)\b/i] },

      { id:'ocr', requires_tool:true, suggested_tool:'ocr',
        patterns:[/\b(ocr|extract.*text|recogni[sz]e.*text|text.*from.*image|read.*scan|scan.*to.*text|nikalo|text\s*nikalo)\b/i] },

      { id:'watermark', requires_tool:true, suggested_tool:'watermark',
        patterns:[/\b(watermark|stamp|overlay.*text|add.*watermark|watermark\s*lagao)\b/i] },

      { id:'protect', requires_tool:true, suggested_tool:'protect',
        patterns:[/\b(protect|password\s*(protect)?|encrypt|lock.*pdf|secure.*pdf|password\s*lagao)\b/i] },

      { id:'unlock', requires_tool:true, suggested_tool:'unlock',
        patterns:[/\b(unlock|remove.*password|decrypt|open.*locked|unprotect)\b/i] },

      { id:'sign', requires_tool:true, suggested_tool:'sign',
        patterns:[/\b(sign\s*(pdf|document|it|this)|signature|esign|e-sign|dastakhat)\b/i] },

      { id:'pdf_to_word', requires_tool:true, suggested_tool:'pdf-to-word',
        patterns:[/\bpdf.*(to|2|into|ko|se).*(word|docx)\b/i, /\bconvert.*pdf.*(word|docx)\b/i,
                  /\b(word|docx)\s*(se|sy|mein|main)\s*convert\b/i, /\b(convert|badal).*to\s*word\b/i] },

      { id:'pdf_to_excel', requires_tool:true, suggested_tool:'pdf-to-excel',
        patterns:[/\bpdf.*(to|2|into).*(excel|xlsx|spreadsheet)\b/i, /\b(extract|get).*table.*excel\b/i] },

      { id:'pdf_to_jpg', requires_tool:true, suggested_tool:'pdf-to-jpg',
        patterns:[/\bpdf.*(to|2|into).*(jpg|jpeg|image|png|picture)\b/i] },

      { id:'word_to_pdf', requires_tool:true, suggested_tool:'word-to-pdf',
        patterns:[/\b(word|docx).*(to|2|into).*pdf\b/i, /\bconvert.*(word|doc).*(pdf)\b/i] },

      { id:'image_to_pdf', requires_tool:true, suggested_tool:'jpg-to-pdf',
        patterns:[/\b(image|photo|picture|jpg|jpeg|png).*(to|2|into).*pdf\b/i] },

      { id:'background_remove', requires_tool:true, suggested_tool:'background-remover',
        patterns:[/\b(remove.*background|background.*remov|bg.*remov|cut.*out|erase.*bg|transparent.*bg|hatao)\b/i] },

      { id:'resize_image', requires_tool:true, suggested_tool:'resize-image',
        patterns:[/\b(resize|scale).*(image|photo|picture)\b/i, /\b(make.*image.*(smaller|bigger|larger))\b/i] },

      { id:'compare', requires_tool:true, suggested_tool:'compare',
        patterns:[/\b(compare|diff(erence)?|versus|\bvs\b|side.*by.*side)\b/i] },

      { id:'coding',
        patterns:[/\b(code|function|debug|error|javascript|python|html|css|sql|bug|program|script|algorithm)\b/i] },

      { id:'general', patterns:[] },
    ];

    function classify(rawText) {
      var normalized = RomanUrduNorm.normalize(rawText);
      var corrected  = TypoCorrector.correct(normalized);
      var text = corrected.toLowerCase().trim();

      var best = {
        intent: 'general', confidence: 0.1,
        requires_web: false, requires_tool: false,
        suggested_tool: null, entities: _extractEntities(rawText, text),
        normalized: corrected, isUrdu: RomanUrduNorm.isRomanUrdu(rawText),
      };

      for (var i = 0; i < _defs.length; i++) {
        var def = _defs[i];
        for (var j = 0; j < def.patterns.length; j++) {
          if (def.patterns[j].test(text)) {
            var conf = Math.min(0.99, 0.72 + def.patterns[j].toString().length / 800);
            if (conf > best.confidence) {
              best = {
                intent:        def.id,
                confidence:    conf,
                requires_web:  def.requires_web  || false,
                requires_tool: def.requires_tool || false,
                suggested_tool: def.suggested_tool || null,
                entities:      _extractEntities(rawText, text),
                normalized:    corrected,
                isUrdu:        RomanUrduNorm.isRomanUrdu(rawText),
              };
            }
            break;
          }
        }
      }
      return best;
    }

    function _extractEntities(rawText, lowerText) {
      var e = {};
      // Location — "weather in Lahore", "Lahore ka mausam"
      var locM = rawText.match(/\b(?:in|at|for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/)
              || rawText.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:weather|mausam|temperature|temp)\b/)
              || (lowerText.match(/\b(lahore|karachi|islamabad|dubai|london|new\s*york|paris|tokyo|berlin|delhi|mumbai|riyadh|abu\s*dhabi|toronto|sydney)\b/) && [null, (lowerText.match(/\b(lahore|karachi|islamabad|dubai|london|new\s*york|paris|tokyo|berlin|delhi|mumbai|riyadh|abu\s*dhabi|toronto|sydney)\b/)||[])[0]]);
      if (locM && locM[1]) e.location = locM[1];
      // Language target
      var langM = lowerText.match(/\b(?:to|in|into)\s+(urdu|arabic|french|spanish|german|chinese|hindi|japanese|korean|russian|turkish|english)\b/);
      if (langM) e.targetLanguage = langM[1];
      // Numbers
      var nums = rawText.match(/\d+(?:\.\d+)?/g);
      if (nums) e.numbers = nums;
      return e;
    }

    return { classify: classify };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 4  BASIC GRAMMAR / TEXT FIXER
  // Rule-based corrections applied when user pastes text to fix.
  // ═══════════════════════════════════════════════════════════════════
  var GrammarFixer = (function () {
    function fix(text) {
      if (!text || text.length < 3) return text;
      return text
        // Capitalize first letter of each sentence
        .replace(/(^|[.!?]\s+)([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); })
        // i → I
        .replace(/\bi\b/g, 'I')
        // Remove double spaces
        .replace(/  +/g, ' ')
        // Ensure space after punctuation
        .replace(/([.!?,;:])([^\s\d"'\)])/g, '$1 $2')
        // Trim
        .trim();
    }

    function buildFixedReply(original, fixed) {
      if (original === fixed || !fixed) return 'The text looks correct already! No changes needed.';
      return '✅ **Here\'s the corrected version:**\n\n> ' + fixed.replace(/\n/g, '\n> ') +
        '\n\n---\n*Grammar, capitalization, and spacing have been corrected.*';
    }

    return { fix: fix, buildFixedReply: buildFixedReply };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 5  WEB RETRIEVAL
  // Weather via wttr.in (CORS-enabled, no auth required).
  // News/search via server proxy /api/web-search.
  // ═══════════════════════════════════════════════════════════════════
  var WebRetrieval = (function () {
    var _cache = new Map();
    var CACHE_TTL = 5 * 60 * 1000; // 5 min

    function _cacheGet(k) {
      var e = _cache.get(k);
      if (e && Date.now() - e.ts < CACHE_TTL) return e.v;
      _cache.delete(k); return null;
    }
    function _cacheSet(k, v) { _cache.set(k, { v: v, ts: Date.now() }); }

    function _timeout(ms) {
      return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); });
    }

    async function fetchWeather(location) {
      var key = 'wx:' + (location || 'London').toLowerCase();
      var c = _cacheGet(key); if (c) return c;
      try {
        var resp = await Promise.race([
          fetch('https://wttr.in/' + encodeURIComponent(location || 'London') + '?format=j1'),
          _timeout(6000),
        ]);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var d = await resp.json();
        var cur = d.current_condition && d.current_condition[0];
        if (!cur) throw new Error('no data');
        var area = d.nearest_area && d.nearest_area[0];
        var city = (area && area.areaName && area.areaName[0] && area.areaName[0].value) || location;
        var country = (area && area.country && area.country[0] && area.country[0].value) || '';
        var result = {
          location: city + (country ? ', ' + country : ''),
          temp_c: cur.temp_C, feels_c: cur.FeelsLikeC,
          humidity: cur.humidity,
          desc: (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '',
          wind: cur.windspeedKmph, uv: cur.uvIndex,
        };
        _cacheSet(key, result);
        return result;
      } catch (e) {
        warn('weather fetch:', e.message);
        return null;
      }
    }

    async function fetchSearch(query, type) {
      var key = 'srch:' + (type || '') + ':' + query.slice(0, 60);
      var c = _cacheGet(key); if (c) return c;
      try {
        var url = '/api/web-search?q=' + encodeURIComponent(query);
        if (type) url += '&type=' + encodeURIComponent(type);
        var resp = await Promise.race([
          fetch(url),
          _timeout(7000),
        ]);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        _cacheSet(key, data);
        return data;
      } catch (e) {
        warn('search fetch:', e.message);
        return null;
      }
    }

    return { fetchWeather: fetchWeather, fetchSearch: fetchSearch };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 6  RESPONSE GENERATOR
  // Natural, non-robotic replies for each intent.
  // ═══════════════════════════════════════════════════════════════════
  var ResponseGen = (function () {
    var _greetings = [
      'Hello! 👋 How can I help you today?',
      'Hi there! What can I do for you?',
      'Hey! Ready to help — ask anything or drop a file to get started.',
      'Hello! I\'m Laba, your AI assistant. What do you need?',
      'Hi! Anything I can help with today?',
    ];
    var _howAreYou = [
      'Main theek hoon 😄 Aap sunao? Koi kaam hai?',
      'All good! 😊 What can I help you with today?',
      'Doing great, thanks for asking! What would you like to work on?',
      'Theek hoon bhai! 😊 Aap kia karna chahte ho?',
      'I\'m doing well! Ready to help with documents, images, or any questions. What\'s on your mind?',
    ];
    var _lastReplies = {};
    function _r(arr) {
      if (arr.length === 1) return arr[0];
      var key = arr[0].slice(0, 20);
      var last = _lastReplies[key];
      var idx;
      do { idx = Math.floor(Math.random() * arr.length); } while (idx === last && arr.length > 1);
      _lastReplies[key] = idx;
      return arr[idx];
    }

    function forIntent(intent, rawText, docCtx) {
      var e = intent.entities || {};

      switch (intent.intent) {
        case 'greeting': {
          if (/\b(aoa|a\.o\.a|assalam|salam\s*alaikum|assalamualaikum|slm)\b/i.test(rawText)) {
            return _r(['Walikum Salam 😊 Kaisy ho?', 'Walikum Assalam! 😄 Kia haal hai?', 'Walikum Salam! Main theek hoon, aap batao?', 'Walikum Salam 😊 Kuch kaam hai?']);
          }
          if (/\b(salam|salaam)\b/i.test(rawText) && intent.isUrdu) {
            return _r(['Salam! 👋 Kaisy ho?', 'Salam bhai! Kia kaam hai aaj?', 'Salam ji! 😊 Kuch madad chahiye?']);
          }
          if (intent.isUrdu) {
            return _r(['Haan ji! 😊 Kaisy ho? Kuch kaam hai?', 'Aoa! Main Laba AI hoon — kuch kaam batao.', 'Hello! 👋 Kia haal hai? Kuch karna hai to batao.', 'Ji! 😊 Kia service chahiye aaj?']);
          }
          return _r(_greetings);
        }

        case 'how_are_you':
          return _r(_howAreYou);

        case 'small_talk':
          return _r([
            'Sab theek! 😄 Aap sunao — koi kaam hai?',
            'Theek chal raha hai! Kia karna chahte ho?',
            'All good here! Kuch kaam ho to batao 👍',
            'Main busy hoon helping people! 😄 Aap batao kya chahiye?',
            'All systems go! 🚀 What would you like to do today?',
          ]);

        case 'frustration':
          return _r([
            'Samajh gaya 👍 Chalo check karte hain kya issue hai. Kya error aa raha hai?',
            'Theek hai, dekhen kya ho raha hai. File upload kar ke batao kya problem hai.',
            'Okay, no problem! Mujhe batao step by step — kya kar rahe ho aur kya ho raha hai?',
            'Got it! Let\'s figure this out together. What\'s happening exactly?',
            'Koi baat nahi! Agar koi error aa raha hai to screenshot share karo ya describe karo 😊',
          ]);

        case 'joke':
          return _r([
            '😄 Ek programmer ka joke:\n\n_Teen log ek bar mein gaye — HTML, CSS, aur JavaScript.\nHTML ne order diya. CSS ne dress code change kar diya. JavaScript ne bar crash kar diya._ 😂',
            '😄 PDF joke:\n\n_Kyun PDF ne Word ko reject kiya?\nKehta tha: "Sorry, I don\'t accept changes." 😂_',
            '😄 Classic one:\n\nWhy do programmers prefer **dark mode**?\n\n**Because light attracts bugs! 🐛**',
            '😄 Roman Urdu mein:\n\n_Ek aadmi ne Google pe search kiya: "Meri biwi kab tak ghar aayegi?"\nGoogle ne kaha: "Map data unavailable." 😂_',
          ]);

        case 'thanks':
          return _r([
            'You\'re welcome! 😊 Let me know if there\'s anything else I can help with.',
            'Koi baat nahi! 😊 Kuch aur kaam ho to batao.',
            'Happy to help! Anything else you need?',
            'Khushi hui! 😄 Aur kuch chahiye to batao.',
          ]);

        case 'bye':
          return _r([
            'Goodbye! Feel free to come back anytime. Take care! 👋',
            'Allah Hafiz! 😊 Kab bhi aao, main hoon yahan.',
            'See you! Take care 👋',
            'Khuda Hafiz! Koi bhi kaam ho to wapas aao 😊',
          ]);

        case 'identity': {
          if (intent.isUrdu || /\b(tum\s*kon|aap\s*kon|tum\s*kaun|aap\s*kaun|kon\s*ho|kaun\s*ho)\b/i.test(rawText)) {
            return 'Main **Laba AI Assistant** hoon 😊\n\nMain yeh kaam kar sakta hoon:\n\n📄 **Files process karna** — compress, convert, merge, split, OCR, sign, watermark (33+ tools)\n🌐 **Web search** — mausam, khabar, realtime facts\n💬 **Chat** — English, Roman Urdu, mixed language\n✍️ **Writing help** — grammar, emails, summaries, translations\n\nFile upload karo ya kuch poocho — main hoon! 😊';
          }
          return 'I\'m **Laba**, an AI assistant built into ILovePDF. Here\'s what I can do:\n\n📄 **Process files** — compress, convert, merge, split, OCR, sign, watermark 33+ tools\n🌐 **Search the web** — weather, news, realtime facts\n💬 **Chat naturally** — English, Roman Urdu, and mixed language\n✍️ **Writing help** — grammar, emails, summaries, translations\n\nJust ask, or drag & drop a file to get started!';
        }

        case 'capabilities':
          return '**Here\'s everything I can help with:**\n\n**📄 PDF Tools**\nCompress · Merge · Split · Rotate · Watermark · Sign · Protect · Unlock · Repair · OCR · AI Summarize · Translate · Compare\n\n**🔄 Convert**\nPDF ↔ Word, Excel, PowerPoint, JPG · Image ↔ PDF · HTML to PDF\n\n**🖼️ Image Tools**\nRemove Background · Crop · Resize · Filters\n\n**🌐 Web Search**\nWeather · News · Realtime facts\n\n**✍️ Writing Help**\nGrammar check · Rewrite · Email drafting · Translation\n\nUpload a file and tell me what you need — or just ask!';

        case 'datetime': {
          var now = new Date();
          var ds = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
          var ts = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
          return 'Today is **' + ds + '** · Current time: **' + ts + '**';
        }

        case 'calculation': {
          var raw = rawText.replace(/[×]/g,'*').replace(/[÷]/g,'/');
          var expr = raw.replace(/[^0-9\+\-\*\/\(\)\.\s]/g,'').trim();
          if (expr && /\d/.test(expr) && /[\+\-\*\/]/.test(expr)) {
            try {
              var res = Function('"use strict"; return (' + expr + ')')();
              if (isFinite(res)) return '**' + expr.trim() + ' = ' + res + '**';
            } catch (_) {}
          }
          return 'I can do basic math! Try something like:\n• "what is 25 × 4"\n• "calculate 1500 / 3"\n• "100 + 250 - 30"';
        }

        case 'grammar': {
          // Extract text to fix from the message
          var toFix = rawText
            .replace(/\b(fix|correct|improve|proofread|check|rewrite|rephrase)\s+(this|my|the|:)?\s*/i, '')
            .replace(/\b(grammar|spelling|text|sentence|writing|email)\b\s*/i, '')
            .replace(/^[:\-\s]+/, '').trim();
          if (toFix.length > 10) {
            var fixed = GrammarFixer.fix(toFix);
            return GrammarFixer.buildFixedReply(toFix, fixed);
          }
          return 'Sure! **Paste the text** you\'d like me to fix and I\'ll correct the grammar, spelling, and flow.';
        }

        case 'write_email': {
          var lc = rawText.toLowerCase();
          if (/resign|resignation/i.test(lc)) {
            return '**Resignation Email Draft:**\n\n---\n**Subject:** Resignation Notice — [Your Name]\n\nDear [Manager\'s Name],\n\nI am writing to formally notify you of my resignation from my position as [Your Role] at [Company Name], effective [Date — typically 2 weeks from today].\n\nI am grateful for the opportunities and experiences I\'ve had during my time here. I will do my best to ensure a smooth transition and complete any outstanding responsibilities before my departure.\n\nThank you for your support and guidance.\n\nSincerely,\n[Your Name]\n\n---\n_Edit the [brackets] with your details._';
          }
          if (/job|application|apply/i.test(lc)) {
            return '**Job Application Email Draft:**\n\n---\n**Subject:** Application for [Position Name] — [Your Name]\n\nDear Hiring Manager,\n\nI am writing to apply for the **[Position]** role at **[Company]**. With my background in [relevant experience], I am confident I can contribute effectively to your team.\n\nI have attached my resume for your review. I would welcome the opportunity to discuss how my skills align with your needs.\n\nThank you for your consideration.\n\nBest regards,\n[Your Name]\n[Contact Information]\n\n---\n_Edit the [brackets] with your details._';
          }
          if (/follow.?up/i.test(lc)) {
            return '**Follow-Up Email Draft:**\n\n---\n**Subject:** Following Up — [Topic]\n\nDear [Name],\n\nI wanted to follow up on my previous message regarding [topic]. I hope you\'ve had a chance to review it.\n\nPlease let me know if you need any additional information or have any questions. I look forward to hearing from you.\n\nBest regards,\n[Your Name]\n\n---\n_Edit the [brackets] with your details._';
          }
          return '**I\'d be happy to draft an email!** Tell me:\n\n1. **Purpose** — what\'s it for? (resignation, job application, complaint, follow-up, thank you, etc.)\n2. **Tone** — formal or friendly?\n3. **Key details** to include\n\nThen I\'ll write a full draft for you.';
        }

        case 'compress':
          return 'To **compress a PDF**, just upload your file here 📎 and I\'ll reduce the size right away.\n\nOr use the [Compress PDF](/compress-pdf) tool directly.';

        case 'merge':
          return 'To **merge PDFs**, upload 2 or more PDF files 📎 and I\'ll combine them into one.\n\nOr use the [Merge PDF](/merge-pdf) tool directly.';

        case 'split':
          return 'To **split a PDF**, upload your file 📎 and tell me which pages you want to extract.\n\nOr use the [Split PDF](/split-pdf) tool directly.';

        case 'rotate':
          return 'To **rotate PDF pages**, upload your file 📎 and specify the rotation (90°, 180°, 270°).\n\nOr use the [Rotate PDF](/rotate-pdf) tool directly.';

        case 'ocr':
          return 'To **extract text** from a scanned PDF or image, upload your file 📎 and say "extract text".\n\nOr use the [OCR PDF](/ocr-pdf) tool directly.';

        case 'watermark':
          return 'To **add a watermark**, upload your PDF 📎 and tell me the watermark text (e.g. "CONFIDENTIAL").\n\nOr use the [Watermark PDF](/watermark-pdf) tool directly.';

        case 'protect':
          return 'To **password-protect a PDF**, upload your file 📎 and say "protect with password".\n\nOr use the [Protect PDF](/protect-pdf) tool directly.';

        case 'unlock':
          return 'To **remove a PDF password**, upload the locked file 📎 and say "unlock".\n\nOr use the [Unlock PDF](/unlock-pdf) tool directly.';

        case 'sign':
          return 'To **sign a PDF**, upload it 📎 — or go to the [Sign PDF](/sign-pdf) tool where you can draw, type, or upload your signature.';

        case 'pdf_to_word':
          return 'To **convert PDF to Word**, upload your PDF 📎 and say "convert to Word".\n\nOr go to [PDF to Word](/pdf-to-word) directly.';

        case 'pdf_to_excel':
          return 'To **convert PDF to Excel**, upload your PDF 📎 and say "convert to Excel".\n\nOr go to [PDF to Excel](/pdf-to-excel) directly.';

        case 'pdf_to_jpg':
          return 'To **convert PDF to images**, upload your PDF 📎 and say "convert to JPG".\n\nOr go to [PDF to JPG](/pdf-to-jpg) directly.';

        case 'word_to_pdf':
          return 'To **convert Word to PDF**, upload your .doc or .docx file 📎.\n\nOr go to [Word to PDF](/word-to-pdf) directly.';

        case 'image_to_pdf':
          return 'To **convert images to PDF**, upload your JPG/PNG files 📎 and say "to PDF".\n\nOr go to [JPG to PDF](/jpg-to-pdf) directly.';

        case 'background_remove':
          return 'To **remove an image background**, upload your image 📎 and say "remove background". I\'ll give you a transparent PNG!\n\nOr go to [Background Remover](/background-remover) directly.';

        case 'resize_image':
          return 'To **resize an image**, upload it 📎 and tell me the target dimensions (e.g. "resize to 800×600").\n\nOr go to [Resize Image](/resize-image) directly.';

        case 'compare':
          return 'To **compare two PDFs**, upload both files 📎 and say "compare".\n\nOr go to [Compare PDFs](/compare-pdf) directly.';

        case 'summarize':
          if (docCtx) {
            return null; // let heuristic handle doc-aware summarize
          }
          return 'To **summarize a document**, upload your PDF 📎 and say "summarize".\n\nOr go to the [AI Summarizer](/ai-summarizer) directly.';

        case 'translate': {
          var lang = (e.targetLanguage) ? e.targetLanguage.charAt(0).toUpperCase() + e.targetLanguage.slice(1) : 'another language';
          return 'To **translate your PDF to ' + lang + '**, upload the file 📎 and say "translate to ' + lang + '".\n\nOr go to [Translate PDF](/translate-pdf) directly.';
        }

        case 'coding':
          return 'I can help with code! Share the snippet or describe the issue and I\'ll assist.\n\n_(Note: for complex code, a full LLM model provider gives better results.)_';

        case 'weather':
        case 'news':
        case 'web_search':
          return null; // handled separately with actual web fetch

        default:
          return null; // fall through to GAE / heuristic
      }
    }

    function buildWeatherReply(data, rawText, isUrdu) {
      if (!data) {
        var locGuess = (rawText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/) || [])[1] || 'the location';
        return 'I couldn\'t fetch the current weather for **' + locGuess + '** — the weather service may be temporarily unavailable. Try [wttr.in](https://wttr.in) directly.';
      }
      var w = data;
      var emoji = /rain/i.test(w.desc) ? '🌧️' : /cloud/i.test(w.desc) ? '☁️' : /sun|clear/i.test(w.desc) ? '☀️' : /snow/i.test(w.desc) ? '❄️' : '🌤️';
      return emoji + ' **Weather in ' + _esc(w.location) + ':**\n\n' +
        '🌡️ **Temperature:** ' + w.temp_c + '°C (feels like ' + w.feels_c + '°C)\n' +
        '💧 **Humidity:** ' + w.humidity + '%\n' +
        '💨 **Wind:** ' + w.wind + ' km/h\n' +
        '🔆 **UV Index:** ' + (w.uv || '—') + '\n' +
        '☁️ **Conditions:** ' + _esc(w.desc || 'N/A') + '\n\n' +
        '_Live data from wttr.in_';
    }

    function buildSearchReply(data, query, type) {
      if (!data) {
        return 'I couldn\'t fetch live results for **"' + _esc(query) + '"** right now. Try [Google](https://www.google.com/search?q=' + encodeURIComponent(query) + ') or [DuckDuckGo](https://duckduckgo.com/?q=' + encodeURIComponent(query) + ').';
      }
      // Abstract answer
      var lines = [];
      if (data.abstract) {
        lines.push('**' + _esc(data.abstract) + '**');
        if (data.source) lines.push('_Source: ' + _esc(data.source) + '_');
        lines.push('');
      }
      if (data.results && data.results.length) {
        if (type === 'news') {
          lines.push('📰 **Latest results for "' + _esc(query) + '":**\n');
        } else {
          lines.push('🔍 **Search results for "' + _esc(query) + '":**\n');
        }
        data.results.slice(0, 4).forEach(function (r, i) {
          lines.push((i + 1) + '. **' + _esc(r.title || '') + '**');
          if (r.snippet) lines.push('   ' + _esc(r.snippet));
          if (r.url) lines.push('   🔗 [Read more](' + r.url + ')');
          lines.push('');
        });
      }
      if (!lines.length) {
        return 'I searched for **"' + _esc(query) + '"** but didn\'t find specific results. Try [Google](https://www.google.com/search?q=' + encodeURIComponent(query) + ') for more.';
      }
      return lines.join('\n').trim();
    }

    return { forIntent: forIntent, buildWeatherReply: buildWeatherReply, buildSearchReply: buildSearchReply };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // § 7  MAIN RESPOND FUNCTION
  // Called by laba-ai-chat.js AiQueryEngine before GAE / heuristic.
  // Returns { intent, answer } or null (caller falls through).
  // ═══════════════════════════════════════════════════════════════════
  // Conversational intents that should ALWAYS return immediately — never fall through to generic fallback
  var _CONV_INTENTS = ['greeting','how_are_you','small_talk','thanks','bye','identity','capabilities',
                       'datetime','calculation','grammar','write_email','joke','frustration'];

  async function respond(rawText, context) {
    context = context || {};

    // ── Step 1: normalize → typo-correct → classify ────────────────────
    var intent = IntentEngine.classify(rawText);
    log('intent:', intent.intent, '| conf:', intent.confidence.toFixed(2),
        '| web:', intent.requires_web, '| urdu:', intent.isUrdu);

    // ── Step 2: Fast-path — confident conversational reply ──────────────
    // If confidence > 0.55 for a known conversational intent, reply immediately.
    // NEVER show tool-help fallback for greetings, small talk, jokes, etc.
    if (_CONV_INTENTS.indexOf(intent.intent) >= 0 && intent.confidence > 0.55) {
      var fastAnswer = ResponseGen.forIntent(intent, rawText, context.docCtx || '');
      if (fastAnswer) return { intent: intent, answer: fastAnswer };
    }

    // ── Step 3: Weather ───────────────────────────────────────────────
    if (intent.intent === 'weather') {
      var loc = (intent.entities && intent.entities.location) || 'London';
      // Try to extract from raw text more aggressively
      var locRaw = rawText.match(/\b(?:in|at|for|of)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b/i);
      if (!loc || loc === 'London') {
        var cityM = rawText.match(/\b(lahore|karachi|islamabad|dubai|london|new york|paris|tokyo|berlin|delhi|mumbai|riyadh|abu dhabi|toronto|sydney|chicago|los angeles|new zealand|hong kong|singapore)\b/i);
        if (cityM) loc = cityM[1];
        else if (locRaw && locRaw[1]) loc = locRaw[1];
      }
      var wxData = await WebRetrieval.fetchWeather(loc);
      return { intent: intent, answer: ResponseGen.buildWeatherReply(wxData, rawText, intent.isUrdu) };
    }

    // ── News ──────────────────────────────────────────────────────────
    if (intent.intent === 'news') {
      var q = intent.normalized || rawText;
      // Simplify query for news
      if (/taza\s*khabar|aaj\s*ki\s*khabar|latest\s*news|today\s*news/i.test(rawText)) q = 'today news headlines';
      var newsData = await WebRetrieval.fetchSearch(q, 'news');
      return { intent: intent, answer: ResponseGen.buildSearchReply(newsData, rawText, 'news') };
    }

    // ── General web search ────────────────────────────────────────────
    if (intent.intent === 'web_search') {
      var srchData = await WebRetrieval.fetchSearch(intent.normalized || rawText);
      return { intent: intent, answer: ResponseGen.buildSearchReply(srchData, rawText, 'search') };
    }

    // ── Intent-based static responses ─────────────────────────────────
    var answer = ResponseGen.forIntent(intent, rawText, context.docCtx || '');
    if (answer) return { intent: intent, answer: answer };

    // ── No confident answer — pass through to GAE / heuristic ─────────
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════
  window.LabaConversationalAI = {
    version:      VERSION,
    respond:      respond,
    classify:     IntentEngine.classify,
    normalizeRU:  RomanUrduNorm.normalize,
    correctTypo:  TypoCorrector.correct,
    isRomanUrdu:  RomanUrduNorm.isRomanUrdu,
    fetchWeather: WebRetrieval.fetchWeather,
    fetchSearch:  WebRetrieval.fetchSearch,
    fixGrammar:   GrammarFixer.fix,
  };

  log('v' + VERSION + ' ready — multilingual intent engine online (EN + Roman Urdu)');
}());
