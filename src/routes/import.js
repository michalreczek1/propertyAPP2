'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { runImport } = require('../../scripts/import-excel');
const { run: runDryRun } = require('../../scripts/import-excel-dryrun');
const { requireAdmin } = require('../middleware/auth');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      cb(new Error('unsupported_file_type'));
      return;
    }
    cb(null, true);
  },
});

function excelImportEnabled() {
  return process.env.ENABLE_EXCEL_IMPORT === '1';
}

function removeUploaded(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

router.get('/status', (_req, res) => {
  res.json({
    excel_import_enabled: excelImportEnabled(),
    dry_run_enabled: true,
    enable_env: 'ENABLE_EXCEL_IMPORT=1',
  });
});

router.post('/excel/dry-run', requireAdmin, upload.single('file'), async (req, res, next) => {
  const filePath = req.file ? req.file.path : req.body && req.body.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'no_file' });
    const result = runDryRun(filePath, req.body && req.body.filter, { quiet: true });
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  } finally {
    if (req.file) removeUploaded(filePath);
  }
});

router.post('/excel', requireAdmin, upload.single('file'), async (req, res, next) => {
  const filePath = req.file ? req.file.path : req.body && req.body.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'no_file' });
    if (!excelImportEnabled()) {
      return res.status(403).json({
        error: 'excel_import_disabled',
        message: 'Excel import is disabled. Set ENABLE_EXCEL_IMPORT=1 on the server to allow writes.',
      });
    }
    if ((req.body && req.body.confirm) !== 'IMPORT_EXCEL') {
      return res.status(400).json({ error: 'missing_import_confirmation' });
    }
    const result = runImport(filePath, { quiet: true, allowWrite: true });
    res.json(result);
  } catch (e) {
    next(e);
  } finally {
    if (req.file) removeUploaded(filePath);
  }
});

module.exports = router;
