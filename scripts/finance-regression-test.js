#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { monthlyFinanceSummary } = require('../src/services/finance-summary');

function near(actual, expected, message) {
  assert.equal(Number(actual).toFixed(2), Number(expected).toFixed(2), message);
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    address TEXT,
    district TEXT,
    type TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    base_rent REAL DEFAULT 0,
    base_media REAL DEFAULT 0,
    status TEXT DEFAULT 'rented'
  );
  CREATE TABLE tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    current_unit_id INTEGER,
    status TEXT DEFAULT 'active',
    avatar_color TEXT
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    tenant_id INTEGER,
    unit_id INTEGER,
    due_day INTEGER,
    due_date DATE,
    paid_date DATE,
    rent_amount REAL DEFAULT 0,
    media_amount REAL DEFAULT 0,
    other_amount REAL DEFAULT 0,
    late_fee_amount REAL DEFAULT 0,
    late_fee_paid REAL DEFAULT 0,
    late_fee_manual INTEGER DEFAULT 0,
    late_fee_resolution TEXT DEFAULT 'unpaid',
    total_paid REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    source TEXT DEFAULT 'manual'
  );
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER,
    unit_id INTEGER,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    date DATE NOT NULL,
    description TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE recurring_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    property_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    valid_from_period TEXT NOT NULL,
    valid_to_period TEXT,
    active INTEGER DEFAULT 1,
    notes TEXT
  );
`);

const insertSetting = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
insertSetting.run('tax.rate', '8.5');
insertSetting.run('tax.koscielna', '0');

const prop = db.prepare('INSERT INTO properties(name, district, type) VALUES (?, ?, ?)');
const koscielnaId = prop.run('Kościelna 30/21', 'Centrum', 'mieszkanie').lastInsertRowid;
const chrobregoId = prop.run('Os. B. Chrobrego 28/21', 'Rataje', 'pokoje').lastInsertRowid;

const unit = db.prepare('INSERT INTO units(property_id, name, code, base_rent, base_media, status) VALUES (?, ?, ?, ?, ?, ?)');
const krId = unit.run(koscielnaId, 'Lokal', 'KR', 2150, 850, 'rented').lastInsertRowid;
const roomIds = [
  unit.run(chrobregoId, 'Pokój 1', 'P1', 690, 240, 'rented').lastInsertRowid,
  unit.run(chrobregoId, 'Pokój 2', 'P2', 760, 240, 'rented').lastInsertRowid,
  unit.run(chrobregoId, 'Pokój 3', 'P3', 660, 240, 'rented').lastInsertRowid,
  unit.run(chrobregoId, 'Pokój 4', 'P4', 590, 240, 'rented').lastInsertRowid,
  unit.run(chrobregoId, 'Pokój 5', 'P5', 690, 240, 'rented').lastInsertRowid,
  unit.run(chrobregoId, 'Pokój 6', 'P6', 770, 230, 'rented').lastInsertRowid,
];

const tenant = db.prepare('INSERT INTO tenants(name, current_unit_id, status) VALUES (?, ?, ?)');
const tenantIds = [krId, ...roomIds].map((unitId, i) => tenant.run(`Tenant ${i + 1}`, unitId, 'active').lastInsertRowid);

const payment = db.prepare(`
  INSERT INTO payments(period, tenant_id, unit_id, due_day, due_date, paid_date, rent_amount, media_amount, total_paid, status)
  VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?, ?)
`);
const aprilPayments = [
  [tenantIds[0], krId, 2150, 850],
  [tenantIds[1], roomIds[0], 690, 240],
  [tenantIds[2], roomIds[1], 760, 240],
  [tenantIds[3], roomIds[2], 660, 240],
  [tenantIds[4], roomIds[3], 590, 240],
  [tenantIds[5], roomIds[4], 690, 240],
  [tenantIds[6], roomIds[5], 770, 230],
];
for (const [tenantId, unitId, rent, media] of aprilPayments) {
  payment.run('2026-04', tenantId, unitId, '2026-04-10', '2026-04-10', rent, media, rent + media, 'paid');
  payment.run('2026-05', tenantId, unitId, '2026-05-10', null, rent, media, 0, 'pending');
}
payment.run('2026-06', tenantIds[0], krId, '2026-06-10', '2026-06-10', 100, 0, 100, 'paid');
payment.run('2026-06', tenantIds[1], roomIds[0], '2026-06-10', '2026-06-10', 100, 0, 100, 'paid');
db.prepare(`
  INSERT INTO payments(period, tenant_id, unit_id, due_day, due_date, paid_date, rent_amount, media_amount, late_fee_amount, late_fee_paid, total_paid, status)
  VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('2026-08', tenantIds[0], krId, '2026-08-10', '2026-08-12', 1000, 100, 50, 50, 1100, 'paid');

