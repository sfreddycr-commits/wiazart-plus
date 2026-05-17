// ============================================================================
// Wiazart API Gateway v3.0 — Full Groq STT Integration
// Handles Desktop App API + Dashboard + Admin + Audio Transcription
// ============================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mysql = require('mysql2/promise');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');

const VERSION = "3.0.0";
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wiazart-dashboard-secret-2026';

// ─── Groq Configuration Constants ────────────────────────────────────
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_SUPPORTED_FORMATS = ['flac', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

app.use(cors());
app.use(morgan('dev'));

// ─── Clean URLs for Dashboard ─────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html')));
app.get('/subscription', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html')));
app.get('/pro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ─── MySQL Pool ───────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || '172.17.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'wiazart',
  password: process.env.DB_PASS || 'wiazart123',
  database: process.env.DB_NAME || 'wiazart',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS plans (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL, price INT NOT NULL DEFAULT 0, credits INT NOT NULL DEFAULT 0, features TEXT, is_default INT NOT NULL DEFAULT 0)`);
    await conn.query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL, user_id VARCHAR(50) UNIQUE NOT NULL, api_key VARCHAR(100) UNIQUE NOT NULL, plan_id VARCHAR(50) NOT NULL DEFAULT 'free', total_credits INT NOT NULL DEFAULT 1000, used_credits INT NOT NULL DEFAULT 0, is_admin INT NOT NULL DEFAULT 0, reset_date TEXT NOT NULL, created_at TEXT NOT NULL)`);
    await conn.query(`CREATE TABLE IF NOT EXISTS ai_providers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, model_name VARCHAR(100) NOT NULL DEFAULT '', is_active INT NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    await conn.query(`CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)`);
    console.log('  ✓ Database tables verified');
  } finally { conn.release(); }
}

const cleanString = (str) => typeof str === 'string' ? str.replace(/[^\x00-\x7F]/g, "").trim() : str;
function generateApiKey() { return 'wz_' + crypto.randomBytes(32).toString('hex'); }

// ─── Shared: Authenticate user by API key ─────────────────────────────
async function authenticateApiKey(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const apiKey = cleanString(auth.split(' ')[1]);
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  return users[0] || null;
}

// ─── Shared: Get a setting from the DB ────────────────────────────────
async function getSetting(key) {
  const [[row]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = ?", [key]);
  return row?.setting_value || null;
}

// ============================================================================
// GROQ AUDIO TRANSCRIPTION — Dedicated Handler (Clean Implementation)
// ============================================================================
//
// How it works:
//   1. Desktop app records audio via MediaRecorder (webm/opus format)
//   2. Desktop app sends POST multipart/form-data to /v1/audio/transcriptions
//      with fields: file (binary), model ("gpt-4o-mini-transcribe")
//   3. This gateway intercepts the request using multer to properly parse
//      the multipart body
//   4. We build a NEW clean multipart request to Groq's API using the
//      official endpoint and model name (whisper-large-v3-turbo)
//   5. We return Groq's JSON response { text: "..." } back to the desktop app
//
// Groq API Reference:
//   Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions
//   Auth:     Bearer <GROQ_API_KEY>
//   Body:     multipart/form-data with "file" (audio) and "model" (string)
//   Formats:  flac, mp3, m4a, mp4, mpeg, mpga, oga, ogg, wav, webm
//   Models:   whisper-large-v3, whisper-large-v3-turbo
//   Response: { "text": "transcribed text..." }
// ============================================================================

// Configure multer to store uploaded audio files in memory (no disk I/O)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max (Groq free tier limit)
});

app.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
  console.log('[GROQ-STT] ── Incoming transcription request ──');

  // 1. Authenticate
  const user = await authenticateApiKey(req);
  if (!user) {
    console.log('[GROQ-STT] ✗ Authentication failed');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  // 2. Check credits
  const remaining = user.total_credits - user.used_credits;
  if (remaining <= 0) {
    console.log(`[GROQ-STT] ✗ No credits for user ${user.email}`);
    return res.status(402).json({ error: 'No credits remaining' });
  }

  // 3. Get Groq API key from admin settings
  const groqApiKey = await getSetting('groq_audio_key');
  if (!groqApiKey) {
    console.log('[GROQ-STT] ✗ Groq API key not configured');
    return res.status(500).json({
      error: 'Groq Audio API key not configured. Ask your admin to set it in the Admin Panel → Voice Engine Settings.'
    });
  }

  // 4. Validate uploaded file
  if (!req.file) {
    console.log('[GROQ-STT] ✗ No audio file in request');
    return res.status(400).json({ error: 'No audio file provided in the "file" field' });
  }

  const audioBuffer = req.file.buffer;
  const originalName = req.file.originalname || 'audio.webm';
  const mimeType = req.file.mimetype || 'audio/webm';

  console.log(`[GROQ-STT] User: ${user.email}`);
  console.log(`[GROQ-STT] File: ${originalName} (${mimeType}, ${(audioBuffer.length / 1024).toFixed(1)}KB)`);

  // 5. Optionally read additional fields from the desktop app's form
  const requestedLanguage = req.body?.language || null;
  const responseFormat = req.body?.response_format || 'json';

  // 6. Build a clean FormData to send to Groq
  const groqFormData = new FormData();
  const audioBlob = new Blob([audioBuffer], { type: mimeType });
  groqFormData.append('file', audioBlob, originalName);
  groqFormData.append('model', GROQ_STT_MODEL);
  groqFormData.append('response_format', responseFormat);

  if (requestedLanguage) {
    groqFormData.append('language', requestedLanguage);
  }

  // 7. Forward to Groq
  const groqUrl = `${GROQ_API_BASE}/audio/transcriptions`;
  console.log(`[GROQ-STT] → Forwarding to Groq: ${groqUrl} (model: ${GROQ_STT_MODEL})`);

  try {
    const groqResponse = await fetch(groqUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
      },
      body: groqFormData,
    });

    const groqStatus = groqResponse.status;
    const groqContentType = groqResponse.headers.get('content-type') || '';

    if (!groqResponse.ok) {
      const errorBody = await groqResponse.text();
      console.log(`[GROQ-STT] ✗ Groq returned error ${groqStatus}: ${errorBody}`);
      return res.status(groqStatus).json({
        error: `Groq transcription failed (${groqStatus})`,
        details: errorBody
      });
    }

    // 8. Return response to desktop app
    const resultText = await groqResponse.text();
    console.log(`[GROQ-STT] ✓ Transcription successful (${resultText.length} chars)`);

    // Deduct 1 credit
    await pool.query('UPDATE users SET used_credits = used_credits + 1 WHERE id = ?', [user.id]);

    // Return with the same content type Groq sent (usually application/json)
    res.setHeader('Content-Type', groqContentType);
    res.status(200).send(resultText);

  } catch (err) {
    console.error('[GROQ-STT] ✗ Network error calling Groq:', err.message);
    res.status(502).json({
      error: 'Failed to reach Groq API',
      details: err.message
    });
  }
});

// ============================================================================
// GROQ ADMIN API — Test Connection & Model Listing
// ============================================================================

// Test Groq API key connectivity
app.post('/api/admin/groq/test', express.json(), async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });

  try {
    // Call Groq's models endpoint to validate the key
    const testRes = await fetch(`${GROQ_API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.json({ ok: false, error: `Groq returned ${testRes.status}: ${errText}` });
    }

    const data = await testRes.json();
    // Filter to show only whisper (audio) models
    const audioModels = (data.data || [])
      .filter(m => m.id.toLowerCase().includes('whisper'))
      .map(m => ({ id: m.id, owned_by: m.owned_by }));

    return res.json({
      ok: true,
      message: `Connected! Found ${audioModels.length} audio model(s).`,
      models: audioModels,
      totalModels: (data.data || []).length
    });
  } catch (err) {
    return res.json({ ok: false, error: `Network error: ${err.message}` });
  }
});

