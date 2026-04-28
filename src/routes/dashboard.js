'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod, previousPeriod, periodLabel } = require('../utils/period');
const { computeTaxAmounts } = require('../utils/tax');

function getNum(key, fallback = 0) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r || r.value == null || r.value === '') return fallback;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : fallback;
}

function computeTax(rentPaid) {
  // Ryczałt 8,5% liczony WYŁĄCZNIE od czynszu (rent_amount).
  // Zaokrąglenie zgodnie z Art. 63 § 1 Ordynacji podatkowej:
  // - podstawę opodatkowania zaokrągla się do pełnych zł (≥50 gr w górę, <50 gr w dół)
  // - kwotę podatku zaokrągla się do pełnych zł
  const rate = getNum('tax.rate', 8.5);
  const koscielna = getNum('tax.koscielna', 0);
  return computeTaxAmounts(rentPaid, rate, koscielna);
}

router.get('/', (req, res) => {
  const period = req.query.period || currentPeriod();
  const prev = previousPeriod(period);

  // Bieżący miesiąc — agregaty z payments.
  // „Przychód zatwierdzony" = pełna należność gdy status='paid', total_paid gdy 'partial'.
  const sumCurrent = db.prepare(`
    SELECT
      SUM(rent_amount + media_amount + other_amount) AS gross_expected,
      SUM(rent_amount)  AS rent_expected,
      SUM(media_amount) AS media_expected,
      SUM(other_amount) AS other_expected,
      SUM(CASE
        WHEN status='paid'    THEN (rent_amount + media_amount + other_amount)
        WHEN status='partial' THEN total_paid
        ELSE 0
      END) AS paid,
      SUM(CASE
        WHEN status='paid'    THEN rent_amount
        WHEN status='partial' THEN
          CASE WHEN (rent_amount + media_amount + other_amount) > 0
            THEN total_paid * rent_amount * 1.0 / (rent_amount + media_amount + other_amount)
            ELSE 0 END
        ELSE 0
      END) AS rent_paid,
      SUM(CASE
        WHEN status='paid'    THEN media_amount
        WHEN status='partial' THEN
          CASE WHEN (rent_amount + media_amount + other_amount) > 0
            THEN total_paid * media_amount * 1.0 / (rent_amount + media_amount + other_amount)
            ELSE 0 END
        ELSE 0
      END) AS media_paid,
      COUNT(*) AS count,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status='overdue' THEN 1 ELSE 0 END) AS overdue_count,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count
    FROM payments
    WHERE period = ?
  `).get(period);

  const sumPrev = db.prepare(`
    SELECT
      SUM(CASE
        WHEN status='paid'    THEN (rent_amount + media_amount + other_amount)
        WHEN status='partial' THEN total_paid
        ELSE 0
      END) AS paid,
      SUM(rent_amount + media_amount + other_amount) AS gross,
      SUM(media_amount) AS media
    FROM payments WHERE period = ?
  `).get(prev || '');

  // Koszty w okresie
  const expensesByCat = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM expenses WHERE strftime('%Y-%m', date) = ? GROUP BY category
  `).all(period);
  const expensesTotal = expensesByCat.reduce((s, r) => s + (r.total || 0), 0);
  const expensesPrev = db.prepare(`
    SELECT SUM(amount) AS total FROM expenses WHERE strftime('%Y-%m', date) = ?
  `).get(prev || '').total || 0;

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

  // Wykres 12 miesięcy: revenue (zatwierdzone wpłaty), media, podatek liczony OD CZYNSZU.
  const taxRate = getNum('tax.rate', 8.5);
  const taxKoscielna = getNum('tax.koscielna', 0);
  const last12 = db.prepare(`
    WITH RECURSIVE months(p) AS (
      SELECT strftime('%Y-%m', DATE(?, '-11 months', 'start of month'))
      UNION ALL
      SELECT strftime('%Y-%m', DATE(p || '-01', '+1 month'))
      FROM months WHERE p < ?
    )
    SELECT m.p AS period,
      COALESCE((SELECT SUM(CASE
        WHEN status='paid'    THEN (rent_amount + media_amount + other_amount)
        WHEN status='partial' THEN total_paid ELSE 0 END) FROM payments WHERE period = m.p), 0) AS revenue,
      COALESCE((SELECT SUM(media_amount) FROM payments WHERE period = m.p AND status='paid'), 0) AS media,
      COALESCE((SELECT SUM(amount) FROM expenses WHERE strftime('%Y-%m', date) = m.p), 0) AS expenses,
      ROUND(COALESCE((SELECT SUM(CASE
        WHEN status='paid'    THEN rent_amount
        WHEN status='partial' THEN
          CASE WHEN (rent_amount + media_amount + other_amount) > 0
            THEN total_paid * rent_amount * 1.0 / (rent_amount + media_amount + other_amount)
            ELSE 0 END
        ELSE 0 END) FROM payments WHERE period = m.p), 0)) AS rent_paid
    FROM months m
    ORDER BY m.p
  `).all(period + '-01', period).map(row => ({
    ...row,
    tax: computeTaxAmounts(row.rent_paid || 0, taxRate, taxKoscielna).podatek_suma,
  }));

  // Podatek liczony od zatwierdzonego CZYNSZU (rent_amount), nie od mediów.
  const paid = sumCurrent.paid || 0;
  const rentPaid = sumCurrent.rent_paid || 0;
  const tax = computeTax(rentPaid);
  const expectedGross = sumCurrent.gross_expected || 0;

  res.json({
    period,
    period_label: periodLabel(period),
    revenue: {
      gross: paid,                                      // przychód = zatwierdzone (czynsz+media+inne)
      expected: expectedGross,                          // oczekiwany (z harmonogramu)
      rent: sumCurrent.rent_expected || 0,              // oczekiwany czynsz
      rent_paid: rentPaid,                              // zatwierdzony czynsz (podstawa podatku)
      media: sumCurrent.media_paid || 0,                // ZATWIERDZONE media (nie nominał!)
      media_expected: sumCurrent.media_expected || 0,
      other: sumCurrent.other_expected || 0,
      paid,
      paid_units: sumCurrent.paid_count || 0,
      total_units: sumCurrent.count || 0,
      delta_vs_prev: sumPrev.paid ? (paid - sumPrev.paid) / sumPrev.paid : 0,
    },
    expenses: {
      total: expensesTotal,
      delta_vs_prev: expensesPrev ? (expensesTotal - expensesPrev) / expensesPrev : 0,
      by_category: expensesByCat,
    },
    tax,
    net_for_owner: +(paid - expensesTotal - tax.podatek_suma).toFixed(2),
    occupancy,
    units: occUnits,
    current_payments: currentPayments,
    alerts: {
      overdue_count: overdue.c,
      overdue_amount: overdue.amount,
      ending_contracts: endingContracts,
      open_tasks: openTasks,
    },
    chart_12m: last12,
  });
});

module.exports = router;
