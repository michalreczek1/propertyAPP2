'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');

const TenantSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  current_unit_id: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['active','inactive']).default('active'),
  avatar_color: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('LOWER(t.name) LIKE ?'); params.push('%' + String(req.query.q).toLowerCase() + '%'); }
  if (req.query.property_id) { where.push('p.id = ?'); params.push(req.query.property_id); }
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
  const t = db.prepare(`
    SELECT t.*, u.name AS unit_name, u.code AS unit_code, p.name AS property_name
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  t.contracts = db.prepare('SELECT * FROM contracts WHERE tenant_id = ? ORDER BY start_date DESC').all(t.id);
  t.payments  = db.prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY period DESC LIMIT 24').all(t.id);
  res.json(t);
});

router.get('/:id/payments', (req, res) => {
  const rows = db.prepare(`
    SELECT p.* FROM payments p WHERE p.tenant_id = ? ORDER BY p.period DESC
  `).all(req.params.id);
  res.json(rows);
});

router.post('/', validate(TenantSchema), (req, res) => {
  const b = req.body;
  const r = db.prepare(`
    INSERT INTO tenants (name,email,phone,current_unit_id,status,avatar_color,notes)
    VALUES (@name,@email,@phone,@current_unit_id,@status,@avatar_color,@notes)
  `).run({
    name: b.name,
    email: b.email || null,
    phone: b.phone || null,
    current_unit_id: b.current_unit_id || null,
    status: b.status,
    avatar_color: b.avatar_color || null,
    notes: b.notes || null,
  });
  res.status(201).json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(TenantSchema.partial()), (req, res) => {
  const fields = ['name','email','phone','current_unit_id','status','avatar_color','notes']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE tenants SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
