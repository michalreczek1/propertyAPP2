'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { dueDate, currentPeriod, todayLocalISO } = require('../utils/period');
const { assertRefs, canAccessPayment, ownerId } = require('../utils/scope');

const LATE_FEE_AMOUNT = 50;

const PaymentSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  unit_id: z.coerce.number().int().positive().nullable().optional(),
  due_day: z.coerce.number().int().min(1).max(31).nullable().optional(),
  due_date: z.string().nullable().optional(),
  paid_date: z.string().nullable().optional(),
  rent_amount: z.coerce.number().min(0).default(0),
  media_amount: z.coerce.number().min(0).default(0),
  other_amount: z.coerce.number().min(0).default(0),
  late_fee_amount: z.coerce.number().min(0).optional(),
  late_fee_paid: z.coerce.number().min(0).optional(),
  late_fee_manual: z.coerce.number().int().min(0).max(1).optional(),
  late_fee_resolution: z.enum(['unpaid','paid','partial','deposit','waived']).optional(),
  total_paid: z.coerce.number().min(0).default(0),
  status: z.enum(['paid','pending','overdue','partial']).default('pending'),
  notes: z.string().nullable().optional(),
  source: z.string().default('manual'),
});

const LateFeeSettlementSchema = z.object({
  action: z.enum(['unpaid','paid','partial','deposit','waived']),
  amount: z.coerce.number().min(0).optional(),
  note: z.string().nullable().optional(),
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function baseAmount(row) {
  return num(row.rent_amount) + num(row.media_amount) + num(row.other_amount);
}

function isLatePayment(row) {
  return row && row.paid_date && row.due_date && new Date(row.paid_date) > new Date(row.due_date);
}

function lateFeePaid(row, amount) {
  return Math.min(num(amount), Math.max(0, num(row.late_fee_paid)));
}

function normalizeLateFee(row, previous = null, explicitAmount = false) {
  const manual = explicitAmount ? 1 : num(row.late_fee_manual ?? previous?.late_fee_manual);
  const status = row.status || previous?.status || 'pending';
  const shouldCharge = ['paid', 'partial'].includes(status) && isLatePayment(row);
  const amount = manual
    ? num(row.late_fee_amount ?? previous?.late_fee_amount)
    : (shouldCharge ? LATE_FEE_AMOUNT : 0);
  return {
    late_fee_amount: amount,
    late_fee_paid: lateFeePaid(row, amount),
    late_fee_manual: manual,
  };
}

function hasManualLateFeeOnCreate(body) {
  return body.late_fee_amount !== undefined && body.late_fee_amount !== null && body.late_fee_amount !== '';
}

function hasManualLateFeeChange(body, previous) {
  if (body.late_fee_amount === undefined || body.late_fee_amount === null || body.late_fee_amount === '') return false;
  return num(previous && previous.late_fee_manual) === 1 || num(body.late_fee_amount) !== num(previous && previous.late_fee_amount);
}

function expectedAmount(row) {
  return baseAmount(row);
}

function paymentJoinSql(where = '') {
  return `
    SELECT p.*,
      (p.rent_amount + p.media_amount + p.other_amount) AS expected_total,
      (p.rent_amount + p.media_amount + p.other_amount + COALESCE(p.late_fee_amount, 0)) AS expected_with_late_fee,
      MAX(COALESCE(p.late_fee_amount, 0) - COALESCE(p.late_fee_paid, 0), 0) AS late_fee_balance,
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
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('(p.owner_user_id = ? OR pr.owner_user_id = ? OR t.owner_user_id = ?)');
    params.push(req.user.id, req.user.id, req.user.id);
  }
  const sql = paymentJoinSql(where.length ? 'WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY p.period DESC, p.unit_id';
  res.json(db.prepare(sql).all(...params));
});

router.get('/periods', (req, res) => {
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const rows = db.prepare(`
    SELECT period, COUNT(*) AS payments_count,
           SUM(p.total_paid) AS total,
           SUM(CASE WHEN p.status='paid' THEN 1 ELSE 0 END) AS paid_count
    FROM payments p
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN tenants t ON t.id = p.tenant_id
    ${scoped ? 'WHERE (p.owner_user_id = ? OR pr.owner_user_id = ? OR t.owner_user_id = ?)' : ''}
    GROUP BY period
    ORDER BY period DESC
  `).all(...(scoped ? [req.user.id, req.user.id, req.user.id] : []));
  res.json(rows);
});

router.get('/:id', (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json(r);
});

router.post('/', validate(PaymentSchema), (req, res) => {
  const b = req.body;
  if (!assertRefs(db, req, { tenant_id: b.tenant_id, unit_id: b.unit_id })) return res.status(404).json({ error: 'related_not_found' });
  if (!b.due_date && b.due_day) b.due_date = dueDate(b.period, b.due_day);
  Object.assign(b, normalizeLateFee(b, null, hasManualLateFeeOnCreate(req.body)));
  const r = db.prepare(`
    INSERT INTO payments (owner_user_id,period,tenant_id,unit_id,due_day,due_date,paid_date,rent_amount,media_amount,other_amount,late_fee_amount,late_fee_paid,late_fee_manual,late_fee_resolution,total_paid,status,notes,source)
    VALUES (@owner_user_id,@period,@tenant_id,@unit_id,@due_day,@due_date,@paid_date,@rent_amount,@media_amount,@other_amount,@late_fee_amount,@late_fee_paid,@late_fee_manual,@late_fee_resolution,@total_paid,@status,@notes,@source)
  `).run({
    ...b,
    owner_user_id: ownerId(req),
    tenant_id: b.tenant_id || null,
    unit_id: b.unit_id || null,
    due_day: b.due_day || null,
    due_date: b.due_date || null,
    paid_date: b.paid_date || null,
    late_fee_resolution: b.late_fee_resolution || (b.late_fee_paid > 0 ? 'partial' : 'unpaid'),
    notes: b.notes || null,
  });
  res.status(201).json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(r.lastInsertRowid));
});

router.put('/:id', validate(PaymentSchema.partial()), (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (!assertRefs(db, req, { tenant_id: req.body.tenant_id, unit_id: req.body.unit_id })) return res.status(404).json({ error: 'related_not_found' });
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const next = { ...cur, ...req.body };
  if (req.body.due_date === undefined && (req.body.due_day !== undefined || req.body.period !== undefined)) {
    next.due_date = next.due_day ? dueDate(next.period, next.due_day) : null;
  }
  Object.assign(next, normalizeLateFee(next, cur, hasManualLateFeeChange(req.body, cur)));
  const patch = {
    ...req.body,
    due_date: next.due_date,
    late_fee_amount: next.late_fee_amount,
    late_fee_paid: next.late_fee_paid,
    late_fee_manual: next.late_fee_manual,
  };
  const fields = ['period','tenant_id','unit_id','due_day','due_date','paid_date','rent_amount','media_amount','other_amount','late_fee_amount','late_fee_paid','late_fee_manual','late_fee_resolution','total_paid','status','notes','source']
    .filter(f => patch[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE payments SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => patch[f] === '' ? null : patch[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.put('/:id/late-fee', validate(LateFeeSettlementSchema), (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const fee = num(cur.late_fee_amount);
  if (!fee) return res.status(400).json({ error: 'no_late_fee' });

  const action = req.body.action;
  const rawAmount = req.body.amount == null ? fee : num(req.body.amount);
  let paid = 0;
  let resolution = action;
  if (action === 'paid' || action === 'deposit' || action === 'waived') {
    paid = fee;
  } else if (action === 'partial') {
    paid = Math.min(fee, rawAmount);
    resolution = paid >= fee ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  }
  const note = String(req.body.note || '').trim();
  const noteSuffix = note ? `\n[kara ${cur.period}] ${note}` : '';
  const notes = noteSuffix ? `${cur.notes || ''}${noteSuffix}`.trim() : cur.notes;

  db.prepare(`
    UPDATE payments
    SET late_fee_paid = ?,
        late_fee_resolution = ?,
        late_fee_manual = 1,
        notes = ?
    WHERE id = ?
  `).run(paid, resolution, notes || null, req.params.id);

  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.put('/:id/mark-paid', (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const today = (req.body && req.body.paid_date) || todayLocalISO();
  const next = { ...cur, status: 'paid', paid_date: today };
  if (!num(cur.late_fee_manual)) {
    next.late_fee_amount = isLatePayment(next) ? LATE_FEE_AMOUNT : 0;
  }
  next.total_paid = expectedAmount(next);
  Object.assign(next, normalizeLateFee(next, cur, false));
  const r = db.prepare(`
    UPDATE payments
    SET status='paid', paid_date=?, total_paid=?, late_fee_amount=?, late_fee_paid=?, late_fee_manual=?
    WHERE id=?
  `).run(today, next.total_paid, next.late_fee_amount, next.late_fee_paid, next.late_fee_manual, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.put('/:id/toggle-paid', (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const today = (req.body && req.body.paid_date) || todayLocalISO();
  if (cur.status === 'paid') {
    const next = { ...cur, status: 'pending', paid_date: null, total_paid: 0 };
    Object.assign(next, normalizeLateFee(next, cur, false));
    db.prepare(`UPDATE payments SET status='pending', paid_date=NULL, total_paid=0, late_fee_amount=?, late_fee_paid=?, late_fee_manual=? WHERE id=?`)
      .run(next.late_fee_amount, next.late_fee_paid, next.late_fee_manual, req.params.id);
  } else {
    const next = { ...cur, status: 'paid', paid_date: today };
    if (!num(cur.late_fee_manual)) {
      next.late_fee_amount = isLatePayment(next) ? LATE_FEE_AMOUNT : 0;
    }
    next.total_paid = expectedAmount(next);
    Object.assign(next, normalizeLateFee(next, cur, false));
    db.prepare(`UPDATE payments SET status='paid', paid_date=?, total_paid=?, late_fee_amount=?, late_fee_paid=?, late_fee_manual=? WHERE id=?`)
      .run(today, next.total_paid, next.late_fee_amount, next.late_fee_paid, next.late_fee_manual, req.params.id);
  }
  res.json(db.prepare(paymentJoinSql('WHERE p.id = ?')).get(req.params.id));
});

router.post('/approve-month', (req, res) => {
  const period = req.body && req.body.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'invalid_period' });
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const today = (req.body && req.body.paid_date) || todayLocalISO();
  const r = db.prepare(`
    UPDATE payments
    SET status='paid',
        paid_date=?,
        late_fee_amount=CASE
          WHEN COALESCE(late_fee_manual, 0) = 1 THEN COALESCE(late_fee_amount, 0)
          WHEN due_date IS NOT NULL AND DATE(?) > DATE(due_date) THEN ?
          ELSE 0
        END,
        late_fee_paid=CASE
          WHEN COALESCE(late_fee_manual, 0) = 1 THEN MIN(COALESCE(late_fee_paid, 0), COALESCE(late_fee_amount, 0))
          WHEN due_date IS NOT NULL AND DATE(?) > DATE(due_date) THEN 0
          ELSE 0
        END,
        total_paid=(rent_amount + media_amount + other_amount)
    WHERE period = ? AND status IN ('pending','overdue')
      ${scoped ? 'AND id IN (SELECT pm.id FROM payments pm LEFT JOIN units u ON u.id = pm.unit_id LEFT JOIN properties pr ON pr.id = u.property_id LEFT JOIN tenants t ON t.id = pm.tenant_id WHERE pm.period = ? AND (pm.owner_user_id = ? OR pr.owner_user_id = ? OR t.owner_user_id = ?))' : ''}
  `).run(today, today, LATE_FEE_AMOUNT, today, period, ...(scoped ? [period, req.user.id, req.user.id, req.user.id] : []));
  res.json({ period, updated: r.changes });
});

router.delete('/:id', (req, res) => {
  if (!canAccessPayment(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/generate-month', (req, res) => {
  const period = (req.body && req.body.period) || currentPeriod();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'invalid_period' });
  const fallbackDueDay = Number(req.body && req.body.default_due_day) || 10;
  if (fallbackDueDay < 1 || fallbackDueDay > 31) return res.status(400).json({ error: 'invalid_due_day' });
  const monthStart = `${period}-01`;
  const monthEnd = dueDate(period, 31);
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const uid = ownerId(req);
  const tx = db.transaction(() => {
    const contracts = db.prepare(`
      SELECT * FROM contracts
      WHERE status = 'active'
        AND (start_date IS NULL OR DATE(start_date) <= DATE(?))
        AND (end_date IS NULL OR DATE(end_date) >= DATE(?))
        ${scoped ? 'AND unit_id IN (SELECT u.id FROM units u JOIN properties p ON p.id = u.property_id WHERE p.owner_user_id = ?)' : ''}
      ORDER BY unit_id
    `).all(monthEnd, monthStart, ...(scoped ? [uid] : []));
    const tenantFallbacks = db.prepare(`
      SELECT
        t.id AS tenant_id,
        t.current_unit_id AS unit_id,
        COALESCE(u.base_rent, 0) AS rent_amount,
        COALESCE(u.base_media, 0) AS media_amount
      FROM tenants t
      JOIN units u ON u.id = t.current_unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE t.status = 'active'
        AND t.current_unit_id IS NOT NULL
        ${scoped ? 'AND (t.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
        AND NOT EXISTS (
          SELECT 1
          FROM contracts c
          WHERE c.unit_id = t.current_unit_id
            AND c.status = 'active'
            AND (c.start_date IS NULL OR DATE(c.start_date) <= DATE(?))
            AND (c.end_date IS NULL OR DATE(c.end_date) >= DATE(?))
        )
      ORDER BY t.current_unit_id
    `).all(...(scoped ? [uid, uid] : []), monthEnd, monthStart);
    let created = 0, skipped = 0;
    const upsert = db.prepare(`
      INSERT INTO payments (owner_user_id,period,tenant_id,unit_id,due_day,due_date,rent_amount,media_amount,late_fee_amount,late_fee_paid,late_fee_manual,total_paid,status,source)
      VALUES (@owner_user_id,@period,@tenant_id,@unit_id,@due_day,@due_date,@rent_amount,@media_amount,0,0,0,0,'pending',@source)
      ON CONFLICT DO NOTHING
    `);

    function insertPayment(row, source) {
      const dueDay = row.due_day || fallbackDueDay;
      const r = upsert.run({
        period,
        owner_user_id: uid,
        tenant_id: row.tenant_id,
        unit_id: row.unit_id,
        due_day: dueDay,
        due_date: dueDate(period, dueDay),
        rent_amount: row.rent_amount || row.rent || 0,
        media_amount: row.media_amount || row.media_advance || 0,
        source,
      });
      if (r.changes) created++;
      else skipped++;
    }

    for (const c of contracts) {
      insertPayment({
        tenant_id: c.tenant_id,
        unit_id: c.unit_id,
        due_day: c.pay_by_day || 31,
        rent_amount: c.rent || 0,
        media_amount: c.media_advance || 0,
      }, 'contract');
    }
    for (const t of tenantFallbacks) {
      insertPayment(t, 'tenant');
    }
    return {
      created,
      skipped,
      source_counts: {
        contracts: contracts.length,
        tenants: tenantFallbacks.length,
      },
      fallback_used: tenantFallbacks.length > 0,
    };
  });
  res.json({ period, ...tx() });
});

module.exports = router;
