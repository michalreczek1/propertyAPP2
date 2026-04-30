'use strict';
const router = require('express').Router();
const PDFDocument = require('pdfkit');
const db = require('../db');
const { currentPeriod, periodLabel } = require('../utils/period');
const { fmtPLN } = require('../utils/money');
const { monthlyFinanceSummary } = require('../services/finance-summary');
const { canSeeAll, ownerId } = require('../utils/scope');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/payments.csv', (req, res) => {
  const period = req.query.period || currentPeriod();
  const scoped = !canSeeAll(req);
  const rows = db.prepare(`
    SELECT pm.period, t.name AS tenant, pr.name AS property, u.name AS unit, u.code,
           pm.due_date, pm.paid_date, pm.rent_amount, pm.media_amount, pm.other_amount,
           COALESCE(pm.late_fee_amount, 0) AS late_fee_amount,
           COALESCE(pm.late_fee_paid, 0) AS late_fee_paid,
           pm.total_paid, pm.status, pm.notes
    FROM payments pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN tenants t2 ON t2.id = pm.tenant_id
    WHERE pm.period = ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR pr.owner_user_id = ? OR t2.owner_user_id = ?)' : ''}
    ORDER BY pr.name, u.code
  `).all(period, ...(scoped ? [ownerId(req), ownerId(req), ownerId(req)] : []));

  const header = ['period','tenant','property','unit','code','due_date','paid_date',
                  'rent','media','other','late_fee','late_fee_paid','paid','status','notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.period, r.tenant, r.property, r.unit, r.code,
      r.due_date || '', r.paid_date || '',
      r.rent_amount, r.media_amount, r.other_amount,
      r.late_fee_amount, r.late_fee_paid,
      r.total_paid, r.status, r.notes || ''
    ].map(csvEscape).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payments-${period}.csv"`);
  // BOM dla Excela
  res.send('﻿' + lines.join('\n'));
});

router.get('/report.pdf', (req, res) => {
  const period = req.query.period || currentPeriod();
  const summary = monthlyFinanceSummary(db, period, req);
  const ownerCosts = summary.owner_costs;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="raport-${period}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text('PropertyApp — Raport miesięczny', { align: 'left' });
  doc.fontSize(12).fillColor('#6b7280').text(periodLabel(period), { align: 'left' });
  doc.moveDown();
  doc.fillColor('#1a1d23');

  doc.fontSize(14).text('Podsumowanie');
  doc.fontSize(11).text(`Przychód zatwierdzony: ${fmtPLN(summary.revenue.gross)} PLN`);
  doc.text(`  – Czynsz zatwierdzony: ${fmtPLN(summary.revenue.rent_paid)} PLN`);
  doc.text(`  – Media + czynsz w przychodach: ${fmtPLN(summary.revenue.media)} PLN`);
  doc.text(`  – Inne zatwierdzone: ${fmtPLN(summary.revenue.other_paid || 0)} PLN`);
  doc.text(`Oczekiwany przychód: ${fmtPLN(summary.revenue.expected)} PLN`);
  doc.text(`Koszty: ${fmtPLN(summary.expenses.total)} PLN`);
  if (ownerCosts.management) doc.text(`  – Zarządzanie: ${fmtPLN(ownerCosts.management)} PLN`);
  if (ownerCosts.mortgage_total) doc.text(`  – Kredyty: ${fmtPLN(ownerCosts.mortgage_total)} PLN`);
  doc.text(`Podatek (ryczałt): ${fmtPLN(summary.tax.podatek || 0)} PLN`);
  if (summary.tax.podatek_koscielna) doc.text(`Podatek dodatkowy: ${fmtPLN(summary.tax.podatek_koscielna)} PLN`);
  doc.text(`Podatek razem: ${fmtPLN(summary.tax.podatek_suma || 0)} PLN`);
  doc.text(`Netto dla właściciela: ${fmtPLN(summary.net_for_owner)} PLN`, { underline: true });
  doc.moveDown();

  doc.fontSize(14).text('Per nieruchomość');
  doc.fontSize(11);
  for (const p of summary.properties) {
    doc.text(`• ${p.name} (${p.district || '—'}): przychód ${fmtPLN(p.revenue)} PLN, koszty ${fmtPLN(p.expenses)} PLN, podatek ${fmtPLN(p.tax)} PLN, netto ${fmtPLN(p.net)} PLN`);
  }

  doc.end();
});

module.exports = router;