const expense = db.prepare('INSERT INTO expenses(property_id, category, amount, date, description) VALUES (?, ?, ?, ?, ?)');
expense.run(chrobregoId, 'czynsz', 1710, '2026-04-01', 'Czynsz Chrobrego');
expense.run(chrobregoId, 'internet', 64, '2026-04-01', 'Internet Chrobrego');
expense.run(chrobregoId, 'prad', 150, '2026-04-01', 'Prąd Chrobrego');
expense.run(koscielnaId, 'czynsz', 695.54, '2026-04-01', 'Czynsz Kościelna');
expense.run(koscielnaId, 'prad', 120, '2026-04-01', 'Prąd Kościelna');
expense.run(chrobregoId, 'remonty', 30, '2026-04-01', 'Testowy remont');
expense.run(chrobregoId, 'kredyt', 100, '2026-07-01', 'Manualny koszt kredytu');

const recurring = db.prepare('INSERT INTO recurring_costs(category, property_id, amount, valid_from_period, active) VALUES (?, ?, ?, ?, 1)');
recurring.run('zarzadzanie', null, 500, '2026-01');
recurring.run('kredyt', chrobregoId, 3030, '2026-01');
recurring.run('kredyt', chrobregoId, 4000, '2026-05');

const april = monthlyFinanceSummary(db, '2026-04');
near(april.revenue.gross, 8590, 'April revenue');
near(april.revenue.rent_paid, 6310, 'April rent tax base');
near(april.revenue.media, 2280, 'April media revenue');
near(april.expenses.total, 6299.54, 'April expenses');
near(april.tax.podatek_suma, 536, 'April tax');
near(april.net_for_owner, 1754.46, 'April net');
near(april.properties.reduce((sum, p) => sum + p.tax, 0), april.totals.tax_total, 'Property taxes sum to total tax');
near(april.costs_by_category.reduce((sum, row) => sum + row.total, 0), april.expenses.total, 'Cost categories sum to expenses');
near(april.per_unit.reduce((sum, row) => sum + row.expenses, 0), april.expenses.total, 'Per-unit allocated expenses sum to total expenses');
const aprilKr = april.per_unit.find(row => row.unit_code === 'KR');
near(aprilKr.direct_expenses, 0, 'KR has no direct unit expenses');
near(aprilKr.allocated_expenses, 1065.54, 'KR gets property and owner costs allocated');
const aprilChrobregoAllocated = april.per_unit
  .filter(row => row.property_name.includes('Chrobrego'))
  .map(row => row.allocated_expenses)
  .sort((a, b) => b - a);
assert.deepEqual(aprilChrobregoAllocated, [872.34, 872.34, 872.33, 872.33, 872.33, 872.33], 'Chrobrego property and owner costs are allocated across rooms with cent remainder');

const may = monthlyFinanceSummary(db, '2026-05');
near(may.revenue.gross, 0, 'May pending revenue is zero');
near(may.tax.podatek_suma, 0, 'May pending tax is zero');
assert.equal(may.revenue.total_units, 7, 'May still has seven expected payments');
near(may.owner_costs.mortgage_total, 4000, 'May uses updated recurring mortgage');
near(april.owner_costs.mortgage_total, 3030, 'April keeps historical recurring mortgage');
near(april.expenses.total, 6299.54, 'April total is unchanged by May recurring cost update');

const june = monthlyFinanceSummary(db, '2026-06');
near(june.tax.podatek_suma, 17, 'June aggregate tax rounds once from total rent');
near(june.properties.reduce((sum, p) => sum + p.tax, 0), 17, 'June property tax allocation sums to aggregate tax');
assert.deepEqual(june.properties.map(p => p.tax).sort((a, b) => b - a), [9, 8], 'June property tax allocation absorbs rounding delta');

const july = monthlyFinanceSummary(db, '2026-07');
const julyCreditRows = july.costs_by_category.filter(row => row.category === 'kredyt');
assert.equal(julyCreditRows.length, 1, 'Manual and owner mortgage costs are merged into one credit category');
near(julyCreditRows[0].total, 4100, 'Credit category includes manual and owner mortgage costs');

const august = monthlyFinanceSummary(db, '2026-08');
near(august.revenue.gross, 1100, 'Paid late fee is tracked separately from monthly revenue');
near(august.revenue.late_fee_paid, 50, 'Paid late fee remains visible in late fee ledger');
near(august.revenue.late_fee_balance, 0, 'Fully paid late fee has no tenant balance');
near(august.tax.podatek_suma, 85, 'Tax base excludes paid late fee');

console.log('✓ Finance regression tests passed');
