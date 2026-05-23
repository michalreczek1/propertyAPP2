'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const { monthlyFinanceSummary } = require('./finance-summary');
const { semanticAnswer } = require('./ai-tools');
const { parsePeriodRange: parseAiPeriodRange } = require('./ai-preprocess');
const { previewPaymentReminder, sendPaymentReminder } = require('./notifications');
const { todayLocalISO, parsePolishMonthYear, previousPeriod, periodLabel } = require('../utils/period');
const { canAccessPayment, ownerId } = require('../utils/scope');

const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const ACTION_TTL_MS = 10 * 60 * 1000;
const LATE_FEE_AMOUNT = 50;

const ParseSchema = z.object({
  message: z.string().min(1).max(1200),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

const ExecuteSchema = z.object({
  token: z.string().min(20),
});

const INTENTS = [
  'mark_payment_paid',
  'explain_tax',
  'send_sms_reminder',
  'search_global',
  'navigate_to_entity',
  'filter_payments',
  'filter_tenants',
  'filter_units',
  'filter_contracts',
  'filter_expenses',
  'report_answer',
  'answer_from_data',
  'data_quality_check',
  'create_task',
  'add_expense',
  'generate_payments',
  'unsupported',
];

const DATA_TOOLS = [
  'payments',
  'tenants',
  'units',
  'contracts',
  'expenses',
  'late_fees',
  'finance',
  'quality',
  'search',
];

const ENTITY_TYPES = ['tenant','payment','unit','property','contract','expense','task','report'];

const ModelIntentSchema = z.object({
  intent: z.enum(INTENTS),
  tenant_name: z.string().nullable().optional(),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  payment_id: z.coerce.number().int().positive().nullable().optional(),
  tool: z.enum(DATA_TOOLS).nullable().optional(),
  query: z.string().nullable().optional(),
  entity_type: z.enum(ENTITY_TYPES).nullable().optional(),
  status: z.string().nullable().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  year: z.coerce.number().int().min(2000).max(2100).nullable().optional(),
  property_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  amount: z.coerce.number().min(0).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.enum(['low','med','high']).nullable().optional(),
  tone: z.enum(['gentle','firm','default']).nullable().optional(),
  filters: z.record(z.unknown()).nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
});

function normalizeModelIntent(raw) {
  const out = raw && typeof raw === 'object' ? { ...raw } : {};
  const toolAliases = {
    payment: 'payments',
    payments: 'payments',
    tenant: 'tenants',
    tenants: 'tenants',
    unit: 'units',
    units: 'units',
    contract: 'contracts',
    contracts: 'contracts',
    expense: 'expenses',
    expenses: 'expenses',
    late_fee: 'late_fees',
    late_fees: 'late_fees',
    penalties: 'late_fees',
    penalty: 'late_fees',
    finance: 'finance',
    quality: 'quality',
    search: 'search',
  };
  if (!out.tool && out.entity_type && toolAliases[out.entity_type]) out.tool = toolAliases[out.entity_type];
  if (out.tool && toolAliases[out.tool]) out.tool = toolAliases[out.tool];
  if (out.entity_type && !ENTITY_TYPES.includes(out.entity_type)) {
    const singular = String(out.entity_type).replace(/s$/, '');
    if (ENTITY_TYPES.includes(singular)) out.entity_type = singular;
    else delete out.entity_type;
  }
  return out;
}

function assistantSecret() {
  return process.env.APP_SESSION_SECRET || process.env.ASSISTANT_ACTION_SECRET || 'propertyapp-assistant-dev-secret';
}

function userKey(req) {
  if (!req.user) return 'anonymous';
  return String(req.user.id || req.user.username || 'anonymous');
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', assistantSecret()).update(payload).digest('base64url');
}

function actionToken(req, action) {
  const payload = base64url(JSON.stringify({
    ...action,
    user_key: userKey(req),
    exp: Date.now() + ACTION_TTL_MS,
  }));
  return `${payload}.${signPayload(payload)}`;
}

function verifyActionToken(req, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || sig !== signPayload(payload)) {
    const err = new Error('invalid_action_token');
    err.status = 400;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    const err = new Error('invalid_action_token');
    err.status = 400;
    throw err;
  }
  if (!data.exp || Date.now() > data.exp || data.user_key !== userKey(req)) {
    const err = new Error('expired_action_token');
    err.status = 400;
    throw err;
  }
  return data;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[łŁ]/g, 'l')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ąćęłńóśźż\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparableToken(value) {
  return normalizeText(value)
    .replace(/(skiego|ckiego|owej|ego|ami|ach|owi|em|ej|ie|ow|ów|a|e|y|i)$/i, '');
}

function matchTokens(value) {
  const stop = new Set([
    'czy', 'ile', 'ilu', 'mialem', 'mial', 'najemca', 'najemcy', 'najemcow', 'najemco', 'najemc',
    'zeszly', 'zeszlym', 'poprzedni', 'poprzednim', 'roku', 'rok', 'tym', 'ten', 'tego',
    'miesiac', 'miesiacu', 'platnosc', 'platnosci', 'podatek', 'podatku',
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .map(comparableToken)
    .filter(token => token.length >= 3 && !stop.has(token));
}

function tokensOverlap(left, right) {
  const a = matchTokens(left);
  const b = matchTokens(right);
  if (!a.length || !b.length) return 0;
  let score = 0;
  for (const leftToken of a) {
    for (const rightToken of b) {
      if (leftToken === rightToken) score += 3;
      else if (leftToken.length >= 4 && rightToken.length >= 4 && (leftToken.includes(rightToken) || rightToken.includes(leftToken))) score += 1;
    }
  }
  return score;
}

function includesAny(text, words) {
  return words.some(word => text.includes(word));
}

function currentYear() {
  return Number(todayLocalISO().slice(0, 4));
}

function periodFromMessage(message, fallbackPeriod) {
  const direct = String(message || '').match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (direct) return direct[0];
  const parsed = parsePolishMonthYear(message);
  if (parsed) return parsed.period;
  const n = normalizeText(message);
  const months = [
    ['styczen', '01'], ['luty', '02'], ['marzec', '03'], ['kwiecien', '04'],
    ['maj', '05'], ['czerwiec', '06'], ['lipiec', '07'], ['sierpien', '08'],
    ['wrzesien', '09'], ['pazdziernik', '10'], ['listopad', '11'], ['grudzien', '12'],
  ];
  const year = (n.match(/\b(20\d{2})\b/) || [null, String(currentYear())])[1];
  const hit = months.find(([name]) => n.includes(name));
  if (hit) return `${year}-${hit[1]}`;
  return fallbackPeriod;
}

function shiftPeriodValue(period, delta) {
  const [year, month] = String(period || todayLocalISO().slice(0, 7)).split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodsBetween(start, end) {
  if (!/^\d{4}-\d{2}$/.test(String(start || '')) || !/^\d{4}-\d{2}$/.test(String(end || ''))) return [];
  const out = [];
  let cur = start;
  while (cur <= end && out.length < 600) {
    out.push(cur);
    cur = shiftPeriodValue(cur, 1);
  }
  return out;
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
  return {
    min: row && row.min_period || null,
    max: row && row.max_period || null,
  };
}

function dateRangeForPeriods(start, end) {
  return { start: `${start}-01`, end: monthEnd(end) };
}

function timeRangeFromMessage(message, fallbackPeriod, req = null) {
  const bounds = req ? paymentPeriodBounds(req) : { min: null, max: null };
  return parseAiPeriodRange(message, fallbackPeriod, bounds);
}

function yearFromMessage(message, fallbackPeriod) {
  const m = String(message || '').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : Number(String(fallbackPeriod || todayLocalISO().slice(0, 7)).slice(0, 4));
}

function monthEnd(period) {
  const [year, month] = String(period).split('-').map(Number);
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function scopeCondition(req, aliases = {}) {
  if (!req.user || !req.user.id || req.user.role === 'admin') return { sql: '', params: [] };
  const uid = req.user.id;
  const parts = [];
  if (aliases.payment) parts.push(`${aliases.payment}.owner_user_id = ?`);
  if (aliases.tenant) parts.push(`${aliases.tenant}.owner_user_id = ?`);
  if (aliases.property) parts.push(`${aliases.property}.owner_user_id = ?`);
  if (!parts.length) return { sql: '', params: [] };
  return { sql: `AND (${parts.join(' OR ')})`, params: parts.map(() => uid) };
}

function likeParam(text) {
  return `%${normalizeText(text).replace(/[%_]/g, '')}%`;
}

function amount(row) {
  return Number(row.rent_amount || 0) + Number(row.media_amount || 0) + Number(row.other_amount || 0);
}

function costCategoryLabel(category) {
  return ({
    czynsz: 'Czynsz',
    prad: 'Prąd',
    internet: 'Internet',
    remonty: 'Remonty',
    doplata: 'Dopłata',
    zarzadzanie: 'Zarządzanie',
    kredyt: 'Kredyt',
    inne: 'Inne',
  })[category] || category || 'Inne';
}

function scopedPaymentRows(req, period) {
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  return db.prepare(`
    SELECT p.id AS payment_id, p.period, p.tenant_id, p.unit_id, p.status, p.due_date,
           p.rent_amount, p.media_amount, p.other_amount, p.total_paid,
           t.name AS tenant_name, t.phone, t.sms_consent, t.sms_disabled,
           u.name AS unit_name, u.code AS unit_code, pr.id AS property_id, pr.name AS property_name
    FROM payments p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE p.period = ?
      ${scoped ? 'AND (p.owner_user_id = ? OR pr.owner_user_id = ? OR t.owner_user_id = ?)' : ''}
    ORDER BY t.name, u.code, p.id
  `).all(period, ...(scoped ? [req.user.id, req.user.id, req.user.id] : []));
}

function publicCandidates(rows) {
  return rows.slice(0, 60).map(row => ({
    payment_id: row.payment_id,
    tenant_id: row.tenant_id,
    tenant_name: row.tenant_name,
    unit: row.unit_code || row.unit_name || null,
    property: row.property_name || null,
    period: row.period,
    status: row.status,
    amount: amount(row),
    has_phone: Boolean(row.phone),
    sms_consent: Number(row.sms_consent || 0) === 1,
    sms_disabled: Number(row.sms_disabled || 0) === 1,
  }));
}

function publicTenantCandidates(rows, query) {
  const q = normalizeText(query || '');
  return rows
    .filter(row => !q || normalizeText(`${row.name || ''} ${row.unit_code || ''} ${row.property_name || ''}`).includes(q) || rowMatchesText({ tenant_name: row.name }, q))
    .slice(0, 30)
    .map(row => ({
      tenant_id: row.id,
      tenant_name: row.name,
      unit: row.unit_code || row.unit_name || null,
      property: row.property_name || null,
      status: row.status || null,
      has_phone: Boolean(row.phone),
      sms_consent: Number(row.sms_consent || 0) === 1,
    }));
}

function publicPropertyCandidates(rows, query) {
  const q = normalizeText(query || '');
  return rows
    .filter(row => !q || normalizeText(`${row.name || ''} ${row.district || ''}`).includes(q) || tokensOverlap(q, `${row.name || ''} ${row.district || ''}`) > 0)
    .slice(0, 20)
    .map(row => ({
      property_id: row.id,
      property_name: row.name,
      district: row.district || null,
      units_count: row.units_count || 0,
    }));
}

function assistantContext(req, message, period) {
  const targetPeriod = periodFromMessage(message, period);
  const query = extractSearchQuery(message) || cleanEntityName(message);
  return {
    current_period: period,
    inferred_period: targetPeriod,
    inferred_range: timeRangeFromMessage(message, period, req),
    period_bounds: paymentPeriodBounds(req),
    payment_candidates: publicCandidates(scopedPaymentRows(req, targetPeriod)).slice(0, 30),
    tenant_candidates: publicTenantCandidates(scopedTenants(req), query),
    property_candidates: publicPropertyCandidates(scopedProperties(req), query),
    supported_read_tools: DATA_TOOLS,
    notes: [
      'Use ids only from candidates.',
      'For questions like "czy X zapłacił" use answer_from_data/payments with status payment_status, not mark_payment_paid.',
      'For "ile X zapłacił" use answer_from_data/payments with status tenant_payment_summary.',
      'For tenant counts by property/time use answer_from_data/tenants with status tenant_count.',
      'For yearly/all-time tax summaries use report_answer with query tax_summary.',
      'For property finance questions like "suma dochodów z Chrobrego za 2025" use report_answer with query property_finance_summary and property_name.',
    ],
  };
}

function localIntent(message) {
  const text = normalizeText(message);
  const period = periodFromMessage(message, null);
  const query = extractSearchQuery(message);
  const base = { query, period, confidence: 0.7 };
  if (/^(szukaj|wyszukaj|znajdz)\b/.test(text)) return { intent: 'search_global', ...base, confidence: 0.9 };
  if (/\b(sms|wiadomosc|przypomnienie|przypomnij)\b/.test(text)) return { intent: 'send_sms_reminder', tenant_name: extractTargetName(message), ...base, confidence: 0.84 };
  if (isPaymentStatusQuestion(message, text)) {
    const tenantName = extractPaymentSubject(message);
    return { intent: 'answer_from_data', tool: 'payments', status: 'payment_status', ...base, tenant_name: tenantName, query: tenantName, confidence: 0.9 };
  }
  if (isTenantPaymentSummaryQuestion(text)) {
    const tenantName = extractPaymentSubject(message);
    return { intent: 'answer_from_data', tool: 'payments', status: 'tenant_payment_summary', ...base, tenant_name: tenantName, query: tenantName, confidence: 0.88 };
  }
  if (/\bilu\b/.test(text) && /\bnajemcow\b/.test(text)) {
    const propertyName = extractPropertySubject(message);
    return { intent: 'answer_from_data', tool: 'tenants', status: 'tenant_count', ...base, query: propertyName, property_name: propertyName, confidence: 0.86 };
  }
  if (isTaxSummaryQuestion(text)) {
    return { intent: 'report_answer', ...base, query: 'tax_summary', year: yearFromMessage(message, period || todayLocalISO().slice(0, 7)), confidence: 0.88 };
  }
  if (isAnnualSummaryQuestion(text)) {
    return { intent: 'report_answer', ...base, query: 'annual_summary', year: yearFromMessage(message, period || todayLocalISO().slice(0, 7)), confidence: 0.88 };
  }
  if (isFinanceExplanationQuestion(text)) {
    return { intent: 'report_answer', ...base, query: 'finance_explanation', confidence: 0.86 };
  }
  if (includesAny(text, ['utworz zadania z audytu', 'dodaj zadania z audytu', 'zrob zadania z audytu', 'stworz zadania z audytu'])) {
    return { intent: 'create_task', ...base, query: 'audit_tasks', confidence: 0.86 };
  }
  if (includesAny(text, ['uzupelnij brakujace platnosci', 'uzupelnij brakujace wplywy', 'uzupelnij brakujace wpłaty', 'skopiuj brakujace wplywy', 'skopiuj brakujace platnosci'])) {
    return { intent: 'generate_payments', ...base, query: 'fill_missing_property_payments', property_name: extractPropertySubject(message), confidence: 0.88 };
  }
  if (isPropertyFinanceQuestion(text)) {
    const propertyName = extractPropertySubject(message);
    return { intent: 'report_answer', query: 'property_finance_summary', ...base, property_name: propertyName, confidence: 0.87 };
  }
  if (isPaymentVerb(text)) {
    return { intent: 'mark_payment_paid', tenant_name: extractTargetName(message), ...base, confidence: 0.84 };
  }
  if (/\b(podatek|podatku|ryczalt|ryczaltu)\b/.test(text)) return { intent: 'explain_tax', ...base, confidence: 0.84 };
  if (includesAny(text, ['dodaj zadanie', 'utworz zadanie', 'zadanie'])) {
    return { intent: 'create_task', title: extractTaskTitle(message), priority: text.includes('pilne') ? 'high' : 'med', ...base, confidence: 0.8 };
  }
  if (includesAny(text, ['dodaj koszt', 'wpisz koszt', 'zaksięguj koszt', 'zaksieguj koszt'])) {
    return { intent: 'add_expense', amount: extractAmount(message), category: extractExpenseCategory(message), description: message, ...base, confidence: 0.8 };
  }
  if (includesAny(text, ['wygeneruj platnosci', 'utworz harmonogram', 'generuj platnosci', 'harmonogram wplat'])) {
    return { intent: 'generate_payments', ...base, confidence: 0.82 };
  }
  if (includesAny(text, ['kto zalega', 'kto ma zaleglosci', 'nieoplacone platnosci', 'nieopłacone płatności'])) {
    return { intent: 'answer_from_data', tool: 'payments', status: 'overdue', ...base, query: null, confidence: 0.86 };
  }
  if (includesAny(text, ['pokaz tylko zaleglosci', 'zalegle platnosci', 'zaleglosci'])) return { intent: 'filter_payments', status: 'overdue', ...base, confidence: 0.85 };
  if (includesAny(text, ['platnosci czesciowe', 'czesciowe platnosci'])) return { intent: 'filter_payments', status: 'partial', ...base, confidence: 0.85 };
  if (includesAny(text, ['platnosci']) && query) return { intent: 'filter_payments', ...base, confidence: 0.78 };
  if (includesAny(text, ['najemcy bez zgody', 'bez zgody sms'])) return { intent: 'filter_tenants', status: 'missing_sms_consent', ...base, confidence: 0.85 };
  if (includesAny(text, ['najemcy bez telefonu', 'brak telefonu'])) return { intent: 'filter_tenants', status: 'missing_phone', ...base, confidence: 0.85 };
  if (includesAny(text, ['najemcy']) && query) return { intent: 'filter_tenants', ...base, confidence: 0.76 };
  if (includesAny(text, ['lokale bez aktywnej umowy', 'lokale bez umowy', 'wolne lokale'])) return { intent: 'filter_units', status: 'without_active_contract', ...base, confidence: 0.85 };
  if (includesAny(text, ['konczace sie umowy', 'kończące się umowy', 'umowy konczace'])) return { intent: 'filter_contracts', status: 'ending_soon', ...base, confidence: 0.85 };
  if (includesAny(text, ['otworz karte najemcy', 'otwórz kartę najemcy'])) return { intent: 'navigate_to_entity', entity_type: 'tenant', ...base, confidence: 0.82 };
  if (includesAny(text, ['pokaz koszty', 'koszty za'])) return { intent: 'filter_expenses', entity_type: 'expense', ...base, confidence: 0.8 };
  if (includesAny(text, ['zestawienie kar', 'raport kar', 'kary najemcow', 'kar najemcow', 'kary za opoznienie', 'kary za opóźnienie', 'najemcy z karami', 'nierozliczone kary'])) {
    return { intent: 'answer_from_data', tool: 'late_fees', status: text.includes('nierozliczone') ? 'unpaid' : null, ...base, query: null, confidence: 0.88 };
  }
  if (includesAny(text, ['ile zarobilem', 'ile zarobiłem', 'netto', 'przychod', 'przychód', 'dochod', 'dochód', 'porownaj', 'porównaj', 'najwiekszy koszt', 'największy koszt'])) {
    return { intent: 'report_answer', ...base, year: yearFromMessage(message, period || todayLocalISO().slice(0, 7)), confidence: 0.82 };
  }
  if (includesAny(text, ['sprawdz bledy', 'bledy w danych', 'kontrola danych', 'jakosc danych', 'audyt danych', 'sprawdz dane', 'kompletnosc danych', 'dane kompletne', 'czy dane sa kompletne', 'nietypowo wysokie koszty', 'brak harmonogramu'])) {
    return { intent: 'data_quality_check', ...base, confidence: 0.86 };
  }
  if (includesAny(text, ['sprawdz brak telefonu', 'sprawdz brak zgody', 'sprawdz bez telefonu', 'sprawdz bez zgody', 'sprawdz bez lokalu', 'sprawdz bez umowy'])) {
    return { intent: 'data_quality_check', ...base, confidence: 0.86 };
  }
  if (query) return { intent: 'search_global', ...base, confidence: 0.65 };
  return { intent: 'unsupported', confidence: 0.3 };
}

function extractSearchQuery(message) {
  let text = String(message || '').trim();
  text = text.replace(/^(poka[zż]|otw[oó]rz|przejd[zź] do|znajd[zź]|szukaj|wyszukaj|ile|jaki|kt[oó]ra)\s+/i, '');
  text = text.replace(/\b(płatności|platnosci|najemcy|najemc[eęa]|lokale|lokal|koszty|koszt|umowy|umowe|kart[eę]|raport|podatkowy|za|dla|do|tylko|poka[zż])\b/gi, ' ');
  text = text.replace(/\b(20\d{2}-\d{2}|20\d{2})\b/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

function extractTargetName(message) {
  const raw = String(message || '').trim();
  const beforeAction = raw.split(/\b(?:wy[sś]lij|wyslij|napisz|przypomnij|zap[łl]aci[łl]a?|op[łl]aci[łl]a?|wp[łl]aci[łl]a?|zap[łl]acone)\b/i)[0].trim();
  if (beforeAction) return beforeAction;
  const afterTo = raw.match(/\b(?:do|dla)\s+(.+)$/i);
  if (afterTo) {
    return afterTo[1].replace(/\b(?:z\s+)?przypomnieniem\b.*$/i, '').trim() || null;
  }
  return null;
}

function cleanEntityName(value) {
  return String(value || '')
    .replace(/[?!.:,;]+/g, ' ')
    .replace(/\b(czy|ile|ilu|podaj|mia[łl]em|sprawd[zź]|podsumuj|poka[zż]|status|dla|do|za|z|ze|na|w)\b/gi, ' ')
    .replace(/\b(ten|ta|to|tym|roku|rok|miesi[aą]cu|miesi[aą]c|poprzedni|zesz[łl]y|bie[zż][aą]cy|obecny|aktualny|od|pocz[aą]tku|danych|ca[łl]y|okres)\b/gi, ' ')
    .replace(/\b(20\d{2}-\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(stycz[eńn]|luty|marzec|kwiecien|kwiecie[nń]|maj|czerwiec|lipiec|sierpien|sierpie[nń]|wrzesien|wrzesie[nń]|pazdziernik|pa[zź]dziernik|listopad|grudzien|grudzie[nń])\b/gi, ' ')
    .replace(/\b(suma|sum[eę]|razem|dochod[oó]w?|przychod[oó]w?|wp[łl]yw[oó]w?|zap[łl]aci[łl]a?|zap[łl]acili|op[łl]aci[łl]a?|wp[łl]aci[łl]a?|wp[łl]acili|p[łl]atno[śs][ćc]|p[łl]atno[śs]ci|najemc[oó]w|najemcy|najemca|podatek|podatku)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPaymentSubject(message) {
  const raw = String(message || '').trim();
  const action = /\b(?:zap[łl]aci[łl]a?|zap[łl]acili|op[łl]aci[łl]a?|wp[łl]aci[łl]a?|wp[łl]acili)\b/i;
  const parts = raw.split(action);
  const before = cleanEntityName(parts[0] || '');
  const after = cleanEntityName(parts.slice(1).join(' ') || '');
  if (after && !includesAny(normalizeText(after), ['kwota', 'suma'])) return after;
  return before || after || extractTargetName(message);
}

function extractPropertySubject(message) {
  const raw = String(message || '').trim();
  const afterPreposition = raw.match(/\b(?:z|ze|na|przy|dla|w)\s+(.+?)(?:\s+\b(?:w|we|za|od)\b\s+(?:tym|zesz[łl]ym|poprzednim|20\d{2}|pocz[aą]tku)|[?.,;:]|$)/i);
  const candidate = afterPreposition ? afterPreposition[1] : raw;
  return cleanEntityName(candidate);
}

function isPaymentVerb(text) {
  return /\b(zaplacil|zaplacila|zaplacili|zaplacone|oplacil|oplacila|wplacil|wplacila|wplacili|wplata)\b/.test(text);
}

function isQuestionLike(message, text) {
  return String(message || '').includes('?')
    || /^(czy|ile|ilu|jaki|jaka|ktory|ktora|sprawdz|podsumuj|pokaz|pokaż|status)\b/.test(text)
    || includesAny(text, ['czy ', 'ile ', 'podsumuj', 'sprawdz czy']);
}

function isTaxSummaryQuestion(text) {
  return /\b(podatek|podatku|ryczalt|ryczaltu)\b/.test(text)
    && (includesAny(text, ['podsumuj', 'zaplacilem', 'w tym roku', 'ten rok', 'biezacy rok', 'zeszlym roku', 'poprzedni rok', 'poprzednim roku', 'od poczatku', 'caly okres', 'rocznie']) || /\b20\d{2}\b/.test(text));
}

function isAnnualSummaryQuestion(text) {
  return includesAny(text, ['podsumowanie roku', 'raport roczny', 'podsumowanie roczne', 'zrob podsumowanie', 'zrób podsumowanie'])
    && (/\b20\d{2}\b/.test(text) || includesAny(text, ['w tym roku', 'zeszlym roku', 'poprzedni rok']));
}

function isPropertyFinanceQuestion(text) {
  return /\b(dochod|dochodow|przychod|przychodow|wplywy|wpływy|utarg|netto|koszty|kosztow|podatku|podatek)\b/.test(text)
    && (/\b(z|ze|na|przy|dla)\b/.test(text) || /\b20\d{2}\b/.test(text) || includesAny(text, ['w tym roku', 'zeszlym roku', 'poprzedni rok', 'od poczatku']));
}

function isFinanceExplanationQuestion(text) {
  return includesAny(text, [
    'dlaczego wynik', 'czemu wynik', 'wyjasnij wynik', 'wyjasnij finanse',
    'dlaczego marza', 'czemu marza', 'marza spadla', 'marza wzrosla',
    'wynik spadl', 'wynik wzrosl', 'co najbardziej obciazylo', 'co obciazylo',
    'co wplynelo na wynik', 'skad taki wynik', 'dlaczego zarobilem',
  ]);
}

function isTenantPaymentSummaryQuestion(text) {
  return isPaymentVerb(text)
    && isQuestionLike('', text)
    && (/\b(ile|podsumuj)\b/.test(text) || includesAny(text, ['w tym roku', 'zeszlym roku', 'poprzedni rok', 'poprzednim roku', 'od poczatku']) || /\b20\d{2}\b/.test(text));
}

function isPaymentStatusQuestion(message, text) {
  return isPaymentVerb(text) && (String(message || '').includes('?') || /^(czy|sprawdz|status)\b/.test(text) || includesAny(text, ['sprawdz czy', 'czy ']));
}

function extractAmount(message) {
  const m = String(message || '').replace(',', '.').match(/\b(\d+(?:\.\d{1,2})?)\b/);
  return m ? Number(m[1]) : null;
}

function extractTaskTitle(message) {
  return String(message || '').replace(/^(dodaj|utw[oó]rz)?\s*zadanie[:\s-]*/i, '').trim() || null;
}

function extractExpenseCategory(message) {
  const text = normalizeText(message);
  if (text.includes('prad')) return 'prad';
  if (text.includes('internet')) return 'internet';
  if (text.includes('remont')) return 'remonty';
  if (text.includes('czynsz')) return 'czynsz';
  if (text.includes('kredyt')) return 'kredyt';
  if (text.includes('zarzadzanie')) return 'zarzadzanie';
  return 'inne';
}

async function classifyWithGroq(message, period, context) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ...localIntent(message), ai_used: false, ai_configured: false, warning: 'GROQ_API_KEY nie jest skonfigurowany - używam lokalnego rozpoznawania v1.' };

  const system = [
    'You classify Polish property-management commands into a strict JSON object.',
    `Allowed intents: ${INTENTS.join(', ')}.`,
    'Return only JSON. Do not invent ids. Use payment_id or tenant_id only from provided candidates.',
    'If tenant/payment is ambiguous or missing, return the intent with tenant_name if visible, but no invented id.',
    `For flexible read-only data questions use intent answer_from_data and one tool from: ${DATA_TOOLS.join(', ')}.`,
    'Read-only tool guide: payments for paid/pending/overdue/partial payment questions, payment_status questions, and tenant_payment_summary aggregations; tenants for tenant lists, missing data, and tenant_count questions by property/time; units for unit availability; contracts for agreements; expenses for cost lists and summaries; late_fees for penalties/kary/opóźnienia; finance for monthly revenue/net/tax; quality for data-quality audits; search for broad lookup.',
    'For navigation/search/filter/report commands, fill query, entity_type, status, period, year or property_name when visible.',
    'Use status payment_status for questions like "czy Hubert zapłacił za kwiecień?". Use status tenant_payment_summary for "ile Hubert zapłacił w tym roku/od początku?". Use status tenant_count for "ilu najemców miałem na Chrobrego w zeszłym roku?".',
    'Use query tax_summary for yearly, previous-year, explicit-year, or all-time tax summaries.',
    'Use query property_finance_summary with property_name for property revenue/income/net/cost/tax questions such as "podaj sumę dochodów z Chrobrego za 2025".',
    'For create_task/add_expense, fill title/description/amount/category/date only when visible.',
    'Schema includes: intent, tool, tenant_name, tenant_id, payment_id, query, entity_type, status, period, year, property_name, title, description, category, amount, date, priority, tone, filters, confidence.',
    'Never request direct SQL. All writes must be one of the explicit write intents and will require confirmation.',
  ].join('\n');
  const body = {
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ message, period, context }, null, 2) },
    ],
  };

  try {
    const response = await fetch(`${GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : `Groq HTTP ${response.status}`);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = ModelIntentSchema.parse(normalizeModelIntent(JSON.parse(content || '{}')));
    return { ...parsed, ai_used: true, ai_configured: true };
  } catch (err) {
    return { ...localIntent(message), ai_used: false, ai_configured: true, warning: `Groq niedostępny: ${err.message || 'błąd klasyfikacji'}` };
  }
}

function rowMatchesText(row, text) {
  const haystack = normalizeText(text);
  const tenant = normalizeText(row.tenant_name);
  if (!tenant) return false;
  if (haystack.includes(tenant)) return true;
  if (haystack.length >= 3 && tenant.includes(haystack)) return true;
  const ignored = new Set(['smoke', 'test', 'demo']);
  const parts = tenant.split(/\s+/).filter(part => part.length >= 3 && !ignored.has(part));
  return parts.some(part => haystack.includes(part));
}

function resolveRows(intent, message, rows) {
  let matches = rows;
  if (intent.payment_id) {
    matches = rows.filter(row => Number(row.payment_id) === Number(intent.payment_id));
    if (matches.length && !rowMatchesText(matches[0], intent.tenant_name || message)) return [];
  }
  else if (intent.tenant_id) matches = rows.filter(row => Number(row.tenant_id) === Number(intent.tenant_id));
  else if (intent.tenant_name) matches = rows.filter(row => rowMatchesText(row, intent.tenant_name));
  else matches = rows.filter(row => rowMatchesText(row, message));
  return matches;
}

function clarification(intent, message, rows) {
  return {
    ok: false,
    status: 'clarify',
    intent,
    title: 'Potrzebuję doprecyzowania',
    message,
    candidates: publicCandidates(rows),
    execute_required: false,
  };
}

function blocked(intent, message, reason, extra = {}) {
  return {
    ok: false,
    status: 'blocked',
    intent,
    title: 'Nie mogę wykonać tej komendy',
    message,
    reason,
    execute_required: false,
    ...extra,
  };
}

function taxResponse(req, period, ai) {
  const summary = monthlyFinanceSummary(db, period, req);
  const tax = summary.tax || {};
  return {
    ok: true,
    status: 'answer',
    intent: 'explain_tax',
    title: `Podatek za ${summary.period_label}`,
    message: `Podatek wynosi ${tax.podatek_suma || 0} zł.`,
    execute_required: false,
    ai,
    tax: {
      period,
      label: summary.period_label,
      base: tax.base || 0,
      rate: tax.rate || 0,
      podatek: tax.podatek || 0,
      podatek_koscielna: tax.podatek_koscielna || 0,
      podatek_suma: tax.podatek_suma || 0,
    },
  };
}

function paymentPreview(req, row, period, ai) {
  if (!row) return blocked('mark_payment_paid', 'Nie znalazłem płatności dla tej komendy.', 'payment_not_found');
  if (row.status === 'paid') {
    return blocked('mark_payment_paid', `${row.tenant_name || 'Najemca'} ma już oznaczoną płatność jako opłaconą.`, 'payment_already_paid', {
      payment: publicCandidates([row])[0],
      ai,
    });
  }
  const action = { type: 'mark_payment_paid', payment_id: row.payment_id, period, paid_date: todayLocalISO() };
  return {
    ok: true,
    status: 'ready',
    intent: 'mark_payment_paid',
    title: 'Oznaczyć płatność jako opłaconą?',
    message: `${row.tenant_name || 'Najemca'} - ${amount(row)} zł za ${period}.`,
    execute_required: true,
    ai,
    payment: publicCandidates([row])[0],
    action: {
      ...action,
      token: actionToken(req, action),
      label: 'Oznacz jako opłacone',
    },
  };
}

function smsPreview(req, row, period, ai) {
  if (!row) return blocked('send_sms_reminder', 'Nie znalazłem płatności dla tej komendy.', 'payment_not_found');
  const preview = previewPaymentReminder(req, row.payment_id);
  if (!preview.ok) {
    return blocked('send_sms_reminder', smsErrorMessage(preview.error), preview.error, {
      payment: publicCandidates([row])[0],
      preview,
      ai,
    });
  }
  const action = { type: 'send_sms_reminder', payment_id: row.payment_id, period };
  return {
    ok: true,
    status: 'ready',
    intent: 'send_sms_reminder',
    title: 'Wysłać SMS z przypomnieniem?',
    message: `${preview.tenant} - ${preview.message}`,
    execute_required: true,
    ai,
    payment: publicCandidates([row])[0],
    preview,
    action: {
      ...action,
      token: actionToken(req, action),
      label: 'Wyślij SMS',
    },
  };
}

function smsErrorMessage(error) {
  return ({
    payment_already_paid: 'Ta płatność jest już oznaczona jako opłacona.',
    sms_consent_required: 'Najemca nie ma aktywnej zgody na SMS.',
    sms_disabled: 'Powiadomienia SMS dla tego najemcy są wyłączone.',
    invalid_phone: 'Najemca nie ma poprawnego numeru telefonu.',
    test_phone_required: 'Tryb testowy SMS wymaga numeru testowego w ustawieniach.',
  })[error] || 'SMS nie może zostać przygotowany.';
}

function navigationResult(intent, title, message, navigation, extra = {}) {
  return {
    ok: true,
    status: 'navigate',
    intent,
    title,
    message,
    execute_required: false,
    navigation,
    ...extra,
  };
}

function resultList(intent, title, message, items, navigation = null, extra = {}) {
  return {
    ok: true,
    status: 'results',
    intent,
    title,
    message,
    execute_required: false,
    items,
    navigation,
    ...extra,
  };
}

function scopedTenants(req) {
  const scope = scopeCondition(req, { tenant: 't', property: 'p' });
  return db.prepare(`
    SELECT t.*, u.name AS unit_name, u.code AS unit_code, p.name AS property_name
    FROM tenants t
    LEFT JOIN units u ON u.id = t.current_unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE 1=1 ${scope.sql}
    ORDER BY t.status, t.name
  `).all(...scope.params);
}

function scopedProperties(req) {
  const scope = scopeCondition(req, { property: 'p' });
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS units_count
    FROM properties p
    WHERE 1=1 ${scope.sql}
    ORDER BY p.name
  `).all(...scope.params);
}

function scopedUnits(req) {
  const scope = scopeCondition(req, { property: 'p' });
  return db.prepare(`
    SELECT u.*, p.name AS property_name,
      (SELECT COUNT(*) FROM contracts c WHERE c.unit_id = u.id AND c.status = 'active') AS active_contracts,
      (SELECT t.name FROM tenants t WHERE t.current_unit_id = u.id AND t.status = 'active' LIMIT 1) AS tenant_name
    FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE 1=1 ${scope.sql}
    ORDER BY p.name, u.code
  `).all(...scope.params);
}

function scopedContracts(req) {
  const scope = scopeCondition(req, { tenant: 't', property: 'p' });
  return db.prepare(`
    SELECT c.*, t.name AS tenant_name, u.code AS unit_code, u.name AS unit_name, p.name AS property_name
    FROM contracts c
    JOIN tenants t ON t.id = c.tenant_id
    JOIN units u ON u.id = c.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE 1=1 ${scope.sql}
    ORDER BY c.status, COALESCE(c.end_date, '9999-12-31'), t.name
  `).all(...scope.params);
}

function scopedExpenses(req, period) {
  return db.prepare(`
    SELECT e.*, COALESCE(e.property_id, up.id) AS resolved_property_id,
           COALESCE(p.name, up.name) AS property_name, u.code AS unit_code, u.name AS unit_name
    FROM expenses e
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN units u ON u.id = e.unit_id
    LEFT JOIN properties up ON up.id = u.property_id
    WHERE strftime('%Y-%m', e.date) = ?
      ${req.user && req.user.id && req.user.role !== 'admin' ? 'AND (e.owner_user_id = ? OR p.owner_user_id = ? OR up.owner_user_id = ?)' : ''}
    ORDER BY e.amount DESC, e.date DESC
  `).all(period, ...(req.user && req.user.id && req.user.role !== 'admin' ? [req.user.id, req.user.id, req.user.id] : []));
}

function scopedLateFeeRows(req, period) {
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const params = [];
  const where = ['COALESCE(pm.late_fee_amount, 0) > 0'];
  if (period) {
    where.push('pm.period = ?');
    params.push(period);
  }
  if (scoped) {
    where.push('(pm.owner_user_id = ? OR t.owner_user_id = ? OR pr.owner_user_id = ?)');
    params.push(req.user.id, req.user.id, req.user.id);
  }
  return db.prepare(`
    SELECT
      t.id AS tenant_id,
      COALESCE(t.name, 'Bez najemcy') AS tenant_name,
      u.code AS unit_code,
      pr.name AS property_name,
      COUNT(pm.id) AS count,
      COALESCE(SUM(COALESCE(pm.late_fee_amount, 0)), 0) AS total,
      COALESCE(SUM(COALESCE(pm.late_fee_paid, 0)), 0) AS paid,
      COALESCE(SUM(MAX(COALESCE(pm.late_fee_amount, 0) - COALESCE(pm.late_fee_paid, 0), 0)), 0) AS balance,
      GROUP_CONCAT(pm.period, ', ') AS periods
    FROM payments pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    LEFT JOIN units u ON u.id = pm.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE ${where.join(' AND ')}
    GROUP BY t.id, t.name, u.code, pr.name
    ORDER BY balance DESC, total DESC, tenant_name
  `).all(...params);
}

function itemTenant(row, subtitle) {
  return { type: 'tenant', id: row.tenant_id || row.id, title: row.tenant_name || row.name || 'Najemca', subtitle, view: 'najemcy' };
}

function paidValue(row) {
  const expected = amount(row);
  if (row.status === 'paid') return Number(row.total_paid || 0) > 0 ? Number(row.total_paid || 0) : expected;
  if (row.status === 'partial') return Number(row.total_paid || 0);
  return Math.max(0, Number(row.total_paid || 0));
}

function matchTenants(req, name) {
  const q = normalizeText(name || '');
  if (!q) return [];
  return scopedTenants(req).filter(row => rowMatchesText({ tenant_name: row.name }, q) || normalizeText(`${row.name || ''} ${row.unit_code || ''} ${row.property_name || ''}`).includes(q));
}

function matchProperties(req, name) {
  const q = normalizeText(name || '');
  if (!q) return [];
  const scored = scopedProperties(req).map(row => {
    const propertyText = normalizeText(`${row.name || ''} ${row.district || ''}`);
    const exactScore = propertyText.includes(q) || q.includes(normalizeText(row.name || '')) ? 10 : 0;
    return { row, score: exactScore + tokensOverlap(q, propertyText) };
  })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name), 'pl'));
  if (!scored.length) return [];
  const best = scored[0].score;
  return scored.filter(item => item.score === best).map(item => item.row);
}

function paymentStatusAnswer(req, model, message, period) {
  const targetPeriod = model.period || periodFromMessage(message, period);
  const name = model.tenant_name || model.query || extractPaymentSubject(message);
  const rows = scopedPaymentRows(req, targetPeriod).filter(row => rowMatchesText(row, name || message));
  const tenantIds = new Set(rows.map(row => row.tenant_id).filter(Boolean));
  if (!rows.length) {
    return resultList('answer_from_data', `Status płatności ${periodLabel(targetPeriod)}`, `Nie znalazłem płatności dla: ${name || message}.`, [], { view: 'platnosci', state: { paymentsQ: name || '', period: targetPeriod } }, { status: 'answer', report: { count: 0, period: targetPeriod } });
  }
  if (rows.length > 1 || tenantIds.size > 1) {
    return resultList('answer_from_data', 'Doprecyzuj płatność', 'Znalazłem więcej niż jedną pasującą płatność.', rows.slice(0, 10).map(row => ({ type: 'payment', id: row.payment_id, title: row.tenant_name || 'Płatność', subtitle: `${row.unit_code || ''} · ${periodLabel(row.period)} · ${row.status} · ${Math.round(amount(row))} zł`, view: 'platnosci' })), { view: 'platnosci', state: { paymentsQ: name || '', period: targetPeriod } }, { status: 'results', report: { count: rows.length, period: targetPeriod } });
  }
  const row = rows[0];
  const statusLabel = STATUS_CHIP_LABELS[row.status] || row.status || 'brak statusu';
  const paid = paidValue(row);
  const yesNo = row.status === 'paid' ? 'Tak' : (row.status === 'partial' || paid > 0 ? 'Częściowo' : 'Nie');
  return {
    ok: true,
    status: 'answer',
    intent: 'answer_from_data',
    title: `Status płatności ${periodLabel(targetPeriod)}`,
    message: `${yesNo}. ${row.tenant_name || 'Najemca'} ma status: ${statusLabel}; lokal ${row.unit_code || 'brak lokalu'}; kwota ${Math.round(amount(row))} zł${paid ? `, odnotowano ${Math.round(paid)} zł` : ''}.`,
    execute_required: false,
    payment: publicCandidates([row])[0],
    report: { period: targetPeriod, status: row.status, expected: amount(row), paid },
  };
}

const STATUS_CHIP_LABELS = {
  paid: 'opłacona',
  pending: 'oczekuje',
  overdue: 'zaległa',
  partial: 'częściowa',
};

function tenantPaymentSummary(req, model, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const name = model.tenant_name || model.query || extractPaymentSubject(message);
  const tenants = matchTenants(req, name);
  if (!tenants.length) {
    return resultList('answer_from_data', 'Wpłaty najemcy', `Nie znalazłem najemcy: ${name || message}.`, [], { view: 'najemcy', state: { tenantsQ: name || '' } }, { status: 'answer', report: { count: 0, range } });
  }
  if (tenants.length > 1) {
    return resultList('answer_from_data', 'Doprecyzuj najemcę', 'Znalazłem więcej niż jednego pasującego najemcę.', tenants.slice(0, 10).map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || 'bez lokalu'} · ${t.property_name || ''}`, view: 'najemcy' })), { view: 'najemcy', state: { tenantsQ: name || '' } }, { status: 'results', report: { count: tenants.length, range } });
  }
  const tenant = tenants[0];
  const rows = range.periods.flatMap(p => scopedPaymentRows(req, p).filter(row => Number(row.tenant_id) === Number(tenant.id)));
  const expected = rows.reduce((sum, row) => sum + amount(row), 0);
  const paid = rows.reduce((sum, row) => sum + paidValue(row), 0);
  const lateFeePaid = rows.reduce((sum, row) => sum + Number(row.late_fee_paid || 0), 0);
  const paidCount = rows.filter(row => row.status === 'paid').length;
  const partialCount = rows.filter(row => row.status === 'partial').length;
  const balance = Math.max(0, expected - paid);
  const label = range.mode === 'all' ? range.label : range.label;
  return resultList(
    'answer_from_data',
    `Wpłaty: ${tenant.name}`,
    `${tenant.name} zapłacił ${Math.round(paid)} zł za ${label}. Oczekiwano ${Math.round(expected)} zł, saldo ${Math.round(balance)} zł${lateFeePaid ? `, kary zapłacone ${Math.round(lateFeePaid)} zł` : ''}.`,
    rows.slice(0, 24).map(row => ({ type: 'payment', id: row.payment_id, title: `${periodLabel(row.period)} · ${row.tenant_name}`, subtitle: `${row.unit_code || ''} · ${STATUS_CHIP_LABELS[row.status] || row.status} · wpłacono ${Math.round(paidValue(row))}/${Math.round(amount(row))} zł`, view: 'platnosci' })),
    { view: 'platnosci', state: { paymentsQ: tenant.name, period: range.end || period } },
    { status: 'answer', report: { tenant_id: tenant.id, tenant_name: tenant.name, range, count: rows.length, paid_count: paidCount, partial_count: partialCount, expected, paid, balance, late_fee_paid: lateFeePaid } }
  );
}

function tenantCountAnswer(req, model, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const propertyQuery = model.property_name || model.query || extractSearchQuery(message) || cleanEntityName(message);
  const properties = matchProperties(req, propertyQuery);
  if (!properties.length) {
    return resultList('answer_from_data', 'Liczba najemców', `Nie znalazłem nieruchomości pasującej do: ${propertyQuery || message}.`, publicPropertyCandidates(scopedProperties(req), '').map(p => ({ type: 'property', id: p.property_id, title: p.property_name, subtitle: `${p.district || ''} · ${p.units_count} lokali`, view: 'nieruchomosci' })), { view: 'nieruchomosci' }, { status: 'answer', report: { count: 0, range } });
  }
  const propertyIds = properties.map(p => Number(p.id));
  const placeholders = propertyIds.map(() => '?').join(',');
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const uid = ownerId(req);
  const dateRange = dateRangeForPeriods(range.start, range.end);
  const paymentRows = db.prepare(`
    SELECT DISTINCT t.id, t.name, u.code AS unit_code, p.name AS property_name
    FROM payments pm
    JOIN tenants t ON t.id = pm.tenant_id
    JOIN units u ON u.id = pm.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE p.id IN (${placeholders})
      AND pm.period BETWEEN ? AND ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR t.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
  `).all(...propertyIds, range.start, range.end, ...(scoped ? [uid, uid, uid] : []));
  const contractRows = db.prepare(`
    SELECT DISTINCT t.id, t.name, u.code AS unit_code, p.name AS property_name
    FROM contracts c
    JOIN tenants t ON t.id = c.tenant_id
    JOIN units u ON u.id = c.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE p.id IN (${placeholders})
      AND COALESCE(c.start_date, '1900-01-01') <= ?
      AND COALESCE(c.end_date, '9999-12-31') >= ?
      ${scoped ? 'AND (t.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
  `).all(...propertyIds, dateRange.end, dateRange.start, ...(scoped ? [uid, uid] : []));
  const byTenant = new Map();
  for (const row of [...paymentRows, ...contractRows]) if (row.id) byTenant.set(Number(row.id), row);
  const tenants = [...byTenant.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl'));
  const propLabel = properties.map(p => p.name).join(', ');
  return resultList(
    'answer_from_data',
    `Najemcy: ${propLabel}`,
    `Na ${propLabel} w okresie ${range.label} było ${tenants.length} unikalnych najemców.`,
    tenants.slice(0, 30).map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || 'bez lokalu'} · ${t.property_name || ''}`, view: 'najemcy' })),
    { view: 'najemcy', state: { tenantsQ: propLabel, tenantsStatus: 'active' } },
    { status: 'answer', report: { property_ids: propertyIds, property_name: propLabel, range, count: tenants.length } }
  );
}

