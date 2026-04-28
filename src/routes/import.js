'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { runImport } = require('../../scripts/import-excel');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/excel', upload.single('file'), async (req, res, next) => {
  try {
    const filePath = req.file ? req.file.path : (req.body && req.body.path);
    if (!filePath) return res.status(400).json({ error: 'no_file' });
    const result = runImport(filePath, { quiet: true });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
