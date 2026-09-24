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
if (registerForm && registerError) {
  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    registerError.className = 'error';
    const button = registerForm.querySelector('button');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(registerForm).entries());
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
      registerForm.hidden = true;
      document.getElementById('register-success').hidden = false;
    } catch (error) {
      registerError.textContent = error.message;
      registerError.className = 'error on';
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
              ? 'Konto czeka na aktywację przez administratora.'
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
