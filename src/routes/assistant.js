'use strict';

const router = require('express').Router();
const { ZodError } = require('zod');
const { parseAssistantCommand, executeAssistantAction } = require('../services/assistant');
const { deleteAlias, listAliases, seedDefaultAliases, upsertAlias } = require('../services/ai-aliases');

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

router.get('/aliases', (req, res) => {
  try {
    res.json(listAliases(req));
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/aliases', (req, res) => {
  try {
    res.json(upsertAlias(req, req.body || {}));
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/aliases/seed', (req, res) => {
  try {
    res.json(seedDefaultAliases(req));
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/aliases/:id', (req, res) => {
  try {
    res.json(deleteAlias(req, Number(req.params.id)));
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
