'use strict';
const router = require('express').Router();
const PDFDocument = require('pdfkit');
const db = require('../db');
const { currentPeriod, periodLabel } = require('../utils/period');
const { fmtPLN } = require('../utils/money');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/payments.csv', (req, res) => {
  const period = req.query.period || currentPeriod();
  const rows = db.prepare(`
    SELECT pm.period, t.name AS tenant, pr.name AS property, u.name AS unit, u.code,
           pm.due_date, pm.paid_date, pm.rent_amount, pm.media_amount, pm.other_amount,
           pm.total_paid, pm.status, pm.notes
    FROM payments pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE pm.period = ?
    ORDER BY pr.name, u.code
  `).all(period);

  const header = ['period','tenant','property','unit','code','due_date','paid_date',
                  'rent','media','other','paid','status','notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.period, r.tenant, r.property, r.unit, r.code,
      r.due_date || '', r.paid_date || '',
      r.rent_amount, r.media_amount, r.other_amount,
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

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(rent_amount + media_amount + other_amount), 0) AS gross,
      COALESCE(SUM(rent_amount), 0) AS rent,
      COALESCE(SUM(media_amount), 0) AS media,
      COALESCE(SUM(other_amount), 0) AS other
    FROM payments WHERE period = ?
  `).get(period);

  const expensesTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE strftime('%Y-%m', date) = ?
  `).get(period).t;

  const summary = db.prepare(`SELECT * FROM monthly_summary WHERE period = ?`).get(period);

  const properties = db.prepare(`
    SELECT p.name, p.district,
      COALESCE((SELECT SUM(pm.rent_amount + pm.media_amount + pm.other_amount)
                FROM payments pm JOIN units u2 ON u2.id = pm.unit_id
                WHERE u2.property_id = p.id AND pm.period = ?), 0) AS revenue
    FROM properties p ORDER BY p.name
  `).all(period);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="raport-${period}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text('PropertyApp — Raport miesięczny', { align: 'left' });
  doc.fontSize(12).fillColor('#6b7280').text(periodLabel(period), { align: 'left' });
  doc.moveDown();
  doc.fillColor('#1a1d23');

  doc.fontSize(14).text('Podsumowanie');
  doc.fontSize(11).text(`Przychód brutto: ${fmtPLN(totals.gross)} PLN`);
  doc.text(`  – Czynsze: ${fmtPLN(totals.rent)} PLN`);
  doc.text(`  – Media (zaliczki): ${fmtPLN(totals.media)} PLN`);
  doc.text(`  – Inne: ${fmtPLN(totals.other)} PLN`);
  doc.text(`Koszty: ${fmtPLN(expensesTotal)} PLN`);
  if (summary) {
    doc.text(`Podatek (ryczałt): ${fmtPLN(summary.podatek || 0)} PLN`);
    doc.text(`Podatek (kościelna): ${fmtPLN(summary.podatek_koscielna || 0)} PLN`);
    doc.text(`Podatek razem: ${fmtPLN(summary.podatek_suma || 0)} PLN`);
  }
  doc.text(`Netto dla właściciela: ${fmtPLN(totals.gross - expensesTotal - (summary ? summary.podatek_suma || 0 : 0))} PLN`, { underline: true });
  doc.moveDown();

  doc.fontSize(14).text('Per nieruchomość');
  doc.fontSize(11);
  for (const p of properties) {
    doc.text(`• ${p.name} (${p.district || '—'}): ${fmtPLN(p.revenue)} PLN`);
  }

  doc.end();
});

module.exports = router;
