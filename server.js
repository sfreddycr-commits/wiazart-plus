require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mysql = require('mysql2/promise');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wiazart-dashboard-secret-2026';

// ─── MySQL Pool ───────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || '172.17.0.1',
  port: 3306,
  user: process.env.DB_USER || 'wiazart',
  password: process.env.DB_PASS || 'wiazart123',
  database: process.env.DB_NAME || 'wiazart',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ─── Init DB Tables ────────────────────────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price INT NOT NULL DEFAULT 0,
        credits INT NOT NULL DEFAULT 0,
        features TEXT NOT NULL DEFAULT '[]',
        is_default INT NOT NULL DEFAULT 0
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        user_id VARCHAR(50) UNIQUE NOT NULL,
        api_key VARCHAR(100) UNIQUE NOT NULL,
        plan_id VARCHAR(50) NOT NULL DEFAULT 'free',
        total_credits INT NOT NULL DEFAULT 0,
        used_credits INT NOT NULL DEFAULT 0,
        is_admin INT NOT NULL DEFAULT 0,
        reset_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ai_providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model_name VARCHAR(100) NOT NULL DEFAULT '',
        is_active INT NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    const [planCount] = await conn.query('SELECT COUNT(*) as c FROM plans');
    if (planCount[0].c === 0) {
      await conn.query(`INSERT INTO plans (id, name, price, credits, features, is_default) VALUES ('free', 'Wiazart Free', 0, 0, '[]', 1)`);
      await conn.query(`INSERT INTO plans (id, name, price, credits, features, is_default) VALUES ('starter', 'Wiazart Starter', 29, 100, '[]', 0)`);
      await conn.query(`INSERT INTO plans (id, name, price, credits, features, is_default) VALUES ('pro', 'Wiazart Pro', 79, 500, '[]', 0)`);
      console.log('[Init] Planes creados');
    }

    const [userCount] = await conn.query('SELECT COUNT(*) as c FROM users WHERE email = ?', ['admin@wiazart.com']);
    if (userCount[0].c === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      const resetDate = new Date();
      resetDate.setMonth(resetDate.getMonth() + 1);
      await conn.query(`
        INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, is_admin, reset_date, created_at)
        VALUES (?, ?, 'admin', 'wiazart_master_2026', 'pro', 10000, 0, 1, ?, NOW())
      `, ['admin@wiazart.com', hash, resetDate.toISOString()]);
      console.log('[Init] Admin creado → admin@wiazart.com / admin123');
    }

    const [provCount] = await conn.query('SELECT COUNT(*) as c FROM ai_providers');
    if (provCount[0].c === 0) {
      await conn.query(`INSERT INTO ai_providers (name, base_url, api_key, model_name, is_active, created_at) VALUES ('MiniMax', 'https://api.minimax.io/v1', 'sk-•••', 'MiniMax-M2.7', 1, NOW())`);
      console.log('[Init] AI Provider creado');
    }
  } finally {
    conn.release();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────
const getPlan = async (planId) => {
  const [rows] = await pool.query('SELECT * FROM plans WHERE id = ?', [planId]);
  return rows[0];
};

// ─── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '50mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Page Routes ───────────────────────────────────────────────────────
const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', sendPage('index.html'));
app.get('/login', sendPage('login.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/dashboard', sendPage('user-dashboard.html'));
app.get('/checkout', sendPage('checkout.html'));

// ─── API: Plans ────────────────────────────────────────────────────────
app.get('/api/plans', async (req, res) => {
  try {
    const [plans] = await pool.query('SELECT * FROM plans ORDER BY price ASC');
    plans.forEach(p => { p.features = JSON.parse(p.features || '[]'); });
    res.json(plans);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Auth ─────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, planId } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos.' });

    const plan = await getPlan(planId || 'free');
    if (!plan) return res.status(400).json({ error: 'Plan inválido.' });

    const hash = await bcrypt.hash(password, 10);
    const userId = 'user_' + Math.random().toString(36).substring(2, 10);
    const apiKey = 'wiazart_' + Math.random().toString(36).substring(2, 18);
    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);

    await pool.query(`
      INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, is_admin, reset_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NOW())
    `, [email, hash, userId, apiKey, plan.id, plan.credits, resetDate.toISOString()]);

    const token = jwt.sign({ email, userId, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email, userId, planId: plan.id, planName: plan.name, isAdmin: false } });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esta cuenta ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
    const plan = await getPlan(user.plan_id);
    const token = jwt.sign({ email: user.email, userId: user.user_id, isAdmin: Boolean(user.is_admin) }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email: user.email, userId: user.user_id, planId: user.plan_id, planName: plan?.name, isAdmin: Boolean(user.is_admin) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Desktop App ─────────────────────────────────────────────────
app.get('/v1/user/info', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ code: 'auth_required', message: 'Falta API key.' });
  const apiKey = auth.split(' ')[1];
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  const user = users[0];
  if (!user) return res.status(403).json({ code: 'invalid_key', message: 'API key inválida.' });
  res.json({ userId: user.user_id, usedCredits: user.used_credits, totalCredits: user.total_credits, budgetResetDate: user.reset_date, isTrial: user.plan_id === 'free' });
});

