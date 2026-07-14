'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
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
    : (truthy(envFlag) || process.env.NODE_ENV === 'production' || configured);
  return { enabled, configured, username, passwordHash, sessionSecret };
}

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
    session_version: Number(row.session_version || 1),
  };
}

function getDbUserByUsername(username) {
  if (!tableExists('users')) return null;
  return db.prepare(`
    SELECT id, username, display_name, role, password_hash, active, session_version
    FROM users
    WHERE LOWER(username) = LOWER(?)
    LIMIT 1
  `).get(username);
}

function getDbUserById(id) {
  if (!tableExists('users') || !id) return null;
  return db.prepare(`
    SELECT id, username, display_name, role, active, session_version
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(id);
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
  const payload = base64url(JSON.stringify({
    id: user.id || null,
    u: user.username,
    role: user.role || 'user',
    name: user.display_name || user.username,
    sv: Number(user.session_version || 1),
    iat: now,
    exp: now + SESSION_TTL_MS,
  }));
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
  try { decoded = decodeURIComponent(value); } catch { return '/'; }
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
        db.prepare(`
          INSERT INTO login_attempts(key_hash, failures, reset_at, updated_at)
          VALUES (?, 1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key_hash) DO UPDATE SET
            failures = 1, reset_at = excluded.reset_at, updated_at = CURRENT_TIMESTAMP
        `).run(keyHash, now + LOGIN_LIMIT_WINDOW_MS);
        return true;
      }
      const failures = Number(cur.failures) + 1;
      db.prepare('UPDATE login_attempts SET failures = ?, updated_at = CURRENT_TIMESTAMP WHERE key_hash = ?').run(failures, keyHash);
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
    if (row && row.active !== 0 && Number(session.sv || 1) === Number(row.session_version || 1)) user = publicUser(row);
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
  const configMissing = status.enabled && !status.configured;
  const safeNext = safeNextPath(req.query.next);
  const encodedNext = encodeURIComponent(safeNext);
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.send(`<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Logowanie - PropertyApp</title>
<style>
:root{--bg:#070714;--surface:rgba(255,255,255,.055);--border:rgba(255,255,255,.12);--t1:#eeeeff;--t2:#aaaad8;--t3:#6c6c98;--violet:#8b5cf6;--cyan:#06b6d4;--rose:#f43f5e}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--t1);background:radial-gradient(circle at 18% 12%,rgba(139,92,246,.22),transparent 34%),radial-gradient(circle at 82% 78%,rgba(6,182,212,.14),transparent 32%),var(--bg);display:grid;place-items:center;padding:22px}
.card{width:min(420px,100%);background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:0 28px 80px rgba(0,0,0,.45);backdrop-filter:blur(18px);overflow:hidden}
.head{padding:28px 28px 18px}.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--violet),var(--cyan));display:grid;place-items:center;margin-bottom:18px}
.logo svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:2}.title{font-size:24px;font-weight:800;letter-spacing:-.02em}.sub{margin-top:6px;color:var(--t3);font-size:14px}
form{padding:8px 28px 28px;display:flex;flex-direction:column;gap:14px}label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);font-weight:700}
input{width:100%;margin-top:6px;padding:13px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--t1);font-size:15px;outline:none}
input:focus{border-color:var(--violet);box-shadow:0 0 0 3px rgba(139,92,246,.22)}button{height:44px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--violet),#6d28d9);color:white;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 12px 30px rgba(139,92,246,.28)}
button:disabled{opacity:.55;cursor:not-allowed}.err{display:none;color:#fecdd3;background:rgba(244,63,94,.13);border:1px solid rgba(244,63,94,.28);border-radius:12px;padding:10px 12px;font-size:13px}.err.on{display:block}
.foot{padding:14px 28px 24px;color:var(--t3);font-size:12px;border-top:1px solid rgba(255,255,255,.06)}
</style>
</head>
<body>
<main class="card">
  <div class="head">
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>
    <div class="title">PropertyApp</div>
    <div class="sub">${configMissing ? 'Logowanie wymaga konfiguracji na serwerze.' : 'Zaloguj się do panelu zarządzania najmem.'}</div>
  </div>
  <form id="login-form" data-next="${encodedNext}">
    <div class="err${configMissing ? ' on' : ''}" id="login-error">${configMissing ? 'Brakuje APP_AUTH_USER, APP_AUTH_PASSWORD_HASH albo APP_SESSION_SECRET.' : ''}</div>
    <div><label>Login<input name="username" autocomplete="username" ${configMissing ? 'disabled' : ''}></label></div>
    <div><label>Hasło<input name="password" type="password" autocomplete="current-password" ${configMissing ? 'disabled' : ''}></label></div>
    <button type="submit" ${configMissing ? 'disabled' : ''}>Zaloguj</button>
  </form>
  <div class="foot">Sesja jest zapisywana w bezpiecznym ciasteczku httpOnly.</div>
</main>
<script src="/login.js"></script>
</body>
</html>`);
}

function installAuth(app) {
  app.get('/login', loginPage);
  app.get('/api/auth/me', (req, res) => res.json(authStatus(req)));
  app.post('/api/auth/login', async (req, res) => {
    const config = getConfig();
    if (!config.enabled) return res.json({ ok: true, disabled: true });
    if (!config.configured) return res.status(503).json({ error: 'auth_not_configured' });
    const username = String(req.body && req.body.username || '').trim();
    const password = String(req.body && req.body.password || '');
    if (!checkRateLimit(req, username)) return res.status(429).json({ error: 'too_many_attempts' });
    let user = null;
    const dbUser = getDbUserByUsername(username);
    if (dbUser && dbUser.active !== 0 && await bcrypt.compare(password, dbUser.password_hash)) {
      db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(dbUser.id);
      user = publicUser(dbUser);
    } else if (!dbUser && username === config.username && await bcrypt.compare(password, config.passwordHash)) {
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
