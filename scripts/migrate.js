#!/usr/bin/env node
'use strict';
/**
 * Tworzy schemat bazy SQLite. Idempotentne (CREATE IF NOT EXISTS).
 * Bezpieczne do wielokrotnego uruchamiania.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

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
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  current_unit_id INTEGER,
  status TEXT DEFAULT 'active',
  avatar_color TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  period TEXT NOT NULL,            -- "YYYY-MM"
  tenant_id INTEGER,
  unit_id INTEGER,
  due_day INTEGER,
  due_date DATE,
  paid_date DATE,
  rent_amount REAL DEFAULT 0,
  media_amount REAL DEFAULT 0,
  other_amount REAL DEFAULT 0,
  total_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',   -- paid|pending|overdue|partial
  notes TEXT,
  source TEXT DEFAULT 'manual',    -- excel|manual
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_period ON payments(period);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_unit ON payments(unit_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
-- jednoznaczność po (period, unit_id) gdy unit_id jest niepusty (idempotentny re-import)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_period_unit
  ON payments(period, unit_id) WHERE unit_id IS NOT NULL;

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
  property_id INTEGER,
  unit_id INTEGER,
  category TEXT NOT NULL,          -- media|podatek|ubezpieczenie|remont|zarzadzanie|inne
  amount REAL NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  document_path TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);

-- ── TASKS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

-- ── DOCUMENTS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- ── SETTINGS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── RECURRING OWNER COSTS ────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,          -- zarzadzanie|kredyt
  property_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  valid_from_period TEXT NOT NULL,
  valid_to_period TEXT,
  active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recurring_costs_period
  ON recurring_costs(valid_from_period, valid_to_period, active);
CREATE INDEX IF NOT EXISTS idx_recurring_costs_property
  ON recurring_costs(property_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recurring_costs_open
  ON recurring_costs(category, COALESCE(property_id, 0), valid_from_period)
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
}

ensureLegacyColumns();
backfillAdminUser();
backfillPropertyOwner();

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
  const propByName = db.prepare('SELECT id, name FROM properties').all();
  const findProp = (fragment) => propByName.find(p => String(p.name || '').toLowerCase().includes(fragment));
  const koscielnaProp = findProp('kościelna') || findProp('koscielna');
  const chrobregoProp = findProp('chrobrego');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO recurring_costs(category, property_id, amount, valid_from_period, notes)
    VALUES (?, ?, ?, ?, ?)
  `);
  if (management) insert.run('zarzadzanie', null, management, validFrom, 'Backfill from settings');
  if (koscielna && koscielnaProp) insert.run('kredyt', koscielnaProp.id, koscielna, validFrom, 'Backfill from settings');
  if (chrobrego && chrobregoProp) insert.run('kredyt', chrobregoProp.id, chrobrego, validFrom, 'Backfill from settings');
}

backfillRecurringCosts();
console.log('✓ Schemat bazy gotowy:', db.name);
console.log('  Tabele:', db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).join(', '));
