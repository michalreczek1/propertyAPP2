'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const {
  assertRefs,
  canAccessContract,
  canAccessDocument,
  canAccessTenant,
  canAccessUnit,
  ownerId,
} = require('../utils/scope');
const { dueDate } = require('../utils/period');
const { isAllowedMime, hasExpectedSignature, removeUploadedFile } = require('../utils/document-upload');
const {
  amendmentHistory,
  contractsEndingWithinDays,
  decorateContractsWithTerms,
  getContractAmendments,
} = require('../utils/contract-amendments');

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
    err.code = 'unsupported_file_type_pdf_jpg_only';
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

const DATE_SCHEMA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalDate = z.preprocess(
  (value) => (value === '' ? null : value),
  DATE_SCHEMA.nullable().optional(),
);
const optionalAmount = z.preprocess(
  (value) => (value === '' ? null : value),
  z.coerce.number().min(0).nullable().optional(),
);
const optionalPayDay = z.preprocess(
  (value) => (value === '' ? null : value),
  z.coerce.number().int().min(1).max(31).nullable().optional(),
);
const AmendmentSchema = z
  .object({
    amendment_number: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240).optional(),
    signed_date: optionalDate,
    effective_date: DATE_SCHEMA,
    new_end_date: optionalDate,
    rent: optionalAmount,
    media_advance: optionalAmount,
    pay_by_day: optionalPayDay,
    status: z.enum(['draft', 'signed']).default('signed'),
    notes: z.string().trim().max(2000).nullable().optional(),
    document_id: z.preprocess(
      (value) => (value === '' ? null : value),
      z.coerce.number().int().positive().nullable().optional(),
    ),
  })
  .strict();
const AmendmentPatchSchema = z
  .object({
    amendment_number: z.string().trim().min(1).max(120).optional(),
    effective_date: DATE_SCHEMA.optional(),
    new_end_date: optionalDate,
    rent: optionalAmount,
    media_advance: optionalAmount,
    pay_by_day: optionalPayDay,
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const AmendmentDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const AmendmentSignSchema = z
  .object({
    signed_date: DATE_SCHEMA,
  })
  .strict();
const ContractDocumentUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    category: z.enum(['umowa', 'protokol', 'inne']).default('umowa'),
    workflow_status: z.enum(['uploaded', 'review', 'approved', 'signed', 'rejected', 'archived']).optional(),
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

function validateAmendmentValues(values) {
  if (values.new_end_date && values.effective_date && values.new_end_date < values.effective_date) {
    const error = new Error('amendment_end_before_effective_date');
    error.code = 'amendment_end_before_effective_date';
    error.status = 400;
    throw error;
  }
  if (values.status === 'signed' && !values.signed_date) {
    const error = new Error('amendment_signed_date_required');
    error.code = 'amendment_signed_date_required';
    error.status = 400;
    throw error;
  }
  const hasTermsChange = ['new_end_date', 'rent', 'media_advance', 'pay_by_day'].some(
    (field) => values[field] !== null && values[field] !== undefined && values[field] !== '',
  );
  if (!hasTermsChange && !String(values.notes || '').trim()) {
    const error = new Error('amendment_change_or_note_required');
    error.code = 'amendment_change_or_note_required';
    error.status = 400;
    throw error;
  }
}

function validateUploadedAmendment(req, res, next) {
  const parsed = AmendmentSchema.safeParse(req.body);
  if (!parsed.success) {
    removeUploadedFile(req.file);
    return next(parsed.error);
  }
  try {
    validateAmendmentValues(parsed.data);
  } catch (error) {
    removeUploadedFile(req.file);
    return next(error);
  }
  if (req.file && !hasExpectedSignature(req.file.path, req.file.mimetype)) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'invalid_file_signature' });
  }
  if (parsed.data.status === 'signed' && !req.file && !parsed.data.document_id) {
    return res.status(400).json({ error: 'signed_amendment_document_required' });
  }
  if (req.file && parsed.data.document_id) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'amendment_document_source_conflict' });
  }
  req.body = parsed.data;
  next();
}

function validateUploadedAmendmentDocument(req, res, next) {
  const parsed = AmendmentDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    removeUploadedFile(req.file);
    return next(parsed.error);
  }
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  if (!hasExpectedSignature(req.file.path, req.file.mimetype)) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'invalid_file_signature' });
  }
  req.body = parsed.data;
  next();
}

