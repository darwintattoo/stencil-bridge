const express = require('express');
const { fal } = require('@fal-ai/client');
const Database = require('better-sqlite3');
require('dotenv').config();

const app = express();
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const db = new Database('usage.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    count   INTEGER DEFAULT 0
  )
`);

const LORA_URL = 'https://v3b.fal.media/files/b/0a919f3f/3sH9dV22IiRUQAaoQyP55_pytorch_lora_weights.safetensors';
const PROMPT   = 'Convert this image into a clean black and white tattoo stencil line art. Use bold, precise outlines with fine detail preservation. Style: fluxdarwinupc';
const LIMIT    = 2;
const SITE_URL = 'https://stencil.tattoostencilpro.app';

// ── Mensajes por idioma ─────────────────────────────────────────────────────
const MESSAGES = {
  es: {
    remaining: (n) => `Aqui esta tu stencil! Te queda ${n} generacion gratuita.`,
    last:           `Aqui esta tu stencil! Has usado tus 2 generaciones gratuitas.`,
    upsell:         `Para generar ilimitados registrate aqui, es gratis para empezar:`,
    blocked:        `Ya usaste tus 2 stencils gratuitos. Para generar ilimitados registrate en nuestra plataforma, es rapido y gratis para empezar.`,
    error:          `Hubo un problema procesando tu imagen. Intentalo de nuevo con otra foto.`,
  },
  en: {
    remaining: (n) => `Here is your stencil! You have ${n} free generation left.`,
    last:           `Here is your stencil! You have used your 2 free generations.`,
    upsell:         `To generate unlimited stencils, sign up here — it's free to get started:`,
    blocked:        `You have used your 2 free stencils. Sign up on our platform to generate unlimited ones — it's free to get started.`,
    error:          `There was a problem processing your image. Please try again with another photo.`,
  },
  pt: {
    remaining: (n) => `Aqui esta o seu stencil! Voce tem ${n} geracao gratuita restante.`,
    last:           `Aqui esta o seu stencil! Voce usou suas 2 geracoes gratuitas.`,
    upsell:         `Para gerar ilimitados, cadastre-se aqui — e gratis para comecar:`,
    blocked:        `Voce ja usou seus 2 stencils gratuitos. Cadastre-se para gerar ilimitados — e gratis para comecar.`,
    error:          `Houve um problema ao processar sua imagem. Tente novamente com outra foto.`,
  },
  fr: {
    remaining: (n) => `Voici votre stencil ! Il vous reste ${n} generation gratuite.`,
    last:           `Voici votre stencil ! Vous avez utilise vos 2 generations gratuites.`,
    upsell:         `Pour generer des stencils illimites, inscrivez-vous ici — c'est gratuit :`,
    blocked:        `Vous avez utilise vos 2 stencils gratuits. Inscrivez-vous pour en generer a l'infini — c'est gratuit.`,
    error:          `Une erreur s'est produite. Veuillez reessayer avec une autre photo.`,
  },
};

function getLang(locale) {
  if (!locale) return 'en';
  const code = locale.toLowerCase().slice(0, 2);
  return MESSAGES[code] ? code : 'en';
}

// ── Helpers DB ───────────────────────────────────────────────────────────────
function getCount(userId) {
  const row = db.prepare('SELECT count FROM users WHERE user_id = ?').get(userId);
  return row ? row.count : 0;
}

function increment(userId) {
  db.prepare(`
    INSERT INTO users (user_id, count) VALUES (?, 1)
    ON CONFLICT(user_id) DO UPDATE SET count = count + 1
  `).run(userId);
}

// ── Endpoint principal ───────────────────────────────────────────────────────
app.post('/stencil', async (req, res) => {
  const imageUrl = req.body.image_url;
  const userId   = req.body.user_id;    // {{contact.id}} en ManyChat
  const locale   = req.body.locale;     // {{contact.locale}} en ManyChat

  if (!imageUrl || !userId) {
    return res.status(400).json({ error: 'image_url y user_id son requeridos' });
  }

  const lang = getLang(locale);
  const t    = MESSAGES[lang];
  const count = getCount(userId);

  // Limite alcanzado
  if (count >= LIMIT) {
    return res.json({
      version: 'v2',
      content: {
        messages: [
          { type: 'text', text: t.blocked },
          { type: 'text', text: SITE_URL },
        ],
      },
    });
  }

  try {
    const result = await fal.subscribe('fal-ai/flux-2/lora/edit', {
      input: {
        image_url: imageUrl,
        prompt: PROMPT,
        loras: [{ path: LORA_URL, scale: 1.0 }],
        num_inference_steps: 30,
        guidance_scale: 7.5,
      },
      logs: false,
    });

    const stencilUrl = result.data.images[0].url;

    increment(userId);
    const remaining = LIMIT - getCount(userId);

    const messages = [
      {
        type: 'text',
        text: remaining > 0 ? t.remaining(remaining) : t.last,
      },
      {
        type: 'image',
        url: stencilUrl,
      },
    ];

    if (remaining === 0) {
      messages.push({ type: 'text', text: t.upsell });
      messages.push({ type: 'text', text: SITE_URL });
    }

    res.json({ version: 'v2', content: { messages } });

  } catch (err) {
    console.error('Error fal.ai:', err.message);
    res.json({
      version: 'v2',
      content: {
        messages: [{ type: 'text', text: t.error }],
      },
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
