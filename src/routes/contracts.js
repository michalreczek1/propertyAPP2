'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const { assertRefs, canAccessContract, canAccessTenant, canAccessUnit, ownerId } = require('../utils/scope');
const { dueDate } = require('../utils/period');
const { isAllowedMime, hasExpectedSignature, removeUploadedFile } = require('../utils/document-upload');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const signedDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w\d.\-_]+/g, '_');
      cb(null, `${Date.now()}-contract-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = isAllowedMime(file.mimetype);
    if (ok) return cb(null, true);
    const err = new Error('unsupported_file_type_pdf_jpg_only');
    err.status = 400;
    cb(err);
  },
});

const ContractSchema = z.object({
  tenant_id: z.coerce.number().int().positive(),
  unit_id: z.coerce.number().int().positive(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  rent: z.coerce.number().min(0).default(0),
  media_advance: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  pay_by_day: z.coerce.number().int().min(1).max(31).default(31),
  document_path: z.string().nullable().optional(),
  status: z.enum(['planned', 'active', 'ended']).default('planned'),
  notes: z.string().nullable().optional(),
});

const EndContractSchema = z.object({
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  set_tenant_inactive: z.boolean().optional().default(true),
});

const CONTRACT_STAGES = [
  'draft',
  'awaiting_documents',
  'awaiting_signature',
  'active',
  'ending',
  'ended',
  'archived',
];
const CONTRACT_TRANSITIONS = {
  draft: ['awaiting_documents', 'archived'],
  awaiting_documents: ['draft', 'awaiting_signature'],
  awaiting_signature: ['awaiting_documents', 'active'],
  active: ['ending', 'ended'],
  ending: ['active', 'ended'],
  ended: ['archived'],
  archived: [],
};
const ContractWorkflowSchema = z
  .object({
    stage: z.enum(CONTRACT_STAGES),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const TurnoverSchema = z.object({
  unit_id: z.coerce.number().int().positive(),
  previous_contract_id: z.coerce.number().int().positive().nullable().optional(),
  previous_end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  end_previous: z.boolean().optional().default(false),
  previous_tenant_inactive: z.boolean().optional().default(true),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  tenant_name: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  sms_consent: z.boolean().optional().default(false),
  sms_disabled: z.boolean().optional().default(false),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  rent: z.coerce.number().min(0).default(0),
  media_advance: z.coerce.number().min(0).default(0),
  deposit: z.coerce.number().min(0).default(0),
  pay_by_day: z.coerce.number().int().min(1).max(31).default(31),
  create_payment: z.boolean().optional().default(false),
  payment_period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable()
    .optional(),
  payment_multiplier: z.coerce.number().min(0).max(2).optional().default(1),
  notes: z.string().optional().nullable(),
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

  const unitConflict = db
    .prepare(
      `
    SELECT id FROM contracts
    WHERE unit_id = ? AND status = 'active' ${idClause}
    LIMIT 1
  `,
    )
    .get(contract.unit_id, ...params);
  if (unitConflict) throw makeConflictError('active_contract_exists_for_unit');

  const tenantInUnit = db
    .prepare(
      `
    SELECT id FROM tenants
    WHERE current_unit_id = ? AND status = 'active' AND id NOT IN (?, ?)
    LIMIT 1
  `,
    )
    .get(contract.unit_id, contract.tenant_id, previousTenantId || contract.tenant_id);
  if (tenantInUnit) throw makeConflictError('active_tenant_exists_for_unit');

  const tenantConflict = db
    .prepare(
      `
    SELECT id FROM contracts
    WHERE tenant_id = ? AND status = 'active' ${idClause}
    LIMIT 1
  `,
    )
    .get(contract.tenant_id, ...params);
  if (tenantConflict) throw makeConflictError('active_contract_exists_for_tenant');
}

function syncUnitOccupancy(unitId) {
  if (!unitId) return;
  const occupied = db
    .prepare(
      `
    SELECT 1
    FROM contracts
    WHERE unit_id = ? AND status = 'active'
    UNION
    SELECT 1
    FROM tenants
    WHERE current_unit_id = ? AND status = 'active'
    LIMIT 1
  `,
    )
    .get(unitId, unitId);
  db.prepare('UPDATE units SET status = ? WHERE id = ?').run(occupied ? 'rented' : 'vacant', unitId);
}

function detachTenantFromUnit(tenantId, unitId) {
  if (!tenantId || !unitId) return;
  db.prepare('UPDATE tenants SET current_unit_id = NULL WHERE id = ? AND current_unit_id = ?').run(
    tenantId,
    unitId,
  );
}

function hasOtherActiveContract(tenantId, excludeContractId) {
  if (!tenantId) return false;
  return !!db
    .prepare(
      `
    SELECT 1 FROM contracts
    WHERE tenant_id = ?
      AND status = 'active'
      AND id != ?
    LIMIT 1
  `,
    )
    .get(tenantId, excludeContractId || 0);
}

function periodFromDate(date) {
  return String(date || '').slice(0, 7);
}

function applyActiveContract(contract) {
  db.prepare('UPDATE tenants SET current_unit_id = ?, status = ? WHERE id = ?').run(
    contract.unit_id,
    'active',
    contract.tenant_id,
  );
  db.prepare('UPDATE units SET status = ? WHERE id = ?').run('rented', contract.unit_id);
}

function requireContractAccess(req, res, next) {
  if (!canAccessContract(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  next();
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('c.status = ?');
    params.push(req.query.status);
  }
  if (req.query.tenant_id) {
    where.push('c.tenant_id = ?');
    params.push(req.query.tenant_id);
  }
  if (req.query.ending_within_days) {
    where.push(
      "c.end_date IS NOT NULL AND DATE(c.end_date) <= DATE('now', '+' || ? || ' days') AND c.status='active'",
    );
    params.push(req.query.ending_within_days);
  }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('(p.owner_user_id = ? OR t.owner_user_id = ?)');
    params.push(req.user.id, req.user.id);
  }
  res.json(
    db
      .prepare(
        `
    SELECT c.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code,
           p.name AS property_name, p.district,
           (SELECT COUNT(*) FROM documents d WHERE d.related_entity_type = 'contract' AND d.related_entity_id = c.id) AS documents_count
    FROM contracts c
    LEFT JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.status, c.end_date
  `,
      )
      .all(...params),
  );
});

router.get('/:id', (req, res) => {
  if (!canAccessContract(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const c = db
    .prepare(
      `
    SELECT c.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code, p.name AS property_name,
           (SELECT COUNT(*) FROM documents d WHERE d.related_entity_type = 'contract' AND d.related_entity_id = c.id) AS documents_count
    FROM contracts c
    LEFT JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE c.id = ?
  `,
    )
    .get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(c);
});

function contractWorkflowSnapshot(contractId) {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!contract) return null;
  const documents = db
    .prepare(
      `SELECT id, name, category, workflow_status, expires_on, version, uploaded_at
       FROM documents
       WHERE related_entity_type = 'contract' AND related_entity_id = ?
       ORDER BY uploaded_at DESC`,
    )
    .all(contractId);
  const signedContract = documents.some(
    (document) => document.category === 'umowa' && document.workflow_status === 'signed',
  );
  const protocol = documents.some(
    (document) =>
      document.category === 'protokol' && ['approved', 'signed'].includes(document.workflow_status),
  );
  const stage = contract.workflow_stage || (contract.status === 'ended' ? 'ended' : 'active');
  return {
    contract,
    stage,
    allowed_transitions: CONTRACT_TRANSITIONS[stage] || [],
    checklist: [
      { key: 'signed_contract', label: 'Podpisana umowa', required_for: 'active', complete: signedContract },
      {
        key: 'handover_protocol',
        label: 'Protokół przekazania',
        required_for: 'handover',
        complete: protocol,
      },
    ],
    documents,
    events: db
      .prepare(
        `SELECT e.*, u.display_name AS actor_name
         FROM contract_workflow_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.contract_id = ? ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(contractId),
  };
}

