'use strict';

const { z } = require('zod');
const db = require('../db');
const { canSeeAll, ownerId } = require('../utils/scope');
const { METRICS } = require('./ai-metrics');
const { normalizeText } = require('./ai-preprocess');

const AliasSchema = z.object({
  alias: z.string().min(2).max(80),
  resolves_to_type: z.enum(['property', 'tenant', 'metric']),
  resolves_to_id: z.coerce.number().int().positive().nullable().optional(),
  resolves_to_value: z.string().max(80).nullable().optional(),
});

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function userKey(req) {
  if (!req.user) return 'anonymous';
  return String(req.user.id || req.user.username || 'anonymous');
}

function ownerUserId(req) {
  return req.user && req.user.id ? Number(req.user.id) : null;
}

function scopedPropertySql(req, alias = 'p') {
  if (canSeeAll(req)) return { sql: '', params: [] };
  return { sql: `AND ${alias}.owner_user_id = ?`, params: [ownerId(req)] };
}

function scopedTenantSql(req, alias = 't') {
  if (canSeeAll(req)) return { sql: '', params: [] };
  return { sql: `AND ${alias}.owner_user_id = ?`, params: [ownerId(req)] };
}

function propertyCandidates(req) {
  const scope = scopedPropertySql(req, 'p');
  return db
    .prepare(`SELECT p.id, p.name FROM properties p WHERE 1=1 ${scope.sql} ORDER BY p.name`)
    .all(...scope.params);
}

function tenantCandidates(req) {
  const scope = scopedTenantSql(req, 't');
  return db
    .prepare(`SELECT t.id, t.name FROM tenants t WHERE 1=1 ${scope.sql} ORDER BY t.name`)
    .all(...scope.params);
}

function metricCandidates() {
  return Object.entries(METRICS).map(([key, metric]) => ({ key, label: metric.label_pl }));
}

function ensureAliasTable() {
  if (!tableExists('user_aliases')) {
    const err = new Error('aliases_not_available');
    err.status = 503;
    throw err;
  }
}

function assertTargetAllowed(req, type, targetId, targetValue) {
  if (type === 'metric') {
    if (!targetValue || !METRICS[targetValue]) {
      const err = new Error('invalid_metric_alias_target');
      err.status = 400;
      throw err;
    }
    return { id: null, value: targetValue };
  }
  if (!targetId) {
    const err = new Error('missing_alias_target');
    err.status = 400;
    throw err;
  }
  const table = type === 'property' ? 'properties' : 'tenants';
  const alias = type === 'property' ? 'p' : 't';
  const scope = type === 'property' ? scopedPropertySql(req, alias) : scopedTenantSql(req, alias);
  const row = db
    .prepare(`SELECT ${alias}.id FROM ${table} ${alias} WHERE ${alias}.id = ? ${scope.sql}`)
    .get(targetId, ...scope.params);
  if (!row) {
    const err = new Error('alias_target_not_found');
    err.status = 404;
    throw err;
  }
  return { id: targetId, value: null };
}

