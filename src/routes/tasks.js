'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  property_id: z.coerce.number().int().positive().nullable().optional(),
  unit_id: z.coerce.number().int().positive().nullable().optional(),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  due_date: z.string().nullable().optional(),
  priority: z.enum(['low','med','high']).default('med'),
  status: z.enum(['open','done']).default('open'),
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.priority) { where.push('t.priority = ?'); params.push(req.query.priority); }
  res.json(db.prepare(`
    SELECT t.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code, te.name AS tenant_name
    FROM tasks t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    LEFT JOIN tenants te ON te.id = t.tenant_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.status, COALESCE(t.due_date, '9999-12-31'), t.priority DESC
  `).all(...params));
});

router.get('/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code, te.name AS tenant_name
    FROM tasks t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    LEFT JOIN tenants te ON te.id = t.tenant_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(t);
});

router.post('/', validate(TaskSchema), (req, res) => {
  const b = req.body;
  const r = db.prepare(`
    INSERT INTO tasks (title,description,property_id,unit_id,tenant_id,due_date,priority,status)
    VALUES (@title,@description,@property_id,@unit_id,@tenant_id,@due_date,@priority,@status)
  `).run({
    ...b,
    description: b.description || null,
    property_id: b.property_id || null,
    unit_id: b.unit_id || null,
    tenant_id: b.tenant_id || null,
    due_date: b.due_date || null,
  });
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(TaskSchema.partial()), (req, res) => {
  const fields = ['title','description','property_id','unit_id','tenant_id','due_date','priority','status']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE tasks SET ${fields.map(f => `${f}=?`).join(',')}, done_at = CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE done_at END WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), req.body.status || '', req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

router.put('/:id/toggle', (req, res) => {
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const next = t.status === 'open' ? 'done' : 'open';
  db.prepare(`UPDATE tasks SET status=?, done_at = CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`)
    .run(next, next, req.params.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
