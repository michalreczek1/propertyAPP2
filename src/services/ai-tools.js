'use strict';

const db = require('../db');
const { monthlyFinanceSummary } = require('./finance-summary');
const { periodLabel } = require('../utils/period');
const { canSeeAll, ownerId } = require('../utils/scope');
const { METRICS, inferMetric, valueFromPropertyTotals } = require('./ai-metrics');
const {
  cleanEntityName,
  extractPropertySubject,
  extractTenantSubject,
  matchTokens,
  normalizeText,
  parsePeriodRange,
  tokensOverlap,
} = require('./ai-preprocess');

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

function scopeCondition(req, aliases = {}) {
  if (canSeeAll(req)) return { sql: '', params: [] };
  const uid = ownerId(req);
  const parts = [];
  if (aliases.property) parts.push(`${aliases.property}.owner_user_id = ?`);
  if (aliases.tenant) parts.push(`${aliases.tenant}.owner_user_id = ?`);
  if (aliases.payment) parts.push(`${aliases.payment}.owner_user_id = ?`);
  if (!parts.length) return { sql: '', params: [] };
  return { sql: `AND (${parts.join(' OR ')})`, params: parts.map(() => uid) };
}

function paymentPeriodBounds(req) {
  const scope = scopeCondition(req, { payment: 'pm', tenant: 't', property: 'pr' });
  const row = db.prepare(`
    SELECT MIN(pm.period) AS min_period, MAX(pm.period) AS max_period
    FROM payments pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE 1=1 ${scope.sql}
  `).get(...scope.params);
  return { min: row && row.min_period || null, max: row && row.max_period || null };
}

