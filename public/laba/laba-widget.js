/* =========================================================
   LABA AI WIDGET v2
   - Browser-side only (no external API calls)
   - Voice: STT via Web Speech API, TTS via SpeechSynthesis
   - Multi-language: English, Urdu (script), Roman Urdu
   - Universal responses: answers ANY query, never refuses
   - Friendly female personality
   ========================================================= */

(function () {
  'use strict';

  const LABA_KB_URL = '/laba/laba-knowledge.json';
  const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

  /* ============================================================
     GENERAL KNOWLEDGE RESPONSE BANK
     Covers common questions beyond PDF tools
     ============================================================ */
  const GENERAL_KB = [
    // Greetings
    {
      patterns: [/^(hi|hello|hey|salam|assalam|aoa|helo|hii+|heyy+)\b/i, /^(namaste|namaskar)\b/i],
      responses: {
        en: ['Hello! 😊 I\'m Laba, your friendly AI assistant. How can I help you today?', 'Hi there! 👋 I\'m Laba. What can I do for you?'],
        ur: ['السلام علیکم! 😊 میں لابا ہوں، آپ کی AI اسسٹنٹ۔ آپ کی کیا مدد کر سکتی ہوں؟', 'ہیلو! میں لابا ہوں۔ آپ کیسے ہیں؟ 😊'],
        'roman-ur': ['Salam! 😊 Main Laba hoon, aapki AI assistant. Aaj main aapki kaise madad kar sakti hoon?', 'Hello! 👋 Aap kaise hain? Main Laba hoon, batayein kya chahiye?'],
      },
    },
    // How are you
    {
      patterns: [/how are you|kaise ho|kaisi ho|kya haal|aap theek|you okay|you good/i],
      responses: {
        en: ['I\'m doing great, thank you for asking! 😊 I\'m here and ready to help you with anything you need.', 'I\'m wonderful! Always happy to assist. What can I do for you today? 💫'],
        ur: ['میں بالکل ٹھیک ہوں، شکریہ! 😊 آپ بتائیں، میں آپ کی کیا مدد کر سکتی ہوں؟'],
        'roman-ur': ['Main bilkul theek hoon, shukriya! 😊 Aap sunao, kya madad chahiye?', 'Main zabardast hoon! Aapki seva mein hazir hoon. Batayein kya karna hai? 💫'],
      },
    },
    // What is your name
    {
      patterns: [/your name|aap ka naam|tumhara naam|apna naam|who are you|tum kaun|aap kaun/i],
      responses: {
        en: ['My name is **Laba** 🤖 — I\'m an AI assistant built for ILovePDF. I can help with PDF tools, answer questions, write emails, fix grammar, and much more!', 'I\'m **Laba**, your intelligent AI assistant! I\'m here to help with ILovePDF tools and any other questions you have. 😊'],
        ur: ['میرا نام **لابا** ہے 🤖 — میں ILovePDF کی AI اسسٹنٹ ہوں۔ میں PDF ٹولز، ای میل، گرامر اور بہت کچھ میں مدد کر سکتی ہوں!'],
        'roman-ur': ['Mera naam **Laba** hai 🤖 — Main ILovePDF ki AI assistant hoon. Main aapki PDF tools, email, grammar aur bohot kuch mein madad kar sakti hoon!'],
      },
    },
    // What can you do
    {
      patterns: [/what can you do|aap kya kar|tum kya kar|help me with|kya kya kar|your ability|features/i],
      responses: {
        en: ['Here\'s what I can help you with:\n\n📄 **PDF Tools** — Explain any of the 36 tools\n📧 **Email Drafts** — Write professional emails\n✏️ **Grammar Fix** — Correct your sentences\n✨ **Rewrite** — Make text more professional\n💬 **General Chat** — Answer any question\n🌐 **Urdu/Roman Urdu** — I understand multiple languages!\n\nJust ask me anything! 😊'],
        ur: ['میں یہ سب کر سکتی ہوں:\n\n📄 **PDF ٹولز** — تمام 36 ٹولز کی وضاحت\n📧 **ای میل** — پیشہ ورانہ ای میل لکھنا\n✏️ **گرامر** — جملے درست کرنا\n✨ **دوبارہ لکھنا** — متن کو بہتر بنانا\n💬 **عام سوالات** — کوئی بھی سوال پوچھیں!'],
        'roman-ur': ['Main yeh sab kar sakti hoon:\n\n📄 **PDF Tools** — 36 tools ki wazahat\n📧 **Email Draft** — Professional email likhna\n✏️ **Grammar Fix** — Jumlay theek karna\n✨ **Rewrite** — Text ko behtar banana\n💬 **General Chat** — Koi bhi sawal poochein!\n\nBas pooch lo! 😊'],
      },
    },
    // Thank you
    {
      patterns: [/thank you|thanks|shukriya|shukria|jazak|mehrbani|bahut accha|very good|great job|well done/i],
      responses: {
        en: ['You\'re very welcome! 😊 It\'s my pleasure to help. Let me know if you need anything else!', 'Happy to help anytime! 💫 Is there anything else you\'d like to know?'],
        ur: ['خوشی ہوئی! 😊 جب بھی ضرورت ہو پوچھیں۔', 'آپ کا شکریہ! 💫 کوئی اور سوال ہو تو بتائیں۔'],
        'roman-ur': ['Koi baat nahi! 😊 Jab bhi zaroorat ho, main hazir hoon.', 'Khushi hui madad karke! 💫 Kuch aur chahiye to batayein.'],
      },
    },
    // Goodbye
    {
      patterns: [/bye|goodbye|khuda hafiz|allah hafiz|alvida|see you|take care|phir milenge/i],
      responses: {
        en: ['Goodbye! 👋 Take care and come back anytime you need help!', 'Bye! 😊 It was great talking to you. See you next time!'],
        ur: ['خدا حافظ! 👋 جب بھی ضرورت ہو واپس آئیں!'],
        'roman-ur': ['Allah Hafiz! 👋 Jab zaroorat ho, wapas aayein!', 'Khuda Hafiz! 😊 Phir milenge!'],
      },
    },
    // What is ILovePDF
    {
      patterns: [/what is ilovepdf|ilovepdf kya|ilovepdf ke baare|about ilovepdf|tell me about this site/i],
      responses: {
        en: ['**ILovePDF** is a free online platform with **36 powerful tools** for working with PDF and image files! 🎉\n\nYou can:\n• Merge, Split, Compress PDFs\n• Convert PDF ↔ Word/Excel/PowerPoint\n• OCR scanned documents\n• Remove image backgrounds\n• And much more — all free, no signup required!\n\nFiles are processed securely and deleted automatically. 🔒'],
        ur: ['**ILovePDF** ایک مفت آن لائن پلیٹ فارم ہے جس میں **36 طاقتور ٹولز** ہیں PDF اور امیج فائلوں کے لیے! 🎉\n\nسب ٹولز مفت ہیں اور کوئی رجسٹریشن نہیں چاہیے۔'],
        'roman-ur': ['**ILovePDF** ek free online platform hai jis mein **36 tools** hain PDF aur image files ke liye! 🎉\n\nSab kuch free hai, koi signup nahi chahiye. Files automatically delete ho jaati hain. 🔒'],
      },
    },
    // What is AI
    {
      patterns: [/what is ai|artificial intelligence|machine learning|deep learning|ai kya|ai ke baare/i],
      responses: {
        en: ['**Artificial Intelligence (AI)** is technology that allows computers to perform tasks that normally require human intelligence — like understanding language, recognizing images, and making decisions.\n\nI\'m an example of AI! I process your questions and generate helpful responses. 😊\n\nAI types include:\n• **Machine Learning** — computers learn from data\n• **Deep Learning** — neural networks inspired by the brain\n• **NLP** — understanding and generating human language'],
        'roman-ur': ['**Artificial Intelligence (AI)** woh technology hai jo computers ko insaan jaise kaam karne deti hai — jaise language samajhna, images pehchanna, decisions lena.\n\nMain khud AI hoon! 😊\n\nAI ki kismein:\n• **Machine Learning** — data se seekhna\n• **Deep Learning** — brain jaise networks\n• **NLP** — language samajhna'],
      },
    },
    // What is PDF
    {
      patterns: [/what is pdf|pdf kya|pdf ka matlab|pdf meaning|pdf full form/i],
      responses: {
        en: ['**PDF** stands for **Portable Document Format**. 📄\n\nIt was created by Adobe in 1993. A PDF file looks the same on every device — phone, computer, printer — no matter what software you use.\n\nKey advantages:\n✅ Same layout on all devices\n✅ Can contain text, images, links\n✅ Secure with passwords\n✅ Universal format for documents\n\nILovePDF has 36 free tools to work with PDF files! 🎉'],
        ur: ['**PDF** کا مطلب ہے **Portable Document Format**۔ 📄\n\nیہ Adobe نے 1993 میں بنایا تھا۔ PDF فائل ہر ڈیوائس پر ایک جیسی دکھتی ہے۔\n\nILovePDF پر 36 مفت ٹولز ہیں PDF کے لیے! 🎉'],
        'roman-ur': ['**PDF** ka matlab hai **Portable Document Format**. 📄\n\nYeh Adobe ne 1993 mein banaya. PDF file har device par same dikhti hai.\n\nILovePDF par 36 free tools hain PDF ke liye! 🎉'],
      },
    },
    // Jokes
    {
      patterns: [/joke|funny|maza|hasao|laugh|mazak/i],
      responses: {
        en: ['😄 Here\'s one for you:\n\nWhy don\'t scientists trust atoms?\n**Because they make up everything!** 😂\n\nWant another one?', '😄 A PDF walked into a bar...\nThe bartender said "Sorry, we don\'t compress drinks here!" 😂'],
        'roman-ur': ['😄 Yeh lo ek joke:\n\nPDF ne doctor se kaha: "Mujhe compress kar do!"\nDoctor bola: "Theek hai, pehle size batao!" 😂\n\nAur sunna hai?'],
      },
    },
    // Time / Date
    {
      patterns: [/what time|what date|what day|aaj ka din|aaj ki date|time kya|date kya/i],
      responses: {
        en: () => {
          const now = new Date();
          return `🕐 Current time: **${now.toLocaleTimeString()}**\n📅 Today: **${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}**`;
        },
        'roman-ur': () => {
          const now = new Date();
          return `🕐 Abhi ka waqt: **${now.toLocaleTimeString()}**\n📅 Aaj: **${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}**`;
        },
      },
    },
    // Who made you / who created you
    {
      patterns: [/who made you|who created you|who built you|kisne banaya|aapko kisne|tumhe kisne|developer|creator/i],
      responses: {
        en: ['I was built as part of the **ILovePDF** platform — a free PDF tools website. I\'m Laba, your AI assistant, here to make your experience smoother! 😊\n\nI run entirely in your browser — no data is sent to any server for my AI responses.'],
        'roman-ur': ['Mujhe **ILovePDF** platform ke liye banaya gaya hai — ek free PDF tools website. Main Laba hoon, aapki AI assistant! 😊\n\nMain completely aapke browser mein chalti hoon — koi data server par nahi jaata.'],
      },
    },
    // Math
    {
      patterns: [/(\d+)\s*[\+\-\*\/x×÷]\s*(\d+)|calculate|math|calculate|compute|kitna hai|result kya/i],
      responses: {
        en: (msg) => {
          try {
            const expr = msg.replace(/[^0-9+\-*/().]/g, '').trim();
            if (expr && /^[\d+\-*/().]+$/.test(expr)) {
              // eslint-disable-next-line no-eval
              const result = Function('"use strict"; return (' + expr + ')')();
              if (typeof result === 'number' && isFinite(result)) {
                return `🔢 **${expr} = ${result}**\n\nWant me to calculate something else? 😊`;
              }
            }
          } catch (_) {}
          return '🔢 I can do basic math! Try something like "12 * 8" or "100 / 4". What would you like to calculate?';
        },
        'roman-ur': (msg) => {
          try {
            const expr = msg.replace(/[^0-9+\-*/().]/g, '').trim();
            if (expr && /^[\d+\-*/().]+$/.test(expr)) {
              const result = Function('"use strict"; return (' + expr + ')')();
              if (typeof result === 'number' && isFinite(result)) {
                return `🔢 **${expr} = ${result}**\n\nAur kuch calculate karein? 😊`;
              }
            }
          } catch (_) {}
          return '🔢 Main basic math kar sakti hoon! Jaise "12 * 8" ya "100 / 4" likhein.';
        },
      },
    },
    // Motivation / encouragement
    {
      patterns: [/motivat|inspire|sad|udaas|upset|depressed|feel bad|dil nahi|help me feel|encourage|boost/i],
      responses: {
        en: ['Here\'s some motivation for you 💪\n\n*"Every expert was once a beginner. Every pro was once an amateur."*\n\nYou are doing amazing — keep going! The fact that you\'re here, learning and asking questions, shows you\'re on the right path. You\'ve got this! 🌟'],
        ur: ['آپ کے لیے کچھ حوصلہ افزائی 💪\n\n*"ہر ماہر کبھی ابتدائی تھا۔"*\n\nآپ بہت اچھا کر رہے ہیں! آگے بڑھتے رہیں! 🌟'],
        'roman-ur': ['Aapke liye kuch motivation 💪\n\n*"Har mahir pehle ek beginner tha."*\n\nAap zabardast kar rahe hain! Himmat rakhein aur aage badhte rahein! 🌟 Aap ye kar sakte hain!'],
      },
    },
    // Weather (can't check live but give guidance)
    {
      patterns: [/weather|mausam|temperature|garmi|sardi|rain|barish|cloud/i],
      responses: {
        en: ['🌤️ I\'m running in your browser so I can\'t check live weather! For accurate weather, try:\n\n• **Google** — just search "weather [your city]"\n• **weather.com**\n• **AccuWeather**\n\nStay safe in whatever weather you\'re in! 😊'],
        'roman-ur': ['🌤️ Main browser mein chalti hoon, isliye live weather nahi dekh sakti! Weather ke liye:\n\n• **Google** mein likhein "weather [aapka shehar]"\n• **weather.com**\n\nApna khayal rakhein! 😊'],
      },
    },
  ];

  /* ============================================================
     UNIVERSAL FALLBACK RESPONSES (for anything else)
     ============================================================ */
  const FALLBACK_RESPONSES = {
    en: [
      (msg) => `That\'s an interesting question! 🤔 While I specialize in ILovePDF tools and text tasks, I\'ll do my best:\n\n**"${msg.substring(0,60)}${msg.length>60?'…':''}"**\n\nFor detailed research on this topic, I'd suggest Google or Wikipedia. Meanwhile, is there anything about our PDF tools I can help with? 😊`,
      () => `Great question! I\'m Laba, focused on ILovePDF tools and everyday tasks. For this specific topic, a quick Google search would give you the most accurate answer. Can I help you with any PDF task or text work? 📄`,
      () => `I appreciate you asking! 😊 While this goes beyond my core expertise, I always try to help. Could you tell me more specifically what you need? I might be able to assist or point you in the right direction!`,
    ],
    ur: [
      () => `اچھا سوال ہے! 🤔 میں ILovePDF ٹولز اور متن کے کاموں میں ماہر ہوں۔ اس موضوع کے لیے Google یا Wikipedia بہتر ہوگا۔ کیا میں آپ کی PDF کام میں مدد کر سکتی ہوں؟`,
    ],
    'roman-ur': [
      (msg) => `Acha sawal hai! 🤔 Main ILovePDF tools aur text tasks mein mahir hoon. Iske liye Google ya Wikipedia behtar hoga. Kya koi PDF kaam hai jo main kar sakti hoon? 📄`,
    ],
  };

  /* ============================================================
     LABA LOGGER — Centralised error logging for debugging
     All errors written to window.__labaErrors (array, capped 50)
     ============================================================ */
  const LabaLogger = {
    _store: [],
    log(context, error, extra = {}) {
      const entry = {
        ts: new Date().toISOString(),
        context,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack || '') : '',
        ...extra,
      };
      this._store.push(entry);
      if (this._store.length > 50) this._store.shift();
      window.__labaErrors = this._store;
      console.warn(`[Laba:${context}]`, entry.error, extra);
    },
    getAll() { return [...this._store]; },
  };

  /* ============================================================
     SMART SUGGESTIONS MAP
     Returns 2–3 contextual follow-up chips based on response type
     ============================================================ */
  const SUGGESTIONS = {
    greeting: {
      en: ['What can you do?', 'Tell me about PDF tools', 'Fix my grammar'],
      ur: ['آپ کیا کر سکتی ہیں؟', 'PDF ٹولز کے بارے میں بتائیں', 'میری گرامر درست کریں'],
      'roman-ur': ['Aap kya kar sakti hain?', 'PDF tools ke baare mein batayein', 'Meri grammar theek karo'],
    },
    tool: {
      en: ['Show me all PDF tools', 'How do I convert PDF to Word?', 'Compress a PDF'],
      ur: ['تمام PDF ٹولز دکھائیں', 'PDF کو Word میں کیسے بدلیں؟', 'PDF کمپریس کریں'],
      'roman-ur': ['Sab PDF tools dikhao', 'PDF ko Word mein kaise badlein?', 'PDF compress karo'],
    },
    faq: {
      en: ['What other tools do you have?', 'Is this service free?', 'How secure are my files?'],
      ur: ['اور کیا ٹولز ہیں؟', 'کیا یہ مفت ہے؟', 'میری فائلیں محفوظ ہیں؟'],
      'roman-ur': ['Aur kya tools hain?', 'Kya yeh free hai?', 'Meri files safe hain?'],
    },
    grammar: {
      en: ['Fix another sentence', 'Write me an email', 'Rewrite professionally'],
      ur: ['ایک اور جملہ درست کریں', 'ای میل لکھیں', 'پیشہ ورانہ انداز میں لکھیں'],
      'roman-ur': ['Ek aur jumla theek karo', 'Email likho', 'Professional andaz mein likho'],
    },
    email: {
      en: ['Fix my grammar', 'Rewrite this text', 'Write a follow-up email'],
      ur: ['میری گرامر درست کریں', 'یہ متن دوبارہ لکھیں', 'فالو اپ ای میل لکھیں'],
      'roman-ur': ['Meri grammar theek karo', 'Yeh text dobara likho', 'Follow-up email likho'],
    },
    rewrite: {
      en: ['Fix my grammar', 'Write me an email', 'Summarize this text'],
      ur: ['میری گرامر درست کریں', 'ای میل لکھیں', 'خلاصہ بنائیں'],
      'roman-ur': ['Meri grammar theek karo', 'Email likho', 'Summary banao'],
    },
    summarize: {
      en: ['Rewrite professionally', 'Fix my grammar', 'Tell me about PDF tools'],
      ur: ['پیشہ ورانہ انداز میں لکھیں', 'گرامر درست کریں', 'PDF ٹولز کے بارے میں بتائیں'],
      'roman-ur': ['Professional andaz mein likho', 'Grammar theek karo', 'PDF tools ke baare mein batao'],
    },
    fallback: {
      en: ['Tell me about PDF tools', 'Help me write an email', 'Fix my grammar'],
      ur: ['PDF ٹولز کے بارے میں بتائیں', 'ای میل لکھنے میں مدد کریں', 'گرامر درست کریں'],
      'roman-ur': ['PDF tools ke baare mein batao', 'Email likhne mein madad karo', 'Grammar theek karo'],
    },
    general: {
      en: ['Tell me more', 'Help with a PDF tool', 'Write an email for me'],
      ur: ['مزید بتائیں', 'PDF ٹول میں مدد', 'میرے لیے ای میل لکھیں'],
      'roman-ur': ['Mazeed batao', 'PDF tool mein madad', 'Mere liye email likho'],
    },
  };

  /* ============================================================
     LABA WIDGET CLASS
     ============================================================ */
  class LabaWidget {
    constructor() {
      this.kb = null;
      this.pipeline = null;
      this.modelLoading = false;
      this.modelLoaded = false;
      this.isOpen = false;
      this.isMinimized = false;
      this.dragState = { active: false, startX: 0, startY: 0, origX: 0, origY: 0 };
      this.busy = false;

      // Voice state
      this.voiceEnabled = false;
      this.isListening = false;
      this.recognition = null;
      this.synthesis = window.speechSynthesis || null;
      this.hasMic = false;
      this.detectedLang = 'en';

      // Session memory — stores last 20 turns, detected topics, start time
      this.session = {
        history: [],      // [{role:'user'|'bot', content:string, ts:number}]
        context: {},      // {lastTopic, toolsSeen:[]}
        startTime: Date.now(),
      };

      this._buildDOM();
      this._bindEvents();
      this._initVoice();
      this.loadKnowledgeBase();
    }

    /* ---- DOM Construction ---- */

    _buildDOM() {
      const launcher = document.createElement('div');
      launcher.id = 'laba-launcher';
      launcher.setAttribute('role', 'button');
      launcher.setAttribute('aria-label', 'Open Laba AI Assistant');
      launcher.setAttribute('tabindex', '0');
      launcher.innerHTML = `
        <div class="laba-ripple"></div>
        <div class="laba-ring-inner"></div>
        <div class="laba-ring-outer"></div>
        <div class="laba-orbit-container">
          <div class="laba-dot"></div><div class="laba-dot"></div>
          <div class="laba-dot"></div><div class="laba-dot"></div>
          <div class="laba-dot"></div><div class="laba-dot"></div>
          <div class="laba-dot"></div><div class="laba-dot"></div>
        </div>
        <span class="laba-icon" aria-hidden="true">🤖</span>
      `;

      const win = document.createElement('div');
      win.id = 'laba-window';
      win.className = 'laba-hidden';
      win.setAttribute('role', 'dialog');
      win.setAttribute('aria-label', 'Laba AI Assistant');
      win.innerHTML = `
        <div id="laba-header">
          <span id="laba-header-title">Laba 🤖 AI Assistant</span>
          <div id="laba-header-btns">
            <button class="laba-hbtn" id="laba-speaker-btn" title="Toggle voice reply" aria-label="Toggle voice">🔇</button>
            <button class="laba-hbtn" id="laba-minimize-btn" title="Minimize" aria-label="Minimize">−</button>
            <button class="laba-hbtn" id="laba-close-btn" title="Close" aria-label="Close">✕</button>
          </div>
        </div>
        <div id="laba-messages" aria-live="polite">
          <div class="laba-msg laba-bot">
            👋 Hi! I\'m <strong>Laba</strong>, your AI assistant!<br><br>
            I can help with:<br>
            • PDF tool questions 📄<br>
            • Email drafts 📧<br>
            • Grammar correction ✏️<br>
            • General questions 💬<br>
            • Urdu &amp; Roman Urdu 🌐<br><br>
            Ask me <em>anything</em>! 😊
          </div>
        </div>
        <div id="laba-typing" class="laba-hidden">
          <div class="laba-typing-dot"></div>
          <div class="laba-typing-dot"></div>
          <div class="laba-typing-dot"></div>
        </div>
        <div id="laba-model-bar" class="laba-hidden">
          <span id="laba-model-label">Loading AI model…</span>
          <div id="laba-model-progress"><div id="laba-model-fill"></div></div>
        </div>
        <div id="laba-input-area">
          <textarea
            id="laba-input"
            placeholder="Ask anything — PDF tools, grammar, email…"
            rows="1"
            aria-label="Type your message"
          ></textarea>
          <button id="laba-mic-btn" title="Speak your message" aria-label="Speak message">🎙️</button>
          <button id="laba-send" aria-label="Send message">➤</button>
        </div>
      `;

      document.body.appendChild(launcher);
      document.body.appendChild(win);

      this.launcher = launcher;
      this.win = win;
      this.msgArea = win.querySelector('#laba-messages');
      this.typingEl = win.querySelector('#laba-typing');
      this.inputEl = win.querySelector('#laba-input');
      this.sendBtn = win.querySelector('#laba-send');
      this.micBtn = win.querySelector('#laba-mic-btn');
      this.speakerBtn = win.querySelector('#laba-speaker-btn');
      this.modelBar = win.querySelector('#laba-model-bar');
      this.modelLabel = win.querySelector('#laba-model-label');
      this.modelFill = win.querySelector('#laba-model-fill');
    }

    /* ---- Event Binding ---- */

    _bindEvents() {
      this.launcher.addEventListener('click', () => this.toggleChat());
      this.launcher.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleChat(); }
      });

      this.win.querySelector('#laba-close-btn').addEventListener('click', () => this.closeChat());
      this.win.querySelector('#laba-minimize-btn').addEventListener('click', () => this.minimizeChat());

      this.sendBtn.addEventListener('click', () => this._sendMessage());
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
      });
      this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 90) + 'px';
      });

      this.micBtn.addEventListener('click', () => this._toggleListening());
      this.speakerBtn.addEventListener('click', () => this._toggleVoice());

      // Drag — mouse
      const header = this.win.querySelector('#laba-header');
      header.addEventListener('mousedown', (e) => this._startDrag(e));
      document.addEventListener('mousemove', (e) => this._onDrag(e));
      document.addEventListener('mouseup', () => this._endDrag());

      // Drag — touch
      header.addEventListener('touchstart', (e) => this._startDrag(e.touches[0]), { passive: true });
      document.addEventListener('touchmove', (e) => this._onDrag(e.touches[0]), { passive: false });
      document.addEventListener('touchend', () => this._endDrag());
    }

    /* ---- Drag Logic ---- */

    _startDrag(e) {
      const rect = this.win.getBoundingClientRect();
      this.dragState = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        origX: rect.right,
        origY: rect.top,
      };
      this.win.style.transition = 'none';
    }

    _onDrag(e) {
      if (!this.dragState.active) return;
      const dx = e.clientX - this.dragState.startX;
      const dy = e.clientY - this.dragState.startY;
      const newRight = window.innerWidth - (this.dragState.origX + dx);
      const newTop = this.dragState.origY + dy;
      const w = this.win.offsetWidth;
      const h = this.win.offsetHeight;
      this.win.style.right = Math.max(0, Math.min(newRight, window.innerWidth - w)) + 'px';
      this.win.style.top = Math.max(0, Math.min(newTop, window.innerHeight - h)) + 'px';
      this.win.style.bottom = 'auto';
    }

    _endDrag() {
      this.dragState.active = false;
      this.win.style.transition = '';
    }

    /* ---- Voice: Speech-to-Text ---- */

    _initVoice() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        this.micBtn.classList.add('laba-no-mic');
        this.micBtn.title = 'Voice input not supported in this browser';
        return;
      }

      this.hasMic = true;
      this.recognition = new SR();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        this.inputEl.value = transcript;
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 90) + 'px';
        this._stopListeningUI();
        this._sendMessage();
      };

      this.recognition.onerror = (e) => {
        LabaLogger.log('speech-recognition', new Error(e.error), { type: e.error });
        this._stopListeningUI();
        if (e.error === 'not-allowed') {
          this.addMessage('bot', '🎙️ Microphone access was denied. Please allow microphone permission in your browser settings.');
        }
      };

      this.recognition.onend = () => {
        this._stopListeningUI();
      };
    }

    _toggleListening() {
      if (!this.hasMic) {
        this.addMessage('bot', '🎙️ Voice input is not supported in your browser. Try Chrome or Edge for the best experience!');
        return;
      }
      if (this.isListening) {
        try { this.recognition.stop(); } catch (_) {}
        this._stopListeningUI();
      } else {
        this._startListening();
      }
    }

    _startListening() {
      try {
        // Set language based on detected lang
        this.recognition.lang = this.detectedLang === 'ur' ? 'ur-PK' : 'en-US';
        this.recognition.start();
        this.isListening = true;
        this.micBtn.classList.add('laba-listening');
        this.micBtn.title = 'Listening… click to stop';
        this.inputEl.placeholder = '🎙️ Listening…';
      } catch (err) {
        LabaLogger.log('speech-start', err);
      }
    }

    _stopListeningUI() {
      this.isListening = false;
      this.micBtn.classList.remove('laba-listening');
      this.micBtn.title = 'Speak your message';
      this.inputEl.placeholder = 'Ask anything — PDF tools, grammar, email…';
    }

    /* ---- Voice: Text-to-Speech ---- */

    _toggleVoice() {
      this.voiceEnabled = !this.voiceEnabled;
      if (this.voiceEnabled) {
        this.speakerBtn.textContent = '🔊';
        this.speakerBtn.classList.add('laba-voice-on');
        this.speakerBtn.title = 'Voice replies ON — click to mute';
      } else {
        this.speakerBtn.textContent = '🔇';
        this.speakerBtn.classList.remove('laba-voice-on');
        this.speakerBtn.title = 'Voice replies OFF — click to enable';
        if (this.synthesis) this.synthesis.cancel();
      }
    }

    speak(text) {
      if (!this.voiceEnabled || !this.synthesis) return;
      this.synthesis.cancel();
      // Strip HTML tags for speech
      const clean = text.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim();
      const utt = new SpeechSynthesisUtterance(clean);
      utt.rate = 0.95;
      utt.pitch = 1.1;
      utt.volume = 1;
      // Choose voice language
      if (this.detectedLang === 'ur') {
        utt.lang = 'ur-PK';
      } else {
        utt.lang = 'en-US';
        // Prefer a female voice if available
        const voices = this.synthesis.getVoices();
        const female = voices.find(v => v.lang.startsWith('en') && /female|zira|hazel|karen|victoria|samantha/i.test(v.name));
        if (female) utt.voice = female;
      }
      this.synthesis.speak(utt);
    }

    /* ---- Open / Close / Minimize ---- */

    toggleChat() {
      if (this.isOpen) {
        if (this.isMinimized) { this.openChat(); }
        else { this.closeChat(); }
      } else {
        this.openChat();
      }
    }

    openChat() {
      this.win.classList.remove('laba-hidden');
      this.isOpen = true;
      this.isMinimized = false;
      this._vibrate(60);
      // Show welcome suggestions on first open only
      if (!this._welcomeSuggestionsShown) {
        this._welcomeSuggestionsShown = true;
        const lang = this.detectedLang || 'en';
        this._showSuggestions(this._getSuggestions('greeting', lang));
      }
      setTimeout(() => this.inputEl.focus(), 100);
      this._scrollToBottom();
    }

    closeChat() {
      this.win.classList.add('laba-hidden');
      this.isOpen = false;
      this.isMinimized = false;
      if (this.synthesis) this.synthesis.cancel();
    }

    minimizeChat() {
      this.win.classList.add('laba-hidden');
      this.isMinimized = true;
      if (this.synthesis) this.synthesis.cancel();
    }

    /* ---- Vibration ---- */

    _vibrate(ms) {
      try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
    }

    /* ---- Language Detection ---- */

    detectLanguage(msg) {
      // Urdu script (Arabic characters)
      if (/[\u0600-\u06FF\u0750-\u077F]/.test(msg)) return 'ur';
      // Roman Urdu keyword detection
      const romanUrduWords = [
        'kya', 'hai', 'hain', 'mujhe', 'karo', 'kaise', 'nahi', 'aur', 'bhi', 'toh',
        'yeh', 'woh', 'mein', 'aap', 'ap', 'theek', 'kuch', 'sab', 'koi', 'likho',
        'batao', 'shukriya', 'shukria', 'mehrbani', 'achi', 'accha', 'bahut', 'bohat',
        'phir', 'abhi', 'zaroor', 'zaroorat', 'madad', 'chahiye', 'karna', 'karo',
        'banao', 'likhna', 'samjhao', 'bata', 'sunao', 'haan', 'jee', 'nahi', 'na',
        'kal', 'aaj', 'kal', 'waqt', 'samay', 'shehar', 'mulk', 'log', 'banda',
        'mushkil', 'asaan', 'mushkil', 'khush', 'udaas', 'dost', 'yaar',
      ];
      const lower = msg.toLowerCase();
      const hits = romanUrduWords.filter(w => {
        const re = new RegExp('\\b' + w + '\\b', 'i');
        return re.test(lower);
      });
      if (hits.length >= 1) return 'roman-ur';
      return 'en';
    }

    /* ---- Knowledge Base ---- */

    async loadKnowledgeBase() {
      try {
        const res = await fetch(LABA_KB_URL);
        if (!res.ok) throw new Error(`KB fetch failed: HTTP ${res.status}`);
        this.kb = await res.json();
      } catch (e) {
        LabaLogger.log('kb-load', e);
        this.kb = { tools: [], faq: [] };
      }
    }

    searchKnowledgeBase(query) {
      if (!this.kb) return null;
      const q = query.toLowerCase().trim();

      for (const faq of this.kb.faq || []) {
        if (faq.keywords.some(kw => q.includes(kw))) {
          return { type: 'faq', data: faq };
        }
      }

      let bestScore = 0;
      let bestTool = null;
      for (const tool of this.kb.tools || []) {
        let score = 0;
        for (const kw of tool.keywords) {
          if (q.includes(kw)) score += kw.length;
        }
        if (score > bestScore) { bestScore = score; bestTool = tool; }
      }

      if (bestTool && bestScore >= 3) {
        return { type: 'tool', data: bestTool };
      }
      return null;
    }

    _formatToolResponse(tool) {
      return (
        `📄 <strong>${tool.name}</strong>\n\n` +
        `${tool.description}\n\n` +
        `📋 <strong>How to use:</strong>\n${tool.how_to_use}\n\n` +
        `📦 <strong>File limit:</strong> ${tool.file_limit}\n` +
        `💰 <strong>Cost:</strong> Free ✅\n\n` +
        `<a class="laba-tool-link" href="/${tool.slug}" target="_blank">Open ${tool.name} →</a>`
      );
    }

    _formatFaqResponse(faq) {
      return `💬 ${faq.answer}`;
    }

    /* ---- General Knowledge Search ---- */

    searchGeneralKB(query, lang) {
      for (const entry of GENERAL_KB) {
        const matched = entry.patterns.some(p => p.test(query));
        if (!matched) continue;

        const respPool = entry.responses[lang] || entry.responses['en'] || entry.responses['roman-ur'];
        if (!respPool) continue;

        if (typeof respPool === 'function') {
          return respPool(query);
        }
        if (Array.isArray(respPool)) {
          const item = respPool[Math.floor(Math.random() * respPool.length)];
          return typeof item === 'function' ? item(query) : item;
        }
        return respPool;
      }
      return null;
    }

    /* ---- Transformers.js Model ---- */

    async _ensureModelLoaded() {
      if (this.modelLoaded) return true;
      if (this.modelLoading) {
        return new Promise((resolve) => {
          const check = setInterval(() => {
            if (this.modelLoaded || !this.modelLoading) { clearInterval(check); resolve(this.modelLoaded); }
          }, 300);
        });
      }

      this.modelLoading = true;
      this._showModelBar('Downloading AI model (~24MB, one-time only)…', 5);

      try {
        if (!window.__transformers_loaded) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = TRANSFORMERS_CDN;
            s.onload = () => { window.__transformers_loaded = true; resolve(); };
            s.onerror = () => reject(new Error('Failed to load Transformers.js'));
            document.head.appendChild(s);
          });
        }

        this._showModelBar('Initializing model…', 30);

        const { pipeline, env } = window.Transformers || window.transformers || {};
        if (!pipeline) throw new Error('Transformers.js not available');

        env.allowRemoteModels = true;
        env.useBrowserCache = true;

        this._showModelBar('Loading t5-small…', 55);

        this.pipeline = await pipeline('text2text-generation', 'Xenova/t5-small', {
          progress_callback: (info) => {
            if (info && info.progress) {
              this._showModelBar(`Loading model… ${Math.round(info.progress)}%`, Math.min(95, 55 + (info.progress * 0.4)));
            }
          },
        });

        this._showModelBar('Model ready!', 100);
        this.modelLoaded = true;
        this.modelLoading = false;
        setTimeout(() => this._hideModelBar(), 1200);
        return true;
      } catch (err) {
        LabaLogger.log('model-load', err);
        this.modelLoading = false;
        this._hideModelBar();
        return false;
      }
    }

    _showModelBar(label, pct) {
      this.modelBar.classList.remove('laba-hidden');
      this.modelLabel.textContent = label;
      this.modelFill.style.width = pct + '%';
    }

    _hideModelBar() { this.modelBar.classList.add('laba-hidden'); }

    async processWithModel(task, text) {
      const loaded = await this._ensureModelLoaded();
      if (!loaded || !this.pipeline) return null;

      const prompts = {
        grammar: `Fix grammar: ${text}`,
        email:   `Write a professional email about: ${text}`,
        rewrite: `Rewrite professionally: ${text}`,
        summarize: `Summarize: ${text}`,
      };

      try {
        const result = await this.pipeline(prompts[task] || text, { max_new_tokens: 200, do_sample: false });
        return result?.[0]?.generated_text?.trim() || null;
      } catch (err) {
        LabaLogger.log('model-inference', err, { task });
        return null;
      }
    }

    /* ---- Intent Detection ---- */

    _detectIntent(msg) {
      const m = msg.toLowerCase();
      if (m.match(/\bgrammar\b|\bfix sentence\b|\bcorrect.*sentence\b|\btheek karo\b|\bsahi karo\b|\bgrammatically\b/)) return 'grammar';
      if (m.match(/\bemail\b|\bwrite.*email\b|\bdraft.*email\b|\bemail likho\b/)) return 'email';
      if (m.match(/\brewrite\b|\brephrase\b|\bprofessional banao\b|\bmake.*professional\b/)) return 'rewrite';
      if (m.match(/\bsummariz(e|ise)\b|\bsummary\b|\btldr\b/) && msg.length > 60) return 'summarize';
      return null;
    }

    _extractContent(msg, intent) {
      const removals = {
        grammar:   [/fix grammar[:\-]?\s*/gi, /correct[:\-]?\s*/gi, /theek karo[:\-]?\s*/gi, /sahi karo[:\-]?\s*/gi, /fix.*?:/gi],
        email:     [/write (?:an? )?email(?: about)?[:\-]?\s*/gi, /draft (?:an? )?email[:\-]?\s*/gi, /email likho[:\-]?\s*/gi],
        rewrite:   [/rewrite[:\-]?\s*/gi, /rephrase[:\-]?\s*/gi, /make professional[:\-]?\s*/gi, /professional banao[:\-]?\s*/gi],
        summarize: [/summarize[:\-]?\s*/gi, /summarise[:\-]?\s*/gi, /summary[:\-]?\s*/gi, /tldr[:\-]?\s*/gi],
      };
      let text = msg;
      for (const p of (removals[intent] || [])) text = text.replace(p, '');
      return text.trim() || msg;
    }

    /* ---- Main Message Handler ---- */

    async handleUserMessage(msg) {
      const trimmed = msg.trim();
      if (!trimmed) return;

      // Detect language
      this.detectedLang = this.detectLanguage(trimmed);

      // Record user message in session memory
      this._sessionRecord('user', trimmed);

      // Remove existing suggestion chips before new query
      this.msgArea.querySelectorAll('.laba-suggestions').forEach(el => el.remove());

      this.addMessage('user', trimmed);
      this._setInputBusy(true);
      this.showTyping();

      await this._delay(350);

      // 1. Knowledge base (PDF tools)
      const kbResult = this.searchKnowledgeBase(trimmed);
      if (kbResult) {
        this.hideTyping();
        const answer = kbResult.type === 'tool'
          ? this._formatToolResponse(kbResult.data)
          : this._formatFaqResponse(kbResult.data);
        this.addMessage('bot', answer, true);
        this.speak(answer);
        this._vibrate(40);
        this._sessionRecord('bot', answer);
        this.session.context.lastTopic = kbResult.type;
        this._showSuggestions(this._getSuggestions(kbResult.type, this.detectedLang));
        this._setInputBusy(false);
        return;
      }

      // 2. General knowledge bank
      const genAnswer = this.searchGeneralKB(trimmed, this.detectedLang);
      if (genAnswer) {
        this.hideTyping();
        this.addMessage('bot', genAnswer);
        this.speak(genAnswer);
        this._vibrate(40);
        this._sessionRecord('bot', genAnswer);
        // Detect if this was a greeting
        const isGreeting = /^(hi|hello|hey|salam|assalam|aoa|namaste)/i.test(trimmed);
        this.session.context.lastTopic = isGreeting ? 'greeting' : 'general';
        this._showSuggestions(this._getSuggestions(this.session.context.lastTopic, this.detectedLang));
        this._setInputBusy(false);
        return;
      }

      // 3. Model-based tasks (grammar, email, rewrite, summarize)
      const intent = this._detectIntent(trimmed);
      if (intent) {
        const content = this._extractContent(trimmed, intent);
        this.hideTyping();
        this._showModelBar('Loading AI model for this task…', 10);
        let result = null;
        try {
          result = await this.processWithModel(intent, content);
        } catch (err) {
          LabaLogger.log('model-inference', err, { intent, contentLength: content.length });
        }
        this._hideModelBar();

        if (result) {
          const prefixes = {
            grammar:  '✏️ <strong>Corrected:</strong>\n',
            email:    '📧 <strong>Email Draft:</strong>\n',
            rewrite:  '✨ <strong>Rewritten:</strong>\n',
            summarize:'📝 <strong>Summary:</strong>\n',
          };
          const reply = (prefixes[intent] || '') + result;
          this.addMessage('bot', reply, true);
          this.speak(result);
          this._vibrate(40);
          this._sessionRecord('bot', reply);
          this.session.context.lastTopic = intent;
          this._showSuggestions(this._getSuggestions(intent, this.detectedLang));
        } else {
          const errMsg = this.detectedLang === 'roman-ur'
            ? '⚠️ AI model abhi load nahi ho raha. Internet connection check karein aur dobara try karein.'
            : '⚠️ The AI model couldn\'t load right now. Please check your connection and try again.';
          this.addMessage('bot', errMsg);
          this._sessionRecord('bot', errMsg);
          this._showSuggestions(this._getSuggestions('fallback', this.detectedLang));
        }
        this._setInputBusy(false);
        return;
      }

      // 4. Universal fallback — always gives a helpful response
      this.hideTyping();
      const fallbackPool = FALLBACK_RESPONSES[this.detectedLang] || FALLBACK_RESPONSES['en'];
      const fallback = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
      const fallbackText = typeof fallback === 'function' ? fallback(trimmed) : fallback;
      this.addMessage('bot', fallbackText);
      this.speak(fallbackText);
      this._vibrate(40);
      this._sessionRecord('bot', fallbackText);
      this.session.context.lastTopic = 'fallback';
      this._showSuggestions(this._getSuggestions('fallback', this.detectedLang));
      this._setInputBusy(false);
    }

    /* ---- Session Memory ---- */

    _sessionRecord(role, content) {
      this.session.history.push({ role, content: content.substring(0, 500), ts: Date.now() });
      // Keep only last 20 entries to avoid memory bloat
      if (this.session.history.length > 20) this.session.history.shift();
    }

    /* ---- Smart Suggestions ---- */

    /**
     * Return 2–3 contextual follow-up suggestion chips.
     * @param {string} topic - key into SUGGESTIONS map
     * @param {string} lang  - 'en' | 'ur' | 'roman-ur'
     * @returns {string[]}
     */
    _getSuggestions(topic, lang) {
      const group = SUGGESTIONS[topic] || SUGGESTIONS['general'];
      const pool = group[lang] || group['en'] || [];
      // Return a random 2-chip slice so suggestions vary
      const shuffled = pool.slice().sort(() => 0.5 - Math.random());
      return shuffled.slice(0, 2);
    }

    /**
     * Render clickable suggestion chips below the last bot message.
     * Clicking a chip fills the input and auto-sends the message.
     * @param {string[]} chips
     */
    _showSuggestions(chips) {
      if (!chips || chips.length === 0) return;
      const container = document.createElement('div');
      container.className = 'laba-suggestions';
      chips.forEach((text) => {
        const btn = document.createElement('button');
        btn.className = 'laba-suggestion-chip';
        btn.textContent = text;
        btn.addEventListener('click', () => {
          container.remove();
          this.inputEl.value = text;
          this._sendMessage();
        });
        container.appendChild(btn);
      });
      this.msgArea.appendChild(container);
      this._scrollToBottom();
    }

    /* ---- UI Helpers ---- */

    addMessage(role, content, isHtml = false) {
      const div = document.createElement('div');
      div.className = `laba-msg laba-${role === 'user' ? 'user' : 'bot'}`;
      if (isHtml) {
        div.innerHTML = content;
      } else {
        // Convert **bold** markdown to <strong>
        const html = content
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>');
        div.innerHTML = html;
      }
      this.msgArea.appendChild(div);
      this._scrollToBottom();
    }

    showTyping() {
      this.typingEl.classList.remove('laba-hidden');
      this.msgArea.appendChild(this.typingEl);
      this._scrollToBottom();
    }

    hideTyping() { this.typingEl.classList.add('laba-hidden'); }

    _scrollToBottom() {
      requestAnimationFrame(() => { this.msgArea.scrollTop = this.msgArea.scrollHeight; });
    }

    _setInputBusy(busy) {
      this.busy = busy;
      this.inputEl.disabled = busy;
      this.sendBtn.disabled = busy;
    }

    _sendMessage() {
      if (this.busy) return;
      const val = this.inputEl.value.trim();
      if (!val) return;
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.handleUserMessage(val);
    }

    _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  }

  /* ---- Bootstrap ---- */
  function init() {
    if (document.getElementById('laba-launcher')) return;
    window.__labaWidget = new LabaWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
