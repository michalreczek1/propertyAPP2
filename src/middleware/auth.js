'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'propertyapp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_MAX = 8;
const attempts = new Map();

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
  const configured = Boolean(username && passwordHash && sessionSecret);
  const envFlag = process.env.APP_AUTH_ENABLED;
  const enabled = explicitlyDisabled(envFlag)
    ? false
    : (truthy(envFlag) || process.env.NODE_ENV === 'production' || configured);
  return { enabled, configured, username, passwordHash, sessionSecret };
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

function createToken(username, secret) {
  const now = Date.now();
  const payload = base64url(JSON.stringify({ u: username, iat: now, exp: now + SESSION_TTL_MS }));
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

function clientKey(req, username) {
  return `${req.ip || req.socket.remoteAddress || 'local'}:${String(username || '').toLowerCase()}`;
}

function checkRateLimit(req, username) {
  const key = clientKey(req, username);
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || now > cur.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_LIMIT_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  return cur.count <= LOGIN_LIMIT_MAX;
}

function resetRateLimit(req, username) {
  attempts.delete(clientKey(req, username));
}

function authStatus(req) {
  const config = getConfig();
  if (!config.enabled) return { enabled: false, configured: config.configured, user: null };
  if (!config.configured) return { enabled: true, configured: false, user: null };
  const cookies = parseCookies(req.headers.cookie);
  const session = verifyToken(cookies[COOKIE_NAME], config.sessionSecret);
  return {
    enabled: true,
    configured: true,
    user: session ? { username: session.u, expires_at: new Date(session.exp).toISOString() } : null,
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

function loginPage(req, res) {
  const status = authStatus(req);
  if (status.user) return res.redirect('/');
  const configMissing = status.enabled && !status.configured;
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
  <form id="login-form">
    <div class="err${configMissing ? ' on' : ''}" id="login-error">${configMissing ? 'Brakuje APP_AUTH_USER, APP_AUTH_PASSWORD_HASH albo APP_SESSION_SECRET.' : ''}</div>
    <div><label>Login<input name="username" autocomplete="username" ${configMissing ? 'disabled' : ''}></label></div>
    <div><label>Hasło<input name="password" type="password" autocomplete="current-password" ${configMissing ? 'disabled' : ''}></label></div>
    <button type="submit" ${configMissing ? 'disabled' : ''}>Zaloguj</button>
  </form>
  <div class="foot">Sesja jest zapisywana w bezpiecznym ciasteczku httpOnly.</div>
</main>
<script>
const form=document.getElementById('login-form'),err=document.getElementById('login-error');
form.addEventListener('submit',async e=>{
  e.preventDefault(); err.className='err'; err.textContent='';
  const btn=form.querySelector('button'); btn.disabled=true;
  try{
    const body=Object.fromEntries(new FormData(form).entries());
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error==='invalid_credentials'?'Nieprawidłowy login lub hasło.':data.error||'Błąd logowania');
    const params=new URLSearchParams(location.search);
    location.href=params.get('next')||'/';
  }catch(ex){err.textContent=ex.message;err.className='err on';btn.disabled=false;}
});
</script>
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
    const username = String(req.body && req.body.username || '');
    const password = String(req.body && req.body.password || '');
    if (!checkRateLimit(req, username)) return res.status(429).json({ error: 'too_many_attempts' });
    const validUser = username === config.username;
    const validPass = validUser && await bcrypt.compare(password, config.passwordHash);
    if (!validPass) return res.status(401).json({ error: 'invalid_credentials' });
    resetRateLimit(req, username);
    setSessionCookie(req, res, createToken(username, config.sessionSecret));
    res.json({ ok: true, user: { username } });
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
};
