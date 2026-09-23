'use strict';

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');
const registerForm = document.getElementById('register-form');
const registerError = document.getElementById('register-error');
const modeButton = document.getElementById('auth-mode');

if (registerForm && registerError && modeButton && form) {
  modeButton.addEventListener('click', () => {
    const registering = registerForm.hidden;
    registerForm.hidden = !registering;
    form.hidden = registering;
    modeButton.textContent = registering ? 'Mam już konto — zaloguj' : 'Utwórz konto';
  });
  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    registerError.className = 'err';
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
            : data.error === 'too_many_attempts'
              ? 'Zbyt wiele prób. Spróbuj ponownie za 15 minut.'
              : 'Nie udało się utworzyć konta. Sprawdź dane.',
        );
      }
      location.href = '/';
    } catch (error) {
      registerError.textContent = error.message;
      registerError.className = 'err on';
      button.disabled = false;
    }
  });
}

if (form && err) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    err.className = 'err';
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
      err.className = 'err on';
      button.disabled = false;
    }
  });
}
