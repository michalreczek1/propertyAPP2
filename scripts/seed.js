#!/usr/bin/env node
'use strict';
/**
 * Seed bazy podstawowymi danymi:
 *  - prawdziwe nieruchomości (Kościelna 30/21, Os. B. Chrobrego 28/21)
 *  - lokale/pokoje
 *  - domyślne ustawienia (firma, podatek)
 *
 * Idempotentny — UPSERT po name/code.
 * Seed NIE nadpisuje danych jeśli nieruchomość już istnieje (na wypadek re-deploy).
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
  ON CONFLICT(name) DO UPDATE SET
    address=excluded.address, district=excluded.district, type=excluded.type
`);

const findProperty = db.prepare('SELECT id FROM properties WHERE name = ?');

const findUnit = db.prepare('SELECT id FROM units WHERE property_id = ? AND code = ?');
const insertUnit = db.prepare(`
  INSERT INTO units (property_id, name, code, base_rent, base_media, status)
  VALUES (?, ?, ?, ?, ?, 'rented')
`);
const updateUnit = db.prepare(`
  UPDATE units SET name=?, base_rent=?, base_media=? WHERE id=?
`);

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
`);

const tx = db.transaction(() => {
  for (const p of properties) upsertProperty.run(p);
  for (const u of units) {
    const prop = findProperty.get(u.property);
    if (!prop) continue;
    const existing = findUnit.get(prop.id, u.code);
    if (existing) {
      updateUnit.run(u.name, u.base_rent, u.base_media, existing.id);
    } else {
      insertUnit.run(prop.id, u.name, u.code, u.base_rent, u.base_media);
    }
  }
  for (const [k, v] of Object.entries(settings)) upsertSetting.run(k, v);
});

tx();

const propCount = db.prepare('SELECT COUNT(*) AS c FROM properties').get().c;
const unitCount = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
const setCount  = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
console.log(`✓ Seed: ${propCount} nieruchomości, ${unitCount} lokali, ${setCount} ustawień`);
