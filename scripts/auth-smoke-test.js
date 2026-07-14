#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-auth-'));
const dbFile = path.join(tmpDir, 'property.db');
const port = Number(process.env.TEST_PORT || 8192);
const base = `http://127.0.0.1:${port}`;
const authHash = bcrypt.hashSync('secret-pass', 10);
let serverProc = null;

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_FILE: dbFile,
      NODE_ENV: 'test',
      APP_AUTH_USER: 'admin',
      APP_AUTH_PASSWORD_HASH: authHash,
      APP_SESSION_SECRET: 'test-secret-for-auth-smoke-with-enough-length',
    },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${script} failed\n${r.stdout}\n${r.stderr}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function legacyToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    iat: Date.now(),
    exp: Date.now() + 60_000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'test-secret-for-auth-smoke-with-enough-length')
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

async function startServer() {
  serverProc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_FILE: dbFile,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      APP_AUTH_ENABLED: '1',
      APP_AUTH_USER: 'admin',
      APP_AUTH_PASSWORD_HASH: authHash,
      APP_SESSION_SECRET: 'test-secret-for-auth-smoke-with-enough-length',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGINT');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      serverProc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main() {
  runNode('scripts/migrate.js');
  await startServer();

  const root = await fetch(base + '/', { redirect: 'manual' });
  expect(root.status === 302, `expected redirect to login, got ${root.status}`);
  expect((root.headers.get('location') || '').startsWith('/login'), 'missing login redirect');

  for (const unsafe of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/%5C%5Cevil.example']) {
    const login = await fetch(base + `/login?next=${encodeURIComponent(unsafe)}`);
    const html = await login.text();
    expect(login.ok && html.includes('location.href="/"'), `login page retained unsafe next redirect: ${unsafe}`);
  }

  const blocked = await fetch(base + '/api/dashboard');
  expect(blocked.status === 401, `expected unauthorized API, got ${blocked.status}`);

  const bad = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'bad' }),
  });
  expect(bad.status === 401, `expected bad login 401, got ${bad.status}`);

  const good = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret-pass' }),
  });
  expect(good.ok, `expected login ok, got ${good.status}`);
  let cookie = good.headers.get('set-cookie');
  expect(cookie && cookie.includes('propertyapp_session='), 'missing session cookie');

  const app = await fetch(base + '/', { headers: { Cookie: cookie } });
  const html = await app.text();
  expect(app.ok && html.includes('PropertyApp'), 'authenticated app shell did not render');

  const api = await fetch(base + '/api/dashboard', { headers: { Cookie: cookie } });
  expect(api.ok, `authenticated API failed: ${api.status}`);

  const pdf = await fetch(base + '/api/export/report.pdf?period=2026-05', { headers: { Cookie: cookie } });
  expect(pdf.ok, `authenticated PDF export failed: ${pdf.status}`);
  expect((pdf.headers.get('content-type') || '').includes('application/pdf'), 'PDF export returned wrong content type');
  expect((pdf.headers.get('cache-control') || '').includes('no-store'), 'PDF export is cacheable');
  const pdfBytes = await pdf.arrayBuffer();
  expect(pdfBytes.byteLength > 10_000, `PDF export too small, fonts may not be embedded: ${pdfBytes.byteLength} bytes`);

  const adminSettingsSeed = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'tax.rate': '8.5' }),
  });
  expect(adminSettingsSeed.ok, `admin settings write failed: ${adminSettingsSeed.status}`);

  const legacyChange = await fetch(base + '/api/admin/change-password', {
    method: 'POST',
    headers: {
      Cookie: `propertyapp_session=${legacyToken('admin')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ current_password: 'secret-pass', new_password: 'secret-pass' }),
  });
  expect(legacyChange.ok, `legacy session password change failed: ${legacyChange.status}`);

  const staleSession = await fetch(base + '/api/admin/users', { headers: { Cookie: cookie } });
  expect(staleSession.status === 401, `password change did not invalidate the previous session: ${staleSession.status}`);
  const freshLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret-pass' }),
  });
  expect(freshLogin.ok, `re-login after password change failed: ${freshLogin.status}`);
  cookie = freshLogin.headers.get('set-cookie');

  const users = await fetch(base + '/api/admin/users', { headers: { Cookie: cookie } });
  expect(users.ok, `admin users list failed: ${users.status}`);

  const adminProperty = await fetch(base + '/api/properties', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin Property', type: 'mieszkanie' }),
  });
  expect(adminProperty.status === 201, `admin property failed: ${adminProperty.status}`);
  const adminPropertyId = (await adminProperty.json()).id;

  const createUser = await fetch(base + '/api/admin/users', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', display_name: 'Tester', role: 'user', password: 'secret-pass-2' }),
  });
  expect(createUser.status === 201, `admin create user failed: ${createUser.status}`);
  const createdUser = await createUser.json();

  const userLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'secret-pass-2' }),
  });
  expect(userLogin.ok, `user login failed: ${userLogin.status}`);
  const userCookie = userLogin.headers.get('set-cookie');
  expect(userCookie && userCookie.includes('propertyapp_session='), 'missing user session cookie');

  const hiddenAdminProperty = await fetch(base + `/api/properties/${adminPropertyId}`, { headers: { Cookie: userCookie } });
  expect(hiddenAdminProperty.status === 404, `user can see admin property: ${hiddenAdminProperty.status}`);

  const userProperty = await fetch(base + '/api/properties', {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'User Property', type: 'mieszkanie' }),
  });
  expect(userProperty.status === 201, `user property failed: ${userProperty.status}`);
  const userPropertyId = (await userProperty.json()).id;

  const userProperties = await fetch(base + '/api/properties', { headers: { Cookie: userCookie } });
  const visibleProperties = await userProperties.json();
  expect(visibleProperties.length === 1 && visibleProperties[0].id === userPropertyId, 'user property list is not isolated');

  const forbiddenUnit = await fetch(base + '/api/units', {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: adminPropertyId, name: 'Hidden Unit', status: 'vacant' }),
  });
  expect(forbiddenUnit.status === 404, `user created unit in admin property: ${forbiddenUnit.status}`);

  const userSettings = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'tax.rate': '12.34' }),
  });
  expect(userSettings.ok, `user settings write failed: ${userSettings.status}`);
  const userSettingsRead = await fetch(base + '/api/settings', { headers: { Cookie: userCookie } });
  expect((await userSettingsRead.json())['tax.rate'] === '12.34', 'user setting override missing');
  const adminSettingsRead = await fetch(base + '/api/settings', { headers: { Cookie: cookie } });
  expect((await adminSettingsRead.json())['tax.rate'] === '8.5', 'user setting leaked into global settings');

  const editUser = await fetch(base + `/api/admin/users/${createdUser.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  expect(editUser.ok, `admin edit user failed: ${editUser.status}`);

  const logout = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  expect(logout.ok && (logout.headers.get('set-cookie') || '').includes('propertyapp_session='), 'logout did not clear cookie');

  console.log('Auth smoke test OK');
}

main()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => stopServer());
