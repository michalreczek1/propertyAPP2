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
    const r = await api('PUT', `/api/tenants/${tenantId}`, { phone: '+48 600 000 000', sms_consent: 1, sms_disabled: 0, notes: 'smoke' });
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

  console.log('\n══ LATE PAYMENT FEES ══');
  let lateTenantId = null, latePaymentId = null;
  await check('POST late paid payment adds 50 zł fee', async () => {
    const tenant = await api('POST', '/api/tenants', { name:'__smoke_late_fee_tenant', status:'active' });
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
    const r = await api('PUT', `/api/payments/${latePaymentId}/late-fee`, { action: 'deposit', note: 'smoke' });
    expect(r.ok && r.data.total_paid === 120 && r.data.late_fee_paid === 50 && r.data.late_fee_resolution === 'deposit' && r.data.late_fee_balance === 0, JSON.stringify(r));
    const t = await api('GET', `/api/tenants/${lateTenantId}`);
    expect(t.ok && t.data.late_fee_summary.total === 50 && t.data.late_fee_summary.balance === 0 && t.data.late_fees[0].resolution === 'deposit', JSON.stringify(t));
    return 'ok';
  });
  await check('DEL  late payment fixture', async () => {
    if (latePaymentId) expect((await api('DELETE', `/api/payments/${latePaymentId}`)).ok, 'payment delete failed');
    if (lateTenantId) expect((await api('DELETE', `/api/tenants/${lateTenantId}`)).ok, 'tenant delete failed');
    return 'ok';
  });

  console.log('\n══ PAYMENT DUE DATES ══');
  let dueTenantId = null, duePaymentId = null;
  await check('PUT payment due_day recalculates due_date', async () => {
    const tenant = await api('POST', '/api/tenants', { name:'__smoke_due_date_tenant', status:'active' });
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
    expect(updated.ok && updated.data.due_day === 31 && updated.data.due_date === '2026-04-30', JSON.stringify(updated));
    return updated.data.due_date;
  });
  await check('DEL  due date fixture', async () => {
    if (duePaymentId) expect((await api('DELETE', `/api/payments/${duePaymentId}`)).ok, 'payment delete failed');
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
    const r = await api('POST', '/api/notifications/run', { type: 'all', dry_run: true, today: '2026-04-01' });
    expect(r.ok && r.data.dry_run === true && Array.isArray(r.data.candidates), JSON.stringify(r));
    return `${r.data.candidates.length} kandydatów`;
  });

  console.log('\n══ AI ASSISTANT ══');
  const aiFixtures = [];
  const aiAliasIds = [];
  async function createAiPaymentFixture(name, opts = {}) {
    const prop = await api('POST', '/api/properties', { name: `${name}_property`, district: 'AI', type: 'mieszkanie' });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    const unit = await api('POST', '/api/units', { property_id: prop.data.id, name: `${name}_unit`, code: opts.code || 'AI', base_rent: 1000, base_media: 200, status: 'vacant' });
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
    const fixture = { propertyId: prop.data.id, unitId: unit.data.id, tenantId: tenant.data.id, paymentId: payment.data.id };
    aiFixtures.push(fixture);
    return fixture;
  }

  let aiPaidFixture = null, aiSmsFixture = null, aiBlockedFixture = null;
  await check('POST /api/assistant/parse mark payment', async () => {
    aiPaidFixture = await createAiPaymentFixture(`__smoke_ai_kowalski_${Date.now()}`);
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: `${Date.now()} kowalski zapłacił` });
    if (!r.ok || !r.data.action) {
      const retry = await api('POST', '/api/assistant/parse', { period: '2026-05', message: `__smoke_ai_kowalski zapłacił` });
      expect(retry.ok && retry.data.intent === 'mark_payment_paid' && retry.data.action && retry.data.action.token, JSON.stringify(retry));
      return retry.data.intent;
    }
    expect(r.data.intent === 'mark_payment_paid' && r.data.action.token, JSON.stringify(r));
    return r.data.intent;
  });
  await check('POST /api/assistant/execute marks paid', async () => {
    const parsed = await api('POST', '/api/assistant/parse', { period: '2026-05', message: `__smoke_ai_kowalski zapłacił` });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.payment.status === 'paid', JSON.stringify(r));
    return r.data.payment.status;
  });
  await check('POST /api/assistant/parse tax explain', async () => {
    const [assistant, dash] = await Promise.all([
      api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ile wynosi podatek za ten miesiąc' }),
      api('GET', '/api/dashboard?period=2026-05'),
    ]);
    expect(assistant.ok && assistant.data.intent === 'explain_tax' && assistant.data.tax, JSON.stringify(assistant));
    expect(dash.ok && assistant.data.tax.podatek_suma === dash.data.tax.podatek_suma, JSON.stringify({ assistant, dash }));
    return `${assistant.data.tax.podatek_suma} zł`;
  });
  await check('POST /api/assistant/parse paid status question', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_status_${Date.now()}`, { period: '2026-04', status: 'paid', totalPaid: 1200, code: 'STAT' });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: `czy __smoke_ai_status zapłacił za kwiecień?` });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && !r.data.action, JSON.stringify(r));
    expect(/Tak/i.test(r.data.message) && r.data.payment && r.data.payment.status === 'paid', JSON.stringify(r.data));
    return r.data.message;
  });
  await check('POST /api/assistant/parse tenant payment yearly summary', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_roczny_${Date.now()}`, { period: '2026-04', status: 'paid', totalPaid: 1200, code: 'YR' });
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
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: `ile w tym roku zapłacił __smoke_ai_roczny` });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report, JSON.stringify(r));
    expect(r.data.report.range && r.data.report.range.start === '2026-01' && r.data.report.range.end === '2026-05', JSON.stringify(r.data.report));
    expect(r.data.report.paid >= 2100 && r.data.report.paid < 7000 && r.data.report.count === 2, JSON.stringify(r.data));
    return `${r.data.report.paid} zł`;
  });
  await check('POST /api/assistant/parse global current-year income summary', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ile zarobiłem w 2026 r.' });
    expect(r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report, JSON.stringify(r));
    expect(r.data.report.metric === 'net_income' && r.data.report.range && r.data.report.range.start === '2026-01' && r.data.report.range.end === '2026-05', JSON.stringify(r.data));
    expect(!String(r.data.title || '').startsWith('Wynik netto maj 2026'), JSON.stringify(r.data));
    return `${r.data.report.net} zł`;
  });
  await check('POST /api/assistant/aliases property and metric aliases', async () => {
    const fixture = await createAiPaymentFixture(`__smoke_ai_alias_${Date.now()}`, { period: '2026-05', status: 'paid', totalPaid: 1200, code: 'AL' });
    const propertyAlias = await api('POST', '/api/assistant/aliases', { alias: '__smoke tajna baza', resolves_to_type: 'property', resolves_to_id: fixture.propertyId });
    expect(propertyAlias.ok && propertyAlias.data.id, JSON.stringify(propertyAlias));
    aiAliasIds.push(propertyAlias.data.id);
    const metricAlias = await api('POST', '/api/assistant/aliases', { alias: '__smoke test mamony', resolves_to_type: 'metric', resolves_to_value: 'revenue_paid' });
    expect(metricAlias.ok && metricAlias.data.id, JSON.stringify(metricAlias));
    aiAliasIds.push(metricAlias.data.id);
    const propertyAnswer = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'podaj dochód z __smoke tajna baza za 2026 r.' });
    expect(propertyAnswer.ok && propertyAnswer.data.report && Number(propertyAnswer.data.report.property_id) === Number(fixture.propertyId), JSON.stringify(propertyAnswer));
    const metricAnswer = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ile __smoke test mamony w 2026 r.' });
    expect(metricAnswer.ok && metricAnswer.data.report && metricAnswer.data.report.metric === 'revenue_paid', JSON.stringify(metricAnswer));
    return `${propertyAlias.data.alias} / ${metricAlias.data.alias}`;
  });
  await check('POST /api/assistant/parse tax yearly summary', async () => {
    const [assistant, taxYear] = await Promise.all([
      api('POST', '/api/assistant/parse', { period: '2026-05', message: 'podsumuj ile podatku zapłaciłem w tym roku' }),
      api('GET', '/api/reports/tax-yearly?year=2026'),
    ]);
    expect(assistant.ok && assistant.data.intent === 'report_answer' && assistant.data.status === 'answer' && assistant.data.report, JSON.stringify(assistant));
    const includedMonths = assistant.data.report.range.periods || [];
    const expectedTax = includedMonths.reduce((sum, period) => {
      const monthIndex = Number(String(period).slice(5, 7)) - 1;
      return sum + Number(taxYear.data.tax_paid.values[monthIndex] || 0);
    }, 0);
    expect(taxYear.ok && assistant.data.report.range.end === '2026-05' && Math.round(assistant.data.report.tax_total) === Math.round(expectedTax), JSON.stringify({ assistant, taxYear, expectedTax }));
    return `${assistant.data.report.tax_total} zł`;
  });
  await check('POST /api/assistant/parse tenant count previous year by property', async () => {
    const prop = await api('POST', '/api/properties', { name: `__smoke_ai_Lawendowa_${Date.now()}`, district: 'AI', type: 'mieszkanie' });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    const unit = await api('POST', '/api/units', { property_id: prop.data.id, name: '__smoke_ai_ch_unit', code: 'CH', base_rent: 1000, base_media: 100, status: 'vacant' });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    const tenant = await api('POST', '/api/tenants', { name: `__smoke_ai_ch_tenant_${Date.now()}`, current_unit_id: unit.data.id, status: 'active' });
    expect(tenant.ok && tenant.data.id, JSON.stringify(tenant));
    const payment = await api('POST', '/api/payments', { period: '2025-06', tenant_id: tenant.data.id, unit_id: unit.data.id, due_day: 10, rent_amount: 1000, media_amount: 100, total_paid: 1100, status: 'paid', source: 'smoke-ai' });
    expect(payment.ok && payment.data.id, JSON.stringify(payment));
    aiFixtures.push({ propertyId: prop.data.id, tenantId: tenant.data.id, paymentId: payment.data.id });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ilu miałem najemców na Lawendowej w zeszłym roku?' });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report && r.data.report.count >= 1, JSON.stringify(r));
    return `${r.data.report.count} najemców`;
  });
  await check('POST /api/assistant/parse inflected property tenant count', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ilu miałem najemców na Kościelnej w zeszłym roku?' });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report, JSON.stringify(r));
    expect(String(r.data.title || '').toLowerCase().includes('kościelna') || String(r.data.title || '').toLowerCase().includes('koscielna'), JSON.stringify(r.data));
    return r.data.title;
  });
  await check('POST /api/assistant/parse property income yearly summary', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'podaj sumę dochodów z chrobrego za 2025 r.' });
    expect(r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report, JSON.stringify(r));
    expect(String(r.data.report.property_name || '').toLowerCase().includes('chrobrego'), JSON.stringify(r.data));
    expect(r.data.report.range && r.data.report.range.start === '2025-01' && r.data.report.range.end === '2025-12', JSON.stringify(r.data.report));
    expect(Number(r.data.report.revenue || 0) >= 0 && !String(r.data.title || '').includes('maj 2026'), JSON.stringify(r.data));
    return `${r.data.report.property_name}: ${r.data.report.revenue} zł`;
  });
  await check('POST /api/assistant/parse SMS preview', async () => {
    aiSmsFixture = await createAiPaymentFixture(`__smoke_ai_sms_${Date.now()}`, { smsConsent: true, code: 'SMS' });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: '__smoke_ai_sms wyślij SMS z przypomnieniem' });
    expect(r.ok && r.data.intent === 'send_sms_reminder' && r.data.preview && r.data.preview.message && r.data.action, JSON.stringify(r));
    return r.data.preview.test_mode ? 'test-mode preview' : 'preview';
  });
  await check('POST /api/assistant/parse SMS blocks missing consent', async () => {
    aiBlockedFixture = await createAiPaymentFixture(`__smoke_ai_bez_zgody_${Date.now()}`, { smsConsent: false, code: 'NO' });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: '__smoke_ai_bez_zgody wyślij SMS z przypomnieniem' });
    expect(r.ok && r.data.status === 'blocked' && r.data.reason === 'sms_consent_required', JSON.stringify(r));
    return r.data.reason;
  });
  await check('POST /api/assistant/parse ambiguous tenant', async () => {
    await createAiPaymentFixture(`__smoke_ai_duplikat_A_${Date.now()}`, { code: 'D1' });
    await createAiPaymentFixture(`__smoke_ai_duplikat_B_${Date.now()}`, { code: 'D2' });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: '__smoke_ai_duplikat zapłacił' });
    expect(r.ok && r.data.status === 'clarify' && Array.isArray(r.data.candidates) && r.data.candidates.length >= 2, JSON.stringify(r));
    return `${r.data.candidates.length} kandydatów`;
  });
  await check('POST /api/assistant/parse global search results', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'szukaj __smoke_ai_sms' });
    expect(r.ok && ['search_global','navigate_to_entity'].includes(r.data.intent) && Array.isArray(r.data.items), JSON.stringify(r));
    expect(r.data.items.some(item => String(item.title || '').includes('__smoke_ai_sms')), JSON.stringify(r.data));
    return `${r.data.items.length} wyników`;
  });
  await check('POST /api/assistant/parse payment filter navigation', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'pokaż tylko zaległości' });
    expect(r.ok && r.data.status === 'navigate' && r.data.navigation.view === 'platnosci' && r.data.navigation.state.paymentsFilter === 'overdue', JSON.stringify(r));
    return r.data.navigation.view;
  });
  await check('POST /api/assistant/parse finance answer', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'ile zarobiłem netto w tym miesiącu?' });
    expect(r.ok && r.data.intent === 'report_answer' && r.data.status === 'answer' && r.data.report, JSON.stringify(r));
    return r.data.title;
  });
  await check('POST /api/assistant/parse late fee report', async () => {
    await createAiPaymentFixture(`__smoke_ai_kary_${Date.now()}`, { code: 'KAR', lateFeeAmount: 50, lateFeePaid: 20 });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'zrób zestawienie kar najemców' });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report && r.data.report.total >= 50, JSON.stringify(r));
    expect(Array.isArray(r.data.items) && r.data.items.some(item => String(item.title || '').includes('__smoke_ai_kary')), JSON.stringify(r.data));
    return `${r.data.report.total} zł`;
  });
  await check('POST /api/assistant/parse flexible unpaid penalties question', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'którzy najemcy mają nierozliczone kary?' });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report && r.data.report.balance >= 30, JSON.stringify(r));
    expect(Array.isArray(r.data.items) && r.data.items.some(item => String(item.title || '').includes('__smoke_ai_kary')), JSON.stringify(r.data));
    return `${r.data.report.balance} zł`;
  });
  await check('POST /api/assistant/parse flexible overdue payments question', async () => {
    await createAiPaymentFixture(`__smoke_ai_zalega_${Date.now()}`, { code: 'OVD', status: 'overdue' });
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'kto zalega z płatnościami?' });
    expect(r.ok && r.data.intent === 'answer_from_data' && r.data.status === 'answer' && r.data.report && r.data.report.count >= 1, JSON.stringify(r));
    expect(Array.isArray(r.data.items) && r.data.items.some(item => String(item.title || '').includes('__smoke_ai_zalega')), JSON.stringify(r.data));
    return `${r.data.report.count} płatności`;
  });
  await check('POST /api/assistant/parse data quality audit', async () => {
    const r = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'sprawdź błędy w danych' });
    expect(r.ok && r.data.intent === 'data_quality_check' && Array.isArray(r.data.checks), JSON.stringify(r));
    return `${r.data.checks.length} kontroli`;
  });
  let aiTaskId = null, aiExpenseId = null;
  await check('POST /api/assistant/execute creates task', async () => {
    const parsed = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'dodaj zadanie sprawdzić licznik prądu' });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.task && r.data.task.title.includes('sprawdzi'), JSON.stringify(r));
    aiTaskId = r.data.task.id;
    return `task=${aiTaskId}`;
  });
  await check('POST /api/assistant/execute adds expense', async () => {
    const parsed = await api('POST', '/api/assistant/parse', { period: '2026-05', message: 'dodaj koszt prąd 123 zł' });
    expect(parsed.ok && parsed.data.action && parsed.data.action.token, JSON.stringify(parsed));
    const r = await api('POST', '/api/assistant/execute', { token: parsed.data.action.token });
    expect(r.ok && r.data.expense && Number(r.data.expense.amount) === 123, JSON.stringify(r));
    aiExpenseId = r.data.expense.id;
    return `expense=${aiExpenseId}`;
  });
  await check('DEL  AI assistant fixtures', async () => {
    if (aiTaskId) await api('DELETE', `/api/tasks/${aiTaskId}`).catch(() => {});
    if (aiExpenseId) await api('DELETE', `/api/expenses/${aiExpenseId}`).catch(() => {});
    for (const id of aiAliasIds.reverse()) await api('DELETE', `/api/assistant/aliases/${id}`).catch(() => {});
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

  console.log('\n══ CONTRACT DOCUMENTS ══');
  let docPropId = null, docUnitId = null, docTenantId = null, docContractId = null, docId = null;
  await check('POST contract fixture', async () => {
    const prop = await api('POST', '/api/properties', { name:`__smoke_docs_${Date.now()}`, district:'Test', type:'mieszkanie' });
    expect(prop.ok && prop.data.id, JSON.stringify(prop));
    docPropId = prop.data.id;
    const unit = await api('POST', '/api/units', { property_id: docPropId, name:'Lokal testowy', code:'D1', status:'vacant' });
    expect(unit.ok && unit.data.id, JSON.stringify(unit));
    docUnitId = unit.data.id;
    const tenant = await api('POST', '/api/tenants', { name:'__smoke_doc_tenant', status:'active' });
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
    expect(r.ok && r.data.some(d => d.id === docId), JSON.stringify(r));
    return `${r.data.length} dokumentów`;
  });
  await check('GET  /api/documents/:id/download', async () => {
    const r = await fetch(BASE + `/api/documents/${docId}/download`);
    expect(r.ok && (r.headers.get('content-type') || '').includes('application/pdf'), `status=${r.status}`);
    expect((r.headers.get('content-disposition') || '').toLowerCase().includes('.pdf'), 'download filename missing .pdf extension');
    return `${(await r.arrayBuffer()).byteLength} bajtów`;
  });
  await check('DEL  contract document fixture', async () => {
    if (docId) expect((await api('DELETE', `/api/documents/${docId}`)).ok, 'doc delete failed');
    if (docContractId) expect((await api('DELETE', `/api/contracts/${docContractId}`)).ok, 'contract delete failed');
    if (docTenantId) expect((await api('DELETE', `/api/tenants/${docTenantId}`)).ok, 'tenant delete failed');
    if (docPropId) expect((await api('DELETE', `/api/properties/${docPropId}`)).ok, 'property delete failed');
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
