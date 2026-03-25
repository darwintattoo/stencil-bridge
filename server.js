const express = require('express');
const { fal } = require('@fal-ai/client');
const Database = require('better-sqlite3');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

fal.config({ credentials: process.env.FAL_KEY });

const db = new Database('usage.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    count   INTEGER DEFAULT 0
  )
`);

const LORA_URL =
  'https://v3b.fal.media/files/b/0a919f3f/3sH9dV22IiRUQAaoQyP55_pytorch_lora_weights.safetensors';

const PROMPT =
  'Convert this image into a clean black and white tattoo stencil line art. Use bold, precise outlines with fine detail preservation. Style: fluxdarwinupc';

const LIMIT = 2;
const SITE_URL = 'https://stencil.tattoostencilpro.app';
const MANYCHAT_API_URL = 'https://api.manychat.com/fb/sending/sendContent';

const MESSAGES = {
  es: {
    processing: 'Estoy generando tu stencil. Te lo mando en un momento...',
    remaining: (n) => `Aqui esta tu stencil. Te queda ${n} generacion gratuita.`,
    last: 'Aqui esta tu stencil. Has usado tus 2 generaciones gratuitas.',
    upsell: 'Para generar ilimitados registrate aqui, es gratis para empezar:',
    blocked:
      'Ya usaste tus 2 stencils gratuitos. Para generar ilimitados registrate en nuestra plataforma, es rapido y gratis para empezar.',
    error: 'Hubo un problema procesando tu imagen. Intentalo de nuevo con otra foto.',
  },
  en: {
    processing: 'I am generating your stencil. I will send it in a moment...',
    remaining: (n) => `Here is your stencil. You have ${n} free generation left.`,
    last: 'Here is your stencil. You have used your 2 free generations.',
    upsell: "To generate unlimited stencils, sign up here — it's free to get started:",
    blocked:
      "You have used your 2 free stencils. Sign up on our platform to generate unlimited ones — it's free to get started.",
    error: 'There was a problem processing your image. Please try again with another photo.',
  },
  pt: {
    processing: 'Estou gerando seu stencil. Vou te enviar em instantes...',
    remaining: (n) => `Aqui esta o seu stencil. Voce tem ${n} geracao gratuita restante.`,
    last: 'Aqui esta o seu stencil. Voce usou suas 2 geracoes gratuitas.',
    upsell: 'Para gerar ilimitados, cadastre-se aqui — e gratis para comecar:',
    blocked:
      'Voce ja usou seus 2 stencils gratuitos. Cadastre-se para gerar ilimitados — e gratis para comecar.',
    error: 'Houve um problema ao processar sua imagem. Tente novamente com outra foto.',
  },
  fr: {
    processing: 'Je genere votre stencil. Je vous lenvoie dans un instant...',
    remaining: (n) => `Voici votre stencil. Il vous reste ${n} generation gratuite.`,
    last: 'Voici votre stencil. Vous avez utilise vos 2 generations gratuites.',
    upsell: "Pour generer des stencils illimites, inscrivez-vous ici — c'est gratuit :",
    blocked:
      "Vous avez utilise vos 2 stencils gratuits. Inscrivez-vous pour en generer a l'infini — c'est gratuit.",
    error: 'Une erreur sest produite. Veuillez reessayer avec une autre photo.',
  },
};

function getLang(locale) {
  if (!locale) return 'en';
  const code = String(locale).toLowerCase().slice(0, 2);
  return MESSAGES[code] ? code : 'en';
}

function getCount(userId) {
  const row = db.prepare('SELECT count FROM users WHERE user_id = ?').get(String(userId));
  return row ? row.count : 0;
}

function increment(userId) {
  db.prepare(`
    INSERT INTO users (user_id, count) VALUES (?, 1)
    ON CONFLICT(user_id) DO UPDATE SET count = count + 1
  `).run(String(userId));
}

async function sendManychatContent(subscriberId, data) {
  if (!process.env.MANYCHAT_API_KEY) {
    throw new Error('Falta MANYCHAT_API_KEY en Railway');
  }

  const payload = {
    subscriber_id: Number(subscriberId),
    data,
  };

  console.log('Enviando a ManyChat payload:', JSON.stringify(payload, null, 2));

  const response = await fetch(MANYCHAT_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  console.log('ManyChat status:', response.status);
  console.log('ManyChat body:', text);

  if (!response.ok) {
    throw new Error(`ManyChat API error ${response.status}: ${text}`);
  }

  return text;
}

app.get('/', (req, res) => {
  res.send('Stencil bridge online');
});

app.post('/stencil', async (req, res) => {
  const imageUrl = req.body.image_url;
  const userId = req.body.user_id;
  const locale = req.body.locale;

  if (!imageUrl || !userId) {
    return res.status(400).json({ error: 'image_url y user_id son requeridos' });
  }

  const lang = getLang(locale);
  const t = MESSAGES[lang];
  const count = getCount(userId);

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

  // Respuesta rápida para evitar timeout en ManyChat
  res.json({
    version: 'v2',
    content: {
      messages: [
        {
          type: 'text',
          text: t.processing,
        },
      ],
    },
  });

  // Proceso en segundo plano
  setImmediate(async () => {
    try {
      console.log('Inicio procesamiento background para user:', userId);
      console.log('URL original recibida:', imageUrl);

      // 1) Descargar la imagen desde la URL de Instagram/ManyChat
      const imgRes = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!imgRes.ok) {
        throw new Error(`No se pudo descargar la imagen original: ${imgRes.status}`);
      }

      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await imgRes.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: contentType });

      // 2) Subir imagen a fal storage
      const safeImageUrl = await fal.storage.upload(blob);
      console.log('Imagen subida a fal storage:', safeImageUrl);

      // 3) Generar stencil en fal
      const result = await fal.subscribe('fal-ai/flux-2/lora/edit', {
        input: {
          prompt: PROMPT,
          image_urls: [safeImageUrl],
          loras: [{ path: LORA_URL, scale: 1.0 }],
          num_inference_steps: 30,
          guidance_scale: 2.5,
          enable_safety_checker: false,
          output_format: 'png',
        },
        logs: true,
      });

      const stencilUrl = result?.data?.images?.[0]?.url;

      if (!stencilUrl) {
        throw new Error('fal no devolvio imagen');
      }

      console.log('Stencil generado:', stencilUrl);

      // 4) Solo contar uso cuando sí hubo imagen
      increment(userId);
      const remaining = LIMIT - getCount(userId);

      const finalMessages = [
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
        finalMessages.push({ type: 'text', text: t.upsell });
        finalMessages.push({ type: 'text', text: SITE_URL });
      }

      // 5) Enviar resultado final por API de ManyChat
      await sendManychatContent(userId, {
        version: 'v2',
        content: {
          messages: finalMessages,
        },
      });

      console.log('Stencil enviado a ManyChat para user:', userId);
    } catch (err) {
      console.error('Error en segundo plano:', err);

      try {
        await sendManychatContent(userId, {
          version: 'v2',
          content: {
            messages: [
              {
                type: 'text',
                text: t.error,
              },
            ],
          },
        });
      } catch (manychatErr) {
        console.error('Error enviando mensaje de error a ManyChat:', manychatErr);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));;