// ============================================================================
// AI PROXY — Chat Completions & Other Routes (Non-Audio)
// ============================================================================
app.use('/v1/chat/completions', express.json({ limit: '50mb' }));
app.use('/v1/responses', express.json({ limit: '50mb' }));
app.use('/v1/images/generations', express.json({ limit: '50mb' }));

const proxyToActiveProvider = async (req, res) => {
  const user = await authenticateApiKey(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const remaining = user.total_credits - user.used_credits;
  if (remaining <= 0) return res.status(402).json({ error: 'No credits remaining' });

  const [[provider]] = await pool.query('SELECT * FROM ai_providers WHERE is_active = 1');
  if (!provider) return res.status(503).json({ error: 'No active AI provider configured' });

  const subPath = req.path.replace(/^\/v1/, '');
  const targetUrl = `${provider.base_url.replace(/\/$/, '')}${subPath}`;
  const finalApiKey = provider.api_key;

  try {
    let body = req.body;
    let headers = { 'Authorization': `Bearer ${cleanString(finalApiKey)}` };

    headers['Content-Type'] = 'application/json';
    if (typeof body === 'object' && body !== null) {
      // Clean Wiazart/Dyad internal options that providers don't understand
      ['wiazart_options', 'wiazartVersionedFiles', 'wiazartFiles', 'wiazartRequestId',
       'wiazartAppId', 'wiazartDisableFiles', 'wiazartMentionedApps', 'wiazartSmartContextMode'
      ].forEach(k => delete body[k]);
      // Override model to the admin-configured model
      if (provider.model_name && body.model) {
        body.model = provider.model_name;
      }
    }
    body = JSON.stringify(body);

    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body
    });

    await pool.query('UPDATE users SET used_credits = used_credits + 1 WHERE id = ?', [user.id]);
    res.status(proxyRes.status);
    const contentType = proxyRes.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream') || req.body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(decoder.decode(value, { stream: true }));
      }
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(await proxyRes.text());
    }
  } catch (err) {
    console.error('[PROXY] Error:', err.message);
    res.status(502).json({ error: 'Proxy error', details: err.message });
  }
};

