'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');

const COOKIE_NAME = 'propertyapp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_MAX = 8;
const fallbackAttempts = new Map();

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function explicitlyDisabled(value) {
  return /^(0|false|no|off)$/i.test(String(value || ''));
}

function getConfig() {
  const username = process.env.APP_AUTH_USER || '';
  const passwordHash = process.env.APP_AUTH_PASSWORD_HASH || '';
  const sessionSecret = process.env.APP_SESSION_SECRET || '';
  const configured = Boolean(sessionSecret && ((username && passwordHash) || hasDbUsers()));
  const envFlag = process.env.APP_AUTH_ENABLED;
  const enabled = explicitlyDisabled(envFlag)
    ? false
    : truthy(envFlag) || process.env.NODE_ENV === 'production' || configured;
  const registrationEnabled = enabled && configured && truthy(process.env.APP_REGISTRATION_ENABLED);
  return { enabled, configured, username, passwordHash, sessionSecret, registrationEnabled };
}

const RegistrationSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/),
    display_name: z.string().trim().min(1).max(120),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12).max(200),
  })
  .strict();

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function hasDbUsers() {
  if (!tableExists('users')) return false;
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    username: row.username,
    display_name: row.display_name || row.username,
    role: row.role || 'user',
    active: row.active !== 0,
    email: row.email || null,
    approval_status: row.approval_status || 'approved',
    session_version: Number(row.session_version || 1),
  };
}

function getDbUserByUsername(username) {
  if (!tableExists('users')) return null;
  return db
    .prepare(
      `
    SELECT id, username, display_name, email, approval_status, role, password_hash, active, session_version
    FROM users
    WHERE LOWER(username) = LOWER(?)
    LIMIT 1
  `,
    )
    .get(username);
}

function getDbUserById(id) {
  if (!tableExists('users') || !id) return null;
  return db
    .prepare(
      `
    SELECT id, username, display_name, email, approval_status, role, active, session_version
    FROM users
    WHERE id = ?
    LIMIT 1
  `,
    )
    .get(id);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createToken(user, secret) {
  const now = Date.now();
  const payload = base64url(
    JSON.stringify({
      id: user.id || null,
      u: user.username,
      role: user.role || 'user',
      name: user.display_name || user.username,
      sv: Number(user.session_version || 1),
      iat: now,
      exp: now + SESSION_TTL_MS,
    }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.u || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function isSecureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https' || truthy(process.env.APP_COOKIE_SECURE);
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  });
}

function safeNextPath(value) {
  if (typeof value !== 'string') return '/';
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '/';
  }
  if (!decoded.startsWith('/') || /^[/\\]{2}/.test(decoded)) return '/';
  try {
    const target = new URL(decoded, 'http://propertyapp.local');
    return target.origin === 'http://propertyapp.local'
      ? `${target.pathname}${target.search}${target.hash}`
      : '/';
  } catch {
    return '/';
  }
}

function clientKey(req, username) {
  return `${req.ip || req.socket.remoteAddress || 'local'}:${String(username || '').toLowerCase()}`;
}

function rateLimitKey(req, username) {
  return crypto.createHash('sha256').update(clientKey(req, username)).digest('hex');
}

