'use strict';

const db = require('../db');
const { confirmMatch } = require('./bank-reconciliation');
const { canSeeAll, ownerId } = require('../utils/scope');

const ALLOWED_ACTIONS = new Set(['create_task', 'reconcile_bank']);

function insertProposal(uid, proposal) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO automation_proposals
        (owner_user_id, source, action_type, risk_level, summary, payload_json, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uid,
      proposal.source || 'rules',
      proposal.action_type,
      proposal.risk_level,
      proposal.summary,
      JSON.stringify(proposal.payload),
      proposal.idempotency_key,
    );
  return result.changes;
}

function scan(req) {
  const uid = ownerId(req);
  const scoped = !canSeeAll(req);
  const endingContracts = db
    .prepare(
      `SELECT c.id, c.end_date, c.tenant_id, c.unit_id, t.name AS tenant_name,
              p.id AS property_id, p.name AS property_name, u.name AS unit_name
       FROM contracts c
       LEFT JOIN tenants t ON t.id = c.tenant_id
       LEFT JOIN units u ON u.id = c.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE c.status = 'active'
         AND c.end_date BETWEEN DATE('now') AND DATE('now', '+30 days')
         ${scoped ? 'AND (p.owner_user_id = ? OR t.owner_user_id = ?)' : ''}
       ORDER BY c.end_date LIMIT 25`,
    )
    .all(...(scoped ? [uid, uid] : []));
  const expiringDocuments = db
    .prepare(
      `SELECT id, name, expires_on, related_entity_type, related_entity_id
       FROM documents
       WHERE workflow_status != 'archived'
         AND expires_on BETWEEN DATE('now') AND DATE('now', '+30 days')
         ${scoped ? 'AND owner_user_id = ?' : ''}
       ORDER BY expires_on LIMIT 25`,
    )
    .all(...(scoped ? [uid] : []));
  const bankSuggestions = db
    .prepare(
      `SELECT bt.id, bt.amount, bt.booked_date, bt.suggested_payment_id, bt.confidence,
              bt.fingerprint, t.name AS tenant_name, pm.period
       FROM bank_transactions bt
       JOIN payments pm ON pm.id = bt.suggested_payment_id
       LEFT JOIN tenants t ON t.id = pm.tenant_id
       WHERE bt.owner_user_id IS ? AND bt.status = 'suggested' AND bt.confidence >= 85
       ORDER BY bt.confidence DESC, bt.booked_date DESC LIMIT 25`,
    )
    .all(uid);

  let created = 0;
  for (const contract of endingContracts) {
    created += insertProposal(uid, {
      action_type: 'create_task',
      risk_level: 'low',
      summary: `Przygotuj przedłużenie lub zakończenie umowy: ${contract.tenant_name || 'najemca'} · ${contract.property_name || 'nieruchomość'}`,
      payload: {
        title: `Umowa kończy się ${contract.end_date}: ${contract.tenant_name || 'najemca'}`,
        description: `Sprawdź decyzję, dokumenty i rozliczenie kaucji dla ${contract.property_name || ''} ${contract.unit_name || ''}.`,
        due_date: contract.end_date,
        priority: 'high',
        property_id: contract.property_id,
        unit_id: contract.unit_id,
        tenant_id: contract.tenant_id,
      },
      idempotency_key: `contract-expiry:${contract.id}:${contract.end_date}`,
    });
  }
  for (const document of expiringDocuments) {
    created += insertProposal(uid, {
      action_type: 'create_task',
      risk_level: 'low',
      summary: `Odnowienie dokumentu: ${document.name}`,
      payload: {
        title: `Dokument wygasa ${document.expires_on}: ${document.name}`,
        description: 'Zweryfikuj ważność i wgraj aktualną wersję dokumentu.',
        due_date: document.expires_on,
        priority: 'high',
      },
      idempotency_key: `document-expiry:${document.id}:${document.expires_on}`,
    });
  }
  for (const transaction of bankSuggestions) {
    created += insertProposal(uid, {
      action_type: 'reconcile_bank',
      risk_level: 'high',
      summary: `Uzgodnij ${Number(transaction.amount).toFixed(2)} PLN z płatnością ${transaction.tenant_name || ''} za ${transaction.period}`,
      payload: {
        transaction_id: transaction.id,
        payment_id: transaction.suggested_payment_id,
        amount: transaction.amount,
        confidence: transaction.confidence,
      },
      idempotency_key: `bank-match:${transaction.id}:${transaction.fingerprint}`,
    });
  }
  return {
    scanned: endingContracts.length + expiringDocuments.length + bankSuggestions.length,
    created,
    existing: endingContracts.length + expiringDocuments.length + bankSuggestions.length - created,
  };
}

