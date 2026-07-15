'use strict';

const multer = require('multer');
const { z } = require('zod');
const router = require('express').Router();
const { validate } = require('../middleware/validate');
const {
  confirmHighConfidence,
  confirmMatch,
  importTransactions,
  listTransactions,
  refreshSuggestion,
  setTransactionStatus,
  stats,
  undoMatch,
} = require('../services/bank-reconciliation');
const { ownerId } = require('../utils/scope');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname || '')) return cb(null, true);
    const error = new Error('unsupported_bank_file');
    error.status = 400;
    cb(error);
  },
});

const MatchSchema = z.object({
  payment_id: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().positive().optional(),
});

const BulkSchema = z.object({
  threshold: z.coerce.number().int().min(80).max(100).default(85),
});

function handle(operation, res, next) {
  try {
    res.json(operation());
  } catch (error) {
    next(error);
  }
}

router.get('/', (req, res) => {
  res.json({ transactions: listTransactions(req, req.query.status), stats: stats(req) });
});

router.post('/import', upload.single('file'), (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'bank_file_required' });
  try {
    res.status(201).json(importTransactions(req, req.file, req.body.bank_name));
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', (_req, res) => {
  const req = _req;
  const rows = listTransactions(req, 'new');
  for (const row of rows) refreshSuggestion(row.id, ownerId(req));
  res.json({ refreshed: rows.length });
});

router.post('/confirm-high', validate(BulkSchema), (req, res, next) => {
  handle(() => confirmHighConfidence(req, req.body.threshold), res, next);
});

router.post('/:id/match', validate(MatchSchema), (req, res, next) => {
  handle(() => confirmMatch(req, Number(req.params.id), req.body.payment_id, req.body.amount), res, next);
});

router.post('/:id/undo', (req, res, next) => {
  handle(() => undoMatch(req, Number(req.params.id)), res, next);
});

router.post('/:id/ignore', (req, res, next) => {
  handle(() => setTransactionStatus(req, Number(req.params.id), 'ignored'), res, next);
});

router.post('/:id/reopen', (req, res, next) => {
  handle(() => setTransactionStatus(req, Number(req.params.id), 'new'), res, next);
});

module.exports = router;
