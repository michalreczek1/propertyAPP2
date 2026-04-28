'use strict';
const router = require('express').Router();
const db = require('../db');

router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  res.json(map);
});

router.put('/', (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, v == null ? '' : String(v));
  });
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  tx(Object.entries(req.body));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  res.json(map);
});

module.exports = router;
