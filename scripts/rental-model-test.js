#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-rental-'));
const dbFile = path.join(tmpDir, 'property.db');
const port = Number(process.env.TEST_PORT || 8191);
const base = `http://127.0.0.1:${port}`;
let serverProc = null;

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, DB_FILE: dbFile, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`${script} failed\n${r.stdout}\n${r.stderr}`);
  }
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, data };
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
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  runNode('scripts/migrate.js');
  await startServer();

  const property = await api('POST', '/api/properties', {
    name: '__rental_model_property',
    district: 'Test',
    type: 'mieszkanie',
  });
  expect(property.ok && property.data.id, 'property create failed');

  const unitA = await api('POST', '/api/units', {
    property_id: property.data.id,
    name: 'Room A',
    code: 'A',
    base_rent: 1200,
    base_media: 300,
    status: 'vacant',
  });
  expect(unitA.ok && unitA.data.id, 'unit A create failed');

  const unitB = await api('POST', '/api/units', {
    property_id: property.data.id,
    name: 'Room B',
    code: 'B',
    base_rent: 800,
    base_media: 200,
    status: 'vacant',
  });
  expect(unitB.ok && unitB.data.id, 'unit B create failed');

  const tenantA = await api('POST', '/api/tenants', { name: '__tenant_a', status: 'active' });
  const tenantB = await api('POST', '/api/tenants', { name: '__tenant_b', status: 'active' });
  const tenantC = await api('POST', '/api/tenants', { name: '__tenant_c_overlap', status: 'active' });
  expect(tenantA.ok && tenantB.ok && tenantC.ok, 'tenant create failed');

  const contractA = await api('POST', '/api/contracts', {
    tenant_id: tenantA.data.id,
    unit_id: unitA.data.id,
    start_date: '2026-08-01',
    rent: 1400,
    media_advance: 250,
    deposit: 1000,
    pay_by_day: 12,
    status: 'active',
  });
  expect(contractA.ok && contractA.data.id, 'active contract create failed');

  let tenantAfter = await api('GET', `/api/tenants/${tenantA.data.id}`);
  let unitAfter = await api('GET', `/api/units/${unitA.data.id}`);
  expect(tenantAfter.data.current_unit_id === unitA.data.id, 'contract did not assign tenant to unit');
  expect(unitAfter.data.status === 'rented', 'contract did not mark unit rented');

  const unitConflict = await api('POST', '/api/contracts', {
    tenant_id: tenantB.data.id,
    unit_id: unitA.data.id,
    start_date: '2026-08-01',
    rent: 900,
    media_advance: 150,
    pay_by_day: 10,
    status: 'active',
  });
  expect(unitConflict.status === 409 && unitConflict.data.error === 'active_contract_exists_for_unit', 'missing unit contract conflict');

  const reassigned = await api('PUT', `/api/contracts/${contractA.data.id}`, {
    tenant_id: tenantB.data.id,
  });
  expect(reassigned.ok && reassigned.data.tenant_id === tenantB.data.id, 'active contract reassignment failed');

  tenantAfter = await api('GET', `/api/tenants/${tenantA.data.id}`);
  const reassignedTenant = await api('GET', `/api/tenants/${tenantB.data.id}`);
  expect(tenantAfter.data.current_unit_id == null, 'reassigned contract did not clear previous tenant');
  expect(reassignedTenant.data.current_unit_id === unitA.data.id, 'reassigned contract did not set new tenant');

  const tenantConflict = await api('POST', '/api/contracts', {
    tenant_id: tenantB.data.id,
    unit_id: unitB.data.id,
    start_date: '2026-08-01',
    rent: 900,
    media_advance: 150,
    pay_by_day: 10,
    status: 'active',
  });
  expect(tenantConflict.status === 409 && tenantConflict.data.error === 'active_contract_exists_for_tenant', 'missing tenant contract conflict');

  const generatedFromContract = await api('POST', '/api/payments/generate-month', { period: '2026-08' });
  expect(generatedFromContract.ok && generatedFromContract.data.created === 1, 'contract payment generation failed');
  expect(generatedFromContract.data.source_counts.contracts === 1, 'contract source count mismatch');

  const augustPayments = await api('GET', `/api/payments?period=2026-08&unit_id=${unitA.data.id}`);
  expect(augustPayments.ok && augustPayments.data.length === 1, 'missing generated contract payment');
  expect(augustPayments.data[0].rent_amount === 1400, 'contract rent was not used');
  expect(augustPayments.data[0].media_amount === 250, 'contract media was not used');
  expect(augustPayments.data[0].due_day === 12, 'contract due day was not used');
  expect(augustPayments.data[0].source === 'contract', 'contract payment source mismatch');

  const overlapPayment = await api('POST', '/api/payments', {
    period: '2026-08',
    tenant_id: tenantC.data.id,
    unit_id: unitA.data.id,
    due_day: 31,
    rent_amount: 700,
    media_amount: 125,
    total_paid: 0,
    status: 'pending',
    source: 'turnover',
  });
  expect(overlapPayment.ok && overlapPayment.data.id, 'overlap payment for same unit/month failed');
  const augustOverlap = await api('GET', `/api/payments?period=2026-08&unit_id=${unitA.data.id}`);
  expect(augustOverlap.ok && augustOverlap.data.length === 2, 'same unit/month should allow two tenants');

  const ended = await api('PUT', `/api/contracts/${contractA.data.id}`, {
    status: 'ended',
    end_date: '2026-08-31',
  });
  expect(ended.ok && ended.data.status === 'ended', 'contract end failed');

  tenantAfter = await api('GET', `/api/tenants/${tenantB.data.id}`);
  unitAfter = await api('GET', `/api/units/${unitA.data.id}`);
  expect(tenantAfter.data.current_unit_id == null, 'ended contract did not clear tenant unit');
  expect(unitAfter.data.status === 'vacant', 'ended contract did not release unit');

  const manualAssign = await api('PUT', `/api/tenants/${tenantA.data.id}`, {
    current_unit_id: unitA.data.id,
    status: 'active',
  });
  expect(manualAssign.ok, 'manual tenant assignment failed');

  const generatedFromTenant = await api('POST', '/api/payments/generate-month', { period: '2026-09' });
  expect(generatedFromTenant.ok && generatedFromTenant.data.created === 1, 'tenant fallback generation failed');
  expect(generatedFromTenant.data.source_counts.tenants === 1, 'tenant fallback count mismatch');
  expect(generatedFromTenant.data.fallback_used === true, 'tenant fallback flag mismatch');

  const septemberPayments = await api('GET', `/api/payments?period=2026-09&unit_id=${unitA.data.id}`);
  expect(septemberPayments.ok && septemberPayments.data.length === 1, 'missing generated tenant payment');
  expect(septemberPayments.data[0].rent_amount === 1200, 'fallback rent was not taken from unit');
  expect(septemberPayments.data[0].media_amount === 300, 'fallback media was not taken from unit');
  expect(septemberPayments.data[0].due_day === 10, 'fallback due day mismatch');
  expect(septemberPayments.data[0].source === 'tenant', 'tenant fallback payment source mismatch');

  const duplicate = await api('POST', '/api/payments/generate-month', { period: '2026-09' });
  expect(duplicate.ok && duplicate.data.created === 0 && duplicate.data.skipped === 1, 'duplicate generation was not idempotent');

  console.log('Rental model regression OK');
}

main()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => stopServer());
