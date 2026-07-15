#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-development-'));
const dbFile = path.join(tempDir, 'test.db');
process.env.DB_FILE = dbFile;

function isoDate(daysFromToday = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

function periodNow() {
  return new Date().toISOString().slice(0, 7);
}

function run() {
  const migrated = spawnSync(process.execPath, ['scripts/migrate.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_FILE: dbFile },
    encoding: 'utf8',
  });
  if (migrated.status !== 0) throw new Error(migrated.stderr || migrated.stdout || 'migration_failed');

  const db = require('../src/db');
  const banking = require('../src/services/bank-reconciliation');
  const automations = require('../src/services/automation-engine');

  const user = db
    .prepare(
      "INSERT INTO users(username, display_name, role, password_hash) VALUES ('regression', 'Regression', 'admin', 'test')",
    )
    .run();
  const uid = Number(user.lastInsertRowid);
  const property = db
    .prepare("INSERT INTO properties(owner_user_id, name) VALUES (?, 'Regression House')")
    .run(uid);
  const propertyId = Number(property.lastInsertRowid);
  const unit = db
    .prepare("INSERT INTO units(property_id, name, code, status) VALUES (?, 'Pokój 1', 'P1', 'rented')")
    .run(propertyId);
  const unitId = Number(unit.lastInsertRowid);
  const tenant = db
    .prepare(
      "INSERT INTO tenants(owner_user_id, name, current_unit_id, status) VALUES (?, 'Jan Kowalski', ?, 'active')",
    )
    .run(uid, unitId);
  const tenantId = Number(tenant.lastInsertRowid);
  const period = periodNow();
  const payment = db
    .prepare(
      `INSERT INTO payments
        (owner_user_id, period, tenant_id, unit_id, due_day, due_date, rent_amount, media_amount, total_paid, status)
       VALUES (?, ?, ?, ?, 10, ?, 1400, 100, 0, 'pending')`,
    )
    .run(uid, period, tenantId, unitId, `${period}-10`);
  const paymentId = Number(payment.lastInsertRowid);
  db.prepare(
    `INSERT INTO contracts
      (tenant_id, unit_id, start_date, end_date, rent, media_advance, status, workflow_stage)
     VALUES (?, ?, ?, ?, 1400, 100, 'active', 'active')`,
  ).run(tenantId, unitId, `${period}-01`, isoDate(10));
  db.prepare(
    `INSERT INTO documents
      (owner_user_id, name, file_path, category, workflow_status, expires_on)
     VALUES (?, 'Polisa testowa', 'test.pdf', 'ubezpieczenie', 'approved', ?)`,
  ).run(uid, isoDate(5));

  const req = { user: { id: uid, role: 'admin' } };
  const csv = [
    'Data operacji;Kwota;Waluta;Tytuł;Kontrahent;Rachunek',
    `${isoDate()};1500,00;PLN;Czynsz ${period} P1;Jan Kowalski;PL001234`,
  ].join('\n');
  const file = { buffer: Buffer.from(csv), originalname: 'bank.csv' };
  const imported = banking.importTransactions(req, file, 'Bank testowy');
  assert.equal(imported.imported, 1);
  assert.equal(imported.duplicates, 0);

  let transaction = banking.listTransactions(req, 'all')[0];
  assert.equal(transaction.status, 'suggested');
  assert.equal(transaction.suggested_payment_id, paymentId);
  assert.ok(transaction.confidence >= 85);

  banking.confirmMatch(req, transaction.id);
  let updatedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(updatedPayment.status, 'paid');
  assert.equal(updatedPayment.total_paid, 1500);
  banking.undoMatch(req, transaction.id);
  updatedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(updatedPayment.status, 'pending');
  assert.equal(updatedPayment.total_paid, 0);

  const duplicate = banking.importTransactions(req, file, 'Bank testowy');
  assert.equal(duplicate.imported, 0);
  assert.equal(duplicate.duplicates, 1);

  const scan = automations.scan(req);
  assert.ok(scan.created >= 3, `expected at least 3 proposals, got ${scan.created}`);
  const proposals = automations.list(req, 'pending').proposals;
  const taskProposal = proposals.find((proposal) => proposal.action_type === 'create_task');
  const bankProposal = proposals.find((proposal) => proposal.action_type === 'reconcile_bank');
  assert.ok(taskProposal);
  assert.ok(bankProposal);
  automations.execute(req, taskProposal.id, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  assert.throws(() => automations.execute(req, bankProposal.id, false), /explicit_confirmation_required/);
  automations.execute(req, bankProposal.id, true);
  transaction = banking.listTransactions(req, 'all')[0];
  assert.equal(transaction.status, 'matched');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(paymentId).status, 'paid');

  const remaining = automations.list(req, 'pending').proposals[0];
  if (remaining) automations.reject(req, remaining.id);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count >= 10);
  db.close();
  console.log('✓ Development regression: banking, workflows and guarded automations');
}

try {
  run();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
