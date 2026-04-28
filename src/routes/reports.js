'use strict';
const router = require('express').Router();
const db = require('../db');
const { currentPeriod, periodLabel } = require('../utils/period');

function getNum(key, fallback = 0) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r || r.value == null || r.value === '') return fallback;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/', (req, res) => {
  const period = req.query.period || currentPeriod();
  const taxRate = getNum('tax.rate', 8.5);
  const taxKoscielna = getNum('tax.koscielna', 0);

  // Per nieruchomość — przychód = zatwierdzone wpłaty + osobno suma czynszu (do podatku)
  const properties = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS units_count,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status='rented') AS units_rented,
      COALESCE((
        SELECT SUM(CASE
          WHEN pm.status='paid'    THEN (pm.rent_amount + pm.media_amount + pm.other_amount)
          WHEN pm.status='partial' THEN pm.total_paid ELSE 0 END)
        FROM payments pm
        JOIN units u2 ON u2.id = pm.unit_id
        WHERE u2.property_id = p.id AND pm.period = ?
      ), 0) AS revenue,
      COALESCE((
        SELECT SUM(CASE
          WHEN pm.status='paid' THEN pm.rent_amount
          WHEN pm.status='partial' THEN
            CASE WHEN (pm.rent_amount + pm.media_amount + pm.other_amount) > 0
              THEN pm.total_paid * pm.rent_amount * 1.0 / (pm.rent_amount + pm.media_amount + pm.other_amount)
              ELSE 0 END
          ELSE 0 END)
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
        SELECT SUM(e.amount) FROM expenses e WHERE e.property_id = p.id AND strftime('%Y-%m', e.date) = ?
      ), 0) AS expenses
    FROM properties p
    ORDER BY p.name
  `).all(period, period, period, period);
  // Polskie zaokrąglenie podatkowe (Art. 63 § 1 Ord. pod.): podstawa i kwota → pełne zł
  for (const p of properties) {
    const baseP = Math.round(p.rent_paid || 0);
    p.tax = Math.round(baseP * taxRate / 100);
    p.net = +(p.revenue - p.expenses - p.tax).toFixed(2);
    p.margin = p.revenue ? p.net / p.revenue : 0;
  }

  const sumRevenue = properties.reduce((s, p) => s + p.revenue, 0);
  const sumRentPaid = properties.reduce((s, p) => s + (p.rent_paid || 0), 0);
  const sumExpenses = properties.reduce((s, p) => s + p.expenses, 0);
  const baseTax = Math.round(sumRentPaid);
  const podatek = Math.round(baseTax * taxRate / 100);
  const podatekKoscielna = Math.round(taxKoscielna);
  const podatekSuma = podatek + podatekKoscielna;
  const totals = {
    revenue: sumRevenue,
    rent_paid: sumRentPaid,
    tax_base: baseTax,
    expected_revenue: properties.reduce((s, p) => s + p.expected_revenue, 0),
    expenses: sumExpenses,
    tax: podatek,
    tax_koscielna: podatekKoscielna,
    tax_total: podatekSuma,
    tax_rate: taxRate,
    net: +(sumRevenue - sumExpenses - podatekSuma).toFixed(2),
  };
  totals.margin = totals.revenue ? totals.net / totals.revenue : 0;

  // Per lokal
  const perUnit = db.prepare(`
    SELECT u.id AS unit_id, u.name AS unit_name, u.code AS unit_code,
           p.name AS property_name, p.district,
           t.name AS tenant_name, t.avatar_color,
           pm.rent_amount, pm.media_amount, pm.other_amount, pm.total_paid, pm.status,
           pm.rent_amount + pm.media_amount + pm.other_amount AS gross,
           (
             SELECT COALESCE(SUM(e.amount), 0)
             FROM expenses e
             WHERE e.unit_id = u.id AND strftime('%Y-%m', e.date) = ?
           ) AS expenses
    FROM units u
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.current_unit_id = u.id AND t.status='active'
    LEFT JOIN payments pm ON pm.unit_id = u.id AND pm.period = ?
    ORDER BY p.name, u.code
  `).all(period, period);

  // Struktura kosztów
  const costsByCategory = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM expenses WHERE strftime('%Y-%m', date) = ?
    GROUP BY category ORDER BY total DESC
  `).all(period);

  // 12-miesięczny wykres — przychód = zatwierdzone wpłaty, podatek liczony dynamicznie
  const chart = db.prepare(`
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
      COALESCE((SELECT SUM(amount) FROM expenses WHERE strftime('%Y-%m', date) = m.p), 0) AS expenses,
      ROUND(ROUND(COALESCE((SELECT SUM(CASE
        WHEN status='paid'    THEN rent_amount
        WHEN status='partial' THEN
          CASE WHEN (rent_amount + media_amount + other_amount) > 0
            THEN total_paid * rent_amount * 1.0 / (rent_amount + media_amount + other_amount)
            ELSE 0 END
        ELSE 0 END) FROM payments WHERE period = m.p), 0)) * ? / 100.0) + ROUND(?) AS tax
    FROM months m
    ORDER BY m.p
  `).all(period + '-01', period, taxRate, taxKoscielna);

  res.json({
    period,
    period_label: periodLabel(period),
    properties,
    totals,
    per_unit: perUnit,
    costs_by_category: costsByCategory,
    chart_12m: chart,
  });
});

router.get('/yearly', (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const rows = db.prepare(`
    SELECT period,
      COALESCE(SUM(rent_amount + media_amount + other_amount), 0) AS revenue,
      COALESCE(SUM(rent_amount), 0) AS rent,
      COALESCE(SUM(media_amount), 0) AS media,
      COALESCE(SUM(total_paid), 0) AS paid
    FROM payments
    WHERE substr(period, 1, 4) = ?
    GROUP BY period ORDER BY period
  `).all(String(year));
  const summary = db.prepare(`
    SELECT * FROM monthly_summary WHERE substr(period, 1, 4) = ? ORDER BY period
  `).all(String(year));
  res.json({ year: +year, months: rows, summary });
});

module.exports = router;
