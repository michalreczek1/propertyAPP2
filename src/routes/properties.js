'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');

const PropertySchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  type: z.string().optional().default('mieszkanie'),
  notes: z.string().optional().nullable(),
});

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS units_count,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id AND u.status='rented') AS units_rented
    FROM properties p
    ORDER BY p.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  p.units = db.prepare('SELECT * FROM units WHERE property_id = ? ORDER BY code').all(p.id);
  res.json(p);
});

router.post('/', validate(PropertySchema), (req, res) => {
  const ownerId = req.user && req.user.id ? req.user.id : null;
  const r = db.prepare(`INSERT INTO properties (owner_user_id,name,address,district,type,notes) VALUES (?,?,?,?,?,?)`)
    .run(ownerId, req.body.name, req.body.address ?? null, req.body.district ?? null, req.body.type ?? 'mieszkanie', req.body.notes ?? null);
  res.status(201).json(db.prepare('SELECT * FROM properties WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(PropertySchema.partial()), (req, res) => {
  const fields = ['name','address','district','type','notes'].filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE properties SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM properties WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
