/* PropertyApp Nova — frontend SPA (dark theme).
 * Vanilla JS + fetch + Chart.js. Router: hash → render.
 * Zachowuje pełną logikę CRUD/akcji z poprzedniej wersji, podpięte pod istniejące /api/*.
 */
'use strict';

// ─── KONSTANTY ──────────────────────────────────────────────────────
const PL_MONTHS = [
  'styczeń',
  'luty',
  'marzec',
  'kwiecień',
  'maj',
  'czerwiec',
  'lipiec',
  'sierpień',
  'wrzesień',
  'październik',
  'listopad',
  'grudzień',
];
const PL_MONTHS_SHORT = ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru'];
const PL_MONTHS_FULL_TITLE = [
  'Styczeń',
  'Luty',
  'Marzec',
  'Kwiecień',
  'Maj',
  'Czerwiec',
  'Lipiec',
  'Sierpień',
  'Wrzesień',
  'Październik',
  'Listopad',
  'Grudzień',
];
const AV_PALETTE = [
  ['rgba(16,185,129,0.15)', '#10b981'],
  ['rgba(6,182,212,0.15)', '#06b6d4'],
  ['rgba(139,92,246,0.15)', '#8b5cf6'],
  ['rgba(245,158,11,0.15)', '#f59e0b'],
  ['rgba(244,63,94,0.15)', '#f43f5e'],
  ['rgba(34,211,238,0.15)', '#22d3ee'],
  ['rgba(167,139,250,0.15)', '#a78bfa'],
  ['rgba(52,211,153,0.15)', '#34d399'],
];

const STATUS_CHIP = {
  paid: { cls: 'chip-e', label: 'Opłacona', icon: '<polyline points="20 6 9 17 4 12"/>' },
  pending: {
    cls: 'chip-n',
    label: 'Oczekująca',
    icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  },
  overdue: {
    cls: 'chip-r',
    label: 'Zaległa',
    icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  },
  partial: { cls: 'chip-a', label: 'Częściowa', icon: '<circle cx="12" cy="12" r="10"/>' },
};

// ─── STAN GLOBALNY ──────────────────────────────────────────────────
const State = {
  period: currentPeriodISO(),
  charts: {},
  paymentsFilter: 'all',
  paymentsQ: '',
  expCat: 'all',
  expProp: '',
  reportProp: 'all',
  contractsStatus: 'all',
  bankStatus: 'all',
  documentStatus: 'all',
  tenantsStatus: 'active',
  tenantsQ: '',
  auth: null,
  assistantLastResult: null,
};

let activeVoiceRecognition = null;

function currentPeriodISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodLabel(p) {
  if (!p) return '';
  const [y, m] = p.split('-').map(Number);
  return `${PL_MONTHS[m - 1]} ${y}`;
}
function periodTitleCase(p) {
  if (!p) return '';
  const [y, m] = p.split('-').map(Number);
  return `${PL_MONTHS_FULL_TITLE[m - 1]} ${y}`;
}
function shiftPeriod(p, delta) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function periodFromDateISO(date) {
  return String(date || todayISO()).slice(0, 7);
}
function monthEndISO(period) {
  const [y, m] = String(period || currentPeriodISO())
    .split('-')
    .map(Number);
  const d = new Date(y, m, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── HELPERY FORMATU ────────────────────────────────────────────────
function fmtPLN(v) {
  if (v == null || v === '') return '0';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
// Format PLN z wymuszoną dokładnością 2 miejsc po przecinku — dla podatku, kwot z groszami
function fmtPLN2(v) {
  if (v == null || v === '') return '0,00';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('pl-PL');
}
function fmtDateShort(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
function fmtDateTimeLocal(d) {
  if (!d) return '—';
  const raw = String(d);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const dt = new Date(iso);
  if (isNaN(dt)) return raw.slice(0, 16);
  return dt.toLocaleString('pl-PL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function costCategoryLabel(category) {
  return (
    {
      czynsz: 'Czynsz',
      prad: 'Prąd',
      internet: 'Internet',
      remonty: 'Remonty',
      doplata: 'Dopłata do czynszu',
      zarzadzanie: 'Zarządzanie',
      kredyt: 'Kredyt',
      inne: 'Inne',
    }[category] || category
  );
}
function avatarInitial(name) {
  return name ? name.trim().slice(0, 1).toUpperCase() : '?';
}
function colorForName(name) {
  if (!name) return AV_PALETTE[0];
  const code = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AV_PALETTE[code % AV_PALETTE.length];
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Starsze widoki generują przyciski z `onclick`. CSP blokuje wykonywanie
// atrybutów inline, dlatego przed interakcją zamieniamy je na listenery z
// kontrolowaną listą funkcji i bez dynamicznej ewaluacji JavaScript.
const LEGACY_CLICK_ACTIONS = new Set([
  'editPayment',
  'deletePayment',
  'editProperty',
  'openTenantDetails',
  'editContract',
  'endContractFlow',
  'tenantTurnover',
  'editUnit',
  'openSmsReminderPreview',
  'resolveLateFee',
  'openContractDocuments',
  'openContractWorkflow',
  'deleteContract',
  'deleteContractDocument',
  'editOwnerMortgageCost',
  'editExpense',
  'deleteExpense',
  'toggleTask',
  'editTask',
  'deleteTask',
  'deleteDoc',
]);

const cspStyleClasses = new Map();
let cspStyleSheet = null;

function cspStyleClass(styleText) {
  const existing = cspStyleClasses.get(styleText);
  if (existing) return existing;
  const nonce = document.querySelector('meta[name="csp-style-nonce"]')?.content;
  if (!nonce) return null;
  if (!cspStyleSheet) {
    const style = document.createElement('style');
    style.nonce = nonce;
    document.head.appendChild(style);
    cspStyleSheet = style.sheet;
  }
  const className = `csp-style-${cspStyleClasses.size + 1}`;
  try {
    cspStyleSheet.insertRule(`.${className}{${styleText}}`, cspStyleSheet.cssRules.length);
  } catch {
    return null;
  }
  cspStyleClasses.set(styleText, className);
  return className;
}

function hydrateInlineStyles(root) {
  const nodes = [];
  if (root instanceof Element && root.matches('[style]')) nodes.push(root);
  if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[style]'));
  for (const node of nodes) {
    const styleText = node.getAttribute('style');
    if (!styleText) continue;
    const className = cspStyleClass(styleText);
    if (!className) continue;
    node.classList.add(className);
    node.removeAttribute('style');
  }
}

function parseLegacyActionArgs(raw) {
  if (!raw.trim()) return [];
  return raw.split(',').map((part) => {
    const value = part.trim();
    if (value === 'null') return null;
    if (/^\d+$/.test(value)) return Number(value);
    const quoted = value.match(/^'([^']*)'$/);
    if (quoted && /^[0-9-]+$/.test(quoted[1])) return quoted[1];
    throw new Error('Unsupported legacy action argument');
  });
}

function bindLegacyClickActions(root) {
  const nodes = [];
  if (root instanceof Element && root.matches('[onclick]')) nodes.push(root);
  if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[onclick]'));
  for (const node of nodes) {
    if (node.dataset.cspBound === '1') continue;
    const match = String(node.getAttribute('onclick') || '').match(/^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/);
    if (!match || !LEGACY_CLICK_ACTIONS.has(match[1])) continue;
    let args;
    try {
      args = parseLegacyActionArgs(match[2]);
    } catch {
      continue;
    }
    node.removeAttribute('onclick');
    node.dataset.cspBound = '1';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      const handler = window[match[1]];
      if (typeof handler !== 'function') return;
      Promise.resolve(handler(...args)).catch((error) => toast(error.message || 'Błąd akcji', 'err'));
    });
  }
}
function deltaPill(delta, opts = {}) {
  if (delta == null || !Number.isFinite(delta) || delta === 0)
    return `<span class="delta-n">— bez zmian</span>`;
  const pct = (delta * 100).toFixed(1);
  if (delta > 0) return `<span class="delta-up">▲ ${pct}% vs poprzedni</span>`;
  return `<span class="delta-dn">▼ ${Math.abs(pct)}% vs poprzedni</span>`;
}
function chip(kind, text, withIcon) {
  const k = kind || 'chip-n';
  const icon = withIcon ? `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>` : '';
  return `<span class="chip ${k}">${icon}${escapeHtml(text)}</span>`;
}
function avatar(name) {
  const [bg, fg] = colorForName(name);
  return `<div class="av" style="background:${bg};color:${fg}">${avatarInitial(name)}</div>`;
}
function avatarLg(name) {
  const [bg, fg] = colorForName(name);
  return `<div class="av av-lg" style="background:${bg};color:${fg}">${avatarInitial(name)}</div>`;
}
function emptyState(msg, sub) {
  return `<div class="empty"><div class="empty-title">${escapeHtml(msg || '')}</div>${sub ? `<div class="empty-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}
function contractTerms(contract) {
  const terms = contract?.current_terms || {};
  const projected = contract?.projected_terms || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(terms, key);
  return {
    rent: Number(has('rent') ? terms.rent : (contract?.effective_rent ?? contract?.rent ?? 0)),
    media_advance: Number(
      has('media_advance')
        ? terms.media_advance
        : (contract?.effective_media_advance ?? contract?.media_advance ?? 0),
    ),
    pay_by_day: Number(
      has('pay_by_day') ? terms.pay_by_day : (contract?.effective_pay_by_day ?? contract?.pay_by_day ?? 31),
    ),
    end_date:
      projected.end_date ??
      contract?.projected_end_date ??
      (has('end_date') ? terms.end_date : (contract?.effective_end_date ?? contract?.end_date ?? null)),
  };
}
function contractStatusState(status, endDate, workflowStage) {
  if (workflowStage === 'archived') return { cls: 'chip-n', label: 'Archiwum', days: null };
  if (status === 'ended') return { cls: 'chip-n', label: 'Zakończona', days: null };
  if (status === 'planned') {
    if (workflowStage === 'awaiting_documents') return { cls: 'chip-a', label: 'Dokumenty', days: null };
    if (workflowStage === 'awaiting_signature') return { cls: 'chip-c', label: 'Do podpisu', days: null };
    return { cls: 'chip-n', label: 'Szkic', days: null };
  }
  if (status !== 'active') return { cls: 'chip-n', label: status || '—', days: null };
  if (workflowStage === 'ending') return { cls: 'chip-a', label: 'Wygaszanie', days: null };
  const days = endDate ? Math.ceil((new Date(endDate) - Date.now()) / 86400000) : null;
  if (days != null && days < 0) return { cls: 'chip-r', label: 'Po terminie', days };
  if (days != null && days <= 30) return { cls: 'chip-a', label: 'Wygasa', days };
  return { cls: 'chip-e', label: 'Aktywna', days };
}
function contractStatusChip(status, endDate, workflowStage) {
  const state = contractStatusState(status, endDate, workflowStage);
  return chip(state.cls, state.label, state.label === 'Aktywna');
}
function amendmentStatusChip(amendment) {
  if (amendment.status === 'cancelled') return chip('chip-n', 'Anulowany');
  if (amendment.status !== 'signed') return chip('chip-a', 'Szkic');
  return chip('chip-e', 'Podpisany', true);
}
function amendmentChangesLabel(amendment) {
  const changes = [];
  if (amendment.new_end_date) changes.push(`termin do ${fmtDate(amendment.new_end_date)}`);
  if (amendment.rent != null) changes.push(`czynsz ${fmtPLN(amendment.rent)} zł`);
  if (amendment.media_advance != null) changes.push(`media ${fmtPLN(amendment.media_advance)} zł`);
  if (amendment.pay_by_day != null) changes.push(`płatność do ${amendment.pay_by_day}.`);
  return changes.length ? changes.join(' · ') : 'Bez zmiany warunków finansowych';
}
function amendmentErrorLabel(error) {
  const code = String(error || '');
  return (
    {
      amendment_number_exists: 'Ten numer aneksu jest już użyty przy tej umowie.',
      amendment_change_or_note_required: 'Wskaż zmianę warunków albo dodaj notatkę wyjaśniającą aneks.',
      amendment_end_before_effective_date:
        'Nowa data końca nie może być wcześniejsza niż data obowiązywania.',
      amendment_signed_date_required: 'Podaj datę podpisania aneksu.',
      signed_amendment_document_required: 'Podpisany aneks wymaga dołączonego pliku PDF, JPG albo PNG.',
      invalid_file_signature: 'Wybrany plik nie jest poprawnym plikiem PDF, JPG ani PNG.',
      unsupported_file_type_pdf_jpg_only: 'Dozwolone są wyłącznie pliki PDF, JPG i PNG.',
      signed_amendment_correction_required:
        'Podpisanego aneksu nie można zmienić w zakresie warunków. Użyj korekty.',
      amendment_document_archived: 'Najpierw przywróć plik aneksu z archiwum.',
      amendment_document_not_for_contract: 'Plik nie należy do wskazanej umowy.',
      amendment_requires_active_contract: 'Aneks można dodać wyłącznie do aktywnej umowy najemcy.',
    }[code] ||
    code ||
    'Nie udało się zapisać aneksu.'
  );
}
function spinner() {
  return `<div style="padding:32px;text-align:center"><span class="spinner"></span></div>`;
}
function roleLabel(role) {
  return role === 'admin' ? 'Administrator' : 'Użytkownik';
}
function initials(name) {
  return (
    String(name || 'PM')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0])
      .join('')
      .toUpperCase() || 'PM'
  );
}

// ─── API ────────────────────────────────────────────────────────────
const Api = {
  async req(method, path, body, isFile) {
    const opts = { method, headers: {} };
    if (body != null && !isFile) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (isFile) {
      opts.body = body;
    }
    const r = await fetch('/api' + path, opts);
    let data = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        data = await r.json();
      } catch {
        data = null;
      }
    } else {
      data = await r.text();
    }
    if (!r.ok) {
      if (r.status === 401 && !path.startsWith('/auth/')) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
      }
      const err = new Error((data && data.error) || 'HTTP ' + r.status);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  get: (p) => Api.req('GET', p),
  post: (p, b) => Api.req('POST', p, b),
  put: (p, b) => Api.req('PUT', p, b),
  del: (p) => Api.req('DELETE', p),
  upload: (p, fd) => Api.req('POST', p, fd, true),
};

// ─── TOAST ──────────────────────────────────────────────────────────
function toast(msg, kind = 'ok', ms = 2800) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 180);
  }, ms);
}

// ─── MODAL / FORM ───────────────────────────────────────────────────
function modal({ title, body, footer, wide, onClose }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal${wide ? ' wide' : ''}">
        <div class="modal-hd">
          <div class="modal-title">${escapeHtml(title || '')}</div>
          <button class="modal-close" id="m-close">×</button>
        </div>
        <div class="modal-body">${body || ''}</div>
        ${footer ? `<div class="modal-ft">${footer}</div>` : ''}
      </div>
    </div>`;
  hydrateInlineStyles(root);
  bindLegacyClickActions(root);
  const close = () => {
    root.innerHTML = '';
    if (onClose) onClose();
  };
  root.querySelector('#m-close').onclick = close;
  root.querySelector('.modal-overlay').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) close();
  });
  return { close, root: root.querySelector('.modal') };
}

function confirmDialog({ title = 'Potwierdź', message, danger, onYes }) {
  const m = modal({
    title,
    body: `<div style="padding:22px 26px;font-size:13.5px;color:var(--t2);line-height:1.55">${escapeHtml(message || '')}</div>`,
    footer: `
      <button class="tb-btn tb-ghost" id="cf-no">Anuluj</button>
      <button class="tb-btn ${danger ? 'tb-danger' : 'tb-primary'}" id="cf-yes">Tak, kontynuuj</button>`,
  });
  m.root.querySelector('#cf-no').onclick = m.close;
  m.root.querySelector('#cf-yes').onclick = async () => {
    m.close();
    try {
      await onYes();
    } catch (e) {
      toast(e.message || 'Błąd', 'err');
    }
  };
}

function formModal({ title, fields, initial = {}, onSubmit, wide, submitLabel = 'Zapisz' }) {
  const fd = initial || {};
  const html = `<form id="m-form" class="form-grid">${fields.map((f) => fieldHtml(f, fd)).join('')}</form>`;
  const m = modal({
    title,
    body: html,
    wide,
    footer: `
      <button class="tb-btn tb-ghost" id="m-cancel">Anuluj</button>
      <button class="tb-btn tb-primary" id="m-submit">${escapeHtml(submitLabel)}</button>`,
  });
  m.root.querySelector('#m-cancel').onclick = m.close;
  m.root.querySelector('#m-submit').onclick = async () => {
    const form = m.root.querySelector('#m-form');
    const obj = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (f.type === 'number' && v !== '') v = Number(v);
      if (v === '') v = null;
      obj[f.name] = v;
    }
    try {
      await onSubmit(obj);
      m.close();
    } catch (e) {
      toast(e.message || 'Błąd zapisu', 'err');
    }
  };
}

function fieldHtml(f, vals) {
  const v = vals[f.name] != null ? vals[f.name] : (f.default ?? '');
  const cls = `form-row${f.full ? ' full' : ''}`;
  let input;
  if (f.type === 'select') {
    input = `<select name="${f.name}">${(f.options || [])
      .map(
        (o) =>
          `<option value="${escapeHtml(o.value)}"${String(o.value) == String(v) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      )
      .join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(v)}</textarea>`;
  } else if (f.type === 'checkbox') {
    input = `<input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}>`;
  } else {
    input = `<input type="${f.type || 'text'}" name="${f.name}" value="${escapeHtml(v)}" placeholder="${escapeHtml(f.placeholder || '')}"${f.step ? ` step="${f.step}"` : ''}${f.required ? ' required' : ''}${f.readonly ? ' readonly' : ''}>`;
  }
  return `<div class="${cls}"><label>${escapeHtml(f.label)}</label>${input}${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ''}</div>`;
}

// ─── TOPBAR / PERIOD ────────────────────────────────────────────────
function setTopbar(title, sub, actions) {
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent = sub || '';
  const right = document.getElementById('topbar-actions');
  right.innerHTML = `
    <button class="tb-btn tb-ghost" data-period="-1" title="Poprzedni miesiąc">‹</button>
    <button class="tb-btn tb-ghost" id="period-btn">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      ${escapeHtml(periodTitleCase(State.period))}
    </button>
    <button class="tb-btn tb-ghost" data-period="+1" title="Następny miesiąc">›</button>
    ${actions || ''}
    <button class="tb-btn tb-ghost" id="account-btn" title="Konto">
      <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Konto
    </button>
    <button class="tb-btn tb-ghost" id="logout-btn" title="Wyloguj">
      <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Wyloguj
    </button>`;
  right.querySelectorAll('[data-period]').forEach((b) => {
    b.onclick = () => {
      State.period = shiftPeriod(State.period, +b.dataset.period);
      render();
    };
  });
  right.querySelector('#period-btn').onclick = () => openPeriodPicker();
  right.querySelector('#account-btn').onclick = () => openAccountPanel();
  right.querySelector('#logout-btn').onclick = () => logout();
}

async function logout() {
  try {
    await Api.post('/auth/logout', {});
  } catch {}
  location.href = '/login';
}

function openPeriodPicker() {
  formModal({
    title: 'Wybierz okres',
    fields: [
      {
        name: 'period',
        label: 'Miesiąc (YYYY-MM)',
        type: 'text',
        placeholder: '2026-04',
        default: State.period,
        full: true,
      },
    ],
    onSubmit: ({ period }) => {
      if (!/^\d{4}-\d{2}$/.test(period || '')) throw new Error('Format YYYY-MM');
      State.period = period;
      render();
    },
  });
}

function openAssistantResultPanel() {
  const body = `
    <div class="assistant-panel">
      <div id="assistant-result">${assistantResultHtml(State.assistantLastResult)}</div>
    </div>`;
  const m = modal({ title: 'Wynik komendy', body, wide: true });
  bindAssistantResult(m.root.querySelector('#assistant-result'), m);
}

function assistantResultHtml(result) {
  if (!result) {
    return `
      <div class="assistant-empty">
        <div class="assistant-examples">
          <button type="button" data-example="Kowalski zapłacił">Kowalski zapłacił</button>
          <button type="button" data-example="Ile wynosi podatek za ten miesiąc?">Ile wynosi podatek?</button>
          <button type="button" data-example="Wyślij SMS z przypomnieniem do Kowalskiego">Wyślij SMS</button>
        </div>
      </div>`;
  }
  const cls = result.ok ? (result.status === 'answer' ? 'answer' : 'ready') : result.status || 'blocked';
  const aiNote =
    result.ai && result.ai.warning
      ? `<div class="assistant-note">${escapeHtml(result.ai.warning)}</div>`
      : '';
  const tax = result.tax
    ? `
    <div class="assistant-grid">
      <div><span>Podstawa</span><b>${fmtPLN(result.tax.base)} zł</b></div>
      <div><span>Stawka</span><b>${fmtPLN(result.tax.rate)}%</b></div>
      <div><span>Ryczałt</span><b>${fmtPLN(result.tax.podatek)} zł</b></div>
      <div><span>Razem</span><b>${fmtPLN(result.tax.podatek_suma)} zł</b></div>
    </div>`
    : '';
  const payment = result.payment
    ? `
    <div class="assistant-grid">
      <div><span>Najemca</span><b>${escapeHtml(result.payment.tenant_name || '—')}</b></div>
      <div><span>Lokal</span><b>${escapeHtml(result.payment.unit || '—')}</b></div>
      <div><span>Status</span><b>${escapeHtml(STATUS_CHIP[result.payment.status]?.label || result.payment.status || '—')}</b></div>
      <div><span>Kwota</span><b>${fmtPLN(result.payment.amount)} zł</b></div>
    </div>`
    : '';
  const sms =
    result.preview && result.preview.message
      ? `
    <div class="assistant-sms">
      <div class="assistant-sms-meta">${escapeHtml(result.preview.test_mode ? 'Tryb testowy' : 'Wysyłka produkcyjna')} · ${escapeHtml(result.preview.phone || '')}</div>
      <div>${escapeHtml(result.preview.message)}</div>
      ${result.preview.token_configured === false ? '<div class="assistant-note warn">Brak tokenu SMSPlanet - wysyłka nie powiedzie się, dopóki nie uzupełnisz konfiguracji.</div>' : ''}
    </div>`
      : '';
  const candidates =
    result.candidates && result.candidates.length
      ? `
    <div class="assistant-candidates">
      ${result.candidates
        .slice(0, 6)
        .map(
          (c) =>
            `<div>${escapeHtml(c.tenant_name || '—')} · ${escapeHtml(c.unit || '—')} · ${escapeHtml(c.status || '—')} · ${fmtPLN(c.amount)} zł</div>`,
        )
        .join('')}
    </div>`
      : '';
  const items =
    result.items && result.items.length
      ? `
    <div class="assistant-candidates">
      ${result.items
        .slice(0, 10)
        .map(
          (
            item,
          ) => `<button class="assistant-item" type="button" data-item-view="${escapeHtml(item.view || (item.navigation && item.navigation.view) || '')}" data-item-title="${escapeHtml(item.title || '')}" data-item-state="${escapeHtml(JSON.stringify(item.state || (item.navigation && item.navigation.state) || {}))}">
        <b>${escapeHtml(item.title || '—')}</b>
        <span>${escapeHtml(item.subtitle || item.type || '')}</span>
      </button>`,
        )
        .join('')}
    </div>`
      : '';
  const checks =
    result.checks && result.checks.length
      ? `
    <div class="assistant-grid assistant-checks">
      ${result.checks.map((c) => `<div><span>${escapeHtml(c.label)}</span><b>${fmtPLN(c.count || 0)}</b></div>`).join('')}
    </div>`
      : '';
  const nav = result.navigation
    ? `
    <div class="assistant-actions">
      <button class="tb-btn tb-ghost" id="assistant-navigate">Przejdź do widoku</button>
    </div>`
    : '';
  const action =
    result.action && result.action.token
      ? `
    <div class="assistant-actions">
      <button class="tb-btn tb-primary" id="assistant-execute" data-token="${escapeHtml(result.action.token)}">${escapeHtml(result.action.label || 'Wykonaj')}</button>
    </div>`
      : '';
  return `
    <div class="assistant-result ${escapeHtml(cls)}">
      <div class="assistant-result-title">${escapeHtml(result.title || 'Wynik komendy')}</div>
      <div class="assistant-result-message">${escapeHtml(result.message || '')}</div>
      ${aiNote}
      ${tax}
      ${payment}
      ${sms}
      ${candidates}
      ${items}
      ${checks}
      ${nav}
      ${action}
    </div>`;
}

function bindAssistantResult(root, modalRef) {
  if (!root) return;
  root.querySelectorAll('[data-example]').forEach((btn) => {
    btn.onclick = () => {
      const input = document.getElementById('global-search');
      if (input) {
        input.value = btn.dataset.example;
        input.focus();
        modalRef.close();
      }
    };
  });
  const execute = root.querySelector('#assistant-execute');
  if (execute) {
    execute.onclick = async () => {
      execute.disabled = true;
      try {
        const result = await Api.post('/assistant/execute', { token: execute.dataset.token });
        toast(result.message || 'Wykonano', 'ok');
        State.assistantLastResult = result;
        modalRef.close();
        render();
      } catch (err) {
        execute.disabled = false;
        toast(err.message || 'Nie udało się wykonać akcji', 'err');
      }
    };
  }
  const nav = root.querySelector('#assistant-navigate');
  if (nav && State.assistantLastResult) {
    nav.onclick = () => {
      applyAssistantNavigation(State.assistantLastResult.navigation);
      modalRef.close();
    };
  }
  root.querySelectorAll('[data-item-view]').forEach((btn) => {
    btn.onclick = () => {
      const view = btn.dataset.itemView;
      if (view) {
        let state = {};
        try {
          state = JSON.parse(btn.dataset.itemState || '{}');
        } catch {
          state = {};
        }
        if (state && typeof state === 'object') Object.assign(State, state);
        navigate(view);
      }
      modalRef.close();
    };
  });
}

function applyAssistantNavigation(navigation) {
  if (!navigation || !navigation.view) return;
  if (navigation.state && typeof navigation.state === 'object') {
    Object.assign(State, navigation.state);
  }
  navigate(navigation.view);
}

async function runCommandBar(message) {
  const q = String(message || '').trim();
  if (!q) return;
  const input = document.getElementById('global-search');
  if (input) input.disabled = true;
  try {
    const result = await Api.post('/assistant/parse', { message: q, period: State.period });
    State.assistantLastResult = result;
    if (result.status === 'navigate' && result.navigation) {
      applyAssistantNavigation(result.navigation);
      toast(result.title || 'Gotowe');
      return;
    }
    openAssistantResultPanel();
  } catch (err) {
    toast(err.message || 'Nie udało się wykonać komendy', 'err');
  } finally {
    if (input) {
      input.disabled = false;
      input.value = '';
    }
  }
}

function bindCommandBar() {
  const input = document.getElementById('global-search');
  if (!input) return;
  input.placeholder = 'Szukaj lub wpisz komendę AI…';
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    runCommandBar(input.value);
  });
  bindVoiceCommand();
}

function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setVoiceListening(listening) {
  const btn = document.getElementById('voice-command');
  if (!btn) return;
  btn.classList.toggle('listening', Boolean(listening));
  btn.setAttribute('aria-pressed', listening ? 'true' : 'false');
  btn.title = listening ? 'Zatrzymaj dyktowanie' : 'Dyktuj komendę AI';
}

function bindVoiceCommand() {
  const btn = document.getElementById('voice-command');
  const input = document.getElementById('global-search');
  if (!btn || !input) return;
  const supported = Boolean(speechRecognitionCtor());
  btn.classList.toggle('unsupported', !supported);
  btn.onclick = () => {
    const Recognition = speechRecognitionCtor();
    if (!Recognition) {
      toast('Dyktowanie nie jest dostępne w tej przeglądarce', 'err');
      input.focus();
      return;
    }
    if (activeVoiceRecognition) {
      activeVoiceRecognition.stop();
      return;
    }
    const recognition = new Recognition();
    activeVoiceRecognition = recognition;
    recognition.lang = 'pl-PL';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let finalTranscript = '';

    recognition.onstart = () => {
      setVoiceListening(true);
      input.focus();
      toast('Słucham komendy...', 'ok', 1200);
    };
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const transcript = String(event.results[i][0]?.transcript || '').trim();
        if (event.results[i].isFinal) finalTranscript = `${finalTranscript} ${transcript}`.trim();
        else interim = `${interim} ${transcript}`.trim();
      }
      input.value = (finalTranscript || interim).trim();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    recognition.onerror = (event) => {
      const err = event && event.error ? event.error : 'unknown';
      toast(err === 'not-allowed' ? 'Brak zgody na mikrofon' : 'Nie udało się rozpoznać głosu', 'err');
    };
    recognition.onend = () => {
      activeVoiceRecognition = null;
      setVoiceListening(false);
      input.focus();
    };

    try {
      recognition.start();
    } catch {
      activeVoiceRecognition = null;
      setVoiceListening(false);
      toast('Nie udało się uruchomić dyktowania', 'err');
    }
  };
}

async function loadAuth() {
  try {
    State.auth = await Api.get('/auth/me');
    updateAccountTile();
    return State.auth;
  } catch {
    return State.auth;
  }
}

function updateAccountTile() {
  const user = State.auth && State.auth.user;
  if (!user) return;
  const name = user.display_name || user.username || 'Property Manager';
  const avatarEl = document.querySelector('.rail-avatar');
  const nameEl = document.querySelector('.rail-user-name');
  const roleEl = document.querySelector('.rail-user-role');
  if (avatarEl) avatarEl.textContent = initials(name);
  if (nameEl) nameEl.textContent = name;
  if (roleEl) roleEl.textContent = roleLabel(user.role);
}

function userRowHtml(u) {
  return `
    <tr>
      <td><div class="user-cell">${avatar(u.display_name || u.username)}<div><b>${escapeHtml(u.display_name || u.username)}</b><span>${escapeHtml(u.username)}</span></div></div></td>
      <td>${escapeHtml(roleLabel(u.role))}</td>
      <td>${u.active ? chip('chip-e', 'Aktywny', true) : chip('chip-r', 'Wyłączony')}</td>
      <td>${Number(u.properties_count || 0)}</td>
      <td>${u.last_login_at ? fmtDate(u.last_login_at) : '—'}</td>
      <td class="ta-r"><button class="icon-btn" data-edit-user="${u.id}" title="Edytuj"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button></td>
    </tr>`;
}

async function openAccountPanel() {
  const auth = await loadAuth();
  const user = auth && auth.user;
  if (!user) return toast('Sesja wygasła', 'err');
  const users = user.role === 'admin' ? await Api.get('/admin/users').catch(() => []) : [];
  const body = `
    <div class="account-panel">
      <section class="account-card">
        <div class="account-head">
          <div class="rail-avatar account-avatar">${escapeHtml(initials(user.display_name || user.username))}</div>
          <div>
            <div class="account-name">${escapeHtml(user.display_name || user.username)}</div>
            <div class="account-meta">${escapeHtml(user.username)} · ${escapeHtml(roleLabel(user.role))}</div>
          </div>
        </div>
        <form id="password-form" class="form-grid compact">
          <div class="form-row"><label>Obecne hasło</label><input name="current_password" type="password" autocomplete="current-password"></div>
          <div class="form-row"><label>Nowe hasło</label><input name="new_password" type="password" autocomplete="new-password"></div>
        </form>
        <div class="account-actions">
          <button class="tb-btn tb-primary" id="save-password">Zmień hasło</button>
          <button class="tb-btn tb-ghost" id="panel-logout">Wyloguj</button>
        </div>
      </section>
      ${
        user.role === 'admin'
          ? `
      <section class="account-card">
        <div class="ch inline"><div><div class="ch-title">Użytkownicy</div><div class="ch-sub">konta aplikacji · dostęp do panelu</div></div><button class="tb-btn tb-primary" id="add-user">Dodaj użytkownika</button></div>
        <div class="table-wrap user-table-wrap"><table class="data-table user-table">
          <thead><tr><th>Użytkownik</th><th>Rola</th><th>Status</th><th>Nieruch.</th><th>Ostatnio</th><th></th></tr></thead>
          <tbody>${users.map(userRowHtml).join('') || `<tr><td colspan="6">${emptyState('Brak użytkowników')}</td></tr>`}</tbody>
        </table></div>
      </section>`
          : ''
      }
    </div>`;
  const m = modal({ title: 'Konto i administracja', body, wide: true });
  m.root.querySelector('#panel-logout').onclick = logout;
  m.root.querySelector('#save-password').onclick = async () => {
    const form = m.root.querySelector('#password-form');
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      await Api.post('/admin/change-password', payload);
      form.reset();
      toast('Hasło zmienione');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const addBtn = m.root.querySelector('#add-user');
  if (addBtn)
    addBtn.onclick = () =>
      editAppUser(null, () => {
        m.close();
        openAccountPanel();
      });
  m.root.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.onclick = () => {
      const found = users.find((x) => String(x.id) === String(btn.dataset.editUser));
      editAppUser(found, () => {
        m.close();
        openAccountPanel();
      });
    };
  });
}

