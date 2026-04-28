'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');

const UnitSchema = z.object({
  property_id: z.coerce.number().int().positive(),
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  area_m2: z.coerce.number().nullable().optional(),
  base_rent: z.coerce.number().default(0),
  base_media: z.coerce.number().default(0),
  status: z.enum(['rented','vacant']).default('rented'),
  notes: z.string().optional().nullable(),
});

router.get('/', (req, res) => {
  const filter = req.query.property_id ? 'WHERE u.property_id = ?' : '';
  const params = req.query.property_id ? [req.query.property_id] : [];
  const rows = db.prepare(`
    SELECT u.*, p.name AS property_name, p.district,
      (SELECT t.id FROM tenants t WHERE t.current_unit_id = u.id AND t.status='active' LIMIT 1) AS tenant_id,
      (SELECT t.name FROM tenants t WHERE t.current_unit_id = u.id AND t.status='active' LIMIT 1) AS tenant_name
    FROM units u
    JOIN properties p ON p.id = u.property_id
    ${filter}
    ORDER BY p.name, u.code
  `).all(...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const u = db.prepare(`
    SELECT u.*, p.name AS property_name FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE u.id = ?
  `).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json(u);
});

router.post('/', validate(UnitSchema), (req, res) => {
  const b = req.body;
  const r = db.prepare(`
    INSERT INTO units (property_id,name,code,area_m2,base_rent,base_media,status,notes)
    VALUES (@property_id,@name,@code,@area_m2,@base_rent,@base_media,@status,@notes)
  `).run({ ...b, code: b.code ?? null, area_m2: b.area_m2 ?? null, notes: b.notes ?? null });
  res.status(201).json(db.prepare('SELECT * FROM units WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(UnitSchema.partial()), (req, res) => {
  const fields = ['property_id','name','code','area_m2','base_rent','base_media','status','notes']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE units SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
