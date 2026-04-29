'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod } = require('../utils/period');

const ALLOWED_KEYS = new Set([
  'company.name',
  'company.address',
  'company.nip',
  'tax.rate',
  'tax.koscielna',
  'cost.management.monthly',
  'cost.mortgage.koscielna.monthly',
  'cost.mortgage.chrobrego.monthly',
  'costs.valid_from_period',
  'currency',
  'locale',
  'app.title',
]);

const NUMERIC_KEYS = new Set([
  'tax.rate',
  'tax.koscielna',
  'cost.management.monthly',
  'cost.mortgage.koscielna.monthly',
  'cost.mortgage.chrobrego.monthly',
]);

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function normalizeEntries(body) {
  const entries = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      const err = new Error(`unknown_setting:${key}`);
      err.status = 400;
      throw err;
    }
    const text = value == null ? '' : String(value).trim();
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(text || 0);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error(`invalid_number:${key}`);
        err.status = 400;
        throw err;
      }
      entries.push([key, String(n)]);
    } else if (key === 'costs.valid_from_period') {
      if (text && !/^\d{4}-\d{2}$/.test(text)) {
        const err = new Error('invalid_period:costs.valid_from_period');
        err.status = 400;
        throw err;
      }
      entries.push([key, text || currentPeriod()]);
    } else {
      entries.push([key, text]);
    }
  }
  return entries;
}

function propertyIdByName(fragment) {
  const rows = db.prepare('SELECT id, name FROM properties').all();
  const plain = fragment.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const row = rows.find(p => String(p.name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(plain));
  return row ? row.id : null;
}

function upsertRecurringCost(category, propertyId, amount, validFrom, notes) {
  if (!tableExists('recurring_costs')) return;
  const existing = db.prepare(`
    SELECT id FROM recurring_costs
    WHERE category = ?
      AND COALESCE(property_id, 0) = COALESCE(?, 0)
      AND valid_from_period = ?
      AND active = 1
    LIMIT 1
  `).get(category, propertyId, validFrom);
  if (existing) {
    db.prepare(`
      UPDATE recurring_costs
      SET amount = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(amount, notes, existing.id);
  } else {
    db.prepare(`
      INSERT INTO recurring_costs(category, property_id, amount, valid_from_period, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(category, propertyId, amount, validFrom, notes);
  }
}

function syncRecurringCosts(body) {
  const hasCostUpdate = ['cost.management.monthly', 'cost.mortgage.koscielna.monthly', 'cost.mortgage.chrobrego.monthly']
    .some(key => Object.prototype.hasOwnProperty.call(body, key));
  if (!hasCostUpdate) return;
  const validFrom = String(body['costs.valid_from_period'] || db.prepare('SELECT value FROM settings WHERE key = ?').get('costs.valid_from_period')?.value || '2026-01');
  if (Object.prototype.hasOwnProperty.call(body, 'cost.management.monthly')) {
    upsertRecurringCost('zarzadzanie', null, Number(body['cost.management.monthly'] || 0), validFrom, 'Owner management cost from settings');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cost.mortgage.koscielna.monthly')) {
    upsertRecurringCost('kredyt', propertyIdByName('koscielna'), Number(body['cost.mortgage.koscielna.monthly'] || 0), validFrom, 'Mortgage cost from settings');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cost.mortgage.chrobrego.monthly')) {
    upsertRecurringCost('kredyt', propertyIdByName('chrobrego'), Number(body['cost.mortgage.chrobrego.monthly'] || 0), validFrom, 'Mortgage cost from settings');
  }
}

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  if (!map['costs.valid_from_period']) map['costs.valid_from_period'] = '2026-01';
  res.json(map);
});

router.put('/', (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, v == null ? '' : String(v));
  });
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  let entries;
  try {
    entries = normalizeEntries(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'invalid_settings' });
  }
  tx(entries);
  syncRecurringCosts(req.body);
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  res.json(map);
});

module.exports = router;
