'use strict';

const API_URL = process.env.SMSPLANET_API_URL || 'https://api2.smsplanet.pl/sms';

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
  if (!bearer) {
    const err = new Error('smsplanet_token_required');
    err.code = 'not_configured';
    throw err;
  }
  if (!from) {
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
  body.set('from', from);
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

module.exports = { sendSms };