function editAppUser(user, onSaved) {
  const isNew = !user;
  formModal({
    title: isNew ? 'Dodaj użytkownika' : 'Edytuj użytkownika',
    fields: [
      ...(isNew
        ? [
            {
              name: 'username',
              label: 'Login',
              required: true,
              hint: 'Litery, cyfry, kropka, myślnik albo podkreślenie.',
            },
          ]
        : []),
      { name: 'display_name', label: 'Nazwa wyświetlana', default: user && user.display_name, full: !isNew },
      {
        name: 'role',
        label: 'Rola',
        type: 'select',
        default: (user && user.role) || 'user',
        options: [
          { value: 'user', label: 'Użytkownik' },
          { value: 'admin', label: 'Administrator' },
        ],
      },
      { name: 'active', label: 'Aktywne konto', type: 'checkbox', default: isNew ? true : user.active !== 0 },
      {
        name: 'password',
        label: isNew ? 'Hasło' : 'Nowe hasło (opcjonalnie)',
        type: 'password',
        required: isNew,
        full: true,
        hint: 'Minimum 8 znaków.',
      },
    ],
    initial: user || {},
    onSubmit: async (payload) => {
      if (!isNew && !payload.password) delete payload.password;
      if (isNew) await Api.post('/admin/users', payload);
      else await Api.put(`/admin/users/${user.id}`, payload);
      toast(isNew ? 'Dodano użytkownika' : 'Zapisano użytkownika');
      if (onSaved) onSaved();
    },
    wide: true,
  });
}

// ─── ROUTER ─────────────────────────────────────────────────────────
const VIEWS = {
  dashboard: renderDashboard,
  nieruchomosci: renderProperties,
  najemcy: renderTenants,
  umowy: renderContracts,
  platnosci: renderPayments,
  banking: renderBanking,
  raporty: renderReports,
  koszty: renderExpenses,
  zadania: renderTasks,
  dokumenty: renderDocuments,
  ustawienia: renderSettings,
};
const VIEW_TITLES = {
  dashboard: 'Dashboard',
  nieruchomosci: 'Nieruchomości',
  najemcy: 'Najemcy',
  umowy: 'Umowy',
  platnosci: 'Płatności',
  banking: 'Bank',
  raporty: 'Raporty',
  koszty: 'Koszty',
  zadania: 'Zadania',
  dokumenty: 'Dokumenty',
  ustawienia: 'Ustawienia',
};
function currentView() {
  return (location.hash || '#dashboard').slice(1);
}
function navigate(v) {
  location.hash = v;
}

async function render(opts = {}) {
  const v = currentView();
  syncNavState(v);
  // destroy charts
  for (const k of Object.keys(State.charts)) {
    try {
      State.charts[k].destroy();
    } catch {}
    delete State.charts[k];
  }
  const root = document.getElementById('view-root');
  const content = document.querySelector('.content');
  const preserveScroll = Boolean(opts.preserveScroll);
  const savedScrollTop = preserveScroll && content ? content.scrollTop : 0;
  const savedWindowScroll = preserveScroll ? window.scrollY : 0;
  const previousMinHeight = root.style.minHeight;
  if (preserveScroll)
    root.style.minHeight = `${Math.max(root.offsetHeight, content ? content.scrollHeight : 0)}px`;
  const fn = VIEWS[v] || renderDashboard;
  root.innerHTML = spinner();
  try {
    await fn(root);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="gc"><div style="padding:22px;color:var(--rose)">Błąd: ${escapeHtml(e.message)}</div></div>`;
  }
  enhanceResponsiveTables(root);
  if (preserveScroll) {
    const restore = () => {
      if (content) content.scrollTop = savedScrollTop;
      window.scrollTo(window.scrollX, savedWindowScroll);
      root.style.minHeight = previousMinHeight;
    };
    restore();
    requestAnimationFrame(restore);
  }
  refreshNavBadges();
}

function syncNavState(view = currentView()) {
  document.querySelectorAll('#nav .nav-item, #mobile-nav .mobile-nav-item').forEach((it) => {
    it.classList.toggle('act', it.dataset.view === view);
  });
  const more = document.querySelector('#mobile-nav [data-more]');
  if (more) more.classList.toggle('act', !['dashboard', 'platnosci', 'banking', 'zadania'].includes(view));
}

function createMobileNav() {
  if (document.getElementById('mobile-nav')) return;
  const sourceItems = Array.from(document.querySelectorAll('#nav .nav-item'));
  const primaryViews = ['dashboard', 'platnosci', 'banking', 'zadania'];
  const primaryItems = primaryViews
    .map((view) => sourceItems.find((item) => item.dataset.view === view))
    .filter(Boolean);
  const mobile = document.createElement('nav');
  mobile.id = 'mobile-nav';
  mobile.className = 'mobile-nav';
  mobile.setAttribute('aria-label', 'Nawigacja mobilna');
  mobile.innerHTML =
    primaryItems
      .map((item) => {
        const view = item.dataset.view;
        const label = item.querySelector('.nav-label')?.textContent?.trim() || VIEW_TITLES[view] || view;
        const icon = item.querySelector('svg')?.outerHTML || '';
        return `
      <button class="mobile-nav-item" type="button" data-view="${escapeHtml(view)}" aria-label="${escapeHtml(label)}">
        ${icon}
        <span>${escapeHtml(label)}</span>
      </button>`;
      })
      .join('') +
    `<button class="mobile-nav-item" type="button" data-more="1" aria-label="Więcej funkcji">
      <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
      <span>Więcej</span>
    </button>`;
  document.body.appendChild(mobile);
  mobile.querySelectorAll('.mobile-nav-item[data-view]').forEach((item) => {
    item.onclick = () => navigate(item.dataset.view);
  });
  mobile.querySelector('[data-more]').onclick = openMobileMoreMenu;
  syncNavState();
}

function openMobileMoreMenu() {
  const items = [
    ['nieruchomosci', 'Nieruchomości'],
    ['najemcy', 'Najemcy'],
    ['umowy', 'Umowy i obieg'],
    ['raporty', 'Raport właścicielski'],
    ['koszty', 'Koszty'],
    ['dokumenty', 'Dokumenty'],
    ['ustawienia', 'Ustawienia i AI'],
  ];
  const body = `<div class="mobile-more-grid">${items
    .map(([view, label]) => {
      const source = document.querySelector(`#nav .nav-item[data-view="${view}"]`);
      return `<button type="button" class="mobile-more-item" data-more-view="${view}">
        ${source?.querySelector('svg')?.outerHTML || ''}<span>${escapeHtml(label)}</span>
      </button>`;
    })
    .join('')}</div>
    <div class="mobile-more-account">
      <button type="button" class="tb-btn tb-ghost" id="mobile-account">Konto</button>
      <button type="button" class="tb-btn tb-ghost" id="mobile-logout">Wyloguj</button>
    </div>`;
  const dialog = modal({ title: 'Więcej funkcji', body });
  dialog.root.classList.add('mobile-more-modal');
  dialog.root.querySelectorAll('[data-more-view]').forEach((button) => {
    button.onclick = () => {
      dialog.close();
      navigate(button.dataset.moreView);
    };
  });
  dialog.root.querySelector('#mobile-account').onclick = () => {
    dialog.close();
    openAccountPanel();
  };
  dialog.root.querySelector('#mobile-logout').onclick = logout;
}

function responsiveHeaderLabel(text, index, total) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === '✓') return 'Wpłata';
  if (!normalized && index === total - 1) return 'Akcje';
  return normalized;
}

function enhanceResponsiveTables(scope = document) {
  scope.querySelectorAll('table.t').forEach((table) => {
    const headers = Array.from(table.querySelectorAll('thead th')).map((th, i, arr) =>
      responsiveHeaderLabel(th.textContent, i, arr.length),
    );
    if (!headers.length) return;
    table.classList.add('t-responsive');

    table.querySelectorAll('tbody tr').forEach((row) => {
      Array.from(row.children).forEach((cell, i) => {
        if (cell.tagName !== 'TD') return;
        if (cell.colSpan > 1) {
          cell.dataset.label = '';
          return;
        }
        if (!cell.dataset.label) cell.dataset.label = headers[i] || '';
      });
    });
  });
}

function refreshNavBadges() {
  Api.get('/tenants?status=active')
    .then((r) => {
      const el = document.getElementById('badge-tenants');
      if (el) el.textContent = r.length;
    })
    .catch(() => {});
  Api.get('/payments?status=overdue')
    .then((r) => {
      const el = document.getElementById('badge-payments');
      if (el) {
        el.textContent = r.length;
        el.className = 'nav-badge ' + (r.length > 0 ? 'nb-r' : 'nb-v');
      }
    })
    .catch(() => {});
  Api.get('/tasks?status=open')
    .then((r) => {
      const el = document.getElementById('badge-tasks');
      if (el) {
        el.textContent = r.length;
        el.className = 'nav-badge ' + (r.length > 0 ? 'nb-r' : 'nb-v');
      }
    })
    .catch(() => {});
}

// ─── CHART.JS DARK DEFAULTS ─────────────────────────────────────────
if (window.Chart) {
  Chart.defaults.font.family = "'DM Sans', sans-serif";
  Chart.defaults.color = '#5a5a8a';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';
}
function chartBaseOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#12122e',
        titleFont: { size: 12 },
        bodyFont: { size: 12 },
        padding: 12,
        cornerRadius: 10,
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      y: {
        grid: { color: 'rgba(255,255,255,0.04)' },
        ticks: { font: { size: 11 }, callback: (v) => v.toLocaleString('pl-PL') + ' zł' },
      },
    },
    ...extra,
  };
}

// ═══════════════════════ DASHBOARD ═══════════════════════
async function renderDashboard(root) {
  const [d, attention] = await Promise.all([
    Api.get(`/dashboard?period=${State.period}`),
    Api.get(`/assistant/attention?period=${State.period}`).catch(() => null),
  ]);
  const r = d.revenue,
    e = d.expenses,
    t = d.tax,
    occ = d.occupancy;
  const owner = d.net_for_owner;
  const mediaCosts = (e.by_category || [])
    .filter((row) => ['czynsz', 'prad', 'internet'].includes(row.category))
    .reduce((sum, row) => sum + (row.total || 0), 0);
  const noPayments = !d.current_payments || d.current_payments.length === 0;
  const paidCount = (d.current_payments || []).filter((p) => p.status === 'paid').length;
  const pendingCount = (d.current_payments || []).filter((p) => p.status !== 'paid').length;

  setTopbar(
    VIEW_TITLES.dashboard,
    `${periodLabel(State.period)} · wszystkie nieruchomości`,
    `<button class="tb-btn tb-primary" id="add-payment"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Dodaj wpłatę</button>`,
  );

  root.innerHTML = `
    ${
      noPayments
        ? `
      <div class="alert-banner ab-info">
        <div class="ab-icon"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
        <div class="ab-text"><div class="ab-title">Brak płatności za ${escapeHtml(periodLabel(State.period))}</div>
          <div class="ab-sub">Wygeneruj harmonogram dla aktywnych umów — kwoty z umów, status „oczekuje".</div></div>
        <button class="ab-action" id="gen-month">Generuj raport →</button>
      </div>`
        : ''
    }

    <div class="kpi-strip">
      <div class="kpi-hero">
        <div class="kh-label">Przychód miesiąca <span class="live-dot"></span></div>
        <div class="kh-val">${fmtPLN(r.gross)}<span class="kh-unit">PLN</span></div>
        <div class="kh-delta">${deltaPill(r.delta_vs_prev)}</div>
        <div class="kh-sub">${escapeHtml(periodLabel(State.period))} · ${r.total_units || 0} najemców · z ${fmtPLN(r.expected || 0)} oczekiwanych</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-e"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
        <div class="ks-label">Obłożenie</div>
        <div class="ks-val">${occ.rented}<span class="ks-unit">/ ${occ.total}</span></div>
        ${chip(occ.total && occ.rented === occ.total ? 'chip-e' : 'chip-a', `${occ.total ? Math.round((occ.rented / occ.total) * 100) : 0}%`, occ.rented === occ.total)}
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-c"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
        <div class="ks-label">Media + czynsz w przychodach</div>
        <div class="ks-val">${fmtPLN(r.media)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">z zatwierdzonych</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-r"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
        <div class="ks-label">Media + czynsz w kosztach</div>
        <div class="ks-val">${fmtPLN(mediaCosts)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">czynsz + prąd + internet</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-v"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg></div>
        <div class="ks-label">Podatek</div>
        <div class="ks-val">${fmtPLN(t.podatek_suma || 0)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">${t.rate || 0}% × ${fmtPLN(r.rent_paid || 0)} zł czynszu</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-c"><svg viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg></div>
        <div class="ks-label">Netto właściciel</div>
        <div class="ks-val">${fmtPLN(owner)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta ${owner >= 0 ? 'delta-up' : 'delta-dn'}">po kosztach + podatku</div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="gc">
        <div class="ch">
          <div><div class="ch-title">Płatności bieżącego miesiąca</div>
            <div class="ch-sub">${escapeHtml(periodLabel(State.period))} · ${noPayments ? 'brak harmonogramu' : `${paidCount}/${d.current_payments.length} zatwierdzonych · ${fmtPLN(r.gross)} PLN`}</div></div>
          <div style="display:flex;gap:8px;align-items:center">
            ${pendingCount > 0 ? `<button class="tb-btn tb-primary" data-approve-month="${State.period}" style="font-size:12px;padding:6px 12px">Zatwierdź miesiąc (${pendingCount})</button>` : ''}
            <span class="ch-action" data-go="platnosci">Wszystkie →</span>
          </div>
        </div>
        ${
          noPayments
            ? `<div style="padding:24px">${emptyState('Brak płatności w tym okresie.', 'Kliknij „Generuj raport" w banerze powyżej.')}</div>`
            : `
        <div class="t-fluid">${paymentsTable(d.current_payments, false)}</div>`
        }
      </div>

      <div class="gc">
        <div class="ch"><div><div class="ch-title">Obłożenie</div><div class="ch-sub">${escapeHtml(periodLabel(State.period))}</div></div>
          ${chip(occ.total && occ.rented === occ.total ? 'chip-e' : 'chip-a', `${occ.total ? Math.round((occ.rented / occ.total) * 100) : 0}%`, occ.rented === occ.total)}
        </div>
        <div class="occ-ring-wrap">
          ${occRingSvg(occ)}
          <div class="occ-mini-stats">
            <div class="oms"><div class="oms-val" style="color:var(--emerald)">${occ.rented}</div><div class="oms-lbl">Wynajęte</div></div>
            <div class="oms"><div class="oms-val" style="color:var(--t4)">${occ.vacant}</div><div class="oms-lbl">Wolne</div></div>
          </div>
          <div class="occ-units">
            ${(d.units || [])
              .slice(0, 7)
              .map(
                (u) => `
              <div class="occ-unit">
                <div style="min-width:0;flex:1">
                  <div class="ou-room">${escapeHtml(u.property_name || '—')} · ${escapeHtml(u.code || u.unit_name || '')}</div>
                  <div class="ou-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(u.tenant_name || '— wolne —')}</div>
                </div>
                <div class="ou-rent">${fmtPLN(u.monthly || 0)} zł</div>
              </div>`,
              )
              .join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="dash-bottom">
      <div class="gc">
        <div class="ch">
          <div><div class="ch-title">Przychody, koszty i podatek</div><div class="ch-sub">12 miesięcy · zatwierdzone wpłaty</div></div>
          <div class="legend">
            <div class="leg"><div class="leg-sq" style="background:#8b5cf6"></div>Przychód</div>
            <div class="leg"><div class="leg-sq" style="background:#06b6d4"></div>Media</div>
            <div class="leg"><div class="leg-sq" style="background:#f59e0b;opacity:.7"></div>Podatek</div>
          </div>
        </div>
        <div style="padding:16px 20px 18px"><div style="position:relative;height:200px"><canvas id="d-chart"></canvas></div></div>
      </div>
      <div class="gc">
        <div class="ch"><div><div class="ch-title">Wymaga uwagi</div><div class="ch-sub">Alerty i zadania</div></div></div>
        <div class="alert-list">
          ${attentionHtml(attention)}
          ${alertRow(
            d.alerts.overdue_count > 0 ? 'ar-r' : 'ar-e',
            '<polyline points="20 6 9 17 4 12"/>',
            'Zaległości',
            d.alerts.overdue_count > 0
              ? `${d.alerts.overdue_count} zaległych · ${fmtPLN(d.alerts.overdue_amount)} zł`
              : 'wszystko opłacone',
            'platnosci',
          )}
          ${alertRow(
            'ar-a',
            '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>',
            'Kończące się umowy',
            `${d.alerts.ending_contracts || 0} w ciągu 30 dni`,
            'umowy',
          )}
          ${alertRow(
            'ar-v',
            '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
            'Zadania otwarte',
            `${d.alerts.open_tasks || 0} do wykonania`,
            'zadania',
          )}
        </div>
      </div>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Rozliczenie ${escapeHtml(periodLabel(State.period))}</div><div class="ch-sub">automatyczne — z zatwierdzonych wpłat i kosztów</div></div></div>
      <div class="settle-grid">
        <div class="settle-cell"><div class="settle-lbl">Przychody (zatwierdzone)</div><div class="settle-val" style="color:var(--emerald)">+ ${fmtPLN(r.gross)} zł</div><div class="settle-sub">z ${fmtPLN(r.expected || 0)} oczekiwanych</div></div>
        <div class="settle-cell"><div class="settle-lbl">Koszty</div><div class="settle-val" style="color:var(--rose)">− ${fmtPLN(e.total)} zł</div><div class="settle-sub">${e.by_category && e.by_category.length ? `${e.by_category.length} kategorii` : 'brak wpisów'}</div></div>
        <div class="settle-cell"><div class="settle-lbl">Podatek (ryczałt)</div><div class="settle-val" style="color:var(--rose)">− ${fmtPLN(t.podatek_suma || 0)} zł</div><div class="settle-sub">${t.rate || 0}% × czynsz ${fmtPLN(r.rent_paid || 0)} zł${(t.podatek_koscielna || 0) > 0 ? ` + ${fmtPLN(t.podatek_koscielna)} zł stałe` : ''}</div></div>
        <div class="settle-cell"><div class="settle-lbl">Netto właściciel</div><div class="settle-val" style="color:var(--emerald);font-size:26px">${fmtPLN(owner)} zł</div><div class="settle-sub">do wypłaty</div></div>
      </div>
    </div>`;

  document.getElementById('add-payment').onclick = () => editPayment(null);
  const gen = document.getElementById('gen-month');
  if (gen) gen.onclick = () => doGenerateMonth();
  bindGoButtons();
  bindPaymentChecks();
  bindApproveMonth();
  bindAttentionActions();

  const ctx = document.getElementById('d-chart');
  if (ctx && d.chart_12m) {
    State.charts.dashboard = new Chart(ctx, {
      type: 'line',
      data: {
        labels: d.chart_12m.map(
          (x) => PL_MONTHS_SHORT[+x.period.split('-')[1] - 1] + ' ' + x.period.slice(2, 4),
        ),
        datasets: [
          {
            label: 'Przychód',
            data: d.chart_12m.map((x) => x.revenue),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139,92,246,0.1)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2.5,
            pointBackgroundColor: '#8b5cf6',
          },
          {
            label: 'Media',
            data: d.chart_12m.map((x) => x.media),
            borderColor: '#06b6d4',
            backgroundColor: 'rgba(6,182,212,0.07)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2,
            pointBackgroundColor: '#06b6d4',
          },
          {
            label: 'Podatek',
            data: d.chart_12m.map((x) => x.tax),
            borderColor: '#f59e0b',
            backgroundColor: 'transparent',
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointBackgroundColor: '#f59e0b',
          },
        ],
      },
      options: chartBaseOpts(),
    });
  }
}

function priorityLabel(priority) {
  return { critical: 'Krytyczne', high: 'Ważne', medium: 'Do sprawdzenia', low: 'Info' }[priority] || 'Info';
}

function attentionHtml(attention) {
  if (!attention || !Array.isArray(attention.checks) || !attention.checks.length) {
    return `
      <div class="attention-box ok">
        <div class="attention-title">AI audyt danych</div>
        <div class="attention-sub">Brak najważniejszych sygnałów w bieżącym okresie.</div>
        <button type="button" class="attention-btn" data-attention-command="sprawdź czy dane są kompletne za ${new Date().getFullYear()} r.">Uruchom audyt</button>
      </div>`;
  }
  return `
    <div class="attention-box">
      <div class="attention-title">AI audyt danych</div>
      <div class="attention-sub">${attention.issue_count || 0} sygnałów w skrócie</div>
      <div class="attention-list">
        ${attention.checks
          .slice(0, 4)
          .map(
            (check) => `
          <button type="button" class="attention-row pr-${escapeHtml(check.priority || 'low')}" data-attention-command="${escapeHtml((attention.commands && attention.commands[0]) || 'sprawdź błędy w danych')}">
            <span>
              <b>${escapeHtml(check.label)}</b>
              <small>${escapeHtml(priorityLabel(check.priority))}</small>
            </span>
            <strong>${fmtPLN(check.count || 0)}</strong>
          </button>`,
          )
          .join('')}
      </div>
      <div class="attention-actions">
        ${(attention.commands || [])
          .slice(0, 3)
          .map(
            (cmd) =>
              `<button type="button" class="attention-chip" data-attention-command="${escapeHtml(cmd)}">${escapeHtml(cmd)}</button>`,
          )
          .join('')}
      </div>
    </div>`;
}

function bindAttentionActions() {
  document.querySelectorAll('[data-attention-command]').forEach((btn) => {
    btn.onclick = () => runCommandBar(btn.dataset.attentionCommand || '');
  });
}

function occRingSvg(occ) {
  const total = occ.total || 0;
  const rented = occ.rented || 0;
  const pct = total ? rented / total : 0;
  const c = 2 * Math.PI * 42;
  const dash = c * pct;
  return `
    <svg width="110" height="110" viewBox="0 0 110 110">
      <circle cx="55" cy="55" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="11"/>
      <circle cx="55" cy="55" r="42" fill="none" stroke="#8b5cf6" stroke-width="11"
              stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
              stroke-linecap="round" transform="rotate(-90 55 55)"
              style="filter:drop-shadow(0 0 6px rgba(139,92,246,0.5))"/>
      <text x="55" y="50" text-anchor="middle" fill="#eeeeff" font-size="20" font-weight="700" font-family="JetBrains Mono,monospace">${rented}</text>
      <text x="55" y="65" text-anchor="middle" fill="#5a5a8a" font-size="10" font-family="DM Sans,sans-serif" font-weight="500">lokali</text>
    </svg>`;
}

function alertRow(cls, iconPath, title, sub, view) {
  return `
    <div class="alert-row" data-go="${view}">
      <div class="ar-icon ${cls}"><svg viewBox="0 0 24 24">${iconPath}</svg></div>
      <div><div class="ar-title">${escapeHtml(title)}</div><div class="ar-sub">${escapeHtml(sub)}</div></div>
      <span class="ar-arr">›</span>
    </div>`;
}

function bindGoButtons() {
  document.querySelectorAll('[data-go]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      navigate(el.dataset.go);
    };
  });
}

// ═══════════════════════ PŁATNOŚCI ═══════════════════════
function paymentsTable(rows, withActions) {
  if (!rows || !rows.length) return emptyState('Brak płatności w tym okresie.');
  return `
    <table class="t">
      <thead><tr>
        <th style="width:40px;text-align:center">✓</th>
        <th>Najemca</th><th>Lokal</th><th>Status</th><th>Termin</th>
        <th>Wpłata</th><th>Czynsz</th><th>Media</th><th>Kara</th><th>Razem bez kar</th>
        ${withActions ? '<th></th>' : ''}
      </tr></thead>
      <tbody>${rows.map((p) => paymentRow(p, withActions)).join('')}</tbody>
      <tfoot><tr>
        <td colspan="${withActions ? 9 : 9}" style="font-size:13px">Suma</td>
        <td class="mono-e" style="font-size:13px">${fmtPLN(rows.reduce((s, r) => s + paymentExpectedTotal(r), 0))} zł</td>
        ${withActions ? '<td></td>' : ''}
      </tr></tfoot>
    </table>`;
}

function paymentExpectedTotal(p) {
  return (p.rent_amount || 0) + (p.media_amount || 0) + (p.other_amount || 0);
}

function paymentRow(p, withActions) {
  const st = STATUS_CHIP[p.status] || STATUS_CHIP.pending;
  const isPaid = p.status === 'paid';
  const total = paymentExpectedTotal(p);
  const lateBalance = Math.max(0, (p.late_fee_amount || 0) - (p.late_fee_paid || 0));
  return `
    <tr>
      <td style="text-align:center">
        <input type="checkbox" class="pay-chk" data-pay-id="${p.id}" ${isPaid ? 'checked' : ''} title="Zatwierdź wpłatę">
      </td>
      <td>
        <div class="t-tenant">${avatar(p.tenant_name)}<div><div class="t-name">${escapeHtml(p.tenant_name || '—')}</div><div class="t-sub">${escapeHtml(p.property_name || '—')}</div></div></div>
      </td>
      <td class="mono">${escapeHtml(p.unit_code || p.unit_name || '—')}</td>
      <td><span class="chip ${st.cls}"><svg viewBox="0 0 24 24">${st.icon}</svg>${st.label}</span></td>
      <td class="mono">${fmtDateShort(p.due_date)}</td>
      <td class="mono${p.paid_date ? '-e' : ''}">${p.paid_date ? fmtDateShort(p.paid_date) : '—'}</td>
      <td class="mono">${fmtPLN(p.rent_amount)} zł</td>
      <td class="mono">${fmtPLN(p.media_amount)} zł</td>
      <td class="mono${lateBalance > 0 ? '-r' : p.late_fee_amount ? '-a' : ''}">${p.late_fee_amount ? fmtPLN(p.late_fee_amount) + ' zł' : '—'}</td>
      <td class="mono-e">${fmtPLN(total)} zł</td>
      ${
        withActions
          ? `<td><div style="display:flex;gap:4px">
        <button class="icon-btn" title="Edytuj" onclick="editPayment(${p.id})"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="icon-btn danger" title="Usuń" onclick="deletePayment(${p.id})"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div></td>`
          : ''
      }
    </tr>`;
}

function bindPaymentChecks() {
  document.querySelectorAll('input.pay-chk').forEach((cb) => {
    cb.onclick = async (ev) => {
      ev.stopPropagation();
      const id = +cb.dataset.payId;
      const wasChecked = cb.checked;
      try {
        await Api.put(`/payments/${id}/toggle-paid`);
        toast(wasChecked ? 'Zatwierdzono wpłatę' : 'Cofnięto zatwierdzenie');
        cb.blur();
        await render({ preserveScroll: true });
      } catch (err) {
        cb.checked = !wasChecked;
        toast(err.message || 'Błąd', 'err');
      }
    };
  });
}

function bindApproveMonth() {
  document.querySelectorAll('[data-approve-month]').forEach((btn) => {
    btn.onclick = () => {
      const period = btn.dataset.approveMonth;
      confirmDialog({
        title: 'Zatwierdź miesiąc',
        message: `Zatwierdzić wszystkie oczekujące wpłaty za ${periodLabel(period)}? Status zmieni się na „opłacona", kwoty trafią do raportów i podatku.`,
        onYes: async () => {
          const r = await Api.post('/payments/approve-month', { period });
          toast(`Zatwierdzono ${r.updated} wpłat`, 'ok');
          render();
        },
      });
    };
  });
}

async function doGenerateMonth() {
  confirmDialog({
    title: 'Generuj raport',
    message: `Utworzyć harmonogram wpłat dla wszystkich aktywnych umów na ${periodLabel(State.period)}?`,
    onYes: async () => {
      const r = await Api.post('/payments/generate-month', { period: State.period });
      toast(`Wygenerowano: ${r.created} (pominięto ${r.skipped})`, 'ok');
      render();
    },
  });
}

async function renderPayments(root) {
  const fromP = shiftPeriod(State.period, -11);
  const params = new URLSearchParams();
  if (State.paymentsFilter && State.paymentsFilter !== 'all') params.set('status', State.paymentsFilter);
  if (State.paymentsQ) params.set('q', State.paymentsQ);
  params.set('from_period', fromP);
  params.set('to_period', State.period);

  const nextP = shiftPeriod(State.period, +1);
  const [all, dash, props, upcoming] = await Promise.all([
    Api.get('/payments?' + params.toString()),
    Api.get(`/dashboard?period=${State.period}`).catch(() => null),
    Api.get('/properties').catch(() => []),
    Api.get(`/payments?period=${nextP}`).catch(() => []),
  ]);

  const overdue = all.filter((p) => p.status === 'overdue');
  const pending = all.filter((p) => p.period === State.period && p.status === 'pending');
  const byPeriod = {};
  for (const p of all) (byPeriod[p.period] = byPeriod[p.period] || []).push(p);
  const periodsSorted = Object.keys(byPeriod).sort().reverse();

  const r = dash ? dash.revenue : { gross: 0, paid_units: 0, total_units: 0, delta_vs_prev: 0 };
  const t = dash ? dash.tax : { podatek_suma: 0 };
  const owner = dash ? dash.net_for_owner : 0;

  setTopbar(
    VIEW_TITLES.platnosci,
    `${periodLabel(State.period)} · ${all.length} płatności w okresie 12m`,
    `<button class="tb-btn tb-ghost" id="btn-gen"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Generuj miesiąc</button>
     <button class="tb-btn tb-ghost" id="btn-csv"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>CSV</button>
     <button class="tb-btn tb-primary" id="btn-add"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Dodaj wpłatę</button>`,
  );

  root.innerHTML = `
    <div class="kpi-strip">
      <div class="kpi-hero">
        <div class="kh-label">Wpłynęło w tym miesiącu <span class="live-dot"></span></div>
        <div class="kh-val">${fmtPLN(r.gross)}<span class="kh-unit">PLN</span></div>
        <div class="kh-delta">${deltaPill(r.delta_vs_prev)}</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-e"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        <div class="ks-label">Zatwierdzone</div>
        <div class="ks-val">${r.paid_units || 0}<span class="ks-unit">/ ${r.total_units || 0}</span></div>
        <div class="ks-delta delta-n">w okresie</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-r"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg></div>
        <div class="ks-label">Zaległości (wszystkie)</div>
        <div class="ks-val">${overdue.length}<span class="ks-unit">szt.</span></div>
        ${chip(overdue.length === 0 ? 'chip-e' : 'chip-r', overdue.length === 0 ? 'bez zaległości' : `${fmtPLN(overdue.reduce((s, p) => s + paymentExpectedTotal(p) - (p.total_paid || 0), 0))} zł`)}
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-v"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"/></svg></div>
        <div class="ks-label">Podatek do zapłaty</div>
        <div class="ks-val">${fmtPLN(t.podatek_suma || 0)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">${escapeHtml(periodLabel(State.period))}</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-c"><svg viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg></div>
        <div class="ks-label">Netto właściciel</div>
        <div class="ks-val">${fmtPLN(owner)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">po podatku</div>
      </div>
    </div>

    ${
      pending.length
        ? `
      <div class="alert-banner">
        <div class="ab-icon"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
        <div class="ab-text">
          <div class="ab-title">${pending.length} płatności oczekuje potwierdzenia — ${escapeHtml(periodLabel(State.period))}</div>
          <div class="ab-sub">Zaznacz checkboxy lub kliknij „Zatwierdź miesiąc".</div>
        </div>
        <button class="ab-action" data-approve-month="${State.period}">Oznacz jako opłacone →</button>
      </div>`
        : ''
    }

    <div class="toolbar">
      <div class="search-box"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="pay-q" placeholder="Szukaj najemcy, lokalu…" value="${escapeHtml(State.paymentsQ || '')}"></div>
      <div class="fsep"></div>
      <div class="fgroup"><span class="flbl">Status:</span>
        ${['all', 'paid', 'pending', 'overdue', 'partial'].map((s) => `<button class="ftab ${(State.paymentsFilter || 'all') === s ? 'on' : ''}" data-pf="${s}">${s === 'all' ? 'Wszystkie' : STATUS_CHIP[s]?.label || s}</button>`).join('')}
      </div>
    </div>

    <div class="pay-grid">
      <div style="display:flex;flex-direction:column;gap:12px">
        ${
          periodsSorted.length === 0
            ? `<div class="gc">${emptyState('Brak płatności w wybranym zakresie.')}</div>`
            : periodsSorted
                .map((period) => {
                  const rows = byPeriod[period];
                  const sum = rows.reduce((a, r) => a + paymentExpectedTotal(r), 0);
                  const paidN = rows.filter((r) => r.status === 'paid').length;
                  const remN = rows.length - paidN;
                  const allPaid = paidN === rows.length;
                  return `<div class="gc">
              <div class="ch">
                <div><div class="ch-title">${escapeHtml(periodLabel(period))}</div>
                  <div class="ch-sub">${paidN}/${rows.length} zatwierdzonych · suma ${fmtPLN(sum)} zł</div></div>
                <div style="display:flex;gap:8px;align-items:center">
                  <span class="chip ${allPaid ? 'chip-e' : 'chip-a'}">${allPaid ? '✓ Zatwierdzony' : '⏳ Oczekuje'}</span>
                  ${remN > 0 ? `<button class="tb-btn tb-primary" data-approve-month="${period}" style="font-size:12px;padding:6px 12px">Zatwierdź miesiąc (${remN})</button>` : ''}
                </div>
              </div>
              <div style="overflow-x:auto">${paymentsTable(rows, true)}</div>
            </div>`;
                })
                .join('')
        }
      </div>

      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="gc">
          <div class="ch"><div><div class="ch-title">Nadchodzące</div><div class="ch-sub">${escapeHtml(periodLabel(shiftPeriod(State.period, +1)))}</div></div></div>
          ${(() => {
            if (!upcoming.length)
              return `<div style="padding:18px">${emptyState('Brak harmonogramu na kolejny miesiąc.', 'Przejdź do następnego okresu i kliknij „Generuj miesiąc".')}</div>`;
            return `<div class="upcoming-list">${upcoming
              .slice(0, 8)
              .map((p) => {
                const due = p.due_date ? new Date(p.due_date) : null;
                const day = due ? String(due.getDate()).padStart(2, '0') : '—';
                const mon = due ? PL_MONTHS_SHORT[due.getMonth()].toLowerCase() : '';
                const status = p.status === 'pending' ? 'amber' : 'cyan';
                return `<div class="up-item">
                <div class="up-date" style="background:var(--${status}-l)"><div class="up-day" style="color:var(--${status})">${day}</div><div class="up-mon" style="color:var(--${status})">${mon}</div></div>
                <div style="flex:1;min-width:0">
                  <div class="up-name">${escapeHtml(p.tenant_name || '—')} — ${escapeHtml(p.unit_code || p.unit_name || '')}</div>
                  <div class="up-detail">${p.status === 'pending' ? 'oczekuje potwierdzenia' : 'termin ' + fmtDateShort(p.due_date)}</div>
                </div>
                <div class="up-amount" style="color:var(--${status === 'amber' ? 'amber' : 'emerald'})">${fmtPLN(paymentExpectedTotal(p))} zł</div>
              </div>`;
              })
              .join('')}</div>`;
          })()}
        </div>

        <div class="gc">
          <div class="ch"><div><div class="ch-title">Podsumowanie</div><div class="ch-sub">${escapeHtml(periodLabel(State.period))}</div></div></div>
          <div style="padding:16px 20px">
            <div class="summary-row"><span class="lbl">Przychody (zatwierdzone)</span><span class="val" style="color:var(--emerald)">+ ${fmtPLN(r.gross)} zł</span></div>
            <div class="summary-row"><span class="lbl">Oczekiwane bez kar</span><span class="val" style="color:var(--t3)">${fmtPLN(r.expected || 0)} zł</span></div>
            ${r.late_fee_expected || r.late_fee_balance ? `<div class="summary-row"><span class="lbl">Kary naliczone / do rozliczenia</span><span class="val" style="color:var(--rose)">${fmtPLN(r.late_fee_expected || 0)} zł / ${fmtPLN(r.late_fee_balance || 0)} zł</span></div>` : ''}
            <div class="summary-row"><span class="lbl">Podatek</span><span class="val" style="color:var(--rose)">− ${fmtPLN(t.podatek_suma || 0)} zł</span></div>
            ${dash && dash.expenses ? `<div class="summary-row"><span class="lbl">Koszty</span><span class="val" style="color:var(--rose)">− ${fmtPLN(dash.expenses.total || 0)} zł</span></div>` : ''}
            <div class="summary-row last"><span class="lbl">Netto właściciel</span><span class="val" style="color:var(--emerald);font-size:18px">${fmtPLN(owner)} zł</span></div>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('btn-add').onclick = () => editPayment(null);
  document.getElementById('btn-gen').onclick = () => doGenerateMonth();
  document.getElementById('btn-csv').onclick = () => {
    window.location = `/api/export/payments.csv?period=${State.period}`;
  };

  const q = document.getElementById('pay-q');
  let qt;
  q.oninput = () => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      State.paymentsQ = q.value.trim();
      render();
    }, 350);
  };

  document.querySelectorAll('[data-pf]').forEach(
    (b) =>
      (b.onclick = () => {
        State.paymentsFilter = b.dataset.pf;
        render();
      }),
  );
  bindPaymentChecks();
  bindApproveMonth();
}

window.editPayment = async function (id) {
  const [tenants, units] = await Promise.all([Api.get('/tenants'), Api.get('/units')]);
  let initial = { period: State.period, status: 'pending', due_day: 31 };
  if (id) initial = await Api.get(`/payments/${id}`);
  formModal({
    title: id ? 'Edytuj płatność' : 'Dodaj płatność',
    wide: true,
    fields: [
      { name: 'period', label: 'Okres (YYYY-MM)', type: 'text', required: true },
      {
        name: 'unit_id',
        label: 'Lokal',
        type: 'select',
        options: [
          { value: '', label: '—' },
          ...units.map((u) => ({ value: u.id, label: `${u.property_name} · ${u.name}` })),
        ],
      },
      {
        name: 'tenant_id',
        label: 'Najemca',
        type: 'select',
        options: [{ value: '', label: '—' }, ...tenants.map((t) => ({ value: t.id, label: t.name }))],
      },
      { name: 'due_day', label: 'Termin (dzień)', type: 'number' },
      { name: 'paid_date', label: 'Data wpłaty', type: 'date' },
      { name: 'rent_amount', label: 'Czynsz', type: 'number', step: '0.01' },
      { name: 'media_amount', label: 'Media', type: 'number', step: '0.01' },
      { name: 'other_amount', label: 'Inne', type: 'number', step: '0.01' },
      {
        name: 'late_fee_amount',
        label: 'Kara za opóźnienie',
        type: 'number',
        step: '0.01',
        hint: 'Automatycznie 50 zł, gdy data wpłaty jest po terminie. Możesz zmienić albo wyzerować.',
      },
      {
        name: 'late_fee_paid',
        label: 'Zapłacono z kary',
        type: 'number',
        step: '0.01',
        hint: 'Osobna ewidencja kar. Nie zwiększa przychodu z czynszu w tym miesiącu.',
      },
      { name: 'total_paid', label: 'Wpłacono bez kar', type: 'number', step: '0.01' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'paid', label: 'Opłacona' },
          { value: 'pending', label: 'Oczekuje' },
          { value: 'overdue', label: 'Zaległa' },
          { value: 'partial', label: 'Częściowa' },
        ],
      },
      { name: 'notes', label: 'Notatka', type: 'textarea', full: true },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/payments/${id}`, b);
      else await Api.post('/payments', b);
      toast(id ? 'Zaktualizowano' : 'Dodano płatność');
      render();
    },
  });
};

