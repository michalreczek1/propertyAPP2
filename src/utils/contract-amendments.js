'use strict';

const { dueDate, todayLocalISO } = require('./period');

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateForTerms(asOf) {
  const value = String(asOf || todayLocalISO());
  if (/^\d{4}-\d{2}$/.test(value)) return dueDate(value, 31);
  return isIsoDate(value) ? value : todayLocalISO();
}

function addDays(date, days) {
  const value = dateForTerms(date);
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Math.max(0, Number(days) || 0));
  return parsed.toISOString().slice(0, 10);
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function baseTerms(contract) {
  return {
    rent: Number(contract.rent || 0),
    media_advance: Number(contract.media_advance || 0),
    pay_by_day: Number(contract.pay_by_day || 31),
    end_date: contract.end_date || null,
  };
}

function applyAmendment(terms, amendment) {
  const next = { ...terms };
  if (hasValue(amendment.new_end_date)) next.end_date = amendment.new_end_date;
  if (hasValue(amendment.rent)) next.rent = Number(amendment.rent);
  if (hasValue(amendment.media_advance)) next.media_advance = Number(amendment.media_advance);
  if (hasValue(amendment.pay_by_day)) next.pay_by_day = Number(amendment.pay_by_day);
  return next;
}

function amendmentOrder(a, b) {
  return (
    String(a.effective_date || '').localeCompare(String(b.effective_date || '')) ||
    Number(a.id || 0) - Number(b.id || 0)
  );
}

function getSignedAmendmentsByContract(db, contractIds, asOf, { includeFuture = false } = {}) {
  const ids = [...new Set((contractIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const cutoff = dateForTerms(asOf);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT *
      FROM contract_amendments
      WHERE status = 'signed'
        AND contract_id IN (${placeholders})
        ${includeFuture ? '' : 'AND DATE(effective_date) <= DATE(?)'}
      ORDER BY contract_id, DATE(effective_date), id
    `,
    )
    .all(...ids, ...(includeFuture ? [] : [cutoff]));
  const byContract = new Map();
  for (const row of rows) {
    const list = byContract.get(row.contract_id) || [];
    list.push(row);
    byContract.set(row.contract_id, list);
  }
  return byContract;
}

function decorateContractsWithTerms(db, contracts, { asOf } = {}) {
  const rows = Array.isArray(contracts) ? contracts : [];
  const appliedByContract = getSignedAmendmentsByContract(
    db,
    rows.map((contract) => contract.id),
    asOf,
  );
  const projectedByContract = getSignedAmendmentsByContract(
    db,
    rows.map((contract) => contract.id),
    asOf,
    { includeFuture: true },
  );
  const effectiveOn = dateForTerms(asOf);
  return rows.map((contract) => {
    const base = baseTerms(contract);
    const applied = appliedByContract.get(contract.id) || [];
    const current = applied.reduce((terms, amendment) => applyAmendment(terms, amendment), base);
    const projected = (projectedByContract.get(contract.id) || []).reduce(
      (terms, amendment) => applyAmendment(terms, amendment),
      base,
    );
    return {
      ...contract,
      base_terms: base,
      current_terms: current,
      projected_terms: projected,
      effective_on: effectiveOn,
      effective_rent: current.rent,
      effective_media_advance: current.media_advance,
      effective_pay_by_day: current.pay_by_day,
      effective_end_date: current.end_date,
      projected_end_date: projected.end_date,
      applied_amendments_count: applied.length,
    };
  });
}

function effectiveContractsForPeriod(db, contracts, period) {
  const monthStart = `${period}-01`;
  const monthEnd = dueDate(period, 31);
  return decorateContractsWithTerms(db, contracts, { asOf: monthEnd }).filter((contract) => {
    const terms = contract.current_terms;
    return (
      (!contract.start_date || String(contract.start_date) <= monthEnd) &&
      (!terms.end_date || String(terms.end_date) >= monthStart)
    );
  });
}

function contractsEndingWithinDays(db, contracts, days, { asOf } = {}) {
  const start = dateForTerms(asOf);
  const end = addDays(start, days);
  return decorateContractsWithTerms(db, contracts, { asOf: start })
    .filter((contract) => {
      const effectiveEnd = contract.projected_terms.end_date;
      return contract.status === 'active' && effectiveEnd && effectiveEnd >= start && effectiveEnd <= end;
    })
    .sort(
      (a, b) =>
        String(a.projected_terms.end_date).localeCompare(String(b.projected_terms.end_date)) || a.id - b.id,
    );
}

function getContractAmendments(db, contractId) {
  return db
    .prepare(
      `
      SELECT a.*,
             d.name AS document_name,
             d.file_path AS document_file_path,
             d.mime_type AS document_mime_type,
             d.size_bytes AS document_size_bytes,
             d.workflow_status AS document_workflow_status,
             d.uploaded_at AS document_uploaded_at
      FROM contract_amendments a
      LEFT JOIN documents d ON d.id = a.document_id
      WHERE a.contract_id = ?
      ORDER BY DATE(a.effective_date), a.id
    `,
    )
    .all(contractId);
}

function amendmentHistory(contract, amendments, { asOf } = {}) {
  let terms = baseTerms(contract);
  const effectiveOn = dateForTerms(asOf);
  return [...(amendments || [])].sort(amendmentOrder).map((amendment) => {
    const before_terms = { ...terms };
    if (amendment.status === 'signed') terms = applyAmendment(terms, amendment);
    return {
      ...amendment,
      before_terms,
      after_terms: { ...terms },
      effective_now: amendment.status === 'signed' && String(amendment.effective_date) <= effectiveOn,
    };
  });
}

module.exports = {
  addDays,
  amendmentHistory,
  applyAmendment,
  baseTerms,
  contractsEndingWithinDays,
  dateForTerms,
  decorateContractsWithTerms,
  effectiveContractsForPeriod,
  getContractAmendments,
};