function checkRateLimit(req, username) {
  const key = clientKey(req, username);
  const now = Date.now();
  if (tableExists('login_attempts')) {
    return db.transaction(() => {
      const keyHash = rateLimitKey(req, username);
      const cur = db.prepare('SELECT failures, reset_at FROM login_attempts WHERE key_hash = ?').get(keyHash);
      if (!cur || now > Number(cur.reset_at)) {
        db.prepare(
          `
          INSERT INTO login_attempts(key_hash, failures, reset_at, updated_at)
          VALUES (?, 1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key_hash) DO UPDATE SET
            failures = 1, reset_at = excluded.reset_at, updated_at = CURRENT_TIMESTAMP
        `,
        ).run(keyHash, now + LOGIN_LIMIT_WINDOW_MS);
        return true;
      }
      const failures = Number(cur.failures) + 1;
      db.prepare(
        'UPDATE login_attempts SET failures = ?, updated_at = CURRENT_TIMESTAMP WHERE key_hash = ?',
      ).run(failures, keyHash);
      return failures <= LOGIN_LIMIT_MAX;
    })();
  }
  const cur = fallbackAttempts.get(key);
  if (!cur || now > cur.resetAt) {
    fallbackAttempts.set(key, { count: 1, resetAt: now + LOGIN_LIMIT_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  return cur.count <= LOGIN_LIMIT_MAX;
}

function resetRateLimit(req, username) {
  if (tableExists('login_attempts')) {
    db.prepare('DELETE FROM login_attempts WHERE key_hash = ?').run(rateLimitKey(req, username));
    return;
  }
  fallbackAttempts.delete(clientKey(req, username));
}

function authStatus(req) {
  const config = getConfig();
  if (!config.enabled) return { enabled: false, configured: config.configured, user: null };
  if (!config.configured) return { enabled: true, configured: false, user: null };
  const cookies = parseCookies(req.headers.cookie);
  const session = verifyToken(cookies[COOKIE_NAME], config.sessionSecret);
  let user = null;
  if (session && session.id) {
    const row = getDbUserById(session.id);
    if (row && row.active !== 0 && Number(session.sv || 1) === Number(row.session_version || 1))
      user = publicUser(row);
  } else if (session && session.u) {
    const row = getDbUserByUsername(session.u);
    if (row && row.active !== 0 && Number(session.sv || 1) === Number(row.session_version || 1)) {
      user = publicUser(row);
    } else if (session.u === config.username) {
      user = { username: session.u, display_name: session.name || session.u, role: session.role || 'admin' };
    }
  }
  return {
    enabled: true,
    configured: true,
    user: user ? { ...user, expires_at: new Date(session.exp).toISOString() } : null,
  };
}

function requireAuth(req, res, next) {
  const status = authStatus(req);
  if (!status.enabled) return next();
  if (!status.configured) {
    return res.status(503).json({ error: 'auth_not_configured' });
  }
  if (!status.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = status.user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin_required' });
  }
  next();
}

function loginPage(req, res) {
  const status = authStatus(req);
  if (status.user) return res.redirect('/');
  const config = getConfig();
  const { renderLanding } = require('../views/landing');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.send(
    renderLanding({
      configMissing: status.enabled && !status.configured,
      registrationEnabled: config.registrationEnabled,
      encodedNext: encodeURIComponent(safeNextPath(req.query.next)),
      isLoginPath: req.path === '/login',
    }),
  );
}

function registrationPage(req, res) {
  const status = authStatus(req);
  if (status.user) return res.redirect('/');
  const { renderRegistration } = require('../views/landing');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.send(renderRegistration({ registrationEnabled: getConfig().registrationEnabled }));
}

function installAuth(app) {
  app.get('/login', loginPage);
  app.get('/register', registrationPage);
  app.get('/api/auth/me', (req, res) => res.json(authStatus(req)));
  app.post('/api/auth/register', (req, res) => {
    const config = getConfig();
    if (!config.registrationEnabled) return res.status(404).json({ error: 'registration_disabled' });
    if (!tableExists('users')) return res.status(503).json({ error: 'migration_required' });
    if (!checkRateLimit(req, '__registration__')) return res.status(429).json({ error: 'too_many_attempts' });
    const parsed = RegistrationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_registration' });
    const { username, display_name, email, password } = parsed.data;
    if (getDbUserByUsername(username) || username.toLowerCase() === config.username.toLowerCase()) {
      return res.status(409).json({ error: 'username_exists' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE LOWER(email) = ?').get(email)) {
      return res.status(409).json({ error: 'email_exists' });
    }
    try {
      const hash = bcrypt.hashSync(password, 12);
      db.prepare(
        `INSERT INTO users(username, display_name, email, role, password_hash, active, approval_status)
        VALUES (?, ?, ?, 'user', ?, 0, 'pending')`,
      ).run(username, display_name, email, hash);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'account_exists' });
      throw error;
    }
    res.status(201).json({ ok: true, approval_status: 'pending' });
  });
  app.post('/api/auth/login', async (req, res) => {
    const config = getConfig();
    if (!config.enabled) return res.json({ ok: true, disabled: true });
    if (!config.configured) return res.status(503).json({ error: 'auth_not_configured' });
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!checkRateLimit(req, username)) return res.status(429).json({ error: 'too_many_attempts' });
    let user = null;
    const dbUser = getDbUserByUsername(username);
    const dbPasswordValid = dbUser && (await bcrypt.compare(password, dbUser.password_hash));
    if (dbPasswordValid && dbUser.approval_status === 'pending') {
      return res.status(403).json({ error: 'account_pending' });
    }
    if (dbPasswordValid && dbUser.active !== 0 && dbUser.approval_status === 'approved') {
      db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(dbUser.id);
      user = publicUser(dbUser);
    } else if (
      !dbUser &&
      username === config.username &&
      (await bcrypt.compare(password, config.passwordHash))
    ) {
      user = { id: null, username, display_name: username, role: 'admin' };
    }
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    resetRateLimit(req, username);
    setSessionCookie(req, res, createToken(user, config.sessionSecret));
    res.json({ ok: true, user });
  });
  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
}

module.exports = {
  authStatus,
  clearSessionCookie,
  getConfig,
  installAuth,
  loginPage,
  requireAuth,
  requireAdmin,
  safeNextPath,
};