window.deletePayment = function (id) {
  confirmDialog({
    title: 'Usuń płatność',
    message: 'Usunąć ten wpis?',
    danger: true,
    onYes: async () => {
      await Api.del(`/payments/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

// ═══════════════════════ BANK / UZGADNIANIE ═══════════════════════
function bankTransactionStatus(status) {
  return (
    {
      new: { cls: 'chip-n', label: 'Do dopasowania' },
      suggested: { cls: 'chip-a', label: 'Propozycja' },
      matched: { cls: 'chip-e', label: 'Uzgodniona' },
      ignored: { cls: 'chip-n', label: 'Pominięta' },
    }[status] || { cls: 'chip-n', label: status || '—' }
  );
}

async function renderBanking(root) {
  const status = State.bankStatus || 'all';
  const data = await Api.get(`/banking?status=${encodeURIComponent(status)}`);
  const transactions = data.transactions || [];
  const stats = data.stats || {};
  setTopbar(
    VIEW_TITLES.banking,
    `${Number(stats.matched || 0)} uzgodnionych · ${Number(stats.unmatched || 0) + Number(stats.suggested || 0)} oczekuje`,
    `<button class="tb-btn tb-ghost" id="bank-confirm-high" ${Number(stats.high_confidence || 0) ? '' : 'disabled'}>Uzgodnij pewne (${Number(stats.high_confidence || 0)})</button>
     <button class="tb-btn tb-primary" id="bank-import"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M4 21h16"/></svg>Import CSV</button>`,
  );
  root.innerHTML = `
    <div class="kpi-strip kpi-strip-flat-4 bank-kpis">
      <div class="kpi-sm"><div class="ks-label">Do dopasowania</div><div class="ks-val">${Number(stats.unmatched || 0)}</div><div class="ks-delta delta-n">wymagają decyzji</div></div>
      <div class="kpi-sm"><div class="ks-label">Pewne propozycje</div><div class="ks-val">${Number(stats.high_confidence || 0)}</div><div class="ks-delta delta-up">gotowe do zatwierdzenia</div></div>
      <div class="kpi-sm"><div class="ks-label">Uzgodnione</div><div class="ks-val">${Number(stats.matched || 0)}</div><div class="ks-delta delta-n">transakcji</div></div>
      <div class="kpi-sm"><div class="ks-label">Kwota uzgodniona</div><div class="ks-val">${fmtPLN(stats.matched_amount || 0)}<span class="ks-unit">PLN</span></div><div class="ks-delta delta-n">łącznie</div></div>
    </div>
    <div class="gc">
      <div class="ch bank-toolbar">
        <div><div class="ch-title">Wyciąg bankowy</div><div class="ch-sub">dopasowanie kwoty, najemcy, lokalu i okresu</div></div>
        <div class="filter-tabs bank-filter-tabs">
          ${[
            ['all', 'Wszystkie'],
            ['suggested', 'Propozycje'],
            ['new', 'Niedopasowane'],
            ['matched', 'Uzgodnione'],
            ['ignored', 'Pominięte'],
          ]
            .map(
              ([value, label]) =>
                `<button class="ftab ${status === value ? 'on' : ''}" data-bank-status="${value}">${label}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="bank-list">
        ${
          transactions.length
            ? transactions
                .map((transaction) => {
                  const state = bankTransactionStatus(transaction.status);
                  const suggestion = transaction.suggested_payment_id
                    ? `<div class="bank-suggestion">
                        <div><strong>${escapeHtml(transaction.suggested_tenant_name || 'Płatność')}</strong><span>${escapeHtml(transaction.suggested_property_name || '')} ${escapeHtml(transaction.suggested_unit_code || transaction.suggested_unit_name || '')} · ${escapeHtml(transaction.suggested_period || '')}</span></div>
                        <div class="bank-confidence">${Number(transaction.confidence || 0)}%</div>
                       </div>
                       <div class="bank-reason">${escapeHtml(transaction.match_reason || '')}</div>`
                    : `<div class="bank-reason">${escapeHtml(transaction.match_reason || 'Brak jednoznacznego dopasowania — wybierz płatność ręcznie.')}</div>`;
                  let actions = '';
                  if (transaction.status === 'suggested') {
                    actions = `<button class="tb-btn tb-primary" data-bank-match="${transaction.id}">Zatwierdź</button>
                               <button class="tb-btn tb-ghost" data-bank-manual="${transaction.id}">Zmień</button>
                               <button class="tb-btn tb-ghost" data-bank-ignore="${transaction.id}">Pomiń</button>`;
                  } else if (transaction.status === 'new') {
                    actions = `<button class="tb-btn tb-primary" data-bank-manual="${transaction.id}">Dopasuj</button>
                               <button class="tb-btn tb-ghost" data-bank-ignore="${transaction.id}">Pomiń</button>`;
                  } else if (transaction.status === 'matched') {
                    actions = `<button class="tb-btn tb-ghost" data-bank-undo="${transaction.id}">Cofnij uzgodnienie</button>`;
                  } else if (transaction.status === 'ignored') {
                    actions = `<button class="tb-btn tb-ghost" data-bank-reopen="${transaction.id}">Przywróć</button>`;
                  }
                  return `<article class="bank-row">
                    <div class="bank-date"><strong>${fmtDate(transaction.booked_date)}</strong><span>${escapeHtml(transaction.bank_name || transaction.file_name || '')}</span></div>
                    <div class="bank-main"><div class="bank-title">${escapeHtml(transaction.title || 'Bez tytułu')}</div><div class="bank-party">${escapeHtml(transaction.counterparty || 'Nieznany kontrahent')}</div>${suggestion}</div>
                    <div class="bank-amount ${Number(transaction.amount) < 0 ? 'negative' : ''}">${fmtPLN2(transaction.amount)} <span>${escapeHtml(transaction.currency || 'PLN')}</span></div>
                    <div class="bank-state">${chip(state.cls, state.label)}</div>
                    <div class="bank-actions">${actions}</div>
                  </article>`;
                })
                .join('')
            : emptyState('Brak transakcji w tym widoku.', 'Zaimportuj wyciąg CSV albo zmień filtr.')
        }
      </div>
    </div>`;

  root.querySelectorAll('[data-bank-status]').forEach((button) => {
    button.onclick = () => {
      State.bankStatus = button.dataset.bankStatus;
      render();
    };
  });
  root.querySelectorAll('[data-bank-match]').forEach((button) => {
    button.onclick = () => confirmBankTransaction(Number(button.dataset.bankMatch));
  });
  root.querySelectorAll('[data-bank-manual]').forEach((button) => {
    const transaction = transactions.find((row) => String(row.id) === button.dataset.bankManual);
    button.onclick = () => openManualBankMatch(transaction);
  });
  root.querySelectorAll('[data-bank-ignore]').forEach((button) => {
    button.onclick = async () => {
      await Api.post(`/banking/${button.dataset.bankIgnore}/ignore`, {});
      toast('Transakcja pominięta', 'info');
      render();
    };
  });
  root.querySelectorAll('[data-bank-reopen]').forEach((button) => {
    button.onclick = async () => {
      await Api.post(`/banking/${button.dataset.bankReopen}/reopen`, {});
      toast('Transakcja przywrócona');
      render();
    };
  });
  root.querySelectorAll('[data-bank-undo]').forEach((button) => {
    button.onclick = () =>
      confirmDialog({
        title: 'Cofnij uzgodnienie',
        message: 'Płatność odzyska stan sprzed powiązania z tą transakcją.',
        danger: true,
        onYes: async () => {
          await Api.post(`/banking/${button.dataset.bankUndo}/undo`, {});
          toast('Uzgodnienie cofnięte', 'info');
          render();
        },
      });
  });
  document.getElementById('bank-import').onclick = openBankImportDialog;
  document.getElementById('bank-confirm-high').onclick = () => {
    if (!Number(stats.high_confidence || 0)) return;
    confirmDialog({
      title: 'Uzgodnij pewne propozycje',
      message: `Zatwierdzić ${Number(stats.high_confidence || 0)} jednoznacznych dopasowań? Każde można później cofnąć.`,
      onYes: async () => {
        const result = await Api.post('/banking/confirm-high', { threshold: 85 });
        toast(`Uzgodniono: ${result.confirmed}`);
        render();
      },
    });
  };
}

function confirmBankTransaction(transactionId) {
  confirmDialog({
    title: 'Zatwierdź uzgodnienie',
    message: 'Kwota transakcji zostanie dopisana do wskazanej płatności. Operację można cofnąć.',
    onYes: async () => {
      await Api.post(`/banking/${transactionId}/match`, {});
      toast('Wpłata uzgodniona');
      render();
    },
  });
}

function openBankImportDialog() {
  const dialog = modal({
    title: 'Import wyciągu bankowego',
    body: `<div class="form-grid">
      <div class="form-row full"><label>Plik CSV</label><input type="file" id="bank-file" accept=".csv,.txt,text/csv"></div>
      <div class="form-row full"><label>Bank / rachunek (opcjonalnie)</label><input id="bank-name" placeholder="np. ING — najem"></div>
      <div class="form-hint full">Obsługiwane kolumny: data, kwota, tytuł/opis, kontrahent i rachunek. Duplikaty są pomijane automatycznie.</div>
    </div>`,
    footer: `<button class="tb-btn tb-ghost" id="bank-import-cancel">Anuluj</button><button class="tb-btn tb-primary" id="bank-import-save">Importuj i dopasuj</button>`,
  });
  dialog.root.querySelector('#bank-import-cancel').onclick = dialog.close;
  dialog.root.querySelector('#bank-import-save').onclick = async () => {
    const file = dialog.root.querySelector('#bank-file').files[0];
    if (!file) return toast('Wybierz plik CSV', 'err');
    const form = new FormData();
    form.append('file', file);
    form.append('bank_name', dialog.root.querySelector('#bank-name').value.trim());
    try {
      const result = await Api.upload('/banking/import', form);
      toast(`Zaimportowano ${result.imported}, duplikaty ${result.duplicates}`);
      dialog.close();
      render();
    } catch (error) {
      toast(error.message, 'err');
    }
  };
}

async function openManualBankMatch(transaction) {
  if (!transaction) return;
  const batches = await Promise.all(
    ['overdue', 'pending', 'partial'].map((status) => Api.get(`/payments?status=${status}`).catch(() => [])),
  );
  const payments = Array.from(new Map(batches.flat().map((payment) => [payment.id, payment])).values()).sort(
    (a, b) => String(b.period).localeCompare(String(a.period)),
  );
  if (!payments.length) return toast('Brak otwartych płatności do uzgodnienia', 'err');
  const dialog = modal({
    title: 'Ręczne dopasowanie wpłaty',
    body: `<div class="bank-match-summary"><strong>${fmtPLN2(transaction.amount)} ${escapeHtml(transaction.currency || 'PLN')}</strong><span>${fmtDate(transaction.booked_date)} · ${escapeHtml(transaction.counterparty || '')}</span><p>${escapeHtml(transaction.title || '')}</p></div>
      <div class="form-grid">
        <div class="form-row full"><label>Płatność</label><select id="bank-payment">${payments
          .map(
            (payment) =>
              `<option value="${payment.id}" ${String(payment.id) === String(transaction.suggested_payment_id) ? 'selected' : ''}>${escapeHtml(payment.tenant_name || '—')} · ${escapeHtml(payment.property_name || '')} ${escapeHtml(payment.unit_code || payment.unit_name || '')} · ${escapeHtml(payment.period)} · pozostało ${fmtPLN(Math.max(0, Number(payment.expected_total || 0) - Number(payment.total_paid || 0)))} zł</option>`,
          )
          .join('')}</select></div>
        <div class="form-row full"><label>Kwota do przypisania</label><input id="bank-match-amount" type="number" step="0.01" min="0.01" max="${Number(transaction.amount)}" value="${Number(transaction.amount)}"></div>
      </div>`,
    footer: `<button class="tb-btn tb-ghost" id="bank-match-cancel">Anuluj</button><button class="tb-btn tb-primary" id="bank-match-save">Zatwierdź dopasowanie</button>`,
  });
  dialog.root.querySelector('#bank-match-cancel').onclick = dialog.close;
  dialog.root.querySelector('#bank-match-save').onclick = async () => {
    try {
      await Api.post(`/banking/${transaction.id}/match`, {
        payment_id: Number(dialog.root.querySelector('#bank-payment').value),
        amount: Number(dialog.root.querySelector('#bank-match-amount').value),
      });
      toast('Wpłata uzgodniona');
      dialog.close();
      render();
    } catch (error) {
      toast(error.message, 'err');
    }
  };
}

// ═══════════════════════ NIERUCHOMOŚCI ═══════════════════════
async function renderProperties(root) {
  const fromP = shiftPeriod(State.period, -11);
  const [props, allUnits, contracts, payments, expenses] = await Promise.all([
    Api.get('/properties'),
    Api.get('/units').catch(() => []),
    Api.get('/contracts').catch(() => []),
    Api.get(`/payments?from_period=${fromP}&to_period=${State.period}`).catch(() => []),
    Api.get(`/expenses?from=${fromP}-01`).catch(() => []),
  ]);

  const totalRent = allUnits.reduce((sum, unit) => {
    const contract = contracts.find((item) => item.status === 'active' && item.unit_id === unit.id);
    return sum + (contract ? contractTerms(contract).rent : unit.base_rent || 0);
  }, 0);
  const totalMedia = allUnits.reduce((sum, unit) => {
    const contract = contracts.find((item) => item.status === 'active' && item.unit_id === unit.id);
    return sum + (contract ? contractTerms(contract).media_advance : unit.base_media || 0);
  }, 0);
  const occupied = allUnits.filter((u) => u.status === 'rented').length;
  const ending30 = contracts.filter((c) => {
    const endDate = contractTerms(c).end_date;
    if (c.status !== 'active' || !endDate) return false;
    const days = (new Date(endDate) - Date.now()) / 86400000;
    return days >= 0 && days <= 30;
  });

  setTopbar(
    VIEW_TITLES.nieruchomosci,
    `${props.length} nieruchomości · ${allUnits.length} lokali`,
    `<button class="tb-btn tb-primary" id="btn-add-prop"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Dodaj nieruchomość</button>`,
  );

  root.innerHTML = `
    <div class="kpi-strip">
      <div class="kpi-hero">
        <div class="kh-label">Łączny czynsz / mies.</div>
        <div class="kh-val">${fmtPLN(totalRent + totalMedia)}<span class="kh-unit">PLN</span></div>
        <div class="kh-sub">${props.length} nieruchomości · ${allUnits.length} lokali</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-c"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>
        <div class="ks-label">Nieruchomości</div>
        <div class="ks-val">${props.length}</div>
        <div class="ks-delta delta-n">aktywnych</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-e"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg></div>
        <div class="ks-label">Zajęte lokale</div>
        <div class="ks-val">${occupied}<span class="ks-unit">/ ${allUnits.length}</span></div>
        ${chip(occupied === allUnits.length ? 'chip-e' : 'chip-a', allUnits.length ? Math.round((occupied / allUnits.length) * 100) + '%' : '0%', occupied === allUnits.length)}
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-v"><svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"/></svg></div>
        <div class="ks-label">Czynsz / mies.</div>
        <div class="ks-val">${fmtPLN(totalRent)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">media: ${fmtPLN(totalMedia)} zł</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-a"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
        <div class="ks-label">Umów wygasa</div>
        <div class="ks-val">${ending30.length}</div>
        <div class="ks-delta ${ending30.length ? 'delta-dn' : 'delta-n'}">w ciągu 30 dni</div>
      </div>
    </div>

    ${props
      .map((p, i) =>
        renderPropertyCard(
          p,
          allUnits.filter((u) => u.property_id === p.id),
          contracts,
          payments,
          expenses.filter((e) => e.property_id === p.id),
          i,
        ),
      )
      .join('')}`;

  document.getElementById('btn-add-prop').onclick = () => editProperty(null);
  // Nazwa nieruchomości pozostaje wyłącznie w stanie JavaScript, nigdy w HTML.
  root.querySelectorAll('[data-delete-property-id]').forEach((button) => {
    const id = Number(button.dataset.deletePropertyId);
    button.addEventListener('click', () => {
      const property = props.find((p) => p.id === id);
      if (property) deleteProperty(id, property.name);
    });
  });
}

function renderPropertyCard(p, units, contracts, payments, expenses, idx) {
  const contractByUnit = {};
  for (const c of contracts) {
    if (c.status !== 'active') continue;
    const cur = contractByUnit[c.unit_id];
    if (!cur || (c.start_date || '') > (cur.start_date || '')) contractByUnit[c.unit_id] = c;
  }
  const occupied = units.filter((u) => u.status === 'rented').length;
  const totalRent = units.reduce(
    (s, u) => s + (contractByUnit[u.id] ? contractTerms(contractByUnit[u.id]).rent : (u.base_rent ?? 0)),
    0,
  );
  const totalMedia = units.reduce(
    (s, u) =>
      s + (contractByUnit[u.id] ? contractTerms(contractByUnit[u.id]).media_advance : (u.base_media ?? 0)),
    0,
  );

  // Single-unit property → uproszczony szczegół
  if (units.length <= 1) {
    const u = units[0];
    const c = u ? contractByUnit[u.id] : null;
    const tenantName = u ? u.tenant_name : null;
    const terms = c ? contractTerms(c) : null;
    const rent = terms ? terms.rent : u ? u.base_rent : 0;
    const media = terms ? terms.media_advance : u ? u.base_media : 0;
    const total = rent + media;
    return `
      <div class="gc">
        <div class="ch">
          <div><div class="ch-title">${escapeHtml(p.name)}</div><div class="ch-sub">${escapeHtml(p.address || p.district || '—')}</div></div>
          <div style="display:flex;gap:6px;align-items:center">
            ${chip(occupied ? 'chip-e' : 'chip-n', occupied ? 'Zajęta' : 'Wolna', !!occupied)}
            <button class="icon-btn" onclick="editProperty(${p.id})" title="Edytuj"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="icon-btn danger" type="button" data-delete-property-id="${p.id}" title="Usuń"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
          </div>
        </div>
        <div class="prop-detail">
          <div class="prop-detail-col">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:var(--t4);margin-bottom:14px">Finansowe (z umowy)</div>
            <div class="prop-detail-grid">
              <div><div class="prop-detail-stat-lbl">Czynsz</div><div class="prop-detail-stat-val">${fmtPLN(rent)} zł</div></div>
              <div><div class="prop-detail-stat-lbl">Media</div><div class="prop-detail-stat-val">${fmtPLN(media)} zł</div></div>
              <div><div class="prop-detail-stat-lbl">Łącznie</div><div class="prop-detail-stat-val" style="color:var(--emerald)">${fmtPLN(total)} zł</div></div>
              <div><div class="prop-detail-stat-lbl">Kaucja</div><div class="prop-detail-stat-val">${fmtPLN(c ? c.deposit : 0)} zł</div></div>
              <div><div class="prop-detail-stat-lbl">Termin</div><div class="prop-detail-stat-val">${terms?.pay_by_day ? 'do ' + terms.pay_by_day + '.' : '—'}</div></div>
            </div>
          </div>
          <div class="prop-detail-col">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:var(--t4);margin-bottom:14px">Najemca</div>
            ${
              tenantName
                ? `
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;min-width:0">
                ${avatarLg(tenantName)}
                <div style="flex:1;min-width:0;overflow:hidden"><div style="font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(tenantName)}</div>
                  <div style="font-size:12px;color:var(--t4);margin-top:2px">${contractStatusState(c.status, terms?.end_date, c.workflow_stage).label}${terms?.end_date ? ` · umowa do ${fmtDate(terms.end_date)}` : ''}</div></div>
                ${contractStatusChip(c.status, terms?.end_date, c.workflow_stage)}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="tb-btn tb-ghost" onclick="openTenantDetails(${u.tenant_id})" style="font-size:12px">Najemca</button>
                ${c ? `<button class="tb-btn tb-ghost" onclick="editContract(${c.id})" style="font-size:12px">Umowa</button>` : ''}
                ${c ? `<button class="tb-btn tb-ghost" onclick="endContractFlow(${c.id})" style="font-size:12px">Zakończ umowę</button>` : ''}
                <button class="tb-btn tb-ghost" onclick="tenantTurnover(${u.id}, ${c ? c.id : 'null'})" style="font-size:12px">Zmień najemcę</button>
                <button class="tb-btn tb-ghost" onclick="editUnit(${u.id})" style="font-size:12px">Lokal</button>
              </div>`
                : `<div style="color:var(--t4);font-style:italic">— lokal niewynajęty —</div>`
            }
            ${!tenantName && u ? `<div style="margin-top:14px"><button class="tb-btn tb-primary" onclick="tenantTurnover(${u.id}, null)" style="font-size:12px">Dodaj najemcę</button></div>` : ''}
          </div>
        </div>
      </div>`;
  }

  // Multi-unit (Chrobrego) → podsumowanie + lista pokoi
  const totalDeposit = units.reduce((s, u) => s + ((contractByUnit[u.id] || {}).deposit || 0), 0);
  const totalMonthly = totalRent + totalMedia;
  // Termin: jeśli wszyscy mają ten sam pay_by_day, pokaż go; inaczej "różne"
  const days = new Set(
    units
      .map((u) => (contractByUnit[u.id] ? contractTerms(contractByUnit[u.id]).pay_by_day : null))
      .filter((d) => d != null),
  );
  const termLbl = days.size === 0 ? '—' : days.size === 1 ? `do ${[...days][0]}.` : 'różne';
  const ends = units
    .map((u) => (contractByUnit[u.id] ? contractTerms(contractByUnit[u.id]).end_date : null))
    .filter(Boolean)
    .sort();
  const earliestEnd = ends[0];

  return `
    <div class="gc">
      <div class="ch">
        <div><div class="ch-title">${escapeHtml(p.name)}</div><div class="ch-sub">${units.length} lokali · ${escapeHtml(p.address || p.district || '—')}</div></div>
        <div style="display:flex;gap:6px;align-items:center">
          ${chip('chip-c', `${occupied}/${units.length} zajętych`)}
          <button class="icon-btn" onclick="editProperty(${p.id})" title="Edytuj"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="icon-btn danger" type="button" data-delete-property-id="${p.id}" title="Usuń"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
        </div>
      </div>
      <div class="prop-detail-col" style="border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:var(--t4);margin-bottom:14px">Finansowe (z umów aktywnych)</div>
        <div class="prop-detail-grid">
          <div><div class="prop-detail-stat-lbl">Czynsz</div><div class="prop-detail-stat-val">${fmtPLN(totalRent)} zł</div></div>
          <div><div class="prop-detail-stat-lbl">Media</div><div class="prop-detail-stat-val">${fmtPLN(totalMedia)} zł</div></div>
          <div><div class="prop-detail-stat-lbl">Łącznie</div><div class="prop-detail-stat-val" style="color:var(--emerald)">${fmtPLN(totalMonthly)} zł</div></div>
          <div><div class="prop-detail-stat-lbl">Kaucja (suma)</div><div class="prop-detail-stat-val">${fmtPLN(totalDeposit)} zł</div></div>
          <div><div class="prop-detail-stat-lbl">Termin</div><div class="prop-detail-stat-val">${escapeHtml(termLbl)}</div></div>
          ${earliestEnd ? `<div><div class="prop-detail-stat-lbl">Najbliższy koniec umowy</div><div class="prop-detail-stat-val" style="font-size:14px">${fmtDate(earliestEnd)}</div></div>` : ''}
        </div>
      </div>
      <div class="rooms-list">
        <div class="rooms-row head">
          <div>Pokój</div><div>Najemca</div><div class="rr-col-status">Status</div>
          <div class="rr-col-rent">Czynsz</div><div class="rr-col-media">Media</div>
          <div>Łącznie</div><div class="rr-col-end">Umowa do</div><div></div>
        </div>
        ${units
          .map((u) => {
            const c = contractByUnit[u.id];
            const terms = c ? contractTerms(c) : null;
            const rent = terms ? terms.rent : u.base_rent || 0;
            const media = terms ? terms.media_advance : u.base_media || 0;
            const total = rent + media;
            const status = c ? contractStatusState(c.status, terms?.end_date, c.workflow_stage) : null;
            const isWarn = status && ['Wygasa', 'Po terminie'].includes(status.label);
            return `<div class="rooms-row">
            <div class="rr-code">${escapeHtml(u.code || u.name || '—')}</div>
            <div class="rr-tenant">${u.tenant_name ? `${avatar(u.tenant_name)}<span class="t-name">${escapeHtml(u.tenant_name)}</span>` : '<span style="color:var(--t4);font-style:italic">— wolny —</span>'}</div>
            <div class="rr-col-status">${u.tenant_name && c ? contractStatusChip(c.status, terms?.end_date, c.workflow_stage) : chip('chip-n', 'Wolny')}</div>
            <div class="rr-num rr-col-rent">${fmtPLN(rent)} zł</div>
            <div class="rr-num rr-col-media">${fmtPLN(media)} zł</div>
            <div class="${isWarn ? 'rr-num-a' : 'rr-num-e'}">${fmtPLN(total)} zł</div>
            <div class="rr-num rr-col-end" style="${isWarn ? 'color:var(--amber)' : ''}">${terms?.end_date ? fmtDate(terms.end_date) + (isWarn ? ' ⚠' : '') : '—'}</div>
            <div class="rr-actions">
              ${c ? `<button class="tb-btn tb-ghost" onclick="endContractFlow(${c.id})" title="Zakończ umowę" style="font-size:11px;padding:0 8px;height:30px">Zakończ</button>` : ''}
              <button class="tb-btn ${c ? 'tb-ghost' : 'tb-primary'}" onclick="tenantTurnover(${u.id}, ${c ? c.id : 'null'})" title="${c ? 'Zmień najemcę' : 'Dodaj najemcę'}" style="font-size:11px;padding:0 8px;height:30px">${c ? 'Zmień' : 'Dodaj'}</button>
              <button class="icon-btn" onclick="editUnit(${u.id})" title="Edytuj lokal"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
              ${c ? `<button class="icon-btn" onclick="editContract(${c.id})" title="Edytuj umowę"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>` : ''}
              ${u.tenant_id ? `<button class="icon-btn" onclick="openTenantDetails(${u.tenant_id})" title="Najemca"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></button>` : ''}
            </div>
          </div>`;
          })
          .join('')}
        <div class="rooms-row foot">
          <div></div><div style="font-size:13px">Suma</div><div class="rr-col-status"></div>
          <div class="rr-num rr-col-rent">${fmtPLN(totalRent)} zł</div>
          <div class="rr-num rr-col-media">${fmtPLN(totalMedia)} zł</div>
          <div class="rr-num-e" style="font-size:13px">${fmtPLN(totalRent + totalMedia)} zł</div>
          <div class="rr-col-end"></div><div></div>
        </div>
      </div>
    </div>`;
}

window.deleteProperty = function (id, name) {
  confirmDialog({
    title: 'Usuń nieruchomość',
    message: `Usunąć "${name}" wraz z lokalami?`,
    danger: true,
    onYes: async () => {
      await Api.del(`/properties/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

window.editProperty = async function (id) {
  if (id) {
    const initial = await Api.get(`/properties/${id}`);
    formModal({
      title: `Edytuj: ${initial.name}`,
      fields: [
        { name: 'name', label: 'Nazwa', required: true },
        {
          name: 'type',
          label: 'Typ',
          type: 'select',
          options: [
            { value: 'mieszkanie', label: 'Mieszkanie' },
            { value: 'pokoje', label: 'Pokoje na wynajem' },
            { value: 'inne', label: 'Inne' },
          ],
        },
        { name: 'address', label: 'Adres', full: true },
        { name: 'district', label: 'Dzielnica' },
        { name: 'notes', label: 'Notatki', type: 'textarea', full: true },
      ],
      initial,
      onSubmit: async (b) => {
        await Api.put(`/properties/${id}`, b);
        toast('Zaktualizowano');
        render();
      },
    });
    return;
  }

  // Nowa nieruchomość — modal z dynamicznymi polami zależnymi od typu
  const html = `
    <div class="form-grid" id="np-form">
      <div class="form-row full"><label>Nazwa</label><input name="name" placeholder="np. Kościelna 30/21" required></div>
      <div class="form-row full">
        <label>Typ nieruchomości</label>
        <select name="type" id="np-type">
          <option value="mieszkanie">Mieszkanie (jeden lokal)</option>
          <option value="pokoje">Pokoje na wynajem (wielopokojowa)</option>
          <option value="inne">Inne</option>
        </select>
      </div>
      <div class="form-row full"><label>Adres</label><input name="address" placeholder="ulica, miasto"></div>
      <div class="form-row"><label>Dzielnica</label><input name="district"></div>

      <div class="form-row full" id="np-rooms-row" style="display:none">
        <label>Liczba pokoi <span style="color:var(--violet)">★</span></label>
        <input name="rooms_count" type="number" min="2" max="50" value="6" style="font-size:18px;font-weight:700">
        <div class="hint">Aplikacja utworzy automatycznie pokoje <strong>P1, P2, …, PN</strong> dla każdego z lokali. Min 2, max 50.</div>
      </div>

      <div class="form-row" id="np-rent-row">
        <label>Czynsz / lokal [PLN]</label>
        <input name="base_rent" type="number" step="0.01" value="0">
        <div class="hint" id="np-rent-hint">Domyślny czynsz pojedynczego lokalu.</div>
      </div>
      <div class="form-row" id="np-media-row">
        <label>Media / lokal [PLN]</label>
        <input name="base_media" type="number" step="0.01" value="0">
      </div>

      <div class="form-row full"><label>Notatki</label><textarea name="notes" placeholder="opcjonalne"></textarea></div>

      <div class="form-row full" id="np-preview" style="background:var(--violet-l);border:1px solid rgba(139,92,246,0.3);border-radius:10px;padding:12px 14px;color:var(--violet);font-size:12.5px">
        Po zapisie zostanie utworzony <strong id="np-preview-text">1 lokal (Lokal — kod KR)</strong>.
      </div>
    </div>`;

  const m = modal({
    title: 'Nowa nieruchomość',
    body: html,
    wide: true,
    footer: `<button class="tb-btn tb-ghost" id="m-cancel">Anuluj</button>
             <button class="tb-btn tb-primary" id="m-save">Utwórz nieruchomość</button>`,
  });
  m.root.querySelector('#m-cancel').onclick = m.close;

  const form = m.root.querySelector('#np-form');
  const typeSel = form.querySelector('#np-type');
  const roomsRow = form.querySelector('#np-rooms-row');
  const roomsInput = roomsRow.querySelector('input[name="rooms_count"]');
  const previewText = form.querySelector('#np-preview-text');
  const rentHint = form.querySelector('#np-rent-hint');

  function refreshPreview() {
    const t = typeSel.value;
    if (t === 'pokoje') {
      const n = Math.max(2, Math.min(50, parseInt(roomsInput.value, 10) || 2));
      previewText.innerHTML = `<strong>${n} pokoi</strong> z kodami P1..P${n} (każdy z osobnym czynszem i mediami)`;
      rentHint.textContent = `Czynsz dla każdego z ${n} pokoi (możesz zmienić indywidualnie później).`;
    } else if (t === 'mieszkanie') {
      previewText.innerHTML = `<strong>1 lokal</strong> (nazwa: „Lokal", kod: KR)`;
      rentHint.textContent = 'Czynsz dla tego lokalu.';
    } else {
      previewText.innerHTML = `<strong>1 lokal</strong> (typ inny — bez auto-podziału)`;
      rentHint.textContent = 'Czynsz dla tego lokalu.';
    }
  }

  function updateVisibility() {
    if (typeSel.value === 'pokoje') {
      roomsRow.style.display = '';
    } else {
      roomsRow.style.display = 'none';
    }
    refreshPreview();
  }

  typeSel.onchange = updateVisibility;
  roomsInput.oninput = refreshPreview;
  updateVisibility();

  m.root.querySelector('#m-save').onclick = async () => {
    const b = {
      name: form.querySelector('input[name="name"]').value.trim(),
      type: typeSel.value,
      address: form.querySelector('input[name="address"]').value.trim() || null,
      district: form.querySelector('input[name="district"]').value.trim() || null,
      notes: form.querySelector('textarea[name="notes"]').value.trim() || null,
    };
    if (!b.name) {
      toast('Nazwa wymagana', 'err');
      return;
    }

    try {
      const created = await Api.post('/properties', b);
      const baseRent = +form.querySelector('input[name="base_rent"]').value || 0;
      const baseMedia = +form.querySelector('input[name="base_media"]').value || 0;

      if (b.type === 'pokoje') {
        const n = Math.max(2, Math.min(50, parseInt(roomsInput.value, 10) || 2));
        for (let i = 1; i <= n; i++) {
          await Api.post('/units', {
            property_id: created.id,
            name: `Pokój ${i}`,
            code: `P${i}`,
            base_rent: baseRent,
            base_media: baseMedia,
            status: 'vacant',
          });
        }
        toast(`Utworzono nieruchomość + ${n} pokoi`, 'ok', 3500);
      } else {
        await Api.post('/units', {
          property_id: created.id,
          name: 'Lokal',
          code: 'KR',
          base_rent: baseRent,
          base_media: baseMedia,
          status: 'vacant',
        });
        toast('Utworzono nieruchomość + 1 lokal', 'ok');
      }
      m.close();
      render();
    } catch (e) {
      toast(e.message || 'Błąd zapisu', 'err');
    }
  };
};

window.editUnit = async function (id, prefillPropertyId) {
  const props = await Api.get('/properties');
  let initial = { status: 'rented', base_rent: 0, base_media: 0 };
  if (id) initial = await Api.get(`/units/${id}`);
  else if (prefillPropertyId) initial.property_id = prefillPropertyId;
  formModal({
    title: id ? `Edytuj lokal: ${initial.name}` : 'Nowy lokal',
    fields: [
      {
        name: 'property_id',
        label: 'Nieruchomość',
        type: 'select',
        options: props.map((p) => ({ value: p.id, label: p.name })),
        required: true,
      },
      { name: 'name', label: 'Nazwa', required: true },
      { name: 'code', label: 'Kod (np. P1)' },
      { name: 'area_m2', label: 'Powierzchnia [m²]', type: 'number', step: '0.01' },
      { name: 'base_rent', label: 'Czynsz bazowy', type: 'number', step: '0.01' },
      { name: 'base_media', label: 'Media bazowo', type: 'number', step: '0.01' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'rented', label: 'Wynajęty' },
          { value: 'vacant', label: 'Wolny' },
        ],
      },
      { name: 'notes', label: 'Notatki', type: 'textarea', full: true },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/units/${id}`, b);
      else await Api.post('/units', b);
      toast(id ? 'Zaktualizowano lokal' : 'Dodano lokal');
      render();
    },
  });
};

// ═══════════════════════ NAJEMCY ═══════════════════════
async function renderTenants(root) {
  const fromP = shiftPeriod(State.period, -11);
  const [tenants, props, payments] = await Promise.all([
    Api.get('/tenants'),
    Api.get('/properties'),
    Api.get(`/payments?from_period=${fromP}&to_period=${State.period}`).catch(() => []),
  ]);

  const stStatus = State.tenantsStatus || 'active';
  const stQ = State.tenantsQ || '';
  const stProp = State.tenantsProp || '';

  const payByT = {};
  for (const p of payments) {
    if (p.tenant_id) (payByT[p.tenant_id] = payByT[p.tenant_id] || []).push(p);
  }

  let filtered = tenants.slice();
  if (stStatus !== 'all') filtered = filtered.filter((t) => t.status === stStatus);
  if (stProp) filtered = filtered.filter((t) => String(t.property_id) === String(stProp));
  if (stQ) {
    const q = stQ.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.unit_name || '').toLowerCase().includes(q) ||
        (t.unit_code || '').toLowerCase().includes(q) ||
        (t.property_name || '').toLowerCase().includes(q),
    );
  }
  filtered.sort((a, b) => (a.contract_end || '9999').localeCompare(b.contract_end || '9999'));

  // Grupowanie po nieruchomości
  const byProp = {};
  for (const t of filtered) {
    const key = t.property_name || '— bez przypisania —';
    (byProp[key] = byProp[key] || []).push(t);
  }
  const propNames = Object.keys(byProp).sort();

  const active = tenants.filter((t) => t.status === 'active');
  const ending30 = active.filter((t) => {
    if (!t.contract_end) return false;
    const d = (new Date(t.contract_end) - Date.now()) / 86400000;
    return d >= 0 && d <= 30;
  });

  setTopbar(
    VIEW_TITLES.najemcy,
    `${active.length} aktywnych · ${tenants.length} w bazie`,
    `<button class="tb-btn tb-primary" id="btn-add"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Dodaj najemcę</button>`,
  );

  root.innerHTML = `
    <div class="toolbar">
      <div class="search-box"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="ten-q" placeholder="Szukaj najemcy, lokalu, telefonu…" value="${escapeHtml(stQ)}"></div>
      <div class="fsep"></div>
      <div class="fgroup"><span class="flbl">Status:</span>
        ${[
          ['active', 'Aktywni'],
          ['inactive', 'Historyczni'],
          ['all', 'Wszyscy'],
        ]
          .map(([v, l]) => `<button class="ftab ${stStatus === v ? 'on' : ''}" data-ts="${v}">${l}</button>`)
          .join('')}
      </div>
      <div class="fsep"></div>
      <div class="fgroup"><span class="flbl">Nieruchomość:</span>
        <button class="ftab ${!stProp ? 'on' : ''}" data-tp="">Wszystkie</button>
        ${props.map((p) => `<button class="ftab ${String(stProp) === String(p.id) ? 'on' : ''}" data-tp="${p.id}">${escapeHtml(p.name)}</button>`).join('')}
      </div>
      <div style="margin-left:auto;font-size:12px;color:var(--t4)">${filtered.length} z ${tenants.length}</div>
    </div>

    <div class="tenant-bento">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        ${
          filtered.length === 0
            ? `<div class="gc">${emptyState('Brak najemców pasujących do filtrów.')}</div>`
            : propNames
                .map((propName) => {
                  const list = byProp[propName];
                  const groupRent = list
                    .filter((t) => t.status === 'active')
                    .reduce((s, t) => s + (t.contract_rent || 0) + (t.contract_media || 0), 0);
                  return `<div class="gc">
              <div class="ch">
                <div><div class="ch-title">${escapeHtml(propName)}</div>
                  <div class="ch-sub">${list.length} ${list.length === 1 ? 'najemca' : 'najemców'}${groupRent ? ` · ${fmtPLN(groupRent)} zł/mies (aktywni)` : ''}</div></div>
              </div>
              <div class="tenant-rows">
                <div class="tenant-row tenant-row-head">
                  <div></div>
                  <div>Najemca</div>
                  <div>Lokal</div>
                  <div>Umowa do</div>
                  <div>Terminowość</div>
                  <div>Czynsz</div>
                  <div>Status</div>
                </div>
                ${list.map((t) => tenantRow(t, payByT[t.id] || [])).join('')}
              </div>
            </div>`;
                })
                .join('')
        }
      </div>

      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="gc">
          <div class="ch"><div><div class="ch-title">Terminowość wpłat (12m)</div><div class="ch-sub">na podstawie statusów płatności</div></div></div>
          <div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px">
            ${active
              .map((t) => {
                const ps = payByT[t.id] || [];
                const paid = ps.filter((p) => p.status === 'paid').length;
                const pct = ps.length ? Math.round((paid / ps.length) * 100) : 0;
                const color = pct >= 90 ? 'emerald' : pct >= 70 ? 'amber' : 'rose';
                return `<div style="display:flex;align-items:center;gap:10px">
                ${avatar(t.name)}
                <span style="flex:1;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.name)}</span>
                <div style="flex:1;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;min-width:60px"><div style="width:${pct}%;height:4px;background:var(--${color});border-radius:2px;${pct === 100 ? 'box-shadow:0 0 6px rgba(16,185,129,0.4)' : ''}"></div></div>
                <span style="font-family:var(--mono);font-size:12px;color:var(--${color});margin-left:6px;min-width:36px;text-align:right">${pct}%</span>
              </div>`;
              })
              .join('')}
          </div>
        </div>

        <div class="gc">
          <div class="ch"><div><div class="ch-title">Terminy umów</div><div class="ch-sub">${active.length} formalnie aktywnych</div></div></div>
          ${active
            .filter((t) => t.contract_end)
            .sort((a, b) => a.contract_end.localeCompare(b.contract_end))
            .slice(0, 8)
            .map((t) => {
              const days = Math.ceil((new Date(t.contract_end) - Date.now()) / 86400000);
              const status = contractStatusState('active', t.contract_end, t.contract_workflow_stage);
              const iconCls = days < 0 ? 'rose' : days <= 30 ? 'amber' : 'emerald';
              return `<div class="cl-item" onclick="openTenantDetails(${t.id})">
              <div class="cl-icon" style="background:var(--${iconCls}-l);color:var(--${iconCls})"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
              <div class="cl-copy"><div class="cl-name">${escapeHtml(t.name)}</div><div class="cl-meta">${fmtDate(t.contract_end)} · ${days < 0 ? `${-days} dni po terminie` : `${days} dni`}</div></div>
              ${chip(status.cls, status.label, status.label === 'Aktywna')}
            </div>`;
            })
            .join('')}
        </div>
      </div>
    </div>`;

  document.getElementById('btn-add').onclick = () => editTenant(null);
  const q = document.getElementById('ten-q');
  let qt;
  q.oninput = () => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      State.tenantsQ = q.value.trim();
      render();
    }, 350);
  };
  document.querySelectorAll('[data-ts]').forEach(
    (b) =>
      (b.onclick = () => {
        State.tenantsStatus = b.dataset.ts;
        render();
      }),
  );
  document.querySelectorAll('[data-tp]').forEach(
    (b) =>
      (b.onclick = () => {
        State.tenantsProp = b.dataset.tp;
        render();
      }),
  );
}

function tenantRow(t, payments) {
  const monthly = (t.contract_rent || 0) + (t.contract_media || 0);
  const paid = payments.filter((p) => p.status === 'paid').length;
  const pct = payments.length ? Math.round((paid / payments.length) * 100) : 0;
  const endChip = t.contract_id
    ? contractStatusChip('active', t.contract_end, t.contract_workflow_stage)
    : chip('chip-n', t.status === 'active' ? 'Brak aktywnej umowy' : 'Historyczny');
  const contractState = t.contract_id
    ? contractStatusState('active', t.contract_end, t.contract_workflow_stage)
    : null;
  const isWarn = contractState && ['Wygasa', 'Po terminie'].includes(contractState.label);
  const pctColor = pct >= 90 ? 'emerald' : pct >= 70 ? 'amber' : 'rose';
  const endStr = t.contract_end ? fmtDate(t.contract_end) + (isWarn ? ' ⚠' : '') : '—';
  return `
    <div class="tenant-row${isWarn ? ' tenant-row-warn' : ''}" onclick="openTenantDetails(${t.id})">
      <div>${(() => {
        const [bg, fg] = colorForName(t.name);
        return `<div class="tc-av" style="background:${bg};color:${fg}">${avatarInitial(t.name)}</div>`;
      })()}</div>
      <div class="tr-cell">
        <div class="tr-val">${escapeHtml(t.name)}</div>
        <div class="tr-mini">${escapeHtml(t.phone || t.email || '—')}</div>
      </div>
      <div class="tr-cell">
        <div class="tr-val">${escapeHtml(t.property_name || '—')}</div>
        <div class="tr-mini">${escapeHtml(t.unit_code || t.unit_name || 'brak lokalu')}</div>
      </div>
      <div class="tr-cell"><div class="tr-val ${isWarn ? 'warn' : ''}">${escapeHtml(endStr)}</div></div>
      <div class="tr-cell"><div class="tr-val" style="color:var(--${pctColor})">${pct}% (${paid}/${payments.length})</div></div>
      <div class="tr-cell"><div class="tr-rent">${fmtPLN(monthly)} zł</div></div>
      <div class="tr-cell tr-status">${endChip}<span class="tc-cta">Szczegóły →</span></div>
    </div>`;
}

window.editTenant = async function (id) {
  const units = await Api.get('/units');
  let initial = { status: 'active' };
  if (id) initial = await Api.get(`/tenants/${id}`);
  formModal({
    title: id ? `Edytuj: ${initial.name}` : 'Nowy najemca',
    wide: true,
    fields: [
      { name: 'name', label: 'Imię/Nazwisko', required: true, full: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Telefon' },
      { name: 'sms_consent', label: 'Zgoda na SMS', type: 'checkbox', default: false },
      { name: 'sms_disabled', label: 'Wyłącz powiadomienia SMS', type: 'checkbox', default: false },
      {
        name: 'current_unit_id',
        label: 'Lokal',
        type: 'select',
        options: [
          { value: '', label: '—' },
          ...units.map((u) => ({ value: u.id, label: `${u.property_name} · ${u.name}` })),
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'active', label: 'Aktywny' },
          { value: 'inactive', label: 'Historyczny' },
        ],
      },
      { name: 'notes', label: 'Notatka', type: 'textarea', full: true },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/tenants/${id}`, b);
      else await Api.post('/tenants', b);
      toast(id ? 'Zaktualizowano' : 'Dodano najemcę');
      render();
    },
  });
};

function lateFeeStatusChip(f) {
  const balance = Number(f && f.balance) || 0;
  const paid = Number(f && f.paid) || 0;
  const resolution = (f && f.resolution) || 'unpaid';
  if (resolution === 'waived') return chip('chip-n', 'Anulowana');
  if (resolution === 'deposit') return chip('chip-v', 'Z kaucji');
  if (balance <= 0 && paid > 0) return chip('chip-e', 'Rozliczona', true);
  if (paid > 0) return chip('chip-a', 'Częściowo');
  return chip('chip-r', 'Do rozliczenia');
}

window.resolveLateFee = async function (paymentId, tenantId) {
  const p = await Api.get(`/payments/${paymentId}`);
  const fee = Number(p.late_fee_amount || 0);
  const paid = Number(p.late_fee_paid || 0);
  const balance = Math.max(0, fee - paid);
  if (!fee) return toast('Ta płatność nie ma naliczonej kary', 'err');

  let finished = false;
  const actionButton = (action, label, cls = 'tb-ghost') =>
    `<button class="tb-btn ${cls}" data-lf-action="${action}" style="justify-content:center">${escapeHtml(label)}</button>`;
  const m = modal({
    title: `Rozlicz karę · ${p.tenant_name || ''} · ${p.period}`,
    wide: true,
    onClose: () => {
      if (!finished) openTenantDetails(tenantId);
    },
    body: `
      <div style="padding:22px 26px;display:flex;flex-direction:column;gap:16px">
        <div class="late-fee-summary">
          <div><span>Naliczono</span><b>${fmtPLN(fee)} zł</b></div>
          <div><span>Rozliczono</span><b style="color:var(--emerald)">${fmtPLN(paid)} zł</b></div>
          <div><span>Pozostało</span><b style="color:${balance > 0 ? 'var(--rose)' : 'var(--t1)'}">${fmtPLN(balance)} zł</b></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
          ${actionButton('paid', 'Zapłacono całość', 'tb-primary')}
          ${actionButton('partial', 'Zapłacono część')}
          ${actionButton('deposit', 'Potrącono z kaucji')}
          ${actionButton('waived', 'Anulowano')}
          ${actionButton('unpaid', 'Cofnij rozliczenie')}
        </div>
        <div class="form-grid compact">
          <div class="form-row">
            <label>Kwota dla opcji częściowej [PLN]</label>
            <input id="lf-amount" type="number" step="0.01" min="0" max="${fee}" value="${balance || fee}">
            <div class="hint">Dla całości, kaucji i anulowania aplikacja rozliczy pełną kwotę kary.</div>
          </div>
          <div class="form-row full">
            <label>Notatka opcjonalna</label>
            <textarea id="lf-note" placeholder="np. potrącone przy zwrocie kaucji albo zapłacone przelewem"></textarea>
          </div>
        </div>
      </div>`,
  });

  m.root.querySelectorAll('[data-lf-action]').forEach((btn) => {
    btn.onclick = async () => {
      const action = btn.dataset.lfAction;
      const amountEl = m.root.querySelector('#lf-amount');
      const noteEl = m.root.querySelector('#lf-note');
      const amount = action === 'partial' ? Number(amountEl.value || 0) : action === 'unpaid' ? 0 : fee;
      if (action === 'partial' && amount <= 0) return toast('Wpisz kwotę częściową', 'err');
      try {
        finished = true;
        await Api.put(`/payments/${paymentId}/late-fee`, { action, amount, note: noteEl.value.trim() });
        toast(action === 'unpaid' ? 'Cofnięto rozliczenie kary' : 'Kara rozliczona');
        m.close();
        openTenantDetails(tenantId);
        render({ preserveScroll: true });
      } catch (e) {
        finished = false;
        toast(e.message || 'Błąd rozliczenia kary', 'err');
      }
    };
  });
};

function paymentReminderAmount(p) {
  return Number(p.rent_amount || 0) + Number(p.media_amount || 0) + Number(p.other_amount || 0);
}
function paymentNeedsReminder(p) {
  return p && p.status !== 'paid' && Number(p.total_paid || 0) < paymentReminderAmount(p);
}
function tenantReminderPayment(t) {
  const payments = (t.payments || []).filter(paymentNeedsReminder);
  return payments.find((p) => p.period === State.period) || payments[0] || null;
}
function smsReminderErrorLabel(code) {
  return (
    {
      payment_not_found: 'Nie znalazłem tej płatności.',
      payment_already_paid: 'Ta płatność jest już oznaczona jako opłacona.',
      sms_consent_required: 'Najemca nie ma aktywnej zgody na SMS.',
      sms_disabled: 'Powiadomienia SMS są wyłączone dla tego najemcy.',
      invalid_phone: 'Najemca nie ma poprawnego numeru telefonu.',
      test_phone_required: 'W trybie testowym wpisz numer testowy w ustawieniach SMS.',
      smsplanet_token_required: 'Brakuje tokenu SMSPlanet po stronie serwera.',
      sms_sender_required: 'Brakuje pola nadawcy SMS.',
    }[code] ||
    code ||
    'Nie udało się przygotować SMS-a.'
  );
}

window.openSmsReminderPreview = async function (paymentId, tenantId) {
  try {
    const preview = await Api.get(`/notifications/payments/${paymentId}/reminder`);
    const m = modal({
      title: 'Wysłać SMS z przypomnieniem?',
      wide: true,
      body: `
        <div style="padding:22px 26px;display:flex;flex-direction:column;gap:14px">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;font-size:12px">
            <div><span style="color:var(--t4)">Najemca:</span> <b>${escapeHtml(preview.tenant || '—')}</b></div>
            <div><span style="color:var(--t4)">Lokal:</span> <b>${escapeHtml(preview.unit || '—')}</b></div>
            <div><span style="color:var(--t4)">Okres:</span> <b class="mono">${escapeHtml(preview.period || '—')}</b></div>
            <div><span style="color:var(--t4)">Numer:</span> <b class="mono">${escapeHtml(preview.phone || '—')}</b></div>
          </div>
          ${preview.test_mode ? `<div class="hint">Tryb testowy jest włączony: SMS pójdzie na numer testowy, nie na numer najemcy.</div>` : ''}
          ${preview.token_configured === false ? `<div class="hint" style="color:var(--rose)">Brak tokenu SMSPlanet po stronie serwera.</div>` : ''}
          <div style="padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;line-height:1.5;color:var(--t1)">
            ${escapeHtml(preview.message || '')}
          </div>
        </div>`,
      footer: `
        <button class="tb-btn tb-ghost" id="sms-cancel">Anuluj</button>
        <button class="tb-btn tb-primary" id="sms-send-confirm">Wyślij SMS</button>`,
    });
    m.root.querySelector('#sms-cancel').onclick = m.close;
    m.root.querySelector('#sms-send-confirm').onclick = async () => {
      const btn = m.root.querySelector('#sms-send-confirm');
      btn.disabled = true;
      try {
        const result = await Api.post(`/notifications/payments/${paymentId}/reminder`, {});
        m.close();
        toast(
          result.status === 'simulated' ? 'Symulacja SMS zapisana' : 'SMS z przypomnieniem wysłany',
          'ok',
          4200,
        );
        openTenantDetails(tenantId);
        render({ preserveScroll: true });
      } catch (e) {
        btn.disabled = false;
        toast(smsReminderErrorLabel(e.message || e.data?.error), 'err', 5200);
      }
    };
  } catch (e) {
    toast(smsReminderErrorLabel(e.message || e.data?.error), 'err', 5200);
  }
};

function rentalDocumentsHtml(tenant) {
  const groups = tenant.rental_documents || [];
  if (!groups.length) return emptyState('Brak dokumentów najmu.', 'Dodaj umowę bazową albo pierwszy aneks.');
  const activeContract = (tenant.contracts || []).find((contract) => contract.status === 'active');
  return `
    <section class="rental-documents-section">
      <div class="rental-documents-heading">
        <div><div class="ch-title">Umowa i aneksy</div><div class="ch-sub">Dokumenty są grupowane przy właściwej umowie, nie jako osobne umowy.</div></div>
        ${activeContract ? `<button class="tb-btn tb-primary" type="button" data-add-tenant-amendment="${activeContract.id}">＋ Dodaj aneks</button>` : ''}
      </div>
      <div class="rental-contract-groups">
        ${groups
          .map((group) => {
            const contract = group.contract;
            const terms = contractTerms(contract);
            const documents = group.documents || [];
            const amendments = group.amendments || [];
            const linkedAmendmentDocuments = new Set(
              amendments.map((amendment) => Number(amendment.document_id)).filter(Boolean),
            );
            const baseDocuments = documents.filter((document) => document.category === 'umowa');
            const otherDocuments = documents.filter(
              (document) =>
                document.category !== 'umowa' && !linkedAmendmentDocuments.has(Number(document.id)),
            );
            const baseTimeline = baseDocuments.length
              ? baseDocuments
                  .map(
                    (document) => `
                    <div class="rental-timeline-row">
                      <div class="rental-timeline-dot"></div>
                      <div class="rental-timeline-card">
                        <div class="rental-timeline-main"><div><strong>Umowa najmu ${escapeHtml(document.document_number || '')}</strong><small>${document.workflow_status === 'signed' ? 'Podpisana' : 'Wgrana'} ${fmtDate(document.uploaded_at)} · dokument bazowy</small></div>${documentWorkflowChip(document.workflow_status)}</div>
                        <div class="rental-timeline-change"><b>Warunki początkowe</b><span>${fmtDate(contract.start_date)}–${fmtDate(contract.end_date)} · ${fmtPLN(contract.rent)} zł + ${fmtPLN(contract.media_advance)} zł media</span></div>
                        <div class="rental-timeline-actions"><a class="rental-document-action" href="/api/documents/${document.id}/download" download>Pobierz</a><button class="rental-document-action" type="button" data-edit-rental-document="${document.id}">Obieg</button></div>
                      </div>
                    </div>`,
                  )
                  .join('')
              : `
                  <div class="rental-timeline-row missing">
                    <div class="rental-timeline-dot"></div>
                    <div class="rental-timeline-card"><div class="rental-timeline-main"><div><strong>Umowa najmu</strong><small>Brak wgranego dokumentu bazowego.</small></div>${chip('chip-a', 'Brak pliku')}</div></div>
                  </div>`;
            const amendmentTimeline = amendments
              .map(
                (amendment) => `
                <div class="rental-timeline-row">
                  <div class="rental-timeline-dot"></div>
                  <div class="rental-timeline-card">
                    <div class="rental-timeline-main"><div><strong>Aneks nr ${escapeHtml(amendment.amendment_number)}</strong><small>${amendment.signed_date ? `Podpisany ${fmtDate(amendment.signed_date)} · ` : 'Szkic · '}${amendment.status === 'signed' ? `obowiązuje od ${fmtDate(amendment.effective_date)}` : `planowany od ${fmtDate(amendment.effective_date)}`}</small></div>${amendmentStatusChip(amendment)}</div>
                    <div class="rental-timeline-change"><b>${escapeHtml(amendmentChangesLabel(amendment))}</b><span>${amendment.notes ? escapeHtml(amendment.notes) : amendment.document_name ? escapeHtml(amendment.document_name) : 'Brak dołączonego pliku'}</span></div>
                    <div class="rental-timeline-actions">${amendment.document_id ? `<a class="rental-document-action" href="/api/documents/${amendment.document_id}/download" download>Pobierz</a>` : ''}${amendment.document_id ? `<button class="rental-document-action" type="button" data-edit-rental-document="${amendment.document_id}">Obieg</button>` : ''}${amendment.status === 'draft' ? `<button class="rental-document-action" type="button" data-edit-tenant-amendment="${contract.id}:${amendment.id}">Edytuj</button><button class="rental-document-action" type="button" data-sign-tenant-amendment="${contract.id}:${amendment.id}">${amendment.document_id ? 'Podpisz szkic' : 'Dołącz i podpisz'}</button>` : `<button class="rental-document-action" type="button" data-edit-signed-amendment="${contract.id}:${amendment.id}">Edytuj dane</button>`}</div>
                  </div>
                </div>`,
              )
              .join('');
            const otherTimeline = otherDocuments
              .map(
                (document) => `
                <div class="rental-timeline-row secondary">
                  <div class="rental-timeline-dot"></div>
                  <div class="rental-timeline-card"><div class="rental-timeline-main"><div><strong>${escapeHtml(document.name)}</strong><small>${escapeHtml(document.category || 'dokument')} · ${fmtDate(document.uploaded_at)}</small></div>${documentWorkflowChip(document.workflow_status)}</div><div class="rental-timeline-actions"><a class="rental-document-action" href="/api/documents/${document.id}/download" download>Pobierz</a><button class="rental-document-action" type="button" data-edit-rental-document="${document.id}">Obieg</button></div></div>
                </div>`,
              )
              .join('');
            return `
              <article class="rental-contract-group">
                <div class="rental-contract-summary">
                  <div><strong>Najem: ${escapeHtml(contract.property_name || tenant.property_name || '—')} ${escapeHtml(contract.unit_code || contract.unit_name || '')}</strong><span>${fmtDate(contract.start_date)}–${fmtDate(terms.end_date)} · aktualnie ${fmtPLN(terms.rent)} zł + ${fmtPLN(terms.media_advance)} zł media</span></div>
                  <div class="rental-contract-actions"><button class="tb-btn tb-ghost" type="button" data-open-contract-documents="${contract.id}">Inny dokument</button></div>
                </div>
                <div class="rental-timeline">${baseTimeline}${amendmentTimeline}${otherTimeline}</div>
              </article>`;
          })
          .join('')}
      </div>
    </section>`;
}

window.openTenantAmendmentForm = async function (tenantId) {
  const tenant = await Api.get(`/tenants/${tenantId}`);
  const activeContract = (tenant.contracts || []).find((contract) => contract.status === 'active');
  if (!activeContract) return toast('Ten najemca nie ma aktywnej umowy, do której można dodać aneks.', 'err');
  const selectedId = String(activeContract.id);
  const selectedGroup = (tenant.rental_documents || []).find(
    (group) => String(group.contract.id) === selectedId,
  );
  const suggestedNumber = `${((selectedGroup?.amendments || []).length || 0) + 1}/A/${new Date().getFullYear()}`;
  const dialog = modal({
    title: `Dodawanie aneksu · ${tenant.name}`,
    wide: true,
    body: `
      <div class="amendment-form-panel">
        <div class="amendment-form-intro"><div><div class="ch-title">Nowy aneks do umowy</div><div class="ch-sub">Zmiany warunków są zapisane razem z dokumentem i datą obowiązywania.</div></div><button type="button" class="tb-btn tb-ghost" id="amendment-back">← Dokumenty najmu</button></div>
        <form id="amendment-form" class="form-grid compact">
          <div class="form-row full"><label>Aktywna umowa bazowa</label><div class="amendment-contract-readonly" id="amendment-contract">${escapeHtml(`${activeContract.property_name || tenant.property_name || '—'} ${activeContract.unit_code || activeContract.unit_name || ''} · ${fmtDate(activeContract.start_date)}–${fmtDate(contractTerms(activeContract).end_date)}`)}</div></div>
          <div class="form-row"><label>Numer aneksu</label><input id="amendment-number" required value="${escapeHtml(suggestedNumber)}"></div>
          <div class="form-row"><label>Nazwa dokumentu</label><input id="amendment-name" placeholder="Aneks do umowy najmu"></div>
          <div class="form-row"><label>Data podpisania</label><input id="amendment-signed-date" type="date" value="${todayISO()}"><div class="hint">Wymagana przy dodaniu podpisanego aneksu.</div></div>
          <div class="form-row"><label>Data wejścia zmian w życie</label><input id="amendment-effective-date" type="date" required value="${todayISO()}"><div class="hint">Pierwszy dzień, od którego stosujemy zmiany. To nie jest nowa data końca umowy.</div></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-change-end" type="checkbox"> Zmiana daty końca</label></div>
          <div class="form-row amendment-conditional" data-amendment-section="end"><label>Nowa data końca umowy</label><input id="amendment-end-date" type="date"><div class="hint">Ostatni dzień przedłużonego okresu najmu.</div></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-change-finance" type="checkbox"> Zmiana czynszu / mediów</label></div>
          <div class="form-row amendment-conditional" data-amendment-section="finance"><label>Nowy czynsz [PLN]</label><input id="amendment-rent" type="number" step="0.01" min="0"></div>
          <div class="form-row amendment-conditional" data-amendment-section="finance"><label>Nowa zaliczka na media [PLN]</label><input id="amendment-media" type="number" step="0.01" min="0"></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-change-payment-day" type="checkbox"> Zmiana terminu płatności</label></div>
          <div class="form-row amendment-conditional" data-amendment-section="payment-day"><label>Nowy dzień płatności</label><input id="amendment-pay-day" type="number" min="1" max="31"></div>
          <div class="form-row full"><label>Notatka</label><textarea id="amendment-notes" placeholder="Opcjonalnie wyjaśnij aneks, jeżeli nie zmienia on pól powyżej."></textarea></div>
          <div class="form-row full"><label>Podpisany plik PDF/JPG/PNG</label><input id="amendment-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"><div class="hint">Szkic można zapisać bez pliku. Podpisany aneks wymaga pliku.</div></div>
          <div class="form-row full amendment-effective-note">Zmiany działają przy generowaniu nowych płatności od miesiąca daty „Obowiązuje od”. Już wygenerowane płatności pozostaną bez zmian.</div>
        </form>
      </div>`,
    footer: `<button class="tb-btn tb-ghost" id="amendment-save-draft">Zapisz szkic</button><button class="tb-btn tb-primary" id="amendment-save-signed">Dodaj podpisany aneks</button>`,
  });
  const root = dialog.root;
  const syncSections = () => {
    root.querySelectorAll('[data-amendment-section]').forEach((section) => {
      const key = section.dataset.amendmentSection;
      const input = root.querySelector(`#amendment-change-${key}`);
      section.classList.toggle('is-hidden', !input?.checked);
    });
  };
  root.querySelectorAll('[id^="amendment-change-"]').forEach((input) => (input.onchange = syncSections));
  syncSections();
  root.querySelector('#amendment-back').onclick = () => {
    dialog.close();
    openTenantDetails(tenantId);
  };
  const submit = async (status) => {
    const number = root.querySelector('#amendment-number').value.trim();
    const effectiveDate = root.querySelector('#amendment-effective-date').value;
    const notes = root.querySelector('#amendment-notes').value.trim();
    const file = root.querySelector('#amendment-file').files[0];
    const endChanged = root.querySelector('#amendment-change-end').checked;
    const financeChanged = root.querySelector('#amendment-change-finance').checked;
    const paymentDayChanged = root.querySelector('#amendment-change-payment-day').checked;
    const endDate = root.querySelector('#amendment-end-date').value;
    const rent = root.querySelector('#amendment-rent').value;
    const media = root.querySelector('#amendment-media').value;
    const payDay = root.querySelector('#amendment-pay-day').value;
    if (!number || !effectiveDate) return toast('Uzupełnij numer aneksu i datę obowiązywania.', 'err');
    if (endChanged && !endDate) return toast('Podaj nową datę końca umowy.', 'err');
    if (financeChanged && rent === '' && media === '')
      return toast('Podaj nowy czynsz lub nową zaliczkę na media.', 'err');
    if (paymentDayChanged && payDay === '') return toast('Podaj nowy dzień płatności.', 'err');
    if (!endDate && rent === '' && media === '' && payDay === '' && !notes) {
      return toast('Wskaż zmianę warunków albo dodaj notatkę wyjaśniającą aneks.', 'err');
    }
    if (status === 'signed' && !file) return toast('Podpisany aneks wymaga pliku PDF, JPG albo PNG.', 'err');
    const formData = new FormData();
    formData.append('amendment_number', number);
    formData.append('effective_date', effectiveDate);
    formData.append('status', status);
    if (root.querySelector('#amendment-name').value.trim())
      formData.append('name', root.querySelector('#amendment-name').value.trim());
    if (root.querySelector('#amendment-signed-date').value)
      formData.append('signed_date', root.querySelector('#amendment-signed-date').value);
    if (endChanged) formData.append('new_end_date', endDate);
    if (financeChanged && rent !== '') formData.append('rent', rent);
    if (financeChanged && media !== '') formData.append('media_advance', media);
    if (paymentDayChanged) formData.append('pay_by_day', payDay);
    if (notes) formData.append('notes', notes);
    if (file) formData.append('file', file);
    await Api.upload(`/contracts/${activeContract.id}/amendments`, formData);
    toast(status === 'signed' ? 'Dodano podpisany aneks' : 'Zapisano szkic aneksu');
    dialog.close();
    openTenantDetails(tenantId);
    render({ preserveScroll: true });
  };
  root.querySelector('#amendment-save-draft').onclick = () =>
    submit('draft').catch((error) => toast(amendmentErrorLabel(error.message), 'err'));
  root.querySelector('#amendment-save-signed').onclick = () =>
    submit('signed').catch((error) => toast(amendmentErrorLabel(error.message), 'err'));
};

window.openTenantAmendmentSignForm = async function (tenantId, contractId, amendmentId) {
  const snapshot = await Api.get(`/contracts/${contractId}/amendments`);
  const amendment = (snapshot.amendments || []).find((item) => Number(item.id) === Number(amendmentId));
  if (!amendment) return toast('Nie znaleziono szkicu aneksu.', 'err');
  if (amendment.status === 'signed') return toast('Ten aneks jest już podpisany.', 'info');
  const hasDocument = Boolean(amendment.document_id);
  const dialog = modal({
    title: `Podpisanie aneksu nr ${amendment.amendment_number}`,
    body: `
      <div class="amendment-form-panel compact-sign-panel">
        <div class="amendment-form-intro"><div><div class="ch-title">Podpisz szkic aneksu</div><div class="ch-sub">Po podpisaniu warunki będą obowiązywać od ${fmtDate(amendment.effective_date)}.</div></div>${amendmentStatusChip(amendment)}</div>
        <div class="amendment-effective-note">Jeżeli data obowiązywania jest w przeszłości, istniejące płatności nie zostaną zmienione automatycznie.</div>
        <form id="amendment-sign-form" class="form-grid compact">
          <div class="form-row"><label>Data podpisania</label><input id="amendment-sign-date" type="date" required value="${todayISO()}"></div>
          <div class="form-row full"><label>${hasDocument ? 'Nowy plik PDF/JPG/PNG (opcjonalnie)' : 'Podpisany plik PDF/JPG/PNG'}</label><input id="amendment-sign-file" type="file" ${hasDocument ? '' : 'required'} accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"><div class="hint">${hasDocument ? 'Wybranie pliku zastąpi wersję dołączoną do szkicu; poprzednia zostanie zarchiwizowana.' : 'Szkic nie ma pliku — dodaj podpisany dokument przed aktywacją.'}</div></div>
        </form>
      </div>`,
    footer: `<button class="tb-btn tb-ghost" id="amendment-sign-cancel">Anuluj</button><button class="tb-btn tb-primary" id="amendment-sign-confirm">Podpisz aneks</button>`,
  });
  const root = dialog.root;
  root.querySelector('#amendment-sign-cancel').onclick = dialog.close;
  root.querySelector('#amendment-sign-confirm').onclick = async () => {
    const signedDate = root.querySelector('#amendment-sign-date').value;
    const file = root.querySelector('#amendment-sign-file').files[0];
    if (!signedDate) return toast('Podaj datę podpisania aneksu.', 'err');
    if (!hasDocument && !file) return toast('Podpisany aneks wymaga pliku PDF, JPG albo PNG.', 'err');
    const button = root.querySelector('#amendment-sign-confirm');
    button.disabled = true;
    try {
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        await Api.upload(`/contracts/${contractId}/amendments/${amendmentId}/document`, formData);
      }
      await Api.post(`/contracts/${contractId}/amendments/${amendmentId}/sign`, { signed_date: signedDate });
      toast('Aneks został podpisany');
      dialog.close();
      openTenantDetails(tenantId);
      render({ preserveScroll: true });
    } catch (error) {
      button.disabled = false;
      toast(amendmentErrorLabel(error.message), 'err');
    }
  };
};

window.openTenantAmendmentEditForm = async function (tenantId, contractId, amendmentId) {
  const snapshot = await Api.get(`/contracts/${contractId}/amendments`);
  const amendment = (snapshot.amendments || []).find((item) => Number(item.id) === Number(amendmentId));
  if (!amendment) return toast('Nie znaleziono aneksu.', 'err');
  const signed = amendment.status === 'signed';
  const endChanged = amendment.new_end_date != null;
  const financeChanged = amendment.rent != null || amendment.media_advance != null;
  const paymentDayChanged = amendment.pay_by_day != null;
  const dialog = modal({
    title: `Edycja aneksu nr ${amendment.amendment_number}`,
    wide: true,
    body: `
      <div class="amendment-form-panel">
        <div class="amendment-form-intro"><div><div class="ch-title">${signed ? 'Edytuj podpisany aneks' : 'Edytuj szkic aneksu'}</div><div class="ch-sub">${signed ? 'Możesz poprawić wszystkie błędnie wpisane dane aneksu.' : 'Możesz poprawić wszystkie dane zapisane w szkicu.'}</div></div>${amendmentStatusChip(amendment)}</div>
        <form id="amendment-edit-form" class="form-grid compact">
          <div class="form-row"><label>Numer aneksu</label><input id="amendment-edit-number" required value="${escapeHtml(amendment.amendment_number)}"></div>
          <div class="form-row"><label>Nazwa dokumentu</label><input id="amendment-edit-name" required value="${escapeHtml(amendment.name || amendment.document_name || `Aneks nr ${amendment.amendment_number}`)}"></div>
          <div class="form-row"><label>Data podpisania</label><input id="amendment-edit-signed-date" type="date" ${signed ? 'required' : ''} value="${escapeHtml(amendment.signed_date || '')}"><div class="hint">Wymagana dla podpisanego aneksu.</div></div>
          <div class="form-row"><label>Data wejścia zmian w życie</label><input id="amendment-edit-effective-date" type="date" required value="${escapeHtml(amendment.effective_date)}"><div class="hint">Pierwszy dzień stosowania zmian, nie data końca umowy.</div></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-edit-change-end" type="checkbox" ${endChanged ? 'checked' : ''}> Zmiana daty końca</label></div>
          <div class="form-row amendment-conditional${endChanged ? '' : ' is-hidden'}" data-amendment-edit-section="end"><label>Nowa data końca umowy</label><input id="amendment-edit-end-date" type="date" value="${escapeHtml(amendment.new_end_date || '')}"><div class="hint">Ostatni dzień zmienionego okresu najmu.</div></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-edit-change-finance" type="checkbox" ${financeChanged ? 'checked' : ''}> Zmiana czynszu / mediów</label></div>
          <div class="form-row amendment-conditional${financeChanged ? '' : ' is-hidden'}" data-amendment-edit-section="finance"><label>Nowy czynsz [PLN]</label><input id="amendment-edit-rent" type="number" step="0.01" min="0" value="${amendment.rent ?? ''}"></div>
          <div class="form-row amendment-conditional${financeChanged ? '' : ' is-hidden'}" data-amendment-edit-section="finance"><label>Nowa zaliczka na media [PLN]</label><input id="amendment-edit-media" type="number" step="0.01" min="0" value="${amendment.media_advance ?? ''}"></div>
          <div class="form-row full amendment-change-toggle"><label><input id="amendment-edit-change-payment-day" type="checkbox" ${paymentDayChanged ? 'checked' : ''}> Zmiana terminu płatności</label></div>
          <div class="form-row amendment-conditional${paymentDayChanged ? '' : ' is-hidden'}" data-amendment-edit-section="payment-day"><label>Nowy dzień płatności</label><input id="amendment-edit-pay-day" type="number" min="1" max="31" value="${amendment.pay_by_day ?? ''}"></div>
          <div class="form-row full"><label>Notatka</label><textarea id="amendment-edit-notes">${escapeHtml(amendment.notes || '')}</textarea></div>
          <div class="form-row full"><label>${amendment.document_id ? 'Zastąp plik PDF/JPG/PNG (opcjonalnie)' : 'Dołącz plik PDF/JPG/PNG (opcjonalnie)'}</label><input id="amendment-edit-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"><div class="hint">${amendment.document_id ? 'Poprzednia wersja pliku zostanie zarchiwizowana.' : signed ? 'Podpisany aneks powinien mieć dołączony plik.' : 'Plik można również dołączyć podczas podpisywania.'}</div></div>
          ${signed ? '<div class="form-row full amendment-effective-note">Korekta warunków przeliczy bieżący status umowy. Już wygenerowane płatności pozostaną bez zmian.</div>' : ''}
        </form>
      </div>`,
    footer: `<button class="tb-btn tb-ghost" id="amendment-edit-cancel">Anuluj</button><button class="tb-btn tb-primary" id="amendment-edit-save">Zapisz zmiany</button>`,
  });
  const root = dialog.root;
  const syncSections = () => {
    root.querySelectorAll('[data-amendment-edit-section]').forEach((section) => {
      const key = section.dataset.amendmentEditSection;
      const input = root.querySelector(`#amendment-edit-change-${key}`);
      section.classList.toggle('is-hidden', !input?.checked);
    });
  };
  root.querySelectorAll('[id^="amendment-edit-change-"]').forEach((input) => (input.onchange = syncSections));
  root.querySelector('#amendment-edit-cancel').onclick = dialog.close;
  root.querySelector('#amendment-edit-save').onclick = async () => {
    const number = root.querySelector('#amendment-edit-number').value.trim();
    const name = root.querySelector('#amendment-edit-name').value.trim();
    const signedDate = root.querySelector('#amendment-edit-signed-date').value;
    const effectiveDate = root.querySelector('#amendment-edit-effective-date').value;
    const notes = root.querySelector('#amendment-edit-notes').value.trim();
    const changeEnd = root.querySelector('#amendment-edit-change-end').checked;
    const changeFinance = root.querySelector('#amendment-edit-change-finance').checked;
    const changePaymentDay = root.querySelector('#amendment-edit-change-payment-day').checked;
    const endDate = root.querySelector('#amendment-edit-end-date').value;
    const rent = root.querySelector('#amendment-edit-rent').value;
    const media = root.querySelector('#amendment-edit-media').value;
    const payDay = root.querySelector('#amendment-edit-pay-day').value;
    const file = root.querySelector('#amendment-edit-file').files[0];
    if (!number || !name || !effectiveDate)
      return toast('Uzupełnij numer, nazwę dokumentu i datę wejścia zmian w życie.', 'err');
    if (signed && !signedDate) return toast('Podaj datę podpisania aneksu.', 'err');
    if (changeEnd && !endDate) return toast('Podaj nową datę końca umowy.', 'err');
    if (changeFinance && rent === '' && media === '')
      return toast('Podaj nowy czynsz lub nową zaliczkę na media.', 'err');
    if (changePaymentDay && payDay === '') return toast('Podaj nowy dzień płatności.', 'err');
    if (!changeEnd && !changeFinance && !changePaymentDay && !notes)
      return toast('Wskaż zmianę warunków albo dodaj notatkę wyjaśniającą aneks.', 'err');
    const button = root.querySelector('#amendment-edit-save');
    button.disabled = true;
    try {
      await Api.put(`/contracts/${contractId}/amendments/${amendmentId}`, {
        amendment_number: number,
        name,
        signed_date: signedDate || null,
        effective_date: effectiveDate,
        new_end_date: changeEnd ? endDate : null,
        rent: changeFinance && rent !== '' ? Number(rent) : null,
        media_advance: changeFinance && media !== '' ? Number(media) : null,
        pay_by_day: changePaymentDay ? Number(payDay) : null,
        notes: notes || null,
      });
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', name);
        formData.append('notes', notes);
        await Api.upload(`/contracts/${contractId}/amendments/${amendmentId}/document`, formData);
      }
      toast(signed ? 'Zaktualizowano podpisany aneks' : 'Zaktualizowano szkic aneksu');
      dialog.close();
      openTenantDetails(tenantId);
      render({ preserveScroll: true });
    } catch (error) {
      button.disabled = false;
      toast(amendmentErrorLabel(error.message), 'err');
    }
  };
};