function rangeForYear(year) {
  const start = `${year}-01`;
  const end = `${year}-12`;
  return { mode: 'year', year, start, end, label: `${year}`, periods: periodsBetween(start, end), source: 'rule' };
}

function previousComparableRange(range) {
  if (range && range.mode === 'year' && range.year) return rangeForYear(Number(range.year) - 1);
  const count = Math.max(1, (range.periods || []).length);
  const end = shiftPeriodValue(range.start || range.period || todayLocalISO().slice(0, 7), -1);
  const start = shiftPeriodValue(end, -(count - 1));
  return {
    mode: 'previous',
    start,
    end,
    label: start === end ? periodLabel(start) : `${periodLabel(start)} - ${periodLabel(end)}`,
    periods: periodsBetween(start, end),
    source: 'rule',
  };
}

function summarizeFinanceRange(req, range) {
  const months = (range.periods || []).map(p => {
    const summary = monthlyFinanceSummary(db, p, req);
    return {
      period: p,
      revenue: Number(summary.revenue.gross || 0),
      expected: Number(summary.revenue.expected || 0),
      expenses: Number(summary.expenses.total || 0),
      tax: Number(summary.tax.podatek_suma || 0),
      net: Number(summary.net_for_owner || 0),
      categories: summary.costs_by_category || [],
    };
  });
  const totals = months.reduce((acc, row) => {
    acc.revenue += row.revenue;
    acc.expected += row.expected;
    acc.expenses += row.expenses;
    acc.tax += row.tax;
    acc.net += row.net;
    for (const cat of row.categories) {
      const key = cat.category || 'inne';
      acc.expense_categories[key] = (acc.expense_categories[key] || 0) + Number(cat.total || 0);
    }
    return acc;
  }, { revenue: 0, expected: 0, expenses: 0, tax: 0, net: 0, expense_categories: {} });
  totals.margin = totals.revenue ? totals.net / totals.revenue : 0;
  return { range, months, totals };
}

