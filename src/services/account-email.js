'use strict';

const crypto = require('crypto');

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function buildAccountEmail(purpose, code) {
  const isVerification = purpose === 'verify';
  const subject = isVerification ? 'Potwierdź adres e-mail w PropertyApp' : 'Odzyskiwanie hasła PropertyApp';
  const title = isVerification ? 'Potwierdź adres e-mail' : 'Ustaw nowe hasło';
  const intro = isVerification
    ? 'Dziękujemy za założenie konta. Wpisz poniższy kod, aby aktywować konto PropertyApp.'
    : 'Otrzymaliśmy prośbę o zmianę hasła do PropertyApp. Wpisz poniższy kod, aby ustawić nowe hasło.';
  const url = `https://propertyapp.familyos.pl/${isVerification ? 'verify-email' : 'forgot-password'}`;
  const text = `PropertyApp — ${title}\n\n${intro}\n\nKod: ${code}\n\nOtwórz formularz: ${url}\n\nKod jest ważny przez 10 minut. Jeśli to nie Ty rozpocząłeś tę operację, zignoruj tę wiadomość. Nigdy nie podawaj nikomu tego kodu ani hasła.\n\nPropertyApp · propertyapp.familyos.pl`;
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f3fa;font-family:Arial,Helvetica,sans-serif;color:#22213a"><span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${title} — kod ważny przez 10 minut.</span><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f3fa"><tr><td align="center" style="padding:32px 16px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e8e5f4;border-radius:18px"><tr><td style="padding:30px 32px 22px;border-bottom:1px solid #eeeaf8"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle;padding-right:12px"><img src="https://propertyapp.familyos.pl/propertyapp-email-logo.png" width="44" height="44" alt="" style="display:block;border:0;border-radius:12px"></td><td style="vertical-align:middle;font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#24213f">PropertyApp</td></tr></table><div style="font-size:12px;color:#6b6785;margin-top:10px">Panel do zarządzania najmem nieruchomości</div></td></tr><tr><td style="padding:32px"><h1 style="font-size:25px;line-height:1.3;margin:0 0 16px;color:#24213f">${title}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 24px;color:#45425e">${intro}</p><div style="background:#f3f0ff;border:1px solid #ddd4ff;border-radius:12px;padding:20px;text-align:center"><div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#6254aa;text-transform:uppercase">Twój kod</div><div style="font-size:36px;line-height:1.3;font-weight:700;letter-spacing:7px;color:#4d3cbb;margin-top:8px">${code}</div></div><p style="font-size:14px;line-height:1.6;color:#625f78;margin:20px 0 24px">Kod jest ważny przez 10 minut.</p><a href="${url}" style="display:inline-block;background:#7668e8;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 20px;border-radius:9px">Otwórz formularz</a><p style="font-size:13px;line-height:1.6;color:#77738d;margin:28px 0 0">Jeśli to nie Ty rozpocząłeś tę operację, zignoruj tę wiadomość. Nigdy nie podawaj nikomu tego kodu ani hasła.</p></td></tr><tr><td style="padding:18px 32px;border-top:1px solid #eeeaf8;font-size:12px;line-height:1.6;color:#858198">PropertyApp · <a href="https://propertyapp.familyos.pl/" style="color:#6254aa;text-decoration:none">propertyapp.familyos.pl</a></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function sendAccountEmail({ to, purpose, code }) {
  if (process.env.NODE_ENV === 'test' && process.env.AUTH_TEST_MODE === '1') return;
  if (!emailConfigured()) throw new Error('Resend is not configured');
  const { subject, text, html } = buildAccountEmail(purpose, code);
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
      html,
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

module.exports = { buildAccountEmail, emailConfigured, newCode, sendAccountEmail, verifyTurnstile };
