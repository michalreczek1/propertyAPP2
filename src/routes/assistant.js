'use strict';

const router = require('express').Router();
const { ZodError } = require('zod');
const { parseAssistantCommand, executeAssistantAction } = require('../services/assistant');

function handleError(res, err) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation_error', details: err.errors });
  }
  return res.status(err.status || 500).json({ error: err.message || 'assistant_error' });
}

router.post('/parse', async (req, res) => {
  try {
    res.json(await parseAssistantCommand(req, req.body || {}));
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/execute', async (req, res) => {
  try {
    res.json(await executeAssistantAction(req, req.body || {}));
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