function upsertAlias(req, input, options = {}) {
  ensureAliasTable();
  const body = AliasSchema.parse(input || {});
  const alias = body.alias.trim();
  const normalized = normalizeText(alias);
  if (!normalized) {
    const err = new Error('invalid_alias');
    err.status = 400;
    throw err;
  }
  const target = assertTargetAllowed(
    req,
    body.resolves_to_type,
    body.resolves_to_id || null,
    body.resolves_to_value || null,
  );
  const owner = ownerUserId(req);
  const key = userKey(req);
  const existing = db
    .prepare(
      `
    SELECT id FROM user_aliases
    WHERE COALESCE(owner_user_id, 0) = COALESCE(?, 0)
      AND normalized_alias = ?
      AND resolves_to_type = ?
    LIMIT 1
  `,
    )
    .get(owner, normalized, body.resolves_to_type);
  if (existing) {
    db.prepare(
      `
      UPDATE user_aliases
      SET alias = ?, user_key = ?, resolves_to_id = ?, resolves_to_value = ?, use_count = use_count + ?
      WHERE id = ?
    `,
    ).run(alias, key, target.id, target.value, options.increment === false ? 0 : 1, existing.id);
    return getAlias(req, existing.id);
  }
  const info = db
    .prepare(
      `
    INSERT INTO user_aliases(owner_user_id,user_key,alias,normalized_alias,resolves_to_type,resolves_to_id,resolves_to_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(owner, key, alias, normalized, body.resolves_to_type, target.id, target.value);
  return getAlias(req, info.lastInsertRowid);
}

function targetLabel(row) {
  if (!row) return '';
  if (row.resolves_to_type === 'metric')
    return METRICS[row.resolves_to_value] ? METRICS[row.resolves_to_value].label_pl : row.resolves_to_value;
  if (row.resolves_to_type === 'property') {
    const property = db.prepare('SELECT name FROM properties WHERE id = ?').get(row.resolves_to_id);
    return property ? property.name : `#${row.resolves_to_id}`;
  }
  if (row.resolves_to_type === 'tenant') {
    const tenant = db.prepare('SELECT name FROM tenants WHERE id = ?').get(row.resolves_to_id);
    return tenant ? tenant.name : `#${row.resolves_to_id}`;
  }
  return '';
}

function decorate(row) {
  return row ? { ...row, target_label: targetLabel(row) } : null;
}

function getAlias(req, id) {
  const row = db
    .prepare(
      `
    SELECT * FROM user_aliases
    WHERE id = ? AND COALESCE(owner_user_id, 0) = COALESCE(?, 0)
  `,
    )
    .get(id, ownerUserId(req));
  return decorate(row);
}

function listAliases(req, { seed = true } = {}) {
  ensureAliasTable();
  if (seed) seedDefaultAliases(req);
  const rows = db
    .prepare(
      `
    SELECT * FROM user_aliases
    WHERE COALESCE(owner_user_id, 0) = COALESCE(?, 0)
    ORDER BY resolves_to_type, use_count DESC, alias COLLATE NOCASE
  `,
    )
    .all(ownerUserId(req))
    .map(decorate);
  return {
    aliases: rows,
    candidates: {
      properties: propertyCandidates(req),
      tenants: tenantCandidates(req),
      metrics: metricCandidates(),
    },
  };
}

function deleteAlias(req, id) {
  ensureAliasTable();
  const info = db
    .prepare(
      `
    DELETE FROM user_aliases
    WHERE id = ? AND COALESCE(owner_user_id, 0) = COALESCE(?, 0)
  `,
    )
    .run(id, ownerUserId(req));
  return { ok: info.changes > 0 };
}

function propertySeedAliases(name) {
  const stop = new Set(['os', 'ul', 'aleja', 'al', 'lokal', 'mieszkanie']);
  return normalizeText(name)
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9-]/g, ''))
    .filter((token) => token.length >= 4 && !/^\d/.test(token) && !stop.has(token));
}

function seedDefaultAliases(req) {
  ensureAliasTable();
  const before = db
    .prepare(
      `
    SELECT COUNT(*) AS count FROM user_aliases
    WHERE COALESCE(owner_user_id, 0) = COALESCE(?, 0)
  `,
    )
    .get(ownerUserId(req)).count;
  for (const property of propertyCandidates(req)) {
    for (const alias of propertySeedAliases(property.name)) {
      upsertAlias(
        req,
        { alias, resolves_to_type: 'property', resolves_to_id: property.id },
        { increment: false },
      );
    }
  }
  for (const [key, metric] of Object.entries(METRICS)) {
    for (const alias of metric.aliases.slice(0, 8)) {
      upsertAlias(req, { alias, resolves_to_type: 'metric', resolves_to_value: key }, { increment: false });
    }
  }
  const after = db
    .prepare(
      `
    SELECT COUNT(*) AS count FROM user_aliases
    WHERE COALESCE(owner_user_id, 0) = COALESCE(?, 0)
  `,
    )
    .get(ownerUserId(req)).count;
  return { ok: true, added: Math.max(0, after - before), total: after };
}

module.exports = {
  deleteAlias,
  listAliases,
  seedDefaultAliases,
  upsertAlias,
};
