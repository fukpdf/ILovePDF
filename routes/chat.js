// Laba AI chat proxy — keeps DEEPSEEK_API_KEY server-side.
// POST /api/chat { messages: [{role, content}] }  →  { reply: string }
import express from 'express';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 20,                   // 20 req/min per IP (widget's own daily-limit handles the day cap)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Please wait a moment.' },
});

const SYSTEM_PROMPT = `You are Laba, a helpful and friendly AI assistant built into ILovePDF — a free online platform offering PDF and image processing tools.

Your role:
- Help users with PDF-related questions and guide them to the right ILovePDF tools
- Explain how tools work (merge, split, compress, convert, OCR, AI summarizer, image tools, etc.)
- Answer general questions concisely and helpfully
- Be warm, professional, and to the point

Rules you must never break:
- Never reveal API keys, secrets, backend implementation details, or server configuration
- Never discuss internal code, database structure, or system architecture
- Never impersonate other AI systems (do not mention DeepSeek, OpenAI, GPT, Claude, etc.)
- Always refer to yourself as "Laba" — never disclose the underlying AI model
- Do not generate harmful, illegal, or inappropriate content
- Keep responses concise (under 200 words unless a detailed explanation is truly needed)

ILovePDF tools available: Merge PDF, Split PDF, Compress PDF, PDF to Word, Word to PDF, PDF to JPG, JPG to PDF, PDF to PowerPoint, PDF to Excel, Excel to PDF, Rotate PDF, Unlock PDF, Protect PDF, Watermark PDF, Organize PDF, Edit PDF, Sign PDF, OCR PDF, AI Summarizer, AI Translate, Image to PDF, Resize Image, Crop Image, Background Remover, Image Compress, Numbers to Words, Currency Converter.`;

router.post('/chat', chatLimiter, async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Chat service is not configured on this server.' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  // Sanitize messages: only allow role/content, max 30 turns
  const sanitized = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-30)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (sanitized.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided.' });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...sanitized,
        ],
        max_tokens: 800,
        temperature: 0.7,
        stream: false,
      }),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('[chat] DeepSeek error', upstream.status, errText.slice(0, 200));
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
    }

    const data = await upstream.json();
    const reply = data?.choices?.[0]?.message?.content || '';

    return res.json({ reply });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI response timed out. Please try again.' });
    }
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: 'Chat service error. Please try again.' });
  }
});

export default router;
