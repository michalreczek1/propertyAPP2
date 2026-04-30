'use strict';

const API_URL = process.env.SMSPLANET_API_URL || 'https://api2.smsplanet.pl/sms';
const INFO_API_URL = process.env.SMSPLANET_INFO_API_URL || 'https://api2.smsplanet.pl/getMessageInfo';

function tokenFromEnv() {
  return process.env.SMSPLANET_TOKEN || process.env.SMSPLANET_API_TOKEN || '';
}

function normalizeSmsPlanetResponse(data) {
  if (data && data.messageId) {
    return { ok: true, messageId: String(data.messageId), raw: data };
  }
  return {
    ok: false,
    errorCode: data && data.errorCode != null ? String(data.errorCode) : null,
    errorMessage: data && data.errorMsg ? String(data.errorMsg) : 'smsplanet_error',
    raw: data,
  };
}

async function sendSms({ token, from, to, msg, testMode, clearPolish, transactional }) {
  const bearer = token || tokenFromEnv();
  const sender = String(from || '').trim().toLowerCase() === 'test' ? 'TEST' : String(from || '').trim();
  if (!bearer) {
    const err = new Error('smsplanet_token_required');
    err.code = 'not_configured';
    throw err;
  }
  if (!sender) {
    const err = new Error('sms_sender_required');
    err.code = 'invalid_sender';
    throw err;
  }
  if (!to) {
    const err = new Error('recipient_phone_required');
    err.code = 'invalid_phone';
    throw err;
  }
  const body = new URLSearchParams();
  body.set('from', sender);
  body.set('to', to);
  body.set('msg', msg);
  if (testMode) body.set('test', '1');
  if (clearPolish) body.set('clear_polish', '1');
  if (transactional) body.set('transactional', '1');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { errorMsg: await response.text().catch(() => '') };
  }
  const normalized = normalizeSmsPlanetResponse(data);
  if (!response.ok && normalized.ok) normalized.ok = false;
  if (!normalized.ok && !normalized.errorMessage) normalized.errorMessage = `HTTP ${response.status}`;
  return { ...normalized, statusCode: response.status };
}

async function getMessageInfo({ token, messageIds }) {
  const bearer = token || tokenFromEnv();
  const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean) : [messageIds].filter(Boolean);
  if (!bearer) {
    const err = new Error('smsplanet_token_required');
    err.code = 'not_configured';
    throw err;
  }
  if (!ids.length) {
    const err = new Error('smsplanet_message_id_required');
    err.code = 'invalid_message_id';
    throw err;
  }
  const body = new URLSearchParams();
  for (const id of ids) body.append('messageId', String(id));
  body.set('responseType', 'json');

  const response = await fetch(INFO_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { errorMsg: await response.text().catch(() => '') };
  }
  if (!response.ok || !data || data.result !== 'OK') {
    const err = new Error(data && data.errorMsg ? data.errorMsg : `HTTP ${response.status}`);
    err.code = data && data.errorCode != null ? String(data.errorCode) : 'smsplanet_info_error';
    throw err;
  }
  return { ok: true, raw: data, message: String(data.message || '') };
}

function parseMessageInfo(report) {
  const text = String(report || '');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"') || !trimmed.includes(';')) continue;
    const cols = trimmed.split(';').map(part => part.replace(/^"|"$/g, '').trim());
    if (cols[0] === 'Numer telefonu') continue;
    rows.push({
      phone: cols[0] || '',
      delivered: /^tak$/i.test(cols[1] || ''),
      deliveredAt: cols[2] || '',
      rejectReason: cols[3] || '',
      charged: /^tak$/i.test(cols[4] || ''),
    });
  }
  return rows;
}

module.exports = { sendSms, getMessageInfo, parseMessageInfo };
