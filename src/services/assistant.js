'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const { monthlyFinanceSummary } = require('./finance-summary');
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
  'data_quality_check',
  'create_task',
  'add_expense',
  'generate_payments',
  'unsupported',
];

const ModelIntentSchema = z.object({
  intent: z.enum(INTENTS),
  tenant_name: z.string().nullable().optional(),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  payment_id: z.coerce.number().int().positive().nullable().optional(),
  query: z.string().nullable().optional(),
  entity_type: z.enum(['tenant','payment','unit','property','contract','expense','task','report']).nullable().optional(),
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
  confidence: z.coerce.number().min(0).max(1).optional(),
});

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

function scopedPaymentRows(req, period) {
  const scoped = req.user && req.user.id && req.user.role !== 'admin';
  return db.prepare(`
    SELECT p.id AS payment_id, p.period, p.tenant_id, p.unit_id, p.status, p.due_date,
           p.rent_amount, p.media_amount, p.other_amount, p.total_paid,
           t.name AS tenant_name, t.phone, t.sms_consent, t.sms_disabled,
           u.name AS unit_name, u.code AS unit_code, pr.name AS property_name
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

function localIntent(message) {
  const text = normalizeText(message);
  const period = periodFromMessage(message, null);
  const query = extractSearchQuery(message);
  const base = { query, period, confidence: 0.7 };
  if (/^(szukaj|wyszukaj|znajdz)\b/.test(text)) return { intent: 'search_global', ...base, confidence: 0.9 };
  if (/\b(sms|wiadomosc|przypomnienie|przypomnij)\b/.test(text)) return { intent: 'send_sms_reminder', tenant_name: extractTargetName(message), ...base, confidence: 0.84 };
  if (/\b(zaplacil|zaplacila|zaplacone|oplacil|oplacila|wplacil|wplacila|wplata)\b/.test(text)) {
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
  if (includesAny(text, ['zestawienie kar', 'raport kar', 'kary najemcow', 'kar najemcow', 'kary za opoznienie', 'kary za opóźnienie'])) {
    return { intent: 'report_answer', ...base, query: 'late_fees', year: yearFromMessage(message, period || todayLocalISO().slice(0, 7)), confidence: 0.88 };
  }
  if (includesAny(text, ['ile zarobilem', 'ile zarobiłem', 'netto', 'przychod', 'przychód', 'porownaj', 'porównaj', 'najwiekszy koszt', 'największy koszt'])) {
    return { intent: 'report_answer', ...base, year: yearFromMessage(message, period || todayLocalISO().slice(0, 7)), confidence: 0.82 };
  }
  if (includesAny(text, ['sprawdz bledy', 'bledy w danych', 'kontrola danych', 'jakosc danych', 'audyt danych', 'sprawdz dane', 'nietypowo wysokie koszty', 'brak harmonogramu'])) {
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

async function classifyWithGroq(message, period, candidates) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ...localIntent(message), ai_used: false, ai_configured: false, warning: 'GROQ_API_KEY nie jest skonfigurowany - używam lokalnego rozpoznawania v1.' };

  const system = [
    'You classify Polish property-management commands into a strict JSON object.',
    `Allowed intents: ${INTENTS.join(', ')}.`,
    'Return only JSON. Do not invent ids. Use payment_id or tenant_id only from provided candidates.',
    'If tenant/payment is ambiguous or missing, return the intent with tenant_name if visible, but no invented id.',
    'For navigation/search/filter/report commands, fill query, entity_type, status, period, year or property_name when visible.',
    'For create_task/add_expense, fill title/description/amount/category/date only when visible.',
    'Schema includes: intent, tenant_name, tenant_id, payment_id, query, entity_type, status, period, year, property_name, title, description, category, amount, date, priority, tone, confidence.',
  ].join('\n');
  const body = {
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ message, period, candidates }, null, 2) },
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
    const parsed = ModelIntentSchema.parse(JSON.parse(content || '{}'));
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
  const scope = scopeCondition(req, { property: 'p' });
  return db.prepare(`
    SELECT e.*, p.name AS property_name, u.code AS unit_code, u.name AS unit_name
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

function dataQualityReport(req, period) {
  const tenants = scopedTenants(req);
  const units = scopedUnits(req);
  const payments = scopedPaymentRows(req, period);
  const expenses = scopedExpenses(req, period);
  const avgExpense = expenses.length ? expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0) / expenses.length : 0;
  const checks = [
    { key: 'missing_phone', label: 'Aktywni najemcy bez telefonu', count: tenants.filter(t => t.status === 'active' && !String(t.phone || '').trim()).length },
    { key: 'missing_sms_consent', label: 'Aktywni najemcy bez zgody SMS', count: tenants.filter(t => t.status === 'active' && Number(t.sms_consent || 0) !== 1).length },
    { key: 'tenant_without_unit', label: 'Aktywni najemcy bez lokalu', count: tenants.filter(t => t.status === 'active' && !t.current_unit_id).length },
    { key: 'unit_without_contract', label: 'Lokale bez aktywnej umowy', count: units.filter(u => Number(u.active_contracts || 0) === 0).length },
    { key: 'payment_without_tenant', label: 'Płatności bez najemcy', count: payments.filter(p => !p.tenant_id).length },
    { key: 'high_expenses', label: 'Nietypowo wysokie koszty', count: avgExpense ? expenses.filter(e => Number(e.amount || 0) > avgExpense * 3 && Number(e.amount || 0) > 500).length : 0 },
    { key: 'missing_schedule', label: `Brak harmonogramu płatności na ${periodLabel(period)}`, count: payments.length === 0 ? 1 : 0 },
  ];
  return {
    ok: true,
    status: 'audit',
    intent: 'data_quality_check',
    title: 'Kontrola jakości danych',
    message: checks.some(c => c.count) ? 'Znalazłem rzeczy warte sprawdzenia.' : 'Nie znalazłem oczywistych problemów.',
    checks,
    execute_required: false,
  };
}

function actionPreview(req, intent, model, message, period) {
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
    : await classifyWithGroq(input.message, period, publicCandidates(rows));
  const merged = useLocalIntent || (classified.intent === 'unsupported' && local.intent !== 'unsupported')
    ? { ...classified, ...local }
    : { ...local, ...classified };
  const intent = ModelIntentSchema.parse({
    intent: merged.intent || 'unsupported',
    tenant_name: merged.tenant_name || null,
    tenant_id: merged.tenant_id || null,
    payment_id: merged.payment_id || null,
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
    confidence: merged.confidence || 0,
  });
  const ai = {
    provider: 'groq',
    model: GROQ_MODEL,
    configured: classified.ai_configured !== false,
    used: classified.ai_used === true,
    warning: classified.warning || null,
  };

  const targetPeriod = intent.period || periodFromMessage(input.message, period);

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
  if (intent.intent === 'report_answer') return { ...reportAnswer(req, intent, input.message, targetPeriod), ai };
  if (intent.intent === 'data_quality_check') return { ...dataQualityReport(req, targetPeriod), ai };
  if (['create_task','add_expense','generate_payments'].includes(intent.intent)) {
    return { ...actionPreview(req, intent.intent, intent, input.message, targetPeriod), ai };
  }
  if (intent.intent === 'unsupported') {
    return {
      ok: false,
      status: 'unsupported',
      intent: 'unsupported',
      title: 'Nieobsługiwana komenda',
      message: 'Obsługuję wyszukiwanie, nawigację, filtry, raporty, kontrolę danych, płatności, koszty, zadania i SMS-y.',
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
  const err = new Error('unsupported_action');
  err.status = 400;
  throw err;
}

module.exports = {
  parseAssistantCommand,
  executeAssistantAction,
};
