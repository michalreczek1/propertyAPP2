'use strict';

const crypto = require('crypto');
const db = require('../db');
const { ownerId } = require('../utils/scope');

const HEADER_ALIASES = {
  booked_date: ['data', 'data operacji', 'data ksiegowania', 'booked date', 'date'],
  amount: ['kwota', 'kwota operacji', 'amount', 'value'],
  currency: ['waluta', 'currency'],
  title: ['tytul', 'tytul operacji', 'opis', 'description', 'title'],
  counterparty: ['kontrahent', 'nadawca', 'odbiorca', 'nazwa nadawcy', 'counterparty'],
  counterparty_account: ['rachunek', 'numer rachunku', 'rachunek nadawcy', 'account'],
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function detectSeparator(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((separator) => ({
    separator,
    count: firstLine.split(separator).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count ? counts[0].separator : ';';
}

function parseDelimited(text, separator = detectSeparator(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === separator) {
      row.push(field.trim());
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, '').trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field.replace(/\r$/, '').trim());
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function headerIndex(headers, key) {
  const normalized = headers.map(normalizeText);
  const aliases = HEADER_ALIASES[key].map(normalizeText);
  return normalized.findIndex((header) => aliases.includes(header));
}

function parseAmount(value) {
  let raw = String(value || '')
    .replace(/[\s\u00a0]|PLN|EUR|USD/gi, '')
    .replace(/[()]/g, (match) => (match === '(' ? '-' : ''));
  if (raw.includes(',') && raw.includes('.')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (raw.includes(',')) raw = raw.replace(',', '.');
  const amount = Number(raw);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return null;
}

function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  return new TextDecoder('windows-1250', { fatal: false }).decode(buffer);
}

function parseBankCsv(buffer) {
  const rows = parseDelimited(decodeCsv(buffer));
  if (rows.length < 2) throw Object.assign(new Error('empty_bank_file'), { status: 400 });
  const headers = rows[0];
  const indexes = Object.fromEntries(
    Object.keys(HEADER_ALIASES).map((key) => [key, headerIndex(headers, key)]),
  );
  if (indexes.booked_date < 0 || indexes.amount < 0) {
    throw Object.assign(new Error('bank_columns_missing'), { status: 400 });
  }
  const transactions = [];
  for (const row of rows.slice(1)) {
    const bookedDate = parseDate(row[indexes.booked_date]);
    const amount = parseAmount(row[indexes.amount]);
    if (!bookedDate || amount == null || amount === 0) continue;
    const value = (key) => (indexes[key] >= 0 ? String(row[indexes[key]] || '').trim() : '');
    transactions.push({
      booked_date: bookedDate,
      amount,
      currency: value('currency').toUpperCase() || 'PLN',
      title: value('title') || null,
      counterparty: value('counterparty') || null,
      counterparty_account: value('counterparty_account').replace(/\s/g, '') || null,
    });
  }
  if (!transactions.length) throw Object.assign(new Error('no_bank_transactions'), { status: 400 });
  return transactions;
}

function fingerprint(ownerUserId, transaction) {
  return crypto
    .createHash('sha256')
    .update(
      [
        ownerUserId,
        transaction.booked_date,
        transaction.amount.toFixed(2),
        transaction.currency,
        normalizeText(transaction.counterparty),
        normalizeText(transaction.counterparty_account),
        normalizeText(transaction.title),
      ].join('|'),
    )
    .digest('hex');
}

function scopedPayment(paymentId, uid) {
  return db
    .prepare(
      `
      SELECT pm.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code,
             p.name AS property_name,
             (COALESCE(pm.rent_amount, 0) + COALESCE(pm.media_amount, 0) + COALESCE(pm.other_amount, 0)) AS expected_total
      FROM payments pm
      LEFT JOIN tenants t ON t.id = pm.tenant_id
      LEFT JOIN units u ON u.id = pm.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE pm.id = ?
        AND (pm.owner_user_id IS ? OR p.owner_user_id IS ? OR t.owner_user_id IS ?)
    `,
    )
    .get(paymentId, uid, uid, uid);
}

function candidatePayments(uid) {
  return db
    .prepare(
      `
      SELECT pm.*, t.name AS tenant_name, u.name AS unit_name, u.code AS unit_code,
             p.name AS property_name,
             (COALESCE(pm.rent_amount, 0) + COALESCE(pm.media_amount, 0) + COALESCE(pm.other_amount, 0)) AS expected_total
      FROM payments pm
      LEFT JOIN tenants t ON t.id = pm.tenant_id
      LEFT JOIN units u ON u.id = pm.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE pm.status IN ('pending', 'overdue', 'partial')
        AND (pm.owner_user_id IS ? OR p.owner_user_id IS ? OR t.owner_user_id IS ?)
      ORDER BY pm.period DESC, pm.id DESC
    `,
    )
    .all(uid, uid, uid);
}

function paymentScore(transaction, payment) {
  const haystack = normalizeText(
    `${transaction.counterparty || ''} ${transaction.title || ''} ${transaction.counterparty_account || ''}`,
  );
  const expected = Number(payment.expected_total || 0);
  const remaining = Math.max(0, expected - Number(payment.total_paid || 0));
  const amount = Number(transaction.amount || 0);
  let score = 0;
  const reasons = [];
  if (Math.abs(amount - remaining) <= 0.01 && remaining > 0) {
    score += 55;
    reasons.push('zgodna kwota');
  } else if (amount > 0 && amount < remaining) {
    score += 32;
    reasons.push('możliwa wpłata częściowa');
  } else if (remaining && Math.abs(amount - remaining) / remaining <= 0.05) {
    score += 20;
    reasons.push('kwota zbliżona');
  }

  const tenant = normalizeText(payment.tenant_name);
  const tenantTokens = tenant.split(' ').filter((token) => token.length >= 4);
  if (tenant && haystack.includes(tenant)) {
    score += 30;
    reasons.push('pełna nazwa najemcy');
  } else if (tenantTokens.some((token) => haystack.includes(token))) {
    score += 22;
    reasons.push('najemca w tytule');
  }

  const unitTokens = [payment.unit_code, payment.unit_name]
    .map(normalizeText)
    .filter((token) => token.length >= 2);
  if (unitTokens.some((token) => haystack.includes(token))) {
    score += 12;
    reasons.push('oznaczenie lokalu');
  }

  const period = String(payment.period || '');
  const [year, month] = period.split('-');
  if (haystack.includes(period.replace('-', ' ')) || haystack.includes(`${month} ${year}`)) {
    score += 18;
    reasons.push('okres w tytule');
  } else if (transaction.booked_date.slice(0, 7) === period) {
    score += 8;
    reasons.push('wpłata w miesiącu rozliczenia');
  }
  return { score: Math.min(100, score), reasons, remaining };
}

function refreshSuggestion(transactionId, uid) {
  const transaction = db
    .prepare('SELECT * FROM bank_transactions WHERE id = ? AND owner_user_id IS ?')
    .get(transactionId, uid);
  if (!transaction || transaction.status === 'matched' || transaction.status === 'ignored')
    return transaction;
  if (Number(transaction.amount) <= 0) {
    db.prepare(
      "UPDATE bank_transactions SET status = 'ignored', suggested_payment_id = NULL, confidence = NULL, match_reason = 'transakcja wychodząca' WHERE id = ?",
    ).run(transaction.id);
    return db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(transaction.id);
  }
  const ranked = candidatePayments(uid)
    .map((payment) => ({ payment, ...paymentScore(transaction, payment) }))
    .filter((candidate) => candidate.score >= 45 && candidate.remaining > 0)
    .sort((a, b) => b.score - a.score || a.payment.id - b.payment.id);
  const top = ranked[0];
  const unique = top && (!ranked[1] || top.score - ranked[1].score >= 12);
  if (top && unique && top.score >= 70) {
    db.prepare(
      `UPDATE bank_transactions
       SET status = 'suggested', suggested_payment_id = ?, confidence = ?, match_reason = ?
       WHERE id = ?`,
    ).run(top.payment.id, top.score, top.reasons.join(', '), transaction.id);
  } else {
    db.prepare(
      `UPDATE bank_transactions
       SET status = 'new', suggested_payment_id = NULL, confidence = ?, match_reason = ?
       WHERE id = ?`,
    ).run(top ? top.score : null, top ? `niejednoznaczne: ${top.reasons.join(', ')}` : null, transaction.id);
  }
  return db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(transaction.id);
}

function importTransactions(req, file, bankName) {
  const uid = ownerId(req);
  const parsed = parseBankCsv(file.buffer);
  const insertImport = db.prepare(
    'INSERT INTO bank_imports(owner_user_id, file_name, bank_name) VALUES (?, ?, ?)',
  );
  const insertTransaction = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (owner_user_id, import_id, fingerprint, booked_date, amount, currency, counterparty, counterparty_account, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = db.transaction(() => {
    const imported = insertImport.run(uid, file.originalname || 'wyciag.csv', bankName || null);
    let inserted = 0;
    const ids = [];
    for (const transaction of parsed) {
      const created = insertTransaction.run(
        uid,
        imported.lastInsertRowid,
        fingerprint(uid, transaction),
        transaction.booked_date,
        transaction.amount,
        transaction.currency,
        transaction.counterparty,
        transaction.counterparty_account,
        transaction.title,
      );
      if (created.changes) {
        inserted += 1;
        ids.push(Number(created.lastInsertRowid));
      }
    }
    const duplicates = parsed.length - inserted;
    db.prepare('UPDATE bank_imports SET imported_count = ?, duplicate_count = ? WHERE id = ?').run(
      inserted,
      duplicates,
      imported.lastInsertRowid,
    );
    return { import_id: Number(imported.lastInsertRowid), imported: inserted, duplicates, ids };
  })();
  for (const id of result.ids) refreshSuggestion(id, uid);
  return { import_id: result.import_id, imported: result.imported, duplicates: result.duplicates };
}

function listTransactions(req, status) {
  const uid = ownerId(req);
  const params = [uid];
  const where = ['bt.owner_user_id IS ?'];
  if (status && status !== 'all') {
    where.push('bt.status = ?');
    params.push(status);
  }
  return db
    .prepare(
      `
      SELECT bt.*, bi.file_name, bi.bank_name,
             pm.period AS suggested_period, pm.total_paid AS suggested_total_paid,
             (COALESCE(pm.rent_amount, 0) + COALESCE(pm.media_amount, 0) + COALESCE(pm.other_amount, 0)) AS suggested_expected,
             t.name AS suggested_tenant_name, u.name AS suggested_unit_name,
             u.code AS suggested_unit_code, p.name AS suggested_property_name,
             bm.payment_id AS matched_payment_id, bm.applied_amount, bm.confirmed_at
      FROM bank_transactions bt
      LEFT JOIN bank_imports bi ON bi.id = bt.import_id
      LEFT JOIN payments pm ON pm.id = bt.suggested_payment_id
      LEFT JOIN tenants t ON t.id = pm.tenant_id
      LEFT JOIN units u ON u.id = pm.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      LEFT JOIN bank_matches bm ON bm.transaction_id = bt.id
      WHERE ${where.join(' AND ')}
      ORDER BY bt.booked_date DESC, bt.id DESC
      LIMIT 500
    `,
    )
    .all(...params);
}

function stats(req) {
  const uid = ownerId(req);
  return db
    .prepare(
      `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS unmatched,
             SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS suggested,
             SUM(CASE WHEN status = 'suggested' AND confidence >= 85 THEN 1 ELSE 0 END) AS high_confidence,
             SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched,
             COALESCE(SUM(CASE WHEN status = 'matched' THEN amount ELSE 0 END), 0) AS matched_amount
      FROM bank_transactions
      WHERE owner_user_id IS ?
    `,
    )
    .get(uid);
}

function confirmMatch(req, transactionId, paymentId, appliedAmount) {
  const uid = ownerId(req);
  const transaction = db
    .prepare('SELECT * FROM bank_transactions WHERE id = ? AND owner_user_id IS ?')
    .get(transactionId, uid);
  if (!transaction) throw Object.assign(new Error('bank_transaction_not_found'), { status: 404 });
  if (transaction.status === 'matched')
    return db.prepare('SELECT * FROM bank_matches WHERE transaction_id = ?').get(transaction.id);
  if (Number(transaction.amount) <= 0)
    throw Object.assign(new Error('outgoing_transaction_cannot_match'), { status: 400 });
  const targetId = Number(paymentId || transaction.suggested_payment_id);
  const payment = scopedPayment(targetId, uid);
  if (!payment) throw Object.assign(new Error('payment_not_found'), { status: 404 });
  const amount = Number(appliedAmount == null ? transaction.amount : appliedAmount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(transaction.amount) + 0.01) {
    throw Object.assign(new Error('invalid_match_amount'), { status: 400 });
  }
  const expected = Number(payment.expected_total || 0);
  const previousTotal = Number(payment.total_paid || 0);
  const nextTotal = Math.round((previousTotal + amount) * 100) / 100;
  const nextStatus = nextTotal >= expected - 0.01 ? 'paid' : 'partial';
  return db.transaction(() => {
    const match = db
      .prepare(
        `
        INSERT INTO bank_matches
          (owner_user_id, transaction_id, payment_id, applied_amount, previous_total_paid,
           previous_status, previous_paid_date, confidence, match_reason, confirmed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        uid,
        transaction.id,
        payment.id,
        amount,
        previousTotal,
        payment.status,
        payment.paid_date,
        transaction.confidence,
        transaction.match_reason,
        uid,
      );
    db.prepare('UPDATE payments SET total_paid = ?, status = ?, paid_date = ? WHERE id = ?').run(
      nextTotal,
      nextStatus,
      transaction.booked_date,
      payment.id,
    );
    db.prepare(
      `UPDATE bank_transactions
       SET status = 'matched', suggested_payment_id = ?, matched_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(payment.id, transaction.id);
    return db.prepare('SELECT * FROM bank_matches WHERE id = ?').get(match.lastInsertRowid);
  })();
}

function confirmHighConfidence(req, threshold = 85) {
  const uid = ownerId(req);
  const rows = db
    .prepare(
      `SELECT id, suggested_payment_id FROM bank_transactions
       WHERE owner_user_id IS ? AND status = 'suggested' AND confidence >= ?
       ORDER BY confidence DESC, id LIMIT 50`,
    )
    .all(uid, threshold);
  const results = [];
  for (const row of rows) results.push(confirmMatch(req, row.id, row.suggested_payment_id));
  return { confirmed: results.length };
}

function undoMatch(req, transactionId) {
  const uid = ownerId(req);
  const match = db
    .prepare(
      `SELECT bm.* FROM bank_matches bm
       JOIN bank_transactions bt ON bt.id = bm.transaction_id
       WHERE bm.transaction_id = ? AND bt.owner_user_id IS ?`,
    )
    .get(transactionId, uid);
  if (!match) throw Object.assign(new Error('bank_match_not_found'), { status: 404 });
  const later = db
    .prepare('SELECT 1 FROM bank_matches WHERE payment_id = ? AND id > ? LIMIT 1')
    .get(match.payment_id, match.id);
  if (later) throw Object.assign(new Error('newer_bank_match_exists'), { status: 409 });
  return db.transaction(() => {
    db.prepare('UPDATE payments SET total_paid = ?, status = ?, paid_date = ? WHERE id = ?').run(
      match.previous_total_paid,
      match.previous_status,
      match.previous_paid_date,
      match.payment_id,
    );
    db.prepare('DELETE FROM bank_matches WHERE id = ?').run(match.id);
    db.prepare("UPDATE bank_transactions SET status = 'suggested', matched_at = NULL WHERE id = ?").run(
      transactionId,
    );
    return { ok: true };
  })();
}

function setTransactionStatus(req, transactionId, status) {
  const uid = ownerId(req);
  const row = db
    .prepare('SELECT * FROM bank_transactions WHERE id = ? AND owner_user_id IS ?')
    .get(transactionId, uid);
  if (!row) throw Object.assign(new Error('bank_transaction_not_found'), { status: 404 });
  if (row.status === 'matched') throw Object.assign(new Error('undo_match_first'), { status: 409 });
  if (status === 'ignored') {
    db.prepare("UPDATE bank_transactions SET status = 'ignored' WHERE id = ?").run(row.id);
  } else {
    db.prepare("UPDATE bank_transactions SET status = 'new' WHERE id = ?").run(row.id);
    refreshSuggestion(row.id, uid);
  }
  return db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(row.id);
}

module.exports = {
  confirmHighConfidence,
  confirmMatch,
  importTransactions,
  listTransactions,
  refreshSuggestion,
  setTransactionStatus,
  stats,
  undoMatch,
};