// ─── API: Admin ───────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.email, u.user_id, u.api_key, u.plan_id, p.name as plan_name,
             u.total_credits, u.used_credits, u.is_admin, u.reset_date, u.created_at
      FROM users u LEFT JOIN plans p ON u.plan_id = p.id ORDER BY u.created_at DESC
    `);
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', async (req, res) => {
  try {
    const { email, password, planId } = req.body;
    const plan = await getPlan(planId || 'free');
    const hash = await bcrypt.hash(password || 'user123', 10);
    const userId = 'user_' + Math.random().toString(36).substring(2, 10);
    const apiKey = 'wiazart_' + Math.random().toString(36).substring(2, 18);
    const resetDate = new Date();
    resetDate.setMonth(resetDate.getMonth() + 1);
    await pool.query(`
      INSERT INTO users (email, password_hash, user_id, api_key, plan_id, total_credits, used_credits, is_admin, reset_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NOW())
    `, [email, hash, userId, apiKey, plan.id, plan.credits, resetDate.toISOString()]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = ? AND is_admin = 0', [req.params.id]);
  res.json({ success: true });
});

app.put('/api/admin/users/:id', async (req, res) => {
  const { planId, totalCredits } = req.body;
  const plan = await getPlan(planId);
  if (!plan) return res.status(400).json({ error: 'Plan inválido.' });
  await pool.query('UPDATE users SET plan_id = ?, total_credits = ? WHERE id = ?', [planId, totalCredits ?? plan.credits, req.params.id]);
  res.json({ success: true });
});

// ─── API: User Profile ───────────────────────────────────────────────
app.get('/api/user/profile', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    const [users] = await pool.query(`SELECT u.*, p.name as plan_name, p.price as plan_price FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.email = ?`, [decoded.email]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ email: user.email, userId: user.user_id, apiKey: user.api_key, planId: user.plan_id, planName: user.plan_name, planPrice: user.plan_price, totalCredits: user.total_credits, usedCredits: user.used_credits, resetDate: user.reset_date });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// ─── API: AI Providers (Admin) ───────────────────────────────────────
app.get('/api/admin/providers', async (req, res) => {
  const [providers] = await pool.query('SELECT * FROM ai_providers ORDER BY created_at DESC');
  res.json(providers);
});

app.post('/api/admin/providers', async (req, res) => {
  const { name, baseUrl, apiKey, modelName } = req.body;
  if (!name || !baseUrl || !apiKey) return res.status(400).json({ error: 'Nombre, URL y API key requeridos.' });
  await pool.query(`INSERT INTO ai_providers (name, base_url, api_key, model_name, is_active, created_at) VALUES (?, ?, ?, ?, 0, NOW())`, [name, baseUrl, apiKey, modelName || '']);
  res.json({ success: true });
});

app.delete('/api/admin/providers/:id', async (req, res) => {
  await pool.query('DELETE FROM ai_providers WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/admin/providers/:id/activate', async (req, res) => {
  await pool.query('UPDATE ai_providers SET is_active = 0');
  await pool.query('UPDATE ai_providers SET is_active = 1 WHERE id = ?', [req.params.id]);
  const [[prov]] = await pool.query('SELECT name FROM ai_providers WHERE id = ?', [req.params.id]);
  console.log(`[AI] Provider activo: ${prov?.name}`);
  res.json({ success: true });
});

// ─── AI PROXY ─────────────────────────────────────────────────────────
const proxyToActiveProvider = async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const apiKey = auth.split(' ')[1];
  const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
  const user = users[0];
  if (!user) return res.status(403).json({ error: 'API key inválida.' });

  const [[provider]] = await pool.query('SELECT * FROM ai_providers WHERE is_active = 1');
  if (!provider) return res.status(503).json({ error: 'No hay AI provider activo.' });

  const subPath = req.path.replace(/^\/v1/, '');
  const targetUrl = `${provider.base_url.replace(/\/$/, '')}${subPath}`;

  try {
    let body = req.body;
    if (provider.model_name && typeof body === 'object' && body.model) body.model = provider.model_name;
    const proxyRes = await fetch(targetUrl, { method: req.method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.api_key}` }, body: JSON.stringify(body) });
    await pool.query('UPDATE users SET used_credits = used_credits + 1 WHERE id = ?', [user.id]);
    const contentType = proxyRes.headers.get('content-type') || '';
    res.status(proxyRes.status);
    if (contentType.includes('text/event-stream') || req.body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder();
      const pump = async () => { while (true) { const { done, value } = await reader.read(); if (done) { res.end(); break; } res.write(decoder.decode(value, { stream: true })); } };
      pump().catch(err => { console.error('[Proxy] Stream error:', err); res.end(); });
    } else {
      const data = await proxyRes.text();
      res.setHeader('Content-Type', contentType);
      res.send(data);
    }
  } catch (err) { console.error('[Proxy] Error:', err.message); res.status(502).json({ error: 'Error al conectar con el AI provider.', details: err.message }); }
};

app.post('/v1/chat/completions', proxyToActiveProvider);
app.post('/v1/responses', proxyToActiveProvider);
app.post('/v1/images/generations', proxyToActiveProvider);
app.post('/v1/audio/transcriptions', proxyToActiveProvider);

app.use('/v1', async (req, res) => {
  const targetUrl = `https://api.dyad.sh/v1${req.path}`;
  try {
    const proxyRes = await fetch(targetUrl, { method: req.method, headers: { ...req.headers, host: 'api.dyad.sh' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body });
    const contentType = proxyRes.headers.get('content-type') || '';
    res.status(proxyRes.status); res.setHeader('Content-Type', contentType);
    res.send(await proxyRes.text());
  } catch (err) { res.status(502).json({ error: 'Proxy error', details: err.message }); }
});

app.use('/health', async (req, res) => {
  try {
    const proxyRes = await fetch('https://api.dyad.sh/health');
    res.status(proxyRes.status).send(await proxyRes.text());
  } catch { res.status(200).send('OK'); }
});

// ─── Start ───────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`\n  ✦ Wiazart Dashboard → http://0.0.0.0:${PORT}\n`));
}).catch(e => { console.error('[Init] Error:', e); process.exit(1); });