window.openSignedAmendmentMetadataForm = async function (tenantId, contractId, amendmentId) {
  return window.openTenantAmendmentEditForm(tenantId, contractId, amendmentId);
};

window.openTenantDetails = async function (id) {
  const t = await Api.get(`/tenants/${id}`);
  const monthly = (t.contract_rent || 0) + (t.contract_media || 0);
  const reminderPayment = tenantReminderPayment(t);

  const paymentsHtml =
    t.payments && t.payments.length
      ? `<table class="t" style="margin-top:10px">
        <thead><tr><th>Okres</th><th>Termin</th><th>Czynsz</th><th>Media</th><th>Kara</th><th>Wpłacono bez kar</th><th>Status</th><th></th></tr></thead>
        <tbody>${t.payments
          .slice(0, 12)
          .map((p) => {
            const st = STATUS_CHIP[p.status] || STATUS_CHIP.pending;
            const canRemind = paymentNeedsReminder(p);
            return `<tr>
            <td class="mono">${escapeHtml(p.period)}</td>
            <td class="mono">${fmtDateShort(p.due_date)}</td>
            <td class="mono">${fmtPLN(p.rent_amount)} zł</td>
            <td class="mono">${fmtPLN(p.media_amount)} zł</td>
            <td class="mono${p.late_fee_amount ? '-a' : '-m'}">${p.late_fee_amount ? fmtPLN(p.late_fee_amount) + ' zł' : '—'}</td>
            <td class="mono-e">${fmtPLN(p.total_paid)} zł</td>
            <td><span class="chip ${st.cls}">${st.label}</span></td>
            <td>${canRemind ? `<button class="tb-btn tb-ghost" style="height:28px;font-size:11px;padding:0 10px" onclick="openSmsReminderPreview(${p.id}, ${t.id})">SMS</button>` : ''}</td>
          </tr>`;
          })
          .join('')}</tbody>
      </table>`
      : emptyState('Brak historii płatności.');

  const feeSummary = t.late_fee_summary || { total: 0, paid: 0, balance: 0, count: 0 };
  const lateFeesHtml =
    t.late_fees && t.late_fees.length
      ? `<div class="late-fee-summary">
        <div><span>Naliczone</span><b>${fmtPLN(feeSummary.total || 0)} zł</b></div>
        <div><span>Rozliczone</span><b style="color:var(--emerald)">${fmtPLN(feeSummary.paid || 0)} zł</b></div>
        <div><span>Pozostało</span><b style="color:${(feeSummary.balance || 0) > 0 ? 'var(--rose)' : 'var(--t1)'}">${fmtPLN(feeSummary.balance || 0)} zł</b></div>
      </div>
      <table class="t" style="margin-top:10px">
        <thead><tr><th>Okres</th><th>Termin</th><th>Wpłata</th><th>Kara</th><th>Rozliczono</th><th>Saldo</th><th>Status</th><th></th></tr></thead>
        <tbody>${t.late_fees
          .map(
            (f) => `<tr>
          <td class="mono">${escapeHtml(f.period)}</td>
          <td class="mono">${fmtDateShort(f.due_date)}</td>
          <td class="mono">${fmtDateShort(f.paid_date)}</td>
          <td class="mono-a">${fmtPLN(f.amount)} zł</td>
          <td class="mono-e">${fmtPLN(f.paid)} zł</td>
          <td class="mono${f.balance > 0 ? '-r' : '-m'}">${fmtPLN(f.balance)} zł</td>
          <td>${lateFeeStatusChip(f)}</td>
          <td><button class="tb-btn tb-primary" style="height:28px;font-size:11px;padding:0 10px" onclick="resolveLateFee(${f.payment_id}, ${t.id})">Rozlicz</button></td>
        </tr>`,
          )
          .join('')}</tbody>
      </table>`
      : emptyState(
          'Brak kar za opóźnione wpłaty.',
          'Gdy wpłata ma datę po terminie, aplikacja naliczy 50 zł automatycznie.',
        );

  const contractsHtml =
    t.contracts && t.contracts.length
      ? `<table class="t" style="margin-top:10px">
        <thead><tr><th>Od</th><th>Do</th><th>Czynsz</th><th>Media</th><th>Kaucja</th><th>Status</th><th></th></tr></thead>
        <tbody>${t.contracts
          .map((c) => {
            const terms = contractTerms(c);
            return `<tr>
          <td class="mono">${fmtDate(c.start_date)}</td>
          <td class="mono">${fmtDate(terms.end_date)}</td>
          <td class="mono">${fmtPLN(terms.rent)} zł</td>
          <td class="mono">${fmtPLN(terms.media_advance)} zł</td>
          <td class="mono">${fmtPLN(c.deposit)} zł</td>
          <td>${contractStatusChip(c.status, terms.end_date, c.workflow_stage)}</td>
          <td>${c.status === 'active' ? `<button class="tb-btn tb-ghost" onclick="endContractFlow(${c.id})" style="font-size:11px;height:30px;padding:0 8px">Zakończ</button>` : ''}</td>
        </tr>`;
          })
          .join('')}</tbody>
      </table>`
      : emptyState('Brak umów.');

  const body = `
    <div style="padding:22px 26px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
        ${avatarLg(t.name)}
        <div style="flex:1"><div style="font-family:var(--display);font-size:18px;font-weight:700">${escapeHtml(t.name)}</div>
          <div style="font-size:12px;color:var(--t3);margin-top:2px">${escapeHtml(t.property_name || '—')} · ${escapeHtml(t.unit_name || 'brak lokalu')}</div></div>
        ${chip(t.status === 'active' ? 'chip-e' : 'chip-n', t.status === 'active' ? 'Aktywny' : 'Historyczny', t.status === 'active')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:20px">
        <div><span style="color:var(--t4)">Telefon:</span> <span style="color:var(--t1)">${escapeHtml(t.phone || '—')}</span></div>
        <div><span style="color:var(--t4)">Email:</span> <span style="color:var(--t1)">${escapeHtml(t.email || '—')}</span></div>
        <div><span style="color:var(--t4)">SMS:</span> <span style="color:var(--t1)">${t.sms_disabled ? 'wyłączone' : t.sms_consent ? 'zgoda aktywna' : 'brak zgody'}</span></div>
        <div><span style="color:var(--t4)">Czynsz mies.:</span> <span style="color:var(--emerald);font-family:var(--mono);font-weight:600">${fmtPLN(monthly)} zł</span></div>
        <div><span style="color:var(--t4)">Umowa do:</span> <span style="color:var(--t1)">${fmtDate(t.contract_end)}</span></div>
        ${t.notes ? `<div style="grid-column:span 2"><span style="color:var(--t4)">Notatka:</span> <span style="color:var(--t1)">${escapeHtml(t.notes)}</span></div>` : ''}
      </div>
      <div class="tenant-detail-tabs" role="tablist"><button type="button" class="tenant-detail-tab active" id="td-documents-tab">Dokumenty najmu</button></div>
      <div id="td-rental-documents">${rentalDocumentsHtml(t)}</div>
      <div class="ch-title" style="margin-top:18px;margin-bottom:6px">Historia umów (${(t.contracts || []).length})</div>
      <div style="overflow-x:auto">${contractsHtml}</div>
      <div class="ch-title" style="margin-top:18px;margin-bottom:6px">Kary za opóźnione wpłaty</div>
      <div style="overflow-x:auto">${lateFeesHtml}</div>
      <div class="ch-title" style="margin-top:18px;margin-bottom:6px">Historia płatności (ostatnie ${Math.min(12, (t.payments || []).length)})</div>
      <div style="overflow-x:auto">${paymentsHtml}</div>
    </div>`;

  const detailDialog = modal({
    title: t.name,
    body,
    wide: true,
    footer: `<button class="tb-btn tb-danger" id="td-del">Usuń najemcę</button>
             <span style="flex:1"></span>
             ${reminderPayment ? `<button class="tb-btn tb-ghost" id="td-sms-reminder">Wyślij SMS z przypomnieniem</button>` : ''}
             ${t.contract_id ? `<button class="tb-btn tb-ghost" id="td-end-contract">Zakończ umowę</button>` : ''}
             <button class="tb-btn tb-ghost" id="td-edit">Edytuj dane</button>
             <button class="tb-btn tb-primary" id="td-close">Zamknij</button>`,
  });
  const detailRoot = detailDialog.root;
  detailRoot.querySelector('#td-close').onclick = detailDialog.close;
  detailRoot.querySelector('#td-edit').onclick = () => {
    detailDialog.close();
    editTenant(id);
  };
  detailRoot.querySelector('#td-documents-tab').onclick = () =>
    detailRoot.querySelector('#td-rental-documents')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  detailRoot.querySelectorAll('[data-add-tenant-amendment]').forEach((button) => {
    button.onclick = () => {
      detailDialog.close();
      openTenantAmendmentForm(t.id);
    };
  });
  detailRoot.querySelectorAll('[data-open-contract-documents]').forEach((button) => {
    button.onclick = () => {
      detailDialog.close();
      openContractDocuments(button.dataset.openContractDocuments);
    };
  });
  detailRoot.querySelectorAll('[data-edit-rental-document]').forEach((button) => {
    button.onclick = async () => {
      const documentData = await Api.get(`/documents/${button.dataset.editRentalDocument}`);
      editDocumentWorkflow(documentData);
    };
  });
  detailRoot.querySelectorAll('[data-sign-tenant-amendment]').forEach((button) => {
    button.onclick = () => {
      const [contractId, amendmentId] = button.dataset.signTenantAmendment.split(':').map(Number);
      detailDialog.close();
      openTenantAmendmentSignForm(t.id, contractId, amendmentId);
    };
  });
  detailRoot.querySelectorAll('[data-edit-tenant-amendment]').forEach((button) => {
    button.onclick = () => {
      const [contractId, amendmentId] = button.dataset.editTenantAmendment.split(':');
      detailDialog.close();
      openTenantAmendmentEditForm(t.id, contractId, amendmentId);
    };
  });
  detailRoot.querySelectorAll('[data-edit-signed-amendment]').forEach((button) => {
    button.onclick = () => {
      const [contractId, amendmentId] = button.dataset.editSignedAmendment.split(':');
      detailDialog.close();
      openSignedAmendmentMetadataForm(t.id, contractId, amendmentId);
    };
  });
  if (reminderPayment)
    detailRoot.querySelector('#td-sms-reminder').onclick = () =>
      openSmsReminderPreview(reminderPayment.id, t.id);
  if (t.contract_id)
    detailRoot.querySelector('#td-end-contract').onclick = () => endContractFlow(t.contract_id);
  detailRoot.querySelector('#td-del').onclick = () =>
    confirmDialog({
      title: 'Usuń najemcę',
      message: `Usunąć "${t.name}"?`,
      danger: true,
      onYes: async () => {
        await Api.del(`/tenants/${id}`);
        toast('Usunięto', 'info');
        detailDialog.close();
        render();
      },
    });
};