function financeExplanationAnswer(req, message, period) {
  const years = [...new Set((String(message || '').match(/\b20\d{2}\b/g) || []).map(Number))];
  const currentRange = years.length >= 2 ? rangeForYear(years[0]) : timeRangeFromMessage(message, period, req);
  const previousRange = years.length >= 2 ? rangeForYear(years[1]) : previousComparableRange(currentRange);
  const current = summarizeFinanceRange(req, currentRange);
  const previous = summarizeFinanceRange(req, previousRange);
  const cur = current.totals;
  const prev = previous.totals;
  const delta = {
    revenue: cur.revenue - prev.revenue,
    expenses: cur.expenses - prev.expenses,
    tax: cur.tax - prev.tax,
    net: cur.net - prev.net,
    margin: cur.margin - prev.margin,
  };
  const drivers = [
    { key: 'revenue', label: 'wpłaty', impact: delta.revenue, raw: delta.revenue },
    { key: 'expenses', label: 'koszty', impact: -delta.expenses, raw: delta.expenses },
    { key: 'tax', label: 'podatek', impact: -delta.tax, raw: delta.tax },
  ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const topCategories = Object.entries(cur.expense_categories)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  const direction = delta.net >= 0 ? 'lepszy' : 'gorszy';
  const driverText = drivers
    .map(d => `${d.label}: ${d.impact >= 0 ? '+' : '-'}${Math.round(Math.abs(d.impact))} zł wpływu na netto`)
    .join(', ');
  const categoryText = topCategories.length
    ? ` Największe kategorie kosztów w analizowanym okresie: ${topCategories.map(c => `${c.category} ${Math.round(c.total)} zł`).join(', ')}.`
    : '';
  return resultList(
    'report_answer',
    `Wyjaśnienie wyniku ${currentRange.label}`,
    `Wynik netto za ${currentRange.label} to ${Math.round(cur.net)} zł, a dla porównania ${previousRange.label}: ${Math.round(prev.net)} zł. Jest ${direction} o ${Math.round(Math.abs(delta.net))} zł. Główne czynniki: ${driverText}.${categoryText} Marża: ${Math.round(cur.margin * 1000) / 10}% vs ${Math.round(prev.margin * 1000) / 10}%.`,
    drivers.map(d => ({
      type: 'report',
      title: d.label,
      subtitle: `zmiana ${Math.round(d.raw)} zł · wpływ na netto ${Math.round(d.impact)} zł`,
      view: 'raporty',
    })),
    { view: 'raporty', state: { period: currentRange.end || period } },
    { status: 'answer', report: { current: cur, previous: prev, delta, current_range: currentRange, previous_range: previousRange, top_expense_categories: topCategories } }
  );
}

function annualSummaryAnswer(req, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const current = summarizeFinanceRange(req, range);
  const previous = summarizeFinanceRange(req, previousComparableRange(range));
  const cur = current.totals;
  const prev = previous.totals;
  const deltaNet = cur.net - prev.net;
  const margin = cur.revenue ? cur.net / cur.revenue : 0;
  const topCategories = Object.entries(cur.expense_categories)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);
  const properties = scopedProperties(req).map(property => {
    let revenue = 0, expenses = 0, tax = 0, net = 0;
    for (const p of range.periods || []) {
      const summary = monthlyFinanceSummary(db, p, req);
      const row = (summary.properties || []).find(x => Number(x.id) === Number(property.id));
      if (!row) continue;
      revenue += Number(row.revenue || 0);
      expenses += Number(row.expenses || 0);
      tax += Number(row.tax || 0);
      net += Number(row.net || 0);
    }
    return { property, revenue, expenses, tax, net };
  }).sort((a, b) => b.net - a.net);
  const best = properties[0];
  const worst = properties[properties.length - 1];
  const audit = dataQualityReport(req, `sprawdź czy dane są kompletne za ${range.label}`, range.end || period);
  const auditTop = (audit.checks || []).filter(c => c.count).slice(0, 3);
  const messageParts = [
    `Podsumowanie ${range.label}: wpłaty ${Math.round(cur.revenue)} zł, koszty ${Math.round(cur.expenses)} zł, podatek ${Math.round(cur.tax)} zł, netto ${Math.round(cur.net)} zł, marża ${Math.round(margin * 1000) / 10}%.`,
    `Vs ${previous.range.label}: ${deltaNet >= 0 ? '+' : '-'}${Math.round(Math.abs(deltaNet))} zł netto.`,
  ];
  if (best) messageParts.push(`Najlepsza nieruchomość: ${best.property.name} (${Math.round(best.net)} zł netto).`);
  if (worst && best && worst.property.id !== best.property.id) messageParts.push(`Najsłabsza: ${worst.property.name} (${Math.round(worst.net)} zł netto).`);
  if (auditTop.length) messageParts.push(`Do sprawdzenia: ${auditTop.map(c => `${c.label}: ${c.count}`).join(', ')}.`);
  return resultList(
    'report_answer',
    `Podsumowanie ${range.label}`,
    messageParts.join(' '),
    [
      ...properties.slice(0, 4).map(row => ({ type: 'property', id: row.property.id, title: row.property.name, subtitle: `wpłaty ${Math.round(row.revenue)} zł · koszty ${Math.round(row.expenses)} zł · netto ${Math.round(row.net)} zł`, view: 'raporty' })),
      ...topCategories.map(row => ({ type: 'expense', title: costCategoryLabel(row.category), subtitle: `${Math.round(row.total)} zł kosztów`, view: 'koszty' })),
    ],
    { view: 'raporty', state: { period: range.end || period } },
    { status: 'answer', report: { range, totals: cur, previous: prev, delta_net: deltaNet, margin, properties, top_expense_categories: topCategories, audit: { issue_count: audit.report.issue_count, checks: auditTop } } }
  );
}

