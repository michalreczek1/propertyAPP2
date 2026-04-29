'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');

const ContractSchema = z.object({
  tenant_id: z.coerce.number().int().positive(),
  unit_id: z.coerce.number().int().positive(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rent: z.coerce.number().min(0).default(0),
  media_advance: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  pay_by_day: z.coerce.number().int().min(1).max(31).default(31),
  document_path: z.string().nullable().optional(),
  status: z.enum(['active','ended']).default('active'),
  notes: z.string().nullable().optional(),
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }
  if (req.query.tenant_id) { where.push('c.tenant_id = ?'); params.push(req.query.tenant_id); }
  if (req.query.ending_within_days) {
    where.push("c.end_date IS NOT NULL AND DATE(c.end_date) <= DATE('now', '+' || ? || ' days') AND c.status='active'");
    params.push(req.query.ending_within_days);
  }
  res.json(db.prepare(`
    SELECT c.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code,
           p.name AS property_name, p.district
    FROM contracts c
    LEFT JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.status, c.end_date
  `).all(...params));
});

router.get('/:id', (req, res) => {
  const c = db.prepare(`
    SELECT c.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code, p.name AS property_name
    FROM contracts c
    LEFT JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(c);
});

router.post('/', validate(ContractSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    if (b.status === 'active') {
      const conflict = db.prepare('SELECT id FROM contracts WHERE unit_id = ? AND status = ? LIMIT 1').get(b.unit_id, 'active');
      if (conflict) {
        const err = new Error('active_contract_exists_for_unit');
        err.status = 409;
        throw err;
      }
    }
    const r = db.prepare(`
      INSERT INTO contracts (tenant_id,unit_id,start_date,end_date,rent,media_advance,deposit,pay_by_day,document_path,status,notes)
      VALUES (@tenant_id,@unit_id,@start_date,@end_date,@rent,@media_advance,@deposit,@pay_by_day,@document_path,@status,@notes)
    `).run({
      ...b,
      start_date: b.start_date || null,
      end_date: b.end_date || null,
      document_path: b.document_path || null,
      notes: b.notes || null,
    });
    if (b.status === 'active') {
      db.prepare('UPDATE tenants SET current_unit_id = ?, status = ? WHERE id = ?').run(b.unit_id, 'active', b.tenant_id);
      db.prepare('UPDATE units SET status = ? WHERE id = ?').run('rented', b.unit_id);
    }
    return r.lastInsertRowid;
  });
  let id;
  try { id = tx(); } catch (err) { return res.status(err.status || 500).json({ error: err.message || 'contract_error' }); }
  res.status(201).json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
});

router.put('/:id', validate(ContractSchema.partial()), (req, res) => {
  const fields = ['tenant_id','unit_id','start_date','end_date','rent','media_advance','deposit','pay_by_day','document_path','status','notes']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE contracts SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (c && c.status === 'active') {
    db.prepare('UPDATE tenants SET current_unit_id = ?, status = ? WHERE id = ?').run(c.unit_id, 'active', c.tenant_id);
    db.prepare('UPDATE units SET status = ? WHERE id = ?').run('rented', c.unit_id);
  } else if (c && c.status === 'ended') {
    db.prepare('UPDATE tenants SET current_unit_id = NULL WHERE id = ? AND current_unit_id = ?').run(c.tenant_id, c.unit_id);
    const stillActive = db.prepare('SELECT 1 FROM contracts WHERE unit_id = ? AND status = ? LIMIT 1').get(c.unit_id, 'active');
    if (!stillActive) db.prepare('UPDATE units SET status = ? WHERE id = ?').run('vacant', c.unit_id);
  }
  res.json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM contracts WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
