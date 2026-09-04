'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod, isValidPeriod } = require('../utils/period');
const { monthlyFinanceSummary, paidPartExpr } = require('../services/finance-summary');
const { canSeeAll, ownerId } = require('../utils/scope');
const { contractsEndingWithinDays } = require('../utils/contract-amendments');

function periodsInRange(from, to) {
  if (!isValidPeriod(from) || !isValidPeriod(to) || from > to) return null;
  const periods = [];
  let [year, month] = from.split('-').map(Number);
  while (periods.length < 24) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    periods.push(period);
    if (period === to) return periods;
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

router.get('/', (req, res) => {
  const period = req.query.period || currentPeriod();
  if (!isValidPeriod(period)) return res.status(400).json({ error: 'invalid_period' });
  const summary = monthlyFinanceSummary(db, period, req);

  res.json({
    period: summary.period,
    period_label: summary.period_label,
    properties: summary.properties,
    totals: summary.totals,
    per_unit: summary.per_unit,
    costs_by_category: summary.costs_by_category,
    owner_costs: summary.owner_costs,
    chart_12m: summary.chart_12m,
  });
});

router.get('/yearly', (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const months = Array.from(
    { length: 12 },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
  ).map((period) => {
    const s = monthlyFinanceSummary(db, period, req, { includeChart: false });
    return {
      period,
      revenue: s.revenue.gross,
      expected_revenue: s.revenue.expected,
      rent_paid: s.revenue.rent_paid,
      media: s.revenue.media,
      expenses: s.expenses.total,
      tax: s.tax.podatek_suma,
      net: s.net_for_owner,
    };
  });
  res.json({ year: +year, months });
});

router.get('/tax-yearly', (req, res) => {
  const year = String(req.query.year || new Date().getFullYear());
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'invalid_year' });
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
  const scoped = !canSeeAll(req);
  const uid = ownerId(req);

  const properties = db
    .prepare(
      `
    SELECT id, name
    FROM properties
    ${scoped ? 'WHERE owner_user_id = ?' : ''}
    ORDER BY name
  `,
    )
    .all(...(scoped ? [uid] : []));

  const rentByProperty = db.prepare(`
    SELECT COALESCE(SUM(${paidPartExpr('rent_amount', 'pm')}), 0) AS rent_paid
    FROM payments pm
    JOIN units u ON u.id = pm.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    WHERE pm.period = ?
      AND p.id = ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR p.owner_user_id = ? OR t.owner_user_id = ?)' : ''}
  `);

  const propertyRows = properties.map((property) => {
    const values = months.map((period) => {
      const row = rentByProperty.get(period, property.id, ...(scoped ? [uid, uid, uid] : []));
      return Math.round((Number(row && row.rent_paid) || 0) * 100) / 100;
    });
    return {
      property_id: property.id,
      name: property.name,
      values,
      total: Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100,
    };
  });

  const taxValues = months.map(
    (period) => monthlyFinanceSummary(db, period, req, { includeChart: false }).tax.podatek_suma || 0,
  );
  const incomeByMonth = months.map((_, index) =>
    propertyRows.reduce((sum, row) => sum + (row.values[index] || 0), 0),
  );
  const incomeTotal = Math.round(incomeByMonth.reduce((sum, value) => sum + value, 0) * 100) / 100;

  res.json({
    year: Number(year),
    months,
    properties: propertyRows,
    tax_paid: {
      values: taxValues,
      total: taxValues.reduce((sum, value) => sum + value, 0),
    },
    income: {
      by_month: incomeByMonth,
      total: incomeTotal,
    },
  });
});

