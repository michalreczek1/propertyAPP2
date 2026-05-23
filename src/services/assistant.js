'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const { monthlyFinanceSummary } = require('./finance-summary');
const { previewPaymentReminder, sendPaymentReminder } = require('./notifications');
const { todayLocalISO } = require('../utils/period');
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

const ModelIntentSchema = z.object({
  intent: z.enum(['mark_payment_paid', 'explain_tax', 'send_sms_reminder', 'unsupported']),
  tenant_name: z.string().nullable().optional(),
  tenant_id: z.coerce.number().int().positive().nullable().optional(),
  payment_id: z.coerce.number().int().positive().nullable().optional(),
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
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ąćęłńóśźż\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (/\b(podatek|podatku|ryczalt|ryczaltu)\b/.test(text)) return { intent: 'explain_tax', confidence: 0.8 };
  if (/\b(sms|wiadomosc|przypomnienie|przypomnij)\b/.test(text)) return { intent: 'send_sms_reminder', confidence: 0.72 };
  if (/\b(zaplacil|zaplacila|zaplacone|oplacil|oplacila|wplacil|wplacila|wplata)\b/.test(text)) {
    return { intent: 'mark_payment_paid', confidence: 0.72 };
  }
  return { intent: 'unsupported', confidence: 0.3 };
}

async function classifyWithGroq(message, period, candidates) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ...localIntent(message), ai_used: false, ai_configured: false, warning: 'GROQ_API_KEY nie jest skonfigurowany - używam lokalnego rozpoznawania v1.' };

  const system = [
    'You classify Polish property-management commands into a strict JSON object.',
    'Allowed intents: mark_payment_paid, explain_tax, send_sms_reminder, unsupported.',
    'Return only JSON. Do not invent ids. Use payment_id or tenant_id only from provided candidates.',
    'If tenant/payment is ambiguous or missing, return the intent with tenant_name if visible, but no invented id.',
    'Schema: {"intent":"...", "tenant_name":string|null, "tenant_id":number|null, "payment_id":number|null, "confidence":number}.',
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
  const parts = tenant.split(/\s+/).filter(part => part.length >= 3);
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

async function parseAssistantCommand(req, body) {
  const input = ParseSchema.parse(body || {});
  const period = input.period || todayLocalISO().slice(0, 7);
  const rows = scopedPaymentRows(req, period);
  const classified = await classifyWithGroq(input.message, period, publicCandidates(rows));
  const intent = ModelIntentSchema.parse({
    intent: classified.intent || 'unsupported',
    tenant_name: classified.tenant_name || null,
    tenant_id: classified.tenant_id || null,
    payment_id: classified.payment_id || null,
    confidence: classified.confidence || 0,
  });
  const ai = {
    provider: 'groq',
    model: GROQ_MODEL,
    configured: classified.ai_configured !== false,
    used: classified.ai_used === true,
    warning: classified.warning || null,
  };

  if (intent.intent === 'explain_tax') return taxResponse(req, period, ai);
  if (intent.intent === 'unsupported') {
    return {
      ok: false,
      status: 'unsupported',
      intent: 'unsupported',
      title: 'Nieobsługiwana komenda',
      message: 'W tej wersji obsługuję płatności, podatek i SMS-y z przypomnieniem.',
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
  const err = new Error('unsupported_action');
  err.status = 400;
  throw err;
}

module.exports = {
  parseAssistantCommand,
  executeAssistantAction,
};
