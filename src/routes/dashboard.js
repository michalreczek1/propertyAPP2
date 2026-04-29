'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod } = require('../utils/period');
const { monthlyFinanceSummary } = require('../services/finance-summary');

router.get('/', (req, res) => {
  const period = req.query.period || currentPeriod();
  const summary = monthlyFinanceSummary(db, period);

  // Status lokali
  const occupancy = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='rented' THEN 1 ELSE 0 END) AS rented,
      SUM(CASE WHEN status='vacant' THEN 1 ELSE 0 END) AS vacant
    FROM units
  `).get();

  // Lokale do statusu (z najemcą)
  const occUnits = db.prepare(`
    SELECT u.id, u.name AS unit_name, u.code, p.name AS property_name,
           t.name AS tenant_name, u.base_rent + u.base_media AS monthly
    FROM units u
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.current_unit_id = u.id AND t.status='active'
    ORDER BY p.name, u.code
  `).all();

  // Bieżące płatności
  const currentPayments = db.prepare(`
    SELECT p.*, t.name AS tenant_name, t.avatar_color, u.name AS unit_name, u.code AS unit_code,
           pr.name AS property_name
    FROM payments p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE p.period = ?
    ORDER BY pr.name, u.code
  `).all(period);

  // Alerty
  const overdue = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(rent_amount + media_amount - total_paid), 0) AS amount
    FROM payments WHERE status='overdue'
  `).get();
  const endingContracts = db.prepare(`
    SELECT COUNT(*) AS c FROM contracts
    WHERE status='active' AND end_date IS NOT NULL
      AND DATE(end_date) <= DATE('now', '+30 days')
  `).get().c;
  const openTasks = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status='open'`).get().c;

  res.json({
    period: summary.period,
    period_label: summary.period_label,
    revenue: summary.revenue,
    expenses: summary.expenses,
    tax: summary.tax,
    net_for_owner: summary.net_for_owner,
    occupancy,
    units: occUnits,
    current_payments: currentPayments,
    alerts: {
      overdue_count: overdue.c,
      overdue_amount: overdue.amount,
      ending_contracts: endingContracts,
      open_tasks: openTasks,
    },
    chart_12m: summary.chart_12m,
  });
});

module.exports = router;
