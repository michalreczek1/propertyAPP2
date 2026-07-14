'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod, isValidPeriod } = require('../utils/period');
const { canSeeAll, ownerId, propertyScope } = require('../utils/scope');

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

function settingsMap(req) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  if (!canSeeAll(req) && tableExists('user_settings')) {
    const scopedRows = db
      .prepare('SELECT key, value FROM user_settings WHERE owner_user_id = ?')
      .all(ownerId(req));
    for (const r of scopedRows) map[r.key] = r.value;
  }
  if (!map['costs.valid_from_period']) map['costs.valid_from_period'] = '2026-01';
  return map;
}

function getSetting(req, key, fallback = null) {
  const row =
    !canSeeAll(req) && tableExists('user_settings')
      ? db
          .prepare('SELECT value FROM user_settings WHERE owner_user_id = ? AND key = ?')
          .get(ownerId(req), key)
      : null;
  if (row) return row.value;
  const global = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return global ? global.value : fallback;
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
      if (text && !isValidPeriod(text)) {
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
  const plain = fragment
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const row = rows.find((p) =>
    String(p.name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .includes(plain),
  );
  return row ? row.id : null;
}

function upsertRecurringCost(category, propertyId, amount, validFrom, notes, userId = null) {
  if (!tableExists('recurring_costs')) return;
  const existing = db
    .prepare(
      `
    SELECT id FROM recurring_costs
    WHERE category = ?
      AND COALESCE(property_id, 0) = COALESCE(?, 0)
      AND COALESCE(owner_user_id, 0) = COALESCE(?, 0)
      AND valid_from_period = ?
      AND active = 1
    LIMIT 1
  `,
    )
    .get(category, propertyId, userId, validFrom);
  if (existing) {
    db.prepare(
      `
      UPDATE recurring_costs
      SET amount = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(amount, notes, existing.id);
  } else {
    db.prepare(
      `
      INSERT INTO recurring_costs(category, owner_user_id, property_id, amount, valid_from_period, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
    ).run(category, userId, propertyId, amount, validFrom, notes);
  }
}

function syncRecurringCosts(body, req) {
  const hasCostUpdate = [
    'cost.management.monthly',
    'cost.mortgage.koscielna.monthly',
    'cost.mortgage.chrobrego.monthly',
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (!hasCostUpdate) return;
  const validFrom = String(
    body['costs.valid_from_period'] || getSetting(req, 'costs.valid_from_period', '2026-01'),
  );
  const uid = ownerId(req);
  if (Object.prototype.hasOwnProperty.call(body, 'cost.management.monthly')) {
    upsertRecurringCost(
      'zarzadzanie',
      null,
      Number(body['cost.management.monthly'] || 0),
      validFrom,
      'Owner management cost from settings',
      uid,
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cost.mortgage.koscielna.monthly')) {
    upsertRecurringCost(
      'kredyt',
      propertyIdByName('koscielna'),
      Number(body['cost.mortgage.koscielna.monthly'] || 0),
      validFrom,
      'Mortgage cost from settings',
      uid,
    );
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cost.mortgage.chrobrego.monthly')) {
    upsertRecurringCost(
      'kredyt',
      propertyIdByName('chrobrego'),
      Number(body['cost.mortgage.chrobrego.monthly'] || 0),
      validFrom,
      'Mortgage cost from settings',
      uid,
    );
  }
}

router.get('/', (req, res) => {
  res.json(settingsMap(req));
});

function activeRecurringCost(category, propertyId, period, req) {
  if (!tableExists('recurring_costs')) return null;
  const uid = ownerId(req);
  const ownerClause = canSeeAll(req) ? '' : 'AND COALESCE(rc.owner_user_id, 0) = COALESCE(?, 0)';
  const ownerParams = canSeeAll(req) ? [] : [uid];
  return db
    .prepare(
      `
    SELECT *
    FROM recurring_costs rc
    WHERE rc.active = 1
      AND rc.category = ?
      AND COALESCE(rc.property_id, 0) = COALESCE(?, 0)
      ${ownerClause}
      AND rc.valid_from_period <= ?
      AND (rc.valid_to_period IS NULL OR rc.valid_to_period = '' OR rc.valid_to_period >= ?)
    ORDER BY rc.valid_from_period DESC, rc.id DESC
    LIMIT 1
  `,
    )
    .get(category, propertyId, ...ownerParams, period, period);
}

router.get('/owner-costs', (req, res) => {
  const savedPeriod = getSetting(req, 'costs.valid_from_period', '2026-01');
  const period = String(req.query.period || savedPeriod || '2026-01');
  if (!isValidPeriod(period)) return res.status(400).json({ error: 'invalid_period' });
  const scope = propertyScope(req, 'p');
  const properties = db
    .prepare(
      `
    SELECT id, name FROM properties p
    ${scope.sql ? 'WHERE ' + scope.sql : ''}
    ORDER BY name COLLATE NOCASE
  `,
    )
    .all(...scope.params);
  const management = activeRecurringCost('zarzadzanie', null, period, req);
  const mortgages = properties.map((property) => {
    const row = activeRecurringCost('kredyt', property.id, period, req);
    return {
      property_id: property.id,
      property_name: property.name,
      amount: row ? Number(row.amount || 0) : 0,
      valid_from_period: row ? row.valid_from_period : null,
    };
  });
  res.json({
    valid_from_period: period,
    management_monthly: management
      ? Number(management.amount || 0)
      : numFromSettings(req, 'cost.management.monthly', 0),
    mortgages,
  });
});

function numFromSettings(req, key, fallback) {
  const n = Number(getSetting(req, key, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAmount(value, key) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`invalid_number:${key}`);
    err.status = 400;
    throw err;
  }
  return n;
}

router.put('/owner-costs', (req, res) => {
  const body = req.body || {};
  const validFrom = String(body.valid_from_period || '2026-01').trim();
  if (!isValidPeriod(validFrom)) return res.status(400).json({ error: 'invalid_period' });
  if (!Array.isArray(body.mortgages)) return res.status(400).json({ error: 'invalid_mortgages' });

  let management;
  let mortgages;
  try {
    management = normalizeAmount(body.management_monthly, 'management_monthly');
    mortgages = body.mortgages.map((row) => ({
      property_id: Number(row.property_id),
      amount: normalizeAmount(row.amount, `mortgage:${row.property_id}`),
    }));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'invalid_owner_costs' });
  }

  const scope = propertyScope(req, 'p');
  const known = new Set(
    db
      .prepare(
        `
    SELECT id FROM properties p
    ${scope.sql ? 'WHERE ' + scope.sql : ''}
  `,
      )
      .all(...scope.params)
      .map((row) => Number(row.id)),
  );
  for (const row of mortgages) {
    if (!Number.isInteger(row.property_id) || !known.has(row.property_id)) {
      return res.status(400).json({ error: `unknown_property:${row.property_id}` });
    }
  }

  const uid = ownerId(req);
  const upsertGlobalSetting = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const upsertUserSetting = db.prepare(`
    INSERT INTO user_settings(owner_user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_user_id, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    if (canSeeAll(req)) {
      upsertGlobalSetting.run('costs.valid_from_period', validFrom);
      upsertGlobalSetting.run('cost.management.monthly', String(management));
    } else {
      upsertUserSetting.run(uid, 'costs.valid_from_period', validFrom);
      upsertUserSetting.run(uid, 'cost.management.monthly', String(management));
    }
    upsertRecurringCost(
      'zarzadzanie',
      null,
      management,
      validFrom,
      'Owner management cost from settings',
      uid,
    );
    for (const row of mortgages) {
      upsertRecurringCost(
        'kredyt',
        row.property_id,
        row.amount,
        validFrom,
        'Mortgage cost from settings',
        uid,
      );
    }
  });
  tx();
  res.json({ ok: true, valid_from_period: validFrom });
});

router.put('/owner-costs/mortgage', (req, res) => {
  const body = req.body || {};
  const validFrom = String(body.valid_from_period || '2026-01').trim();
  if (!isValidPeriod(validFrom)) return res.status(400).json({ error: 'invalid_period' });

  let amount;
  const propertyId = Number(body.property_id);
  try {
    amount = normalizeAmount(body.amount, 'amount');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'invalid_owner_mortgage' });
  }

  const scope = propertyScope(req, 'p');
  const property = db
    .prepare(
      `
    SELECT id FROM properties p
    WHERE p.id = ?
      ${scope.sql ? 'AND ' + scope.sql : ''}
  `,
    )
    .get(propertyId, ...scope.params);
  if (!Number.isInteger(propertyId) || !property)
    return res.status(400).json({ error: `unknown_property:${body.property_id}` });

  upsertRecurringCost(
    'kredyt',
    propertyId,
    amount,
    validFrom,
    'Mortgage cost from expenses edit',
    ownerId(req),
  );
  res.json({ ok: true, property_id: propertyId, amount, valid_from_period: validFrom });
});

router.put('/', (req, res) => {
  const upsertGlobal = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const upsertUser = db.prepare(`
    INSERT INTO user_settings(owner_user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_user_id, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (canSeeAll(req)) upsertGlobal.run(k, v == null ? '' : String(v));
      else upsertUser.run(ownerId(req), k, v == null ? '' : String(v));
    }
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
  syncRecurringCosts(req.body, req);
  res.json(settingsMap(req));
});

module.exports = router;