function taxSummaryAnswer(req, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const months = range.periods || [];
  const rows = months.map(p => {
    const s = monthlyFinanceSummary(db, p, req);
    return { period: p, tax: s.tax.podatek_suma || 0, base: s.tax.base || 0, rent_paid: s.revenue.rent_paid || 0 };
  });
  const taxTotal = rows.reduce((sum, row) => sum + Number(row.tax || 0), 0);
  const baseTotal = rows.reduce((sum, row) => sum + Number(row.base || 0), 0);
  const monthsWithTax = rows.filter(row => Number(row.tax || 0) > 0).length;
  return resultList(
    'report_answer',
    `Podatek ${range.label}`,
    `Wyliczony podatek za ${range.label}: ${Math.round(taxTotal)} zł. Podstawa opodatkowania: ${Math.round(baseTotal)} zł, miesięcy z podatkiem: ${monthsWithTax}.`,
    rows.filter(row => Number(row.tax || 0) > 0).slice(-24).map(row => ({ type: 'report', title: periodLabel(row.period), subtitle: `podatek ${Math.round(row.tax)} zł · podstawa ${Math.round(row.base)} zł`, view: 'raporty' })),
    { view: 'raporty', state: { period: range.end || period } },
    { status: 'answer', report: { range, tax_total: taxTotal, tax_base: baseTotal, months: rows } }
  );
}

