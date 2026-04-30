'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod } = require('../utils/period');
const { monthlyFinanceSummary, paidPartExpr } = require('../services/finance-summary');
const { canSeeAll, ownerId } = require('../utils/scope');

router.get('/', (req, res) => {
  const period = req.query.period || currentPeriod();
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
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`)
    .map((period) => {
      const s = monthlyFinanceSummary(db, period, req);
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

  const properties = db.prepare(`
    SELECT id, name
    FROM properties
    ${scoped ? 'WHERE owner_user_id = ?' : ''}
    ORDER BY name
  `).all(...(scoped ? [uid] : []));

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

  const taxValues = months.map((period) => monthlyFinanceSummary(db, period, req).tax.podatek_suma || 0);
  const incomeByMonth = months.map((_, index) => propertyRows.reduce((sum, row) => sum + (row.values[index] || 0), 0));
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

module.exports = router;
