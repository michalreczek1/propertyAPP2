'use strict';

const { periodLabel, previousPeriod, parsePeriod } = require('../utils/period');
const { computeTaxAmounts } = require('../utils/tax');
const { getOwnerCosts, ownerCostsForProperty, appendOwnerCostCategories } = require('../utils/owner-costs');
const { canSeeAll, ownerId, propertyScope } = require('../utils/scope');

function getNum(db, key, fallback = 0, req = null) {
  let row = null;
  if (!canSeeAll(req)) {
    row = db.prepare('SELECT value FROM user_settings WHERE owner_user_id = ? AND key = ?').get(ownerId(req), key);
  }
  if (!row) row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value == null || row.value === '') return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function paidExpr(alias = 'pm') {
  return `CASE
    WHEN ${alias}.status='paid' THEN (${alias}.rent_amount + ${alias}.media_amount + ${alias}.other_amount)
    WHEN ${alias}.status='partial' THEN MIN(${alias}.total_paid, ${alias}.rent_amount + ${alias}.media_amount + ${alias}.other_amount)
    ELSE 0
  END`;
}

function paidPartExpr(part, alias = 'pm') {
  return `CASE
    WHEN ${alias}.status='paid' THEN ${alias}.${part}
    WHEN ${alias}.status='partial' THEN
      CASE WHEN (${alias}.rent_amount + ${alias}.media_amount + ${alias}.other_amount) > 0
        THEN MIN(${alias}.total_paid, ${alias}.rent_amount + ${alias}.media_amount + ${alias}.other_amount) * ${alias}.${part} * 1.0 / (${alias}.rent_amount + ${alias}.media_amount + ${alias}.other_amount)
        ELSE 0 END
    ELSE 0
  END`;
}

function allocateRounded(total, rows, weightKey) {
  const safeTotal = Math.round(Number(total) || 0);
  const weightSum = rows.reduce((sum, row) => sum + (Number(row[weightKey]) || 0), 0);
  if (!safeTotal || !weightSum || !rows.length) return rows.map(() => 0);

  const raw = rows.map((row, index) => {
    const value = safeTotal * (Number(row[weightKey]) || 0) / weightSum;
    return { index, floor: Math.floor(value), frac: value - Math.floor(value) };
  });
  let left = safeTotal - raw.reduce((sum, row) => sum + row.floor, 0);
  raw.sort((a, b) => b.frac - a.frac);
  for (const row of raw) {
    if (left <= 0) break;
    row.floor += 1;
    left -= 1;
  }
  raw.sort((a, b) => a.index - b.index);
  return raw.map(row => row.floor);
}

function allocateMoneyEvenly(total, count) {
  const safeCount = Math.max(1, count || 1);
  const cents = Math.round((Number(total) || 0) * 100);
  const base = Math.floor(cents / safeCount);
  let remainder = cents - (base * safeCount);
  return Array.from({ length: safeCount }, () => {
    const value = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return value / 100;
  });
}

