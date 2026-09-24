'use strict';

const crypto = require('crypto');

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

async function sendAccountEmail({ to, purpose, code }) {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_MODE === '1') return;
  if (!emailConfigured()) throw new Error('Resend is not configured');
  const isVerification = purpose === 'verify';
  const subject = isVerification ? 'Potwierdź adres e-mail w PropertyApp' : 'Odzyskiwanie hasła PropertyApp';
  const intro = isVerification
    ? 'Wpisz ten kod w formularzu, aby aktywować konto PropertyApp.'
    : 'Wpisz ten kod w formularzu, aby ustawić nowe hasło do PropertyApp.';
  const text = `${intro}\n\nKod: ${code}\n\nKod jest ważny przez 10 minut. Jeśli to nie Ty rozpocząłeś tę operację, zignoruj wiadomość.`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend rejected account email (${response.status})`);
  const payload = await response.json();
  if (!payload.id) throw new Error('Resend did not confirm account email');
}

async function verifyTurnstile(token, req) {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_MODE === '1') {
    return token === 'test-turnstile';
  }
  if (!process.env.TURNSTILE_SECRET_KEY || typeof token !== 'string' || !token || token.length > 2048)
    return false;
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
  if (req.ip) body.set('remoteip', req.ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true && result.hostname === 'propertyapp.familyos.pl';
  } catch {
    return false;
  }
}

function newCode() {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_MODE === '1') return '123456';
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { emailConfigured, newCode, sendAccountEmail, verifyTurnstile };