// ═══════════════════════ UMOWY ═══════════════════════
async function renderContracts(root) {
  const [contracts, props] = await Promise.all([Api.get('/contracts'), Api.get('/properties')]);
  const stStatus = State.contractsStatus || 'all';

  const now = Date.now();
  const daysTo = (d) => (d ? Math.ceil((new Date(d) - now) / 86400000) : null);
  const contractEnd = (contract) => contractTerms(contract).end_date;

  const active = contracts.filter((c) => c.status === 'active');
  const ending30 = active.filter((c) => {
    const d = daysTo(contractEnd(c));
    return d != null && d >= 0 && d <= 30;
  });
  const pastEnd = active.filter((c) => {
    const d = daysTo(contractEnd(c));
    return d != null && d < 0;
  });
  const safe = active.filter((c) => {
    const d = daysTo(contractEnd(c));
    return d == null || d > 30;
  });
  const totalDeposit = active.reduce((s, c) => s + (c.deposit || 0), 0);
  const totalMonthly = active.reduce((s, c) => {
    const terms = contractTerms(c);
    return s + terms.rent + terms.media_advance;
  }, 0);

  let filtered = contracts.slice();
  if (stStatus === 'active') filtered = filtered.filter((c) => c.status === 'active');
  else if (stStatus === 'ending30')
    filtered = filtered.filter((c) => {
      const d = daysTo(contractEnd(c));
      return active.includes(c) && d != null && d >= 0 && d <= 30;
    });
  else if (stStatus === 'past') filtered = filtered.filter((c) => pastEnd.includes(c));
  else if (stStatus === 'safe')
    filtered = filtered.filter((c) => active.includes(c) && (daysTo(contractEnd(c)) ?? 999) > 30);
  else if (stStatus === 'ended') filtered = filtered.filter((c) => c.status === 'ended');

  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return (contractEnd(a) || '9999').localeCompare(contractEnd(b) || '9999');
  });

  const avgMonths = (() => {
    const durs = contracts
      .filter((c) => c.start_date && contractEnd(c))
      .map((c) => (new Date(contractEnd(c)) - new Date(c.start_date)) / (86400000 * 30.44));
    return durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  })();

  setTopbar(
    VIEW_TITLES.umowy,
    `${active.length} aktywnych · ${contracts.length - active.length} zakończonych`,
    `<button class="tb-btn tb-primary" id="btn-add-contract"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Nowa umowa</button>`,
  );

  root.innerHTML = `
    <div class="kpi-strip">
      <div class="kpi-hero">
        <div class="kh-label">Aktywne umowy</div>
        <div class="kh-val">${active.length}</div>
        <div class="kh-sub">wszystkich najemców</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-a"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="ks-label">Wygasają</div>
        <div class="ks-val">${ending30.length}</div>
        <div class="ks-delta delta-dn">w ciągu 30 dni</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-c"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
        <div class="ks-label">Średni czas</div>
        <div class="ks-val">${avgMonths}<span class="ks-unit">mies.</span></div>
        <div class="ks-delta delta-n">od zawarcia</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-v"><svg viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"/></svg></div>
        <div class="ks-label">Łączna kaucja</div>
        <div class="ks-val">${fmtPLN(totalDeposit)}<span class="ks-unit">PLN</span></div>
        <div class="ks-delta delta-n">aktywnych umów</div>
      </div>
      <div class="kpi-sm">
        <div class="ks-icon ki-e"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg></div>
        <div class="ks-label">Bezpieczne</div>
        <div class="ks-val">${safe.length}</div>
        ${chip('chip-e', 'bez ryzyka')}
      </div>
    </div>

    <div class="gc">
      <div class="ch">
        <div><div class="ch-title">Wszystkie umowy</div><div class="ch-sub">posortowane wg daty wygaśnięcia</div></div>
        <div style="display:flex;gap:6px">
          ${[
            ['all', 'Wszystkie'],
            ['active', 'Aktywne'],
            ['ending30', 'Wygasające'],
            ['past', 'Po terminie'],
            ['safe', 'Bezpieczne'],
            ['ended', 'Zakończone'],
          ]
            .map(([v, l]) => `<div class="ftab ${stStatus === v ? 'on' : ''}" data-cs="${v}">${l}</div>`)
            .join('')}
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="t">
          <thead><tr><th>Najemca</th><th>Nieruchomość</th><th>Status</th><th>Umowa do</th><th>Pozostało</th><th>Czynsz</th><th>Media</th><th>Łącznie</th><th></th></tr></thead>
          <tbody>${
            filtered.length === 0
              ? `<tr><td colspan="9">${emptyState('Brak umów.')}</td></tr>`
              : filtered
                  .map((c) => {
                    const terms = contractTerms(c);
                    const total = terms.rent + terms.media_advance;
                    const days = daysTo(terms.end_date);
                    let leftChip;
                    if (c.status === 'ended') {
                      leftChip = chip('chip-n', '—');
                    } else if (days != null && days < 0) {
                      leftChip = chip('chip-r', `+${-days}d po`);
                    } else if (days != null && days <= 30) {
                      leftChip = chip('chip-a', `${days} dni`);
                    } else if (days != null && days <= 90) {
                      leftChip = chip('chip-c', `${days} dni`);
                    } else if (days != null) {
                      leftChip = chip('chip-v', `${days} dni`);
                    } else {
                      leftChip = chip('chip-v', 'bezterminowo');
                    }
                    return `<tr>
              <td><div class="t-tenant">${avatar(c.tenant_name)}<span class="t-name">${escapeHtml(c.tenant_name || '—')}</span></div></td>
              <td style="font-size:12px;color:var(--t2)">${escapeHtml(c.property_name || '—')} / ${escapeHtml(c.unit_code || c.unit_name || '')}</td>
              <td>${contractStatusChip(c.status, terms.end_date, c.workflow_stage)}</td>
              <td class="mono${days != null && days <= 30 ? '-a' : ''}">${fmtDate(terms.end_date)}</td>
              <td>${leftChip}</td>
              <td class="mono">${fmtPLN(terms.rent)} zł</td>
              <td class="mono">${fmtPLN(terms.media_advance)} zł</td>
              <td class="mono-e">${fmtPLN(total)} zł</td>
              <td><div style="display:flex;gap:4px">
                <button class="tb-btn tb-ghost" onclick="openContractWorkflow(${c.id})" title="Obieg umowy" style="font-size:11px;height:30px;padding:0 8px">Obieg</button>
                ${c.status === 'active' ? `<button class="tb-btn tb-ghost" onclick="endContractFlow(${c.id})" title="Zakończ umowę" style="font-size:11px;height:30px;padding:0 8px">Zakończ</button>` : ''}
                <button class="icon-btn" onclick="openContractDocuments(${c.id})" title="Dokumenty umowy"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
                <button class="icon-btn" onclick="editContract(${c.id})" title="Edytuj"><svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                <button class="icon-btn danger" onclick="deleteContract(${c.id})" title="Usuń"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
              </div></td>
            </tr>`;
                  })
                  .join('')
          }</tbody>
          <tfoot>${active.length ? `<tr><td colspan="5" style="font-size:13px">Suma (aktywne)</td><td class="mono">${fmtPLN(active.reduce((s, c) => s + contractTerms(c).rent, 0))} zł</td><td class="mono">${fmtPLN(active.reduce((s, c) => s + contractTerms(c).media_advance, 0))} zł</td><td class="mono-e" style="font-size:13px">${fmtPLN(totalMonthly)} zł</td><td></td></tr>` : ''}</tfoot>
        </table>
      </div>
    </div>`;

  document.getElementById('btn-add-contract').onclick = () => editContract(null);
  document.querySelectorAll('[data-cs]').forEach(
    (b) =>
      (b.onclick = () => {
        State.contractsStatus = b.dataset.cs;
        render();
      }),
  );
}

