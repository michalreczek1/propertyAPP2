#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-auth-'));
const dbFile = path.join(tmpDir, 'property.db');
const port = Number(process.env.TEST_PORT || 8192);
const base = `http://127.0.0.1:${port}`;
let serverProc = null;

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: dbFile, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${script} failed\n${r.stdout}\n${r.stderr}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
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
      APP_AUTH_PASSWORD_HASH: bcrypt.hashSync('secret-pass', 10),
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
  const cookie = good.headers.get('set-cookie');
  expect(cookie && cookie.includes('propertyapp_session='), 'missing session cookie');

  const app = await fetch(base + '/', { headers: { Cookie: cookie } });
  const html = await app.text();
  expect(app.ok && html.includes('PropertyApp'), 'authenticated app shell did not render');

  const api = await fetch(base + '/api/dashboard', { headers: { Cookie: cookie } });
  expect(api.ok, `authenticated API failed: ${api.status}`);

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
