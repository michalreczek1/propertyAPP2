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
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8090';
const isolated = !process.env.BASE_URL;
const tmpDir = isolated ? fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-smoke-')) : null;
const dbFile = process.env.TEST_DB_FILE || (tmpDir && path.join(tmpDir, 'property.db'));
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
    try {
      data = await r.json();
    } catch {}
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

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function prepareIsolatedDatabase() {
  if (!isolated) return;
  for (const script of ['scripts/migrate.js', 'scripts/seed.js']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_FILE: dbFile, UPLOADS_DIR: path.join(tmpDir, 'uploads'), NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function startServer() {
  if (process.env.BASE_URL) return; // serwer zewnętrzny
  console.log('▶ Uruchamiam serwer w tle…');
  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_FILE: dbFile,
      UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      PORT: '8090',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));

  // poczekaj na health
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) {
        console.log('  ✓ serwer up');
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Serwer nie wstał w 6s');
}

function stopServer() {
  if (serverProc) serverProc.kill('SIGINT');
}

async function stopServerAndCleanup() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGINT');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      serverProc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  prepareIsolatedDatabase();
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
    '/api/reports/tax-yearly?year=2026',
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
    '/api/notifications/settings',
    '/api/notifications/logs',
    '/api/import/status',
  ]) {
    await check(`GET  ${p}`, async () => {
      const r = await api('GET', p);
      expect(r.ok, `${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
      const len = Array.isArray(r.data) ? r.data.length : Object.keys(r.data || {}).length;
      return `${len} ${Array.isArray(r.data) ? 'wierszy' : 'pól'}`;
    });
  }

  console.log('\n══ CRUD: tenant ══');
  let tenantId = null;
  await check('POST /api/tenants', async () => {
    const r = await api('POST', '/api/tenants', { name: '__smoke_test_tenant', status: 'active' });
    expect(r.ok && r.data.id, JSON.stringify(r));
    tenantId = r.data.id;
    return `id=${tenantId}`;
  });
  await check('PUT  /api/tenants/:id', async () => {
    const r = await api('PUT', `/api/tenants/${tenantId}`, {
      phone: '+48 600 000 000',
      sms_consent: 1,
      sms_disabled: 0,
      notes: 'smoke',
    });
    expect(r.ok && r.data.phone === '+48 600 000 000' && Number(r.data.sms_consent) === 1, JSON.stringify(r));
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
    const r = await api('POST', '/api/tasks', { title: '__smoke task', priority: 'low' });
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

  console.log('\n══ LATE PAYMENT FEES ══');
  let lateTenantId = null,
    latePaymentId = null;
  await check('POST late paid payment adds 50 zł fee', async () => {
    const tenant = await api('POST', '/api/tenants', { name: '__smoke_late_fee_tenant', status: 'active' });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    lateTenantId = tenant.data.id;
    const payment = await api('POST', '/api/payments', {
      period: '2026-02',
      tenant_id: lateTenantId,
      due_day: 10,
      due_date: '2026-02-10',
      paid_date: '2026-02-12',
      rent_amount: 100,
      media_amount: 20,
      other_amount: 0,
      total_paid: 120,
      status: 'paid',
      source: 'smoke',
    });
    expect(payment.ok && payment.data.late_fee_amount === 50, JSON.stringify(payment));
    expect(payment.data.late_fee_balance === 50, JSON.stringify(payment));
    latePaymentId = payment.data.id;
    return `fee=${payment.data.late_fee_amount} balance=${payment.data.late_fee_balance}`;
  });
  await check('PUT late fee settlement updates tenant balance', async () => {
    const r = await api('PUT', `/api/payments/${latePaymentId}/late-fee`, {
      action: 'deposit',
      note: 'smoke',
    });
    expect(
      r.ok &&
        r.data.total_paid === 120 &&
        r.data.late_fee_paid === 50 &&
        r.data.late_fee_resolution === 'deposit' &&
        r.data.late_fee_balance === 0,
      JSON.stringify(r),
    );
    const t = await api('GET', `/api/tenants/${lateTenantId}`);
    expect(
      t.ok &&
        t.data.late_fee_summary.total === 50 &&
        t.data.late_fee_summary.balance === 0 &&
        t.data.late_fees[0].resolution === 'deposit',
      JSON.stringify(t),
    );
    return 'ok';
  });
  await check('DEL  late payment fixture', async () => {
    if (latePaymentId)
      expect((await api('DELETE', `/api/payments/${latePaymentId}`)).ok, 'payment delete failed');
    if (lateTenantId)
      expect((await api('DELETE', `/api/tenants/${lateTenantId}`)).ok, 'tenant delete failed');
    return 'ok';
  });

  console.log('\n══ PAYMENT DUE DATES ══');
  let dueTenantId = null,
    duePaymentId = null;
  await check('PUT payment due_day recalculates due_date', async () => {
    const tenant = await api('POST', '/api/tenants', { name: '__smoke_due_date_tenant', status: 'active' });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    dueTenantId = tenant.data.id;
    const payment = await api('POST', '/api/payments', {
      period: '2026-04',
      tenant_id: dueTenantId,
      due_day: 10,
      rent_amount: 100,
      media_amount: 0,
      other_amount: 0,
      total_paid: 0,
      status: 'pending',
      source: 'smoke',
    });
    expect(payment.ok && payment.data.due_date === '2026-04-10', JSON.stringify(payment));
    duePaymentId = payment.data.id;
    const updated = await api('PUT', `/api/payments/${duePaymentId}`, { due_day: 31 });
    expect(
      updated.ok && updated.data.due_day === 31 && updated.data.due_date === '2026-04-30',
      JSON.stringify(updated),
    );
    return updated.data.due_date;
  });
  await check('DEL  due date fixture', async () => {
    if (duePaymentId)
      expect((await api('DELETE', `/api/payments/${duePaymentId}`)).ok, 'payment delete failed');
    if (dueTenantId) expect((await api('DELETE', `/api/tenants/${dueTenantId}`)).ok, 'tenant delete failed');
    return 'ok';
  });

  console.log('\n══ SMS NOTIFICATIONS ══');
  await check('PUT  /api/notifications/settings', async () => {
    const r = await api('PUT', '/api/notifications/settings', {
      enabled: false,
      sender: 'TEST',
      send_time: '09:30',
      overdue_days: 1,
      reminder_enabled: true,
      reminder_days_before_due: 3,
      test_mode: true,
      test_phone: '+48600000000',
      clear_polish: true,
      transactional: false,
    });
    expect(r.ok && r.data.sender === 'TEST' && r.data.test_mode === true, JSON.stringify(r));
    return 'ok';
  });
  await check('POST /api/notifications/run dry-run', async () => {
    const r = await api('POST', '/api/notifications/run', {
      type: 'all',
      dry_run: true,
      today: '2026-04-01',
    });
    expect(r.ok && r.data.dry_run === true && Array.isArray(r.data.candidates), JSON.stringify(r));
    return `${r.data.candidates.length} kandydatów`;
  });
  let smsPropId, smsUnitId, smsTenantId, smsPaymentId;
  await check('POST /api/notifications/payments/:id/reminder', async () => {
    const suffix = `__smoke_sms_button_${Date.now()}`;
    const prop = await api('POST', '/api/properties', {
      name: `${suffix}_property`,
      district: 'SMS',
      type: 'mieszkanie',
    });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    smsPropId = prop.data.id;
    const unit = await api('POST', '/api/units', {
      property_id: smsPropId,
      name: `${suffix}_unit`,
      code: 'SMS',
      base_rent: 900,
      base_media: 100,
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    smsUnitId = unit.data.id;
    const tenant = await api('POST', '/api/tenants', {
      name: suffix,
      current_unit_id: smsUnitId,
      status: 'active',
      phone: '+48600000000',
      sms_consent: 1,
    });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    smsTenantId = tenant.data.id;
    const payment = await api('POST', '/api/payments', {
      period: '2026-05',
      tenant_id: smsTenantId,
      unit_id: smsUnitId,
      due_day: 10,
      rent_amount: 900,
      media_amount: 100,
      total_paid: 0,
      status: 'pending',
      source: 'smoke',
    });
    expect(payment.ok && payment.data.id, JSON.stringify(payment));
    smsPaymentId = payment.data.id;
    const preview = await api('GET', `/api/notifications/payments/${smsPaymentId}/reminder`);
    expect(
      preview.ok && preview.data.ok && preview.data.message && preview.data.payment_id === smsPaymentId,
      JSON.stringify(preview),
    );
    const sent = await api('POST', `/api/notifications/payments/${smsPaymentId}/reminder`, {});
    expect(sent.ok && sent.data.id, JSON.stringify(sent));
    if (preview.data.token_configured) {
      expect(sent.data.status === 'simulated', JSON.stringify(sent));
    } else {
      expect(
        sent.data.status === 'failed' && sent.data.error === 'smsplanet_token_required',
        JSON.stringify(sent),
      );
    }
    return `log=${sent.data.id} status=${sent.data.status}`;
  });
  await check('DEL  SMS reminder fixture', async () => {
    if (smsPaymentId)
      expect((await api('DELETE', `/api/payments/${smsPaymentId}`)).ok, 'payment delete failed');
    if (smsTenantId) expect((await api('DELETE', `/api/tenants/${smsTenantId}`)).ok, 'tenant delete failed');
    if (smsUnitId) expect((await api('DELETE', `/api/units/${smsUnitId}`)).ok, 'unit delete failed');
    if (smsPropId) expect((await api('DELETE', `/api/properties/${smsPropId}`)).ok, 'property delete failed');
    return 'ok';
  });

  console.log('\n══ AI ASSISTANT ══');
  const aiFixtures = [];
  const aiAliasIds = [];
  async function createAiPaymentFixture(name, opts = {}) {
    const prop = await api('POST', '/api/properties', {
      name: `${name}_property`,
      district: 'AI',
      type: 'mieszkanie',
    });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    const unit = await api('POST', '/api/units', {
      property_id: prop.data.id,
      name: `${name}_unit`,
      code: opts.code || 'AI',
      base_rent: 1000,
      base_media: 200,
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    const tenant = await api('POST', '/api/tenants', {
      name,
      current_unit_id: unit.data.id,
      status: 'active',
      phone: opts.phone || '+48 600 000 000',
      sms_consent: opts.smsConsent ? 1 : 0,
      sms_disabled: opts.smsDisabled ? 1 : 0,
    });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    const payment = await api('POST', '/api/payments', {
      period: opts.period || '2026-05',
      tenant_id: tenant.data.id,
      unit_id: unit.data.id,
      due_day: 10,
      due_date: opts.dueDate || null,
      paid_date: opts.paidDate || null,
      rent_amount: 1000,
      media_amount: 200,
      other_amount: 0,
      late_fee_amount: opts.lateFeeAmount || 0,
      late_fee_paid: opts.lateFeePaid || 0,
      late_fee_manual: opts.lateFeeAmount ? 1 : 0,
      total_paid: opts.totalPaid ?? (opts.status === 'paid' ? 1200 : 0),
      status: opts.status || 'pending',
      source: 'smoke-ai',
    });
    expect(payment.ok && payment.data.id, JSON.stringify(payment));
    const fixture = {
      propertyId: prop.data.id,
      unitId: unit.data.id,
      tenantId: tenant.data.id,
      paymentId: payment.data.id,
    };
    aiFixtures.push(fixture);
    return fixture;
  }

  let aiPaidFixture = null,
    aiSmsFixture = null,
    aiBlockedFixture = null;
  await check('POST /api/assistant/parse mark payment', async () => {
    aiPaidFixture = await createAiPaymentFixture(`__smoke_ai_kowalski_${Date.now()}`);
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `${Date.now()} kowalski zapłacił`,
    });
    if (!r.ok || !r.data.action) {
      const retry = await api('POST', '/api/assistant/parse', {
        period: '2026-05',
        message: `__smoke_ai_kowalski zapłacił`,
      });
      expect(
        retry.ok && retry.data.intent === 'mark_payment_paid' && retry.data.action && retry.data.action.token,
        JSON.stringify(retry),
      );
      return retry.data.intent;
    }
    expect(r.data.intent === 'mark_payment_paid' && r.data.action.token, JSON.stringify(r));
    return r.data.intent;
  });
  await check('POST /api/assistant/execute marks paid', async () => {
    const parsed = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `__smoke_ai_kowalski zapłacił`,
    });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.payment.status === 'paid', JSON.stringify(r));
    return r.data.payment.status;
  });
  await check('POST /api/assistant/parse tax explain', async () => {
    const [assistant, dash] = await Promise.all([
      api('POST', '/api/assistant/parse', {
        period: '2026-05',
        message: 'ile wynosi podatek za ten miesiąc',
      }),
      api('GET', '/api/dashboard?period=2026-05'),
    ]);
    expect(
      assistant.ok && assistant.data.intent === 'explain_tax' && assistant.data.tax,
      JSON.stringify(assistant),
    );
    expect(
      dash.ok && assistant.data.tax.podatek_suma === dash.data.tax.podatek_suma,
      JSON.stringify({ assistant, dash }),
    );
    return `${assistant.data.tax.podatek_suma} zł`;
  });
  await check('POST /api/assistant/parse paid status question', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_status_${Date.now()}`, {
      period: '2026-04',
      status: 'paid',
      totalPaid: 1200,
      code: 'STAT',
    });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `czy __smoke_ai_status zapłacił za kwiecień?`,
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && !r.data.action,
      JSON.stringify(r),
    );
    expect(
      /Tak/i.test(r.data.message) && r.data.payment && r.data.payment.status === 'paid',
      JSON.stringify(r.data),
    );
    return r.data.message;
  });
  await check('POST /api/assistant/parse tenant payment yearly summary', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_roczny_${Date.now()}`, {
      period: '2026-04',
      status: 'paid',
      totalPaid: 1200,
      code: 'YR',
    });
    const extra = await api('POST', '/api/payments', {
      period: '2026-05',
      tenant_id: fixture.tenantId,
      unit_id: fixture.unitId,
      due_day: 10,
      rent_amount: 800,
      media_amount: 100,
      other_amount: 0,
      total_paid: 900,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(extra.ok && extra.data.id, JSON.stringify(extra));
    aiFixtures.push({ paymentId: extra.data.id });
    const future = await api('POST', '/api/payments', {
      period: '2026-12',
      tenant_id: fixture.tenantId,
      unit_id: fixture.unitId,
      due_day: 10,
      rent_amount: 5000,
      media_amount: 0,
      other_amount: 0,
      total_paid: 5000,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(future.ok && future.data.id, JSON.stringify(future));
    aiFixtures.push({ paymentId: future.data.id });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `ile w tym roku zapłacił __smoke_ai_roczny`,
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      r.data.report.range && r.data.report.range.start === '2026-01' && r.data.report.range.end === '2026-05',
      JSON.stringify(r.data.report),
    );
    expect(
      r.data.report.paid >= 2100 && r.data.report.paid < 7000 && r.data.report.count === 2,
      JSON.stringify(r.data),
    );
    return `${r.data.report.paid} zł`;
  });
  await check('POST /api/assistant/parse tenant payment summary by surname', async () => {
    const tenantName = `__smoke_ai_hryniuk_${Date.now()}`;
    const fixture = await createAiPaymentFixture(tenantName, {
      period: '2026-04',
      status: 'paid',
      totalPaid: 1250,
      code: 'HR',
    });
    const extra = await api('POST', '/api/payments', {
      period: '2026-05',
      tenant_id: fixture.tenantId,
      unit_id: fixture.unitId,
      due_day: 10,
      rent_amount: 800,
      media_amount: 100,
      other_amount: 0,
      total_paid: 930,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(extra.ok && extra.data.id, JSON.stringify(extra));
    aiFixtures.push({ paymentId: extra.data.id });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `podsumuj wpłaty ${tenantName}`,
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      r.data.report.tenant && Number(r.data.report.tenant.id) === Number(fixture.tenantId),
      JSON.stringify(r.data),
    );
    expect(
      r.data.report.range && r.data.report.range.mode === 'all' && r.data.report.paid >= 2180,
      JSON.stringify(r.data),
    );
    return `${r.data.report.paid} zł`;
  });
  await check('POST /api/assistant/parse global current-year income summary', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ile zarobiłem w 2026 r.',
    });
    expect(
      r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      r.data.report.metric === 'net_income' &&
        r.data.report.range &&
        r.data.report.range.start === '2026-01' &&
        r.data.report.range.end === '2026-05',
      JSON.stringify(r.data),
    );
    expect(!String(r.data.title || '').startsWith('Wynik netto maj 2026'), JSON.stringify(r.data));
    return `${r.data.report.net} zł`;
  });
  await check('POST /api/assistant/aliases property and metric aliases', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_alias_${Date.now()}`, {
      period: '2026-05',
      status: 'paid',
      totalPaid: 1200,
      code: 'AL',
    });
    const propertyAlias = await api('POST', '/api/assistant/aliases', {
      alias: '__smoke tajna baza',
      resolves_to_type: 'property',
      resolves_to_id: fixture.propertyId,
    });
    expect(propertyAlias.ok && propertyAlias.data.id, JSON.stringify(propertyAlias));
    aiAliasIds.push(propertyAlias.data.id);
    const metricAlias = await api('POST', '/api/assistant/aliases', {
      alias: '__smoke test mamony',
      resolves_to_type: 'metric',
      resolves_to_value: 'revenue_paid',
    });
    expect(metricAlias.ok && metricAlias.data.id, JSON.stringify(metricAlias));
    aiAliasIds.push(metricAlias.data.id);
    const propertyAnswer = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'podaj dochód z __smoke tajna baza za 2026 r.',
    });
    expect(
      propertyAnswer.ok &&
        propertyAnswer.data.report &&
        Number(propertyAnswer.data.report.property_id) === Number(fixture.propertyId),
      JSON.stringify(propertyAnswer),
    );
    const metricAnswer = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ile __smoke test mamony w 2026 r.',
    });
    expect(
      metricAnswer.ok && metricAnswer.data.report && metricAnswer.data.report.metric === 'revenue_paid',
      JSON.stringify(metricAnswer),
    );
    return `${propertyAlias.data.alias} / ${metricAlias.data.alias}`;
  });
  await check('POST /api/assistant/parse tax yearly summary', async () => {
    const [assistant, taxYear] = await Promise.all([
      api('POST', '/api/assistant/parse', {
        period: '2026-05',
        message: 'podsumuj ile podatku zapłaciłem w tym roku',
      }),
      api('GET', '/api/reports/tax-yearly?year=2026'),
    ]);
    expect(
      assistant.ok &&
        assistant.data.intent === 'report_answer' &&
        assistant.data.status === 'answer' &&
        assistant.data.report,
      JSON.stringify(assistant),
    );
    const includedMonths = assistant.data.report.range.periods || [];
    const expectedTax = includedMonths.reduce((sum, period) => {
      const monthIndex = Number(String(period).slice(5, 7)) - 1;
      return sum + Number(taxYear.data.tax_paid.values[monthIndex] || 0);
    }, 0);
    expect(
      taxYear.ok &&
        assistant.data.report.range.end === '2026-05' &&
        Math.round(assistant.data.report.tax_total) === Math.round(expectedTax),
      JSON.stringify({ assistant, taxYear, expectedTax }),
    );
    return `${assistant.data.report.tax_total} zł`;
  });
  await check('POST /api/assistant/parse portfolio calculation commands', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_calculations_${Date.now()}`, {
      period: '2026-05',
      status: 'pending',
      code: 'CAL',
    });
    const januaryPayment = await api('POST', '/api/payments', {
      period: '2026-01',
      tenant_id: fixture.tenantId,
      unit_id: fixture.unitId,
      due_day: 10,
      rent_amount: 1000,
      media_amount: 200,
      other_amount: 0,
      total_paid: 1200,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(januaryPayment.ok && januaryPayment.data.id, JSON.stringify(januaryPayment));
    aiFixtures.push({ paymentId: januaryPayment.data.id });

    const monthlyPayments = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'podsumuj wpłaty z tego miesiąca',
    });
    expect(
      monthlyPayments.ok &&
        monthlyPayments.data.report &&
        monthlyPayments.data.report.metric === 'revenue_paid' &&
        monthlyPayments.data.report.range.mode === 'period',
      JSON.stringify(monthlyPayments),
    );

    const shortfall = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ile jeszcze wpłat brakuje w tym miesiącu? Podaj kwotę.',
    });
    expect(
      shortfall.ok &&
        shortfall.data.report &&
        shortfall.data.report.metric === 'revenue_shortfall' &&
        Math.round(shortfall.data.report.value) ===
          Math.round(Math.max(0, shortfall.data.report.expected - shortfall.data.report.revenue)),
      JSON.stringify(shortfall),
    );

    const yearToDatePayments = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'podsumuj wpływy z najmu od początku roku',
    });
    expect(
      yearToDatePayments.ok &&
        yearToDatePayments.data.report &&
        yearToDatePayments.data.report.metric === 'revenue_paid' &&
        yearToDatePayments.data.report.range.start === '2026-01' &&
        yearToDatePayments.data.report.range.end === '2026-05',
      JSON.stringify(yearToDatePayments),
    );

    const yearToDateTax = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'podsumuj zapłacony podatek od początku roku',
    });
    expect(
      yearToDateTax.ok &&
        yearToDateTax.data.report &&
        yearToDateTax.data.report.tax_total >= 0 &&
        yearToDateTax.data.report.range.start === '2026-01' &&
        yearToDateTax.data.report.range.end === '2026-05',
      JSON.stringify(yearToDateTax),
    );

    const rentAndMedia = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ile zapłaciłem czynszu i mediów od początku roku',
    });
    expect(
      rentAndMedia.ok &&
        rentAndMedia.data.report &&
        rentAndMedia.data.report.metric === 'rent_and_media_paid' &&
        Math.round(rentAndMedia.data.report.value) ===
          Math.round(rentAndMedia.data.report.rent_paid + rentAndMedia.data.report.media_paid),
      JSON.stringify(rentAndMedia),
    );
    return `${Math.round(shortfall.data.report.value)} zł brakuje`;
  });
  await check('POST /api/assistant/parse tenant count previous year by property', async () => {
    const prop = await api('POST', '/api/properties', {
      name: `__smoke_ai_Lawendowa_${Date.now()}`,
      district: 'AI',
      type: 'mieszkanie',
    });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    const unit = await api('POST', '/api/units', {
      property_id: prop.data.id,
      name: '__smoke_ai_ch_unit',
      code: 'CH',
      base_rent: 1000,
      base_media: 100,
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    const tenant = await api('POST', '/api/tenants', {
      name: `__smoke_ai_ch_tenant_${Date.now()}`,
      current_unit_id: unit.data.id,
      status: 'active',
    });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    const payment = await api('POST', '/api/payments', {
      period: '2025-06',
      tenant_id: tenant.data.id,
      unit_id: unit.data.id,
      due_day: 10,
      rent_amount: 1000,
      media_amount: 100,
      total_paid: 1100,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(payment.ok && payment.data.id, JSON.stringify(payment));
    aiFixtures.push({ propertyId: prop.data.id, tenantId: tenant.data.id, paymentId: payment.data.id });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ilu miałem najemców na Lawendowej w zeszłym roku?',
    });
    expect(
      r.ok &&
        r.data.intent === 'answer_from_data' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.count >= 1,
      JSON.stringify(r),
    );
    return `${r.data.report.count} najemców`;
  });
  await check('POST /api/assistant/parse inflected property tenant count', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ilu miałem najemców na Kościelnej w zeszłym roku?',
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      String(r.data.title || '')
        .toLowerCase()
        .includes('kościelna') ||
        String(r.data.title || '')
          .toLowerCase()
          .includes('koscielna'),
      JSON.stringify(r.data),
    );
    return r.data.title;
  });
  await check('POST /api/assistant/parse property income yearly summary', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'podaj sumę dochodów z chrobrego za 2025 r.',
    });
    expect(
      r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      String(r.data.report.property_name || '')
        .toLowerCase()
        .includes('chrobrego'),
      JSON.stringify(r.data),
    );
    expect(
      r.data.report.range && r.data.report.range.start === '2025-01' && r.data.report.range.end === '2025-12',
      JSON.stringify(r.data.report),
    );
    expect(
      Number(r.data.report.revenue || 0) >= 0 && !String(r.data.title || '').includes('maj 2026'),
      JSON.stringify(r.data),
    );
    return `${r.data.report.property_name}: ${r.data.report.revenue} zł`;
  });
  await check('POST /api/assistant/parse SMS preview', async () => {
    aiSmsFixture = await createAiPaymentFixture(`__smoke_ai_sms_${Date.now()}`, {
      smsConsent: true,
      code: 'SMS',
    });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: '__smoke_ai_sms wyślij SMS z przypomnieniem',
    });
    expect(
      r.ok &&
        r.data.intent === 'send_sms_reminder' &&
        r.data.preview &&
        r.data.preview.message &&
        r.data.action,
      JSON.stringify(r),
    );
    return r.data.preview.test_mode ? 'test-mode preview' : 'preview';
  });
  await check('POST /api/assistant/parse SMS blocks missing consent', async () => {
    aiBlockedFixture = await createAiPaymentFixture(`__smoke_ai_bez_zgody_${Date.now()}`, {
      smsConsent: false,
      code: 'NO',
    });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: '__smoke_ai_bez_zgody wyślij SMS z przypomnieniem',
    });
    expect(
      r.ok && r.data.status === 'blocked' && r.data.reason === 'sms_consent_required',
      JSON.stringify(r),
    );
    return r.data.reason;
  });
  await check('POST /api/assistant/parse ambiguous tenant', async () => {
    await createAiPaymentFixture(`__smoke_ai_duplikat_A_${Date.now()}`, { code: 'D1' });
    await createAiPaymentFixture(`__smoke_ai_duplikat_B_${Date.now()}`, { code: 'D2' });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: '__smoke_ai_duplikat zapłacił',
    });
    expect(
      r.ok &&
        r.data.status === 'clarify' &&
        Array.isArray(r.data.candidates) &&
        r.data.candidates.length >= 2,
      JSON.stringify(r),
    );
    return `${r.data.candidates.length} kandydatów`;
  });
  await check('POST /api/assistant/parse global search results', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'szukaj __smoke_ai_sms',
    });
    expect(
      r.ok && ['search_global', 'navigate_to_entity'].includes(r.data.intent) && Array.isArray(r.data.items),
      JSON.stringify(r),
    );
    expect(
      r.data.items.some((item) => String(item.title || '').includes('__smoke_ai_sms')),
      JSON.stringify(r.data),
    );
    return `${r.data.items.length} wyników`;
  });
  await check('POST /api/assistant/parse payment filter navigation', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'pokaż tylko zaległości',
    });
    expect(
      r.ok &&
        r.data.status === 'navigate' &&
        r.data.navigation.view === 'platnosci' &&
        r.data.navigation.state.paymentsFilter === 'overdue',
      JSON.stringify(r),
    );
    return r.data.navigation.view;
  });
  await check('POST /api/assistant/parse finance answer', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'ile zarobiłem netto w tym miesiącu?',
    });
    expect(
      r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    return r.data.title;
  });
  await check('POST /api/assistant/parse late fee report', async () => {
    await createAiPaymentFixture(`__smoke_ai_kary_${Date.now()}`, {
      code: 'KAR',
      lateFeeAmount: 50,
      lateFeePaid: 20,
    });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'zrób zestawienie kar najemców',
    });
    expect(
      r.ok &&
        r.data.intent === 'answer_from_data' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.total >= 50,
      JSON.stringify(r),
    );
    expect(
      Array.isArray(r.data.items) &&
        r.data.items.some((item) => String(item.title || '').includes('__smoke_ai_kary')),
      JSON.stringify(r.data),
    );
    return `${r.data.report.total} zł`;
  });
  await check('POST /api/assistant/parse flexible unpaid penalties question', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'którzy najemcy mają nierozliczone kary?',
    });
    expect(
      r.ok &&
        r.data.intent === 'answer_from_data' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.balance >= 30,
      JSON.stringify(r),
    );
    expect(
      Array.isArray(r.data.items) &&
        r.data.items.some((item) => String(item.title || '').includes('__smoke_ai_kary')),
      JSON.stringify(r.data),
    );
    return `${r.data.report.balance} zł`;
  });
  await check('POST /api/assistant/parse flexible overdue payments question', async () => {
    await createAiPaymentFixture(`__smoke_ai_zalega_${Date.now()}`, { code: 'OVD', status: 'overdue' });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'kto zalega z płatnościami?',
    });
    expect(
      r.ok &&
        r.data.intent === 'answer_from_data' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.count >= 1,
      JSON.stringify(r),
    );
    expect(
      r.data.report.range && r.data.report.range.mode === 'all' && r.data.report.total_balance >= 1200,
      JSON.stringify(r.data.report),
    );
    expect(
      Array.isArray(r.data.items) &&
        r.data.items.some((item) => String(item.title || '').includes('__smoke_ai_zalega')),
      JSON.stringify(r.data),
    );
    return `${r.data.report.total_balance} zł`;
  });
  await check('POST /api/assistant/parse tenant lateness stats', async () => {
    const tenantName = `__smoke_ai_spozniony_${Date.now()}`;
    const fixture = await createAiPaymentFixture(tenantName, {
      period: '2026-04',
      code: 'LAT',
      status: 'paid',
      totalPaid: 1200,
      dueDate: '2026-04-10',
      paidDate: '2026-04-15',
    });
    const extra = await api('POST', '/api/payments', {
      period: '2026-05',
      tenant_id: fixture.tenantId,
      unit_id: fixture.unitId,
      due_day: 10,
      due_date: '2026-05-10',
      paid_date: '2026-05-10',
      rent_amount: 1000,
      media_amount: 200,
      other_amount: 0,
      total_paid: 1200,
      status: 'paid',
      source: 'smoke-ai',
    });
    expect(extra.ok && extra.data.id, JSON.stringify(extra));
    aiFixtures.push({ paymentId: extra.data.id });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `jak płaci ${tenantName} w tym roku?`,
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      r.data.report.late_count === 1 && r.data.report.max_delay_days === 5,
      JSON.stringify(r.data.report),
    );
    return `${r.data.report.average_delay_days} dni`;
  });
  await check('POST /api/assistant/parse lateness ranking', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'kto najczęściej się spóźnia z płatnościami w tym roku?',
    });
    expect(
      r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report,
      JSON.stringify(r),
    );
    expect(
      Array.isArray(r.data.report.ranking) &&
        r.data.report.ranking.some((row) => String(row.tenant_name || '').includes('__smoke_ai_spozniony')),
      JSON.stringify(r.data.report),
    );
    return `${r.data.report.count} najemców`;
  });
  await check('POST /api/assistant/parse unit profitability ranking', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'który pokój przynosi najwięcej w tym roku?',
    });
    expect(
      r.ok &&
        r.data.intent === 'report_answer' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.metric === 'revenue',
      JSON.stringify(r),
    );
    expect(Array.isArray(r.data.items), JSON.stringify(r.data));
    return r.data.title;
  });
  await check('POST /api/assistant/parse property profitability ranking', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'która nieruchomość ma największą marżę w tym roku?',
    });
    expect(
      r.ok &&
        r.data.intent === 'report_answer' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.metric === 'margin',
      JSON.stringify(r),
    );
    expect(Array.isArray(r.data.items), JSON.stringify(r.data));
    return r.data.title;
  });
  await check('POST /api/assistant/parse margin explains per-zloty meaning', async () => {
    const name = '__smoke_ai_profit_plain';
    await createAiPaymentFixture(name, { period: '2026-05', status: 'paid', totalPaid: 1200, code: 'MAR' });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `jaka jest marża ${name}_property w maju 2026?`,
    });
    expect(
      r.ok &&
        r.data.intent === 'report_answer' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.metric === 'margin',
      JSON.stringify(r),
    );
    expect(
      String(r.data.message || '').includes('z każdej 1 zł') &&
        String(r.data.message || '').includes('Rachunek:'),
      JSON.stringify(r.data),
    );
    return r.data.title;
  });
  await check('POST /api/assistant/parse data quality audit', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'sprawdź błędy w danych',
    });
    expect(r.ok && r.data.intent === 'data_quality_check' && Array.isArray(r.data.checks), JSON.stringify(r));
    return `${r.data.checks.length} kontroli`;
  });
  await check('POST /api/assistant/parse range data completeness audit', async () => {
    const auditName = `__smoke_ai_audyt_${Date.now()}`;
    await createAiPaymentFixture(auditName, { period: '2026-04', status: 'paid', code: 'AUD' });
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'sprawdź czy dane są kompletne za 2026 r.',
    });
    expect(
      r.ok &&
        r.data.intent === 'data_quality_check' &&
        r.data.report &&
        r.data.report.range.start === '2026-01',
      JSON.stringify(r),
    );
    const missing = (r.data.checks || []).find((c) => c.key === 'property_missing_months');
    expect(missing && missing.count >= 1, JSON.stringify(r.data));
    expect(
      Array.isArray(r.data.items) &&
        r.data.items.some(
          (item) =>
            String(item.title || '').includes(auditName) || String(item.subtitle || '').includes('2026-01'),
        ),
      JSON.stringify(r.data),
    );
    return `${missing.count} braków`;
  });
  await check('POST /api/assistant/parse finance explanation', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'dlaczego wynik w maju 2026?',
    });
    expect(
      r.ok &&
        r.data.intent === 'report_answer' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.delta,
      JSON.stringify(r),
    );
    expect(String(r.data.title || '').includes('Wyjaśnienie'), JSON.stringify(r.data));
    return r.data.title;
  });
  await check('GET /api/assistant/attention', async () => {
    const r = await api('GET', '/api/assistant/attention?period=2026-05');
    expect(r.ok && Array.isArray(r.data.checks) && Array.isArray(r.data.commands), JSON.stringify(r));
    return `${r.data.checks.length} sygnałów`;
  });
  await check('POST /api/assistant/parse annual AI summary', async () => {
    const r = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'zrób podsumowanie 2026',
    });
    expect(
      r.ok &&
        r.data.intent === 'report_answer' &&
        r.data.status === 'answer' &&
        r.data.report &&
        r.data.report.totals,
      JSON.stringify(r),
    );
    expect(String(r.data.title || '').includes('Podsumowanie'), JSON.stringify(r.data));
    return r.data.title;
  });
  let aiTaskId = null,
    aiTaskToken = null,
    aiExpenseId = null,
    aiAuditTaskIds = [],
    aiFilledPaymentIds = [];
  await check('POST /api/assistant/execute creates task', async () => {
    const parsed = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'dodaj zadanie sprawdzić licznik prądu',
    });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    aiTaskToken = parsed.data.action.token;
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.task && r.data.task.title.includes('sprawdzi'), JSON.stringify(r));
    aiTaskId = r.data.task.id;
    return `task=${aiTaskId}`;
  });
  await check('POST /api/assistant/execute rejects replayed token', async () => {
    const r = await api('POST', '/api/assistant/execute', { token: aiTaskToken });
    expect(r.status === 409 && r.data.error === 'action_already_executed', JSON.stringify(r));
    return r.data.error;
  });
  await check('POST /api/assistant/execute adds expense', async () => {
    const parsed = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'dodaj koszt prąd 123 zł',
    });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.expense && Number(r.data.expense.amount) === 123, JSON.stringify(r));
    aiExpenseId = r.data.expense.id;
    return `expense=${aiExpenseId}`;
  });
  await check('POST /api/assistant/execute creates audit tasks', async () => {
    const parsed = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: 'utwórz zadania z audytu 2026',
    });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && Array.isArray(r.data.tasks) && r.data.tasks.length > 0, JSON.stringify(r));
    aiAuditTaskIds = r.data.tasks.map((t) => t.id);
    return `${aiAuditTaskIds.length} zadań`;
  });
  await check('POST /api/assistant/execute fills missing property payments', async () => {
    const name = `__smoke_ai_fill_${Date.now()}`;
    const fixture = await createAiPaymentFixture(name, {
      period: '2026-04',
      status: 'paid',
      totalPaid: 1333,
      code: 'FIL',
    });
    const parsed = await api('POST', '/api/assistant/parse', {
      period: '2026-05',
      message: `uzupełnij brakujące wpływy z ${name}_property za 2026 r.`,
    });
    expect(
      parsed.ok && parsed.data.action && parsed.data.action.token && parsed.data.items.length >= 1,
      JSON.stringify(parsed),
    );
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.result && r.data.result.created.length >= 1, JSON.stringify(r));
    aiFilledPaymentIds = r.data.result.created.map((row) => row.id);
    aiFilledPaymentIds.forEach((paymentId) => aiFixtures.push({ paymentId }));
    return `${r.data.result.created.length} płatności`;
  });
  await check('DEL  AI assistant fixtures', async () => {
    if (aiTaskId) await api('DELETE', `/api/tasks/${aiTaskId}`).catch(() => {});
    if (aiExpenseId) await api('DELETE', `/api/expenses/${aiExpenseId}`).catch(() => {});
    for (const id of aiAuditTaskIds.reverse()) await api('DELETE', `/api/tasks/${id}`).catch(() => {});
    for (const id of aiAliasIds.reverse())
      await api('DELETE', `/api/assistant/aliases/${id}`).catch(() => {});
    for (const fixture of aiFixtures.reverse()) {
      if (fixture.paymentId) await api('DELETE', `/api/payments/${fixture.paymentId}`).catch(() => {});
      if (fixture.tenantId) await api('DELETE', `/api/tenants/${fixture.tenantId}`).catch(() => {});
      if (fixture.propertyId) await api('DELETE', `/api/properties/${fixture.propertyId}`).catch(() => {});
    }
    return 'ok';
  });

  console.log('\n══ CRUD: property ══');
  let propId = null;
  await check('POST /api/properties', async () => {
    const r = await api('POST', '/api/properties', {
      name: '__smoke_property',
      district: 'Test',
      type: 'inne',
    });
    expect(r.ok && r.data.id, JSON.stringify(r));
    propId = r.data.id;
    return `id=${propId}`;
  });
  await check('GET  /api/properties/:id', async () => {
    const r = await api('GET', `/api/properties/${propId}`);
    expect(r.ok && r.data.name === '__smoke_property', JSON.stringify(r));
    return 'ok';
  });
  await check('PUT  /api/settings/owner-costs/mortgage', async () => {
    const r = await api('PUT', '/api/settings/owner-costs/mortgage', {
      property_id: propId,
      valid_from_period: '2026-11',
      amount: 4321.09,
    });
    expect(r.ok && Number(r.data.amount) === 4321.09, JSON.stringify(r));
    const rows = await api(
      'GET',
      `/api/expenses?period=2026-11&category=kredyt&property_id=${propId}&include_owner=1`,
    );
    expect(
      rows.ok &&
        rows.data.some((row) => row.system && row.category === 'kredyt' && Number(row.amount) === 4321.09),
      JSON.stringify(rows),
    );
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
    const r = await api('POST', '/api/expenses', {
      category: 'inne',
      amount: 12.34,
      date: '2025-01-15',
      description: '__smoke',
    });
    expect(r.ok && r.data.id, JSON.stringify(r));
    expId = r.data.id;
    return `id=${expId}`;
  });
  await check('DEL  /api/expenses/:id', async () => {
    const r = await api('DELETE', `/api/expenses/${expId}`);
    expect(r.ok, JSON.stringify(r));
    return 'ok';
  });

  console.log('\n══ CONTRACT DOCUMENTS ══');
  let docPropId = null,
    docUnitId = null,
    docTenantId = null,
    docContractId = null,
    docId = null;
  await check('POST contract fixture', async () => {
    const prop = await api('POST', '/api/properties', {
      name: `__smoke_docs_${Date.now()}`,
      district: 'Test',
      type: 'mieszkanie',
    });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    docPropId = prop.data.id;
    const unit = await api('POST', '/api/units', {
      property_id: docPropId,
      name: 'Lokal testowy',
      code: 'D1',
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    docUnitId = unit.data.id;
    const tenant = await api('POST', '/api/tenants', { name: '__smoke_doc_tenant', status: 'active' });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    docTenantId = tenant.data.id;
    const contract = await api('POST', '/api/contracts', {
      tenant_id: docTenantId,
      unit_id: docUnitId,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      rent: 1000,
      media_advance: 200,
      deposit: 1200,
      pay_by_day: 10,
      status: 'active',
    });
    expect(contract.ok && contract.data.id, JSON.stringify(contract));
    docContractId = contract.data.id;
    return `contract=${docContractId}`;
  });
  await check('POST /api/contracts/:id/documents', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'signed.pdf');
    fd.append('name', 'Podpisana umowa smoke');
    const r = await fetch(BASE + `/api/contracts/${docContractId}/documents`, { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    expect(r.ok && data.id, `${r.status} ${JSON.stringify(data)}`);
    docId = data.id;
    return `doc=${docId}`;
  });
  await check('GET  /api/contracts/:id/documents', async () => {
    const r = await api('GET', `/api/contracts/${docContractId}/documents`);
    expect(r.ok && r.data.some((d) => d.id === docId), JSON.stringify(r));
    return `${r.data.length} dokumentów`;
  });
  await check('GET  /api/documents/:id/download', async () => {
    const r = await fetch(BASE + `/api/documents/${docId}/download`);
    expect(r.ok && (r.headers.get('content-type') || '').includes('application/pdf'), `status=${r.status}`);
    expect(
      (r.headers.get('content-disposition') || '').toLowerCase().includes('.pdf'),
      'download filename missing .pdf extension',
    );
    return `${(await r.arrayBuffer()).byteLength} bajtów`;
  });
  await check('DEL  contract document fixture', async () => {
    if (docId) expect((await api('DELETE', `/api/documents/${docId}`)).ok, 'doc delete failed');
    if (docContractId)
      expect((await api('DELETE', `/api/contracts/${docContractId}`)).ok, 'contract delete failed');
    if (docTenantId) expect((await api('DELETE', `/api/tenants/${docTenantId}`)).ok, 'tenant delete failed');
    if (docPropId) expect((await api('DELETE', `/api/properties/${docPropId}`)).ok, 'property delete failed');
    return 'ok';
  });

  console.log('\n══ CONTRACT AMENDMENTS ══');
  let amendmentPropId = null,
    amendmentUnitId = null,
    amendmentTenantId = null,
    amendmentContractId = null,
    secondAmendmentUnitId = null,
    secondAmendmentTenantId = null,
    secondAmendmentContractId = null,
    amendmentDraftId = null,
    amendmentSignedId = null,
    amendmentSecondSignedId = null;
  const amendmentDocumentIds = [];
  const amendmentPaymentPeriods = ['2098-01', '2098-02', '2098-04'];

  async function postAmendment(contractId, fields, file = null) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    if (file) form.append('file', new Blob([file.body], { type: file.type }), file.name);
    const response = await fetch(BASE + `/api/contracts/${contractId}/amendments`, {
      method: 'POST',
      body: form,
    });
    return {
      status: response.status,
      ok: response.ok,
      data: await response.json().catch(() => ({})),
    };
  }

  await check('POST contract amendments fixture', async () => {
    const property = await api('POST', '/api/properties', {
      name: `__smoke_amendments_${Date.now()}`,
      district: 'Test',
      type: 'mieszkanie',
    });
    expect(property.ok && property.data.id, JSON.stringify(property));
    amendmentPropId = property.data.id;
    const unit = await api('POST', '/api/units', {
      property_id: amendmentPropId,
      name: 'Lokal aneksowy',
      code: 'A1',
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    amendmentUnitId = unit.data.id;
    const tenant = await api('POST', '/api/tenants', { name: '__smoke_amendment_tenant', status: 'active' });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    amendmentTenantId = tenant.data.id;
    const contract = await api('POST', '/api/contracts', {
      tenant_id: amendmentTenantId,
      unit_id: amendmentUnitId,
      start_date: '2098-01-01',
      end_date: '2098-03-31',
      rent: 1000,
      media_advance: 200,
      deposit: 1200,
      pay_by_day: 10,
      status: 'active',
    });
    expect(contract.ok && contract.data.id, JSON.stringify(contract));
    amendmentContractId = contract.data.id;
    return `contract=${amendmentContractId}`;
  });
  await check('POST base contract document for amendment fixture', async () => {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'base.pdf');
    form.append('name', 'Umowa bazowa aneksy smoke');
    const response = await fetch(BASE + `/api/contracts/${amendmentContractId}/documents`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    expect(
      response.ok && data.id && data.category === 'umowa' && data.workflow_status === 'signed',
      JSON.stringify(data),
    );
    amendmentDocumentIds.push(data.id);
    return `doc=${data.id}`;
  });
  await check('POST draft amendment without file', async () => {
    const response = await postAmendment(amendmentContractId, {
      amendment_number: '1/A/2098',
      effective_date: '2098-01-01',
      status: 'draft',
      notes: 'Szkic aneksu bez zmiany warunków',
    });
    expect(
      response.ok && response.data.id && response.data.status === 'draft' && !response.data.document_id,
      JSON.stringify(response),
    );
    amendmentDraftId = response.data.id;
    return `amendment=${amendmentDraftId}`;
  });
  await check('GET draft does not change effective terms', async () => {
    const response = await api('GET', `/api/contracts/${amendmentContractId}?as_of=2098-01-10`);
    const terms = response.data.current_terms || {};
    expect(
      response.ok && terms.rent === 1000 && terms.media_advance === 200 && terms.pay_by_day === 10,
      JSON.stringify(response),
    );
    return 'warunki bazowe';
  });
  await check('PUT draft amendment updates editable data', async () => {
    const response = await api(
      'PUT',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentDraftId}`,
      {
        amendment_number: '1/A/2098',
        effective_date: '2098-01-01',
        new_end_date: '2098-03-31',
        rent: null,
        media_advance: null,
        pay_by_day: null,
        notes: 'Zmieniony szkic aneksu',
      },
    );
    expect(
      response.ok &&
        response.data.status === 'draft' &&
        response.data.new_end_date === '2098-03-31' &&
        response.data.notes === 'Zmieniony szkic aneksu',
      JSON.stringify(response),
    );
    return 'szkic zaktualizowany';
  });
  await check('POST amendment without change returns readable validation', async () => {
    const response = await postAmendment(
      amendmentContractId,
      {
        amendment_number: 'empty/A/2098',
        signed_date: '2098-01-10',
        effective_date: '2098-01-10',
        status: 'signed',
      },
      { name: 'empty-amendment.pdf', type: 'application/pdf', body: '%PDF-1.4\n%%EOF' },
    );
    expect(
      response.status === 400 && response.data.error === 'amendment_change_or_note_required',
      JSON.stringify(response),
    );
    return 'czytelny błąd walidacji';
  });
  await check('POST invalid amendment file signature → 400', async () => {
    const response = await postAmendment(
      amendmentContractId,
      {
        amendment_number: 'invalid/A/2098',
        effective_date: '2098-01-02',
        status: 'draft',
        notes: 'Nieprawidłowy plik testowy',
      },
      { name: 'not-a-pdf.pdf', type: 'application/pdf', body: 'to nie jest PDF' },
    );
    expect(
      response.status === 400 && response.data.error === 'invalid_file_signature',
      JSON.stringify(response),
    );
    return 'odrzucono';
  });
  await check('POST signed amendment without file → 400', async () => {
    const response = await postAmendment(amendmentContractId, {
      amendment_number: '2/A/2098',
      signed_date: '2098-01-20',
      effective_date: '2098-01-15',
      new_end_date: '2098-04-30',
      status: 'signed',
    });
    expect(
      response.status === 400 && response.data.error === 'signed_amendment_document_required',
      JSON.stringify(response),
    );
    return 'odrzucono';
  });
  await check('POST /api/payments/generate-month before signed terms', async () => {
    const response = await api('POST', '/api/payments/generate-month', { period: '2098-01' });
    expect(response.ok, JSON.stringify(response));
    const payments = await api('GET', '/api/payments?period=2098-01');
    const payment = payments.data.find((item) => item.tenant_id === amendmentTenantId);
    expect(
      payments.ok &&
        payment &&
        payment.rent_amount === 1000 &&
        payment.media_amount === 200 &&
        payment.due_day === 10,
      JSON.stringify(payments),
    );
    return `payment=${payment.id}`;
  });
  await check('POST attachment and sign existing draft amendment', async () => {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'draft-signed.pdf');
    const uploaded = await fetch(
      BASE + `/api/contracts/${amendmentContractId}/amendments/${amendmentDraftId}/document`,
      { method: 'POST', body: form },
    );
    const uploadedData = await uploaded.json().catch(() => ({}));
    expect(uploaded.ok && uploadedData.document_id, JSON.stringify(uploadedData));
    amendmentDocumentIds.push(uploadedData.document_id);
    const signed = await api(
      'POST',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentDraftId}/sign`,
      {
        signed_date: '2098-01-12',
      },
    );
    expect(signed.ok && signed.data.status === 'signed', JSON.stringify(signed));
    return `doc=${uploadedData.document_id}`;
  });
  await check('POST signed amendment with changed terms', async () => {
    const response = await postAmendment(
      amendmentContractId,
      {
        amendment_number: '2/A/2098',
        signed_date: '2098-01-20',
        effective_date: '2098-01-15',
        new_end_date: '2098-04-30',
        rent: 1350,
        media_advance: 250,
        pay_by_day: 15,
        status: 'signed',
      },
      { name: 'signed-amendment.pdf', type: 'application/pdf', body: '%PDF-1.4\n%%EOF' },
    );
    expect(
      response.ok && response.data.id && response.data.status === 'signed' && response.data.document_id,
      JSON.stringify(response),
    );
    amendmentSignedId = response.data.id;
    amendmentDocumentIds.push(response.data.document_id);
    const document = await api('GET', `/api/documents/${response.data.document_id}`);
    expect(
      document.ok && document.data.category === 'aneks' && document.data.workflow_status === 'signed',
      JSON.stringify(document),
    );
    return `amendment=${amendmentSignedId}`;
  });
  await check('GET projected end date includes future signed extension', async () => {
    const contract = await api('GET', `/api/contracts/${amendmentContractId}?as_of=2098-01-10`);
    const tenants = await api('GET', '/api/tenants?status=active');
    const tenant = tenants.data.find((item) => item.id === amendmentTenantId);
    expect(
      contract.ok &&
        contract.data.current_terms.end_date === '2098-03-31' &&
        contract.data.projected_terms.end_date === '2098-04-30' &&
        tenant?.contract_end === '2098-04-30',
      JSON.stringify({ contract, tenant }),
    );
    return 'status używa podpisanego przedłużenia';
  });
  await check('PUT signed amendment allows complete correction', async () => {
    const response = await api(
      'PUT',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentSignedId}`,
      {
        amendment_number: '2/A/2098-korekta',
        name: 'Skorygowany aneks smoke',
        signed_date: '2098-01-21',
        effective_date: '2098-01-16',
        new_end_date: '2098-04-29',
        rent: 1360,
        media_advance: 260,
        pay_by_day: 16,
        notes: 'Poprawiona data podpisania',
      },
    );
    expect(
      response.ok &&
        response.data.status === 'signed' &&
        response.data.amendment_number === '2/A/2098-korekta' &&
        response.data.name === 'Skorygowany aneks smoke' &&
        response.data.signed_date === '2098-01-21' &&
        response.data.effective_date === '2098-01-16' &&
        response.data.rent === 1360 &&
        response.data.media_advance === 260 &&
        response.data.pay_by_day === 16 &&
        response.data.notes === 'Poprawiona data podpisania' &&
        response.data.new_end_date === '2098-04-29',
      JSON.stringify(response),
    );
    const correctedDocument = await api('GET', `/api/documents/${response.data.document_id}`);
    expect(
      correctedDocument.ok &&
        correctedDocument.data.name === 'Skorygowany aneks smoke' &&
        correctedDocument.data.document_number === '2/A/2098-korekta',
      JSON.stringify(correctedDocument),
    );
    const restored = await api(
      'PUT',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentSignedId}`,
      {
        amendment_number: '2/A/2098',
        name: 'Aneks nr 2/A/2098',
        signed_date: '2098-01-20',
        effective_date: '2098-01-15',
        new_end_date: '2098-04-30',
        rent: 1350,
        media_advance: 250,
        pay_by_day: 15,
        notes: null,
      },
    );
    expect(restored.ok && restored.data.new_end_date === '2098-04-30', JSON.stringify(restored));
    return 'wszystkie pola poprawione';
  });

  await check('POST replacement file for signed amendment archives previous version', async () => {
    const before = (
      await api('GET', `/api/contracts/${amendmentContractId}/amendments`)
    ).data.amendments.find((item) => item.id === amendmentSignedId);
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'replacement.pdf');
    form.append('name', 'Aneks nr 2/A/2098');
    const response = await fetch(
      BASE + `/api/contracts/${amendmentContractId}/amendments/${amendmentSignedId}/document`,
      { method: 'POST', body: form },
    );
    const data = await response.json().catch(() => ({}));
    expect(response.ok && data.document_id !== before.document_id, JSON.stringify(data));
    amendmentDocumentIds.push(data.document_id);
    const previous = await api('GET', `/api/documents/${before.document_id}`);
    const replacement = await api('GET', `/api/documents/${data.document_id}`);
    expect(
      previous.ok &&
        previous.data.workflow_status === 'archived' &&
        replacement.ok &&
        replacement.data.workflow_status === 'signed',
      JSON.stringify({ previous, replacement, data }),
    );
    return `doc=${data.document_id}`;
  });
  await check('POST second signed amendment uses effective-date order', async () => {
    const response = await postAmendment(
      amendmentContractId,
      {
        amendment_number: '3/A/2098',
        signed_date: '2098-01-25',
        effective_date: '2098-02-01',
        media_advance: 300,
        status: 'signed',
      },
      { name: 'second-amendment.pdf', type: 'application/pdf', body: '%PDF-1.4\n%%EOF' },
    );
    expect(response.ok && response.data.id && response.data.status === 'signed', JSON.stringify(response));
    amendmentSecondSignedId = response.data.id;
    amendmentDocumentIds.push(response.data.document_id);
    return `amendment=${amendmentSecondSignedId}`;
  });
  await check('POST duplicate amendment number → 409', async () => {
    const response = await postAmendment(amendmentContractId, {
      amendment_number: '2/A/2098',
      effective_date: '2098-02-02',
      status: 'draft',
      notes: 'Duplikat',
    });
    expect(
      response.status === 409 && response.data.error === 'amendment_number_exists',
      JSON.stringify(response),
    );
    return 'konflikt wykryty';
  });
  await check('GET amendments preserves chronology and base checklist', async () => {
    const amendments = await api('GET', `/api/contracts/${amendmentContractId}/amendments`);
    expect(
      amendments.ok &&
        amendments.data.amendments.map((item) => item.amendment_number).join(',') ===
          '1/A/2098,2/A/2098,3/A/2098',
      JSON.stringify(amendments),
    );
    const workflow = await api('GET', `/api/contracts/${amendmentContractId}/workflow`);
    const signedBase = workflow.data.checklist.find((item) => item.key === 'signed_contract');
    expect(workflow.ok && signedBase && signedBase.complete, JSON.stringify(workflow));
    return 'kolejność oraz umowa bazowa';
  });
  await check('GET terms after signed amendment and existing payment remains unchanged', async () => {
    const contract = await api('GET', `/api/contracts/${amendmentContractId}?as_of=2098-01-31`);
    const terms = contract.data.current_terms || {};
    expect(
      contract.ok &&
        terms.rent === 1350 &&
        terms.media_advance === 250 &&
        terms.pay_by_day === 15 &&
        terms.end_date === '2098-04-30',
      JSON.stringify(contract),
    );
    const regenerated = await api('POST', '/api/payments/generate-month', { period: '2098-01' });
    expect(regenerated.ok, JSON.stringify(regenerated));
    const payments = await api('GET', '/api/payments?period=2098-01');
    const payment = payments.data.find((item) => item.tenant_id === amendmentTenantId);
    expect(
      payment && payment.rent_amount === 1000 && payment.media_amount === 200 && payment.due_day === 10,
      JSON.stringify(payments),
    );
    return 'płatność historyczna bez zmian';
  });
  await check('POST future periods use signed amendment terms', async () => {
    for (const period of ['2098-02', '2098-04']) {
      const generated = await api('POST', '/api/payments/generate-month', { period });
      expect(generated.ok, JSON.stringify(generated));
      const payments = await api('GET', `/api/payments?period=${period}`);
      const payment = payments.data.find((item) => item.tenant_id === amendmentTenantId);
      expect(
        payment && payment.rent_amount === 1350 && payment.media_amount === 300 && payment.due_day === 15,
        `${period}: ${JSON.stringify(payments)}`,
      );
    }
    return 'luty i kwiecień';
  });
  await check('GET extended contract appears in expiry alert query', async () => {
    const response = await api('GET', `/api/contracts?status=active&as_of=2098-04-01&ending_within_days=30`);
    expect(
      response.ok && response.data.some((item) => item.id === amendmentContractId),
      JSON.stringify(response),
    );
    return 'widoczny do 30.04.2098';
  });
  await check('PUT signed amendment can clear and restore a changed term', async () => {
    const response = await api(
      'PUT',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentSignedId}`,
      {
        pay_by_day: null,
      },
    );
    expect(response.ok && response.data.pay_by_day === null, JSON.stringify(response));
    const restored = await api(
      'PUT',
      `/api/contracts/${amendmentContractId}/amendments/${amendmentSignedId}`,
      { pay_by_day: 15 },
    );
    expect(restored.ok && restored.data.pay_by_day === 15, JSON.stringify(restored));
    return 'wartość opcjonalna poprawiona';
  });
  await check('DELETE signed annex document keeps applied terms', async () => {
    const amendment = (
      await api('GET', `/api/contracts/${amendmentContractId}/amendments`)
    ).data.amendments.find((item) => item.id === amendmentSignedId);
    expect(amendment && amendment.document_id, JSON.stringify(amendment));
    const deleted = await api('DELETE', `/api/documents/${amendment.document_id}`);
    expect(deleted.ok, JSON.stringify(deleted));
    const contract = await api('GET', `/api/contracts/${amendmentContractId}?as_of=2098-02-28`);
    const terms = contract.data.current_terms || {};
    const history = await api('GET', `/api/contracts/${amendmentContractId}/amendments`);
    const removedFile = history.data.amendments.find((item) => item.id === amendmentSignedId);
    expect(
      terms.rent === 1350 && terms.media_advance === 300 && removedFile && !removedFile.document_id,
      JSON.stringify({ contract, history }),
    );
    return 'historia zachowana';
  });
  await check('POST same amendment number on another contract', async () => {
    const unit = await api('POST', '/api/units', {
      property_id: amendmentPropId,
      name: 'Drugi lokal aneksowy',
      code: 'A2',
      status: 'vacant',
    });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    secondAmendmentUnitId = unit.data.id;
    const tenant = await api('POST', '/api/tenants', {
      name: '__smoke_amendment_tenant_2',
      status: 'active',
    });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    secondAmendmentTenantId = tenant.data.id;
    const contract = await api('POST', '/api/contracts', {
      tenant_id: secondAmendmentTenantId,
      unit_id: secondAmendmentUnitId,
      start_date: '2098-01-01',
      end_date: '2098-12-31',
      rent: 900,
      media_advance: 100,
      pay_by_day: 10,
      status: 'active',
    });
    expect(contract.ok && contract.data.id, JSON.stringify(contract));
    secondAmendmentContractId = contract.data.id;
    const response = await postAmendment(
      secondAmendmentContractId,
      {
        amendment_number: '2/A/2098',
        signed_date: '2098-01-20',
        effective_date: '2098-01-15',
        rent: 950,
        status: 'signed',
      },
      { name: 'same-number.pdf', type: 'application/pdf', body: '%PDF-1.4\n%%EOF' },
    );
    expect(response.ok && response.data.id && response.data.document_id, JSON.stringify(response));
    amendmentDocumentIds.push(response.data.document_id);
    const workflow = await api('GET', `/api/contracts/${secondAmendmentContractId}/workflow`);
    const signedBase = workflow.data.checklist.find((item) => item.key === 'signed_contract');
    expect(workflow.ok && signedBase && !signedBase.complete, JSON.stringify(workflow));
    return `contract=${secondAmendmentContractId}`;
  });
  await check('POST amendment for inactive contract → 409', async () => {
    const ended = await api('PUT', `/api/contracts/${secondAmendmentContractId}`, { status: 'ended' });
    expect(ended.ok && ended.data.status === 'ended', JSON.stringify(ended));
    const response = await postAmendment(secondAmendmentContractId, {
      amendment_number: '3/A/2098',
      effective_date: '2098-03-01',
      notes: 'Nie powinien powstać',
      status: 'draft',
    });
    expect(
      response.status === 409 && response.data.error === 'amendment_requires_active_contract',
      JSON.stringify(response),
    );
    return 'nieaktywna umowa zablokowana';
  });
  await check('GET tenant rental documents groups contract and annexes', async () => {
    const tenant = await api('GET', `/api/tenants/${amendmentTenantId}`);
    const group = (tenant.data.rental_documents || []).find(
      (item) => item.contract.id === amendmentContractId,
    );
    expect(
      tenant.ok &&
        group &&
        group.documents.some((document) => document.category === 'umowa') &&
        group.amendments.length === 3,
      JSON.stringify(tenant),
    );
    return 'umowa + 3 aneksy';
  });
  await check('DEL  contract amendments fixtures', async () => {
    for (const period of amendmentPaymentPeriods) {
      const payments = await api('GET', `/api/payments?period=${period}`).catch(() => ({ data: [] }));
      for (const payment of (payments.data || []).filter((item) => item.tenant_id === amendmentTenantId)) {
        await api('DELETE', `/api/payments/${payment.id}`).catch(() => {});
      }
    }
    for (const documentId of [...new Set(amendmentDocumentIds)].reverse()) {
      await api('DELETE', `/api/documents/${documentId}`).catch(() => {});
    }
    if (secondAmendmentContractId)
      await api('DELETE', `/api/contracts/${secondAmendmentContractId}`).catch(() => {});
    if (amendmentContractId) await api('DELETE', `/api/contracts/${amendmentContractId}`).catch(() => {});
    if (secondAmendmentTenantId)
      await api('DELETE', `/api/tenants/${secondAmendmentTenantId}`).catch(() => {});
    if (amendmentTenantId) await api('DELETE', `/api/tenants/${amendmentTenantId}`).catch(() => {});
    if (amendmentPropId) await api('DELETE', `/api/properties/${amendmentPropId}`).catch(() => {});
    return 'ok';
  });

  console.log('\n══ EKSPORT ══');
  await check('GET  /api/export/payments.csv?period=2025-01', async () => {
    const r = await fetch(BASE + '/api/export/payments.csv?period=2025-01');
    expect(r.ok && r.headers.get('content-type').includes('text/csv'), `status=${r.status}`);
    const txt = await r.text();
    return `${txt.split('\n').length - 1} linii CSV`;
  });
  await check('GET  /api/export/report.pdf?period=2025-01', async () => {
    const r = await fetch(BASE + '/api/export/report.pdf?period=2025-01');
    expect(r.ok && r.headers.get('content-type').includes('application/pdf'), `status=${r.status}`);
    expect((r.headers.get('cache-control') || '').includes('no-store'), 'PDF must not be cached');
    const buf = await r.arrayBuffer();
    expect(buf.byteLength > 10_000, `PDF too small, fonts may not be embedded: ${buf.byteLength} bytes`);
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
    const r = await api('POST', '/api/properties', { type: 'inne' });
    expect(r.status === 400 && r.data.error === 'validation_error', JSON.stringify(r));
    return 'walidacja działa';
  });

  // wynik
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.log(`\n══════ ${ok}/${results.length} OK · ${failed} błędów ══════`);
  if (failed > 0) {
    console.log('\nBłędy:');
    for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}: ${r.info}`);
  }

  await stopServerAndCleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  stopServerAndCleanup()
    .catch((cleanupErr) => console.error('Cleanup failed:', cleanupErr.message))
    .finally(() => process.exit(1));
});

process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
