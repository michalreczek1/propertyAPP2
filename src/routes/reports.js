'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod } = require('../utils/period');
const { monthlyFinanceSummary } = require('../services/finance-summary');

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

module.exports = router;
