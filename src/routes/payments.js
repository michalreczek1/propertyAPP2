'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { dueDate, currentPeriod } = require('../utils/period');

const PaymentSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  unit_id: z.coerce.number().int().positive().nullable().optional(),
  due_day: z.coerce.number().int().min(1).max(31).nullable().optional(),
  due_date: z.string().nullable().optional(),
  paid_date: z.string().nullable().optional(),
  rent_amount: z.coerce.number().default(0),
  media_amount: z.coerce.number().default(0),
  other_amount: z.coerce.number().default(0),
  total_paid: z.coerce.number().default(0),
  status: z.enum(['paid','pending','overdue','partial']).default('pending'),
  notes: z.string().nullable().optional(),
  source: z.string().default('manual'),
});

function paymentJoinSql(where = '') {
  return `
    SELECT p.*,
      t.name AS tenant_name, t.avatar_color,
      u.name AS unit_name, u.code AS unit_code,
      pr.name AS property_name, pr.district
    FROM payments p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    ${where}
  `;
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.period) { where.push('p.period = ?'); params.push(req.query.period); }
  if (req.query.from_period) { where.push('p.period >= ?'); params.push(req.query.from_period); }
  if (req.query.to_period)   { where.push('p.period <= ?'); params.push(req.query.to_period); }
  if (req.query.status)      { where.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.tenant_id)   { where.push('p.tenant_id = ?'); params.push(req.query.tenant_id); }
  if (req.query.unit_id)     { where.push('p.unit_id = ?'); params.push(req.query.unit_id); }
  if (req.query.property_id) { where.push('pr.id = ?'); params.push(req.query.property_id); }
  if (req.query.q) {
    where.push('(LOWER(t.name) LIKE ? OR LOWER(u.name) LIKE ? OR LOWER(pr.name) LIKE ?)');
    const q = '%' + String(req.query.q).toLowerCase() + '%';
    params.push(q, q, q);
  }
  const sql = paymentJoinSql(where.length ? 'WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY p.period DESC, p.unit_id';
  res.json(db.prepare(sql).all(...params));
});

router.get('/periods', (_req, res) => {
  const rows = db.prepare(`
    SELECT period, COUNT(*) AS payments_count,
           SUM(total_paid) AS total,
           SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count
    FROM payments
    GROUP BY period
    ORDER BY period DESC
  `).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const r = db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json(r);
});

router.post('/', validate(PaymentSchema), (req, res) => {
  const b = req.body;
  if (!b.due_date && b.due_day) b.due_date = dueDate(b.period, b.due_day);
  const r = db.prepare(`
    INSERT INTO payments (period,tenant_id,unit_id,due_day,due_date,paid_date,rent_amount,media_amount,other_amount,total_paid,status,notes,source)
    VALUES (@period,@tenant_id,@unit_id,@due_day,@due_date,@paid_date,@rent_amount,@media_amount,@other_amount,@total_paid,@status,@notes,@source)
  `).run({
    ...b,
    tenant_id: b.tenant_id || null,
    unit_id: b.unit_id || null,
    due_day: b.due_day || null,
    due_date: b.due_date || null,
    paid_date: b.paid_date || null,
    notes: b.notes || null,
  });
  res.status(201).json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(r.lastInsertRowid));
});

router.put('/:id', validate(PaymentSchema.partial()), (req, res) => {
  const fields = ['period','tenant_id','unit_id','due_day','due_date','paid_date','rent_amount','media_amount','other_amount','total_paid','status','notes','source']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE payments SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.put('/:id/mark-paid', (req, res) => {
  const today = (req.body && req.body.paid_date) || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`
    UPDATE payments
    SET status='paid', paid_date=?, total_paid=(rent_amount + media_amount + other_amount)
    WHERE id=?
  `).run(today, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.put('/:id/toggle-paid', (req, res) => {
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const today = (req.body && req.body.paid_date) || new Date().toISOString().slice(0, 10);
  if (cur.status === 'paid') {
    db.prepare(`UPDATE payments SET status='pending', paid_date=NULL, total_paid=0 WHERE id=?`).run(req.params.id);
  } else {
    const full = (cur.rent_amount || 0) + (cur.media_amount || 0) + (cur.other_amount || 0);
    db.prepare(`UPDATE payments SET status='paid', paid_date=?, total_paid=? WHERE id=?`).run(today, full, req.params.id);
  }
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.post('/approve-month', (req, res) => {
  const period = req.body && req.body.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'invalid_period' });
  const today = (req.body && req.body.paid_date) || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`
    UPDATE payments
    SET status='paid', paid_date=?, total_paid=(rent_amount + media_amount + other_amount)
    WHERE period = ? AND status != 'paid'
  `).run(today, period);
  res.json({ period, updated: r.changes });
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/generate-month', (req, res) => {
  // Generuje wpisy `pending` dla wszystkich aktywnych umów w danym miesiącu (z domyślnymi kwotami z umowy).
  const period = (req.body && req.body.period) || currentPeriod();
  const tx = db.transaction(() => {
    const contracts = db.prepare(`SELECT * FROM contracts WHERE status='active'`).all();
    let created = 0, skipped = 0;
    const upsert = db.prepare(`
      INSERT INTO payments (period,tenant_id,unit_id,due_day,due_date,rent_amount,media_amount,total_paid,status,source)
      VALUES (@period,@tenant_id,@unit_id,@due_day,@due_date,@rent_amount,@media_amount,0,'pending','manual')
      ON CONFLICT(period, unit_id) WHERE unit_id IS NOT NULL DO NOTHING
    `);
    for (const c of contracts) {
      const before = db.prepare('SELECT id FROM payments WHERE period=? AND unit_id=?').get(period, c.unit_id);
      if (before) { skipped++; continue; }
      upsert.run({
        period,
        tenant_id: c.tenant_id,
        unit_id: c.unit_id,
        due_day: c.pay_by_day || 31,
        due_date: dueDate(period, c.pay_by_day || 31),
        rent_amount: c.rent || 0,
        media_amount: c.media_advance || 0,
      });
      created++;
    }
    return { created, skipped };
  });
  res.json({ period, ...tx() });
});

module.exports = router;
