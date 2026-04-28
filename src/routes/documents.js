'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w\d.\-_]+/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entity_type) { where.push('related_entity_type = ?'); params.push(req.query.entity_type); }
  if (req.query.entity_id)   { where.push('related_entity_id = ?'); params.push(req.query.entity_id); }
  if (req.query.category)    { where.push('category = ?'); params.push(req.query.category); }
  res.json(db.prepare(`
    SELECT * FROM documents
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY uploaded_at DESC
  `).all(...params));
});

router.get('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  res.json(d);
});

router.get('/:id/download', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  const abs = path.join(UPLOADS_DIR, d.file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file_missing' });
  res.download(abs, d.name);
});

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const r = db.prepare(`
    INSERT INTO documents (name, file_path, mime_type, size_bytes, related_entity_type, related_entity_id, category, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.body.name || req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    req.file.size,
    req.body.entity_type || null,
    req.body.entity_id ? +req.body.entity_id : null,
    req.body.category || 'inne',
    req.body.notes || null
  );
  res.status(201).json(db.prepare('SELECT * FROM documents WHERE id = ?').get(r.lastInsertRowid));
});

router.delete('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, d.file_path)); } catch { /* ignore missing */ }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