function list(req, status) {
  const uid = ownerId(req);
  const where = ['owner_user_id IS ?'];
  const params = [uid];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  const proposals = db
    .prepare(
      `SELECT * FROM automation_proposals
       WHERE ${where.join(' AND ')}
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
       LIMIT 200`,
    )
    .all(...params)
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json),
      payload_json: undefined,
    }));
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END) AS executed,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'pending' AND risk_level = 'high' THEN 1 ELSE 0 END) AS high_risk
       FROM automation_proposals WHERE owner_user_id IS ?`,
    )
    .get(uid);
  return { proposals, stats };
}

function getPending(req, id) {
  const proposal = db
    .prepare("SELECT * FROM automation_proposals WHERE id = ? AND owner_user_id IS ? AND status = 'pending'")
    .get(id, ownerId(req));
  if (!proposal) throw Object.assign(new Error('automation_proposal_not_found'), { status: 404 });
  if (!ALLOWED_ACTIONS.has(proposal.action_type)) {
    throw Object.assign(new Error('automation_action_not_allowed'), { status: 400 });
  }
  proposal.payload = JSON.parse(proposal.payload_json);
  return proposal;
}

function execute(req, id, confirmed) {
  const proposal = getPending(req, id);
  if (proposal.risk_level === 'high' && confirmed !== true) {
    throw Object.assign(new Error('explicit_confirmation_required'), { status: 409 });
  }
  const uid = ownerId(req);
  try {
    let result;
    if (proposal.action_type === 'create_task') {
      const payload = proposal.payload;
      const inserted = db
        .prepare(
          `INSERT INTO tasks
            (owner_user_id, title, description, property_id, unit_id, tenant_id, due_date, priority, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          uid,
          payload.title,
          payload.description || null,
          payload.property_id || null,
          payload.unit_id || null,
          payload.tenant_id || null,
          payload.due_date || null,
          payload.priority || 'med',
        );
      result = { task_id: Number(inserted.lastInsertRowid) };
    } else if (proposal.action_type === 'reconcile_bank') {
      result = confirmMatch(
        req,
        Number(proposal.payload.transaction_id),
        Number(proposal.payload.payment_id),
        Number(proposal.payload.amount),
      );
    }
    db.prepare(
      `UPDATE automation_proposals
       SET status = 'executed', decision_by = ?, decision_at = CURRENT_TIMESTAMP,
           executed_at = CURRENT_TIMESTAMP, error_message = NULL
       WHERE id = ?`,
    ).run(uid, proposal.id);
    return { ok: true, result };
  } catch (error) {
    db.prepare('UPDATE automation_proposals SET error_message = ? WHERE id = ?').run(
      String(error.message || error).slice(0, 500),
      proposal.id,
    );
    throw error;
  }
}

function reject(req, id) {
  const proposal = getPending(req, id);
  db.prepare(
    `UPDATE automation_proposals
     SET status = 'rejected', decision_by = ?, decision_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(ownerId(req), proposal.id);
  return { ok: true };
}

module.exports = { execute, list, reject, scan };