function validateUploadedContractDocument(req, res, next) {
  const parsed = ContractDocumentUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    removeUploadedFile(req.file);
    return next(parsed.error);
  }
  if (!req.file) {
    return res.status(400).json({ error: 'no_file' });
  }
  if (!hasExpectedSignature(req.file.path, req.file.mimetype)) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'invalid_file_signature' });
  }
  req.body = {
    ...parsed.data,
    workflow_status:
      parsed.data.workflow_status || (parsed.data.category === 'umowa' ? 'signed' : 'uploaded'),
  };
  next();
}

function setDocumentStatus(documentId, status, actorUserId, note) {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!document || document.workflow_status === status) return;
  db.prepare('UPDATE documents SET workflow_status = ? WHERE id = ?').run(status, document.id);
  db.prepare(
    `INSERT INTO document_workflow_events(document_id, actor_user_id, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(document.id, actorUserId, document.workflow_status, status, note || null);
}

function amendmentDocumentName(contract, amendmentNumber, suppliedName) {
  if (suppliedName) return suppliedName;
  const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(contract.tenant_id);
  const unit = db
    .prepare(
      `SELECT p.name AS property_name
       FROM units u LEFT JOIN properties p ON p.id = u.property_id
       WHERE u.id = ?`,
    )
    .get(contract.unit_id);
  return `Aneks nr ${amendmentNumber} - ${tenant?.name || 'najemca'} - ${unit?.property_name || 'nieruchomosc'}`;
}

function createAmendmentDocument(contract, amendment, file, actorUserId, { name, notes, workflowStatus }) {
  const documentName = amendmentDocumentName(contract, amendment.amendment_number, name);
  const insertedDocument = db
    .prepare(
      `
      INSERT INTO documents
        (owner_user_id, name, file_path, mime_type, size_bytes, related_entity_type, related_entity_id,
         category, notes, workflow_status, document_number)
      VALUES (?, ?, ?, ?, ?, 'contract', ?, 'aneks', ?, ?, ?)
    `,
    )
    .run(
      actorUserId,
      documentName,
      file.filename,
      file.mimetype,
      file.size,
      contract.id,
      notes || null,
      workflowStatus,
      amendment.amendment_number,
    );
  const documentId = Number(insertedDocument.lastInsertRowid);
  db.prepare(
    `INSERT INTO document_workflow_events(document_id, actor_user_id, from_status, to_status, note)
     VALUES (?, ?, NULL, ?, ?)`,
  ).run(
    documentId,
    actorUserId,
    workflowStatus,
    workflowStatus === 'signed' ? 'Dodano podpisany aneks do umowy' : 'Dodano plik szkicu aneksu',
  );
  return documentId;
}

function amendmentSnapshot(contract) {
  const amendments = getContractAmendments(db, contract.id);
  const decorated = decorateContractsWithTerms(db, [contract])[0];
  return {
    contract: decorated,
    amendments: amendmentHistory(contract, amendments),
  };
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  const endingWithinDays =
    req.query.ending_within_days === undefined ? null : Number(req.query.ending_within_days);
  if (endingWithinDays !== null && (!Number.isInteger(endingWithinDays) || endingWithinDays < 0)) {
    return res.status(400).json({ error: 'invalid_ending_within_days' });
  }
  if (req.query.status) {
    where.push('c.status = ?');
    params.push(req.query.status);
  }
  if (req.query.tenant_id) {
    where.push('c.tenant_id = ?');
    params.push(req.query.tenant_id);
  }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('(p.owner_user_id = ? OR t.owner_user_id = ?)');
    params.push(req.user.id, req.user.id);
  }
  const rows = db
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
    .all(...params);
  const contracts = decorateContractsWithTerms(db, rows, { asOf: req.query.as_of });
  res.json(
    endingWithinDays === null
      ? contracts
      : contractsEndingWithinDays(db, contracts, endingWithinDays, { asOf: req.query.as_of }),
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
  res.json(decorateContractsWithTerms(db, [c], { asOf: req.query.as_of })[0]);
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

router.get('/:id/amendments', requireContractAccess, (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'not_found' });
  res.json(amendmentSnapshot(contract));
});

router.post(
  '/:id/amendments',
  requireContractAccess,
  signedDocumentUpload.single('file'),
  validateUploadedAmendment,
  (req, res, next) => {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    if (!contract) {
      removeUploadedFile(req.file);
      return res.status(404).json({ error: 'not_found' });
    }
    if (contract.status !== 'active') {
      removeUploadedFile(req.file);
      return res.status(409).json({ error: 'amendment_requires_active_contract' });
    }
    const b = req.body;
    const existingDocument = b.document_id
      ? db.prepare('SELECT * FROM documents WHERE id = ?').get(b.document_id)
      : null;
    if (
      b.document_id &&
      (!existingDocument ||
        !canAccessDocument(db, req, existingDocument.id) ||
        existingDocument.related_entity_type !== 'contract' ||
        Number(existingDocument.related_entity_id) !== Number(contract.id))
    ) {
      removeUploadedFile(req.file);
      return res.status(404).json({ error: 'amendment_document_not_for_contract' });
    }
    if (existingDocument && existingDocument.category !== 'aneks') {
      removeUploadedFile(req.file);
      return res.status(409).json({ error: 'amendment_document_category_required' });
    }
    if (
      db
        .prepare('SELECT id FROM contract_amendments WHERE contract_id = ? AND amendment_number = ?')
        .get(contract.id, b.amendment_number)
    ) {
      removeUploadedFile(req.file);
      return res.status(409).json({ error: 'amendment_number_exists' });
    }

    let amendmentId;
    try {
      amendmentId = db.transaction(() => {
        let documentId = b.document_id || null;
        if (req.file) {
          documentId = createAmendmentDocument(contract, b, req.file, ownerId(req), {
            name: b.name,
            notes: b.notes,
            workflowStatus: b.status === 'signed' ? 'signed' : 'uploaded',
          });
        } else if (documentId && b.status === 'signed') {
          setDocumentStatus(documentId, 'signed', ownerId(req), 'Podpisano aneks do umowy');
        }
        const inserted = db
          .prepare(
            `
            INSERT INTO contract_amendments
              (contract_id, document_id, amendment_number, signed_date, effective_date, new_end_date,
               rent, media_advance, pay_by_day, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            contract.id,
            documentId,
            b.amendment_number,
            b.signed_date || null,
            b.effective_date,
            b.new_end_date || null,
            b.rent ?? null,
            b.media_advance ?? null,
            b.pay_by_day ?? null,
            b.status,
            b.notes || null,
          );
        return Number(inserted.lastInsertRowid);
      })();
    } catch (error) {
      removeUploadedFile(req.file);
      if (String(error.message || '').includes('UNIQUE constraint failed: contract_amendments')) {
        return res.status(409).json({ error: 'amendment_number_exists' });
      }
      return next(error);
    }

    const snapshot = amendmentSnapshot(contract);
    const amendment = snapshot.amendments.find((item) => Number(item.id) === amendmentId);
    res.status(201).json({ ...amendment, contract: snapshot.contract });
  },
);

