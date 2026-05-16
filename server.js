// ============================================================================
// Wiazart API Gateway v2.3 — Modern Version Compatibility
// Handles Desktop App API + Dashboard + Admin Management
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

const VERSION = "2.3.0";
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wiazart-dashboard-secret-2026';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(morgan('dev'));

// ─── Clean URLs for Dashboard ─────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-dashboard.html')));
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
    console.log('  ✓ Wiazart Ecosystem Ready');
  } finally { conn.release(); }
}

const cleanString = (str) => typeof str === 'string' ? str.replace(/[^\x00-\x7F]/g, "").trim() : str;
function generateApiKey() { return 'wz_' + crypto.randomBytes(32).toString('hex'); }

// ─── AI Proxy (Including Transcriptions) ──────────────────────────────
const proxyToActiveProvider = async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const apiKey = cleanString(auth.split(' ')[1]);
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  const user = users[0];
  if (!user) return res.status(403).json({ error: 'Invalid API key' });

  const remaining = user.total_credits - user.used_credits;
  if (remaining <= 0) return res.status(402).json({ error: 'No credits remaining' });

  const [[provider]] = await pool.query('SELECT * FROM ai_providers WHERE is_active = 1');
  if (!provider) return res.status(503).json({ error: 'No active AI provider' });

  const subPath = req.path.replace(/^\/v1/, '');
  const targetUrl = `${provider.base_url.replace(/\/$/, '')}${subPath}`;

  try {
    let body = req.body;
    let headers = { 'Authorization': `Bearer ${cleanString(provider.api_key)}` };
    
    // Handle JSON body
    if (req.is('json')) {
      headers['Content-Type'] = 'application/json';
      if (typeof body === 'object' && body !== null) {
        // Clean Dyad internal options
        ['wiazart_options', 'wiazartVersionedFiles', 'wiazartFiles', 'wiazartRequestId', 'wiazartAppId', 'wiazartDisableFiles', 'wiazartMentionedApps', 'wiazartSmartContextMode', 'wiazart_options'].forEach(k => delete body[k]);
        if (provider.model_name && body.model) body.model = provider.model_name;
      }
      body = JSON.stringify(body);
    } else {
      // For multipart (audio transcriptions), we might need to handle it differently
      // But fetch can handle Buffer/Stream if passed correctly.
      // For now, if it's not JSON, we pass the raw body (which works for simple proxying)
      body = req.body;
    }

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
      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) { res.end(); break; } res.write(decoder.decode(value, { stream: true })); }
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(await proxyRes.text());
    }
  } catch (err) { res.status(502).json({ error: 'Proxy error', details: err.message }); }
};

app.post(['/v1/chat/completions', '/v1/responses', '/v1/images/generations', '/v1/audio/transcriptions'], proxyToActiveProvider);

// ─── App Config ──────────────────────────────────────────────────────
app.get('/v1/language-model-catalog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog.json')));
app.get('/v1/desktop-config', (req, res) => res.sendFile(path.join(__dirname, 'public', 'desktop-config.json')));

// Modern Wiazart User Info (Budget)
app.get('/v1/user/info', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const apiKey = cleanString(auth.split(' ')[1]);
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  const user = users[0];
  if (!user) return res.status(403).json({ error: 'Invalid API key' });

  // Return format expected by pro_handlers.ts
  res.json({ 
    usedCredits: user.used_credits,
    totalCredits: user.total_credits,
    budgetResetDate: new Date().toISOString(), // Default to today for now
    userId: user.user_id,
    isTrial: false
  });
});

// Legacy User Info (if still used)
app.get('/user/info', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const apiKey = cleanString(auth.split(' ')[1]);
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  const user = users[0];
  if (!user) return res.status(403).json({ error: 'Invalid API key' });
  const ratio = (10 * 3) / 2;
  res.json({ user_info: { spend: user.used_credits / ratio, max_budget: user.total_credits / ratio, budget_reset_at: user.reset_date } });
});

app.get('/v1/update/:channel', (req, res) => res.status(204).end());

// ─── Auth API ─────────────────────────────────────────────────────────
app.post(['/api/login', '/api/auth/login'], async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = users[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
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

// Route requested by the Wiazart desktop app
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
      id: user.user_id,
      email: user.email,
      api_key: user.api_key,
      plan_id: user.plan_id,
      total_credits: user.total_credits,
      used_credits: user.used_credits,
      is_admin: !!user.is_admin
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

app.post(['/api/register', '/api/auth/register'], async (req, res) => {
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
app.post('/api/admin/providers', async (req, res) => {
  const { name, baseUrl, apiKey, modelName } = req.body;
  await pool.query('INSERT INTO ai_providers (name, base_url, api_key, model_name, is_active, created_at) VALUES (?, ?, ?, ?, 0, NOW())', [name, baseUrl, apiKey, modelName || '']);
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
app.get('/api/admin/users', async (req, res) => {
  const [users] = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
  res.json(users);
});
app.post('/api/admin/users', async (req, res) => {
  const { email, password, planId } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const userId = 'usr_' + crypto.randomBytes(4).toString('hex');
  const apiKey = generateApiKey();
  const credits = planId === 'pro' ? 10000 : planId === 'max' ? 50000 : 100;
  await pool.query('INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, reset_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())', 
    [email, hash, userId, apiKey, planId, credits, 0]);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: VERSION }));

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`\n  ✦ Wiazart Gateway v${VERSION}\n`));
});
