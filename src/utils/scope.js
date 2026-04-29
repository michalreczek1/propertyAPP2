'use strict';

function canSeeAll(req) {
  const user = req && req.user;
  return !user || !user.id || user.role === 'admin';
}

function ownerId(req) {
  return req && req.user && req.user.id ? Number(req.user.id) : null;
}

function propertyScope(req, alias = 'p') {
  if (canSeeAll(req)) return { sql: '', params: [] };
  return { sql: `${alias}.owner_user_id = ?`, params: [ownerId(req)] };
}

function scopedWhere(req, alias, where = [], params = []) {
  const scope = propertyScope(req, alias);
  return {
    where: scope.sql ? [...where, scope.sql] : where,
    params: [...params, ...scope.params],
  };
}

function exists(db, sql, params) {
  return !!db.prepare(sql).get(...params);
}

function canAccessProperty(db, req, propertyId) {
  if (!propertyId || canSeeAll(req)) return true;
  return exists(db, 'SELECT 1 FROM properties WHERE id = ? AND owner_user_id = ? LIMIT 1', [propertyId, ownerId(req)]);
}

function canAccessUnit(db, req, unitId) {
  if (!unitId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE u.id = ? AND p.owner_user_id = ?
    LIMIT 1
  `, [unitId, ownerId(req)]);
}

function canAccessTenant(db, req, tenantId) {
  if (!tenantId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE t.id = ?
      AND (t.owner_user_id = ? OR p.owner_user_id = ?)
    LIMIT 1
  `, [tenantId, ownerId(req), ownerId(req)]);
}

function canAccessContract(db, req, contractId) {
  if (!contractId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM contracts c
    LEFT JOIN units u ON u.id = c.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.id = c.tenant_id
    WHERE c.id = ?
      AND (p.owner_user_id = ? OR t.owner_user_id = ?)
    LIMIT 1
  `, [contractId, ownerId(req), ownerId(req)]);
}

function canAccessPayment(db, req, paymentId) {
  if (!paymentId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM payments pm
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    WHERE pm.id = ?
      AND (pm.owner_user_id = ? OR p.owner_user_id = ? OR t.owner_user_id = ?)
    LIMIT 1
  `, [paymentId, ownerId(req), ownerId(req), ownerId(req)]);
}

function canAccessExpense(db, req, expenseId) {
  if (!expenseId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    WHERE e.id = ?
      AND (e.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ?)
    LIMIT 1
  `, [expenseId, ownerId(req), ownerId(req), ownerId(req)]);
}

function canAccessTask(db, req, taskId) {
  if (!taskId || canSeeAll(req)) return true;
  return exists(db, `
    SELECT 1
    FROM tasks t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    LEFT JOIN tenants te ON te.id = t.tenant_id
    WHERE t.id = ?
      AND (t.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ? OR te.owner_user_id = ?)
    LIMIT 1
  `, [taskId, ownerId(req), ownerId(req), ownerId(req), ownerId(req)]);
}

function canAccessDocument(db, req, documentId) {
  if (!documentId || canSeeAll(req)) return true;
  return exists(db, 'SELECT 1 FROM documents WHERE id = ? AND owner_user_id = ? LIMIT 1', [documentId, ownerId(req)]);
}

function assertRefs(db, req, refs) {
  if (refs.property_id && !canAccessProperty(db, req, refs.property_id)) return false;
  if (refs.unit_id && !canAccessUnit(db, req, refs.unit_id)) return false;
  if (refs.tenant_id && !canAccessTenant(db, req, refs.tenant_id)) return false;
  return true;
}

module.exports = {
  assertRefs,
  canAccessContract,
  canAccessDocument,
  canAccessExpense,
  canAccessPayment,
  canAccessProperty,
  canAccessTask,
  canAccessTenant,
  canAccessUnit,
  canSeeAll,
  ownerId,
  propertyScope,
  scopedWhere,
};
