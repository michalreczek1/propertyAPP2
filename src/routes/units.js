'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { canAccessProperty, canAccessUnit, propertyScope } = require('../utils/scope');

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
  const where = [];
  const params = [];
  if (req.query.property_id) { where.push('u.property_id = ?'); params.push(req.query.property_id); }
  const scope = propertyScope(req, 'p');
  if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
  const rows = db.prepare(`
    SELECT u.*, p.name AS property_name, p.district,
      COALESCE(
        (SELECT c.tenant_id FROM contracts c WHERE c.unit_id = u.id AND c.status='active' ORDER BY COALESCE(c.start_date, '') DESC, c.id DESC LIMIT 1),
        (SELECT t.id FROM tenants t WHERE t.current_unit_id = u.id AND t.status='active' LIMIT 1)
      ) AS tenant_id,
      COALESCE(
        (SELECT t.name FROM contracts c JOIN tenants t ON t.id = c.tenant_id WHERE c.unit_id = u.id AND c.status='active' ORDER BY COALESCE(c.start_date, '') DESC, c.id DESC LIMIT 1),
        (SELECT t.name FROM tenants t WHERE t.current_unit_id = u.id AND t.status='active' LIMIT 1)
      ) AS tenant_name
    FROM units u
    JOIN properties p ON p.id = u.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.name, u.code
  `).all(...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  if (!canAccessUnit(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
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
  if (!canAccessProperty(db, req, b.property_id)) return res.status(404).json({ error: 'property_not_found' });
  const r = db.prepare(`
    INSERT INTO units (property_id,name,code,area_m2,base_rent,base_media,status,notes)
    VALUES (@property_id,@name,@code,@area_m2,@base_rent,@base_media,@status,@notes)
  `).run({ ...b, code: b.code ?? null, area_m2: b.area_m2 ?? null, notes: b.notes ?? null });
  res.status(201).json(db.prepare('SELECT * FROM units WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(UnitSchema.partial()), (req, res) => {
  if (!canAccessUnit(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (req.body.property_id && !canAccessProperty(db, req, req.body.property_id)) return res.status(404).json({ error: 'property_not_found' });
  const fields = ['property_id','name','code','area_m2','base_rent','base_media','status','notes']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE units SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  if (!canAccessUnit(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
