'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { assertRefs, canAccessTenant, ownerId } = require('../utils/scope');

const TenantSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  sms_consent: z.coerce.number().int().min(0).max(1).optional(),
  sms_disabled: z.coerce.number().int().min(0).max(1).optional(),
  current_unit_id: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  avatar_color: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function assertNoActiveUnitConflict(tenant, excludeId = null) {
  if (tenant.status !== 'active' || !tenant.current_unit_id) return;
  const params = excludeId ? [tenant.current_unit_id, excludeId] : [tenant.current_unit_id];
  const idClause = excludeId ? 'AND id != ?' : '';
  const existing = db
    .prepare(
      `
    SELECT id FROM tenants
    WHERE current_unit_id = ? AND status = 'active' ${idClause}
    LIMIT 1
  `,
    )
    .get(...params);
  if (existing) throw conflict('active_tenant_exists_for_unit');

  const contractParams = excludeId ? [tenant.current_unit_id, excludeId] : [tenant.current_unit_id];
  const contractTenantClause = excludeId ? 'AND tenant_id != ?' : '';
  const activeContract = db
    .prepare(
      `
    SELECT id FROM contracts
    WHERE unit_id = ? AND status = 'active' ${contractTenantClause}
    LIMIT 1
  `,
    )
    .get(...contractParams);
  if (activeContract) throw conflict('active_contract_exists_for_unit');
}

function syncUnitOccupancy(unitId) {
  if (!unitId) return;
  const occupied = db
    .prepare(
      `
    SELECT 1
    FROM tenants
    WHERE current_unit_id = ? AND status = 'active'
    UNION
    SELECT 1
    FROM contracts
    WHERE unit_id = ? AND status = 'active'
    LIMIT 1
  `,
    )
    .get(unitId, unitId);
  db.prepare('UPDATE units SET status = ? WHERE id = ?').run(occupied ? 'rented' : 'vacant', unitId);
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('t.status = ?');
    params.push(req.query.status);
  }
  if (req.query.q) {
    where.push('LOWER(t.name) LIKE ?');
    params.push('%' + String(req.query.q).toLowerCase() + '%');
  }
  if (req.query.property_id) {
    where.push('p.id = ?');
    params.push(req.query.property_id);
  }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('(t.owner_user_id = ? OR p.owner_user_id = ?)');
    params.push(req.user.id, req.user.id);
  }
  const sql = `
    SELECT t.*, u.name AS unit_name, u.code AS unit_code, u.base_rent, u.base_media,
           p.id AS property_id, p.name AS property_name, p.district,
           c.start_date AS contract_start, c.end_date AS contract_end,
           c.rent AS contract_rent, c.media_advance AS contract_media,
           c.deposit AS contract_deposit, c.id AS contract_id, c.pay_by_day AS contract_pay_by_day
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    LEFT JOIN contracts c ON c.tenant_id = t.id AND c.status = 'active'
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.status, t.name
  `;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  if (!canAccessTenant(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const t = db
    .prepare(
      `
    SELECT t.*, u.name AS unit_name, u.code AS unit_code, p.name AS property_name
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE t.id = ?
  `,
    )
    .get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  t.contracts = db.prepare('SELECT * FROM contracts WHERE tenant_id = ? ORDER BY start_date DESC').all(t.id);
  t.payments = db
    .prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY period DESC LIMIT 24')
    .all(t.id);
  t.late_fees = db
    .prepare(
      `
    SELECT p.id AS payment_id, p.period, p.due_date, p.paid_date,
           COALESCE(p.late_fee_amount, 0) AS amount,
           COALESCE(p.late_fee_paid, 0) AS paid,
           COALESCE(p.late_fee_resolution, 'unpaid') AS resolution,
           MAX(COALESCE(p.late_fee_amount, 0) - COALESCE(p.late_fee_paid, 0), 0) AS balance,
           p.status, p.notes
    FROM payments p
    WHERE p.tenant_id = ?
      AND COALESCE(p.late_fee_amount, 0) > 0
    ORDER BY p.period DESC
  `,
    )
    .all(t.id);
  t.late_fee_summary = db
    .prepare(
      `
    SELECT COALESCE(SUM(COALESCE(late_fee_amount, 0)), 0) AS total,
           COALESCE(SUM(COALESCE(late_fee_paid, 0)), 0) AS paid,
           COALESCE(SUM(MAX(COALESCE(late_fee_amount, 0) - COALESCE(late_fee_paid, 0), 0)), 0) AS balance,
           COUNT(*) AS count
    FROM payments
    WHERE tenant_id = ?
      AND COALESCE(late_fee_amount, 0) > 0
  `,
    )
    .get(t.id);
  res.json(t);
});

router.get('/:id/payments', (req, res) => {
  if (!canAccessTenant(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const rows = db
    .prepare(
      `
    SELECT p.* FROM payments p WHERE p.tenant_id = ? ORDER BY p.period DESC
  `,
    )
    .all(req.params.id);
  res.json(rows);
});

router.post('/', validate(TenantSchema), (req, res) => {
  const b = req.body;
  if (!assertRefs(db, req, { unit_id: b.current_unit_id }))
    return res.status(404).json({ error: 'unit_not_found' });
  const tx = db.transaction(() => {
    assertNoActiveUnitConflict(b);
    const r = db
      .prepare(
        `
      INSERT INTO tenants (owner_user_id,name,email,phone,sms_consent,sms_disabled,current_unit_id,status,avatar_color,notes)
      VALUES (@owner_user_id,@name,@email,@phone,@sms_consent,@sms_disabled,@current_unit_id,@status,@avatar_color,@notes)
    `,
      )
      .run({
        owner_user_id: ownerId(req),
        name: b.name,
        email: b.email || null,
        phone: b.phone || null,
        sms_consent: b.sms_consent ? 1 : 0,
        sms_disabled: b.sms_disabled ? 1 : 0,
        current_unit_id: b.current_unit_id || null,
        status: b.status,
        avatar_color: b.avatar_color || null,
        notes: b.notes || null,
      });
    syncUnitOccupancy(b.current_unit_id);
    return r.lastInsertRowid;
  });
  try {
    const id = tx();
    res.status(201).json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'tenant_error' });
  }
});

router.put('/:id', validate(TenantSchema.partial()), (req, res) => {
  if (!canAccessTenant(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (!assertRefs(db, req, { unit_id: req.body.current_unit_id }))
    return res.status(404).json({ error: 'unit_not_found' });
  const fields = [
    'name',
    'email',
    'phone',
    'sms_consent',
    'sms_disabled',
    'current_unit_id',
    'status',
    'avatar_color',
    'notes',
  ].filter((f) => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (!before) return null;
    const next = { ...before };
    for (const field of fields) next[field] = req.body[field] === '' ? null : req.body[field];
    assertNoActiveUnitConflict(next, id);
    const sql = `UPDATE tenants SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id = ?`;
    db.prepare(sql).run(...fields.map((f) => (req.body[f] === '' ? null : req.body[f])), id);
    if (before.current_unit_id !== next.current_unit_id || before.status !== next.status) {
      syncUnitOccupancy(before.current_unit_id);
      syncUnitOccupancy(next.current_unit_id);
    }
    return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  });
  try {
    const updated = tx();
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'tenant_error' });
  }
});

router.delete('/:id', (req, res) => {
  if (!canAccessTenant(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (!before) return false;
    db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    syncUnitOccupancy(before.current_unit_id);
    return true;
  });
  if (!tx()) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