function propertyFinanceAnswer(req, model, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const propertyQuery = model.property_name || extractPropertySubject(message) || model.query || '';
  const properties = matchProperties(req, propertyQuery);
  if (!properties.length) {
    return resultList('report_answer', 'Finanse nieruchomości', `Nie znalazłem nieruchomości pasującej do: ${propertyQuery || message}.`, publicPropertyCandidates(scopedProperties(req), '').map(p => ({ type: 'property', id: p.property_id, title: p.property_name, subtitle: `${p.district || ''} · ${p.units_count} lokali`, view: 'nieruchomosci' })), { view: 'nieruchomosci' }, { status: 'answer', report: { count: 0, range } });
  }
  const ids = new Set(properties.map(p => Number(p.id)));
  const rows = [];
  for (const p of range.periods) {
    const summary = monthlyFinanceSummary(db, p, req);
    const matched = (summary.properties || []).filter(property => ids.has(Number(property.id)));
    const revenue = matched.reduce((sum, property) => sum + Number(property.revenue || 0), 0);
    const expected = matched.reduce((sum, property) => sum + Number(property.expected_revenue || 0), 0);
    const expenses = matched.reduce((sum, property) => sum + Number(property.expenses || 0), 0);
    const tax = matched.reduce((sum, property) => sum + Number(property.tax || 0), 0);
    const net = matched.reduce((sum, property) => sum + Number(property.net || 0), 0);
    if (revenue || expected || expenses || tax || net) rows.push({ period: p, revenue, expected, expenses, tax, net });
  }
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  const expected = rows.reduce((sum, row) => sum + row.expected, 0);
  const expenses = rows.reduce((sum, row) => sum + row.expenses, 0);
  const tax = rows.reduce((sum, row) => sum + row.tax, 0);
  const net = rows.reduce((sum, row) => sum + row.net, 0);
  const label = properties.map(p => p.name).join(', ');
  const text = normalizeText(message);
  const primary = text.includes('netto') ? net : text.includes('koszt') ? expenses : text.includes('podatek') ? tax : total;
  const primaryLabel = text.includes('netto') ? 'netto' : text.includes('koszt') ? 'koszty' : text.includes('podatek') ? 'podatek' : 'dochód/przychód z wpłat';
  return resultList(
    'report_answer',
    `${primaryLabel[0].toUpperCase()}${primaryLabel.slice(1)}: ${label}`,
    `${primaryLabel[0].toUpperCase()}${primaryLabel.slice(1)} za ${range.label}: ${Math.round(primary)} zł. Wpłaty/przychód: ${Math.round(total)} zł, oczekiwano ${Math.round(expected)} zł, koszty ${Math.round(expenses)} zł, podatek ${Math.round(tax)} zł, netto ${Math.round(net)} zł.`,
    rows.slice(-24).map(row => ({ type: 'report', title: periodLabel(row.period), subtitle: `wpłaty ${Math.round(row.revenue)} zł · koszty ${Math.round(row.expenses)} zł · podatek ${Math.round(row.tax)} zł · netto ${Math.round(row.net)} zł`, view: 'raporty' })),
    { view: 'raporty', state: { period: range.end || period } },
    { status: 'answer', report: { property_ids: [...ids], property_name: label, range, revenue: total, expected, expenses, tax, net, months: rows } }
  );
}

function answerFromDataTool(req, model, message, period) {
  const tool = model.tool || 'search';
  const targetPeriod = model.period || periodFromMessage(message, period);
  const query = model.query || extractSearchQuery(message) || '';
  const status = model.status || null;
  if (tool === 'search') return searchGlobal(req, query || message, targetPeriod);
  if (tool === 'quality') return dataQualityReport(req, message, targetPeriod);
  if (tool === 'finance') return reportAnswer(req, model, message, targetPeriod);
  if (tool === 'late_fees') {
    const explicitPeriod = model.period || periodFromMessage(message, null);
    const allRows = scopedLateFeeRows(req, explicitPeriod);
    const rows = status === 'unpaid' ? allRows.filter(row => Number(row.balance || 0) > 0) : allRows;
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const paid = rows.reduce((sum, row) => sum + Number(row.paid || 0), 0);
    const balance = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
    const suffix = explicitPeriod ? ` za ${periodLabel(explicitPeriod)}` : '';
    return resultList(
      'answer_from_data',
      `${status === 'unpaid' ? 'Nierozliczone kary najemców' : 'Zestawienie kar najemców'}${suffix}`,
      rows.length ? `Naliczono ${Math.round(total)} zł kar, zapłacono ${Math.round(paid)} zł, pozostało ${Math.round(balance)} zł.` : `Brak naliczonych kar${suffix}.`,
      rows.slice(0, 20).map(row => itemTenant(row, `${row.unit_code || 'bez lokalu'} · naliczono ${Math.round(row.total || 0)} zł · zapłacono ${Math.round(row.paid || 0)} zł · pozostało ${Math.round(row.balance || 0)} zł · ${row.periods || ''}`)),
      null,
      { status: 'answer', report: { total, paid, balance, count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0), period: explicitPeriod || null } }
    );
  }
  if (tool === 'payments') {
    if (status === 'payment_status') return paymentStatusAnswer(req, model, message, targetPeriod);
    if (status === 'tenant_payment_summary') return tenantPaymentSummary(req, model, message, targetPeriod);
    const paymentQuery = status === 'overdue' ? '' : query;
    const payments = scopedPaymentRows(req, targetPeriod).filter(row => {
      const computedOverdue = row.status !== 'paid' && row.due_date && row.due_date < todayLocalISO();
      if (status === 'overdue' && row.status !== 'overdue' && !computedOverdue) return false;
      if (status && status !== 'overdue' && ['paid','pending','partial'].includes(status) && row.status !== status) return false;
      return !paymentQuery || rowMatchesText(row, paymentQuery) || normalizeText(`${row.unit_code || ''} ${row.property_name || ''} ${row.status || ''}`).includes(normalizeText(paymentQuery));
    });
    const total = payments.reduce((sum, row) => sum + amount(row), 0);
    return resultList(
      'answer_from_data',
      `Płatności ${periodLabel(targetPeriod)}`,
      `Znalazłem ${payments.length} płatności na ${Math.round(total)} zł.`,
      payments.slice(0, 20).map(row => ({ type: 'payment', id: row.payment_id, title: row.tenant_name || 'Płatność', subtitle: `${row.unit_code || ''} · ${row.status || ''} · ${Math.round(amount(row))} zł`, view: 'platnosci' })),
      { view: 'platnosci', state: { paymentsQ: query, paymentsFilter: ['paid','pending','overdue','partial'].includes(status) ? status : 'all', period: targetPeriod } },
      { status: 'answer', report: { count: payments.length, total, period: targetPeriod } }
    );
  }
  if (tool === 'tenants') {
    if (status === 'tenant_count') return tenantCountAnswer(req, model, message, targetPeriod);
    const lateTenantIds = new Set(scopedLateFeeRows(req, null).filter(row => status !== 'unpaid' || Number(row.balance || 0) > 0).map(row => Number(row.tenant_id)));
    const tenants = scopedTenants(req).filter(t => {
      if (status === 'missing_phone' && String(t.phone || '').trim()) return false;
      if (status === 'missing_sms_consent' && Number(t.sms_consent || 0) === 1) return false;
      if (status === 'without_unit' && t.current_unit_id) return false;
      if (status === 'with_late_fees' && !lateTenantIds.has(Number(t.id))) return false;
      return !query || normalizeText(`${t.name || ''} ${t.unit_code || ''} ${t.property_name || ''}`).includes(normalizeText(query));
    });
    return resultList(
      'answer_from_data',
      'Najemcy',
      `Znalazłem ${tenants.length} najemców.`,
      tenants.slice(0, 20).map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || 'bez lokalu'} · ${t.property_name || ''} · SMS ${Number(t.sms_consent || 0) === 1 ? 'zgoda' : 'brak zgody'}`, view: 'najemcy' })),
      { view: 'najemcy', state: { tenantsQ: query, tenantsStatus: 'active' } },
      { status: 'answer', report: { count: tenants.length } }
    );
  }
  if (tool === 'units') {
    const units = scopedUnits(req).filter(u => {
      if (status === 'without_active_contract' && Number(u.active_contracts || 0) > 0) return false;
      return !query || normalizeText(`${u.code || ''} ${u.name || ''} ${u.property_name || ''} ${u.tenant_name || ''}`).includes(normalizeText(query));
    });
    return resultList('answer_from_data', 'Lokale', `Znalazłem ${units.length} lokali.`, units.slice(0, 20).map(u => ({ type: 'unit', id: u.id, title: u.code || u.name, subtitle: `${u.property_name || ''} · ${u.tenant_name || 'brak najemcy'}`, view: 'nieruchomosci' })), { view: 'nieruchomosci' }, { status: 'answer', report: { count: units.length } });
  }
  if (tool === 'contracts') {
    const contracts = scopedContracts(req).filter(c => !query || normalizeText(`${c.tenant_name || ''} ${c.unit_code || ''} ${c.property_name || ''}`).includes(normalizeText(query)));
    return resultList('answer_from_data', 'Umowy', `Znalazłem ${contracts.length} umów.`, contracts.slice(0, 20).map(c => ({ type: 'contract', id: c.id, title: c.tenant_name, subtitle: `${c.unit_code || ''} · ${c.status || ''} · ${c.end_date || 'bez daty końca'}`, view: 'umowy' })), { view: 'umowy' }, { status: 'answer', report: { count: contracts.length } });
  }
  if (tool === 'expenses') {
    const expenses = scopedExpenses(req, targetPeriod).filter(e => !query || normalizeText(`${e.description || ''} ${e.category || ''} ${e.property_name || ''} ${e.unit_code || ''}`).includes(normalizeText(query)));
    const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    return resultList('answer_from_data', `Koszty ${periodLabel(targetPeriod)}`, `Znalazłem ${expenses.length} kosztów na ${Math.round(total)} zł.`, expenses.slice(0, 20).map(e => ({ type: 'expense', id: e.id, title: e.description || e.category, subtitle: `${Math.round(e.amount || 0)} zł · ${e.property_name || ''} · ${e.date}`, view: 'koszty' })), { view: 'koszty', state: { period: targetPeriod } }, { status: 'answer', report: { count: expenses.length, total, period: targetPeriod } });
  }
  return searchGlobal(req, query || message, targetPeriod);
}

function searchGlobal(req, query, period) {
  const q = normalizeText(query || '');
  const tenants = scopedTenants(req)
    .filter(t => !q || normalizeText(`${t.name} ${t.unit_code || ''} ${t.property_name || ''}`).includes(q))
    .slice(0, 8)
    .map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || 'bez lokalu'} · ${t.property_name || ''}`, view: 'najemcy' }));
  const payments = scopedPaymentRows(req, period)
    .filter(p => !q || normalizeText(`${p.tenant_name || ''} ${p.unit_code || ''} ${p.property_name || ''}`).includes(q))
    .slice(0, 8)
    .map(p => ({ type: 'payment', id: p.payment_id, title: `${p.tenant_name || 'Płatność'} · ${p.period}`, subtitle: `${p.unit_code || ''} · ${p.status} · ${amount(p)} zł`, view: 'platnosci' }));
  const units = scopedUnits(req)
    .filter(u => !q || normalizeText(`${u.code || ''} ${u.name || ''} ${u.property_name || ''} ${u.tenant_name || ''}`).includes(q))
    .slice(0, 8)
    .map(u => ({ type: 'unit', id: u.id, title: u.code || u.name, subtitle: `${u.property_name || ''} · ${u.tenant_name || 'brak najemcy'}`, view: 'nieruchomosci' }));
  const items = [...tenants, ...payments, ...units].slice(0, 12);
  return resultList('search_global', 'Wyniki wyszukiwania', items.length ? `Znalazłem ${items.length} pasujących elementów.` : 'Brak pasujących wyników.', items, null);
}

