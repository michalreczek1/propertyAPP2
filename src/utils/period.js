'use strict';
/** Pomocnicze funkcje do obsługi okresów (YYYY-MM) i polskich miesięcy. */

const PL_MONTHS = [
  'styczeń','luty','marzec','kwiecień','maj','czerwiec',
  'lipiec','sierpień','wrzesień','październik','listopad','grudzień'
];

const PL_MONTHS_NORM = PL_MONTHS.map(normalize);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // diakrytyki
    .replace(/\s+/g, ' ')
    .trim();
}

/** np. "kwiecien 2025" / "kwiecień 2026" / "styczeń  jak grudzień 2023 r." → { year, month, period } */
function parsePolishMonthYear(text) {
  if (!text) return null;
  const n = normalize(text);
  const yearMatch = n.match(/(?:^|[^\d])(20\d{2})(?=$|[^\d])/);
  if (!yearMatch) return null;
  const year = +yearMatch[1];
  for (let i = 0; i < PL_MONTHS_NORM.length; i++) {
    if (n.includes(PL_MONTHS_NORM[i])) {
      const month = i + 1;
      return {
        year,
        month,
        period: `${year}-${String(month).padStart(2, '0')}`,
      };
    }
  }
  return null;
}

/** "2026-04" → { year:2026, month:4 } */
function parsePeriod(period) {
  if (!period || typeof period !== 'string') return null;
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const month = +m[2];
  if (month < 1 || month > 12) return null;
  return { year: +m[1], month };
}

/** Formatuje period i dzień jako "YYYY-MM-DD" (ostrożnie z 31 lutego). */
function dueDate(period, day) {
  const p = parsePeriod(period);
  if (!p || !day) return null;
  const last = new Date(p.year, p.month, 0).getDate();   // ostatni dzień miesiąca
  const d = Math.min(+day || last, last);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function previousPeriod(period) {
  const p = parsePeriod(period); if (!p) return null;
  const d = new Date(p.year, p.month - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function periodLabel(period) {
  const p = parsePeriod(period); if (!p) return period;
  return `${PL_MONTHS[p.month - 1]} ${p.year}`;
}

module.exports = {
  PL_MONTHS, normalize,
  parsePolishMonthYear, parsePeriod,
  dueDate, currentPeriod, previousPeriod, periodLabel,
  todayLocalISO,
};
