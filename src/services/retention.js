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

function purgeExpiredAssistantActions() {
  if (!tableExists('assistant_action_executions')) return 0;
  return db.prepare("DELETE FROM assistant_action_executions WHERE created_at < datetime('now', '-2 days')").run().changes;
}

function purgeExpiredLoginAttempts() {
  if (!tableExists('login_attempts')) return 0;
  return db.prepare('DELETE FROM login_attempts WHERE reset_at < ?').run(Date.now()).changes;
}

module.exports = { purgeExpiredAiQueries, purgeExpiredAssistantActions, purgeExpiredLoginAttempts };
