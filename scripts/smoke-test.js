#!/usr/bin/env node
'use strict';
/**
 * Smoke test PropertyApp — uruchamia serwer w tle, woła wszystkie endpointy,
 * tworzy/aktualizuje/usuwa po jednym wpisie z każdej tabeli, raportuje wynik.
 *
 * Wymaga zaimportowanych deps (`npm install`) i działającej bazy (`npm run migrate && npm run seed`).
 * Bezpieczne dla danych — tworzone wpisy są czyszczone na końcu.
 *
 * Użycie:
 *   node scripts/smoke-test.js                 # uruchom serwer + testy
 *   BASE_URL=http://localhost:8090 node scripts/smoke-test.js   # przeciw istniejącemu
 */
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8090';
let serverProc = null;

const results = []; // { name, ok, ms, info }

function log(name, ok, ms, info = '') {
  results.push({ name, ok, ms, info });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name.padEnd(40)} ${String(ms).padStart(5)}ms  ${info}`);
}

async function api(method, p, body, isFile) {
  const opts = { method, headers: {} };
  if (body != null && !isFile) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const t0 = Date.now();
  const r = await fetch(BASE + p, opts);
  const ms = Date.now() - t0;
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await r.json(); } catch {}
  } else {
    data = await r.text();
  }
  return { status: r.status, ok: r.ok, data, ms };
}

async function check(name, fn) {
  try {
    const t0 = Date.now();
    const r = await fn();
    const ms = Date.now() - t0;
    log(name, true, ms, r || '');
  } catch (e) {
    log(name, false, 0, e.message);
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function startServer() {
  if (process.env.BASE_URL) return; // serwer zewnętrzny
  console.log('▶ Uruchamiam serwer w tle…');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '8090', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

  // poczekaj na health
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) { console.log('  ✓ serwer up'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Serwer nie wstał w 6s');
}

function stopServer() { if (serverProc) serverProc.kill('SIGINT'); }

async function main() {
  await startServer();

  console.log('\n══ HEALTH ══');
  await check('GET  /health', async () => {
    const r = await api('GET', '/health');
    expect(r.ok && r.data.ok, JSON.stringify(r));
    return `db=${r.data.db} tables=${r.data.tables}`;
  });

  console.log('\n══ READ-ONLY ══');
  for (const p of [
    '/api/dashboard',
    '/api/reports',
    '/api/reports/yearly?year=2025',
    '/api/properties',
    '/api/units',
    '/api/tenants',
    '/api/tenants?status=active',
    '/api/contracts',
    '/api/payments?period=2025-01',
    '/api/payments/periods',
    '/api/expenses',
    '/api/tasks',
    '/api/documents',
    '/api/settings',
    '/api/settings/owner-costs',
    '/api/import/status',
  ]) {
    await check(`GET  ${p}`, async () => {
      const r = await api('GET', p);
      expect(r.ok, `${r.status} ${JSON.stringify(r.data).slice(0,140)}`);
      const len = Array.isArray(r.data) ? r.data.length : Object.keys(r.data || {}).length;
      return `${len} ${Array.isArray(r.data) ? 'wierszy' : 'pól'}`;
    });
  }

  console.log('\n══ CRUD: tenant ══');
  let tenantId = null;
  await check('POST /api/tenants', async () => {
    const r = await api('POST', '/api/tenants', { name:'__smoke_test_tenant', status:'active' });
    expect(r.ok && r.data.id, JSON.stringify(r));
    tenantId = r.data.id;
    return `id=${tenantId}`;
  });
  await check('PUT  /api/tenants/:id', async () => {
    const r = await api('PUT', `/api/tenants/${tenantId}`, { phone: '+48 600 000 000', notes: 'smoke' });
    expect(r.ok && r.data.phone === '+48 600 000 000', JSON.stringify(r));
    return 'ok';
  });
  await check('DEL  /api/tenants/:id', async () => {
    const r = await api('DELETE', `/api/tenants/${tenantId}`);
    expect(r.ok, JSON.stringify(r));
    return 'ok';
  });

  console.log('\n══ CRUD: task ══');
  let taskId = null;
  await check('POST /api/tasks', async () => {
    const r = await api('POST', '/api/tasks', { title:'__smoke task', priority:'low' });
    expect(r.ok && r.data.id, JSON.stringify(r));
    taskId = r.data.id;
    return `id=${taskId}`;
  });
  await check('PUT  /api/tasks/:id/toggle', async () => {
    const r = await api('PUT', `/api/tasks/${taskId}/toggle`);
    expect(r.ok && r.data.status === 'done', JSON.stringify(r));
    return r.data.status;
  });
  await check('DEL  /api/tasks/:id', async () => {
    const r = await api('DELETE', `/api/tasks/${taskId}`);
    expect(r.ok, JSON.stringify(r));
    return 'ok';
  });

  console.log('\n══ CRUD: property ══');
  let propId = null;
  await check('POST /api/properties', async () => {
    const r = await api('POST', '/api/properties', { name:'__smoke_property', district:'Test', type:'inne' });
    expect(r.ok && r.data.id, JSON.stringify(r));
    propId = r.data.id;
    return `id=${propId}`;
  });
  await check('GET  /api/properties/:id', async () => {
    const r = await api('GET', `/api/properties/${propId}`);
    expect(r.ok && r.data.name === '__smoke_property', JSON.stringify(r));
    return 'ok';
  });
  await check('DEL  /api/properties/:id', async () => {
    const r = await api('DELETE', `/api/properties/${propId}`);
    expect(r.ok, JSON.stringify(r));
    return 'ok';
  });

  console.log('\n══ CRUD: expense ══');
  let expId = null;
  await check('POST /api/expenses', async () => {
    const r = await api('POST', '/api/expenses', { category:'inne', amount: 12.34, date: '2025-01-15', description: '__smoke' });
    expect(r.ok && r.data.id, JSON.stringify(r));
    expId = r.data.id;
    return `id=${expId}`;
  });
  await check('DEL  /api/expenses/:id', async () => {
    const r = await api('DELETE', `/api/expenses/${expId}`);
    expect(r.ok, JSON.stringify(r));
    return 'ok';
  });

  console.log('\n══ EKSPORT ══');
  await check('GET  /api/export/payments.csv?period=2025-01', async () => {
    const r = await fetch(BASE + '/api/export/payments.csv?period=2025-01');
    expect(r.ok && r.headers.get('content-type').includes('text/csv'), `status=${r.status}`);
    const txt = await r.text();
    return `${txt.split('\n').length-1} linii CSV`;
  });
  await check('GET  /api/export/report.pdf?period=2025-01', async () => {
    const r = await fetch(BASE + '/api/export/report.pdf?period=2025-01');
    expect(r.ok && r.headers.get('content-type').includes('application/pdf'), `status=${r.status}`);
    const buf = await r.arrayBuffer();
    return `${buf.byteLength} bajtów PDF`;
  });

  console.log('\n══ STATIC FRONTEND ══');
  await check('GET  / (index.html)', async () => {
    const r = await fetch(BASE + '/');
    expect(r.ok, `status=${r.status}`);
    const t = await r.text();
    expect(t.includes('PropertyApp'), 'brak tagu PropertyApp w HTML');
    return `${t.length} bajtów`;
  });
  for (const p of ['/styles.css', '/app.js']) {
    await check(`GET  ${p}`, async () => {
      const r = await fetch(BASE + p);
      expect(r.ok, `status=${r.status}`);
      return 'ok';
    });
  }

  console.log('\n══ NEGATYWNE ══');
  await check('GET  /api/tenants/999999 → 404', async () => {
    const r = await api('GET', '/api/tenants/999999');
    expect(r.status === 404, `oczekiwano 404, było ${r.status}`);
    return 'ok';
  });
  await check('POST /api/properties bez name → 400', async () => {
    const r = await api('POST', '/api/properties', { type:'inne' });
    expect(r.status === 400 && r.data.error === 'validation_error', JSON.stringify(r));
    return 'walidacja działa';
  });

  // wynik
  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  console.log(`\n══════ ${ok}/${results.length} OK · ${failed} błędów ══════`);
  if (failed > 0) {
    console.log('\nBłędy:');
    for (const r of results.filter(r => !r.ok)) console.log(`  ✗ ${r.name}: ${r.info}`);
  }

  stopServer();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  stopServer();
  process.exit(1);
});

process.on('SIGINT', () => { stopServer(); process.exit(130); });
