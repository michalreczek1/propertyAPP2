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

function appendOwnerCostCategories(categories, ownerCosts) {
  const rows = categories.map(row => ({ ...row }));
  if (ownerCosts.management) rows.push({ category: 'zarzadzanie', total: ownerCosts.management });
  if (ownerCosts.mortgage_total) rows.push({ category: 'kredyt', total: ownerCosts.mortgage_total });
  return rows;
}

module.exports = {
  getOwnerCosts,
  ownerCostsForProperty,
  appendOwnerCostCategories,
};
