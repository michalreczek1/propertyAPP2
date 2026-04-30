#!/usr/bin/env node
'use strict';
/**
 * Tworzy schemat bazy SQLite. Idempotentne (CREATE IF NOT EXISTS).
 * Bezpieczne do wielokrotnego uruchamiania.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { dueDate } = require('../src/utils/period');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'EACCES') return;
    throw err;
  }
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile('/etc/propertyapp/auth.env');

const SCHEMA = `
-- ── APP USERS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

CREATE TABLE IF NOT EXISTS user_settings (
  owner_user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_user_id, key),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── PROPERTIES ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  name TEXT NOT NULL UNIQUE,
  address TEXT,
  district TEXT,
  type TEXT DEFAULT 'mieszkanie',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ── UNITS (lokale/pokoje) ────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  area_m2 REAL,
  base_rent REAL DEFAULT 0,
  base_media REAL DEFAULT 0,
  status TEXT DEFAULT 'rented',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);

-- ── TENANTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  sms_consent INTEGER DEFAULT 0,
  sms_disabled INTEGER DEFAULT 0,
  current_unit_id INTEGER,
  status TEXT DEFAULT 'active',
  avatar_color TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (current_unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_unit ON tenants(current_unit_id);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- ── CONTRACTS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  start_date DATE,
  end_date DATE,
  rent REAL DEFAULT 0,
  media_advance REAL DEFAULT 0,
  deposit REAL DEFAULT 0,
  pay_by_day INTEGER DEFAULT 31,
  document_path TEXT,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_contracts_tenant ON contracts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contracts_unit ON contracts(unit_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- ── PAYMENTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  period TEXT NOT NULL,            -- "YYYY-MM"
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
  total_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',   -- paid|pending|overdue|partial
  notes TEXT,
  source TEXT DEFAULT 'manual',    -- excel|manual
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_period ON payments(period);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_unit ON payments(unit_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
-- Jednoznaczność po okresie, lokalu i najemcy.
-- Pozwala na zakładkę w jednym miesiącu: ten sam lokal, dwóch różnych najemców.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_period_unit_tenant
  ON payments(period, unit_id, tenant_id)
  WHERE unit_id IS NOT NULL AND tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_period_unit_no_tenant
  ON payments(period, unit_id)
  WHERE unit_id IS NOT NULL AND tenant_id IS NULL;

-- ── MONTHLY SUMMARY (per period) ─────────────────────
CREATE TABLE IF NOT EXISTS monthly_summary (
  period TEXT PRIMARY KEY,
  czynsz_total REAL,
  marek_total REAL,
  dla_mnie REAL,
  media_advance_total REAL,
  media_paid REAL,
  media_left REAL,
  penalties REAL,
  total REAL,
  podatek REAL,
  podatek_koscielna REAL,
  podatek_suma REAL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── EXPENSES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  property_id INTEGER,
  unit_id INTEGER,
  category TEXT NOT NULL,          -- media|podatek|ubezpieczenie|remont|zarzadzanie|inne
  amount REAL NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  document_path TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);

-- ── TASKS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  property_id INTEGER,
  unit_id INTEGER,
  tenant_id INTEGER,
  due_date DATE,
  priority TEXT DEFAULT 'med',     -- low|med|high
  status TEXT DEFAULT 'open',      -- open|done
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  done_at TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

-- ── DOCUMENTS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  related_entity_type TEXT,        -- tenant|contract|expense|property|unit
  related_entity_id INTEGER,
  category TEXT,                   -- umowa|faktura|protokol|inne
  notes TEXT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_entity
  ON documents(related_entity_type, related_entity_id);

-- ── NOTIFICATION LOGS ───────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  payment_id INTEGER,
  tenant_id INTEGER,
  unit_id INTEGER,
  period TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  type TEXT NOT NULL,
  recipient_phone TEXT,
  message_hash TEXT,
  message_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  provider_message_id TEXT,
  next_attempt_at TIMESTAMP,
  last_attempt_at TIMESTAMP,
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_logs_status
  ON notification_logs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_notification_logs_payment
  ON notification_logs(payment_id, type, channel);

-- ── SETTINGS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── RECURRING OWNER COSTS ────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  category TEXT NOT NULL,          -- zarzadzanie|kredyt
  property_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  valid_from_period TEXT NOT NULL,
  valid_to_period TEXT,
  active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recurring_costs_period
  ON recurring_costs(valid_from_period, valid_to_period, active);
CREATE INDEX IF NOT EXISTS idx_recurring_costs_property
  ON recurring_costs(property_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recurring_costs_open
  ON recurring_costs(category, COALESCE(owner_user_id, 0), COALESCE(property_id, 0), valid_from_period)
  WHERE active = 1;
`;

db.exec(SCHEMA);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function ensureLegacyColumns() {
  if (!columnExists('properties', 'owner_user_id')) {
    db.prepare('ALTER TABLE properties ADD COLUMN owner_user_id INTEGER').run();
  }
  for (const table of ['tenants', 'payments', 'expenses', 'tasks', 'documents', 'recurring_costs']) {
    if (!columnExists(table, 'owner_user_id')) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN owner_user_id INTEGER`).run();
    }
  }
  if (!columnExists('payments', 'late_fee_amount')) {
    db.prepare('ALTER TABLE payments ADD COLUMN late_fee_amount REAL DEFAULT 0').run();
  }
  if (!columnExists('payments', 'late_fee_paid')) {
    db.prepare('ALTER TABLE payments ADD COLUMN late_fee_paid REAL DEFAULT 0').run();
  }
  if (!columnExists('payments', 'late_fee_manual')) {
    db.prepare('ALTER TABLE payments ADD COLUMN late_fee_manual INTEGER DEFAULT 0').run();
  }
  if (!columnExists('tenants', 'sms_consent')) {
    db.prepare('ALTER TABLE tenants ADD COLUMN sms_consent INTEGER DEFAULT 0').run();
  }
  if (!columnExists('tenants', 'sms_disabled')) {
    db.prepare('ALTER TABLE tenants ADD COLUMN sms_disabled INTEGER DEFAULT 0').run();
  }
  if (!columnExists('notification_logs', 'delivered_at')) {
    db.prepare('ALTER TABLE notification_logs ADD COLUMN delivered_at TIMESTAMP').run();
  }
}

function backfillAdminUser() {
  const existing = db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (existing) return;
  const username = process.env.APP_AUTH_USER || 'michal';
  const passwordHash = process.env.APP_AUTH_PASSWORD_HASH;
  if (!passwordHash) return;
  db.prepare(`
    INSERT INTO users(username, display_name, role, password_hash, active)
    VALUES (?, ?, 'admin', ?, 1)
  `).run(username, 'Property Manager', passwordHash);
}

function backfillPropertyOwner() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) return;
  db.prepare('UPDATE properties SET owner_user_id = ? WHERE owner_user_id IS NULL').run(admin.id);
  db.prepare(`
    UPDATE tenants
    SET owner_user_id = ?
    WHERE owner_user_id IS NULL
  `).run(admin.id);
  db.prepare(`
    UPDATE payments
    SET owner_user_id = COALESCE((
      SELECT p.owner_user_id
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.id = payments.unit_id
    ), (
      SELECT t.owner_user_id FROM tenants t WHERE t.id = payments.tenant_id
    ), ?)
    WHERE owner_user_id IS NULL
  `).run(admin.id);
  db.prepare(`
    UPDATE expenses
    SET owner_user_id = COALESCE((
      SELECT p.owner_user_id FROM properties p WHERE p.id = expenses.property_id
    ), (
      SELECT p.owner_user_id
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.id = expenses.unit_id
    ), ?)
    WHERE owner_user_id IS NULL
  `).run(admin.id);
  db.prepare(`
    UPDATE tasks
    SET owner_user_id = COALESCE((
      SELECT p.owner_user_id FROM properties p WHERE p.id = tasks.property_id
    ), (
      SELECT p.owner_user_id
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.id = tasks.unit_id
    ), (
      SELECT t.owner_user_id FROM tenants t WHERE t.id = tasks.tenant_id
    ), ?)
    WHERE owner_user_id IS NULL
  `).run(admin.id);
  db.prepare('UPDATE documents SET owner_user_id = ? WHERE owner_user_id IS NULL').run(admin.id);
  db.prepare(`
    UPDATE recurring_costs
    SET owner_user_id = COALESCE((
      SELECT p.owner_user_id FROM properties p WHERE p.id = recurring_costs.property_id
    ), ?)
    WHERE owner_user_id IS NULL
  `).run(admin.id);
}

function ensureRecurringCostIndex() {
  db.prepare('DROP INDEX IF EXISTS uniq_recurring_costs_open').run();
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_recurring_costs_open
      ON recurring_costs(category, COALESCE(owner_user_id, 0), COALESCE(property_id, 0), valid_from_period)
      WHERE active = 1
  `).run();
}

function ensureNotificationLogIndexes() {
  db.prepare('DROP INDEX IF EXISTS uniq_notification_logs_payment_type').run();
  db.prepare(`
    UPDATE notification_logs
    SET status = 'simulated'
    WHERE type = 'test'
      AND status = 'sent'
      AND provider_message_id = '12345'
  `).run();
  db.prepare(`
    UPDATE notification_logs
    SET status = 'failed',
        next_attempt_at = NULL
    WHERE type = 'test'
      AND status = 'queued'
      AND error_message IS NOT NULL
  `).run();
}

function ensurePaymentIndexes() {
  db.prepare('DROP INDEX IF EXISTS uniq_payments_period_unit').run();
  db.prepare('DROP INDEX IF EXISTS uniq_payments_period_unit_tenant').run();
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_period_unit_tenant
      ON payments(period, unit_id, tenant_id)
      WHERE unit_id IS NOT NULL AND tenant_id IS NOT NULL
  `).run();
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_period_unit_no_tenant
      ON payments(period, unit_id)
      WHERE unit_id IS NOT NULL AND tenant_id IS NULL
  `).run();
}

function normalizePaymentDueDates() {
  const rows = db.prepare(`
    SELECT id, period, due_day, due_date
    FROM payments
    WHERE due_day IS NOT NULL
  `).all();
  const update = db.prepare('UPDATE payments SET due_date = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      const expected = dueDate(row.period, row.due_day);
      if (expected && row.due_date !== expected) update.run(expected, row.id);
    }
  });
  tx();
}

function backfillLateFees() {
  db.prepare(`
    UPDATE payments
    SET late_fee_amount = 50,
        late_fee_paid = MIN(50, MAX(0, COALESCE(total_paid, 0) - (COALESCE(rent_amount, 0) + COALESCE(media_amount, 0) + COALESCE(other_amount, 0))))
    WHERE COALESCE(late_fee_manual, 0) = 0
      AND status IN ('paid', 'partial')
      AND paid_date IS NOT NULL
      AND due_date IS NOT NULL
      AND DATE(paid_date) > DATE(due_date)
  `).run();
  db.prepare(`
    UPDATE payments
    SET late_fee_amount = 0,
        late_fee_paid = 0
    WHERE COALESCE(late_fee_manual, 0) = 0
      AND (status NOT IN ('paid', 'partial')
        OR paid_date IS NULL
        OR due_date IS NULL
        OR DATE(paid_date) <= DATE(due_date))
  `).run();
}

ensureLegacyColumns();
backfillAdminUser();
backfillPropertyOwner();
ensureRecurringCostIndex();
ensureNotificationLogIndexes();
ensurePaymentIndexes();
normalizePaymentDueDates();
backfillLateFees();

function numSetting(key, fallback = 0) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value == null || row.value === '') return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

function backfillRecurringCosts() {
  const hasRows = db.prepare('SELECT 1 FROM recurring_costs LIMIT 1').get();
  if (hasRows) return;
  const validFrom = '2026-01';
  const management = numSetting('cost.management.monthly', 0);
  const koscielna = numSetting('cost.mortgage.koscielna.monthly', 0);
  const chrobrego = numSetting('cost.mortgage.chrobrego.monthly', 0);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const adminId = admin ? admin.id : null;
  const propByName = db.prepare('SELECT id, name FROM properties').all();
  const findProp = (fragment) => propByName.find(p => String(p.name || '').toLowerCase().includes(fragment));
  const koscielnaProp = findProp('kościelna') || findProp('koscielna');
  const chrobregoProp = findProp('chrobrego');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO recurring_costs(category, owner_user_id, property_id, amount, valid_from_period, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  if (management) insert.run('zarzadzanie', adminId, null, management, validFrom, 'Backfill from settings');
  if (koscielna && koscielnaProp) insert.run('kredyt', adminId, koscielnaProp.id, koscielna, validFrom, 'Backfill from settings');
  if (chrobrego && chrobregoProp) insert.run('kredyt', adminId, chrobregoProp.id, chrobrego, validFrom, 'Backfill from settings');
}

backfillRecurringCosts();
console.log('✓ Schemat bazy gotowy:', db.name);
console.log('  Tabele:', db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).join(', '));