function filterResponse(req, intent, model, message, period) {
  const query = model.query || extractSearchQuery(message) || '';
  if (intent === 'filter_payments') {
    const status = model.status || localIntent(message).status || null;
    const state = { paymentsQ: query, paymentsFilter: ['paid','pending','overdue','partial'].includes(status) ? status : 'all' };
    const title = status === 'overdue' ? 'Zaległe płatności' : status === 'partial' ? 'Płatności częściowe' : 'Płatności';
    return navigationResult(intent, title, 'Przełączam widok płatności i ustawiam filtr.', { view: 'platnosci', state });
  }
  if (intent === 'filter_tenants') {
    const status = model.status || localIntent(message).status || null;
    const tenants = scopedTenants(req).filter(t => {
      if (status === 'missing_phone') return t.status === 'active' && !String(t.phone || '').trim();
      if (status === 'missing_sms_consent') return t.status === 'active' && Number(t.sms_consent || 0) !== 1;
      return !query || normalizeText(t.name).includes(normalizeText(query));
    });
    const items = tenants.slice(0, 12).map(t => ({ type: 'tenant', id: t.id, title: t.name, subtitle: `${t.unit_code || 'bez lokalu'} · SMS ${t.sms_consent ? 'zgoda' : 'brak zgody'}`, view: 'najemcy' }));
    return resultList(intent, 'Najemcy', `Znalazłem ${tenants.length} pozycji.`, items, { view: 'najemcy', state: { tenantsQ: query, tenantsStatus: 'active' } });
  }
  if (intent === 'filter_units') {
    const units = scopedUnits(req).filter(u => Number(u.active_contracts || 0) === 0);
    const items = units.slice(0, 12).map(u => ({ type: 'unit', id: u.id, title: u.code || u.name, subtitle: `${u.property_name || ''} · ${u.tenant_name || 'brak najemcy'}`, view: 'nieruchomosci' }));
    return resultList(intent, 'Lokale bez aktywnej umowy', `Znalazłem ${units.length} lokali bez aktywnej umowy.`, items, { view: 'nieruchomosci' });
  }
  if (intent === 'filter_contracts') {
    const contracts = scopedContracts(req).filter(c => c.status === 'active' && c.end_date && new Date(c.end_date) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    const items = contracts.slice(0, 12).map(c => ({ type: 'contract', id: c.id, title: c.tenant_name, subtitle: `${c.unit_code || ''} · koniec ${c.end_date}`, view: 'umowy' }));
    return resultList(intent, 'Kończące się umowy', `Znalazłem ${contracts.length} umów kończących się w ciągu 30 dni.`, items, { view: 'umowy', state: { contractsStatus: 'active' } });
  }
  if (intent === 'filter_expenses') {
    const targetPeriod = periodFromMessage(message, period);
    return navigationResult(intent, 'Koszty', `Przełączam widok kosztów na ${periodLabel(targetPeriod)}.`, { view: 'koszty', state: { period: targetPeriod } });
  }
  return searchGlobal(req, query, period);
}

function reportAnswer(req, model, message, period) {
  const targetPeriod = model.period || periodFromMessage(message, period);
  const text = normalizeText(message);
  if (model.query === 'finance_explanation' || isFinanceExplanationQuestion(text)) {
    return financeExplanationAnswer(req, message, targetPeriod);
  }
  if (model.query === 'annual_summary' || isAnnualSummaryQuestion(text)) {
    return annualSummaryAnswer(req, message, targetPeriod);
  }
  if (model.query === 'property_finance_summary' || (isPropertyFinanceQuestion(text) && extractPropertySubject(message))) {
    return propertyFinanceAnswer(req, model, message, targetPeriod);
  }
  if (model.query === 'tax_summary' || isTaxSummaryQuestion(text)) {
    return taxSummaryAnswer(req, message, targetPeriod);
  }
  if (model.query === 'late_fees' || includesAny(text, ['zestawienie kar', 'raport kar', 'kary najemcow', 'kar najemcow', 'kary za opoznienie'])) {
    const explicitPeriod = periodFromMessage(message, null);
    const rows = scopedLateFeeRows(req, explicitPeriod);
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const paid = rows.reduce((sum, row) => sum + Number(row.paid || 0), 0);
    const balance = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
    const suffix = explicitPeriod ? ` za ${periodLabel(explicitPeriod)}` : '';
    return {
      ok: true,
      status: 'answer',
      intent: 'report_answer',
      title: `Zestawienie kar najemców${suffix}`,
      message: rows.length
        ? `Naliczono ${Math.round(total)} zł kar, zapłacono ${Math.round(paid)} zł, pozostało ${Math.round(balance)} zł.`
        : `Brak naliczonych kar${suffix}.`,
      report: { total, paid, balance, count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0), period: explicitPeriod || null },
      items: rows.slice(0, 20).map(row => ({
        type: 'tenant',
        id: row.tenant_id,
        title: row.tenant_name,
        subtitle: `${row.unit_code || 'bez lokalu'} · naliczono ${Math.round(row.total || 0)} zł · zapłacono ${Math.round(row.paid || 0)} zł · pozostało ${Math.round(row.balance || 0)} zł · ${row.periods || ''}`,
        view: 'najemcy',
      })),
      execute_required: false,
    };
  }
  if (text.includes('porownaj') || text.includes('porownanie')) {
    const cur = monthlyFinanceSummary(db, targetPeriod, req);
    const prevP = previousPeriod(targetPeriod);
    const prev = monthlyFinanceSummary(db, prevP, req);
    const delta = cur.net_for_owner - prev.net_for_owner;
    return {
      ok: true, status: 'answer', intent: 'report_answer', title: `Porównanie ${periodLabel(targetPeriod)} do ${periodLabel(prevP)}`,
      message: `Netto: ${Math.round(cur.net_for_owner)} zł vs ${Math.round(prev.net_for_owner)} zł. Różnica: ${Math.round(delta)} zł.`,
      report: { period: targetPeriod, previous_period: prevP, current_net: cur.net_for_owner, previous_net: prev.net_for_owner, delta },
      execute_required: false,
    };
  }
  if (text.includes('najwiekszy koszt') || text.includes('najwieksze koszty')) {
    const expenses = scopedExpenses(req, targetPeriod);
    const top = expenses[0];
    return {
      ok: true, status: 'answer', intent: 'report_answer', title: `Największy koszt w ${periodLabel(targetPeriod)}`,
      message: top ? `${top.description || top.category}: ${top.amount} zł (${top.property_name || 'bez nieruchomości'}).` : 'Brak kosztów w tym okresie.',
      items: expenses.slice(0, 8).map(e => ({ type: 'expense', id: e.id, title: e.description || e.category, subtitle: `${e.amount} zł · ${e.property_name || ''} · ${e.date}`, view: 'koszty' })),
      execute_required: false,
    };
  }
  const summary = monthlyFinanceSummary(db, targetPeriod, req);
  if (text.includes('zaleglosci')) {
    return {
      ok: true, status: 'answer', intent: 'report_answer', title: `Zaległości ${periodLabel(targetPeriod)}`,
      message: `Saldo zaległości i oczekujących wpłat: ${Math.round((summary.revenue.expected || 0) - (summary.revenue.paid || 0))} zł.`,
      report: { expected: summary.revenue.expected, paid: summary.revenue.paid, overdue_count: summary.revenue.overdue_count || 0 },
      execute_required: false,
    };
  }
  return {
    ok: true, status: 'answer', intent: 'report_answer', title: `Wynik netto ${periodLabel(targetPeriod)}`,
    message: `Netto właściciel wynosi ${Math.round(summary.net_for_owner || 0)} zł. Przychód: ${Math.round(summary.revenue.gross || 0)} zł, koszty: ${Math.round(summary.expenses.total || 0)} zł, podatek: ${Math.round(summary.tax.podatek_suma || 0)} zł.`,
    report: summary.totals,
    execute_required: false,
  };
}

function qualityRangeFromInput(input, fallbackPeriod, req) {
  if (/^\d{4}-\d{2}$/.test(String(input || ''))) {
    return { mode: 'period', period: input, start: input, end: input, label: periodLabel(input), periods: [input], source: 'rule' };
  }
  return timeRangeFromMessage(input || fallbackPeriod, fallbackPeriod, req);
}

