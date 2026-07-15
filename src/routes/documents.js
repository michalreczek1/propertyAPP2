'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { z } = require('zod');
const db = require('../db');
const { validate } = require('../middleware/validate');
const {
  canAccessContract,
  canAccessDocument,
  canAccessExpense,
  canAccessProperty,
  canAccessTenant,
  canAccessUnit,
  ownerId,
} = require('../utils/scope');
const { isAllowedMime, hasExpectedSignature, removeUploadedFile } = require('../utils/document-upload');

const DOCUMENT_STATUSES = ['uploaded', 'review', 'approved', 'signed', 'rejected', 'archived'];
const STATUS_TRANSITIONS = {
  uploaded: ['review', 'approved', 'archived'],
  review: ['uploaded', 'approved', 'rejected'],
  approved: ['review', 'signed', 'archived'],
  signed: ['archived'],
  rejected: ['uploaded', 'archived'],
  archived: ['uploaded'],
};
const DocumentPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    document_number: z.string().trim().max(120).nullable().optional(),
    expires_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    version: z.coerce.number().int().min(1).max(999).optional(),
    workflow_status: z.enum(DOCUMENT_STATUSES).optional(),
    transition_note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR);

function resolveUploadPath(filePath) {
  const abs = path.resolve(UPLOADS_ROOT, filePath || '');
  if (abs !== UPLOADS_ROOT && !abs.startsWith(UPLOADS_ROOT + path.sep)) return null;
  return abs;
}

function getDownloadName(document) {
  const name = String(document.name || 'dokument').trim() || 'dokument';
  if (path.extname(name)) return name;

  const extByMime = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
  };
  const ext =
    extByMime[String(document.mime_type || '').toLowerCase()] ||
    path.extname(document.file_path || '').toLowerCase();
  return ext ? `${name}${ext}` : name;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w\d.\-_]+/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMime(file.mimetype)) return cb(null, true);
    const err = new Error('unsupported_file_type');
    err.status = 400;
    cb(err);
  },
});

function canAccessRelated(req, type, id) {
  if (!type || !id) return true;
  if (type === 'property') return canAccessProperty(db, req, id);
  if (type === 'unit') return canAccessUnit(db, req, id);
  if (type === 'tenant') return canAccessTenant(db, req, id);
  if (type === 'contract') return canAccessContract(db, req, id);
  if (type === 'expense') return canAccessExpense(db, req, id);
  return false;
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entity_type) {
    where.push('related_entity_type = ?');
    params.push(req.query.entity_type);
  }
  if (req.query.entity_id) {
    where.push('related_entity_id = ?');
    params.push(req.query.entity_id);
  }
  if (req.query.category) {
    where.push('category = ?');
    params.push(req.query.category);
  }
  if (req.query.workflow_status) {
    where.push('workflow_status = ?');
    params.push(req.query.workflow_status);
  }
  if (req.query.expiring_before) {
    where.push('expires_on IS NOT NULL AND expires_on <= ?');
    params.push(req.query.expiring_before);
  }
  if (req.user && req.user.id && req.user.role !== 'admin') {
    where.push('owner_user_id = ?');
    params.push(req.user.id);
  }
  res.json(
    db
      .prepare(
        `
    SELECT * FROM documents
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY uploaded_at DESC
  `,
      )
      .all(...params),
  );
});

router.get('/:id', (req, res) => {
  if (!canAccessDocument(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  res.json(d);
});

router.get('/:id/events', (req, res) => {
  if (!canAccessDocument(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  res.json(
    db
      .prepare(
        `SELECT e.*, u.display_name AS actor_name
         FROM document_workflow_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.document_id = ?
         ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(req.params.id),
  );
});

router.get('/:id/download', (req, res) => {
  if (!canAccessDocument(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  const abs = resolveUploadPath(d.file_path);
  if (!abs) return res.status(400).json({ error: 'invalid_file_path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file_missing' });
  res.download(abs, getDownloadName(d));
});

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const entityType = req.body.entity_type || null;
  const entityId = req.body.entity_id ? +req.body.entity_id : null;
  if (!hasExpectedSignature(req.file.path, req.file.mimetype)) {
    removeUploadedFile(req.file);
    return res.status(400).json({ error: 'invalid_file_signature' });
  }
  if (!canAccessRelated(req, entityType, entityId)) {
    removeUploadedFile(req.file);
    return res.status(404).json({ error: 'related_not_found' });
  }
  const r = db
    .prepare(
      `
    INSERT INTO documents
      (owner_user_id, name, file_path, mime_type, size_bytes, related_entity_type, related_entity_id,
       category, notes, workflow_status, expires_on, document_number, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      ownerId(req),
      req.body.name || req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      entityType,
      entityId,
      req.body.category || 'inne',
      req.body.notes || null,
      DOCUMENT_STATUSES.includes(req.body.workflow_status) ? req.body.workflow_status : 'uploaded',
      req.body.expires_on || null,
      req.body.document_number || null,
      Math.max(1, Number(req.body.version) || 1),
    );
  res.status(201).json(db.prepare('SELECT * FROM documents WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/:id', validate(DocumentPatchSchema), (req, res) => {
  if (!canAccessDocument(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const current = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const targetStatus = req.body.workflow_status;
  if (
    targetStatus &&
    targetStatus !== current.workflow_status &&
    !(STATUS_TRANSITIONS[current.workflow_status] || []).includes(targetStatus)
  ) {
    return res.status(409).json({
      error: 'invalid_document_transition',
      from: current.workflow_status,
      to: targetStatus,
      allowed: STATUS_TRANSITIONS[current.workflow_status] || [],
    });
  }
  const fields = [
    'name',
    'category',
    'notes',
    'document_number',
    'expires_on',
    'version',
    'workflow_status',
  ].filter((field) => req.body[field] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const updated = db.transaction(() => {
    db.prepare(`UPDATE documents SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`).run(
      ...fields.map((field) => req.body[field]),
      current.id,
    );
    if (targetStatus && targetStatus !== current.workflow_status) {
      db.prepare(
        `INSERT INTO document_workflow_events
          (document_id, actor_user_id, from_status, to_status, note)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        current.id,
        ownerId(req),
        current.workflow_status,
        targetStatus,
        req.body.transition_note || null,
      );
    }
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(current.id);
  })();
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  if (!canAccessDocument(db, req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  const abs = resolveUploadPath(d.file_path);
  if (abs) {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* ignore missing */
    }
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