router.post(
  '/:id/amendments/:amendmentId/document',
  requireContractAccess,
  signedDocumentUpload.single('file'),
  validateUploadedAmendmentDocument,
  (req, res, next) => {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    const amendment = db
      .prepare('SELECT * FROM contract_amendments WHERE id = ? AND contract_id = ?')
      .get(req.params.amendmentId, req.params.id);
    if (!contract || !amendment) {
      removeUploadedFile(req.file);
      return res.status(404).json({ error: 'amendment_not_found' });
    }
    if (amendment.status === 'signed') {
      removeUploadedFile(req.file);
      return res.status(409).json({ error: 'signed_amendment_correction_required' });
    }
    try {
      db.transaction(() => {
        if (amendment.document_id) {
          setDocumentStatus(
            amendment.document_id,
            'archived',
            ownerId(req),
            'Zastąpiono plik szkicu aneksu nową wersją',
          );
        }
        const documentId = createAmendmentDocument(contract, amendment, req.file, ownerId(req), {
          name: req.body.name,
          notes: req.body.notes || amendment.notes,
          workflowStatus: 'uploaded',
        });
        db.prepare(
          `UPDATE contract_amendments
           SET document_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(documentId, amendment.id);
      })();
    } catch (error) {
      removeUploadedFile(req.file);
      return next(error);
    }
    const snapshot = amendmentSnapshot(contract);
    const updated = snapshot.amendments.find((item) => Number(item.id) === Number(amendment.id));
    res.status(201).json({ ...updated, contract: snapshot.contract });
  },
);

router.post(
  '/:id/amendments/:amendmentId/sign',
  requireContractAccess,
  validate(AmendmentSignSchema),
  (req, res, next) => {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    const amendment = db
      .prepare('SELECT * FROM contract_amendments WHERE id = ? AND contract_id = ?')
      .get(req.params.amendmentId, req.params.id);
    if (!contract || !amendment) return res.status(404).json({ error: 'amendment_not_found' });
    if (amendment.status === 'signed') return res.status(409).json({ error: 'amendment_already_signed' });
    if (!amendment.document_id) return res.status(409).json({ error: 'signed_amendment_document_required' });
    const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(amendment.document_id);
    if (
      !document ||
      !canAccessDocument(db, req, document.id) ||
      document.category !== 'aneks' ||
      document.related_entity_type !== 'contract' ||
      Number(document.related_entity_id) !== Number(contract.id)
    ) {
      return res.status(404).json({ error: 'amendment_document_not_for_contract' });
    }
    if (document.workflow_status === 'archived') {
      return res.status(409).json({ error: 'amendment_document_archived' });
    }
    const values = { ...amendment, status: 'signed', signed_date: req.body.signed_date };
    try {
      validateAmendmentValues(values);
      db.transaction(() => {
        db.prepare(
          `UPDATE contract_amendments
           SET status = 'signed', signed_date = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(req.body.signed_date, amendment.id);
        setDocumentStatus(document.id, 'signed', ownerId(req), 'Podpisano aneks do umowy');
      })();
    } catch (error) {
      return next(error);
    }
    const snapshot = amendmentSnapshot(contract);
    const updated = snapshot.amendments.find((item) => Number(item.id) === Number(amendment.id));
    res.json({ ...updated, contract: snapshot.contract });
  },
);

router.put(
  '/:id/amendments/:amendmentId',
  requireContractAccess,
  validate(AmendmentPatchSchema),
  (req, res, next) => {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'not_found' });
    const current = db
      .prepare('SELECT * FROM contract_amendments WHERE id = ? AND contract_id = ?')
      .get(req.params.amendmentId, contract.id);
    if (!current) return res.status(404).json({ error: 'amendment_not_found' });
    const fields = [
      'amendment_number',
      'effective_date',
      'new_end_date',
      'rent',
      'media_advance',
      'pay_by_day',
      'notes',
    ].filter((field) => req.body[field] !== undefined);
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });
    if (
      current.status === 'signed' &&
      fields.some((field) =>
        ['effective_date', 'new_end_date', 'rent', 'media_advance', 'pay_by_day'].includes(field),
      )
    ) {
      return res.status(409).json({ error: 'signed_amendment_correction_required' });
    }
    const updatedValues = { ...current, ...req.body };
    try {
      validateAmendmentValues(updatedValues);
    } catch (error) {
      return next(error);
    }
    if (
      fields.includes('amendment_number') &&
      db
        .prepare(
          'SELECT id FROM contract_amendments WHERE contract_id = ? AND amendment_number = ? AND id != ?',
        )
        .get(contract.id, updatedValues.amendment_number, current.id)
    ) {
      return res.status(409).json({ error: 'amendment_number_exists' });
    }
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE contract_amendments
         SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        ).run(...fields.map((field) => updatedValues[field]), current.id);
      })();
    } catch (error) {
      return next(error);
    }
    const snapshot = amendmentSnapshot(contract);
    const amendment = snapshot.amendments.find((item) => Number(item.id) === Number(current.id));
    res.json({ ...amendment, contract: snapshot.contract });
  },
);