function listProperties(req) {
  const scope = scopeCondition(req, { property: 'p' });
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS units_count
    FROM properties p
    WHERE 1=1 ${scope.sql}
    ORDER BY p.name
  `).all(...scope.params);
}

function listTenants(req) {
  const scope = scopeCondition(req, { tenant: 't', property: 'p' });
  return db.prepare(`
    SELECT t.*, u.code AS unit_code, u.name AS unit_name, p.name AS property_name
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE 1=1 ${scope.sql}
    ORDER BY t.status, t.name
  `).all(...scope.params);
}

function userAliases(req, type = null) {
  if (!tableExists('user_aliases')) return [];
  const params = [userKey(req)];
  let sql = 'SELECT * FROM user_aliases WHERE user_key = ?';
  if (type) {
    sql += ' AND resolves_to_type = ?';
    params.push(type);
  }
  return db.prepare(sql + ' ORDER BY use_count DESC, learned_at DESC').all(...params);
}

function aliasScore(req, type, query, idOrValue) {
  const q = normalizeText(query);
  if (!q) return 0;
  return userAliases(req, type).reduce((score, row) => {
    const targetMatches = type === 'metric'
      ? row.resolves_to_value === idOrValue
      : Number(row.resolves_to_id) === Number(idOrValue);
    if (!targetMatches) return score;
    const alias = normalizeText(row.alias);
    if (alias && (q.includes(alias) || alias.includes(q))) return Math.max(score, 20 + Number(row.use_count || 0));
    return Math.max(score, tokensOverlap(q, alias));
  }, 0);
}

function resolveProperty(req, query) {
  const q = normalizeText(query);
  if (!q) return { status: 'missing', matches: [] };
  const scored = listProperties(req).map(row => {
    const text = normalizeText(`${row.name || ''} ${row.district || ''}`);
    const exact = text.includes(q) || q.includes(normalizeText(row.name || '')) ? 10 : 0;
    return { row, score: exact + tokensOverlap(q, text) + aliasScore(req, 'property', q, row.id) };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name), 'pl'));
  if (!scored.length) return { status: 'not_found', matches: [] };
  const best = scored[0].score;
  const matches = scored.filter(item => item.score === best).map(item => item.row);
  return { status: matches.length === 1 ? 'ok' : 'ambiguous', property: matches[0], matches };
}

function resolveTenant(req, query) {
  const q = normalizeText(query);
  if (!q) return { status: 'missing', matches: [] };
  const scored = listTenants(req).map(row => {
    const text = normalizeText(`${row.name || ''} ${row.unit_code || ''} ${row.property_name || ''}`);
    const exact = text.includes(q) || q.includes(normalizeText(row.name || '')) ? 10 : 0;
    return { row, score: exact + tokensOverlap(q, text) + aliasScore(req, 'tenant', q, row.id) };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name), 'pl'));
  if (!scored.length) return { status: 'not_found', matches: [] };
  const best = scored[0].score;
  const matches = scored.filter(item => item.score === best).map(item => item.row);
  return { status: matches.length === 1 ? 'ok' : 'ambiguous', tenant: matches[0], matches };
}

function paidValue(row) {
  const expected = Number(row.rent_amount || 0) + Number(row.media_amount || 0) + Number(row.other_amount || 0);
  if (row.status === 'paid') return expected;
  if (row.status === 'partial') return Math.min(Number(row.total_paid || 0), expected);
  return Math.max(0, Number(row.total_paid || 0));
}

function getPaymentRows(req, period) {
  const scope = scopeCondition(req, { payment: 'pm', tenant: 't', property: 'pr' });
  return db.prepare(`
    SELECT pm.*, t.name AS tenant_name, u.code AS unit_code, u.name AS unit_name, pr.name AS property_name
    FROM payments pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE pm.period = ? ${scope.sql}
    ORDER BY t.name, u.code, pm.id
  `).all(period, ...scope.params);
}

function dataQualityForRange(periods, rowsByPeriod) {
  const monthsMissing = periods.filter(period => !(rowsByPeriod.get(period) || []).length);
  return {
    months_expected: periods.length,
    months_with_data: periods.length - monthsMissing.length,
    months_missing: monthsMissing,
    has_issues: monthsMissing.length > 0,
  };
}

function getPropertyFinance(req, property, range) {
  const rows = [];
  const rowsByPeriod = new Map();
  for (const period of range.periods) {
    const summary = monthlyFinanceSummary(db, period, req);
    const matched = (summary.properties || []).filter(p => Number(p.id) === Number(property.id));
    rowsByPeriod.set(period, matched);
    const revenue = matched.reduce((sum, p) => sum + Number(p.revenue || 0), 0);
    const expected = matched.reduce((sum, p) => sum + Number(p.expected_revenue || 0), 0);
    const expenses = matched.reduce((sum, p) => sum + Number(p.expenses || 0), 0);
    const tax = matched.reduce((sum, p) => sum + Number(p.tax || 0), 0);
    const net = matched.reduce((sum, p) => sum + Number(p.net || 0), 0);
    rows.push({ period, revenue, expected, expenses, tax, net });
  }
  const totals = rows.reduce((acc, row) => ({
    revenue: acc.revenue + row.revenue,
    expected: acc.expected + row.expected,
    expenses: acc.expenses + row.expenses,
    tax: acc.tax + row.tax,
    net: acc.net + row.net,
  }), { revenue: 0, expected: 0, expenses: 0, tax: 0, net: 0 });
  totals.margin = totals.revenue ? totals.net / totals.revenue : 0;
  return {
    property,
    range,
    months: rows,
    totals,
    data_quality: dataQualityForRange(range.periods, rowsByPeriod),
    methodology: {
      revenue: METRICS.revenue_paid.methodology_pl,
      expected: METRICS.revenue_expected.methodology_pl,
      expenses: METRICS.expenses.methodology_pl,
      tax: METRICS.tax_total.methodology_pl,
      net: METRICS.net_income.methodology_pl,
      margin: METRICS.margin.methodology_pl,
    },
  };
}

function getGlobalFinance(req, range) {
  const rows = [];
  const rowsByPeriod = new Map();
  for (const period of range.periods) {
    const summary = monthlyFinanceSummary(db, period, req);
    const row = {
      period,
      revenue: Number(summary.totals.revenue || 0),
      expected: Number(summary.totals.expected_revenue || 0),
      expenses: Number(summary.totals.expenses || 0),
      tax: Number(summary.totals.tax_total || 0),
      net: Number(summary.totals.net || 0),
    };
    rows.push(row);
    rowsByPeriod.set(period, (row.revenue || row.expected || row.expenses || row.tax || row.net) ? [row] : []);
  }
  const totals = rows.reduce((acc, row) => ({
    revenue: acc.revenue + row.revenue,
    expected: acc.expected + row.expected,
    expenses: acc.expenses + row.expenses,
    tax: acc.tax + row.tax,
    net: acc.net + row.net,
  }), { revenue: 0, expected: 0, expenses: 0, tax: 0, net: 0 });
  totals.margin = totals.revenue ? totals.net / totals.revenue : 0;
  return {
    range,
    months: rows,
    totals,
    data_quality: dataQualityForRange(range.periods, rowsByPeriod),
    methodology: {
      revenue: METRICS.revenue_paid.methodology_pl,
      expected: METRICS.revenue_expected.methodology_pl,
      expenses: METRICS.expenses.methodology_pl,
      tax: METRICS.tax_total.methodology_pl,
      net: METRICS.net_income.methodology_pl,
      margin: METRICS.margin.methodology_pl,
    },
  };
}

function getTenantFinance(req, tenant, range) {
  const rows = range.periods.flatMap(period => getPaymentRows(req, period).filter(row => Number(row.tenant_id) === Number(tenant.id)));
  const expected = rows.reduce((sum, row) => sum + Number(row.rent_amount || 0) + Number(row.media_amount || 0) + Number(row.other_amount || 0), 0);
  const paid = rows.reduce((sum, row) => sum + paidValue(row), 0);
  const balance = Math.max(0, expected - paid);
  return {
    tenant,
    range,
    payments: rows,
    totals: { expected, paid, balance, count: rows.length },
    data_quality: { months_expected: range.periods.length, months_with_data: new Set(rows.map(r => r.period)).size, months_missing: range.periods.filter(p => !rows.some(r => r.period === p)) },
  };
}

function getTaxSummary(req, range) {
  const months = range.periods.map(period => {
    const summary = monthlyFinanceSummary(db, period, req);
    return { period, tax: summary.tax.podatek_suma || 0, base: summary.tax.base || 0, rent_paid: summary.revenue.rent_paid || 0 };
  });
  return {
    range,
    months,
    totals: {
      tax: months.reduce((sum, row) => sum + row.tax, 0),
      base: months.reduce((sum, row) => sum + row.base, 0),
      months_with_tax: months.filter(row => row.tax > 0).length,
    },
    methodology: METRICS.tax_total.methodology_pl,
  };
}

function getTenantCount(req, property, range) {
  const scoped = !canSeeAll(req);
  const uid = ownerId(req);
  const startDate = `${range.start}-01`;
  const endDate = `${range.end}-${new Date(Number(range.end.slice(0, 4)), Number(range.end.slice(5, 7)), 0).getDate()}`;
  const paymentRows = db.prepare(`
    SELECT DISTINCT t.id, t.name, u.code AS unit_code, p.name AS property_name
    FROM payments pm
    JOIN tenants t ON t.id = pm.tenant_id
    JOIN units u ON u.id = pm.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE p.id = ? AND pm.period BETWEEN ? AND ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR t.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
  `).all(property.id, range.start, range.end, ...(scoped ? [uid, uid, uid] : []));
  const contractRows = db.prepare(`
    SELECT DISTINCT t.id, t.name, u.code AS unit_code, p.name AS property_name
    FROM contracts c
    JOIN tenants t ON t.id = c.tenant_id
    JOIN units u ON u.id = c.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE p.id = ?
      AND COALESCE(c.start_date, '1900-01-01') <= ?
      AND COALESCE(c.end_date, '9999-12-31') >= ?
      ${scoped ? 'AND (t.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
  `).all(property.id, endDate, startDate, ...(scoped ? [uid, uid] : []));
  const byTenant = new Map();
  for (const row of [...paymentRows, ...contractRows]) if (row.id) byTenant.set(Number(row.id), row);
  const tenants = [...byTenant.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl'));
  return { property, range, tenants, totals: { count: tenants.length } };
}

function shouldShowMethodology(question, result) {
  const text = normalizeText(question);
  return text.includes('jak') || text.includes('licz') || text.includes('skad') || text.includes('dlaczego')
    || Boolean(result && result.data_quality && result.data_quality.has_issues)
    || Boolean(result && result.totals && (result.totals.net < 0 || result.totals.revenue === 0));
}

function formatMoney(value) {
  return `${Math.round(Number(value || 0))} zł`;
}

function itemsForMonths(rows) {
  return rows.filter(row => row.revenue || row.expected || row.expenses || row.tax || row.net)
    .slice(-24)
    .map(row => ({
      type: 'report',
      title: periodLabel(row.period),
      subtitle: `wpłaty ${formatMoney(row.revenue)} · oczek. ${formatMoney(row.expected)} · koszty ${formatMoney(row.expenses)} · podatek ${formatMoney(row.tax)} · netto ${formatMoney(row.net)}`,
      view: 'raporty',
    }));
}

function maybeQualityNote(dataQuality) {
  if (!dataQuality || !dataQuality.months_missing || !dataQuality.months_missing.length) return '';
  return ` Uwaga: brak danych dla ${dataQuality.months_missing.join(', ')}.`;
}

function resultList(intent, title, message, items = [], navigation = null, extra = {}) {
  return { ok: true, status: 'answer', intent, title, message, execute_required: false, items, navigation, ...extra };
}

function logAiQuery(req, payload) {
  if (!tableExists('ai_queries')) return;
  db.prepare(`
    INSERT INTO ai_queries(owner_user_id,user_key,session_id,question,route,metric_used,params_json,tools_called,answer,duration_ms,tokens_in,tokens_out,cost_usd,unmatched)
    VALUES (@owner_user_id,@user_key,@session_id,@question,@route,@metric_used,@params_json,@tools_called,@answer,@duration_ms,@tokens_in,@tokens_out,@cost_usd,@unmatched)
  `).run({
    owner_user_id: ownerUserId(req),
    user_key: userKey(req),
    session_id: payload.session_id || null,
    question: payload.question || '',
    route: payload.route || 'semantic',
    metric_used: payload.metric_used || null,
    params_json: JSON.stringify(payload.params || {}),
    tools_called: JSON.stringify(payload.tools_called || []),
    answer: payload.answer || null,
    duration_ms: payload.duration_ms || null,
    tokens_in: payload.tokens_in || null,
    tokens_out: payload.tokens_out || null,
    cost_usd: payload.cost_usd || null,
    unmatched: payload.unmatched ? 1 : 0,
  });
}

function semanticAnswer(req, question, currentPeriod) {
  const started = Date.now();
  const bounds = paymentPeriodBounds(req);
  const range = parsePeriodRange(question, currentPeriod, bounds);
  const metricHit = inferMetric(question);
  const text = normalizeText(question);
  const toolsCalled = [];
  const propertySubject = extractPropertySubject(question);
  const hasPropertySubject = Boolean(propertySubject && matchTokens(propertySubject).length);

  function finish(result, metricUsed, params = {}) {
    const enriched = {
      ...result,
      semantic: { metric: metricUsed, range, params, tools_called: toolsCalled },
    };
    logAiQuery(req, {
      question,
      route: 'semantic',
      metric_used: metricUsed,
      params,
      tools_called: toolsCalled,
      answer: enriched.message,
      duration_ms: Date.now() - started,
      unmatched: false,
    });
    return enriched;
  }

  if (metricHit && metricHit.ambiguous) {
    const result = {
      ok: false,
      status: 'clarify',
      intent: 'metric_clarification',
      title: 'Doprecyzuj metrykę',
      message: `Co dokładnie mam policzyć: ${metricHit.options.map(o => o.label).join(' czy ')}?`,
      execute_required: false,
      items: metricHit.options.map(o => ({ type: 'metric', title: o.label, subtitle: o.key })),
    };
    return finish(result, 'ambiguous_metric', { options: metricHit.options });
  }

  if (metricHit && metricHit.key === 'tax_total' && !hasPropertySubject) {
    toolsCalled.push('get_tax_summary');
    const tax = getTaxSummary(req, range);
    const message = `Podatek za ${range.label}: ${formatMoney(tax.totals.tax)}. Podstawa: ${formatMoney(tax.totals.base)}, miesięcy z podatkiem: ${tax.totals.months_with_tax}.`;
    return finish(resultList('report_answer', `Podatek ${range.label}`, message, tax.months.filter(row => row.tax > 0).map(row => ({ type: 'report', title: periodLabel(row.period), subtitle: `podatek ${formatMoney(row.tax)} · podstawa ${formatMoney(row.base)}`, view: 'raporty' })), { view: 'raporty', state: { period: range.end } }, { report: { ...tax, tax_total: tax.totals.tax, tax_base: tax.totals.base } }), 'tax_total', { range });
  }

  const isPropertyFinance = metricHit && ['net_income','revenue_paid','revenue_expected','expenses','tax_total','margin'].includes(metricHit.key)
    && hasPropertySubject;
  if (isPropertyFinance) {
    const query = propertySubject;
    toolsCalled.push('resolve_property');
    const resolved = resolveProperty(req, query);
    if (resolved.status !== 'ok') {
      const items = (resolved.matches.length ? resolved.matches : listProperties(req)).slice(0, 12).map(p => ({ type: 'property', id: p.id, title: p.name, subtitle: `${p.district || ''} · ${p.units_count || 0} lokali`, view: 'nieruchomosci' }));
      return finish(resultList('report_answer', 'Finanse nieruchomości', resolved.status === 'ambiguous' ? 'Znalazłem więcej niż jedną pasującą nieruchomość.' : `Nie znalazłem nieruchomości pasującej do: ${query || question}.`, items, { view: 'nieruchomosci' }, { report: { count: 0, range } }), metricHit.key, { query });
    }
    toolsCalled.push('get_property_finance');
    const finance = getPropertyFinance(req, resolved.property, range);
    const metric = metricHit.key;
    const value = valueFromPropertyTotals(metric, finance.totals);
    const metricLabel = metricHit.metric.label_pl;
    const valueText = metric === 'margin' ? `${Math.round(value * 1000) / 10}%` : formatMoney(value);
    const methodology = shouldShowMethodology(question, finance) ? ` ${metricHit.metric.methodology_pl}` : '';
    const message = `${metricLabel} dla ${resolved.property.name} za ${range.label}: ${valueText}. Wpłaty: ${formatMoney(finance.totals.revenue)}, oczekiwano: ${formatMoney(finance.totals.expected)}, koszty: ${formatMoney(finance.totals.expenses)}, podatek: ${formatMoney(finance.totals.tax)}, netto: ${formatMoney(finance.totals.net)}.${maybeQualityNote(finance.data_quality)}${methodology}`;
    return finish(resultList('report_answer', `${metricLabel}: ${resolved.property.name}`, message, itemsForMonths(finance.months), { view: 'raporty', state: { period: range.end } }, {
      report: { property_id: resolved.property.id, property_name: resolved.property.name, metric, range, ...finance.totals, value, data_quality: finance.data_quality, methodology: finance.methodology },
    }), metric, { property_id: resolved.property.id, range });
  }

  const isGlobalFinance = metricHit && ['net_income','revenue_paid','revenue_expected','expenses','margin'].includes(metricHit.key)
    && !hasPropertySubject;
  if (isGlobalFinance) {
    toolsCalled.push('get_global_finance');
    const finance = getGlobalFinance(req, range);
    const metric = metricHit.key;
    const value = valueFromPropertyTotals(metric, finance.totals);
    const metricLabel = metricHit.metric.label_pl;
    const valueText = metric === 'margin' ? `${Math.round(value * 1000) / 10}%` : formatMoney(value);
    const methodology = shouldShowMethodology(question, finance) ? ` ${metricHit.metric.methodology_pl}` : '';
    const message = `${metricLabel} za ${range.label}: ${valueText}. Wpłaty: ${formatMoney(finance.totals.revenue)}, oczekiwano: ${formatMoney(finance.totals.expected)}, koszty: ${formatMoney(finance.totals.expenses)}, podatek: ${formatMoney(finance.totals.tax)}, netto: ${formatMoney(finance.totals.net)}.${maybeQualityNote(finance.data_quality)}${methodology}`;
    return finish(resultList('report_answer', `${metricLabel} ${range.label}`, message, itemsForMonths(finance.months), { view: 'raporty', state: { period: range.end } }, {
      report: { metric, range, ...finance.totals, value, data_quality: finance.data_quality, methodology: finance.methodology },
    }), metric, { range });
  }

  if (metricHit && metricHit.key === 'tenant_count') {
    const query = cleanEntityName(extractPropertySubject(question) || question);
    toolsCalled.push('resolve_property');
    const resolved = resolveProperty(req, query);
    if (resolved.status !== 'ok') return null;
    toolsCalled.push('get_tenant_count');
    const counted = getTenantCount(req, resolved.property, range);
    const message = `Na ${resolved.property.name} w okresie ${range.label} było ${counted.totals.count} unikalnych najemców.`;
    return finish(resultList('answer_from_data', `Najemcy: ${resolved.property.name}`, message, counted.tenants.slice(0, 30).map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || ''} · ${t.property_name || ''}`, view: 'najemcy' })), { view: 'najemcy' }, { report: { ...counted, count: counted.totals.count } }), 'tenant_count', { property_id: resolved.property.id, range });
  }

  if (metricHit && metricHit.key === 'tenant_paid_total') {
    const query = extractTenantSubject(question);
    toolsCalled.push('resolve_tenant');
    const resolved = resolveTenant(req, query);
    if (resolved.status !== 'ok') return null;
    toolsCalled.push('get_tenant_finance');
    const finance = getTenantFinance(req, resolved.tenant, range);
    const message = `${resolved.tenant.name} zapłacił ${formatMoney(finance.totals.paid)} za ${range.label}. Oczekiwano ${formatMoney(finance.totals.expected)}, saldo ${formatMoney(finance.totals.balance)}.`;
    return finish(resultList('answer_from_data', `Wpłaty: ${resolved.tenant.name}`, message, finance.payments.slice(0, 24).map(row => ({ type: 'payment', id: row.id, title: `${periodLabel(row.period)} · ${row.tenant_name}`, subtitle: `${row.unit_code || ''} · ${row.status} · wpłacono ${formatMoney(paidValue(row))}`, view: 'platnosci' })), { view: 'platnosci', state: { paymentsQ: resolved.tenant.name, period: range.end } }, { report: { ...finance, ...finance.totals } }), 'tenant_paid_total', { tenant_id: resolved.tenant.id, range });
  }

  if (metricHit && metricHit.key === 'tenant_balance') {
    const query = extractTenantSubject(question);
    toolsCalled.push('resolve_tenant');
    const resolved = resolveTenant(req, query);
    if (resolved.status !== 'ok') return null;
    toolsCalled.push('get_tenant_finance');
    const finance = getTenantFinance(req, resolved.tenant, range);
    const message = `${resolved.tenant.name} ma saldo do zapłaty ${formatMoney(finance.totals.balance)} za ${range.label}. Oczekiwano ${formatMoney(finance.totals.expected)}, wpłacono ${formatMoney(finance.totals.paid)}.`;
    return finish(resultList('answer_from_data', `Saldo: ${resolved.tenant.name}`, message, [], { view: 'platnosci', state: { paymentsQ: resolved.tenant.name, period: range.end } }, { report: finance }), 'tenant_balance', { tenant_id: resolved.tenant.id, range });
  }

  return null;
}

module.exports = {
  getPropertyFinance,
  getGlobalFinance,
  getTaxSummary,
  getTenantCount,
  getTenantFinance,
  listProperties,
  listTenants,
  logAiQuery,
  paymentPeriodBounds,
  resolveProperty,
  resolveTenant,
  semanticAnswer,
};