function monthListUntil(period, count = 12) {
  const parsed = parsePeriod(period);
  if (!parsed) return [];
  const months = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const d = new Date(parsed.year, parsed.month - 1 - offset, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

function scopePaymentClause(req, propertyAlias = 'pr', paymentAlias = 'pm', tenantAlias = 't') {
  if (canSeeAll(req)) return { sql: '', params: [] };
  const uid = ownerId(req);
  return {
    sql: `AND (${paymentAlias}.owner_user_id = ? OR ${propertyAlias}.owner_user_id = ? OR ${tenantAlias}.owner_user_id = ?)`,
    params: [uid, uid, uid],
  };
}

function baseForPeriod(db, period, req = null) {
  const scope = scopePaymentClause(req, 'pr', 'pm', 't');
  return db.prepare(`
    SELECT
      COALESCE(SUM(rent_amount + media_amount + other_amount), 0) AS gross_expected,
      COALESCE(SUM(rent_amount + media_amount + other_amount + COALESCE(late_fee_amount, 0)), 0) AS expected_with_late_fees,
      COALESCE(SUM(rent_amount), 0) AS rent_expected,
      COALESCE(SUM(media_amount), 0) AS media_expected,
      COALESCE(SUM(other_amount), 0) AS other_expected,
      COALESCE(SUM(COALESCE(late_fee_amount, 0)), 0) AS late_fee_expected,
      COALESCE(SUM(COALESCE(late_fee_paid, 0)), 0) AS late_fee_paid,
      COALESCE(SUM(MAX(COALESCE(late_fee_amount, 0) - COALESCE(late_fee_paid, 0), 0)), 0) AS late_fee_balance,
      COALESCE(SUM(${paidExpr('pm')}), 0) AS paid,
      COALESCE(SUM(${paidPartExpr('rent_amount', 'pm')}), 0) AS rent_paid,
      COALESCE(SUM(${paidPartExpr('media_amount', 'pm')}), 0) AS media_paid,
      COALESCE(SUM(${paidPartExpr('other_amount', 'pm')}), 0) AS other_paid,
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN pm.status='paid' THEN 1 ELSE 0 END), 0) AS paid_count,
      COALESCE(SUM(CASE WHEN pm.status='overdue' THEN 1 ELSE 0 END), 0) AS overdue_count,
      COALESCE(SUM(CASE WHEN pm.status='pending' THEN 1 ELSE 0 END), 0) AS pending_count
    FROM payments pm
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    WHERE pm.period = ?
    ${scope.sql}
  `).get(period, ...scope.params);
}

function costsForPeriod(db, period, req = null) {
  const ownerCosts = getOwnerCosts(db, period, req);
  const expenseScope = canSeeAll(req) ? { sql: '', params: [] } : {
    sql: 'AND (e.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ?)',
    params: [ownerId(req), ownerId(req), ownerId(req)],
  };
  const categories = db.prepare(`
    SELECT e.category, SUM(e.amount) AS total
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    WHERE strftime('%Y-%m', e.date) = ?
      ${expenseScope.sql}
    GROUP BY category
  `).all(period, ...expenseScope.params);
  const withOwner = appendOwnerCostCategories(categories, ownerCosts);
  return {
    ownerCosts,
    byCategory: withOwner,
    total: round2(withOwner.reduce((sum, row) => sum + (Number(row.total) || 0), 0)),
  };
}

function propertiesForPeriod(db, period, tax, ownerCosts, req = null) {
  const scope = propertyScope(req, 'p');
  const properties = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS units_count,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status='rented') AS units_rented,
      COALESCE((
        SELECT SUM(${paidExpr('pm')})
        FROM payments pm
        JOIN units u2 ON u2.id = pm.unit_id
        WHERE u2.property_id = p.id AND pm.period = ?
      ), 0) AS revenue,
      COALESCE((
        SELECT SUM(${paidPartExpr('rent_amount', 'pm')})
        FROM payments pm
        JOIN units u2 ON u2.id = pm.unit_id
        WHERE u2.property_id = p.id AND pm.period = ?
      ), 0) AS rent_paid,
      COALESCE((
        SELECT SUM(pm.rent_amount + pm.media_amount + pm.other_amount)
        FROM payments pm
        JOIN units u2 ON u2.id = pm.unit_id
        WHERE u2.property_id = p.id AND pm.period = ?
      ), 0) AS expected_revenue,
      COALESCE((
        SELECT SUM(e.amount)
        FROM expenses e
        WHERE e.property_id = p.id AND strftime('%Y-%m', e.date) = ?
      ), 0) AS direct_expenses
    FROM properties p
    ${scope.sql ? 'WHERE ' + scope.sql : ''}
    ORDER BY p.name
  `).all(period, period, period, period, ...scope.params);

  const propertyCount = properties.length || 1;
  const baseTaxParts = allocateRounded(tax.podatek, properties, 'rent_paid');
  const additionalTaxParts = properties.map((p) => {
    const name = String(p.name || '').toLowerCase();
    return (name.includes('kościelna') || name.includes('koscielna')) ? (tax.podatek_koscielna || 0) : 0;
  });
  if ((tax.podatek_koscielna || 0) && !additionalTaxParts.some(Boolean) && additionalTaxParts.length) {
    additionalTaxParts[0] = tax.podatek_koscielna;
  }

  return properties.map((property, index) => {
    const ownerCost = ownerCostsForProperty(ownerCosts, property.name, propertyCount, property.id);
    const expenses = round2((property.direct_expenses || 0) + ownerCost);
    const propertyTax = (baseTaxParts[index] || 0) + (additionalTaxParts[index] || 0);
    const net = round2((property.revenue || 0) - expenses - propertyTax);
    return {
      ...property,
      owner_expenses: ownerCost,
      expenses,
      tax: propertyTax,
      net,
      margin: property.revenue ? net / property.revenue : 0,
    };
  });
}

function perUnitForPeriod(db, period, ownerCosts, req = null) {
  const scope = propertyScope(req, 'p');
  const rows = db.prepare(`
    SELECT u.id AS unit_id, u.name AS unit_name, u.code AS unit_code,
           u.property_id, p.name AS property_name, p.district,
           t.name AS tenant_name, t.avatar_color,
           pm.rent_amount, pm.media_amount, pm.other_amount, pm.late_fee_amount, pm.late_fee_paid, pm.total_paid, pm.status,
           pm.rent_amount + pm.media_amount + pm.other_amount AS gross,
           COALESCE((
             SELECT SUM(e.amount)
             FROM expenses e
             WHERE e.unit_id = u.id AND strftime('%Y-%m', e.date) = ?
           ), 0) AS direct_expenses,
           COALESCE((
             SELECT SUM(e.amount)
             FROM expenses e
             WHERE e.property_id = p.id AND e.unit_id IS NULL AND strftime('%Y-%m', e.date) = ?
           ), 0) AS property_expenses,
           (SELECT COUNT(*) FROM units ux WHERE ux.property_id = p.id) AS property_units
    FROM units u
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.current_unit_id = u.id AND t.status='active'
    LEFT JOIN payments pm ON pm.unit_id = u.id AND pm.period = ?
    ${scope.sql ? 'WHERE ' + scope.sql : ''}
    ORDER BY p.name, u.code
  `).all(period, period, period, ...scope.params);

  const propertyCount = new Set(rows.map(row => row.property_id)).size || 1;
  const rowsByProperty = new Map();
  for (const row of rows) {
    const key = row.property_id;
    if (!rowsByProperty.has(key)) rowsByProperty.set(key, []);
    rowsByProperty.get(key).push(row);
  }

  const allocatedByUnit = new Map();
  for (const propertyRows of rowsByProperty.values()) {
    const first = propertyRows[0];
    const ownerForProperty = ownerCostsForProperty(ownerCosts, first.property_name, propertyCount, first.property_id);
    const shares = allocateMoneyEvenly((first.property_expenses || 0) + ownerForProperty, propertyRows.length);
    propertyRows.forEach((row, index) => allocatedByUnit.set(row.unit_id, shares[index] || 0));
  }

  return rows.map(row => {
    const allocated = allocatedByUnit.get(row.unit_id) || 0;
    return {
      ...row,
      allocated_expenses: allocated,
      expenses: round2((row.direct_expenses || 0) + allocated),
    };
  });
}

function chartForPeriod(db, period, taxRate, taxKoscielna, req = null) {
  return monthListUntil(period, 12).map((p) => {
    const base = baseForPeriod(db, p, req);
    const costs = costsForPeriod(db, p, req);
    const tax = computeTaxAmounts(base.rent_paid || 0, taxRate, taxKoscielna);
    return {
      period: p,
      revenue: round2(base.paid || 0),
      media: round2(base.media_paid || 0),
      expenses: costs.total,
      tax: tax.podatek_suma,
      rent_paid: round2(base.rent_paid || 0),
    };
  });
}

function monthlyFinanceSummary(db, period, req = null) {
  const taxRate = getNum(db, 'tax.rate', 8.5, req);
  const taxKoscielna = getNum(db, 'tax.koscielna', 0, req);
  const current = baseForPeriod(db, period, req);
  const prevPeriod = previousPeriod(period);
  const prev = prevPeriod ? baseForPeriod(db, prevPeriod, req) : { paid: 0 };
  const costs = costsForPeriod(db, period, req);
  const prevCosts = prevPeriod ? costsForPeriod(db, prevPeriod, req) : { total: 0 };
  const tax = computeTaxAmounts(current.rent_paid || 0, taxRate, taxKoscielna);
  const properties = propertiesForPeriod(db, period, tax, costs.ownerCosts, req);
  const perUnit = perUnitForPeriod(db, period, costs.ownerCosts, req);
  const net = round2((current.paid || 0) - costs.total - tax.podatek_suma);
  const chart = chartForPeriod(db, period, taxRate, taxKoscielna, req);

  return {
    period,
    period_label: periodLabel(period),
    revenue: {
      gross: round2(current.paid || 0),
      expected: round2(current.gross_expected || 0),
      expected_with_late_fees: round2(current.expected_with_late_fees || current.gross_expected || 0),
      rent: round2(current.rent_expected || 0),
      rent_paid: round2(current.rent_paid || 0),
      media: round2(current.media_paid || 0),
      media_expected: round2(current.media_expected || 0),
      other: round2(current.other_expected || 0),
      other_paid: round2(current.other_paid || 0),
      late_fee_expected: round2(current.late_fee_expected || 0),
      late_fee_paid: round2(current.late_fee_paid || 0),
      late_fee_balance: round2(current.late_fee_balance || 0),
      paid: round2(current.paid || 0),
      paid_units: current.paid_count || 0,
      total_units: current.count || 0,
      delta_vs_prev: prev.paid ? ((current.paid || 0) - prev.paid) / prev.paid : 0,
    },
    expenses: {
      total: costs.total,
      recurring_owner: costs.ownerCosts,
      delta_vs_prev: prevCosts.total ? (costs.total - prevCosts.total) / prevCosts.total : 0,
      by_category: costs.byCategory,
    },
    tax,
    net_for_owner: net,
    properties,
    per_unit: perUnit,
    costs_by_category: costs.byCategory,
    owner_costs: costs.ownerCosts,
    chart_12m: chart,
    totals: {
      revenue: round2(current.paid || 0),
      rent_paid: round2(current.rent_paid || 0),
      tax_base: tax.base,
      expected_revenue: round2(current.gross_expected || 0),
      expected_revenue_with_late_fees: round2(current.expected_with_late_fees || current.gross_expected || 0),
      late_fee_paid: round2(current.late_fee_paid || 0),
      late_fee_balance: round2(current.late_fee_balance || 0),
      expenses: costs.total,
      tax: tax.podatek,
      tax_koscielna: tax.podatek_koscielna,
      tax_total: tax.podatek_suma,
      tax_rate: taxRate,
      net,
      margin: current.paid ? net / current.paid : 0,
    },
  };
}

module.exports = {
  monthlyFinanceSummary,
  paidExpr,
  paidPartExpr,
};