router.post(
  '/:id/documents',
  requireContractAccess,
  signedDocumentUpload.single('file'),
  validateUploadedContractDocument,
  (req, res) => {
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
    const categoryLabel = { umowa: 'Umowa', protokol: 'Protokół', inne: 'Dokument' }[req.body.category];
    const defaultName = `${categoryLabel} - ${contract.tenant_name || 'najemca'} - ${contract.property_name || 'nieruchomosc'}`;
    const r = db
      .prepare(
        `
    INSERT INTO documents
      (owner_user_id, name, file_path, mime_type, size_bytes, related_entity_type, related_entity_id,
       category, notes, workflow_status)
    VALUES (?, ?, ?, ?, ?, 'contract', ?, ?, ?, ?)
  `,
      )
      .run(
        ownerId(req),
        req.body.name || defaultName,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.params.id,
        req.body.category,
        req.body.notes || null,
        req.body.workflow_status,
      );
    db.prepare(
      `INSERT INTO document_workflow_events(document_id, actor_user_id, from_status, to_status, note)
     VALUES (?, ?, NULL, ?, ?)`,
    ).run(
      r.lastInsertRowid,
      ownerId(req),
      req.body.workflow_status,
      req.body.workflow_status === 'signed'
        ? 'Dodano podpisany dokument do umowy'
        : 'Dodano dokument do umowy',
    );
    res.status(201).json(db.prepare('SELECT * FROM documents WHERE id = ?').get(r.lastInsertRowid));
  },
);

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