function contractWorkflowChip(stage) {
  const value = {
    draft: ['chip-n', 'Szkic'],
    awaiting_documents: ['chip-a', 'Dokumenty'],
    awaiting_signature: ['chip-c', 'Do podpisu'],
    active: ['chip-e', 'Aktywna'],
    ending: ['chip-a', 'Wygaszanie'],
    ended: ['chip-n', 'Zakończona'],
    archived: ['chip-n', 'Archiwum'],
  }[stage] || ['chip-n', stage || '—'];
  return chip(value[0], value[1], stage === 'active');
}

window.openContractWorkflow = async function (id) {
  const snapshot = await Api.get(`/contracts/${id}/workflow`);
  const labels = {
    draft: 'Szkic',
    awaiting_documents: 'Kompletowanie dokumentów',
    awaiting_signature: 'Oczekuje na podpis',
    active: 'Aktywna',
    ending: 'Wygaszanie',
    ended: 'Zakończona',
    archived: 'Archiwum',
  };
  const ordered = [
    'draft',
    'awaiting_documents',
    'awaiting_signature',
    'active',
    'ending',
    'ended',
    'archived',
  ];
  const currentIndex = ordered.indexOf(snapshot.stage);
  const body = `<div class="contract-workflow">
    <div class="workflow-stage-track">${ordered
      .map(
        (stage, index) =>
          `<div class="workflow-stage ${index < currentIndex ? 'complete' : ''} ${stage === snapshot.stage ? 'current' : ''}"><span>${index + 1}</span><strong>${labels[stage]}</strong></div>`,
      )
      .join('')}</div>
    <div class="workflow-checklist">
      ${(snapshot.checklist || [])
        .map(
          (item) =>
            `<div class="workflow-check ${item.complete ? 'complete' : ''}"><span>${item.complete ? '✓' : '!'}</span><div><strong>${escapeHtml(item.label)}</strong><small>${item.required_for === 'active' ? 'wymagane do aktywacji' : 'zalecane przy przekazaniu'}</small></div></div>`,
        )
        .join('')}
    </div>
    <div class="ch inline"><div><div class="ch-title">Dokumenty umowy</div><div class="ch-sub">${(snapshot.documents || []).length} plików</div></div><button class="tb-btn tb-ghost" id="workflow-documents">Otwórz dokumenty</button></div>
    <div class="workflow-document-list">${
      (snapshot.documents || []).length
        ? snapshot.documents
            .map(
              (document) =>
                `<div><span>${documentWorkflowChip(document.workflow_status)}</span><strong>${escapeHtml(document.name)}</strong><small>v${Number(document.version || 1)} · ${fmtDate(document.uploaded_at)}</small></div>`,
            )
            .join('')
        : emptyState('Brak dokumentów.', 'Dodaj podpisaną umowę przed aktywacją.')
    }</div>
    <div class="workflow-history"><div class="ch-title">Historia</div>${
      (snapshot.events || []).length
        ? snapshot.events
            .slice(0, 8)
            .map(
              (event) =>
                `<div><span>${fmtDateTimeLocal(event.created_at)}</span><strong>${escapeHtml(labels[event.from_stage] || event.from_stage || 'Start')} → ${escapeHtml(labels[event.to_stage] || event.to_stage)}</strong>${event.note ? `<small>${escapeHtml(event.note)}</small>` : ''}</div>`,
            )
            .join('')
        : '<div class="ch-sub">Brak zmian etapu.</div>'
    }</div>
  </div>`;
  const transitions = (snapshot.allowed_transitions || [])
    .map(
      (stage) =>
        `<button class="tb-btn ${stage === 'active' ? 'tb-primary' : 'tb-ghost'}" data-contract-stage="${stage}">${escapeHtml(labels[stage] || stage)}</button>`,
    )
    .join('');
  const dialog = modal({
    title: `Obieg umowy · ${labels[snapshot.stage] || snapshot.stage}`,
    body,
    footer: `<button class="tb-btn tb-ghost" id="workflow-close">Zamknij</button>${transitions}`,
    wide: true,
  });
  dialog.root.querySelector('#workflow-close').onclick = dialog.close;
  dialog.root.querySelector('#workflow-documents').onclick = () => {
    dialog.close();
    openContractDocuments(id);
  };
  dialog.root.querySelectorAll('[data-contract-stage]').forEach((button) => {
    button.onclick = async () => {
      try {
        await Api.post(`/contracts/${id}/workflow`, { stage: button.dataset.contractStage });
        toast(`Etap umowy: ${labels[button.dataset.contractStage]}`);
        dialog.close();
        render();
      } catch (error) {
        toast(
          error.message === 'signed_contract_required' ? 'Najpierw dodaj podpisaną umowę' : error.message,
          'err',
        );
      }
    };
  });
};

