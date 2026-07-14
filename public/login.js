'use strict';

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');

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
        throw new Error(data.error === 'invalid_credentials'
          ? 'Nieprawidłowy login lub hasło.'
          : data.error || 'Błąd logowania');
      }
      let next = '/';
      try { next = decodeURIComponent(form.dataset.next || '%2F'); } catch {}
      location.href = next;
    } catch (error) {
      err.textContent = error.message;
      err.className = 'err on';
      button.disabled = false;
    }
  });
}
