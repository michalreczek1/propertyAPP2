'use strict';
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { ownerExpenseRows, getOwnerCosts, appendOwnerCostCategories } = require('../utils/owner-costs');
const { assertRefs, canAccessExpense, ownerId } = require('../utils/scope');
const { requireAdmin } = require('../middleware/auth');

const ExpenseSchema = z.object({
  property_id: z.coerce.number().int().positive().nullable().optional(),
  unit_id: z.coerce.number().int().positive().nullable().optional(),
  category: z.enum(['czynsz','prad','internet','remonty','doplata','zarzadzanie','kredyt','inne']),
  amount: z.coerce.number().min(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().nullable().optional(),
  document_path: z.string().nullable().optional(),
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.from) { where.push('e.date >= ?'); params.push(req.query.from); }
  if (req.query.to)   { where.push('e.date <= ?'); params.push(req.query.to); }
  if (req.query.period) {
    where.push("strftime('%Y-%m', e.date) = ?");
    params.push(req.query.period);
  }
  if (req.query.category) { where.push('e.category = ?'); params.push(req.query.category); }
  if (req.query.property_id) { where.push('e.property_id = ?'); params.push(req.query.property_id); }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('(e.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ?)');
    params.push(req.user.id, req.user.id, req.user.id);
  }
  const rows = db.prepare(`
    SELECT e.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.date DESC, e.id DESC
  `).all(...params);

  if (req.query.include_owner === '1') {
    rows.push(...ownerExpenseRows(db, {
      from: req.query.from,
      to: req.query.to,
      period: req.query.period,
      category: req.query.category,
      property_id: req.query.property_id,
      user: req,
    }));
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  }

  res.json(rows);
});

router.get('/by-category', (req, res) => {
  const period = req.query.period;
  if (!period) return res.status(400).json({ error: 'period_required' });
  let rows = db.prepare(`
    SELECT e.category, SUM(e.amount) AS total
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    WHERE strftime('%Y-%m', e.date) = ?
      ${req.user && req.user.id && req.user.role !== 'admin' ? 'AND (e.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ?)' : ''}
    GROUP BY category
    ORDER BY total DESC
  `).all(period, ...(req.user && req.user.id && req.user.role !== 'admin' ? [req.user.id, req.user.id, req.user.id] : []));
  if (req.query.include_owner === '1') {
    rows = appendOwnerCostCategories(rows, getOwnerCosts(db, period, req));
  }
  res.json(rows);
});

router.get('/:id', (req, res) => {
  if (!canAccessExpense(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const e = db.prepare(`
    SELECT e.*, p.name AS property_name, u.name AS unit_name, u.code AS unit_code
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  res.json(e);
});

router.post('/', validate(ExpenseSchema), (req, res) => {
  const b = req.body;
  if (!assertRefs(db, req, { property_id: b.property_id, unit_id: b.unit_id })) return res.status(404).json({ error: 'related_not_found' });
  const r = db.prepare(`
    INSERT INTO expenses (owner_user_id,property_id,unit_id,category,amount,date,description,document_path)
    VALUES (@owner_user_id,@property_id,@unit_id,@category,@amount,@date,@description,@document_path)
  `).run({
    ...b,
    owner_user_id: ownerId(req),
    property_id: b.property_id || null,
    unit_id: b.unit_id || null,
    description: b.description || null,
    document_path: b.document_path || null,
  });
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(ExpenseSchema.partial()), (req, res) => {
  if (!canAccessExpense(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (!assertRefs(db, req, { property_id: req.body.property_id, unit_id: req.body.unit_id })) return res.status(404).json({ error: 'related_not_found' });
  const fields = ['property_id','unit_id','category','amount','date','description','document_path']
    .filter(f => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const sql = `UPDATE expenses SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
  const r = db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  if (!canAccessExpense(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// Migracja historycznych kosztów ze starego monthly_summary do tabeli expenses.
// Mapuje:
//   media_paid    → 'inne' (rzeczywiste koszty mediów dla wszystkich pokoi razem)
//   marek_total   → 'doplata' (prowizja zarządcy)
// Przypisuje do nieruchomości "Os. B. Chrobrego 28/21" (chrobrego ma 6 pokoi, generuje większość kosztów).
// Idempotentna — pomija miesiące dla których już istnieją wpisy z source='monthly_summary'.
router.post('/migrate-from-summary', requireAdmin, (req, res) => {
  const chrobr = db.prepare("SELECT id FROM properties WHERE name LIKE '%Chrobrego%' LIMIT 1").get();
  if (!chrobr) return res.status(400).json({ error: 'no_chrobrego_property' });

  const summaries = db.prepare(`
    SELECT period, marek_total, media_paid
    FROM monthly_summary
    WHERE COALESCE(marek_total,0) > 0 OR COALESCE(media_paid,0) > 0
    ORDER BY period
  `).all();

  let inserted = 0, skipped = 0;
  const ins = db.prepare(`
    INSERT INTO expenses (owner_user_id, property_id, category, amount, date, description, document_path)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  const exists = db.prepare(`
    SELECT 1 FROM expenses
    WHERE property_id = ? AND category = ?
      AND strftime('%Y-%m', date) = ?
    LIMIT 1
  `);

  const tx = db.transaction(() => {
    for (const s of summaries) {
      const date = `${s.period}-01`;
      if (s.media_paid && s.media_paid > 0) {
        if (!exists.get(chrobr.id, 'inne', s.period)) {
          ins.run(ownerId(req), chrobr.id, 'inne', s.media_paid, date, 'Media (dostawcy) — z arkusza Excel');
          inserted++;
        } else skipped++;
      }
      if (s.marek_total && s.marek_total > 0) {
        if (!exists.get(chrobr.id, 'doplata', s.period)) {
          ins.run(ownerId(req), chrobr.id, 'doplata', s.marek_total, date, 'Prowizja zarządcy (Marek) — z arkusza Excel');
          inserted++;
        } else skipped++;
      }
    }
  });
  tx();

  res.json({ inserted, skipped, periods: summaries.length });
});

module.exports = router;
