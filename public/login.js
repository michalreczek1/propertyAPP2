'use strict';

const previewOpen = document.getElementById('preview-open');
const previewDialog = document.getElementById('dashboard-dialog');
const previewClose = document.getElementById('preview-close');
if (previewOpen && previewDialog && previewClose) {
  previewOpen.addEventListener('click', () => previewDialog.showModal());
  previewClose.addEventListener('click', () => previewDialog.close());
  previewDialog.addEventListener('click', (event) => {
    if (event.target === previewDialog) previewDialog.close();
  });
}

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');
const registerForm = document.getElementById('register-form');
const registerError = document.getElementById('register-error');
function formBody(element) {
  const body = Object.fromEntries(new FormData(element).entries());
  if (body['cf-turnstile-response']) {
    body.captcha_token = body['cf-turnstile-response'];
    delete body['cf-turnstile-response'];
  }
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      captcha_failed: 'Potwierdź, że nie jesteś botem, i spróbuj ponownie.',
      invalid_code: 'Kod jest nieprawidłowy, wygasł lub przekroczono liczbę prób.',
      resend_cooldown: 'Poczekaj minutę przed ponowną wysyłką kodu.',
      too_many_attempts: 'Zbyt wiele prób. Spróbuj ponownie za 15 minut.',
      email_delivery_failed: 'Nie udało się wysłać wiadomości. Spróbuj ponownie później.',
      invalid_request: 'Sprawdź wpisane dane.',
    };
    throw new Error(messages[data.error] || 'Operacja nie powiodła się. Spróbuj ponownie.');
  }
  return data;
}

function showError(element, error) {
  element.textContent = error.message;
  element.className = 'error on';
  if (window.turnstile) window.turnstile.reset();
}

if (registerForm && registerError) {
  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    registerError.className = 'error';
    const button = registerForm.querySelector('button');
    button.disabled = true;
    try {
      const body = formBody(registerForm);
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data.error === 'username_exists'
            ? 'Ten login jest już zajęty.'
            : data.error === 'email_exists'
              ? 'Ten adres e-mail jest już używany.'
              : data.error === 'account_exists'
                ? 'Login lub adres e-mail jest już używany.'
                : data.error === 'too_many_attempts'
                  ? 'Zbyt wiele prób. Spróbuj ponownie za 15 minut.'
                  : 'Nie udało się utworzyć konta. Sprawdź dane.',
        );
      }
      location.href = `/verify-email?email=${encodeURIComponent(body.email)}`;
    } catch (error) {
      showError(registerError, error);
      button.disabled = false;
    }
  });
}

const verifyForm = document.getElementById('verify-form');
if (verifyForm) {
  verifyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = verifyForm.querySelector('button');
    const errorElement = document.getElementById('verify-error');
    errorElement.className = 'error';
    button.disabled = true;
    try {
      await postJson('/api/auth/verify-email', formBody(verifyForm));
      verifyForm.hidden = true;
      document.getElementById('resend-form').hidden = true;
      document.getElementById('verify-success').hidden = false;
    } catch (error) {
      showError(errorElement, error);
      button.disabled = false;
    }
  });
}

const resendForm = document.getElementById('resend-form');
if (resendForm) {
  resendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = resendForm.querySelector('button');
    const errorElement = document.getElementById('resend-error');
    errorElement.className = 'error';
    button.disabled = true;
    try {
      await postJson('/api/auth/verification/resend', formBody(resendForm));
      errorElement.textContent = 'Jeśli konto czeka na potwierdzenie, wysłaliśmy nowy kod.';
      errorElement.className = 'account-message on';
    } catch (error) {
      showError(errorElement, error);
    } finally {
      button.disabled = false;
      if (window.turnstile) window.turnstile.reset();
    }
  });
}

const forgotForm = document.getElementById('forgot-form');
if (forgotForm) {
  forgotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = forgotForm.querySelector('button');
    const errorElement = document.getElementById('forgot-error');
    errorElement.className = 'error';
    button.disabled = true;
    try {
      const body = formBody(forgotForm);
      await postJson('/api/auth/password/forgot', body);
      document.querySelector('#reset-form input[name="email"]').value = body.email;
      document.getElementById('forgot-success').hidden = false;
    } catch (error) {
      showError(errorElement, error);
    } finally {
      button.disabled = false;
      if (window.turnstile) window.turnstile.reset();
    }
  });
}

const resetForm = document.getElementById('reset-form');
if (resetForm) {
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = resetForm.querySelector('button');
    const errorElement = document.getElementById('reset-error');
    errorElement.className = 'error';
    button.disabled = true;
    try {
      await postJson('/api/auth/password/reset', formBody(resetForm));
      resetForm.hidden = true;
      forgotForm.hidden = true;
      document.getElementById('forgot-success').hidden = true;
      document.getElementById('reset-success').hidden = false;
    } catch (error) {
      showError(errorElement, error);
      button.disabled = false;
    }
  });
}

if (form && err) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    err.className = 'error';
    err.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data.error === 'invalid_credentials'
            ? 'Nieprawidłowy login lub hasło.'
            : data.error === 'account_pending'
              ? 'Konto czeka na potwierdzenie adresu e-mail. Sprawdź pocztę lub otwórz stronę potwierdzenia.'
              : data.error || 'Błąd logowania',
        );
      }
      let next = '/';
      try {
        next = decodeURIComponent(form.dataset.next || '%2F');
      } catch {}
      location.href = next;
    } catch (error) {
      err.textContent = error.message;
      err.className = 'error on';
      button.disabled = false;
    }
  });
}
