'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');

const propertyIds = 'SELECT id FROM properties WHERE owner_user_id = @userId';
const unitIds = `SELECT id FROM units WHERE property_id IN (${propertyIds})`;
const tenantIds = `SELECT id FROM tenants WHERE owner_user_id = @userId OR current_unit_id IN (${unitIds})`;
const contractIds = `SELECT id FROM contracts WHERE tenant_id IN (${tenantIds}) OR unit_id IN (${unitIds})`;
const paymentIds = `SELECT id FROM payments WHERE owner_user_id = @userId OR tenant_id IN (${tenantIds}) OR unit_id IN (${unitIds})`;
const expenseIds = `SELECT id FROM expenses WHERE owner_user_id = @userId OR property_id IN (${propertyIds}) OR unit_id IN (${unitIds})`;
const transactionIds = 'SELECT id FROM bank_transactions WHERE owner_user_id = @userId';

const filters = {
  properties: 'owner_user_id = @userId',
  units: `property_id IN (${propertyIds})`,
  tenants: `id IN (${tenantIds})`,
  contracts: `id IN (${contractIds})`,
  payments: `id IN (${paymentIds})`,
  expenses: `id IN (${expenseIds})`,
  tasks: `owner_user_id = @userId OR property_id IN (${propertyIds}) OR unit_id IN (${unitIds}) OR tenant_id IN (${tenantIds})`,
  documents: `owner_user_id = @userId
    OR (related_entity_type = 'property' AND related_entity_id IN (${propertyIds}))
    OR (related_entity_type = 'unit' AND related_entity_id IN (${unitIds}))
    OR (related_entity_type = 'tenant' AND related_entity_id IN (${tenantIds}))
    OR (related_entity_type = 'contract' AND related_entity_id IN (${contractIds}))
    OR (related_entity_type = 'expense' AND related_entity_id IN (${expenseIds}))`,
  notification_logs: `owner_user_id = @userId OR payment_id IN (${paymentIds}) OR tenant_id IN (${tenantIds}) OR unit_id IN (${unitIds})`,
  recurring_costs: `owner_user_id = @userId OR property_id IN (${propertyIds})`,
  recurring_cost_month_status: `owner_user_id = @userId OR property_id IN (${propertyIds})`,
  bank_matches: `owner_user_id = @userId OR payment_id IN (${paymentIds}) OR transaction_id IN (${transactionIds})`,
  bank_transactions: 'owner_user_id = @userId',
  bank_imports: 'owner_user_id = @userId',
  automation_proposals: 'owner_user_id = @userId',
  ai_queries: 'owner_user_id = @userId',
  assistant_action_executions: 'owner_user_id = @userId',
  user_aliases: 'owner_user_id = @userId',
  user_settings: 'owner_user_id = @userId',
  user_secrets: 'owner_user_id = @userId',
  account_codes: 'user_id = @userId',
};

function deletionPreview(userId) {
  const counts = {};
  for (const table of [
    'properties',
    'units',
    'tenants',
    'contracts',
    'payments',
    'expenses',
    'tasks',
    'documents',
  ]) {
    counts[table] = db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${filters[table]}`)
      .get({ userId }).count;
  }
  return counts;
}

function filePathsForDeletion(userId) {
  const paths = new Set();
  for (const [table, column] of [
    ['documents', 'file_path'],
    ['contracts', 'document_path'],
    ['expenses', 'document_path'],
  ]) {
    for (const row of db
      .prepare(`SELECT ${column} AS file_path FROM ${table} WHERE ${filters[table]}`)
      .all({ userId })) {
      if (row.file_path) paths.add(row.file_path);
    }
  }
  return [...paths];
}

function removeUnreferencedFiles(filePaths) {
  const uploadsRoot = path.resolve(
    process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads'),
  );
  let failed = 0;
  for (const filePath of filePaths) {
    const absolute = path.resolve(uploadsRoot, filePath);
    if (!absolute.startsWith(uploadsRoot + path.sep)) continue;
    const referenced = db
      .prepare(
        `
      SELECT 1 FROM documents WHERE file_path = ?
      UNION SELECT 1 FROM contracts WHERE document_path = ?
      UNION SELECT 1 FROM expenses WHERE document_path = ?
      LIMIT 1
    `,
      )
      .get(filePath, filePath, filePath);
    if (referenced) continue;
    try {
      fs.unlinkSync(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        failed++;
        console.error('User document cleanup failed:', error.message);
      }
    }
  }
  return failed;
}

function deleteUserAndData(userId) {
  const filePaths = filePathsForDeletion(userId);
  db.transaction(() => {
    for (const table of [
      'bank_matches',
      'documents',
      'notification_logs',
      'tasks',
      'expenses',
      'payments',
      'contracts',
      'tenants',
      'recurring_cost_month_status',
      'recurring_costs',
      'bank_transactions',
      'bank_imports',
      'automation_proposals',
      'ai_queries',
      'assistant_action_executions',
      'user_aliases',
      'user_settings',
      'user_secrets',
      'account_codes',
      'units',
      'properties',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE ${filters[table]}`).run({ userId });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  return { files_cleanup_failed: removeUnreferencedFiles(filePaths) };
}

module.exports = { deleteUserAndData, deletionPreview };
