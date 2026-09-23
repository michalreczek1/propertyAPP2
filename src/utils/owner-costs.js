'use strict';

const { currentPeriod } = require('./period');
const { canSeeAll, ownerId } = require('./scope');

function toNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getSetting(db, key, fallback = 0, req = null) {
  const row = !canSeeAll(req)
    ? db.prepare('SELECT value FROM user_settings WHERE owner_user_id = ? AND key = ?').get(ownerId(req), key)
    : db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return toNumber(row && row.value, fallback);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function getRecurringRows(db, period, req = null) {
  if (!tableExists(db, 'recurring_costs')) return [];
  const hasOwnerColumn = db
    .prepare('PRAGMA table_info(recurring_costs)')
    .all()
    .some((column) => column.name === 'owner_user_id');
  const uid = ownerId(req);
  const scopeParams = canSeeAll(req) ? [] : [uid, uid];
  const scopeClause = canSeeAll(req)
    ? ''
    : `
      AND (
        (rc.property_id IS NULL AND rc.owner_user_id = @uid)
        OR p.owner_user_id = @uid
      )
  `;
  return db
    .prepare(
      `
    SELECT rc.*, p.name AS property_name
    FROM recurring_costs rc
    LEFT JOIN properties p ON p.id = rc.property_id
    WHERE rc.active = 1
      ${scopeClause}
      AND rc.valid_from_period <= ?
      AND (rc.valid_to_period IS NULL OR rc.valid_to_period = '' OR rc.valid_to_period >= ?)
      AND rc.valid_from_period = (
        SELECT MAX(rc2.valid_from_period)
        FROM recurring_costs rc2
        WHERE rc2.active = 1
          AND rc2.category = rc.category
          AND COALESCE(rc2.property_id, 0) = COALESCE(rc.property_id, 0)
          ${hasOwnerColumn ? 'AND COALESCE(rc2.owner_user_id, 0) = COALESCE(rc.owner_user_id, 0)' : ''}
          AND rc2.valid_from_period <= ?
          AND (rc2.valid_to_period IS NULL OR rc2.valid_to_period = '' OR rc2.valid_to_period >= ?)
      )
    ORDER BY rc.category, rc.property_id
  `.replaceAll('@uid', '?'),
    )
    .all(...scopeParams, period, period, period, period);
}

function scopedProperties(db, req = null) {
  const scopeSql = req && !canSeeAll(req) ? 'WHERE owner_user_id = ?' : '';
  const params = req && !canSeeAll(req) ? [ownerId(req)] : [];
  return db
    .prepare(`SELECT id, name FROM properties ${scopeSql} ORDER BY name COLLATE NOCASE`)
    .all(...params);
}

function monthlyStatus(db, period, req = null) {
  if (!tableExists(db, 'recurring_cost_month_status')) return new Map();
  const scoped = req && !canSeeAll(req);
  const rows = db
    .prepare(
      `
      SELECT s.category, s.property_id, s.exists_in_month
      FROM recurring_cost_month_status s
      LEFT JOIN properties p ON p.id = s.property_id
      WHERE s.period = ?
        ${scoped ? 'AND s.owner_user_id = ? AND p.owner_user_id = ?' : ''}
    `,
    )
    .all(period, ...(scoped ? [ownerId(req), ownerId(req)] : []));
  return new Map(
    rows.map((row) => [`${row.category}:${Number(row.property_id || 0)}`, Number(row.exists_in_month) !== 0]),
  );
}

function getOwnerCosts(db, period = currentPeriod(), req = null) {
  const rows = getRecurringRows(db, period, req);
  const properties = scopedProperties(db, req);
  const statuses = monthlyStatus(db, period, req);
  const isPresent = (category, propertyId) =>
    statuses.get(`${category}:${Number(propertyId || 0)}`) !== false;
  const byProperty = Object.fromEntries(
    properties.map((property) => [
      property.id,
      {
        management: 0,
        management_configured: 0,
        management_present: true,
        mortgage: 0,
        mortgage_configured: 0,
        mortgage_present: true,
        total: 0,
      },
    ]),
  );
  let managementConfigured = rows.length
    ? rows.filter((row) => row.category === 'zarzadzanie').reduce((sum, row) => sum + toNumber(row.amount), 0)
    : getSetting(db, 'cost.management.monthly', 0, req);
  let mortgageConfiguredTotal = 0;
  let mortgageKoscielna = 0;
  let mortgageChrobrego = 0;

  const mortgageRows = rows.length
    ? rows.filter((row) => row.category === 'kredyt')
    : properties.map((property) => {
        const name = String(property.name || '').toLowerCase();
        return {
          property_id: property.id,
          property_name: property.name,
          amount:
            name.includes('kościelna') || name.includes('koscielna')
              ? getSetting(db, 'cost.mortgage.koscielna.monthly', 0, req)
              : name.includes('chrobrego')
                ? getSetting(db, 'cost.mortgage.chrobrego.monthly', 0, req)
                : 0,
        };
      });

  let management = 0;
  const managementShare = managementConfigured / Math.max(1, properties.length || 1);
  for (const property of properties) {
    const item = byProperty[property.id];
    item.management_configured = managementShare;
    item.management_present = isPresent('zarzadzanie', property.id);
    if (item.management_present) {
      item.management = managementShare;
      item.total += managementShare;
      management += managementShare;
    }
  }

  let mortgageTotal = 0;
  for (const row of mortgageRows) {
    const amount = toNumber(row.amount, 0);
    mortgageConfiguredTotal += amount;
    const item = byProperty[row.property_id];
    if (!item) continue;
    item.mortgage_configured += amount;
    item.mortgage_present = isPresent('kredyt', row.property_id);
    if (!item.mortgage_present) continue;
    item.mortgage += amount;
    item.total += amount;
    mortgageTotal += amount;
    const name = String(row.property_name || '').toLowerCase();
    if (name.includes('kościelna') || name.includes('koscielna')) mortgageKoscielna += amount;
    else if (name.includes('chrobrego')) mortgageChrobrego += amount;
  }

  return {
    management,
    management_configured: managementConfigured,
    mortgage_koscielna: mortgageKoscielna,
    mortgage_chrobrego: mortgageChrobrego,
    mortgage_total: mortgageTotal,
    mortgage_configured_total: mortgageConfiguredTotal,
    total: management + mortgageTotal,
    by_property: byProperty,
    period,
    source: rows.length ? 'recurring_costs' : 'settings',
  };
}

function ownerCostsForProperty(ownerCosts, propertyName, propertyCount = 2, propertyId = null) {
  if (propertyId && ownerCosts.by_property && ownerCosts.by_property[propertyId]) {
    return +Number(ownerCosts.by_property[propertyId].total || 0).toFixed(2);
  }
  const name = String(propertyName || '').toLowerCase();
  const managementShare = (ownerCosts.management || 0) / Math.max(1, propertyCount || 1);
  let mortgage = 0;
  if (name.includes('kościelna') || name.includes('koscielna')) {
    mortgage = ownerCosts.mortgage_koscielna || 0;
  } else if (name.includes('chrobrego')) {
    mortgage = ownerCosts.mortgage_chrobrego || 0;
  }
  return +(managementShare + mortgage).toFixed(2);
}

function monthRangeFromDates(from, to) {
  const start = String(from || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const end = String(to || from || start).slice(0, 7);
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function ownerExpenseRows(db, filters = {}) {
  const scopeSql = filters.user && !canSeeAll(filters.user) ? 'WHERE owner_user_id = ?' : '';
  const scopeParams = filters.user && !canSeeAll(filters.user) ? [ownerId(filters.user)] : [];
  const properties = db
    .prepare(`SELECT id, name FROM properties ${scopeSql} ORDER BY name`)
    .all(...scopeParams);
  const months = monthRangeFromDates(filters.from || filters.period, filters.to || filters.period);
  const rows = [];

  for (const period of months) {
    const ownerCosts = getOwnerCosts(db, period, filters.user || null);
    const date = `${period}-01`;
    for (const property of properties) {
      const propertyCosts = ownerCosts.by_property[property.id] || {};
      const managementShare = +(propertyCosts.management_configured || 0).toFixed(2);
      const mortgage = +(propertyCosts.mortgage_configured || 0).toFixed(2);

      if (managementShare) {
        rows.push({
          id: `owner-zarzadzanie-${period}-${property.id}`,
          system: true,
          read_only: true,
          property_id: property.id,
          unit_id: null,
          category: 'zarzadzanie',
          amount: managementShare,
          present: propertyCosts.management_present !== false,
          date,
          description: 'Zarządzanie nieruchomościami',
          document_path: null,
          created_at: null,
          property_name: property.name,
          unit_name: null,
          unit_code: null,
        });
      }

      if (mortgage) {
        rows.push({
          id: `owner-kredyt-${period}-${property.id}`,
          system: true,
          read_only: true,
          property_id: property.id,
          unit_id: null,
          category: 'kredyt',
          amount: mortgage,
          present: propertyCosts.mortgage_present !== false,
          date,
          description: 'Rata kredytu hipotecznego',
          document_path: null,
          created_at: null,
          property_name: property.name,
          unit_name: null,
          unit_code: null,
        });
      }
    }
  }

  return rows.filter((row) => {
    if (filters.category && row.category !== filters.category) return false;
    if (filters.property_id && String(row.property_id) !== String(filters.property_id)) return false;
    return true;
  });
}

function appendOwnerCostCategories(categories, ownerCosts) {
  const byCategory = new Map();
  for (const row of categories) {
    const key = row.category;
    byCategory.set(key, { ...row, total: toNumber(row.total, 0) });
  }
  function add(category, amount) {
    const total = toNumber(amount, 0);
    if (!total) return;
    const before = byCategory.get(category) || { category, total: 0 };
    before.total = +(toNumber(before.total, 0) + total).toFixed(2);
    byCategory.set(category, before);
  }
  add('zarzadzanie', ownerCosts.management);
  add('kredyt', ownerCosts.mortgage_total);
  return Array.from(byCategory.values()).sort((a, b) => (b.total || 0) - (a.total || 0));
}

module.exports = {
  getOwnerCosts,
  ownerCostsForProperty,
  ownerExpenseRows,
  appendOwnerCostCategories,
};