router.get('/:id/workflow', requireContractAccess, (req, res) => {
  const snapshot = contractWorkflowSnapshot(Number(req.params.id));
  if (!snapshot) return res.status(404).json({ error: 'not_found' });
  res.json(snapshot);
});

router.post('/:id/workflow', requireContractAccess, validate(ContractWorkflowSchema), (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'not_found' });
  const currentStage = contract.workflow_stage || (contract.status === 'ended' ? 'ended' : 'active');
  const targetStage = req.body.stage;
  if (!(CONTRACT_TRANSITIONS[currentStage] || []).includes(targetStage)) {
    return res.status(409).json({
      error: 'invalid_contract_transition',
      from: currentStage,
      to: targetStage,
      allowed: CONTRACT_TRANSITIONS[currentStage] || [],
    });
  }
  const snapshot = contractWorkflowSnapshot(contract.id);
  if (
    targetStage === 'active' &&
    !snapshot.checklist.find((item) => item.key === 'signed_contract').complete
  ) {
    return res.status(409).json({ error: 'signed_contract_required' });
  }
  const targetStatus = ['active', 'ending'].includes(targetStage)
    ? 'active'
    : targetStage === 'ended' || targetStage === 'archived'
      ? 'ended'
      : 'planned';
  try {
    const updated = db.transaction(() => {
      if (targetStatus === 'active' && contract.status !== 'active') {
        assertNoActiveConflict({ ...contract, status: 'active' }, contract.id, contract.tenant_id);
        applyActiveContract(contract);
      } else if (targetStatus !== 'active' && contract.status === 'active') {
        detachTenantFromUnit(contract.tenant_id, contract.unit_id);
        syncUnitOccupancy(contract.unit_id);
      }
      db.prepare(
        `UPDATE contracts
         SET workflow_stage = ?, status = ?,
             activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, CURRENT_TIMESTAMP) ELSE activated_at END,
             archived_at = CASE WHEN ? = 'archived' THEN CURRENT_TIMESTAMP ELSE archived_at END
         WHERE id = ?`,
      ).run(targetStage, targetStatus, targetStage, targetStage, contract.id);
      db.prepare(
        `INSERT INTO contract_workflow_events
          (contract_id, actor_user_id, from_stage, to_stage, note)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(contract.id, ownerId(req), currentStage, targetStage, req.body.note || null);
      return contractWorkflowSnapshot(contract.id);
    })();
    res.json(updated);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'contract_workflow_error' });
  }
});

router.get('/:id/documents', requireContractAccess, (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT *
    FROM documents
    WHERE related_entity_type = 'contract'
      AND related_entity_id = ?
      ${req.user && req.user.id && req.user.role !== 'admin' ? 'AND owner_user_id = ?' : ''}
    ORDER BY uploaded_at DESC
  `,
    )
    .all(req.params.id, ...(req.user && req.user.id && req.user.role !== 'admin' ? [req.user.id] : []));
  res.json(rows);
});

router.post('/:id/documents', requireContractAccess, signedDocumentUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  if (!hasExpectedSignature(req.file.path, req.file.mimetype)) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'invalid_file_signature' });
  }
  const contract = db
    .prepare(
      `
    SELECT c.id, t.name AS tenant_name, p.name AS property_name
    FROM contracts c
    LEFT JOIN tenants t ON t.id = c.tenant_id
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE c.id = ?
  `,
    )
    .get(req.params.id);
  const defaultName = `Umowa podpisana - ${contract.tenant_name || 'najemca'} - ${contract.property_name || 'nieruchomosc'}`;
  const r = db
    .prepare(
      `
    INSERT INTO documents
      (owner_user_id, name, file_path, mime_type, size_bytes, related_entity_type, related_entity_id,
       category, notes, workflow_status)
    VALUES (?, ?, ?, ?, ?, 'contract', ?, 'umowa', ?, 'signed')
  `,
    )
    .run(
      ownerId(req),
      req.body.name || defaultName,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      req.params.id,
      req.body.notes || null,
    );
  db.prepare(
    `INSERT INTO document_workflow_events(document_id, actor_user_id, from_status, to_status, note)
     VALUES (?, ?, NULL, 'signed', 'Dodano podpisany dokument do umowy')`,
  ).run(r.lastInsertRowid, ownerId(req));
  res.status(201).json(db.prepare('SELECT * FROM documents WHERE id = ?').get(r.lastInsertRowid));
});

