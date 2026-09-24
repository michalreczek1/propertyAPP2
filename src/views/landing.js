'use strict';

const fs = require('fs');
const path = require('path');

function publicAsset(name) {
  const file = path.join(__dirname, '..', '..', 'public', name);
  return `/${name}?v=${Math.floor(fs.statSync(file).mtimeMs)}`;
}

const brand =
  '<img class="brand-mark" src="/propertyapp-logo.svg" width="38" height="38" alt=""><span>PropertyApp</span>';

function renderLanding({ configMissing, registrationEnabled, encodedNext, isLoginPath }) {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PropertyApp – zarządzanie najmem, płatnościami i dokumentami</title>
  <meta name="description" content="PropertyApp pomaga właścicielom nieruchomości zarządzać lokalami, najemcami, umowami, płatnościami, kosztami i dokumentami w jednym miejscu.">
  <meta name="robots" content="${isLoginPath ? 'noindex,follow' : 'index,follow'}">
  <link rel="canonical" href="https://propertyapp.familyos.pl/">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="pl_PL">
  <meta property="og:site_name" content="PropertyApp">
  <meta property="og:title" content="PropertyApp – uporządkuj zarządzanie najmem">
  <meta property="og:description" content="Lokale, najemcy, umowy, płatności, koszty i dokumenty w jednym panelu.">
  <meta property="og:url" content="https://propertyapp.familyos.pl/">
  <meta name="theme-color" content="#070714">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${publicAsset('landing.css')}">
</head>
<body>
  <a class="skip-link" href="#main">Przejdź do treści</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="PropertyApp — strona główna">${brand}</a>
      <nav aria-label="Nawigacja główna">
        <a href="#funkcje">Funkcje</a>
        <a href="#jak-to-dziala">Jak to działa</a>
        <a href="#pytania">Pytania</a>
        <a class="nav-login" href="#konto">Zaloguj się</a>
      </nav>
    </div>
  </header>

  <main id="main">
    <section class="hero container" aria-labelledby="hero-title">
      <div class="hero-copy">
        <span class="eyebrow">Panel dla właścicieli nieruchomości na wynajem</span>
        <h1 id="hero-title">Najem pod kontrolą.<br><span>W jednym miejscu.</span></h1>
        <p class="lead">PropertyApp pomaga uporządkować lokale, najemców, umowy i rozliczenia. Sprawdzaj wpłaty, koszty oraz terminy bez przeskakiwania między arkuszami i dokumentami.</p>
        <div class="hero-actions"><a class="primary-link" href="${registrationEnabled ? '/register' : '#konto'}">${registrationEnabled ? 'Załóż konto' : 'Przejdź do logowania'}</a><a class="secondary-link" href="#podglad">Zobacz panel <span aria-hidden="true">↓</span></a></div>
        <p class="hero-note">Dostęp przez przeglądarkę · osobne dane dla każdego zwykłego konta</p>
      </div>
      <div class="account-card" id="konto">
        <div class="account-head"><span class="account-kicker">TWOJE KONTO</span><h2>Zaloguj się</h2><p>${configMissing ? 'Logowanie wymaga konfiguracji na serwerze.' : 'Wpisz dane konta, aby wejść do panelu.'}</p></div>
        <form id="login-form" data-next="${encodedNext}">
          <div class="error${configMissing ? ' on' : ''}" id="login-error" role="alert">${configMissing ? 'Logowanie nie jest obecnie dostępne.' : ''}</div>
          <label>Login<input name="username" autocomplete="username" required ${configMissing ? 'disabled' : ''}></label>
          <label>Hasło<input name="password" type="password" autocomplete="current-password" required ${configMissing ? 'disabled' : ''}></label>
          <button class="submit" type="submit" ${configMissing ? 'disabled' : ''}>Zaloguj się <span aria-hidden="true">→</span></button>
        </form>
        ${registrationEnabled ? '<div class="account-switch"><span>Nowy użytkownik?</span><a href="/register">Załóż konto</a></div>' : ''}
        <div class="account-foot">Bezpieczne połączenie · dostęp do własnych danych</div>
      </div>
    </section>

    <section class="section preview-section" id="podglad" aria-labelledby="preview-title"><div class="container">
      <div class="section-heading"><span class="eyebrow">TAK WYGLĄDA PROPERTYAPP</span><h2 id="preview-title">Zajrzyj do środka</h2><p>To zrzut ekranu działającego dashboardu. Dane na obrazie są przykładowe i zostały przygotowane wyłącznie do prezentacji.</p></div>
      <figure class="dashboard-preview">
        <div class="preview-scroll" tabindex="0" role="region" aria-label="Podgląd dashboardu, przewijany poziomo na telefonie">
          <img src="${publicAsset('dashboard-preview.png')}" width="2880" height="1800" loading="lazy" alt="Dashboard PropertyApp z przykładowymi danymi: przychód miesiąca, obłożenie lokali, lista płatności i statusy najmu.">
        </div>
        <figcaption><span>Rzeczywisty interfejs aplikacji · wyłącznie fikcyjne dane<span class="preview-swipe-hint"> · Przesuń obraz w bok</span></span><a href="${publicAsset('dashboard-preview.png')}" target="_blank" rel="noopener">Otwórz pełny obraz ↗</a></figcaption>
      </figure>
    </div></section>

    <section class="section feature-section" id="funkcje" aria-labelledby="features-title"><div class="container">
      <div class="section-heading"><span class="eyebrow">CO ZROBI PROPERTYAPP</span><h2 id="features-title">Codzienna obsługa najmu bez chaosu</h2><p>Najważniejsze informacje o wynajmie są połączone z właściwą nieruchomością, lokalem i najemcą.</p></div>
      <div class="feature-grid">
        <article class="feature"><span class="feature-icon" aria-hidden="true">⌂</span><h3>Nieruchomości i lokale</h3><p>Dodawaj nieruchomości, pokoje i lokale. Sprawdzaj obłożenie oraz podstawowe warunki najmu.</p></article>
        <article class="feature"><span class="feature-icon" aria-hidden="true">◇</span><h3>Najemcy i umowy</h3><p>Trzymaj dane najemców, etapy umów, aneksy i ważne terminy w jednym widoku.</p></article>
        <article class="feature"><span class="feature-icon" aria-hidden="true">↗</span><h3>Płatności i bank</h3><p>Śledź należności i wpłaty. Importuj wyciąg bankowy i potwierdzaj proponowane dopasowania.</p></article>
        <article class="feature"><span class="feature-icon" aria-hidden="true">▥</span><h3>Koszty i raporty</h3><p>Zapisuj wydatki i oglądaj miesięczne oraz roczne zestawienia przychodów, kosztów i wyniku.</p></article>
        <article class="feature"><span class="feature-icon" aria-hidden="true">□</span><h3>Dokumenty i zadania</h3><p>Przechowuj dokumenty związane z najmem i zapisuj sprawy, które wymagają działania.</p></article>
        <article class="feature"><span class="feature-icon" aria-hidden="true">✉</span><h3>Powiadomienia SMS</h3><p>Przygotuj przypomnienia o płatnościach. Do wysyłki potrzebne jest własne konto i token SMSPlanet.</p></article>
      </div>
    </div></section>

    <section class="section steps-section" id="jak-to-dziala" aria-labelledby="steps-title"><div class="container steps-layout">
      <div class="section-heading"><span class="eyebrow">PROSTY POCZĄTEK</span><h2 id="steps-title">Od pierwszego lokalu do pełnego obrazu najmu</h2><p>Wprowadź dane raz, a potem korzystaj z połączonych widoków i raportów.</p></div>
      <ol class="steps"><li><span>01</span><div><h3>Dodaj nieruchomość i lokal</h3><p>Utwórz strukturę swoich mieszkań lub pokoi.</p></div></li><li><span>02</span><div><h3>Powiąż najemcę i umowę</h3><p>Zapisz warunki najmu oraz dokumenty.</p></div></li><li><span>03</span><div><h3>Kontroluj rozliczenia</h3><p>Oznaczaj wpłaty, dodawaj koszty i sprawdzaj raporty.</p></div></li></ol>
    </div></section>

    <section class="section faq-section" id="pytania" aria-labelledby="faq-title"><div class="container">
      <div class="section-heading"><span class="eyebrow">WARTO WIEDZIEĆ</span><h2 id="faq-title">Najczęstsze pytania</h2></div>
      <div class="faq-grid">
        <div><h3>Dla kogo jest PropertyApp?</h3><p>Dla osób, które samodzielnie zarządzają wynajmowanymi nieruchomościami i chcą mieć dane operacyjne oraz rozliczenia w jednym panelu.</p></div>
        <div><h3>Czy inni użytkownicy widzą moje dane?</h3><p>Zwykłe konta mają oddzielne dane. Administrator serwisu ma dostęp do danych wszystkich kont w celu zarządzania aplikacją.</p></div>
        <div><h3>Czy SMS-y są wysyłane automatycznie?</h3><p>Użytkownik może ręcznie uruchomić podgląd i wysyłkę. Potrzebuje własnego konta SMSPlanet, tokenu API i środków u tego dostawcy.</p></div>
        <div><h3>Czy mogę korzystać na telefonie?</h3><p>Panel działa w przeglądarce i dopasowuje układ do mniejszych ekranów.</p></div>
      </div>
    </div></section>

    <section class="closing container"><div><span class="eyebrow">WSZYSTKO W JEDNYM PANELU</span><h2>Uporządkuj najem od dziś</h2><p>Dodaj pierwszą nieruchomość i zobacz, jak Twoje dane łączą się w spójny obraz.</p></div><a class="primary-link" href="${registrationEnabled ? '/register' : '#konto'}">${registrationEnabled ? 'Utwórz konto' : 'Zaloguj się'}</a></section>
  </main>
  <footer class="site-footer"><div class="container"><span>© ${new Date().getFullYear()} PropertyApp</span><span>Panel zarządzania najmem nieruchomości</span></div></footer>
  <script src="${publicAsset('login.js')}"></script>
</body>
</html>`;
}

function renderRegistration({ registrationEnabled }) {
  return `<!DOCTYPE html>
<html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,follow"><meta name="theme-color" content="#070714"><title>Załóż konto – PropertyApp</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${publicAsset('landing.css')}"></head>
<body><header class="site-header"><div class="container header-inner"><a class="brand" href="/" aria-label="PropertyApp — strona główna">${brand}</a><nav aria-label="Nawigacja"><a href="/">O serwisie</a><a class="nav-login" href="/login#konto">Zaloguj się</a></nav></div></header>
<main class="register-page container"><div class="account-card"><div class="account-head"><span class="account-kicker">NOWE KONTO</span><h1>Załóż konto</h1><p>${registrationEnabled ? 'Wypełnij formularz. Administrator sprawdzi zgłoszenie i aktywuje konto. Potem możesz się zalogować.' : 'Rejestracja jest obecnie niedostępna.'}</p></div>
${
  registrationEnabled
    ? `<form id="register-form"><div class="error" id="register-error" role="alert"></div>
<label>Imię lub nazwa<input name="display_name" autocomplete="name" required maxlength="120"></label>
<label>Login<input name="username" autocomplete="username" required minlength="3" maxlength="64" pattern="[a-zA-Z0-9._-]+"></label>
<label>Adres e-mail<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
<label>Hasło (minimum 12 znaków)<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200"></label>
<button class="submit" type="submit">Wyślij zgłoszenie <span aria-hidden="true">→</span></button></form>
<div id="register-success" class="register-success" role="status" hidden><h2>Zgłoszenie wysłane</h2><p>Konto czeka na aktywację przez administratora. Po zatwierdzeniu zaloguj się swoim loginem i hasłem.</p><a class="primary-link" href="/login#konto">Przejdź do logowania</a></div>`
    : ''
}
<div class="account-switch"><span>Masz już konto?</span><a href="/login#konto">Zaloguj się</a></div></div></main>
<script src="${publicAsset('login.js')}"></script></body></html>`;
}

module.exports = { renderLanding, renderRegistration };