function dataQualityReport(req, input, fallbackPeriod = null) {
  const range = qualityRangeFromInput(input, fallbackPeriod || todayLocalISO().slice(0, 7), req);
  const tenants = scopedTenants(req);
  const units = scopedUnits(req);
  const properties = scopedProperties(req);
  const payments = range.periods.flatMap(p => scopedPaymentRows(req, p));
  const expenses = range.periods.flatMap(p => scopedExpenses(req, p));
  const avgExpense = expenses.length ? expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0) / expenses.length : 0;
  const propertyIssues = [];
  for (const property of properties) {
    const propertyPayments = payments.filter(p => Number(p.property_id) === Number(property.id));
    if (!propertyPayments.length) continue;
    const monthsWithPayments = new Set(propertyPayments.map(p => p.period));
    const missing = range.periods.filter(p => !monthsWithPayments.has(p));
    if (missing.length) {
      propertyIssues.push({
        type: 'report',
        title: property.name,
        subtitle: `brak wpływów w ${missing.join(', ')}`,
        view: 'raporty',
      });
    }
  }
  const activeTenantScheduleMissing = [];
  const activeTenantsWithUnits = tenants.filter(t => t.status === 'active' && t.current_unit_id);
  for (const tenant of activeTenantsWithUnits) {
    const tenantPayments = payments.filter(p => Number(p.tenant_id) === Number(tenant.id));
    const monthsWithPayments = new Set(tenantPayments.map(p => p.period));
    const missing = range.periods.filter(p => !monthsWithPayments.has(p));
    if (missing.length && range.periods.length <= 12) {
      activeTenantScheduleMissing.push({
        type: 'tenant',
        id: tenant.id,
        title: tenant.name,
        subtitle: `${tenant.unit_code || 'bez lokalu'} · brak harmonogramu: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`,
        view: 'najemcy',
      });
    }
  }
  const mediaExpenseIssues = [];
  for (const property of properties) {
    const propertyPayments = payments.filter(p => Number(p.property_id) === Number(property.id));
    if (!propertyPayments.length) continue;
    for (const p of range.periods) {
      if (!propertyPayments.some(row => row.period === p)) continue;
      const hasMediaExpense = expenses.some(e =>
        Number(e.resolved_property_id || e.property_id || 0) === Number(property.id)
        && String(e.date || '').startsWith(p)
        && ['inne', 'prad', 'internet', 'czynsz'].includes(String(e.category || ''))
      );
      if (!hasMediaExpense) {
        mediaExpenseIssues.push({ type: 'report', title: `${property.name} · ${periodLabel(p)}`, subtitle: 'wpływy są, ale nie widzę kosztów eksploatacyjnych/mediów', view: 'koszty' });
      }
    }
  }
  const monthlySummaries = range.periods.map(p => ({ period: p, summary: monthlyFinanceSummary(db, p, req) }));
  const taxGaps = monthlySummaries
    .filter(row => Number(row.summary.revenue.rent_paid || 0) > 0 && Number(row.summary.tax.podatek_suma || 0) <= 0)
    .map(row => ({ type: 'report', title: periodLabel(row.period), subtitle: `podstawa ${Math.round(row.summary.revenue.rent_paid || 0)} zł, podatek 0 zł`, view: 'raporty' }));
  const expectedGaps = monthlySummaries
    .filter(row => Number(row.summary.revenue.expected || 0) > Number(row.summary.revenue.gross || 0))
    .map(row => ({ type: 'report', title: periodLabel(row.period), subtitle: `oczekiwano ${Math.round(row.summary.revenue.expected || 0)} zł, wpłaty ${Math.round(row.summary.revenue.gross || 0)} zł`, view: 'platnosci' }));
  const emptyMonths = range.periods.filter(p => !payments.some(row => row.period === p));
  const highExpenses = avgExpense ? expenses.filter(e => Number(e.amount || 0) > Math.max(500, avgExpense * 3)) : [];
  const checks = [
    { key: 'missing_phone', label: 'Aktywni najemcy bez telefonu', priority: 'medium', count: tenants.filter(t => t.status === 'active' && !String(t.phone || '').trim()).length },
    { key: 'missing_sms_consent', label: 'Aktywni najemcy bez zgody SMS', priority: 'medium', count: tenants.filter(t => t.status === 'active' && Number(t.sms_consent || 0) !== 1).length },
    { key: 'tenant_without_unit', label: 'Aktywni najemcy bez lokalu', priority: 'high', count: tenants.filter(t => t.status === 'active' && !t.current_unit_id).length },
    { key: 'unit_without_contract', label: 'Lokale bez aktywnej umowy', priority: 'medium', count: units.filter(u => Number(u.active_contracts || 0) === 0).length },
    { key: 'payment_without_tenant', label: 'Płatności bez najemcy', priority: 'high', count: payments.filter(p => !p.tenant_id).length },
    { key: 'property_missing_months', label: 'Nieruchomości z brakującymi miesiącami wpływów', priority: 'critical', count: propertyIssues.length },
    { key: 'missing_schedule', label: `Brak harmonogramu u aktywnych najemców (${range.label})`, priority: 'high', count: activeTenantScheduleMissing.length },
    { key: 'empty_months', label: 'Miesiące bez żadnych płatności', priority: 'critical', count: emptyMonths.length },
    { key: 'expected_vs_paid_gap', label: 'Miesiące z różnicą oczekiwane vs wpłaty', priority: 'high', count: expectedGaps.length },
    { key: 'missing_media_expenses', label: 'Miesiące z wpływami bez kosztów eksploatacyjnych', priority: 'medium', count: mediaExpenseIssues.length },
    { key: 'high_expenses', label: 'Nietypowo wysokie koszty', priority: 'medium', count: highExpenses.length },
    { key: 'tax_gap', label: 'Wpłaty czynszowe bez podatku', priority: 'critical', count: taxGaps.length },
  ];
  const items = [
    ...propertyIssues,
    ...activeTenantScheduleMissing,
    ...expectedGaps,
    ...mediaExpenseIssues,
    ...highExpenses.map(e => ({ type: 'expense', id: e.id, title: e.description || e.category, subtitle: `${Math.round(e.amount || 0)} zł · ${e.property_name || ''} · ${e.date}`, view: 'koszty' })),
    ...taxGaps,
  ].slice(0, 24);
  const issueCount = checks.reduce((sum, c) => sum + Number(c.count || 0), 0);
  return {
    ok: true,
    status: 'audit',
    intent: 'data_quality_check',
    title: `Kontrola jakości danych ${range.label}`,
    message: issueCount ? `Znalazłem ${issueCount} sygnałów do sprawdzenia. Najważniejsze pozycje masz poniżej.` : 'Nie znalazłem oczywistych problemów.',
    checks,
    items,
    report: { range, issue_count: issueCount, empty_months: emptyMonths, priorities: checks.reduce((acc, c) => { acc[c.priority] = (acc[c.priority] || 0) + Number(c.count || 0); return acc; }, {}) },
    execute_required: false,
  };
}

function priorityRank(priority) {
  return ({ critical: 4, high: 3, medium: 2, low: 1 })[priority] || 0;
}

function attentionSummary(req, period) {
  const currentAudit = dataQualityReport(req, `sprawdź dane za ${period}`, period);
  const year = String(period || todayLocalISO().slice(0, 7)).slice(0, 4);
  const yearlyAudit = dataQualityReport(req, `sprawdź czy dane są kompletne za ${year} r.`, period);
  const checks = [...(currentAudit.checks || []), ...(yearlyAudit.checks || [])]
    .filter(c => Number(c.count || 0) > 0)
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.count - a.count)
    .slice(0, 5);
  const items = [...(currentAudit.items || []), ...(yearlyAudit.items || [])].slice(0, 6);
  return {
    ok: true,
    period,
    title: 'Co wymaga uwagi',
    issue_count: checks.reduce((sum, c) => sum + Number(c.count || 0), 0),
    checks,
    items,
    commands: [
      `sprawdź czy dane są kompletne za ${year} r.`,
      `zrób podsumowanie ${year}`,
      'utwórz zadania z audytu',
    ],
  };
}

function previewFillMissingPropertyPayments(req, model, message, period) {
  const range = timeRangeFromMessage(message, period, req);
  const propertyQuery = model.property_name || extractPropertySubject(message) || model.query || '';
  const properties = matchProperties(req, propertyQuery);
  if (!properties.length) {
    return resultList('generate_payments', 'Doprecyzuj nieruchomość', 'Nie znalazłem nieruchomości do uzupełnienia wpływów.', publicPropertyCandidates(scopedProperties(req), '').map(p => ({ type: 'property', id: p.property_id, title: p.property_name, subtitle: `${p.district || ''} · ${p.units_count} lokali`, view: 'nieruchomosci' })), { view: 'nieruchomosci' }, { status: 'blocked' });
  }
  if (properties.length > 1) {
    return resultList('generate_payments', 'Doprecyzuj nieruchomość', 'Znalazłem więcej niż jedną pasującą nieruchomość.', properties.map(p => ({ type: 'property', id: p.id, title: p.name, subtitle: p.district || '', view: 'nieruchomosci' })), { view: 'nieruchomosci' }, { status: 'blocked' });
  }
  const property = properties[0];
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const uid = ownerId(req);
  const rows = db.prepare(`
    SELECT pm.*, t.name AS tenant_name, u.code AS unit_code, p.name AS property_name
    FROM payments pm
    JOIN units u ON u.id = pm.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    WHERE p.id = ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR p.owner_user_id = ? OR t.owner_user_id = ?)' : ''}
    ORDER BY pm.period DESC, pm.id DESC
  `).all(property.id, ...(scoped ? [uid, uid, uid] : []));
  if (!rows.length) {
    return { ok: false, status: 'blocked', intent: 'generate_payments', title: 'Brak wzorca płatności', message: `Nie mam z czego skopiować wpływów dla ${property.name}.`, execute_required: false };
  }
  const monthsWithPayments = new Set(rows.filter(row => range.periods.includes(row.period)).map(row => row.period));
  const missing = range.periods.filter(p => !monthsWithPayments.has(p));
  if (!missing.length) {
    return { ok: true, status: 'answer', intent: 'generate_payments', title: 'Brak brakujących wpływów', message: `${property.name} ma płatności w całym zakresie ${range.label}.`, execute_required: false };
  }
  const sample = rows.find(row => range.periods.includes(row.period) && row.status === 'paid') || rows.find(row => row.status === 'paid') || rows[0];
  const unitCount = new Set(rows.map(row => row.unit_id)).size;
  if (unitCount > 1) {
    return { ok: false, status: 'blocked', intent: 'generate_payments', title: 'Zbyt wiele lokali', message: `Automatyczne kopiowanie wpływów działa teraz tylko dla nieruchomości z jednym lokalem. ${property.name} ma więcej niż jeden lokal.`, execute_required: false };
  }
  const amountValue = Number(sample.total_paid || amount(sample));
  const action = {
    type: 'fill_missing_property_payments',
    property_id: property.id,
    sample_payment_id: sample.id,
    periods: missing,
    notes: `Uzupełnienie ${property.name} za ${range.label} na podstawie ${sample.period}`,
  };
  return {
    ok: true,
    status: 'ready',
    intent: 'generate_payments',
    title: 'Uzupełnić brakujące wpływy?',
    message: `Dodam ${missing.length} płatności dla ${property.name}: ${missing.join(', ')}. Każda po ${Math.round(amountValue)} zł na podstawie ${periodLabel(sample.period)} (${sample.tenant_name || 'najemca'} / ${sample.unit_code || 'lokal'}). Razem ${Math.round(amountValue * missing.length)} zł.`,
    execute_required: true,
    items: missing.map(p => ({ type: 'payment', title: periodLabel(p), subtitle: `${sample.tenant_name || 'najemca'} · ${Math.round(amountValue)} zł`, view: 'platnosci' })),
    action: { ...action, token: actionToken(req, action), label: 'Uzupełnij wpływy' },
  };
}

function previewAuditTasks(req, message, period) {
  const audit = dataQualityReport(req, message, period);
  const active = (audit.checks || []).filter(c => Number(c.count || 0) > 0)
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.count - a.count)
    .slice(0, 8);
  if (!active.length) {
    return { ok: true, status: 'answer', intent: 'create_task', title: 'Audyt bez zadań', message: 'Nie znalazłem problemów, z których warto tworzyć zadania.', execute_required: false };
  }
  const tasks = active.map(check => ({
    title: `AI audyt: ${check.label}`,
    description: `Zakres: ${audit.report.range.label}. Liczba sygnałów: ${check.count}. Priorytet: ${check.priority}.`,
    priority: check.priority === 'critical' || check.priority === 'high' ? 'high' : 'med',
  }));
  const action = { type: 'create_audit_tasks', tasks };
  return {
    ok: true,
    status: 'ready',
    intent: 'create_task',
    title: 'Utworzyć zadania z audytu?',
    message: `Dodam ${tasks.length} zadań z najważniejszych punktów audytu ${audit.report.range.label}.`,
    execute_required: true,
    items: tasks.map(task => ({ type: 'task', title: task.title, subtitle: task.description, view: 'zadania' })),
    action: { ...action, token: actionToken(req, action), label: 'Dodaj zadania' },
  };
}

function actionPreview(req, intent, model, message, period) {
  if (intent === 'create_task' && model.query === 'audit_tasks') {
    return previewAuditTasks(req, message, period);
  }
  if (intent === 'generate_payments' && model.query === 'fill_missing_property_payments') {
    return previewFillMissingPropertyPayments(req, model, message, period);
  }
  if (intent === 'create_task') {
    const title = model.title || extractTaskTitle(message);
    if (!title) return blocked(intent, 'Podaj tytuł zadania.', 'missing_task_title');
    const action = { type: 'create_task', title, description: model.description || null, priority: model.priority || 'med', due_date: model.date || null };
    return { ok: true, status: 'ready', intent, title: 'Dodać zadanie?', message: title, execute_required: true, action: { ...action, token: actionToken(req, action), label: 'Dodaj zadanie' } };
  }
  if (intent === 'add_expense') {
    const amountValue = model.amount || extractAmount(message);
    if (!amountValue) return blocked(intent, 'Podaj kwotę kosztu.', 'missing_expense_amount');
    const targetPeriod = model.period || periodFromMessage(message, period);
    const action = { type: 'add_expense', amount: amountValue, category: model.category || extractExpenseCategory(message), date: model.date || `${targetPeriod}-01`, description: model.description || message };
    return { ok: true, status: 'ready', intent, title: 'Dodać koszt?', message: `${action.category}: ${action.amount} zł (${action.date})`, execute_required: true, action: { ...action, token: actionToken(req, action), label: 'Dodaj koszt' } };
  }
  if (intent === 'generate_payments') {
    const targetPeriod = model.period || periodFromMessage(message, period);
    const action = { type: 'generate_payments', period: targetPeriod };
    return { ok: true, status: 'ready', intent, title: 'Wygenerować płatności?', message: `Utworzyć harmonogram wpłat na ${periodLabel(targetPeriod)}?`, execute_required: true, action: { ...action, token: actionToken(req, action), label: 'Generuj płatności' } };
  }
  return null;
}

