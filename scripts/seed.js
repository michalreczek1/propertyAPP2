#!/usr/bin/env node
'use strict';
/**
 * Seed bazy podstawowymi danymi:
 *  - prawdziwe nieruchomości (Kościelna 30/21, Os. B. Chrobrego 28/21)
 *  - lokale/pokoje
 *  - domyślne ustawienia (firma, podatek)
 *
 * Idempotentny — uzupełnia tylko brakujące rekordy.
 * Seed NIE nadpisuje istniejących nieruchomości, lokali, ustawień ani kosztów cyklicznych.
 */
const db = require('../src/db');

const properties = [
  { name: 'Kościelna 30/21',      address: 'ul. Kościelna 30/21',      district: 'Centrum', type: 'mieszkanie' },
  { name: 'Os. B. Chrobrego 28/21', address: 'Os. B. Chrobrego 28/21', district: 'Rataje',  type: 'pokoje' },
];

const units = [
  // Kościelna 30/21 — jeden lokal (Hubert)
  { property: 'Kościelna 30/21',       name: 'Lokal',   code: 'KR', base_rent: 3000, base_media: 0 },

  // Os. B. Chrobrego 28/21 — 6 pokoi
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 1', code: 'P1', base_rent: 690,  base_media: 240 },
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 2', code: 'P2', base_rent: 760,  base_media: 240 },
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 3', code: 'P3', base_rent: 660,  base_media: 240 },
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 4', code: 'P4', base_rent: 590,  base_media: 240 },
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 5', code: 'P5', base_rent: 690,  base_media: 240 },
  { property: 'Os. B. Chrobrego 28/21', name: 'Pokój 6', code: 'P6', base_rent: 770,  base_media: 230 },
];

const settings = {
  'company.name':    'Property Manager',
  'company.address': '',
  'company.nip':     '',
  'tax.rate':        '8.5',
  'tax.koscielna':   '0',
  'cost.management.monthly': '500',
  'cost.mortgage.koscielna.monthly': '0',
  'cost.mortgage.chrobrego.monthly': '0',
  'currency':        'PLN',
  'locale':          'pl-PL',
  'app.title':       'PropertyApp',
};

const upsertProperty = db.prepare(`
  INSERT INTO properties (name, address, district, type)
  VALUES (@name, @address, @district, @type)
  ON CONFLICT(name) DO NOTHING
`);

const findProperty = db.prepare('SELECT id FROM properties WHERE name = ?');

const findUnit = db.prepare('SELECT id FROM units WHERE property_id = ? AND code = ?');
const insertUnit = db.prepare(`
  INSERT INTO units (property_id, name, code, base_rent, base_media, status)
  VALUES (?, ?, ?, ?, ?, 'rented')
`);

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO NOTHING
`);

const insertRecurringCost = db.prepare(`
  INSERT OR IGNORE INTO recurring_costs(category, property_id, amount, valid_from_period, notes)
  VALUES (?, ?, ?, '2026-01', ?)
`);

const tx = db.transaction(() => {
  for (const p of properties) upsertProperty.run(p);
  for (const u of units) {
    const prop = findProperty.get(u.property);
    if (!prop) continue;
    const existing = findUnit.get(prop.id, u.code);
    if (existing) {
      continue;
    } else {
      insertUnit.run(prop.id, u.name, u.code, u.base_rent, u.base_media);
    }
  }
  for (const [k, v] of Object.entries(settings)) upsertSetting.run(k, v);
  const koscielna = findProperty.get('Kościelna 30/21');
  const chrobrego = findProperty.get('Os. B. Chrobrego 28/21');
  insertRecurringCost.run('zarzadzanie', null, 500, 'Seed default owner management cost');
  if (koscielna) insertRecurringCost.run('kredyt', koscielna.id, 0, 'Seed default mortgage cost');
  if (chrobrego) insertRecurringCost.run('kredyt', chrobrego.id, 0, 'Seed default mortgage cost');
});

tx();

const propCount = db.prepare('SELECT COUNT(*) AS c FROM properties').get().c;
const unitCount = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
const setCount  = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
console.log(`✓ Seed: ${propCount} nieruchomości, ${unitCount} lokali, ${setCount} ustawień`);