app.post(['/v1/chat/completions', '/v1/responses', '/v1/images/generations'], proxyToActiveProvider);

// ============================================================================
// WEB SEARCH & CRAWL/FETCH TOOLS (Jina AI Integration)
// ============================================================================

app.post('/v1/tools/web-search', express.json(), async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  const user = await authenticateApiKey(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  console.log(`[SEARCH] Query: "${query}" for user ${user.email}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'text/plain',
      }
    });

    if (!response.ok) {
      throw new Error(`Jina Search returned status ${response.status}`);
    }

    const text = await response.text();
    const chunkSize = 150;
    
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      const data = {
        choices: [{
          delta: {
            content: chunk
          }
        }]
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[SEARCH] Error:', err.message);
    const errData = { error: { message: err.message } };
    res.write(`data: ${JSON.stringify(errData)}\n\n`);
    res.end();
  }
});

app.post('/v1/tools/web-crawl', express.json(), async (req, res) => {
  const { url, markdownOnly } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const user = await authenticateApiKey(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  console.log(`[CRAWL] URL: "${url}" (markdownOnly: ${!!markdownOnly}) for user ${user.email}`);

  try {
    const readerUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(readerUrl, {
      headers: {
        'Accept': 'text/plain',
      }
    });

    if (!response.ok) {
      throw new Error(`Jina Reader returned status ${response.status}`);
    }

    const markdown = await response.text();

    const result = {
      rootUrl: url,
      markdown: markdown,
      pages: [
        {
          url: url,
          markdown: markdown
        }
      ]
    };

    if (!markdownOnly) {
      result.screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    }

    res.json(result);
  } catch (err) {
    console.error('[CRAWL] Error:', err.message);
    res.status(502).json({ error: 'Scraping failed', details: err.message });
  }
});


// Dynamic Plans Endpoint
app.get('/api/plans', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM plans');
    const formatted = rows.map(p => {
      let parsedFeatures = [];
      try {
        parsedFeatures = typeof p.features === 'string' ? JSON.parse(p.features) : (p.features || []);
      } catch (e) {
        parsedFeatures = p.features ? p.features.split(',').map(f => f.trim()) : [];
      }
      return { ...p, features: parsedFeatures };
    });
    res.json(formatted);
  } catch (err) {
    console.error('Failed to get plans:', err);
    res.status(500).json({ error: 'Failed to retrieve plans' });
  }
});

// App Templates Endpoint (Desktop App Compatibility)
app.get('/v1/templates', (req, res) => {
  res.json([
    {
      githubOrg: "wiazart",
      githubRepo: "react-vite-shadcn-template",
      title: "React.js Template",
      description: "Uses React.js, Vite, Shadcn, Tailwind, and TypeScript.",
      imageUrl: "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9"
    },
    {
      githubOrg: "wiazart",
      githubRepo: "nextjs-template",
      title: "Next.js Template",
      description: "Uses Next.js, React.js, Shadcn, Tailwind, and TypeScript.",
      imageUrl: "https://github.com/user-attachments/assets/96258e4f-abce-4910-a62a-a9dff77965f2"
    }
  ]);
});

// ─── App Config ──────────────────────────────────────────────────────
app.get('/v1/language-model-catalog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog.json')));
app.get('/v1/desktop-config', (req, res) => res.sendFile(path.join(__dirname, 'public', 'desktop-config.json')));

// Modern Wiazart User Info (Budget)
app.get('/v1/user/info', async (req, res) => {
  const user = await authenticateApiKey(req);
  if (!user) return res.status(403).json({ error: 'Invalid API key' });
  res.json({
    usedCredits: user.used_credits,
    totalCredits: user.total_credits,
    budgetResetDate: new Date().toISOString(),
    userId: user.user_id,
    isTrial: false
  });
});

// Legacy User Info
app.get('/user/info', async (req, res) => {
  const user = await authenticateApiKey(req);
  if (!user) return res.status(403).json({ error: 'Invalid API key' });
  const ratio = (10 * 3) / 2;
  res.json({ user_info: { spend: user.used_credits / ratio, max_budget: user.total_credits / ratio, budget_reset_at: user.reset_date } });
});

app.get('/v1/update/:channel', (req, res) => res.status(204).end());

// ─── Auth API ─────────────────────────────────────────────────────────
app.post(['/api/login', '/api/auth/login'], express.json(), async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      console.log(`[AUTH] Login failed: User not found (${email})`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = users[0];
    if (!await bcrypt.compare(password, user.password_hash)) {
      console.log(`[AUTH] Login failed: Password mismatch for ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log(`[AUTH] Login successful: ${email}`);
    const token = jwt.sign({ id: user.id, email: user.email, isAdmin: !!user.is_admin }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      api_key: user.api_key,
      user_id: user.user_id,
      user: { id: user.id, email: user.email, isAdmin: !!user.is_admin }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

app.post('/api/auth/signup', express.json(), async (req, res) => {
  const { email, password, planId } = req.body;
  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const userId = 'usr_' + crypto.randomBytes(4).toString('hex');
    const apiKey = generateApiKey();
    
    // Look up dynamic plan credits
    const [plans] = await pool.query('SELECT credits FROM plans WHERE id = ?', [planId]);
    const credits = plans.length > 0 ? plans[0].credits : 1000;

    await pool.query(
      'INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [email, hash, userId, apiKey, planId, credits, 0]
    );

    const [newUsers] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = newUsers[0];

    const token = jwt.sign({ id: user.id, email: user.email, isAdmin: !!user.is_admin }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      api_key: user.api_key,
      user_id: user.user_id,
      user: { id: user.id, email: user.email, isAdmin: !!user.is_admin }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

app.get('/api/v2/profile/me', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [decoded.id]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.user_id, email: user.email, api_key: user.api_key,
      plan_id: user.plan_id, total_credits: user.total_credits,
      used_credits: user.used_credits, is_admin: !!user.is_admin
    });
  } catch (err) { res.status(401).json({ error: 'Invalid or expired token' }); }
});

app.post(['/api/register', '/api/auth/register'], express.json(), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email/Password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const userId = 'usr_' + crypto.randomBytes(4).toString('hex');
    const apiKey = generateApiKey();
    await pool.query('INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [email, hash, userId, apiKey, 'pro', 10000, 0]);
    res.json({ ok: true, user: { email, userId, isAdmin: false } });
  } catch (e) { res.status(500).json({ error: 'Registration failed' }); }
});

// ─── Admin API ────────────────────────────────────────────────────────
app.get('/api/admin/providers', async (req, res) => {
  const [providers] = await pool.query('SELECT * FROM ai_providers');
  res.json(providers);
});
app.post('/api/admin/providers', express.json(), async (req, res) => {
  const { name, baseUrl, apiKey, modelName } = req.body;
  await pool.query('INSERT INTO ai_providers (name, base_url, api_key, model_name, is_active, created_at) VALUES (?, ?, ?, ?, 0, NOW())', [name, baseUrl, apiKey, modelName || '']);
  res.json({ ok: true });
});
app.put('/api/admin/providers/:id', express.json(), async (req, res) => {
  const { name, baseUrl, apiKey, modelName } = req.body;
  await pool.query('UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, model_name = ? WHERE id = ?', [name, baseUrl, apiKey, modelName || '', req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/providers/:id/activate', async (req, res) => {
  await pool.query('UPDATE ai_providers SET is_active = 0');
  await pool.query('UPDATE ai_providers SET is_active = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/admin/providers/:id', async (req, res) => {
  await pool.query('DELETE FROM ai_providers WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Settings Endpoints
app.get('/api/admin/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/settings', express.json(), async (req, res) => {
  const { setting_key, setting_value } = req.body;
  try {
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?', [setting_key, setting_value, setting_value]);
    res.json({ message: 'Setting updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/settings/bulk', express.json(), async (req, res) => {
  const settings = req.body; // Expects an array: [{setting_key, setting_value}, ...]
  try {
    for (const s of settings) {
      if (!s.setting_key) continue;
      await pool.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?', 
        [s.setting_key, s.setting_value || '', s.setting_value || '']
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  const [users] = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
  res.json(users);
});
app.post('/api/admin/users', express.json(), async (req, res) => {
  const { email, password, planId } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const userId = 'usr_' + crypto.randomBytes(4).toString('hex');
    const apiKey = generateApiKey();
    
    // Dynamic credits from database
    const [plans] = await pool.query('SELECT credits FROM plans WHERE id = ?', [planId]);
    const credits = plans.length > 0 ? plans[0].credits : 1000;

    await pool.query('INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [email, hash, userId, apiKey, planId, credits, 0]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/admin/users/:id', express.json(), async (req, res) => {
  const { plan_id, total_credits, used_credits, reset_date } = req.body;
  try {
    await pool.query(
      'UPDATE users SET plan_id = ?, total_credits = ?, used_credits = ?, reset_date = ? WHERE id = ?',
      [plan_id, total_credits, used_credits, reset_date || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Plans API ──────────────────────────────────────────────────
app.get('/api/admin/plans', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM plans');
    const formatted = rows.map(p => {
      let parsedFeatures = [];
      try {
        parsedFeatures = typeof p.features === 'string' ? JSON.parse(p.features) : (p.features || []);
      } catch (e) {
        parsedFeatures = p.features ? p.features.split(',').map(f => f.trim()) : [];
      }
      return { ...p, features: parsedFeatures };
    });
    res.json(formatted);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/plans', express.json(), async (req, res) => {
  const { id, name, price, credits, features, is_default } = req.body;
  try {
    const featuresStr = JSON.stringify(features || []);
    await pool.query(
      'INSERT INTO plans (id, name, price, credits, features, is_default) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, price, credits, featuresStr, is_default ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/plans/:id', express.json(), async (req, res) => {
  const { name, price, credits, features, is_default } = req.body;
  try {
    const featuresStr = JSON.stringify(features || []);
    await pool.query(
      'UPDATE plans SET name = ?, price = ?, credits = ?, features = ?, is_default = ? WHERE id = ?',
      [name, price, credits, featuresStr, is_default ? 1 : 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/plans/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: VERSION, groqEndpoint: GROQ_API_BASE }));

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✦ Wiazart Gateway v${VERSION}`);
    console.log(`  ✦ Groq STT: ${GROQ_API_BASE}/audio/transcriptions`);
    console.log(`  ✦ Groq Model: ${GROQ_STT_MODEL}`);
    console.log(`  ✦ Listening on port ${PORT}\n`);
  });
});
