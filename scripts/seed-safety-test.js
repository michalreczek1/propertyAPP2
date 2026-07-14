#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-seed-'));
const dbFile = path.join(tmp, 'seed-safety.db');
const env = { ...process.env, DB_FILE: dbFile };

function runNode(script) {
  execFileSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    env,
    stdio: 'pipe',
  });
}

try {
  runNode('scripts/migrate.js');
  runNode('scripts/seed.js');

  let db = new Database(dbFile);
  assert.equal(
    db.prepare('SELECT status FROM units WHERE code = ?').get('KR').status,
    'vacant',
    'fresh seed must not mark an uncontracted unit as rented',
  );
  db.prepare("UPDATE units SET status = 'rented' WHERE code = ?").run('KR');
  db.prepare('DELETE FROM schema_migrations WHERE id = ?').run('2026-07-14-007-normalize-unit-occupancy');
  db.close();
  runNode('scripts/migrate.js');
  db = new Database(dbFile);
  assert.equal(
    db.prepare('SELECT status FROM units WHERE code = ?').get('KR').status,
    'vacant',
    'occupancy migration must release an unassigned rented unit',
  );
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('12.5', 'tax.rate');
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('999', 'cost.management.monthly');
  db.prepare('UPDATE properties SET district = ? WHERE name = ?').run('User district', 'Kościelna 30/21');
  db.prepare('UPDATE units SET name = ?, base_rent = ?, base_media = ? WHERE code = ?').run(
    'User Lokal',
    4321,
    987,
    'KR',
  );
  db.prepare(
    'UPDATE recurring_costs SET amount = ?, notes = ? WHERE category = ? AND property_id IS NULL',
  ).run(999, 'User management', 'zarzadzanie');
  db.close();

  runNode('scripts/seed.js');

  const verify = new Database(dbFile);
  assert.equal(verify.prepare('SELECT value FROM settings WHERE key = ?').get('tax.rate').value, '12.5');
  assert.equal(
    verify.prepare('SELECT value FROM settings WHERE key = ?').get('cost.management.monthly').value,
    '999',
  );
  assert.equal(
    verify.prepare('SELECT district FROM properties WHERE name = ?').get('Kościelna 30/21').district,
    'User district',
  );

  const unit = verify.prepare('SELECT name, base_rent, base_media FROM units WHERE code = ?').get('KR');
  assert.equal(unit.name, 'User Lokal');
  assert.equal(unit.base_rent, 4321);
  assert.equal(unit.base_media, 987);

  const recurring = verify
    .prepare('SELECT amount, notes FROM recurring_costs WHERE category = ? AND property_id IS NULL')
    .get('zarzadzanie');
  assert.equal(recurring.amount, 999);
  assert.equal(recurring.notes, 'User management');
  assert.equal(
    verify
      .prepare('SELECT COUNT(*) AS c FROM recurring_costs WHERE category = ? AND property_id IS NULL')
      .get('zarzadzanie').c,
    1,
  );
  verify.close();

  console.log('✓ Seed safety test passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
