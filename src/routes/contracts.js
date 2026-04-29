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

function makeConflictError(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function assertNoActiveConflict(contract, excludeId = null, previousTenantId = null) {
  if (contract.status !== 'active') return;
  const idClause = excludeId ? 'AND id != ?' : '';
  const params = excludeId ? [excludeId] : [];

  const unitConflict = db.prepare(`
    SELECT id FROM contracts
    WHERE unit_id = ? AND status = 'active' ${idClause}
    LIMIT 1
  `).get(contract.unit_id, ...params);
  if (unitConflict) throw makeConflictError('active_contract_exists_for_unit');

  const tenantInUnit = db.prepare(`
    SELECT id FROM tenants
    WHERE current_unit_id = ? AND status = 'active' AND id NOT IN (?, ?)
    LIMIT 1
  `).get(contract.unit_id, contract.tenant_id, previousTenantId || contract.tenant_id);
  if (tenantInUnit) throw makeConflictError('active_tenant_exists_for_unit');

  const tenantConflict = db.prepare(`
    SELECT id FROM contracts
    WHERE tenant_id = ? AND status = 'active' ${idClause}
    LIMIT 1
  `).get(contract.tenant_id, ...params);
  if (tenantConflict) throw makeConflictError('active_contract_exists_for_tenant');
}

function syncUnitOccupancy(unitId) {
  if (!unitId) return;
  const occupied = db.prepare(`
    SELECT 1
    FROM contracts
    WHERE unit_id = ? AND status = 'active'
    UNION
    SELECT 1
    FROM tenants
    WHERE current_unit_id = ? AND status = 'active'
    LIMIT 1
  `).get(unitId, unitId);
  db.prepare('UPDATE units SET status = ? WHERE id = ?').run(occupied ? 'rented' : 'vacant', unitId);
}

function detachTenantFromUnit(tenantId, unitId) {
  if (!tenantId || !unitId) return;
  db.prepare('UPDATE tenants SET current_unit_id = NULL WHERE id = ? AND current_unit_id = ?').run(tenantId, unitId);
}

function applyActiveContract(contract) {
  db.prepare('UPDATE tenants SET current_unit_id = ?, status = ? WHERE id = ?').run(contract.unit_id, 'active', contract.tenant_id);
  db.prepare('UPDATE units SET status = ? WHERE id = ?').run('rented', contract.unit_id);
}

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
    assertNoActiveConflict(b);
    const tenantBefore = db.prepare('SELECT current_unit_id FROM tenants WHERE id = ?').get(b.tenant_id);
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
      applyActiveContract(b);
      if (tenantBefore && tenantBefore.current_unit_id !== b.unit_id) {
        syncUnitOccupancy(tenantBefore.current_unit_id);
      }
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
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!before) return null;
    const next = { ...before };
    for (const field of fields) next[field] = req.body[field] === '' ? null : req.body[field];

    assertNoActiveConflict(next, id, before.tenant_id);
    const nextTenantBefore = db.prepare('SELECT current_unit_id FROM tenants WHERE id = ?').get(next.tenant_id);

    const sql = `UPDATE contracts SET ${fields.map(f => `${f}=?`).join(',')} WHERE id = ?`;
    db.prepare(sql).run(...fields.map(f => req.body[f] === '' ? null : req.body[f]), id);

    const movedTenant = before.tenant_id !== next.tenant_id;
    const movedUnit = before.unit_id !== next.unit_id;
    const stoppedBeingActive = before.status === 'active' && next.status !== 'active';

    if (before.status === 'active' && (movedTenant || movedUnit || stoppedBeingActive)) {
      detachTenantFromUnit(before.tenant_id, before.unit_id);
      syncUnitOccupancy(before.unit_id);
    }

    if (next.status === 'active') {
      applyActiveContract(next);
      if (nextTenantBefore && nextTenantBefore.current_unit_id !== next.unit_id) {
        syncUnitOccupancy(nextTenantBefore.current_unit_id);
      }
    } else {
      detachTenantFromUnit(next.tenant_id, next.unit_id);
      syncUnitOccupancy(next.unit_id);
    }

    return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  });
  try {
    const updated = tx();
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'contract_error' });
  }
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!before) return false;
    db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
    if (before.status === 'active') {
      detachTenantFromUnit(before.tenant_id, before.unit_id);
      syncUnitOccupancy(before.unit_id);
    }
    return true;
  });
  if (!tx()) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