router.post('/:id/end', validate(EndContractSchema), (req, res) => {
  if (!canAccessContract(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!before) return null;
    db.prepare("UPDATE contracts SET status = ?, workflow_stage = 'ended', end_date = ? WHERE id = ?").run(
      'ended',
      req.body.end_date,
      id,
    );
    if ((before.workflow_stage || 'active') !== 'ended') {
      db.prepare(
        `INSERT INTO contract_workflow_events(contract_id, actor_user_id, from_stage, to_stage, note)
         VALUES (?, ?, ?, 'ended', 'Zakończenie umowy')`,
      ).run(id, ownerId(req), before.workflow_stage || 'active');
    }
    detachTenantFromUnit(before.tenant_id, before.unit_id);
    if (req.body.set_tenant_inactive && !hasOtherActiveContract(before.tenant_id, id)) {
      db.prepare('UPDATE tenants SET status = ?, current_unit_id = NULL WHERE id = ?').run(
        'inactive',
        before.tenant_id,
      );
    }
    syncUnitOccupancy(before.unit_id);
    return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  });
  const ended = tx();
  if (!ended) return res.status(404).json({ error: 'not_found' });
  res.json(ended);
});

router.post('/turnover', validate(TurnoverSchema), (req, res) => {
  const b = req.body;
  if (!canAccessUnit(db, req, b.unit_id)) return res.status(404).json({ error: 'unit_not_found' });
  if (b.tenant_id && !canAccessTenant(db, req, b.tenant_id))
    return res.status(404).json({ error: 'tenant_not_found' });
  if (!b.tenant_id && !String(b.tenant_name || '').trim())
    return res.status(400).json({ error: 'tenant_name_required' });

  const tx = db.transaction(() => {
    if (b.end_previous && b.previous_contract_id) {
      const previous = db.prepare('SELECT * FROM contracts WHERE id = ?').get(b.previous_contract_id);
      if (!previous || previous.unit_id !== b.unit_id)
        throw makeConflictError('previous_contract_not_for_unit');
      db.prepare('UPDATE contracts SET status = ?, end_date = ? WHERE id = ?').run(
        'ended',
        b.previous_end_date || b.start_date,
        previous.id,
      );
      detachTenantFromUnit(previous.tenant_id, previous.unit_id);
      if (b.previous_tenant_inactive && !hasOtherActiveContract(previous.tenant_id, previous.id)) {
        db.prepare('UPDATE tenants SET status = ?, current_unit_id = NULL WHERE id = ?').run(
          'inactive',
          previous.tenant_id,
        );
      }
      syncUnitOccupancy(previous.unit_id);
    }

    let tenantId = b.tenant_id || null;
    if (!tenantId) {
      const tenant = db
        .prepare(
          `
        INSERT INTO tenants (owner_user_id,name,email,phone,sms_consent,sms_disabled,current_unit_id,status,notes)
        VALUES (@owner_user_id,@name,@email,@phone,@sms_consent,@sms_disabled,NULL,'active',@notes)
      `,
        )
        .run({
          owner_user_id: ownerId(req),
          name: String(b.tenant_name || '').trim(),
          email: b.email || null,
          phone: b.phone || null,
          sms_consent: b.sms_consent ? 1 : 0,
          sms_disabled: b.sms_disabled ? 1 : 0,
          notes: null,
        });
      tenantId = tenant.lastInsertRowid;
    }

    const contract = {
      tenant_id: tenantId,
      unit_id: b.unit_id,
      start_date: b.start_date,
      end_date: b.end_date || null,
      rent: b.rent,
      media_advance: b.media_advance,
      deposit: b.deposit,
      pay_by_day: b.pay_by_day,
      document_path: null,
      status: 'active',
      notes: b.notes || null,
    };
    assertNoActiveConflict(contract);
    const created = db
      .prepare(
        `
      INSERT INTO contracts (tenant_id,unit_id,start_date,end_date,rent,media_advance,deposit,pay_by_day,document_path,status,notes)
      VALUES (@tenant_id,@unit_id,@start_date,@end_date,@rent,@media_advance,@deposit,@pay_by_day,@document_path,@status,@notes)
    `,
      )
      .run(contract);
    applyActiveContract(contract);

    let payment = null;
    if (b.create_payment) {
      const period = b.payment_period || periodFromDate(b.start_date);
      const multiplier = Number.isFinite(Number(b.payment_multiplier)) ? Number(b.payment_multiplier) : 1;
      const rent = Math.round(Number(b.rent || 0) * multiplier * 100) / 100;
      const media = Math.round(Number(b.media_advance || 0) * multiplier * 100) / 100;
      const inserted = db
        .prepare(
          `
        INSERT OR IGNORE INTO payments
          (owner_user_id,period,tenant_id,unit_id,due_day,due_date,rent_amount,media_amount,other_amount,late_fee_amount,late_fee_paid,late_fee_manual,total_paid,status,source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'pending', 'turnover')
      `,
        )
        .run(
          ownerId(req),
          period,
          tenantId,
          b.unit_id,
          b.pay_by_day,
          dueDate(period, b.pay_by_day),
          rent,
          media,
        );
      if (inserted.changes)
        payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(inserted.lastInsertRowid);
    }

    return {
      tenant: db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId),
      contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(created.lastInsertRowid),
      payment,
    };
  });

  try {
    res.status(201).json(tx());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'contract_turnover_error' });
  }
});

