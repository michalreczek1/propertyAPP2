'use strict';

const crypto = require('crypto');
const db = require('../db');
const { sendSms, getMessageInfo, parseMessageInfo } = require('./smsplanet');
const { todayLocalISO } = require('../utils/period');
const { canSeeAll, ownerId } = require('../utils/scope');

const SETTING_KEYS = [
  'notifications.sms.enabled',
  'notifications.sms.sender',
  'notifications.sms.send_time',
  'notifications.sms.overdue_days',
  'notifications.sms.reminder_enabled',
  'notifications.sms.reminder_days_before_due',
  'notifications.sms.test_mode',
  'notifications.sms.test_phone',
  'notifications.sms.clear_polish',
  'notifications.sms.transactional',
  'notifications.sms.template.test',
  'notifications.sms.template.due_reminder',
  'notifications.sms.template.overdue',
];

const DEFAULT_TEMPLATES = {
  test: 'Test SMS PropertyApp: konfiguracja powiadomien dziala.',
  due_reminder: 'Przypomnienie: termin platnosci za {unit} ({period}) uplywa {due_date}. Kwota: {amount} zl.',
  overdue: 'Przypomnienie: nie odnotowano platnosci za {unit} ({period}). Kwota: {amount} zl. Prosimy o uregulowanie.',
};

const DEFAULT_SETTINGS = {
  'notifications.sms.enabled': '0',
  'notifications.sms.sender': process.env.SMSPLANET_SENDER || 'TEST',
  'notifications.sms.send_time': '09:30',
  'notifications.sms.overdue_days': '1',
  'notifications.sms.reminder_enabled': '1',
  'notifications.sms.reminder_days_before_due': '3',
  'notifications.sms.test_mode': '1',
  'notifications.sms.test_phone': process.env.SMSPLANET_TEST_PHONE || '',
  'notifications.sms.clear_polish': '0',
  'notifications.sms.transactional': '0',
  'notifications.sms.template.test': DEFAULT_TEMPLATES.test,
  'notifications.sms.template.due_reminder': DEFAULT_TEMPLATES.due_reminder,
  'notifications.sms.template.overdue': DEFAULT_TEMPLATES.overdue,
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [5, 15, 30];

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function intSetting(settings, key, fallback) {
  const n = Number(settings[key]);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function getRawSetting(req, key) {
  if (!canSeeAll(req) && tableExists('user_settings')) {
    const row = db.prepare('SELECT value FROM user_settings WHERE owner_user_id = ? AND key = ?').get(ownerId(req), key);
    if (row) return row.value;
  }
  const global = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return global ? global.value : undefined;
}

function getNotificationSettings(req = null) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    const value = getRawSetting(req, key);
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return {
    enabled: truthy(out['notifications.sms.enabled']),
    sender: out['notifications.sms.sender'] || 'TEST',
    send_time: out['notifications.sms.send_time'] || '09:30',
    overdue_days: intSetting(out, 'notifications.sms.overdue_days', 1),
    reminder_enabled: truthy(out['notifications.sms.reminder_enabled']),
    reminder_days_before_due: intSetting(out, 'notifications.sms.reminder_days_before_due', 3),
    test_mode: truthy(out['notifications.sms.test_mode']),
    test_phone: out['notifications.sms.test_phone'] || '',
    clear_polish: truthy(out['notifications.sms.clear_polish']),
    transactional: truthy(out['notifications.sms.transactional']),
    template_test: out['notifications.sms.template.test'] || DEFAULT_TEMPLATES.test,
    template_due_reminder: out['notifications.sms.template.due_reminder'] || DEFAULT_TEMPLATES.due_reminder,
    template_overdue: out['notifications.sms.template.overdue'] || DEFAULT_TEMPLATES.overdue,
    token_configured: Boolean(process.env.SMSPLANET_TOKEN || process.env.SMSPLANET_API_TOKEN),
  };
}

function validateSettings(body) {
  const enabled = body.enabled ? '1' : '0';
  const reminderEnabled = body.reminder_enabled ? '1' : '0';
  const testMode = body.test_mode ? '1' : '0';
  const clearPolish = body.clear_polish ? '1' : '0';
  const transactional = body.transactional ? '1' : '0';
  let sender = String(body.sender || 'TEST').trim();
  if (sender.toLowerCase() === 'test') sender = 'TEST';
  if (!sender) throw Object.assign(new Error('sender_required'), { status: 400 });
  const sendTime = String(body.send_time || '09:30').trim();
  if (!/^\d{2}:\d{2}$/.test(sendTime)) throw Object.assign(new Error('invalid_send_time'), { status: 400 });
  const [h, m] = sendTime.split(':').map(Number);
  if (h > 23 || m > 59) throw Object.assign(new Error('invalid_send_time'), { status: 400 });
  const overdueDays = Number(body.overdue_days ?? 1);
  const reminderDays = Number(body.reminder_days_before_due ?? 3);
  if (!Number.isInteger(overdueDays) || overdueDays < 0 || overdueDays > 31) throw Object.assign(new Error('invalid_overdue_days'), { status: 400 });
  if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 31) throw Object.assign(new Error('invalid_reminder_days'), { status: 400 });
  const templateTest = String(body.template_test || DEFAULT_TEMPLATES.test).trim();
  const templateDueReminder = String(body.template_due_reminder || DEFAULT_TEMPLATES.due_reminder).trim();
  const templateOverdue = String(body.template_overdue || DEFAULT_TEMPLATES.overdue).trim();
  return {
    'notifications.sms.enabled': enabled,
    'notifications.sms.sender': sender,
    'notifications.sms.send_time': sendTime,
    'notifications.sms.overdue_days': String(overdueDays),
    'notifications.sms.reminder_enabled': reminderEnabled,
    'notifications.sms.reminder_days_before_due': String(reminderDays),
    'notifications.sms.test_mode': testMode,
    'notifications.sms.test_phone': String(body.test_phone || '').trim(),
    'notifications.sms.clear_polish': clearPolish,
    'notifications.sms.transactional': transactional,
    'notifications.sms.template.test': templateTest,
    'notifications.sms.template.due_reminder': templateDueReminder,
    'notifications.sms.template.overdue': templateOverdue,
  };
}

