'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { assertRefs, canAccessTask, ownerId } = require('../utils/scope');

const TaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  property_id: z.coerce.number().int().positive().nullable().optional(),
  unit_id: z.coerce.number().int().positive().nullable().optional(),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  priority: z.enum(['low', 'med', 'high']).default('med'),
  status: z.enum(['open', 'done']).default('open'),
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('t.status = ?');
    params.push(req.query.status);
  }
  if (req.query.priority) {
    where.push('t.priority = ?');
    params.push(req.query.priority);
  }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push(
      '(t.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ? OR te.owner_user_id = ?)',
    );
    params.push(req.user.id, req.user.id, req.user.id, req.user.id);
  }
  res.json(
    db
      .prepare(
        `
    SELECT t.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code, te.name AS tenant_name
    FROM tasks t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    LEFT JOIN tenants te ON te.id = t.tenant_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.status, COALESCE(t.due_date, '9999-12-31'), t.priority DESC
  `,
      )
      .all(...params),
  );
});

router.get('/:id', (req, res) => {
  if (!canAccessTask(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const t = db
    .prepare(
      `
    SELECT t.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code, te.name AS tenant_name
    FROM tasks t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    LEFT JOIN tenants te ON te.id = t.tenant_id
    WHERE t.id = ?
  `,
    )
    .get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(t);
});

router.post('/', validate(TaskSchema), (req, res) => {
  const b = req.body;
  if (!assertRefs(db, req, { property_id: b.property_id, unit_id: b.unit_id, tenant_id: b.tenant_id }))
    return res.status(404).json({ error: 'related_not_found' });
  const r = db
    .prepare(
      `
    INSERT INTO tasks (owner_user_id,title,description,property_id,unit_id,tenant_id,due_date,priority,status)
    VALUES (@owner_user_id,@title,@description,@property_id,@unit_id,@tenant_id,@due_date,@priority,@status)
  `,
    )
    .run({
      ...b,
      owner_user_id: ownerId(req),
      description: b.description || null,
      property_id: b.property_id || null,
      unit_id: b.unit_id || null,
      tenant_id: b.tenant_id || null,
      due_date: b.due_date || null,
    });
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(TaskSchema.partial()), (req, res) => {
  if (!canAccessTask(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (
    !assertRefs(db, req, {
      property_id: req.body.property_id,
      unit_id: req.body.unit_id,
      tenant_id: req.body.tenant_id,
    })
  )
    return res.status(404).json({ error: 'related_not_found' });
  const fields = [
    'title',
    'description',
    'property_id',
    'unit_id',
    'tenant_id',
    'due_date',
    'priority',
    'status',
  ].filter((f) => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE tasks SET ${fields.map((f) => `${f}=?`).join(',')}, done_at = CASE WHEN ?='done' THEN CURRENT_TIMESTAMP WHEN ?='open' THEN NULL ELSE done_at END WHERE id = ?`;
  const r = db
    .prepare(sql)
    .run(
      ...fields.map((f) => (req.body[f] === '' ? null : req.body[f])),
      req.body.status || '',
      req.body.status || '',
      req.params.id,
    );
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

router.put('/:id/toggle', (req, res) => {
  if (!canAccessTask(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const next = t.status === 'open' ? 'done' : 'open';
  db.prepare(
    `UPDATE tasks SET status=?, done_at = CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`,
  ).run(next, next, req.params.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  if (!canAccessTask(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