router.post('/', validate(ContractSchema), (req, res) => {
  const b = req.body;
  if (!assertRefs(db, req, { tenant_id: b.tenant_id, unit_id: b.unit_id }))
    return res.status(404).json({ error: 'related_not_found' });
  const tx = db.transaction(() => {
    assertNoActiveConflict(b);
    const tenantBefore = db.prepare('SELECT current_unit_id FROM tenants WHERE id = ?').get(b.tenant_id);
    const r = db
      .prepare(
        `
      INSERT INTO contracts (tenant_id,unit_id,start_date,end_date,rent,media_advance,deposit,pay_by_day,document_path,status,notes)
      VALUES (@tenant_id,@unit_id,@start_date,@end_date,@rent,@media_advance,@deposit,@pay_by_day,@document_path,@status,@notes)
    `,
      )
      .run({
        ...b,
        start_date: b.start_date || null,
        end_date: b.end_date || null,
        document_path: b.document_path || null,
        notes: b.notes || null,
      });
    db.prepare('UPDATE contracts SET workflow_stage = ? WHERE id = ?').run(
      b.status === 'planned' ? 'draft' : b.status === 'ended' ? 'ended' : 'active',
      r.lastInsertRowid,
    );
    if (b.status === 'active') {
      applyActiveContract(b);
      if (tenantBefore && tenantBefore.current_unit_id !== b.unit_id) {
        syncUnitOccupancy(tenantBefore.current_unit_id);
      }
    }
    return r.lastInsertRowid;
  });
  let id;
  try {
    id = tx();
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'contract_error' });
  }
  res.status(201).json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
});