function saveNotificationSettings(req, body) {
  const entries = validateSettings(body);
  const upsertGlobal = db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const upsertUser = db.prepare(`
    INSERT INTO user_settings(owner_user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_user_id, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      if (canSeeAll(req)) upsertGlobal.run(key, value);
      else upsertUser.run(ownerId(req), key, value);
    }
  });
  tx();
  return getNotificationSettings(req);
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (digits.length === 9) digits = `48${digits}`;
  if (!/^48\d{9}$/.test(digits)) return null;
  return digits;
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function monthLabel(period) {
  const [year, month] = String(period || '').split('-');
  return month && year ? `${month}.${year}` : period;
}

function templateContext(row) {
  const due = row.due_date ? row.due_date.slice(8, 10) + '.' + row.due_date.slice(5, 7) : 'terminu';
  const unit = row.unit_code || row.unit_name || 'lokal';
  const amount = money(Number(row.rent_amount || 0) + Number(row.media_amount || 0) + Number(row.other_amount || 0));
  return {
    tenant: row.tenant_name || '',
    unit,
    property: row.property_name || '',
    period: monthLabel(row.period),
    due_date: due,
    amount,
  };
}

function renderTemplate(template, row) {
  const context = templateContext(row);
  return String(template || '').replace(/\{([a-z_]+)\}/gi, (match, key) => {
    return Object.prototype.hasOwnProperty.call(context, key) ? context[key] : match;
  });
}

function buildMessage(type, row, settings) {
  const template = type === 'due_reminder'
    ? settings.template_due_reminder
    : settings.template_overdue;
  return renderTemplate(template, row);
}

function messageHash(message) {
  return crypto.createHash('sha256').update(String(message || '')).digest('hex');
}

function scopeSql(req, aliases = {}) {
  if (canSeeAll(req)) return { sql: '', params: [] };
  const uid = ownerId(req);
  const payment = aliases.payment || 'p';
  const property = aliases.property || 'pr';
  const tenant = aliases.tenant || 't';
  return {
    sql: `AND (${payment}.owner_user_id = ? OR ${property}.owner_user_id = ? OR ${tenant}.owner_user_id = ?)`,
    params: [uid, uid, uid],
  };
}

function eligiblePayments(type, settings, req, today = todayLocalISO()) {
  const scope = scopeSql(req);
  const reminderClause = type === 'due_reminder'
    ? `AND DATE(p.due_date, '-' || ? || ' day') = DATE(?)`
    : `AND DATE(p.due_date, '+' || ? || ' day') <= DATE(?)`;
  const dayValue = type === 'due_reminder' ? settings.reminder_days_before_due : settings.overdue_days;
  return db.prepare(`
    SELECT p.*, t.name AS tenant_name, t.phone, t.sms_consent, t.sms_disabled,
           u.name AS unit_name, u.code AS unit_code, pr.name AS property_name
    FROM payments p
    JOIN tenants t ON t.id = p.tenant_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    WHERE p.due_date IS NOT NULL
      AND p.status IN ('pending', 'partial', 'overdue')
      AND COALESCE(p.total_paid, 0) < (COALESCE(p.rent_amount, 0) + COALESCE(p.media_amount, 0) + COALESCE(p.other_amount, 0))
      AND COALESCE(t.sms_consent, 0) = 1
      AND COALESCE(t.sms_disabled, 0) = 0
      ${reminderClause}
      AND NOT EXISTS (
        SELECT 1 FROM notification_logs nl
        WHERE nl.payment_id = p.id
          AND nl.type = ?
          AND nl.channel = 'sms'
          AND nl.status IN ('queued', 'sent', 'delivered')
      )
      ${scope.sql}
    ORDER BY p.due_date, t.name
  `).all(dayValue, today, type, ...scope.params);
}

function insertLog(row, type, phone, message, status = 'queued', error = null) {
  const result = db.prepare(`
    INSERT INTO notification_logs (
      owner_user_id, payment_id, tenant_id, unit_id, period, channel, type,
      recipient_phone, message_hash, message_text, status, attempts,
      error_code, error_message, next_attempt_at
    )
    VALUES (?, ?, ?, ?, ?, 'sms', ?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    row.owner_user_id || null,
    row.id,
    row.tenant_id,
    row.unit_id,
    row.period,
    type,
    phone,
    messageHash(message),
    message,
    status,
    error && error.code ? String(error.code) : null,
    error && error.message ? String(error.message) : null
  );
  return db.prepare('SELECT * FROM notification_logs WHERE id = ?').get(result.lastInsertRowid);
}

function updateLogSuccess(logId, providerMessageId, simulated = false) {
  db.prepare(`
    UPDATE notification_logs
    SET status = ?,
        attempts = attempts + 1,
        provider_message_id = ?,
        error_code = NULL,
        error_message = NULL,
        next_attempt_at = NULL,
        last_attempt_at = CURRENT_TIMESTAMP,
        sent_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(simulated ? 'simulated' : 'sent', providerMessageId || null, logId);
}

function providerDateToSql(value) {
  const m = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
}

function updateDeliveryStatus(log, delivery) {
  if (!delivery) return { id: log.id, status: log.status, changed: false, reason: 'delivery_row_missing' };
  if (delivery.delivered) {
    db.prepare(`
      UPDATE notification_logs
      SET status = 'delivered',
          error_code = NULL,
          error_message = NULL,
          delivered_at = COALESCE(?, delivered_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(providerDateToSql(delivery.deliveredAt), log.id);
    return { id: log.id, status: 'delivered', changed: log.status !== 'delivered' };
  }
  if (delivery.rejectReason) {
    db.prepare(`
      UPDATE notification_logs
      SET status = 'failed',
          error_code = 'delivery_rejected',
          error_message = ?,
          delivered_at = NULL
      WHERE id = ?
    `).run(delivery.rejectReason, log.id);
    return { id: log.id, status: 'failed', changed: log.status !== 'failed', error: delivery.rejectReason };
  }
  return { id: log.id, status: log.status, changed: false, reason: 'delivery_pending' };
}

function updateLogFailure(logId, errorCode, errorMessage, attemptsBefore, noRetry = false) {
  const attempts = attemptsBefore + 1;
  const retryDelay = RETRY_DELAYS_MINUTES[Math.min(attempts - 1, RETRY_DELAYS_MINUTES.length - 1)];
  const finalStatus = noRetry || attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
  db.prepare(`
    UPDATE notification_logs
    SET status = ?,
        attempts = ?,
        error_code = ?,
        error_message = ?,
        next_attempt_at = CASE WHEN ? = 'queued' THEN DATETIME('now', '+' || ? || ' minutes') ELSE NULL END,
        last_attempt_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalStatus, attempts, errorCode || null, errorMessage || 'send_failed', finalStatus, retryDelay, logId);
}

async function sendLog(log, settings) {
  const result = await sendSms({
    from: settings.sender,
    to: log.recipient_phone,
    msg: log.message_text,
    testMode: settings.test_mode,
    clearPolish: settings.clear_polish,
    transactional: settings.transactional,
  });
  if (result.ok) {
    updateLogSuccess(log.id, result.messageId, settings.test_mode);
    return { ok: true, id: log.id, message_id: result.messageId, status: settings.test_mode ? 'simulated' : 'sent' };
  }
  updateLogFailure(log.id, result.errorCode, result.errorMessage, Number(log.attempts || 0), log.type === 'test');
  return { ok: false, id: log.id, error: result.errorMessage, error_code: result.errorCode };
}

async function enqueueAndSend(row, type, settings, dryRun = false) {
  const actualPhone = normalizePhone(row.phone);
  const targetPhone = settings.test_mode && normalizePhone(settings.test_phone)
    ? normalizePhone(settings.test_phone)
    : actualPhone;
  const message = buildMessage(type, row, settings);
  if (!actualPhone) {
    const skipped = insertLog(row, type, null, message, 'skipped', { code: 'invalid_phone', message: 'invalid_phone' });
    return { status: 'skipped', reason: 'invalid_phone', id: skipped && skipped.id };
  }
  if (!targetPhone) {
    const skipped = insertLog(row, type, actualPhone, message, 'skipped', { code: 'test_phone_required', message: 'test_phone_required' });
    return { status: 'skipped', reason: 'test_phone_required', id: skipped && skipped.id };
  }
  if (dryRun) {
    return {
      status: 'candidate',
      tenant: row.tenant_name,
      period: row.period,
      unit: row.unit_code || row.unit_name,
      phone: targetPhone,
      message,
    };
  }
  const log = insertLog(row, type, targetPhone, message);
  if (!log) return { status: 'skipped', reason: 'already_logged' };
  const sent = await sendLog(log, settings);
  return sent.ok ? { status: sent.status || 'sent', id: log.id, message_id: sent.message_id } : { status: 'failed', id: log.id, error: sent.error };
}

async function runNotificationScan({ req = null, type = 'all', dryRun = false, today = todayLocalISO() } = {}) {
  const settings = getNotificationSettings(req);
  const types = type === 'all' ? ['due_reminder', 'overdue'] : [type];
  const result = { dry_run: dryRun, date: today, settings: { ...settings, token_configured: settings.token_configured }, scanned: 0, sent: 0, simulated: 0, failed: 0, skipped: 0, candidates: [] };
  for (const currentType of types) {
    if (currentType === 'due_reminder' && !settings.reminder_enabled) continue;
    const rows = eligiblePayments(currentType, settings, req, today);
    for (const row of rows) {
      result.scanned += 1;
      const item = await enqueueAndSend(row, currentType, settings, dryRun);
      if (dryRun) result.candidates.push({ type: currentType, ...item });
      else if (item.status === 'sent') result.sent += 1;
      else if (item.status === 'simulated') result.simulated += 1;
      else if (item.status === 'failed') result.failed += 1;
      else result.skipped += 1;
    }
  }
  return result;
}

function listLogs(req, limit = 80) {
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 300);
  const scope = canSeeAll(req) ? { sql: '', params: [] } : { sql: 'WHERE nl.owner_user_id = ?', params: [ownerId(req)] };
  return db.prepare(`
    SELECT nl.*, t.name AS tenant_name, u.code AS unit_code, u.name AS unit_name, pr.name AS property_name
    FROM notification_logs nl
    LEFT JOIN tenants t ON t.id = nl.tenant_id
    LEFT JOIN units u ON u.id = nl.unit_id
    LEFT JOIN properties pr ON pr.id = u.property_id
    ${scope.sql}
    ORDER BY nl.created_at DESC, nl.id DESC
    LIMIT ?
  `).all(...scope.params, safeLimit);
}

async function processDueRetries(req = null) {
  const settings = getNotificationSettings(req);
  const scope = canSeeAll(req) ? { sql: '', params: [] } : { sql: 'AND owner_user_id = ?', params: [ownerId(req)] };
  const logs = db.prepare(`
    SELECT *
    FROM notification_logs
    WHERE status = 'queued'
      AND type <> 'test'
      AND attempts < ?
      AND (next_attempt_at IS NULL OR DATETIME(next_attempt_at) <= DATETIME('now'))
      ${scope.sql}
    ORDER BY created_at ASC
    LIMIT 20
  `).all(MAX_ATTEMPTS, ...scope.params);
  const result = { retried: 0, sent: 0, simulated: 0, failed: 0 };
  for (const log of logs) {
    result.retried += 1;
    const sent = await sendLog(log, settings);
    if (sent.ok && sent.status === 'simulated') result.simulated = (result.simulated || 0) + 1;
    else if (sent.ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}

async function syncDeliveryStatuses(req = null, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const scope = canSeeAll(req) ? { sql: '', params: [] } : { sql: 'AND owner_user_id = ?', params: [ownerId(req)] };
  const logs = db.prepare(`
    SELECT *
    FROM notification_logs
    WHERE status = 'sent'
      AND provider_message_id IS NOT NULL
      AND provider_message_id <> '12345'
      ${scope.sql}
    ORDER BY sent_at DESC, id DESC
    LIMIT ?
  `).all(...scope.params, safeLimit);
  const result = { checked: 0, delivered: 0, failed: 0, pending: 0, errors: [] };
  for (const log of logs) {
    try {
      const info = await getMessageInfo({ messageIds: [log.provider_message_id] });
      const rows = parseMessageInfo(info.message);
      const expectedPhone = String(log.recipient_phone || '').replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');
      const delivery = rows.find(item => {
        const candidate = String(item.phone || '').replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');
        return candidate && candidate === expectedPhone;
      }) || rows[0];
      const updated = updateDeliveryStatus(log, delivery);
      result.checked += 1;
      if (updated.status === 'delivered') result.delivered += 1;
      else if (updated.status === 'failed') result.failed += 1;
      else result.pending += 1;
    } catch (err) {
      result.errors.push({ id: log.id, message_id: log.provider_message_id, error: err.message || 'status_sync_failed' });
    }
  }
  return result;
}

async function sendTestSms(req, phone, message) {
  const settings = getNotificationSettings(req);
  const normalized = normalizePhone(phone || settings.test_phone);
  if (!normalized) throw Object.assign(new Error('test_phone_required'), { status: 400 });
  const text = message || settings.template_test || DEFAULT_TEMPLATES.test;
  const fake = {
    id: null,
    owner_user_id: ownerId(req),
    tenant_id: null,
    unit_id: null,
    period: null,
  };
  const log = insertLog(fake, 'test', normalized, text);
  const sent = await sendLog(log, settings);
  return { ...sent, log_id: log.id, test_mode: settings.test_mode };
}

let schedulerState = { started: false, lastRunDate: null, timer: null };

function localHHMM(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function startNotificationScheduler() {
  if (schedulerState.started) return schedulerState;
  schedulerState.started = true;
  schedulerState.timer = setInterval(async () => {
    try {
      const settings = getNotificationSettings(null);
      if (!settings.enabled) return;
      await processDueRetries(null);
      const today = todayLocalISO();
      if (schedulerState.lastRunDate === today) return;
      if (localHHMM() < settings.send_time) return;
      schedulerState.lastRunDate = today;
      const result = await runNotificationScan({ type: 'all', today });
      console.log('[notifications] daily scan', JSON.stringify({ date: today, sent: result.sent, failed: result.failed, skipped: result.skipped, scanned: result.scanned }));
    } catch (err) {
      console.error('[notifications] scheduler error', err && err.message ? err.message : err);
    }
  }, 60 * 1000);
  if (schedulerState.timer.unref) schedulerState.timer.unref();
  return schedulerState;
}

module.exports = {
  getNotificationSettings,
  saveNotificationSettings,
  runNotificationScan,
  listLogs,
  processDueRetries,
  sendTestSms,
  syncDeliveryStatuses,
  startNotificationScheduler,
  normalizePhone,
};