async function parseAssistantCommand(req, body) {
  const input = ParseSchema.parse(body || {});
  const period = input.period || todayLocalISO().slice(0, 7);
  const rows = scopedPaymentRows(req, period);
  const local = localIntent(input.message);
  const useLocalIntent = local.intent !== 'unsupported' && Number(local.confidence || 0) >= 0.8;
  const classified = useLocalIntent
    ? { ...local, ai_used: false, ai_configured: Boolean(process.env.GROQ_API_KEY), warning: null }
    : await classifyWithGroq(input.message, period, assistantContext(req, input.message, period));
  const merged = useLocalIntent || (classified.intent === 'unsupported' && local.intent !== 'unsupported')
    ? { ...classified, ...local }
    : { ...local, ...classified };
  const intent = ModelIntentSchema.parse(normalizeModelIntent({
    intent: merged.intent || 'unsupported',
    tenant_name: merged.tenant_name || null,
    tenant_id: merged.tenant_id || null,
    payment_id: merged.payment_id || null,
    tool: merged.tool || null,
    query: merged.query || null,
    entity_type: merged.entity_type || null,
    status: merged.status || null,
    period: merged.period || null,
    year: merged.year || null,
    property_name: merged.property_name || null,
    title: merged.title || null,
    description: merged.description || null,
    category: merged.category || null,
    amount: merged.amount || null,
    date: merged.date || null,
    priority: merged.priority || null,
    tone: merged.tone || null,
    filters: merged.filters || null,
    confidence: merged.confidence || 0,
  }));
  const ai = {
    provider: 'groq',
    model: GROQ_MODEL,
    configured: classified.ai_configured !== false,
    used: classified.ai_used === true,
    warning: classified.warning || null,
  };

  const targetPeriod = intent.period || periodFromMessage(input.message, period);
  const explicitSearch = /^(szukaj|wyszukaj|znajdz)\b/.test(normalizeText(input.message));
  const shouldTrySemantic = !['finance_explanation'].includes(intent.query || '')
    && ['answer_from_data', 'report_answer'].includes(intent.intent);
  if (shouldTrySemantic || (intent.intent === 'search_global' && !explicitSearch)) {
    const semantic = semanticAnswer(req, input.message, period);
    if (semantic) return { ...semantic, ai };
  }

  if (intent.intent === 'explain_tax') return taxResponse(req, targetPeriod, ai);
  if (intent.intent === 'search_global') return { ...searchGlobal(req, intent.query || input.message, targetPeriod), ai };
  if (intent.intent === 'navigate_to_entity') {
    const results = searchGlobal(req, intent.query || intent.tenant_name || input.message, targetPeriod);
    if (results.items && results.items.length === 1) {
      return navigationResult('navigate_to_entity', `Otwieram: ${results.items[0].title}`, results.items[0].subtitle || '', {
        view: results.items[0].view,
        state: results.items[0].type === 'tenant' ? { tenantsQ: results.items[0].title, tenantsStatus: 'active' } : {},
      }, { ai });
    }
    return { ...results, intent: 'navigate_to_entity', title: 'Wybierz wynik', ai };
  }
  if (['filter_payments','filter_tenants','filter_units','filter_contracts','filter_expenses'].includes(intent.intent)) {
    return { ...filterResponse(req, intent.intent, intent, input.message, targetPeriod), ai };
  }
  if (intent.intent === 'answer_from_data') return { ...answerFromDataTool(req, intent, input.message, targetPeriod), ai };
  if (intent.intent === 'report_answer') return { ...reportAnswer(req, intent, input.message, targetPeriod), ai };
  if (intent.intent === 'data_quality_check') return { ...dataQualityReport(req, input.message, targetPeriod), ai };
  if (['create_task','add_expense','generate_payments'].includes(intent.intent)) {
    return { ...actionPreview(req, intent.intent, intent, input.message, targetPeriod), ai };
  }
  if (intent.intent === 'unsupported') {
    return {
      ok: false,
      status: 'unsupported',
      intent: 'unsupported',
      title: 'Nieobsługiwana komenda',
      message: 'Obsługuję wyszukiwanie, nawigację, filtry, raporty, kontrolę danych, pytania o dane, płatności, koszty, zadania i SMS-y.',
      execute_required: false,
      ai,
    };
  }

  const matches = resolveRows(intent, input.message, rows);
  const tenantIds = new Set(matches.map(row => row.tenant_id).filter(Boolean));
  if (matches.length === 0) return clarification(intent.intent, 'Nie znalazłem pasującego najemcy lub płatności.', rows);
  if (tenantIds.size > 1 || matches.length > 1) return clarification(intent.intent, 'Znalazłem więcej niż jedną pasującą płatność.', matches);
  const row = matches[0];

  if (intent.intent === 'mark_payment_paid') return paymentPreview(req, row, period, ai);
  if (intent.intent === 'send_sms_reminder') return smsPreview(req, row, period, ai);
  return blocked('unsupported', 'Nieobsługiwana komenda.', 'unsupported', { ai });
}

function isLatePayment(row, paidDate) {
  return row && paidDate && row.due_date && new Date(paidDate) > new Date(row.due_date);
}

function markPaymentPaid(req, paymentId, paidDate) {
  if (!canAccessPayment(db, req, paymentId)) {
    const err = new Error('payment_not_found');
    err.status = 404;
    throw err;
  }
  const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!cur) {
    const err = new Error('payment_not_found');
    err.status = 404;
    throw err;
  }
  const total = amount(cur);
  let lateFeeAmount = Number(cur.late_fee_amount || 0);
  if (!Number(cur.late_fee_manual || 0)) lateFeeAmount = isLatePayment(cur, paidDate) ? LATE_FEE_AMOUNT : 0;
  const lateFeePaid = Math.min(lateFeeAmount, Math.max(0, Number(cur.late_fee_paid || 0)));
  db.prepare(`
    UPDATE payments
    SET status = 'paid',
        paid_date = ?,
        total_paid = ?,
        late_fee_amount = ?,
        late_fee_paid = ?,
        late_fee_manual = ?
    WHERE id = ?
  `).run(paidDate, total, lateFeeAmount, lateFeePaid, Number(cur.late_fee_manual || 0), paymentId);
  return db.prepare(`
    SELECT p.*, t.name AS tenant_name, u.code AS unit_code, u.name AS unit_name
    FROM payments p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN units u ON u.id = p.unit_id
    WHERE p.id = ?
  `).get(paymentId);
}

function createTask(req, action) {
  const r = db.prepare(`
    INSERT INTO tasks (owner_user_id,title,description,due_date,priority,status)
    VALUES (?, ?, ?, ?, ?, 'open')
  `).run(ownerId(req), action.title, action.description || null, action.due_date || null, action.priority || 'med');
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid);
}

function addExpense(req, action) {
  const r = db.prepare(`
    INSERT INTO expenses (owner_user_id,category,amount,date,description)
    VALUES (?, ?, ?, ?, ?)
  `).run(ownerId(req), action.category || 'inne', Number(action.amount || 0), action.date || todayLocalISO(), action.description || null);
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(r.lastInsertRowid);
}

function fillMissingPropertyPayments(req, action) {
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const uid = ownerId(req);
  const sample = db.prepare(`
    SELECT pm.*
    FROM payments pm
    JOIN units u ON u.id = pm.unit_id
    JOIN properties p ON p.id = u.property_id
    WHERE pm.id = ?
      ${scoped ? 'AND (pm.owner_user_id = ? OR p.owner_user_id = ?)' : ''}
  `).get(action.sample_payment_id, ...(scoped ? [uid, uid] : []));
  if (!sample) {
    const err = new Error('sample_payment_not_found');
    err.status = 404;
    throw err;
  }
  const insert = db.prepare(`
    INSERT INTO payments (owner_user_id,period,tenant_id,unit_id,due_day,due_date,paid_date,rent_amount,media_amount,other_amount,total_paid,status,source,notes)
    VALUES (@owner_user_id,@period,@tenant_id,@unit_id,@due_day,@due_date,@paid_date,@rent_amount,@media_amount,@other_amount,@total_paid,'paid','assistant-repair',@notes)
  `);
  const exists = db.prepare('SELECT id FROM payments WHERE period = ? AND unit_id = ? LIMIT 1');
  const tx = db.transaction(() => {
    const created = [];
    const skipped = [];
    for (const period of action.periods || []) {
      if (exists.get(period, sample.unit_id)) {
        skipped.push(period);
        continue;
      }
      const dueDay = Number(sample.due_day || 10);
      const day = String(Math.min(dueDay, Number(monthEnd(period).slice(8)))).padStart(2, '0');
      const result = insert.run({
        owner_user_id: sample.owner_user_id || uid || null,
        period,
        tenant_id: sample.tenant_id,
        unit_id: sample.unit_id,
        due_day: dueDay,
        due_date: `${period}-${day}`,
        paid_date: `${period}-${day}`,
        rent_amount: Number(sample.rent_amount || 0),
        media_amount: Number(sample.media_amount || 0),
        other_amount: Number(sample.other_amount || 0),
        total_paid: Number(sample.total_paid || amount(sample)),
        notes: action.notes || 'Uzupełnienie brakujących wpływów przez AI',
      });
      created.push({ id: result.lastInsertRowid, period });
    }
    return { created, skipped };
  });
  return tx();
}

function createAuditTasks(req, action) {
  const tx = db.transaction(() => {
    const tasks = [];
    for (const item of (action.tasks || []).slice(0, 12)) {
      const task = createTask(req, {
        title: item.title,
        description: item.description || null,
        priority: item.priority || 'med',
        due_date: item.due_date || null,
      });
      tasks.push(task);
    }
    return tasks;
  });
  return tx();
}

function generatePayments(req, period) {
  const fallbackDueDay = 10;
  const monthStart = `${period}-01`;
  const monthEndDate = monthEnd(period);
  const uid = ownerId(req);
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  const tx = db.transaction(() => {
    const contracts = db.prepare(`
      SELECT * FROM contracts
      WHERE status = 'active'
        AND (start_date IS NULL OR DATE(start_date) <= DATE(?))
        AND (end_date IS NULL OR DATE(end_date) >= DATE(?))
        ${scoped ? 'AND unit_id IN (SELECT u.id FROM units u JOIN properties p ON p.id = u.property_id WHERE p.owner_user_id = ?)' : ''}
      ORDER BY unit_id
    `).all(monthEndDate, monthStart, ...(scoped ? [uid] : []));
    const upsert = db.prepare(`
      INSERT INTO payments (owner_user_id,period,tenant_id,unit_id,due_day,due_date,rent_amount,media_amount,late_fee_amount,late_fee_paid,late_fee_manual,total_paid,status,source)
      VALUES (@owner_user_id,@period,@tenant_id,@unit_id,@due_day,@due_date,@rent_amount,@media_amount,0,0,0,0,'pending','assistant')
      ON CONFLICT DO NOTHING
    `);
    let created = 0;
    let skipped = 0;
    for (const c of contracts) {
      const dueDay = c.pay_by_day || fallbackDueDay;
      const result = upsert.run({
        owner_user_id: uid,
        period,
        tenant_id: c.tenant_id,
        unit_id: c.unit_id,
        due_day: dueDay,
        due_date: `${period}-${String(Math.min(dueDay, Number(monthEndDate.slice(8)))).padStart(2, '0')}`,
        rent_amount: c.rent || 0,
        media_amount: c.media_advance || 0,
      });
      if (result.changes) created += 1;
      else skipped += 1;
    }
    return { period, created, skipped, source_counts: { contracts: contracts.length } };
  });
  return tx();
}

async function executeAssistantAction(req, body) {
  const input = ExecuteSchema.parse(body || {});
  const action = verifyActionToken(req, input.token);
  if (action.type === 'mark_payment_paid') {
    const payment = markPaymentPaid(req, action.payment_id, action.paid_date || todayLocalISO());
    return {
      ok: true,
      status: 'done',
      intent: 'mark_payment_paid',
      message: `Oznaczono płatność jako opłaconą: ${payment.tenant_name || 'najemca'} (${payment.period}).`,
      payment,
    };
  }
  if (action.type === 'send_sms_reminder') {
    const sent = await sendPaymentReminder(req, action.payment_id);
    if (sent.status === 'failed') {
      const err = new Error(sent.error || 'sms_send_failed');
      err.status = 500;
      throw err;
    }
    return {
      ok: true,
      status: 'done',
      intent: 'send_sms_reminder',
      message: sent.status === 'simulated' ? 'SMS zapisany jako symulacja testowa.' : 'SMS został wysłany.',
      sent,
    };
  }
  if (action.type === 'create_task') {
    const task = createTask(req, action);
    return { ok: true, status: 'done', intent: 'create_task', message: `Dodano zadanie: ${task.title}.`, task };
  }
  if (action.type === 'add_expense') {
    const expense = addExpense(req, action);
    return { ok: true, status: 'done', intent: 'add_expense', message: `Dodano koszt: ${expense.amount} zł.`, expense };
  }
  if (action.type === 'generate_payments') {
    const result = generatePayments(req, action.period);
    return { ok: true, status: 'done', intent: 'generate_payments', message: `Utworzono ${result.created} płatności, pominięto ${result.skipped}.`, result };
  }
  if (action.type === 'fill_missing_property_payments') {
    const result = fillMissingPropertyPayments(req, action);
    return { ok: true, status: 'done', intent: 'generate_payments', message: `Uzupełniono ${result.created.length} płatności, pominięto ${result.skipped.length}.`, result };
  }
  if (action.type === 'create_audit_tasks') {
    const tasks = createAuditTasks(req, action);
    return { ok: true, status: 'done', intent: 'create_task', message: `Dodano ${tasks.length} zadań z audytu.`, tasks };
  }
  const err = new Error('unsupported_action');
  err.status = 400;
  throw err;
}

module.exports = {
  attentionSummary,
  parseAssistantCommand,
  executeAssistantAction,
};
