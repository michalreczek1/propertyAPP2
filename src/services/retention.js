'use strict';

const db = require('../db');

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function purgeExpiredAiQueries() {
  const days = Math.max(1, Number(process.env.AI_QUERY_RETENTION_DAYS || 90));
  if (!tableExists('ai_queries')) return 0;
  return db.prepare("DELETE FROM ai_queries WHERE created_at < datetime('now', '-' || ? || ' days')").run(days).changes;
}

module.exports = { purgeExpiredAiQueries };
