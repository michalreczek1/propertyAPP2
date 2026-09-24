#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { chromium } = require('@playwright/test');
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
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', 'test-secret-for-auth-smoke-with-enough-length')
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
      APP_REGISTRATION_ENABLED: '1',
      AUTH_TEST_MODE: '1',
      SMSPLANET_TOKEN: 'server-private-test-token',
      GROQ_API_KEY: 'server-private-test-key',
      APP_AUTH_USER: 'admin',
      APP_AUTH_PASSWORD_HASH: authHash,
      APP_SESSION_SECRET: 'test-secret-for-auth-smoke-with-enough-length',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGINT');
    await new Promise((resolve) => {
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
  const rootHtml = await root.text();
  expect(root.status === 200, `expected public landing page, got ${root.status}`);
  expect(
    rootHtml.includes('<h1 id="hero-title">') && rootHtml.includes('Nieruchomości i lokale'),
    'landing page is missing product information',
  );
  expect(
    rootHtml.includes('<meta name="description"') && rootHtml.includes('content="index,follow"'),
    'landing page SEO metadata missing',
  );
  expect(
    rootHtml.includes('id="podglad"') && rootHtml.includes('Na dashboardzie od razu sprawdzisz'),
    'dashboard preview section missing',
  );
  expect(
    rootHtml.indexOf('id="jak-to-dziala"') < rootHtml.indexOf('id="podglad"') &&
      rootHtml.indexOf('id="podglad"') < rootHtml.indexOf('id="pytania"'),
    'dashboard preview is not before the FAQ',
  );
  const preview = await fetch(base + '/dashboard-preview.png');
  expect(
    preview.ok && (preview.headers.get('content-type') || '').includes('image/png'),
    'public dashboard preview missing',
  );
  const robots = await fetch(base + '/robots.txt');
  expect(robots.ok && (await robots.text()).includes('Sitemap:'), 'robots.txt missing');
  const sitemap = await fetch(base + '/sitemap.xml');
  expect(sitemap.ok && (await sitemap.text()).includes('propertyapp.familyos.pl/'), 'sitemap missing');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(base + '/');
    await page.locator('#hero-title').waitFor();
    const previewImage = page.locator('.preview-trigger img');
    await previewImage.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const img = document.querySelector('.preview-trigger img');
      return img?.complete && img.naturalWidth > 0;
    });
    expect(
      await previewImage.evaluate((img) => img.complete && img.naturalWidth > 0),
      'dashboard preview image did not load',
    );
    await page.locator('#preview-open').click();
    expect(await page.locator('#dashboard-dialog').isVisible(), 'dashboard popup did not open');
    expect(
      await page.locator('.preview-dialog-scroll').evaluate((el) => el.scrollWidth > el.clientWidth),
      'mobile dashboard popup cannot be panned',
    );
    await page.keyboard.press('Escape');
    expect(!(await page.locator('#dashboard-dialog').isVisible()), 'Escape did not close dashboard popup');
    await page.locator('#hero-title').scrollIntoViewIfNeeded();
    expect(await page.locator('#hero-title').isVisible(), 'landing hero is not visible on mobile');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'landing page overflows mobile viewport',
    );
    await page.locator('.hero-actions .primary-link').click();
    expect(page.url().endsWith('/register'), 'sign-up button did not open registration page');
    expect(await page.locator('#register-form').isVisible(), 'registration form cannot be opened');
    expect(await page.locator('input[name="email"]').isVisible(), 'email field is missing');
    const registerCard = await page.locator('.register-page .account-card').boundingBox();
    expect(registerCard && registerCard.width <= 480, 'registration card is too wide');
    expect(
      await page.locator('.brand-mark').evaluate((img) => img.complete && img.naturalWidth > 0),
      'FamilyOS PropertyApp logo is missing',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'registration page overflows mobile viewport',
    );
    await page.locator('#register-form input[name="display_name"]').fill('UI owner');
    await page.locator('#register-form input[name="username"]').fill('ui_owner');
    await page.locator('#register-form input[name="email"]').fill('ui-owner@example.test');
    await page.locator('#register-form input[name="password"]').fill('a-long-ui-password');
    await page.locator('#register-form').evaluate((form) => {
      const token = document.createElement('input');
      token.type = 'hidden';
      token.name = 'cf-turnstile-response';
      token.value = 'test-turnstile';
      form.append(token);
    });
    await page.locator('#register-form button').click();
    await page.waitForURL('**/verify-email?email=ui-owner%40example.test');
    await page.locator('#verify-form input[name="code"]').fill('123456');
    await page.locator('#verify-form button').click();
    await page.locator('#verify-success').waitFor({ state: 'visible' });
    expect(
      await page.locator('#verify-success').isVisible(),
      `browser email verification failed: ${await page.locator('#verify-error').textContent()}`,
    );
    await page.goto(base + '/forgot-password');
    await page.locator('#forgot-form input[name="email"]').fill('ui-owner@example.test');
    await page.locator('#forgot-form').evaluate((form) => {
      const token = document.createElement('input');
      token.type = 'hidden';
      token.name = 'cf-turnstile-response';
      token.value = 'test-turnstile';
      form.append(token);
    });
    await page.locator('#forgot-form button').click();
    await page.locator('#forgot-success').waitFor({ state: 'visible' });
    expect(await page.locator('#forgot-success').isVisible(), 'browser reset code request failed');
    await page.locator('#reset-form input[name="code"]').fill('123456');
    await page.locator('#reset-form input[name="password"]').fill('a-new-ui-password');
    await page.locator('#reset-form button').click();
    await page.locator('#reset-success').waitFor({ state: 'visible' });
    expect(await page.locator('#reset-success').isVisible(), 'browser password reset failed');
    await page.goto(base + '/');
    await page.setViewportSize({ width: 1440, height: 900 });
    const thumbnail = await page.locator('.dashboard-preview').boundingBox();
    const previewCopy = await page.locator('.preview-section .section-heading').boundingBox();
    expect(thumbnail && thumbnail.width <= 600, 'dashboard thumbnail is too wide');
    expect(
      previewCopy && previewCopy.x + previewCopy.width < thumbnail.x,
      'dashboard description is not left of the thumbnail',
    );
    await page.locator('#preview-open').click();
    const popup = await page.locator('#dashboard-dialog').boundingBox();
    expect(popup && popup.width > thumbnail.width, 'dashboard popup is not larger than thumbnail');
    await page.locator('#preview-close').click();
    expect(
      !(await page.locator('#dashboard-dialog').isVisible()),
      'close button did not close dashboard popup',
    );
    const heroBox = await page.locator('.hero-copy').boundingBox();
    const accountBox = await page.locator('.account-card').boundingBox();
    expect(heroBox && accountBox && accountBox.x > heroBox.x, 'desktop landing layout is broken');
  } finally {
    await browser.close();
  }

  for (const unsafe of [
    'https://evil.example',
    '//evil.example',
    'javascript:alert(1)',
    '/%5C%5Cevil.example',
  ]) {
    const login = await fetch(base + `/login?next=${encodeURIComponent(unsafe)}`);
    const html = await login.text();
    expect(
      login.ok && html.includes('data-next="%2F"'),
      `login page retained unsafe next redirect: ${unsafe}`,
    );
    expect(
      html.includes('<script src="/login.js?v=') && !html.includes('<script>'),
      'login page still contains inline JavaScript',
    );
    expect(html.includes('content="noindex,follow"'), 'duplicate login URL is indexable');
  }
  const loginScript = await fetch(base + '/login.js');
  expect(
    loginScript.ok && (loginScript.headers.get('content-type') || '').includes('javascript'),
    'login JavaScript is not publicly available',
  );

  const blocked = await fetch(base + '/api/dashboard');
  expect(blocked.status === 401, `expected unauthorized API, got ${blocked.status}`);

  const botRegistration = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'bot_owner',
      display_name: 'Bot owner',
      email: 'bot-owner@example.test',
      password: 'a-long-test-password',
      captcha_token: 'invalid',
    }),
  });
  expect(botRegistration.status === 400, 'invalid Turnstile token was accepted');

  const register = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'self_registered',
      display_name: 'New owner',
      email: 'new-owner@example.test',
      password: 'a-long-test-password',
      captcha_token: 'test-turnstile',
    }),
  });
  expect(register.status === 201, `registration failed: ${register.status}`);
  const registered = await register.json();
  expect(registered.approval_status === 'pending', 'registration must wait for email verification');
  expect(!register.headers.get('set-cookie'), 'pending registration received a session');
  const anonymousApproval = await fetch(base + '/api/admin/users/1/approve', { method: 'POST' });
  expect(anonymousApproval.status === 401, 'anonymous user could approve an account');
  const pendingLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'self_registered', password: 'a-long-test-password' }),
  });
  expect(
    pendingLogin.status === 403 && (await pendingLogin.json()).error === 'account_pending',
    'pending user could log in',
  );
  const adminLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret-pass' }),
  });
  const adminCookie = adminLogin.headers.get('set-cookie');
  const pendingUsers = await (
    await fetch(base + '/api/admin/users', { headers: { Cookie: adminCookie } })
  ).json();
  const pendingUser = pendingUsers.find((user) => user.username === 'self_registered');
  expect(
    pendingUser && pendingUser.email === 'new-owner@example.test' && pendingUser.active === 0,
    'pending account missing from admin list',
  );
  const badCode = await fetch(base + '/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new-owner@example.test', code: '000000' }),
  });
  expect(badCode.status === 400, 'invalid verification code was accepted');
  const verify = await fetch(base + '/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new-owner@example.test', code: '123456' }),
  });
  expect(verify.ok, 'valid email code did not activate account');
  const verifiedUsers = await (
    await fetch(base + '/api/admin/users', { headers: { Cookie: adminCookie } })
  ).json();
  expect(verifiedUsers.find((u) => u.id === pendingUser.id)?.active === 1, 'verified account inactive');
  const registeredLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'self_registered', password: 'a-long-test-password' }),
  });
  expect(registeredLogin.ok, 'approved user could not log in');
  let registerCookie = registeredLogin.headers.get('set-cookie');
  registered.user = { id: pendingUser.id };
  const duplicate = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'SELF_REGISTERED',
      display_name: 'Duplicate',
      email: 'different@example.test',
      password: 'a-long-test-password',
      captcha_token: 'test-turnstile',
    }),
  });
  expect(duplicate.status === 409, 'case-insensitive duplicate registration was allowed');
  const duplicateEmail = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'another_owner',
      display_name: 'Duplicate email',
      email: 'NEW-OWNER@example.test',
      password: 'a-long-test-password',
      captcha_token: 'test-turnstile',
    }),
  });
  expect(duplicateEmail.status === 409, 'case-insensitive duplicate email was allowed');
  const forgot = await fetch(base + '/api/auth/password/forgot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new-owner@example.test', captcha_token: 'test-turnstile' }),
  });
  expect(forgot.ok, 'password reset code request failed');
  const reset = await fetch(base + '/api/auth/password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'new-owner@example.test',
      code: '123456',
      password: 'a-new-long-password',
    }),
  });
  expect(reset.ok, 'valid reset code did not change password');
  const reusedReset = await fetch(base + '/api/auth/password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'new-owner@example.test',
      code: '123456',
      password: 'another-long-password',
    }),
  });
  expect(reusedReset.status === 400, 'reset code was reusable');
  const oldLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'self_registered', password: 'a-long-test-password' }),
  });
  expect(oldLogin.status === 401, 'old password still works');
  const newLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'self_registered', password: 'a-new-long-password' }),
  });
  expect(newLogin.ok, 'new password does not work');
  const expiredByReset = await fetch(base + '/api/auth/me', { headers: { Cookie: registerCookie } });
  expect(!(await expiredByReset.json()).user, 'old session remained valid after password reset');
  registerCookie = newLogin.headers.get('set-cookie');
  const deniedAdmin = await fetch(base + '/api/admin/users', { headers: { Cookie: registerCookie } });
  expect(deniedAdmin.status === 403, 'registered user can access admin API');
  const noSharedSms = await fetch(base + '/api/notifications/settings', {
    headers: { Cookie: registerCookie },
  });
  expect(!(await noSharedSms.json()).token_configured, 'registered user inherited server SMS token');
  const noSharedCredential = await fetch(base + '/api/notifications/credential', {
    headers: { Cookie: registerCookie },
  });
  expect(!(await noSharedCredential.json()).configured, 'registered user inherited SMS credential');
  const smsWithoutToken = await fetch(base + '/api/notifications/test', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '501123456', message: 'Test' }),
  });
  expect((await smsWithoutToken.json()).error === 'smsplanet_token_required', 'server SMS token was used');
  const saveSmsToken = await fetch(base + '/api/notifications/credential', {
    method: 'PUT',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'this-is-a-user-owned-test-token' }),
  });
  expect(saveSmsToken.ok, 'user cannot save own SMS token');
  const credentialStatus = await fetch(base + '/api/notifications/credential', {
    headers: { Cookie: registerCookie },
  });
  const credentialBody = await credentialStatus.text();
  expect(
    credentialBody.includes('"configured":true') && !credentialBody.includes('test-token'),
    'SMS token leaked in credential status',
  );
  const inspectDb = new Database(dbFile, { readonly: true });
  const storedToken = inspectDb
    .prepare('SELECT ciphertext FROM user_secrets WHERE owner_user_id = ? AND name = ?')
    .get(registered.user.id, 'smsplanet_token');
  inspectDb.close();
  expect(
    storedToken && !storedToken.ciphertext.includes('user-owned-test-token'),
    'SMS token is stored in plaintext',
  );
  const noSharedAi = await fetch(base + '/api/assistant/parse', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'niejasna prośba testowa' }),
  });
  expect((await noSharedAi.json()).ai?.configured === false, 'registered user inherited server AI key');

  const bad = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'bad' }),
  });
  expect(bad.status === 401, `expected bad login 401, got ${bad.status}`);

  const limitedUsername = `__rate_limit_${Date.now()}`;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: limitedUsername, password: 'bad' }),
    });
    expect(
      response.status === 401,
      `expected failed rate-limit attempt ${attempt} to return 401, got ${response.status}`,
    );
  }
  const limited = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: limitedUsername, password: 'bad' }),
  });
  expect(limited.status === 429, `expected ninth failed login to be limited, got ${limited.status}`);

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
  const csp = app.headers.get('content-security-policy') || '';
  expect(
    csp.includes("script-src 'self'") && !csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'),
    `missing strict CSP: ${csp}`,
  );

  const api = await fetch(base + '/api/dashboard', { headers: { Cookie: cookie } });
  expect(api.ok, `authenticated API failed: ${api.status}`);

  const pdf = await fetch(base + '/api/export/report.pdf?period=2026-05', { headers: { Cookie: cookie } });
  expect(pdf.ok, `authenticated PDF export failed: ${pdf.status}`);
  expect(
    (pdf.headers.get('content-type') || '').includes('application/pdf'),
    'PDF export returned wrong content type',
  );
  expect((pdf.headers.get('cache-control') || '').includes('no-store'), 'PDF export is cacheable');
  const pdfBytes = await pdf.arrayBuffer();
  expect(
    pdfBytes.byteLength > 10_000,
    `PDF export too small, fonts may not be embedded: ${pdfBytes.byteLength} bytes`,
  );

  const adminSettingsSeed = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'tax.rate': '8.5', 'company.nip': 'ADMIN-PRIVATE-NIP' }),
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
  expect(
    staleSession.status === 401,
    `password change did not invalidate the previous session: ${staleSession.status}`,
  );
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
  const registeredSettings = await fetch(base + '/api/settings', { headers: { Cookie: registerCookie } });
  expect(
    !(await registeredSettings.text()).includes('ADMIN-PRIVATE-NIP'),
    'global company data leaked to registered user',
  );
  const audit = await fetch(base + '/api/admin/audit', { headers: { Cookie: cookie } });
  const auditRows = await audit.json();
  expect(
    audit.ok && auditRows.some((row) => row.resource === 'properties' && row.action === 'post'),
    'property creation was not recorded in audit log',
  );

  const createUser = await fetch(base + '/api/admin/users', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'tester',
      display_name: 'Tester',
      role: 'user',
      password: 'secret-pass-2',
    }),
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

  const hiddenAdminProperty = await fetch(base + `/api/properties/${adminPropertyId}`, {
    headers: { Cookie: userCookie },
  });
  expect(hiddenAdminProperty.status === 404, `user can see admin property: ${hiddenAdminProperty.status}`);

  const userProperty = await fetch(base + '/api/properties', {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'User Property', type: 'mieszkanie' }),
  });
  expect(userProperty.status === 201, `user property failed: ${userProperty.status}`);
  const userPropertyId = (await userProperty.json()).id;
  const registeredProperty = await fetch(base + '/api/properties', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Registered Private Property', type: 'mieszkanie' }),
  });
  expect(registeredProperty.status === 201, 'registered user cannot create property');
  const registeredPropertyId = (await registeredProperty.json()).id;
  const registeredTenant = await fetch(base + '/api/tenants', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Registered Private Tenant', status: 'active' }),
  });
  expect(registeredTenant.status === 201, 'registered user cannot create tenant');
  const registeredTenantId = (await registeredTenant.json()).id;
  const registeredTask = await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Registered Private Task' }),
  });
  expect(registeredTask.status === 201, 'registered user cannot create task');
  const registeredTaskId = (await registeredTask.json()).id;
  const registeredPayment = await fetch(base + '/api/payments', {
    method: 'POST',
    headers: { Cookie: registerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: '2026-05',
      tenant_id: registeredTenantId,
      rent_amount: 700,
      notes: 'Registered Private Payment',
    }),
  });
  expect(registeredPayment.status === 201, 'registered user cannot create payment');
  const registeredPaymentId = (await registeredPayment.json()).id;
  for (const [endpoint, privateName] of [
    ['/api/properties', 'Registered Private Property'],
    ['/api/tenants', 'Registered Private Tenant'],
    ['/api/tasks', 'Registered Private Task'],
    ['/api/payments?period=2026-05', 'Registered Private Payment'],
    ['/api/export/payments.csv?period=2026-05', 'Registered Private Payment'],
    ['/api/dashboard', 'Registered Private Property'],
  ]) {
    const otherResponse = await fetch(base + endpoint, { headers: { Cookie: userCookie } });
    expect(
      !String(await otherResponse.text()).includes(privateName),
      `${endpoint} leaked registered user data`,
    );
  }
  for (const endpoint of [
    `/api/properties/${registeredPropertyId}`,
    `/api/tenants/${registeredTenantId}`,
    `/api/tasks/${registeredTaskId}`,
    `/api/payments/${registeredPaymentId}`,
  ]) {
    const otherResponse = await fetch(base + endpoint, { headers: { Cookie: userCookie } });
    expect(otherResponse.status === 404, `${endpoint} returned another user's record`);
  }
  const forbiddenApproval = await fetch(base + '/api/payments/approve-month', {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: '2026-05' }),
  });
  expect((await forbiddenApproval.json()).updated === 0, 'bulk payment approval changed another user data');
  const registeredPaymentRead = await fetch(base + `/api/payments/${registeredPaymentId}`, {
    headers: { Cookie: registerCookie },
  });
  expect((await registeredPaymentRead.json()).status === 'pending', 'other user changed registered payment');
  const foreignPropertyForRegistered = await fetch(base + `/api/properties/${userPropertyId}`, {
    headers: { Cookie: registerCookie },
  });
  expect(foreignPropertyForRegistered.status === 404, 'registered account can read another user property');
  const foreignPropertyMutation = await fetch(base + `/api/properties/${userPropertyId}`, {
    method: 'DELETE',
    headers: { Cookie: registerCookie },
  });
  expect(foreignPropertyMutation.status === 404, 'registered account can delete another user property');
  const userSmsStatus = await fetch(base + '/api/notifications/credential', {
    headers: { Cookie: userCookie },
  });
  expect(!(await userSmsStatus.json()).configured, 'SMS credential leaked to second user');

  const userProperties = await fetch(base + '/api/properties', { headers: { Cookie: userCookie } });
  const visibleProperties = await userProperties.json();
  expect(
    visibleProperties.length === 1 && visibleProperties[0].id === userPropertyId,
    'user property list is not isolated',
  );

  const adminUnit = await fetch(base + '/api/units', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: adminPropertyId, name: 'Admin Contract Unit', status: 'vacant' }),
  });
  expect(adminUnit.status === 201, `admin unit failed: ${adminUnit.status}`);
  const adminUnitId = (await adminUnit.json()).id;
  const adminTenant = await fetch(base + '/api/tenants', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin Contract Tenant', status: 'active' }),
  });
  expect(adminTenant.status === 201, `admin tenant failed: ${adminTenant.status}`);
  const adminTenantId = (await adminTenant.json()).id;
  const adminContract = await fetch(base + '/api/contracts', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: adminTenantId,
      unit_id: adminUnitId,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      rent: 1000,
      media_advance: 100,
      pay_by_day: 10,
      status: 'active',
    }),
  });
  expect(adminContract.status === 201, `admin contract failed: ${adminContract.status}`);
  const adminContractId = (await adminContract.json()).id;
  const hiddenAmendments = await fetch(base + `/api/contracts/${adminContractId}/amendments`, {
    headers: { Cookie: userCookie },
  });
  expect(
    hiddenAmendments.status === 404,
    `user can read admin contract amendments: ${hiddenAmendments.status}`,
  );
  const foreignAmendment = new FormData();
  foreignAmendment.append('amendment_number', '1/A/2026');
  foreignAmendment.append('effective_date', '2026-02-01');
  foreignAmendment.append('status', 'draft');
  foreignAmendment.append('notes', 'Niedozwolona próba dostępu');
  const deniedAmendment = await fetch(base + `/api/contracts/${adminContractId}/amendments`, {
    method: 'POST',
    headers: { Cookie: userCookie },
    body: foreignAmendment,
  });
  expect(
    deniedAmendment.status === 404,
    `user can create amendment on admin contract: ${deniedAmendment.status}`,
  );

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
  expect(
    logout.ok && (logout.headers.get('set-cookie') || '').includes('propertyapp_session='),
    'logout did not clear cookie',
  );

  console.log('Auth smoke test OK');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => stopServer());