router.get('/owner-statement', (req, res) => {
  const to = req.query.to || currentPeriod();
  const from =
    req.query.from ||
    (() => {
      const [year, month] = to.split('-').map(Number);
      const date = new Date(year, month - 12, 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    })();
  const periods = periodsInRange(from, to);
  if (!periods) return res.status(400).json({ error: 'invalid_report_range' });

  const propertyMap = new Map();
  const categoryMap = new Map();
  const trend = periods.map((period) => {
    const summary = monthlyFinanceSummary(db, period, req, { includeChart: false });
    for (const property of summary.properties) {
      const current = propertyMap.get(property.id) || {
        property_id: property.id,
        name: property.name,
        revenue: 0,
        expected: 0,
        expenses: 0,
        tax: 0,
        net: 0,
      };
      current.revenue += Number(property.revenue || 0);
      current.expected += Number(property.expected_revenue || 0);
      current.expenses += Number(property.expenses || 0);
      current.tax += Number(property.tax || 0);
      current.net += Number(property.net || 0);
      propertyMap.set(property.id, current);
    }
    for (const category of summary.costs_by_category) {
      categoryMap.set(
        category.category,
        (categoryMap.get(category.category) || 0) + Number(category.total || 0),
      );
    }
    return {
      period,
      revenue: summary.totals.revenue,
      expected: summary.totals.expected_revenue,
      expenses: summary.totals.expenses,
      tax: summary.totals.tax_total,
      net: summary.totals.net,
    };
  });

  const totals = trend.reduce(
    (result, month) => {
      for (const key of ['revenue', 'expected', 'expenses', 'tax', 'net'])
        result[key] += Number(month[key] || 0);
      return result;
    },
    { revenue: 0, expected: 0, expenses: 0, tax: 0, net: 0 },
  );
  for (const key of Object.keys(totals)) totals[key] = round2(totals[key]);
  totals.collection_rate = totals.expected ? round2((totals.revenue / totals.expected) * 100) : 0;
  totals.cost_ratio = totals.revenue ? round2((totals.expenses / totals.revenue) * 100) : 0;
  totals.net_margin = totals.revenue ? round2((totals.net / totals.revenue) * 100) : 0;

  const uid = ownerId(req);
  const scoped = !canSeeAll(req);
  const paymentScope = scoped
    ? 'AND (pm.owner_user_id = ? OR p.owner_user_id = ? OR t.owner_user_id = ?)'
    : '';
  const paymentParams = scoped ? [uid, uid, uid] : [];
  const arrears = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(MAX(0, COALESCE(pm.rent_amount, 0) + COALESCE(pm.media_amount, 0) +
                COALESCE(pm.other_amount, 0) - COALESCE(pm.total_paid, 0))), 0) AS amount
       FROM payments pm
       LEFT JOIN tenants t ON t.id = pm.tenant_id
       LEFT JOIN units u ON u.id = pm.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE pm.period BETWEEN ? AND ?
         AND pm.status IN ('pending', 'overdue', 'partial')
         ${paymentScope}`,
    )
    .get(from, to, ...paymentParams);
  const activeContracts = db
    .prepare(
      `SELECT c.* FROM contracts c
       LEFT JOIN tenants t ON t.id = c.tenant_id
       LEFT JOIN units u ON u.id = c.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE c.status = 'active'
       ${scoped ? 'AND (p.owner_user_id = ? OR t.owner_user_id = ?)' : ''}`,
    )
    .all(...(scoped ? [uid, uid] : []));
  const contractsEnding = contractsEndingWithinDays(db, activeContracts, 60).length;
  const expiringDocuments = db
    .prepare(
      `SELECT COUNT(*) AS count FROM documents
       WHERE workflow_status != 'archived'
         AND expires_on BETWEEN DATE('now') AND DATE('now', '+60 days')
         ${scoped ? 'AND owner_user_id = ?' : ''}`,
    )
    .get(...(scoped ? [uid] : []));
  const bank = db
    .prepare(
      `SELECT SUM(CASE WHEN status IN ('new', 'suggested') AND amount > 0 THEN 1 ELSE 0 END) AS unresolved,
              SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched,
              COALESCE(SUM(CASE WHEN status = 'matched' THEN amount ELSE 0 END), 0) AS matched_amount
       FROM bank_transactions WHERE owner_user_id IS ? AND SUBSTR(booked_date, 1, 7) BETWEEN ? AND ?`,
    )
    .get(uid, from, to);

  const properties = Array.from(propertyMap.values())
    .map((property) => ({
      ...property,
      revenue: round2(property.revenue),
      expected: round2(property.expected),
      expenses: round2(property.expenses),
      tax: round2(property.tax),
      net: round2(property.net),
      collection_rate: property.expected ? round2((property.revenue / property.expected) * 100) : 0,
      net_margin: property.revenue ? round2((property.net / property.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.net - a.net);

  res.json({
    range: { from, to, months: periods.length },
    totals,
    trend,
    properties,
    costs_by_category: Array.from(categoryMap, ([category, total]) => ({
      category,
      total: round2(total),
    })).sort((a, b) => b.total - a.total),
    risks: {
      arrears_count: Number(arrears.count || 0),
      arrears_amount: round2(arrears.amount),
      contracts_ending_60d: contractsEnding,
      documents_expiring_60d: Number(expiringDocuments.count || 0),
      bank_unresolved: Number(bank.unresolved || 0),
    },
    reconciliation: {
      matched: Number(bank.matched || 0),
      matched_amount: round2(bank.matched_amount),
      unresolved: Number(bank.unresolved || 0),
    },
  });
});

module.exports = router;
