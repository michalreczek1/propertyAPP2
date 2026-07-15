'use strict';

const router = require('express').Router();
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { execute, list, reject, scan } = require('../services/automation-engine');

const DecisionSchema = z.object({ confirmed: z.boolean().optional().default(false) }).strict();

function handle(operation, res, next) {
  try {
    res.json(operation());
  } catch (error) {
    next(error);
  }
}

router.get('/', (req, res) => {
  res.json(list(req, req.query.status));
});

router.post('/scan', (req, res, next) => {
  handle(() => scan(req), res, next);
});

router.post('/:id/approve', validate(DecisionSchema), (req, res, next) => {
  handle(() => execute(req, Number(req.params.id), req.body.confirmed), res, next);
});

router.post('/:id/reject', (req, res, next) => {
  handle(() => reject(req, Number(req.params.id)), res, next);
});

module.exports = router;