window.editContract = async function (id) {
  const [tenants, units] = await Promise.all([Api.get('/tenants'), Api.get('/units')]);
  let initial = { status: 'planned', pay_by_day: 31, rent: 0, media_advance: 0, deposit: 0 };
  if (id) initial = await Api.get(`/contracts/${id}`);
  formModal({
    title: id ? 'Edytuj umowę' : 'Nowa umowa',
    wide: true,
    fields: [
      {
        name: 'tenant_id',
        label: 'Najemca',
        type: 'select',
        required: true,
        options: tenants.map((t) => ({ value: t.id, label: t.name })),
      },
      {
        name: 'unit_id',
        label: 'Lokal',
        type: 'select',
        required: true,
        options: units.map((u) => ({ value: u.id, label: `${u.property_name} · ${u.name}` })),
      },
      { name: 'start_date', label: 'Od', type: 'date' },
      { name: 'end_date', label: 'Do', type: 'date' },
      { name: 'rent', label: 'Czynsz [PLN]', type: 'number', step: '0.01' },
      { name: 'media_advance', label: 'Zaliczka media [PLN]', type: 'number', step: '0.01' },
      { name: 'deposit', label: 'Kaucja [PLN]', type: 'number', step: '0.01' },
      { name: 'pay_by_day', label: 'Termin płatności (dzień)', type: 'number' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'planned', label: 'Szkic / planowana' },
          { value: 'active', label: 'Aktywna' },
          { value: 'ended', label: 'Zakończona' },
        ],
      },
      { name: 'notes', label: 'Notatki', type: 'textarea', full: true },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/contracts/${id}`, b);
      else await Api.post('/contracts', b);
      toast(id ? 'Zaktualizowano' : 'Dodano umowę');
      render();
    },
  });
};

window.endContractFlow = async function (id) {
  const contract = await Api.get(`/contracts/${id}`);
  const terms = contractTerms(contract);
  formModal({
    title: `Zakończ umowę: ${contract.tenant_name || 'najemca'}`,
    fields: [
      {
        name: 'end_date',
        label: 'Data zakończenia',
        type: 'date',
        default: terms.end_date || monthEndISO(State.period),
        full: true,
      },
      {
        name: 'set_tenant_inactive',
        label: 'Ustaw najemcę jako historycznego',
        type: 'checkbox',
        default: true,
        full: true,
        hint: 'Historia płatności i dokumenty zostają w aplikacji.',
      },
    ],
    submitLabel: 'Zakończ umowę',
    onSubmit: async (b) => {
      await Api.post(`/contracts/${id}/end`, b);
      toast('Umowa zakończona');
      document.getElementById('modal-root').innerHTML = '';
      render();
    },
  });
};

window.tenantTurnover = async function (unitId, contractId = null) {
  const unit = await Api.get(`/units/${unitId}`);
  const contract = contractId ? await Api.get(`/contracts/${contractId}`) : null;
  const start = todayISO();
  const defaultPeriod = periodFromDateISO(start);
  const contractTermsNow = contract ? contractTerms(contract) : null;
  const currentRent = contractTermsNow ? contractTermsNow.rent : Number(unit.base_rent || 0);
  const currentMedia = contractTermsNow ? contractTermsNow.media_advance : Number(unit.base_media || 0);
  const fields = [];
  if (contract) {
    fields.push(
      { name: 'end_previous', label: 'Zakończ obecną umowę', type: 'checkbox', default: true, full: true },
      {
        name: 'previous_end_date',
        label: 'Koniec starej umowy',
        type: 'date',
        default: monthEndISO(defaultPeriod),
        hint: 'Dla zakładki ustaw zwykle ostatni dzień miesiąca.',
      },
      {
        name: 'previous_tenant_inactive',
        label: 'Stary najemca historyczny',
        type: 'checkbox',
        default: true,
      },
    );
  }
  fields.push(
    { name: 'tenant_name', label: 'Nowy najemca', required: true, full: true },
    { name: 'phone', label: 'Telefon' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'sms_consent', label: 'Zgoda na SMS', type: 'checkbox', default: false },
    { name: 'start_date', label: 'Start nowej umowy', type: 'date', default: start },
    { name: 'end_date', label: 'Koniec nowej umowy', type: 'date' },
    { name: 'rent', label: 'Czynsz / mies.', type: 'number', step: '0.01', default: currentRent },
    { name: 'media_advance', label: 'Media / mies.', type: 'number', step: '0.01', default: currentMedia },
    {
      name: 'deposit',
      label: 'Kaucja',
      type: 'number',
      step: '0.01',
      default: contract ? Number(contract.deposit || 0) : 0,
    },
    {
      name: 'pay_by_day',
      label: 'Termin płatności (dzień)',
      type: 'number',
      default: contractTermsNow ? contractTermsNow.pay_by_day || 31 : 31,
    },
    {
      name: 'create_payment',
      label: 'Dodaj płatność za miesiąc startowy',
      type: 'checkbox',
      default: true,
      full: true,
    },
    { name: 'payment_period', label: 'Okres płatności', type: 'text', default: defaultPeriod },
    {
      name: 'payment_multiplier',
      label: 'Mnożnik płatności',
      type: 'number',
      step: '0.01',
      default: contract ? 0.5 : 1,
      hint: '0.5 oznacza połowę miesiąca. Jeśli stary najemca ma pełną płatność, razem wyjdzie 150%.',
    },
    { name: 'notes', label: 'Notatka do umowy', type: 'textarea', full: true },
  );
  formModal({
    title: `${contract ? 'Zmień najemcę' : 'Dodaj najemcę'} · ${unit.property_name || ''} ${unit.code || unit.name || ''}`,
    fields,
    wide: true,
    submitLabel: contract ? 'Zmień najemcę' : 'Dodaj najemcę',
    onSubmit: async (b) => {
      await Api.post('/contracts/turnover', {
        ...b,
        unit_id: unitId,
        previous_contract_id: contractId,
      });
      toast(contract ? 'Najemca zmieniony' : 'Najemca dodany');
      render();
    },
  });
};

window.deleteContract = function (id) {
  confirmDialog({
    title: 'Usuń umowę',
    message: 'Czy na pewno usunąć tę umowę?',
    danger: true,
    onYes: async () => {
      await Api.del(`/contracts/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

window.openContractDocuments = async function (id) {
  const [contract, docs] = await Promise.all([
    Api.get(`/contracts/${id}`),
    Api.get(`/contracts/${id}/documents`),
  ]);
  const terms = contractTerms(contract);
  const list = docs.length
    ? `
    <div class="doc-grid contract-doc-grid">
      ${docs
        .map(
          (d) => `
        <div class="doc-card">
          <div class="doc-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
          <div class="doc-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
          <div class="doc-meta">${escapeHtml(d.category || 'inne')} · ${escapeHtml(d.mime_type || 'plik')} · ${(Number(d.size_bytes || 0) / 1024).toFixed(0)} kB · ${fmtDate(d.uploaded_at)}</div>
          <div class="doc-workflow-line">${documentWorkflowChip(d.workflow_status)}</div>
          <div class="doc-actions">
            <a href="/api/documents/${d.id}/download" download>Pobierz</a>
            <button onclick="deleteContractDocument(${d.id}, ${id})">Usuń</button>
          </div>
        </div>`,
        )
        .join('')}
    </div>`
    : emptyState('Brak dokumentów najmu.', 'Dodaj dokument bazowy, protokół albo inny plik do tej umowy.');

  const body = `
    <div class="contract-doc-panel">
      <div class="contract-doc-summary">
        <div>
          <div class="contract-doc-title">${escapeHtml(contract.tenant_name || 'Umowa')}</div>
          <div class="contract-doc-meta">${escapeHtml(contract.property_name || '—')} · ${fmtDate(contract.start_date)} - ${fmtDate(terms.end_date)}</div>
        </div>
        ${contractStatusChip(contract.status, terms.end_date, contract.workflow_stage)}
      </div>
      <form id="contract-doc-form" class="form-grid compact">
        <div class="form-row"><label>Rodzaj dokumentu</label><select id="contract-doc-category"><option value="umowa">Umowa bazowa</option><option value="protokol">Protokół</option><option value="inne">Inny dokument</option></select></div>
        <div class="form-row"><label>Status przy dodaniu</label><select id="contract-doc-status"><option value="signed">Podpisany</option><option value="uploaded">Nowy / do obiegu</option></select></div>
        <div class="form-row full"><label>Dokument PDF/JPG/PNG</label><input id="contract-doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></div>
        <div class="form-row full"><label>Nazwa dokumentu</label><input id="contract-doc-name" value="${escapeHtml(`Umowa podpisana - ${contract.tenant_name || ''}`.trim())}"></div>
      </form>
      <div class="contract-doc-list">${list}</div>
    </div>`;
  const m = modal({
    title: 'Umowa i aneksy',
    body,
    wide: true,
    footer: `
      <button class="tb-btn tb-ghost" id="contract-doc-close">Zamknij</button>
      <button class="tb-btn tb-ghost" id="contract-add-amendment">＋ Dodaj aneks</button>
      <button class="tb-btn tb-primary" id="contract-doc-upload">Dodaj dokument</button>`,
  });
  m.root.querySelector('#contract-doc-close').onclick = m.close;
  m.root.querySelector('#contract-add-amendment').onclick = () => {
    m.close();
    openTenantAmendmentForm(contract.tenant_id, id);
  };
  m.root.querySelector('#contract-doc-upload').onclick = async () => {
    const file = m.root.querySelector('#contract-doc-file').files[0];
    if (!file) return toast('Wybierz plik PDF albo JPG', 'err');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', m.root.querySelector('#contract-doc-name').value || file.name);
    fd.append('category', m.root.querySelector('#contract-doc-category').value);
    fd.append('workflow_status', m.root.querySelector('#contract-doc-status').value);
    try {
      await Api.upload(`/contracts/${id}/documents`, fd);
      toast('Dokument zapisany');
      m.close();
      openContractDocuments(id);
      render();
    } catch (e) {
      toast(e.message || 'Błąd uploadu', 'err');
    }
  };
};

window.deleteContractDocument = function (docId, contractId) {
  confirmDialog({
    title: 'Usuń dokument',
    message: 'Plik zostanie usunięty z serwera i odpięty od umowy.',
    danger: true,
    onYes: async () => {
      await Api.del(`/documents/${docId}`);
      toast('Usunięto dokument', 'info');
      openContractDocuments(contractId);
      render();
    },
  });
};

// ═══════════════════════ RAPORTY ═══════════════════════
async function renderReports(root) {
  const reportYear = String(State.period || currentPeriodISO()).slice(0, 4);
  const ownerFrom = shiftPeriod(State.period, -11);
  const [r, taxReport, ownerReport] = await Promise.all([
    Api.get(`/reports?period=${State.period}`),
    Api.get(`/reports/tax-yearly?year=${reportYear}`).catch(() => null),
    Api.get(`/reports/owner-statement?from=${ownerFrom}&to=${State.period}`).catch(() => null),
  ]);
  const totals = r.totals;
  const margin = totals.margin || 0;
  const palette = ['#06b6d4', '#8b5cf6', '#f59e0b', '#f43f5e', '#10b981', '#a78bfa'];

  const selProp = State.reportProp || 'all';
  const propsToShow =
    selProp === 'all' ? r.properties : r.properties.filter((p) => String(p.id) === String(selProp));

  setTopbar(
    VIEW_TITLES.raporty,
    `Analiza za ${escapeHtml(r.period_label)}`,
    `<button class="tb-btn tb-ghost" id="btn-pdf"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF</button>
     <button class="tb-btn tb-primary" id="btn-refresh"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Odśwież</button>`,
  );

  root.innerHTML = `
    <div class="prop-selector">
      <div class="prop-card${selProp === 'all' ? ' sel' : ''}" data-rp="all">
        <div style="display:flex;justify-content:space-between"><div style="width:36px;height:36px;border-radius:10px;background:var(--violet-l);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--violet);fill:none;stroke-width:1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></div>${chip('chip-v', 'wszystkie')}</div>
        <div class="pc-name">Wszystkie nieruchomości</div><div class="pc-addr">${r.properties.length} obiekty</div>
        <div class="pc-stats">
          <div><div class="pcs-lbl">Przychód</div><div class="pcs-val" style="color:var(--emerald)">${fmtPLN(totals.revenue)}</div></div>
          <div><div class="pcs-lbl">Marża</div><div class="pcs-val" style="color:var(--emerald)">${(margin * 100).toFixed(0)}%</div></div>
          <div><div class="pcs-lbl">Koszty</div><div class="pcs-val">${fmtPLN(totals.expenses)}</div></div>
          <div><div class="pcs-lbl">Lokali</div><div class="pcs-val">${r.properties.reduce((s, p) => s + (p.units_count || 0), 0)}</div></div>
        </div>
      </div>
      ${r.properties
        .map(
          (p, i) => `
        <div class="prop-card${String(selProp) === String(p.id) ? ' sel' : ''}" data-rp="${p.id}">
          <div style="display:flex;justify-content:space-between"><div style="width:36px;height:36px;border-radius:10px;background:var(--${i % 2 ? 'cyan' : 'emerald'}-l);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--${i % 2 ? 'cyan' : 'emerald'});fill:none;stroke-width:1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>${chip(p.units_rented === p.units_count ? 'chip-e' : 'chip-c', p.units_rented === p.units_count ? '100%' : `${p.units_rented}/${p.units_count}`, p.units_rented === p.units_count)}</div>
          <div class="pc-name">${escapeHtml(p.name)}</div><div class="pc-addr">${p.units_count} ${p.units_count === 1 ? 'lokal' : 'lokali'}${p.district ? ' · ' + escapeHtml(p.district) : ''}</div>
          <div class="pc-stats">
            <div><div class="pcs-lbl">Przychód</div><div class="pcs-val" style="color:var(--emerald)">${fmtPLN(p.revenue)}</div></div>
            <div><div class="pcs-lbl">Marża</div><div class="pcs-val" style="color:var(--emerald)">${((p.margin || 0) * 100).toFixed(0)}%</div></div>
            <div><div class="pcs-lbl">Koszty</div><div class="pcs-val">${fmtPLN(p.expenses)}</div></div>
            <div><div class="pcs-lbl">Najemców</div><div class="pcs-val">${p.units_rented || 0}</div></div>
          </div>
        </div>`,
        )
        .join('')}
    </div>

    ${renderOwnerStatement(ownerReport)}

    <div class="gc">
      <div class="sum-grid sum-grid-5">
        <div class="sum-cell"><div class="sc-lbl">Przychód brutto</div><div class="sc-val">${fmtPLN(totals.revenue)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">z ${fmtPLN(totals.expected_revenue || 0)} oczekiwanych bez kar</div><div class="sc-bar"><div class="sc-fill" style="width:${totals.expected_revenue ? Math.min(100, (totals.revenue / totals.expected_revenue) * 100) : 0}%;background:var(--emerald)"></div></div></div>
        <div class="sum-cell"><div class="sc-lbl">Łączne koszty</div><div class="sc-val">${fmtPLN(totals.expenses)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">w okresie</div><div class="sc-bar"><div class="sc-fill" style="width:${totals.revenue ? Math.min(100, (totals.expenses / totals.revenue) * 100) : 0}%;background:var(--rose)"></div></div></div>
        <div class="sum-cell"><div class="sc-lbl">Podatek (ryczałt)</div><div class="sc-val">${fmtPLN(totals.tax_total || 0)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">${totals.tax_rate || 0}% × ${fmtPLN(totals.rent_paid || 0)} zł czynszu${(totals.tax_koscielna || 0) > 0 ? ` + ${fmtPLN(totals.tax_koscielna)} zł stałe` : ''}</div><div class="sc-bar"><div class="sc-fill" style="width:${totals.revenue ? Math.min(100, ((totals.tax_total || 0) / totals.revenue) * 100) : 0}%;background:var(--violet)"></div></div></div>
        <div class="sum-cell"><div class="sc-lbl">Netto właściciel</div><div class="sc-val">${fmtPLN(totals.net)}<span class="sc-unit"> PLN</span></div><div class="sc-delta ${totals.net >= 0 ? 'delta-up' : 'delta-dn'}">po kosztach + podatku</div><div class="sc-bar"><div class="sc-fill" style="width:${totals.revenue ? Math.max(0, Math.min(100, (totals.net / totals.revenue) * 100)) : 0}%;background:var(--cyan)"></div></div></div>
        <div class="sum-cell"><div class="sc-lbl">Marża netto</div><div class="sc-val">${(margin * 100).toFixed(1)}<span class="sc-unit">%</span></div><div class="sc-delta ${margin >= 0 ? 'delta-up' : 'delta-dn'}">netto / przychód</div><div class="sc-bar"><div class="sc-fill" style="width:${Math.max(0, Math.min(100, margin * 100))}%;background:${margin >= 0 ? 'var(--emerald)' : 'var(--rose)'}"></div></div></div>
      </div>
    </div>

    ${renderTaxReportCard(taxReport)}

    <div class="chart-grid">
      <div class="gc">
        <div class="ch">
          <div><div class="ch-title">Przychody i koszty</div><div class="ch-sub">12 miesięcy · zatwierdzone wpłaty</div></div>
          <div class="legend">
            <div class="leg"><div class="leg-sq" style="background:#8b5cf6"></div>Przychód</div>
            <div class="leg"><div class="leg-sq" style="background:#6b6ba0"></div>Koszty</div>
            <div class="leg"><div class="leg-sq" style="background:#06b6d4"></div>Netto</div>
          </div>
        </div>
        <div style="padding:16px 20px 18px"><div style="position:relative;height:230px"><canvas id="r-chart"></canvas></div></div>
      </div>
      <div class="gc">
        <div class="ch"><div><div class="ch-title">Struktura kosztów</div><div class="ch-sub">${escapeHtml(r.period_label)} · ${fmtPLN(totals.expenses)} PLN</div></div></div>
        <div style="padding:14px 20px">
          ${
            r.costs_by_category.length === 0
              ? emptyState('Brak kosztów w okresie.', 'Dodaj wpis w zakładce „Koszty".')
              : (() => {
                  const t = r.costs_by_category.reduce((s, c) => s + c.total, 0);
                  return (
                    r.costs_by_category
                      .map((c, i) => {
                        const pct = t ? c.total / t : 0;
                        const color = palette[i % palette.length];
                        return `<div class="cost-row">
                <div class="cr-dot" style="background:${color}"></div>
                <div class="cr-label">${escapeHtml(costCategoryLabel(c.category))}</div>
                <div class="cr-pct">${(pct * 100).toFixed(0)}%</div>
                <div class="cr-bar-wrap"><div class="cr-bar-fill" style="width:${pct * 100}%;background:${color}"></div></div>
                <div class="cr-val">${fmtPLN(c.total)} zł</div>
              </div>`;
                      })
                      .join('') +
                    `<div class="cost-row" style="font-weight:700"><div class="cr-dot" style="background:var(--t1)"></div><div class="cr-label" style="font-weight:700;color:var(--t1)">Łącznie</div><div class="cr-pct">100%</div><div class="cr-bar-wrap"><div class="cr-bar-fill" style="width:100%;background:var(--t1)"></div></div><div class="cr-val">${fmtPLN(t)} zł</div></div>`
                  );
                })()
          }
        </div>
      </div>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Szczegół per lokal</div><div class="ch-sub">${escapeHtml(r.period_label)} · ${r.per_unit.length} pozycji · koszty bezpośrednie + alokowane</div></div></div>
      <div style="overflow-x:auto">
        <table class="t">
          <thead><tr><th>#</th><th>Lokal</th><th>Najemca</th><th>Czynsz</th><th>Media</th><th>Inne</th><th>Kary</th><th>Razem bez kar</th><th>Wpłacono bez kar</th><th>Koszty (bezp. + alok.)</th><th>Status</th><th>Marża</th></tr></thead>
          <tbody>${r.per_unit
            .map((u, i) => {
              const st = STATUS_CHIP[u.status] || { cls: 'chip-n', label: '—' };
              const rev =
                (u.status === 'paid'
                  ? (u.rent_amount || 0) + (u.media_amount || 0) + (u.other_amount || 0)
                  : u.status === 'partial'
                    ? u.total_paid
                    : 0) || 0;
              const margin = rev ? (rev - (u.expenses || 0)) / rev : 0;
              const mc = margin >= 0.7 ? 'emerald' : margin >= 0.5 ? 'cyan' : margin >= 0 ? 'amber' : 'rose';
              return `<tr>
              <td class="mono-m">${String(i + 1).padStart(2, '0')}</td>
              <td><div style="font-weight:600;font-size:13px">${escapeHtml(u.property_name || '—')} ${u.unit_code ? '/ ' + escapeHtml(u.unit_code) : ''}</div></td>
              <td>${u.tenant_name ? `<div class="t-tenant">${avatar(u.tenant_name)}<span class="t-name">${escapeHtml(u.tenant_name)}</span></div>` : '<span style="color:var(--t4)">— wolne —</span>'}</td>
              <td class="mono">${fmtPLN(u.rent_amount)} zł</td>
              <td class="mono">${fmtPLN(u.media_amount)} zł</td>
              <td class="mono${u.other_amount ? '-a' : '-m'}">${u.other_amount ? fmtPLN(u.other_amount) + ' zł' : '—'}</td>
              <td class="mono${u.late_fee_amount ? '-a' : '-m'}">${u.late_fee_amount ? fmtPLN(u.late_fee_amount) + ' zł' : '—'}</td>
              <td class="mono-e">${fmtPLN(u.gross)} zł</td>
              <td class="mono">${fmtPLN(u.total_paid)} zł</td>
              <td class="mono${u.expenses ? '-r' : '-m'}" title="Bezpośrednie: ${fmtPLN(u.direct_expenses || 0)} zł · alokowane: ${fmtPLN(u.allocated_expenses || 0)} zł">${u.expenses ? fmtPLN(u.expenses) + ' zł' : '—'}</td>
              <td><span class="chip ${st.cls}">${st.label}</span></td>
              <td><div style="font-size:12px;font-weight:600;color:var(--${mc})">${(margin * 100).toFixed(1)}%</div><div class="margin-bar"><div class="margin-fill" style="width:${Math.max(0, Math.min(100, margin * 100))}%;background:var(--${mc})"></div></div></td>
            </tr>`;
            })
            .join('')}</tbody>
          <tfoot><tr>
            <td colspan="3" style="font-size:13px">Suma</td>
            <td class="mono">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.rent_amount || 0), 0))} zł</td>
            <td class="mono">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.media_amount || 0), 0))} zł</td>
            <td class="mono">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.other_amount || 0), 0))} zł</td>
            <td class="mono-a">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.late_fee_amount || 0), 0))} zł</td>
            <td class="mono-e" style="font-size:13px">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.gross || 0), 0))} zł</td>
            <td class="mono">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.total_paid || 0), 0))} zł</td>
            <td class="mono-r" style="font-size:13px">${fmtPLN(r.per_unit.reduce((s, u) => s + (u.expenses || 0), 0))} zł</td>
            <td></td>
            <td style="font-size:13px;font-weight:700;color:var(--emerald)">${(margin * 100).toFixed(1)}%</td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;

  document.getElementById('btn-refresh').onclick = () => render();
  document.getElementById('btn-pdf').onclick = () => {
    window.location = `/api/export/report.pdf?period=${State.period}&v=${Date.now()}`;
  };
  document.querySelectorAll('[data-rp]').forEach(
    (el) =>
      (el.onclick = () => {
        State.reportProp = el.dataset.rp;
        render();
      }),
  );

  const ctx = document.getElementById('r-chart');
  if (ctx && r.chart_12m) {
    const net = r.chart_12m.map((x) => (x.revenue || 0) - (x.expenses || 0) - (x.tax || 0));
    State.charts.reports = new Chart(ctx, {
      type: 'line',
      data: {
        labels: r.chart_12m.map(
          (x) => PL_MONTHS_SHORT[+x.period.split('-')[1] - 1] + ' ' + x.period.slice(2, 4),
        ),
        datasets: [
          {
            label: 'Przychód',
            data: r.chart_12m.map((x) => x.revenue),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139,92,246,0.1)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2.5,
          },
          {
            label: 'Koszty + podatek',
            data: r.chart_12m.map((x) => (x.expenses || 0) + (x.tax || 0)),
            borderColor: '#6b6ba0',
            backgroundColor: 'rgba(107,107,160,0.07)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2,
            borderDash: [4, 3],
          },
          {
            label: 'Netto',
            data: net,
            borderColor: '#06b6d4',
            backgroundColor: 'transparent',
            tension: 0.4,
            pointRadius: 3,
            borderWidth: 2,
          },
        ],
      },
      options: chartBaseOpts(),
    });
  }
}

function renderOwnerStatement(report) {
  if (!report) return '';
  const totals = report.totals || {};
  const risks = report.risks || {};
  const riskCount =
    Number(risks.arrears_count || 0) +
    Number(risks.contracts_ending_60d || 0) +
    Number(risks.documents_expiring_60d || 0) +
    Number(risks.bank_unresolved || 0);
  return `<details class="gc owner-statement" open>
    <summary class="owner-statement-summary">
      <div><div class="ch-title">Raport właścicielski · ${escapeHtml(report.range.from)} — ${escapeHtml(report.range.to)}</div><div class="ch-sub">wynik portfela, ściągalność, ryzyka i uzgodnienie bankowe</div></div>
      ${chip(riskCount ? 'chip-a' : 'chip-e', riskCount ? `${riskCount} sygnałów` : 'bez pilnych sygnałów', !riskCount)}
    </summary>
    <div class="owner-statement-body">
      <div class="sum-grid sum-grid-5">
        <div class="sum-cell"><div class="sc-lbl">Ściągalność</div><div class="sc-val">${fmtPLN2(totals.collection_rate)}<span class="sc-unit">%</span></div><div class="sc-delta ${totals.collection_rate >= 95 ? 'delta-up' : 'delta-dn'}">${fmtPLN(totals.revenue)} / ${fmtPLN(totals.expected)} zł</div></div>
        <div class="sum-cell"><div class="sc-lbl">Przychód 12 mies.</div><div class="sc-val">${fmtPLN(totals.revenue)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">wpłaty zatwierdzone</div></div>
        <div class="sum-cell"><div class="sc-lbl">Koszty</div><div class="sc-val">${fmtPLN(totals.expenses)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">${fmtPLN2(totals.cost_ratio)}% przychodu</div></div>
        <div class="sum-cell"><div class="sc-lbl">Netto właściciela</div><div class="sc-val">${fmtPLN(totals.net)}<span class="sc-unit"> PLN</span></div><div class="sc-delta ${totals.net >= 0 ? 'delta-up' : 'delta-dn'}">po kosztach i podatku</div></div>
        <div class="sum-cell"><div class="sc-lbl">Marża netto</div><div class="sc-val">${fmtPLN2(totals.net_margin)}<span class="sc-unit">%</span></div><div class="sc-delta delta-n">wynik / przychód</div></div>
      </div>
      <div class="owner-risk-grid">
        <div class="owner-risk ${risks.arrears_count ? 'warn' : ''}"><strong>${Number(risks.arrears_count || 0)}</strong><span>Zaległe płatności</span><small>${fmtPLN(risks.arrears_amount || 0)} PLN</small></div>
        <div class="owner-risk ${risks.bank_unresolved ? 'warn' : ''}"><strong>${Number(risks.bank_unresolved || 0)}</strong><span>Nieuzgodnione wpłaty</span><small>${fmtPLN(report.reconciliation?.matched_amount || 0)} PLN uzgodnione</small></div>
        <div class="owner-risk ${risks.contracts_ending_60d ? 'warn' : ''}"><strong>${Number(risks.contracts_ending_60d || 0)}</strong><span>Umowy do 60 dni</span><small>do decyzji</small></div>
        <div class="owner-risk ${risks.documents_expiring_60d ? 'warn' : ''}"><strong>${Number(risks.documents_expiring_60d || 0)}</strong><span>Dokumenty do 60 dni</span><small>do odnowienia</small></div>
      </div>
      <div class="ch inline"><div><div class="ch-title">Wynik nieruchomości</div><div class="ch-sub">ranking za cały zakres raportu</div></div></div>
      <div class="table-wrap"><table class="t owner-property-table">
        <thead><tr><th>Nieruchomość</th><th>Przychód</th><th>Ściągalność</th><th>Koszty</th><th>Podatek</th><th>Netto</th><th>Marża</th></tr></thead>
        <tbody>${(report.properties || [])
          .map(
            (property) =>
              `<tr><td><strong>${escapeHtml(property.name)}</strong></td><td class="mono-e">${fmtPLN(property.revenue)} zł</td><td class="mono">${fmtPLN2(property.collection_rate)}%</td><td class="mono-r">${fmtPLN(property.expenses)} zł</td><td class="mono">${fmtPLN(property.tax)} zł</td><td class="mono${property.net >= 0 ? '-e' : '-r'}">${fmtPLN(property.net)} zł</td><td>${chip(property.net_margin >= 0 ? 'chip-e' : 'chip-r', `${fmtPLN2(property.net_margin)}%`)}</td></tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>
  </details>`;
}

function renderTaxReportCard(report) {
  if (!report) return '';
  const monthLabels = report.months.map((period) => PL_MONTHS[Number(period.slice(5, 7)) - 1]);
  const incomeTotal = report.income && report.income.total ? report.income.total : 0;
  const rows = (report.properties || [])
    .map(
      (row) => `
    <tr>
      <th>${escapeHtml(row.name)}</th>
      ${row.values.map((value) => `<td>${fmtPLN2(value)} zł</td>`).join('')}
      <td class="tax-total">${fmtPLN2(row.total)} zł</td>
      <td></td>
    </tr>`,
    )
    .join('');
  return `
    <div class="gc tax-card">
      <div class="ch">
        <div>
          <div class="ch-title">Raport podatkowy ${report.year} r.</div>
          <div class="ch-sub">Automatycznie z zatwierdzonych wpłat czynszu · ryczałt miesięczny</div>
        </div>
        ${chip('chip-a', `Dochód ${fmtPLN2(incomeTotal)} zł`)}
      </div>
      <div class="tax-table-wrap">
        <table class="tax-report-table">
          <thead>
            <tr>
              <th>Podatek ${report.year} r.</th>
              ${monthLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}
              <th>Sumy</th>
              <th>Dochód całkowity</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><th>Brak nieruchomości</th><td colspan="14">—</td></tr>`}
            <tr class="tax-paid-row">
              <th>Podatek zapłacony</th>
              ${report.tax_paid.values.map((value) => `<td>${fmtPLN(value)} zł</td>`).join('')}
              <td class="tax-total">${fmtPLN(report.tax_paid.total)} zł</td>
              <td class="tax-income">${fmtPLN2(incomeTotal)} zł</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

// ═══════════════════════ KOSZTY ═══════════════════════
function expenseDescriptionLabel(e) {
  const raw = String((e && e.description) || '').trim();
  const category = String((e && e.category) || '').toLowerCase();
  const categoryFallback =
    {
      czynsz: 'Czynsz administracyjny',
      prad: 'Prąd',
      internet: 'Internet',
      remonty: 'Remont',
      doplata: 'Dopłata do czynszu',
      zarzadzanie: 'Zarządzanie nieruchomościami',
      kredyt: 'Rata kredytu hipotecznego',
      inne: 'Inny koszt',
    }[category] || 'Koszt';
  if (!raw) return categoryFallback;

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (normalized === 'koszt wlasciciela: zarzadzanie') return 'Zarządzanie nieruchomościami';
  if (normalized === 'koszt wlasciciela: rata kredytu') return 'Rata kredytu hipotecznego';

  const fixed = normalized.match(/^staly koszt\s+[^:]+:\s*(czynsz|internet|prad)$/);
  if (fixed) {
    return {
      czynsz: 'Czynsz administracyjny',
      internet: 'Internet',
      prad: 'Prąd',
    }[fixed[1]];
  }

  return raw
    .replace(/\s*\(stały\)$/i, '')
    .replace(/^Media \(dostawcy\)\s*[—-]\s*/i, 'Media dostawcy · ')
    .replace(/^Prowizja zarządcy \(Marek\)\s*[—-]\s*/i, 'Prowizja zarządcy · ');
}

async function renderExpenses(root) {
  const params = new URLSearchParams();
  if (State.expCat && State.expCat !== 'all') params.set('category', State.expCat);
  if (State.expProp) params.set('property_id', State.expProp);
  params.set('from', State.period + '-01');
  params.set('to', State.period + '-31');
  params.set('include_owner', '1');

  const [expenses, properties] = await Promise.all([
    Api.get('/expenses?' + params.toString()),
    Api.get('/properties'),
  ]);

  const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const dash = await Api.get(`/dashboard?period=${State.period}`).catch(() => null);
  const revenue = dash && dash.revenue ? dash.revenue.gross || 0 : 0;
  const tax = dash && dash.tax ? dash.tax.podatek_suma || 0 : 0;
  const burdenTotal = total + tax;
  const afterCosts = +(revenue - total).toFixed(2);
  const net =
    dash && Number.isFinite(Number(dash.net_for_owner)) ? dash.net_for_owner : +(afterCosts - tax).toFixed(2);
  const CATS = ['all', 'czynsz', 'prad', 'internet', 'remonty', 'doplata', 'zarzadzanie', 'kredyt', 'inne'];
  const CAT_LABELS = {
    all: 'Wszystkie',
    czynsz: 'Czynsz',
    prad: 'Prąd',
    internet: 'Internet',
    remonty: 'Remonty',
    doplata: 'Dopłata do czynszu',
    zarzadzanie: 'Zarządzanie',
    kredyt: 'Kredyt',
    inne: 'Inne',
  };
  const CAT_COLORS = {
    czynsz: '#8b5cf6',
    prad: '#f59e0b',
    internet: '#06b6d4',
    remonty: '#f43f5e',
    doplata: '#10b981',
    zarzadzanie: '#a78bfa',
    kredyt: '#fb7185',
    inne: '#5a5a8a',
  };

  const year = State.period.slice(0, 4);
  const yearExpenses = await Api.get(`/expenses?from=${year}-01-01&to=${year}-12-31&include_owner=1`).catch(
    () => [],
  );
  const byMonthCat = Array.from({ length: 12 }, () => ({}));
  for (const e of yearExpenses) {
    const m = parseInt((e.date || '').slice(5, 7), 10) - 1;
    if (m >= 0 && m < 12) byMonthCat[m][e.category] = (byMonthCat[m][e.category] || 0) + (e.amount || 0);
  }
  const yearTotal = yearExpenses.reduce((s, e) => s + (e.amount || 0), 0);

  setTopbar(
    VIEW_TITLES.koszty,
    `${expenses.length} pozycji · ${fmtPLN(total)} zł w ${periodLabel(State.period)}`,
    `<button class="tb-btn tb-ghost" id="btn-migrate" title="Importuj historyczne koszty z arkusza"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Importuj historyczne</button>
     <button class="tb-btn tb-primary" id="btn-add-exp"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Dodaj koszt</button>`,
  );

  root.innerHTML = `
    <div class="gc">
      <div class="ch"><div><div class="ch-title">Obciążenia miesiąca</div><div class="ch-sub">${escapeHtml(periodLabel(State.period))} · koszty + podatek</div></div></div>
      <div class="sum-grid sum-grid-5">
        <div class="sum-cell"><div class="sc-lbl">Przychód</div><div class="sc-val">${fmtPLN(revenue)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">zatwierdzone wpłaty</div></div>
        <div class="sum-cell"><div class="sc-lbl">Koszty</div><div class="sc-val">${fmtPLN(total)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">bez podatku</div></div>
        <div class="sum-cell"><div class="sc-lbl">Podatek</div><div class="sc-val">${fmtPLN(tax)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">wyliczony z czynszu</div></div>
        <div class="sum-cell"><div class="sc-lbl">Razem obciążenia</div><div class="sc-val">${fmtPLN(burdenTotal)}<span class="sc-unit"> PLN</span></div><div class="sc-delta delta-n">koszty + podatek</div></div>
        <div class="sum-cell"><div class="sc-lbl">Netto</div><div class="sc-val">${fmtPLN(net)}<span class="sc-unit"> PLN</span></div><div class="sc-delta ${net >= 0 ? 'delta-up' : 'delta-dn'}">po wszystkim</div></div>
      </div>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Koszty miesięczne — ${escapeHtml(year)}</div><div class="ch-sub">Suma roczna: ${fmtPLN(yearTotal)} zł · ${yearExpenses.length} wpisów</div></div>
        <div class="legend">
          ${CATS.filter((c) => c !== 'all')
            .map(
              (c) =>
                `<div class="leg"><div class="leg-sq" style="background:${CAT_COLORS[c]}"></div>${CAT_LABELS[c]}</div>`,
            )
            .join('')}
        </div>
      </div>
      <div style="padding:16px 20px 18px"><div style="position:relative;height:240px"><canvas id="exp-year-chart"></canvas></div></div>
    </div>

    <div class="toolbar">
      <div class="fgroup"><span class="flbl">Kategoria:</span>
        ${CATS.map((c) => `<button class="ftab ${(State.expCat || 'all') === c ? 'on' : ''}" data-ec="${c}">${CAT_LABELS[c]}</button>`).join('')}
      </div>
      <div class="fsep"></div>
      <div class="fgroup"><span class="flbl">Nieruchomość:</span>
        <button class="ftab ${!State.expProp ? 'on' : ''}" data-ep="">Wszystkie</button>
        ${properties.map((p) => `<button class="ftab ${String(State.expProp) === String(p.id) ? 'on' : ''}" data-ep="${p.id}">${escapeHtml(p.name)}</button>`).join('')}
      </div>
    </div>

    <div class="gc">
      ${
        expenses.length === 0
          ? `<div style="padding:32px">${emptyState('Brak kosztów w wybranym okresie.', 'Zmień filtry, dodaj nowy wpis lub kliknij „Importuj historyczne" w prawym górnym rogu, aby pobrać dane z arkusza Excel.')}</div>`
          : `
      <div style="overflow-x:auto"><table class="t">
        <thead><tr><th>Data</th><th>Kategoria</th><th>Nieruchomość</th><th>Lokal</th><th>Opis</th><th>Kwota</th><th></th></tr></thead>
        <tbody>${expenses
          .map(
            (e) => `<tr>
          <td class="mono">${fmtDate(e.date)}</td>
          <td>${chip('chip-v', CAT_LABELS[e.category] || e.category)}</td>
          <td style="font-size:12px">${escapeHtml(e.property_name || '—')}</td>
          <td class="mono">${escapeHtml(e.unit_code || e.unit_name || '—')}</td>
          <td style="font-size:12px;color:var(--t2)" title="${escapeHtml(e.description || '')}">${escapeHtml(expenseDescriptionLabel(e))}</td>
          <td class="mono-r">${fmtPLN(e.amount)} zł</td>
          <td>${expenseActionsHtml(e)}</td>
        </tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr><td colspan="5" style="text-align:right;padding-right:12px">Razem:</td><td class="mono-r" style="font-size:13px">${fmtPLN(total)} zł</td><td></td></tr></tfoot>
      </table></div>`
      }
    </div>`;

  document.getElementById('btn-add-exp').onclick = () => editExpense(null);
  document.getElementById('btn-migrate').onclick = () => {
    confirmDialog({
      title: 'Importuj historyczne koszty',
      message:
        'Zaimportować historyczne koszty z arkusza Excel (monthly_summary)? Zostaną dodane: media (dostawcy) jako kategoria „Inne" oraz prowizja zarządcy jako „Dopłata", przypisane do Os. B. Chrobrego. Operacja jest idempotentna — duplikaty są pomijane.',
      onYes: async () => {
        const r = await Api.post('/expenses/migrate-from-summary');
        toast(`Zaimportowano ${r.inserted} wpisów (pominięto ${r.skipped})`, 'ok', 4000);
        render();
      },
    });
  };
  document.querySelectorAll('[data-ec]').forEach(
    (b) =>
      (b.onclick = () => {
        State.expCat = b.dataset.ec;
        render();
      }),
  );
  document.querySelectorAll('[data-ep]').forEach(
    (b) =>
      (b.onclick = () => {
        State.expProp = b.dataset.ep || '';
        render();
      }),
  );

  const ctx = document.getElementById('exp-year-chart');
  if (ctx) {
    const cats = Object.keys(CAT_LABELS).filter((k) => k !== 'all');
    const datasets = cats
      .map((cat) => ({
        label: CAT_LABELS[cat],
        data: byMonthCat.map((m) => m[cat] || 0),
        backgroundColor: CAT_COLORS[cat],
        borderRadius: 4,
      }))
      .filter((ds) => ds.data.some((v) => v > 0));
    State.charts.expYear = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: PL_MONTHS_SHORT,
        datasets: datasets.length
          ? datasets
          : [{ label: 'Brak kosztów', data: Array(12).fill(0), backgroundColor: '#33335a' }],
      },
      options: chartBaseOpts({
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { font: { size: 11 }, callback: (v) => v.toLocaleString('pl-PL') + ' zł' },
          },
        },
      }),
    });
  }
}

function expenseActionsHtml(e) {
  const editIcon =
    '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const deleteIcon =
    '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>';
  if (e.system) {
    const period = String(e.date || State.period).slice(0, 7);
    const propertyId = Number(e.property_id || 0);
    return `<div style="display:flex;gap:4px;align-items:center">
      <span class="mono-m">systemowy</span>
      ${e.category === 'kredyt' && propertyId ? `<button class="icon-btn" onclick="editOwnerMortgageCost('${escapeHtml(period)}', ${propertyId})" title="Edytuj ratę kredytu">${editIcon}</button>` : ''}
    </div>`;
  }
  const expenseId = Number(e.id);
  return `<div style="display:flex;gap:4px">
    <button class="icon-btn" onclick="editExpense(${expenseId})" title="Edytuj">${editIcon}</button>
    <button class="icon-btn danger" onclick="deleteExpense(${expenseId})" title="Usuń">${deleteIcon}</button>
  </div>`;
}

window.editExpense = async function (id) {
  const [props, units] = await Promise.all([Api.get('/properties'), Api.get('/units')]);
  let initial = { category: 'inne', date: State.period + '-01' };
  if (id) initial = await Api.get(`/expenses/${id}`);
  formModal({
    title: id ? 'Edytuj koszt' : 'Nowy koszt',
    fields: [
      { name: 'date', label: 'Data', type: 'date', required: true },
      {
        name: 'category',
        label: 'Kategoria',
        type: 'select',
        options: [
          { value: 'czynsz', label: 'Czynsz' },
          { value: 'prad', label: 'Prąd' },
          { value: 'internet', label: 'Internet' },
          { value: 'remonty', label: 'Remonty' },
          { value: 'doplata', label: 'Dopłata do czynszu' },
          { value: 'zarzadzanie', label: 'Zarządzanie' },
          { value: 'kredyt', label: 'Kredyt' },
          { value: 'inne', label: 'Inne' },
        ],
      },
      {
        name: 'property_id',
        label: 'Nieruchomość',
        type: 'select',
        options: [{ value: '', label: '—' }, ...props.map((p) => ({ value: p.id, label: p.name }))],
      },
      {
        name: 'unit_id',
        label: 'Lokal',
        type: 'select',
        options: [
          { value: '', label: '—' },
          ...units.map((u) => ({ value: u.id, label: `${u.property_name} · ${u.name}` })),
        ],
      },
      { name: 'amount', label: 'Kwota [PLN]', type: 'number', step: '0.01', required: true },
      { name: 'description', label: 'Opis', type: 'textarea', full: true },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/expenses/${id}`, b);
      else await Api.post('/expenses', b);
      toast(id ? 'Zaktualizowano' : 'Dodano koszt');
      render();
    },
  });
};

window.editOwnerMortgageCost = async function (period, propertyId) {
  const ownerCosts = await Api.get(`/settings/owner-costs?period=${encodeURIComponent(period)}`);
  const row = (ownerCosts.mortgages || []).find((item) => String(item.property_id) === String(propertyId));
  if (!row) throw new Error('Nie znaleziono nieruchomości dla raty kredytu');
  formModal({
    title: 'Edytuj ratę kredytu',
    fields: [
      {
        name: 'valid_from_period',
        label: 'Obowiązuje od miesiąca',
        type: 'text',
        required: true,
        hint: 'Format YYYY-MM. Nowa rata będzie liczona od tego miesiąca.',
      },
      { name: 'amount', label: 'Kwota [PLN]', type: 'number', step: '0.01', required: true },
      { name: 'property_name', label: 'Nieruchomość', type: 'text', readonly: true },
    ],
    initial: {
      valid_from_period: period,
      amount: row.amount || 0,
      property_name: row.property_name || '',
    },
    onSubmit: async (b) => {
      if (!/^\d{4}-\d{2}$/.test(b.valid_from_period || '')) throw new Error('Format YYYY-MM');
      await Api.put('/settings/owner-costs/mortgage', {
        property_id: propertyId,
        valid_from_period: b.valid_from_period,
        amount: b.amount,
      });
      toast('Zaktualizowano ratę kredytu');
      State.period = b.valid_from_period;
      render();
    },
  });
};

window.deleteExpense = function (id) {
  confirmDialog({
    title: 'Usuń koszt',
    message: 'Usunąć ten wpis?',
    danger: true,
    onYes: async () => {
      await Api.del(`/expenses/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

// ═══════════════════════ ZADANIA ═══════════════════════
async function renderTasks(root) {
  const tasks = await Api.get('/tasks');
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');

  setTopbar(
    VIEW_TITLES.zadania,
    `${open.length} otwartych · ${done.length} ukończonych`,
    `<button class="tb-btn tb-primary" id="btn-add-task"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Nowe zadanie</button>`,
  );

  root.innerHTML = `
    <div class="kanban">
      <div class="gc kcol">
        <div class="ch"><div><div class="ch-title">Otwarte (${open.length})</div></div></div>
        <div class="kcol-body">
          ${open.length === 0 ? emptyState('Brak otwartych zadań.') : open.map(taskCard).join('')}
        </div>
      </div>
      <div class="gc kcol">
        <div class="ch"><div><div class="ch-title">Ukończone (${done.length})</div></div></div>
        <div class="kcol-body">
          ${done.length === 0 ? emptyState('Jeszcze nic nie zamknięte.') : done.map(taskCard).join('')}
        </div>
      </div>
    </div>`;

  document.getElementById('btn-add-task').onclick = () => editTask(null);
}

function taskCard(t) {
  const prio = { high: 'chip-r', med: 'chip-a', low: 'chip-n' }[t.priority] || 'chip-n';
  const prioLabel = { high: 'Wysoki', med: 'Średni', low: 'Niski' }[t.priority] || t.priority;
  const where = t.property_name ? `${t.property_name}${t.unit_name ? ' · ' + t.unit_name : ''}` : '';
  return `
    <div class="task-card${t.status === 'done' ? ' done' : ''}">
      <div class="task-chk" onclick="toggleTask(${t.id})">${t.status === 'done' ? '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>
      <div class="task-body" onclick="editTask(${t.id})">
        <div class="task-title">${escapeHtml(t.title)}</div>
        ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
        <div class="task-meta">
          ${chip(prio, prioLabel)}
          ${t.due_date ? `<span>📅 ${fmtDate(t.due_date)}</span>` : ''}
          ${where ? `<span>${escapeHtml(where)}</span>` : ''}
        </div>
      </div>
      <button class="icon-btn danger" title="Usuń" onclick="deleteTask(${t.id})"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg></button>
    </div>`;
}

window.editTask = async function (id) {
  const [props, units, tenants] = await Promise.all([
    Api.get('/properties'),
    Api.get('/units'),
    Api.get('/tenants'),
  ]);
  let initial = { priority: 'med', status: 'open' };
  if (id) initial = await Api.get(`/tasks/${id}`);
  formModal({
    title: id ? 'Edytuj zadanie' : 'Nowe zadanie',
    wide: true,
    fields: [
      { name: 'title', label: 'Tytuł', required: true, full: true },
      { name: 'description', label: 'Opis', type: 'textarea', full: true },
      {
        name: 'property_id',
        label: 'Nieruchomość',
        type: 'select',
        options: [{ value: '', label: '—' }, ...props.map((p) => ({ value: p.id, label: p.name }))],
      },
      {
        name: 'unit_id',
        label: 'Lokal',
        type: 'select',
        options: [
          { value: '', label: '—' },
          ...units.map((u) => ({ value: u.id, label: `${u.property_name} · ${u.name}` })),
        ],
      },
      {
        name: 'tenant_id',
        label: 'Najemca',
        type: 'select',
        options: [{ value: '', label: '—' }, ...tenants.map((t) => ({ value: t.id, label: t.name }))],
      },
      { name: 'due_date', label: 'Termin', type: 'date' },
      {
        name: 'priority',
        label: 'Priorytet',
        type: 'select',
        options: [
          { value: 'low', label: 'Niski' },
          { value: 'med', label: 'Średni' },
          { value: 'high', label: 'Wysoki' },
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'open', label: 'Otwarte' },
          { value: 'done', label: 'Ukończone' },
        ],
      },
    ],
    initial,
    onSubmit: async (b) => {
      if (id) await Api.put(`/tasks/${id}`, b);
      else await Api.post('/tasks', b);
      toast(id ? 'Zaktualizowano' : 'Dodano zadanie');
      render();
    },
  });
};

window.deleteTask = function (id) {
  confirmDialog({
    title: 'Usuń zadanie',
    message: 'Czy na pewno usunąć?',
    danger: true,
    onYes: async () => {
      await Api.del(`/tasks/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

window.toggleTask = function (id) {
  Api.put(`/tasks/${id}/toggle`)
    .then(() => {
      toast('Zaktualizowano');
      render();
    })
    .catch((e) => toast(e.message, 'err'));
};

// ═══════════════════════ DOKUMENTY ═══════════════════════
async function renderDocuments(root) {
  const documentStatus = State.documentStatus || 'all';
  const docs = await Api.get(
    `/documents${documentStatus === 'all' ? '' : `?workflow_status=${encodeURIComponent(documentStatus)}`}`,
  );

  setTopbar(
    VIEW_TITLES.dokumenty,
    `${docs.length} plików w archiwum`,
    `<button class="tb-btn tb-primary" id="btn-up"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Wgraj plik</button>`,
  );

  root.innerHTML = `
    <div class="gc">
      <div class="ch document-toolbar">
        <div><div class="ch-title">Obieg dokumentów</div><div class="ch-sub">wersje, akceptacja, podpis i terminy ważności</div></div>
        <div class="filter-tabs document-filter-tabs">
          ${[
            ['all', 'Wszystkie'],
            ['uploaded', 'Nowe'],
            ['review', 'Weryfikacja'],
            ['approved', 'Zaakceptowane'],
            ['signed', 'Podpisane'],
            ['archived', 'Archiwum'],
          ]
            .map(
              ([value, label]) =>
                `<button class="ftab ${documentStatus === value ? 'on' : ''}" data-document-status="${value}">${label}</button>`,
            )
            .join('')}
        </div>
      </div>
      ${
        docs.length === 0
          ? `<div style="padding:36px">${emptyState('Brak dokumentów.', 'Wgraj pierwszy plik.')}</div>`
          : `<div style="padding:18px"><div class="doc-grid">
          ${docs
            .map(
              (d) => `
            <div class="doc-card">
              <div class="doc-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
              <div class="doc-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
              <div class="doc-meta">${escapeHtml(d.category || 'inne')} · v${Number(d.version || 1)} · ${(d.size_bytes / 1024).toFixed(0)} kB · ${fmtDate(d.uploaded_at)}</div>
              <div class="doc-workflow-line">${documentWorkflowChip(d.workflow_status)}${d.expires_on ? `<span class="doc-expiry ${d.expires_on < todayISO() ? 'expired' : ''}">ważny do ${fmtDate(d.expires_on)}</span>` : ''}</div>
              <div class="doc-actions">
                <a href="/api/documents/${d.id}/download" download>Pobierz</a>
                <button data-edit-document="${d.id}">Obieg</button>
                <button onclick="deleteDoc(${d.id})">Usuń</button>
              </div>
            </div>`,
            )
            .join('')}
        </div></div>`
      }
    </div>`;

  document.getElementById('btn-up').onclick = () => uploadDocDialog();
  root.querySelectorAll('[data-document-status]').forEach((button) => {
    button.onclick = () => {
      State.documentStatus = button.dataset.documentStatus;
      render();
    };
  });
  root.querySelectorAll('[data-edit-document]').forEach((button) => {
    const document = docs.find((item) => String(item.id) === button.dataset.editDocument);
    button.onclick = () => editDocumentWorkflow(document);
  });
}

function documentWorkflowChip(status) {
  const value = {
    uploaded: ['chip-n', 'Nowy'],
    review: ['chip-a', 'Weryfikacja'],
    approved: ['chip-c', 'Zaakceptowany'],
    signed: ['chip-e', 'Podpisany'],
    rejected: ['chip-r', 'Odrzucony'],
    archived: ['chip-n', 'Archiwum'],
  }[status || 'uploaded'] || ['chip-n', status || 'Nowy'];
  return chip(value[0], value[1]);
}

function editDocumentWorkflow(document) {
  const transitions = {
    uploaded: ['review', 'approved', 'archived'],
    review: ['uploaded', 'approved', 'rejected'],
    approved: ['review', 'signed', 'archived'],
    signed: ['archived'],
    rejected: ['uploaded', 'archived'],
    archived: ['uploaded'],
  };
  const labels = {
    uploaded: 'Nowy / wgrany',
    review: 'W weryfikacji',
    approved: 'Zaakceptowany',
    signed: 'Podpisany',
    rejected: 'Odrzucony',
    archived: 'Archiwum',
  };
  formModal({
    title: `Obieg: ${document.name}`,
    fields: [
      { name: 'name', label: 'Nazwa', required: true, default: document.name, full: true },
      { name: 'document_number', label: 'Numer dokumentu', default: document.document_number || '' },
      { name: 'version', label: 'Wersja', type: 'number', default: Number(document.version || 1) },
      { name: 'expires_on', label: 'Ważny do', type: 'date', default: document.expires_on || '' },
      {
        name: 'workflow_status',
        label: 'Następny etap',
        type: 'select',
        default: document.workflow_status || 'uploaded',
        options: [
          document.workflow_status || 'uploaded',
          ...(transitions[document.workflow_status || 'uploaded'] || []),
        ].map((value) => ({ value, label: labels[value] || value })),
      },
      { name: 'transition_note', label: 'Notatka do zmiany', type: 'textarea', full: true },
    ],
    submitLabel: 'Zapisz etap',
    onSubmit: async (payload) => {
      if (!payload.expires_on) payload.expires_on = null;
      await Api.put(`/documents/${document.id}`, payload);
      toast('Obieg dokumentu zaktualizowany');
      render();
    },
  });
}

window.deleteDoc = function (id) {
  confirmDialog({
    title: 'Usuń dokument',
    message: 'Plik zostanie usunięty z dysku.',
    danger: true,
    onYes: async () => {
      await Api.del(`/documents/${id}`);
      toast('Usunięto', 'info');
      render();
    },
  });
};

async function uploadDocDialog() {
  const [tenants, properties, contracts] = await Promise.all([
    Api.get('/tenants').catch(() => []),
    Api.get('/properties').catch(() => []),
    Api.get('/contracts').catch(() => []),
  ]);
  const html = `
    <div class="form-grid">
      <div class="form-row full"><label>Plik</label><input type="file" id="doc-file" required></div>
      <div class="form-row"><label>Kategoria</label>
        <select id="doc-cat"><option value="umowa">Umowa</option><option value="aneks">Aneks</option><option value="faktura">Faktura</option><option value="protokol">Protokół</option><option value="inne" selected>Inne</option></select>
      </div>
      <div class="form-row"><label>Numer dokumentu</label><input id="doc-number"></div>
      <div class="form-row"><label>Ważny do</label><input id="doc-expiry" type="date"></div>
      <div class="form-row"><label>Powiązane z</label>
        <select id="doc-ent"><option value="">— brak —</option><option value="tenant">Najemcą</option><option value="contract">Umową</option><option value="property">Nieruchomością</option></select>
      </div>
      <div class="form-row full" id="doc-ref-row" style="display:none">
        <label id="doc-ref-label">Wybierz</label>
        <select id="doc-eid-sel"><option value="">— wybierz —</option></select>
      </div>
    </div>`;
  const m = modal({
    title: 'Wgraj dokument',
    body: html,
    footer: `<button class="tb-btn tb-ghost" id="m-cancel">Anuluj</button><button class="tb-btn tb-primary" id="m-save">Wgraj</button>`,
  });
  m.root.querySelector('#m-cancel').onclick = m.close;
  const entSel = m.root.querySelector('#doc-ent');
  const categorySel = m.root.querySelector('#doc-cat');
  const refRow = m.root.querySelector('#doc-ref-row');
  const refLabel = m.root.querySelector('#doc-ref-label');
  const refSel = m.root.querySelector('#doc-eid-sel');
  entSel.onchange = () => {
    const v = entSel.value;
    refRow.style.display = v ? '' : 'none';
    if (!v) return;
    const opts = { tenant: tenants, property: properties, contract: contracts };
    const lblMap = {
      tenant: (t) => t.name,
      property: (p) => p.name,
      contract: (c) => `${c.tenant_name} – ${c.property_name}`,
    };
    const lblHead = { tenant: 'Najemca', property: 'Nieruchomość', contract: 'Umowa' };
    refLabel.textContent = lblHead[v] || 'Wybierz';
    refSel.innerHTML =
      '<option value="">— wybierz —</option>' +
      (opts[v] || []).map((x) => `<option value="${x.id}">${escapeHtml(lblMap[v](x))}</option>`).join('');
  };
  const syncAmendmentCategory = () => {
    const isAmendment = categorySel.value === 'aneks';
    if (isAmendment) {
      entSel.value = 'contract';
      entSel.disabled = true;
      entSel.onchange();
    } else {
      entSel.disabled = false;
    }
  };
  categorySel.onchange = syncAmendmentCategory;
  m.root.querySelector('#m-save').onclick = async () => {
    const f = m.root.querySelector('#doc-file').files[0];
    if (!f) return toast('Wybierz plik', 'err');
    if (categorySel.value === 'aneks' && (!entSel.value || !refSel.value)) {
      return toast('Aneks musi być powiązany z konkretną umową.', 'err');
    }
    const fd = new FormData();
    fd.append('file', f);
    fd.append('category', categorySel.value);
    fd.append('document_number', m.root.querySelector('#doc-number').value.trim());
    fd.append('expires_on', m.root.querySelector('#doc-expiry').value);
    const ent = entSel.value;
    if (ent) {
      fd.append('entity_type', ent);
      fd.append('entity_id', refSel.value || '');
    }
    try {
      await Api.upload('/documents', fd);
      toast('Wgrano');
      m.close();
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

// ═══════════════════════ USTAWIENIA ═══════════════════════
async function renderSettings(root) {
  const [s, importStatus, ownerCosts, notificationSettings, notificationLogs, aiAliases, automationData] =
    await Promise.all([
      Api.get('/settings'),
      Api.get('/import/status').catch(() => ({ excel_import_enabled: false, dry_run_enabled: true })),
      Api.get('/settings/owner-costs').catch(() => ({
        valid_from_period: '2026-01',
        management_monthly: 0,
        mortgages: [],
      })),
      Api.get('/notifications/settings').catch(() => ({
        enabled: false,
        sender: 'TEST',
        send_time: '09:30',
        overdue_days: 1,
        reminder_enabled: true,
        reminder_days_before_due: 3,
        test_mode: true,
        test_phone: '',
        clear_polish: false,
        transactional: false,
        token_configured: false,
      })),
      Api.get('/notifications/logs?limit=12').catch(() => []),
      Api.get('/assistant/aliases').catch(() => ({
        aliases: [],
        candidates: { properties: [], tenants: [], metrics: [] },
      })),
      Api.get('/automations?status=pending').catch(() => ({ proposals: [], stats: {} })),
    ]);
  setTopbar(
    VIEW_TITLES.ustawienia,
    'Dane firmy, podatki, preferencje',
    `<button class="tb-btn tb-primary" id="set-save"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Zapisz</button>`,
  );

  root.innerHTML = `
    <div class="gc">
      <div class="ch"><div><div class="ch-title">Dane firmy</div><div class="ch-sub">właściciel · stawki · waluta</div></div></div>
      <form id="set-form" class="form-grid">
        <div class="form-row"><label>Nazwa</label><input name="company.name" value="${escapeHtml(s['company.name'] || '')}"></div>
        <div class="form-row"><label>NIP</label><input name="company.nip" value="${escapeHtml(s['company.nip'] || '')}"></div>
        <div class="form-row full"><label>Adres</label><input name="company.address" value="${escapeHtml(s['company.address'] || '')}"></div>
        <div class="form-row"><label>Stawka ryczałtu [%]</label><input name="tax.rate" type="number" step="0.01" value="${escapeHtml(s['tax.rate'] || '8.5')}"></div>
        <div class="form-row"><label>Dodatkowy podatek mies. [PLN]</label><input name="tax.koscielna" type="number" step="0.01" value="${escapeHtml(s['tax.koscielna'] || '0')}"></div>
        <div class="form-row"><label>Waluta</label><input name="currency" value="${escapeHtml(s['currency'] || 'PLN')}"></div>
        <div class="form-row"><label>Locale</label><input name="locale" value="${escapeHtml(s['locale'] || 'pl-PL')}"></div>
      </form>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Koszty właściciela</div><div class="ch-sub">zarządzanie i kredyty per nieruchomość</div></div></div>
      <form id="owner-cost-form" class="form-grid">
        <div class="form-row"><label>Koszty obowiązują od</label><input name="valid_from_period" pattern="\\d{4}-\\d{2}" placeholder="YYYY-MM" value="${escapeHtml(ownerCosts.valid_from_period || s['costs.valid_from_period'] || '2026-01')}"></div>
        <div class="form-row"><label>Zarządzanie / mies. [PLN]</label><input name="management_monthly" type="number" step="0.01" value="${escapeHtml(ownerCosts.management_monthly ?? s['cost.management.monthly'] ?? '0')}"></div>
        ${(ownerCosts.mortgages || [])
          .map(
            (row) => `
          <div class="form-row">
            <label>Rata kredytu: ${escapeHtml(row.property_name)} [PLN]</label>
            <input name="mortgage_${row.property_id}" data-property-id="${row.property_id}" type="number" step="0.01" value="${escapeHtml(row.amount ?? 0)}">
          </div>`,
          )
          .join('')}
        ${!(ownerCosts.mortgages || []).length ? `<div class="form-row full"><div class="hint">Dodaj nieruchomość, aby przypisać do niej ratę kredytu.</div></div>` : ''}
      </form>
    </div>

    <div class="gc">
      <div class="ch">
        <div><div class="ch-title">Powiadomienia SMS</div><div class="ch-sub">SMSPlanet · przypomnienia przed terminem i po terminie</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="tb-btn tb-ghost" id="sms-dry-run">Podgląd wysyłki</button>
          <button class="tb-btn tb-ghost" id="sms-sync-status">Sprawdź doręczenia</button>
          <button class="tb-btn tb-ghost" id="sms-test">Wyślij SMS testowy</button>
          <button class="tb-btn tb-primary" id="sms-run-now">Wyślij teraz</button>
        </div>
      </div>
      <form id="notif-form" class="form-grid">
        <div class="form-row"><label>Wysyłka aktywna</label><input name="enabled" type="checkbox" ${notificationSettings.enabled ? 'checked' : ''}></div>
        <div class="form-row"><label>Symulacja API bez wysyłki</label><input name="test_mode" type="checkbox" ${notificationSettings.test_mode ? 'checked' : ''}></div>
        <div class="form-row"><label>Nadawca</label><input name="sender" value="${escapeHtml(notificationSettings.sender || 'TEST')}"></div>
        <div class="form-row"><label>Godzina wysyłki</label><input name="send_time" type="time" value="${escapeHtml(notificationSettings.send_time || '09:30')}"></div>
        <div class="form-row"><label>Dni po terminie</label><input name="overdue_days" type="number" min="0" max="31" step="1" value="${escapeHtml(notificationSettings.overdue_days ?? 1)}"></div>
        <div class="form-row"><label>Przypomnienie przed terminem</label><input name="reminder_enabled" type="checkbox" ${notificationSettings.reminder_enabled ? 'checked' : ''}></div>
        <div class="form-row"><label>Dni przed terminem</label><input name="reminder_days_before_due" type="number" min="0" max="31" step="1" value="${escapeHtml(notificationSettings.reminder_days_before_due ?? 3)}"></div>
        <div class="form-row"><label>Numer testowy</label><input name="test_phone" value="${escapeHtml(notificationSettings.test_phone || '')}" placeholder="+48..."></div>
        <div class="form-row"><label>Bez polskich znaków</label><input name="clear_polish" type="checkbox" ${notificationSettings.clear_polish ? 'checked' : ''}></div>
        <div class="form-row"><label>Kanał transakcyjny</label><input name="transactional" type="checkbox" ${notificationSettings.transactional ? 'checked' : ''}></div>
        <div class="form-row full">
          <label>Treść SMS testowego</label>
          <textarea name="template_test" rows="2">${escapeHtml(notificationSettings.template_test || 'Test SMS PropertyApp: konfiguracja powiadomien dziala.')}</textarea>
        </div>
        <div class="form-row full">
          <label>Treść przypomnienia przed terminem</label>
          <textarea name="template_due_reminder" rows="3">${escapeHtml(notificationSettings.template_due_reminder || 'Przypomnienie: termin platnosci za {unit} ({period}) uplywa {due_date}. Kwota: {amount} zl.')}</textarea>
        </div>
        <div class="form-row full">
          <label>Treść przypomnienia po terminie</label>
          <textarea name="template_overdue" rows="3">${escapeHtml(notificationSettings.template_overdue || 'Przypomnienie: nie odnotowano platnosci za {unit} ({period}). Kwota: {amount} zl. Prosimy o uregulowanie.')}</textarea>
        </div>
        <div class="form-row full">
          <div class="hint">Token API jest czytany z env serwera: ${notificationSettings.token_configured ? 'skonfigurowany' : 'brak tokena'}. Zaznaczona symulacja sprawdza API bez fizycznej wysyłki SMS-a. Odznacz ją, zapisz i użyj „Wyślij SMS testowy”, aby dostać prawdziwą wiadomość. Zmienne w treści: {tenant}, {unit}, {property}, {period}, {due_date}, {amount}.</div>
        </div>
      </form>
      <div id="sms-preview" style="padding:0 24px 16px;font-size:12px;color:var(--t3)"></div>
      <div style="padding:0 24px 22px;overflow-x:auto">
        <table class="t">
          <thead><tr><th>Czas</th><th>Typ</th><th>Najemca</th><th>Lokal</th><th>Status</th><th>Próby</th><th>Treść</th><th>Błąd</th></tr></thead>
          <tbody>${
            (notificationLogs || [])
              .map(
                (log) => `
            <tr>
              <td class="mono">${escapeHtml(fmtDateTimeLocal(log.created_at))}</td>
              <td>${escapeHtml(notificationTypeLabel(log.type))}</td>
              <td>${escapeHtml(log.tenant_name || '—')}</td>
              <td>${escapeHtml(log.unit_code || log.unit_name || '—')}</td>
              <td>${chip(notificationStatusChip(log.status), notificationStatusLabel(log.status), log.status === 'sent' || log.status === 'delivered')}</td>
              <td class="mono">${Number(log.attempts || 0)}</td>
              <td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(log.message_text || '')}">${escapeHtml(log.message_text || '—')}</td>
              <td style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(log.error_message || '—')}</td>
            </tr>`,
              )
              .join('') || `<tr><td colspan="8">${emptyState('Brak historii SMS.')}</td></tr>`
          }</tbody>
        </table>
      </div>
    </div>

    <div class="gc automation-center">
      <div class="ch">
        <div><div class="ch-title">Bezpieczne automatyzacje AI</div><div class="ch-sub">AI i reguły tworzą propozycje — żadna wpłata ani wiadomość nie jest zatwierdzana bez Twojej decyzji</div></div>
        <button class="tb-btn tb-primary" id="automation-scan">Skanuj i zaproponuj</button>
      </div>
      <div class="automation-guardrails">
        <span>✓ biała lista akcji</span><span>✓ limit 50 akcji</span><span>✓ idempotencja</span><span>✓ jawna zgoda dla finansów</span>
      </div>
      <div class="automation-list">
        ${
          (automationData.proposals || [])
            .map(
              (
                proposal,
              ) => `<article class="automation-proposal ${proposal.risk_level === 'high' ? 'high-risk' : ''}">
              <div class="automation-risk">${chip(proposal.risk_level === 'high' ? 'chip-a' : 'chip-c', proposal.risk_level === 'high' ? 'Wymaga potwierdzenia' : 'Niskie ryzyko')}</div>
              <div><strong>${escapeHtml(proposal.summary)}</strong><small>${proposal.action_type === 'reconcile_bank' ? 'Uzgodnienie bankowe' : 'Utworzenie zadania'} · ${fmtDateTimeLocal(proposal.created_at)}</small></div>
              <div class="automation-actions"><button class="tb-btn tb-primary" data-automation-approve="${proposal.id}" data-automation-risk="${proposal.risk_level}">Zatwierdź</button><button class="tb-btn tb-ghost" data-automation-reject="${proposal.id}">Odrzuć</button></div>
            </article>`,
            )
            .join('') ||
          `<div class="automation-empty">${emptyState('Brak oczekujących propozycji.', 'Uruchom skan, aby znaleźć kończące się umowy, dokumenty i pewne dopasowania bankowe.')}</div>`
        }
      </div>
    </div>

    <div class="gc">
      <div class="ch">
        <div><div class="ch-title">AI aliasy</div><div class="ch-sub">własne nazwy dla nieruchomości, najemców i metryk</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="tb-btn tb-ghost" id="ai-alias-seed">Uzupełnij domyślne</button>
          <button class="tb-btn tb-primary" id="ai-alias-add">Dodaj alias</button>
        </div>
      </div>
      <div style="padding:0 24px 22px;overflow-x:auto">
        <table class="t">
          <thead><tr><th>Alias</th><th>Typ</th><th>Cel</th><th>Użycia</th><th></th></tr></thead>
          <tbody>${
            (aiAliases.aliases || [])
              .slice(0, 80)
              .map(
                (row) => `
            <tr>
              <td><b>${escapeHtml(row.alias)}</b><div class="muted mono">${escapeHtml(row.normalized_alias || '')}</div></td>
              <td>${escapeHtml(aiAliasTypeLabel(row.resolves_to_type))}</td>
              <td>${escapeHtml(row.target_label || row.resolves_to_value || row.resolves_to_id || '—')}</td>
              <td class="mono">${Number(row.use_count || 0)}</td>
              <td style="text-align:right"><button class="tb-btn tb-ghost" data-ai-alias-delete="${row.id}">Usuń</button></td>
            </tr>`,
              )
              .join('') || `<tr><td colspan="5">${emptyState('Brak aliasów AI.')}</td></tr>`
          }</tbody>
        </table>
        <div class="hint" style="margin-top:10px">Przykład: alias „moja baza” może wskazywać nieruchomość, a „kasa” metrykę „Przychód brutto z wpłat”.</div>
      </div>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Import danych z Excela</div><div class="ch-sub">ROZLICZENIA Z NAJEMCAMI.xlsx</div></div></div>
      <div style="padding:20px 24px">
        <input type="file" id="xlsx-file" accept=".xlsx,.xls" style="margin-bottom:12px;color:var(--t2)">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="tb-btn tb-ghost" id="btn-import-preview">Sprawdź import</button>
          <button class="tb-btn tb-primary" id="btn-do-import" ${importStatus.excel_import_enabled ? '' : 'disabled title="Import zapisu jest zablokowany na serwerze"'}>Importuj zapis</button>
        </div>
        <div id="import-preview" style="margin-top:12px;font-size:12px;color:var(--t3)"></div>
        <div style="margin-top:10px;font-size:11px;color:var(--t4)">
          Najpierw uruchom sprawdzenie. Zapis importu ${importStatus.excel_import_enabled ? 'jest włączony' : 'jest zablokowany'} po stronie API.
        </div>
      </div>
    </div>

    <div class="gc">
      <div class="ch"><div><div class="ch-title">Wersja i baza</div></div></div>
      <div style="padding:18px 24px;font-size:12px;color:var(--t3);font-family:var(--mono)">
        <div>Frontend: PropertyApp Nova v1.0 (dark)</div>
        <div id="dbinfo">DB: ładowanie…</div>
      </div>
    </div>`;

  document.getElementById('set-save').onclick = async () => {
    const form = document.getElementById('set-form');
    const out = {};
    for (const el of form.elements) if (el.name) out[el.name] = el.value;
    const costForm = document.getElementById('owner-cost-form');
    const mortgages = Array.from(costForm.querySelectorAll('[data-property-id]')).map((el) => ({
      property_id: Number(el.dataset.propertyId),
      amount: el.value,
    }));
    const ownerPayload = {
      valid_from_period: costForm.elements.valid_from_period.value,
      management_monthly: costForm.elements.management_monthly.value,
      mortgages,
    };
    const notifPayload = notificationPayload();
    try {
      await Api.put('/settings', out);
      await Api.put('/settings/owner-costs', ownerPayload);
      await Api.put('/notifications/settings', notifPayload);
      toast('Zapisano');
      render();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  document.getElementById('btn-import-preview').onclick = () =>
    previewExcelImport(document.getElementById('xlsx-file').files[0]);
  document.getElementById('btn-do-import').onclick = () =>
    doExcelImport(document.getElementById('xlsx-file').files[0]);
  document.getElementById('sms-dry-run').onclick = () => previewSmsNotifications();
  document.getElementById('sms-sync-status').onclick = () => syncSmsDeliveryStatuses();
  document.getElementById('sms-run-now').onclick = () => runSmsNotificationsNow();
  document.getElementById('sms-test').onclick = () => sendTestSms();
  document.getElementById('ai-alias-add').onclick = () => openAiAliasModal(aiAliases);
  document.getElementById('ai-alias-seed').onclick = () => seedAiAliases();
  document.querySelectorAll('[data-ai-alias-delete]').forEach((btn) => {
    btn.onclick = () => deleteAiAlias(btn.dataset.aiAliasDelete);
  });
  document.getElementById('automation-scan').onclick = async () => {
    const result = await Api.post('/automations/scan', {});
    toast(`Nowe propozycje: ${result.created}`);
    render();
  };
  document.querySelectorAll('[data-automation-approve]').forEach((button) => {
    button.onclick = () => {
      const highRisk = button.dataset.automationRisk === 'high';
      const approve = async () => {
        await Api.post(`/automations/${button.dataset.automationApprove}/approve`, { confirmed: highRisk });
        toast('Automatyzacja wykonana');
        render();
      };
      if (highRisk) {
        confirmDialog({
          title: 'Potwierdź operację finansową',
          message: 'Ta propozycja zmieni stan płatności. Operacja zostanie zapisana w historii audytowej.',
          onYes: approve,
        });
      } else approve();
    };
  });
  document.querySelectorAll('[data-automation-reject]').forEach((button) => {
    button.onclick = async () => {
      await Api.post(`/automations/${button.dataset.automationReject}/reject`, {});
      toast('Propozycja odrzucona', 'info');
      render();
    };
  });
  fetch('/health')
    .then((r) => r.json())
    .then((j) => {
      document.getElementById('dbinfo').textContent = `DB: ${j.db} (${j.tables} tabel)`;
    })
    .catch(() => {});
}

function aiAliasTypeLabel(type) {
  return { property: 'Nieruchomość', tenant: 'Najemca', metric: 'Metryka' }[type] || type || '—';
}
function aiAliasTargetOptions(data) {
  const c = (data && data.candidates) || {};
  return [
    ...(c.properties || []).map((p) => ({ value: `property:${p.id}`, label: `Nieruchomość · ${p.name}` })),
    ...(c.tenants || []).map((t) => ({ value: `tenant:${t.id}`, label: `Najemca · ${t.name}` })),
    ...(c.metrics || []).map((m) => ({ value: `metric:${m.key}`, label: `Metryka · ${m.label}` })),
  ];
}
function openAiAliasModal(data) {
  const options = aiAliasTargetOptions(data);
  if (!options.length) return toast('Brak celów dla aliasu', 'err');
  formModal({
    title: 'Dodaj alias AI',
    fields: [
      {
        name: 'alias',
        label: 'Alias',
        type: 'text',
        placeholder: 'np. moja baza, kasa, u Huberta',
        required: true,
        full: true,
      },
      { name: 'target', label: 'Cel', type: 'select', options, full: true },
    ],
    onSubmit: async ({ alias, target }) => {
      const [type, value] = String(target || '').split(':');
      const payload = { alias, resolves_to_type: type };
      if (type === 'metric') payload.resolves_to_value = value;
      else payload.resolves_to_id = Number(value);
      await Api.post('/assistant/aliases', payload);
      toast('Alias zapisany');
      render();
    },
  });
}
async function deleteAiAlias(id) {
  try {
    await Api.del(`/assistant/aliases/${id}`);
    toast('Alias usunięty');
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}
async function seedAiAliases() {
  try {
    const r = await Api.post('/assistant/aliases/seed', {});
    toast(`Aliasy domyślne: dodano ${r.added || 0}`);
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function notificationTypeLabel(type) {
  return (
    {
      due_reminder: 'Przed terminem',
      overdue: 'Po terminie',
      assistant_reminder: 'Ręczne przypomnienie',
      test: 'Test',
    }[type] ||
    type ||
    '—'
  );
}
function notificationStatusLabel(status) {
  return (
    {
      queued: 'Kolejka',
      simulated: 'Symulacja',
      sent: 'Wysłane',
      delivered: 'Dostarczone',
      failed: 'Błąd',
      skipped: 'Pominięte',
    }[status] ||
    status ||
    '—'
  );
}
function notificationStatusChip(status) {
  return (
    {
      queued: 'chip-n',
      simulated: 'chip-a',
      sent: 'chip-e',
      delivered: 'chip-e',
      failed: 'chip-r',
      skipped: 'chip-a',
    }[status] || 'chip-n'
  );
}
function notificationPayload() {
  const form = document.getElementById('notif-form');
  return {
    enabled: form.elements.enabled.checked,
    sender: form.elements.sender.value,
    send_time: form.elements.send_time.value,
    overdue_days: Number(form.elements.overdue_days.value || 1),
    reminder_enabled: form.elements.reminder_enabled.checked,
    reminder_days_before_due: Number(form.elements.reminder_days_before_due.value || 3),
    test_mode: form.elements.test_mode.checked,
    test_phone: form.elements.test_phone.value,
    clear_polish: form.elements.clear_polish.checked,
    transactional: form.elements.transactional.checked,
    template_test: form.elements.template_test.value,
    template_due_reminder: form.elements.template_due_reminder.value,
    template_overdue: form.elements.template_overdue.value,
  };
}
async function saveNotificationSettingsOnly() {
  await Api.put('/notifications/settings', notificationPayload());
}
async function previewSmsNotifications() {
  const target = document.getElementById('sms-preview');
  target.textContent = 'Sprawdzam kandydatów…';
  try {
    await saveNotificationSettingsOnly();
    const r = await Api.post('/notifications/run', { type: 'all', dry_run: true });
    target.innerHTML =
      r.candidates && r.candidates.length
        ? `<div><b>Kandydaci:</b> ${r.candidates.length}</div><div style="margin-top:6px">${r.candidates
            .slice(0, 8)
            .map(
              (x) =>
                `${notificationTypeLabel(x.type)} · ${escapeHtml(x.tenant || '—')} · ${escapeHtml(x.unit || '—')} · ${escapeHtml(x.message || '')}`,
            )
            .join('<br>')}</div>`
        : '<div>Brak kandydatów do wysyłki dzisiaj.</div>';
  } catch (e) {
    target.textContent = '';
    toast(e.message, 'err');
  }
}
async function runSmsNotificationsNow() {
  const target = document.getElementById('sms-preview');
  target.textContent = 'Wysyłam…';
  try {
    await saveNotificationSettingsOnly();
    const r = await Api.post('/notifications/run', { type: 'all', dry_run: false });
    toast(
      `SMS: wysłane ${r.sent}, symulacje ${r.simulated || 0}, błędy ${r.failed}, pominięte ${r.skipped}`,
      r.failed ? 'err' : 'ok',
      4500,
    );
    render();
  } catch (e) {
    target.textContent = '';
    toast(e.message, 'err');
  }
}
async function syncSmsDeliveryStatuses() {
  try {
    const r = await Api.post('/notifications/sync-status', { limit: 20 });
    toast(
      `Doręczenia: sprawdzone ${r.checked}, dostarczone ${r.delivered}, błędy ${r.failed}, oczekujące ${r.pending}`,
      r.failed ? 'err' : 'ok',
      5000,
    );
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}
async function sendTestSms() {
  try {
    await saveNotificationSettingsOnly();
    const phone = document.getElementById('notif-form').elements.test_phone.value;
    const message = document.getElementById('notif-form').elements.template_test.value;
    const r = await Api.post('/notifications/test', { phone, message });
    toast(r.status === 'simulated' ? 'Symulacja API OK, SMS nie został wysłany' : 'SMS testowy wysłany');
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function previewExcelImport(file) {
  if (!file) return toast('Wybierz plik xlsx', 'err');
  const fd = new FormData();
  fd.append('file', file);
  const target = document.getElementById('import-preview');
  target.textContent = 'Sprawdzam plik…';
  try {
    const r = await Api.upload('/import/excel/dry-run', fd);
    const sample = (r.periods || [])
      .slice(0, 6)
      .map((p) => `${p.period}: ${p.payments} wpłat`)
      .join(' · ');
    target.innerHTML = `
      <div><b>Dry-run OK:</b> ${r.periods?.length || r.periods_count || r.periods || 0} okresów, ${r.payments || 0} płatności, ${r.uniqueTenants || 0} najemców.</div>
      <div>Częściowe: ${r.partialPayments || 0}, bez wpłat: ${r.unpaidPayments || 0}, pominięte nagłówki: ${r.missingHdr || 0}.</div>
      ${sample ? `<div style="margin-top:4px;color:var(--t4)">${escapeHtml(sample)}</div>` : ''}
    `;
    toast('Dry-run importu OK');
  } catch (e) {
    target.textContent = '';
    toast(e.message, 'err');
  }
}

async function doExcelImport(file) {
  if (!file) return toast('Wybierz plik xlsx', 'err');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('confirm', 'IMPORT_EXCEL');
  toast('Importuję…', 'info', 1500);
  try {
    const r = await Api.upload('/import/excel', fd);
    toast(`Import OK: ${r.periods} okresów, ${r.payments} płatności`, 'ok', 4500);
    render();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ═══════════════════════ INIT ═══════════════════════
function init() {
  bindLegacyClickActions(document);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        hydrateInlineStyles(node);
        bindLegacyClickActions(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('#nav .nav-item').forEach((it) => {
    it.onclick = () => navigate(it.dataset.view);
  });
  const footer = document.querySelector('.rail-footer');
  if (footer) footer.onclick = () => openAccountPanel();
  loadAuth();
  createMobileNav();
  bindCommandBar();
  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = 'dashboard';
  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
