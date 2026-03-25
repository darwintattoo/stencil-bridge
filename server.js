const express = require('express');
const { fal } = require('@fal-ai/client');
const Database = require('better-sqlite3');
const crypto = require('crypto');
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

const jobs = {};

const LORA_URL =
  'https://v3b.fal.media/files/b/0a919f3f/3sH9dV22IiRUQAaoQyP55_pytorch_lora_weights.safetensors';

const PROMPT =
  'Convert this image into a clean black and white tattoo stencil line art. Use bold, precise outlines with fine detail preservation. Style: fluxdarwinupc';

const LIMIT = 2;
const SITE_URL = 'https://stencil.tattoostencilpro.app';

const MESSAGES = {
  es: {
    blocked:
      'Ya usaste tus 2 stencils gratuitos. Para generar ilimitados registrate en nuestra plataforma, es rapido y gratis para empezar.',
    error: 'Hubo un problema procesando tu imagen. Intentalo de nuevo con otra foto.',
  },
  en: {
    blocked:
      "You have used your 2 free stencils. Sign up on our platform to generate unlimited ones — it's free to get started.",
    error: 'There was a problem processing your image. Please try again with another photo.',
  },
  pt: {
    blocked:
      'Voce ja usou seus 2 stencils gratuitos. Cadastre-se para gerar ilimitados — e gratis para comecar.',
    error: 'Houve um problema ao processar sua imagem. Tente novamente com outra foto.',
  },
  fr: {
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

app.get('/', (req, res) => {
  res.send('Stencil bridge online');
});

app.post('/stencil-start', async (req, res) => {
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
      status: 'blocked',
      output: '',
      message: t.blocked,
      link: SITE_URL
    });
  }

  const jobId = crypto.randomUUID();

  jobs[jobId] = {
    status: 'processing',
    output: '',
    userId,
    locale,
    error: ''
  };

  res.json({
    job_id: jobId,
    status: 'processing'
  });

  setImmediate(async () => {
    try {
      console.log('Inicio procesamiento background job:', jobId, 'user:', userId);

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

      const safeImageUrl = await fal.storage.upload(blob);
      console.log('Imagen subida a fal storage:', safeImageUrl);

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

      increment(userId);

      jobs[jobId].status = 'done';
      jobs[jobId].output = stencilUrl;

      console.log('Stencil generado job:', jobId, stencilUrl);
    } catch (err) {
      console.error('Error en job:', jobId, err);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message || 'unknown error';
    }
  });
});

app.get('/stencil-status', async (req, res) => {
  const jobId = req.query.job_id;

  if (!jobId || !jobs[jobId]) {
    return res.status(404).json({
      status: 'error',
      output: '',
      error: 'job not found'
    });
  }

  const job = jobs[jobId];

  if (job.status === 'processing') {
    return res.json({
      status: 'processing',
      output: ''
    });
  }

  if (job.status === 'error') {
    const lang = getLang(job.locale);
    return res.json({
      status: 'error',
      output: '',
      error: MESSAGES[lang].error
    });
  }

  if (job.status === 'done') {
    return res.json({
      status: 'done',
      output: job.output
    });
  }

  return res.json({
    status: 'processing',
    output: ''
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
