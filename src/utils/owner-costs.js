'use strict';

function toNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getSetting(db, key, fallback = 0) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return toNumber(row && row.value, fallback);
}

function getOwnerCosts(db) {
  const management = getSetting(db, 'cost.management.monthly', 500);
  const mortgageKoscielna = getSetting(db, 'cost.mortgage.koscielna.monthly', 0);
  const mortgageChrobrego = getSetting(db, 'cost.mortgage.chrobrego.monthly', 0);
  return {
    management,
    mortgage_koscielna: mortgageKoscielna,
    mortgage_chrobrego: mortgageChrobrego,
    mortgage_total: mortgageKoscielna + mortgageChrobrego,
    total: management + mortgageKoscielna + mortgageChrobrego,
  };
}

function ownerCostsForProperty(ownerCosts, propertyName, propertyCount = 2) {
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
  const ownerCosts = getOwnerCosts(db);
  const properties = db.prepare('SELECT id, name FROM properties ORDER BY name').all();
  const propertyCount = properties.length || 1;
  const months = monthRangeFromDates(filters.from || filters.period, filters.to || filters.period);
  const rows = [];

  for (const period of months) {
    const date = `${period}-01`;
    for (const property of properties) {
      const managementShare = +(ownerCosts.management / propertyCount).toFixed(2);
      const lowerName = String(property.name || '').toLowerCase();
      const mortgage = lowerName.includes('kościelna') || lowerName.includes('koscielna')
        ? ownerCosts.mortgage_koscielna
        : lowerName.includes('chrobrego')
          ? ownerCosts.mortgage_chrobrego
          : 0;

      if (managementShare) {
        rows.push({
          id: `owner-zarzadzanie-${period}-${property.id}`,
          system: true,
          read_only: true,
          property_id: property.id,
          unit_id: null,
          category: 'zarzadzanie',
          amount: managementShare,
          date,
          description: 'Koszt właściciela: zarządzanie',
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
          date,
          description: 'Koszt właściciela: rata kredytu',
          document_path: null,
          created_at: null,
          property_name: property.name,
          unit_name: null,
          unit_code: null,
        });
      }
    }
  }

  return rows.filter(row => {
    if (filters.category && row.category !== filters.category) return false;
    if (filters.property_id && String(row.property_id) !== String(filters.property_id)) return false;
    return true;
  });
}

function appendOwnerCostCategories(categories, ownerCosts) {
  const rows = categories.map(row => ({ ...row }));
  if (ownerCosts.management) rows.push({ category: 'zarzadzanie', total: ownerCosts.management });
  if (ownerCosts.mortgage_total) rows.push({ category: 'kredyt', total: ownerCosts.mortgage_total });
  return rows;
}

module.exports = {
  getOwnerCosts,
  ownerCostsForProperty,
  ownerExpenseRows,
  appendOwnerCostCategories,
};