router.put('/:id', validate(ContractSchema.partial()), (req, res) => {
  if (!canAccessContract(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  if (req.body.tenant_id && !canAccessTenant(db, req, req.body.tenant_id))
    return res.status(404).json({ error: 'tenant_not_found' });
  if (req.body.unit_id && !canAccessUnit(db, req, req.body.unit_id))
    return res.status(404).json({ error: 'unit_not_found' });
  const fields = [
    'tenant_id',
    'unit_id',
    'start_date',
    'end_date',
    'rent',
    'media_advance',
    'deposit',
    'pay_by_day',
    'document_path',
    'status',
    'notes',
  ].filter((f) => req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const id = Number(req.params.id);
  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!before) return null;
    const next = { ...before };
    for (const field of fields) next[field] = req.body[field] === '' ? null : req.body[field];

    assertNoActiveConflict(next, id, before.tenant_id);
    const nextTenantBefore = db
      .prepare('SELECT current_unit_id FROM tenants WHERE id = ?')
      .get(next.tenant_id);

    const sql = `UPDATE contracts SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id = ?`;
    db.prepare(sql).run(...fields.map((f) => (req.body[f] === '' ? null : req.body[f])), id);

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
    if (fields.includes('status')) {
      const workflowStage =
        next.status === 'planned' ? 'draft' : next.status === 'ended' ? 'ended' : 'active';
      db.prepare('UPDATE contracts SET workflow_stage = ? WHERE id = ?').run(workflowStage, id);
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
  if (!canAccessContract(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
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
