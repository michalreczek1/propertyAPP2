'use strict';

const db = require('../db');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDITED_RESOURCES = new Set([
  'payments',
  'expenses',
  'contracts',
  'assistant',
  'properties',
  'units',
  'tenants',
  'tasks',
  'documents',
  'banking',
  'automations',
  'settings',
  'admin',
  'notifications',
]);

function tableExists() {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
}

function auditDetails(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);
  const resource = segments[1] || 'unknown';
  const targetId = segments.find((part, index) => index > 1 && /^\d+$/.test(part)) || null;
  return { resource, targetId, path };
}

function auditMutation(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const details = auditDetails(req);
  if (!AUDITED_RESOURCES.has(details.resource)) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400 || !tableExists()) return;
    try {
      db.prepare(
        `
        INSERT INTO audit_log(actor_user_id, action, resource, target_id, status_code, request_path)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run(
        req.user && req.user.id ? req.user.id : null,
        req.method.toLowerCase(),
        details.resource,
        details.targetId,
        res.statusCode,
        details.path,
      );
    } catch (error) {
      // Rejestr audytowy nie może zmienić wyniku poprawnie wykonanej operacji.
      console.error('Audit log write failed:', error.message);
    }
  });
  next();
}

function purgeExpiredAuditLog() {
  const days = Math.max(1, Number(process.env.AUDIT_LOG_RETENTION_DAYS || 365));
  if (!tableExists()) return 0;
  return db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')").run(days)
    .changes;
}

module.exports = { auditMutation, purgeExpiredAuditLog };
