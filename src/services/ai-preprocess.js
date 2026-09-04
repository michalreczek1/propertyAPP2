'use strict';

const { parsePolishMonthYear, periodLabel, todayLocalISO } = require('../utils/period');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[łŁ]/g, 'l')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparableToken(value) {
  return normalizeText(value).replace(/(skiego|ckiego|owej|ego|ami|ach|owi|em|ej|ie|ow|ów|a|e|y|i)$/i, '');
}

function matchTokens(value) {
  const stop = new Set([
    'czy',
    'ile',
    'ilu',
    'podaj',
    'sume',
    'suma',
    'razem',
    'mialem',
    'mial',
    'najemca',
    'najemcy',
    'najemcow',
    'najemc',
    'zeszly',
    'zeszlym',
    'poprzedni',
    'poprzednim',
    'roku',
    'rok',
    'tym',
    'ten',
    'tego',
    'miesiac',
    'miesiacu',
    'platnosc',
    'platnosci',
    'podatek',
    'podatku',
    'dochod',
    'dochodow',
    'przychod',
    'przychodow',
    'koszt',
    'koszty',
    'netto',
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .map(comparableToken)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function tokensOverlap(left, right) {
  const a = matchTokens(left);
  const b = matchTokens(right);
  if (!a.length || !b.length) return 0;
  let score = 0;
  for (const leftToken of a) {
    for (const rightToken of b) {
      if (leftToken === rightToken) score += 3;
      else if (
        leftToken.length >= 4 &&
        rightToken.length >= 4 &&
        (leftToken.includes(rightToken) || rightToken.includes(leftToken))
      )
        score += 1;
    }
  }
  return score;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function shiftPeriod(period, delta) {
  const [year, month] = String(period || todayLocalISO().slice(0, 7))
    .split('-')
    .map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodsBetween(start, end) {
  if (!/^\d{4}-\d{2}$/.test(String(start || '')) || !/^\d{4}-\d{2}$/.test(String(end || ''))) return [];
  const out = [];
  let cur = start;
  while (cur <= end && out.length < 600) {
    out.push(cur);
    cur = shiftPeriod(cur, 1);
  }
  return out;
}

function earlierPeriod(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left) <= String(right) ? left : right;
}

function wantsFullYear(text) {
  return includesAny(text, [
    'caly rok',
    'calym roku',
    'za caly',
    'pelny rok',
    'pelnym roku',
    'do konca roku',
    'prognoza',
    'prognoze',
    'prognozowany',
    'planowany',
    'ile zarobie',
    'ile zarobimy',
    'oczekiwany',
    'oczekiwane',
    'naleznosci',
    'co powinno wplynac',
  ]);
}

function yearRange(year, fallback, text, mode = 'year') {
  const fallbackYear = Number(String(fallback).slice(0, 4));
  const start = `${year}-01`;
  const requestedEnd = `${year}-12`;
  const capToCurrent = year === fallbackYear && !wantsFullYear(text);
  const end = capToCurrent ? earlierPeriod(fallback, requestedEnd) : requestedEnd;
  const label = capToCurrent ? `${year} do ${periodLabel(end)}` : `${year}`;
  return {
    mode,
    year,
    start,
    end,
    requested_end: requestedEnd,
    capped_to_current: capToCurrent,
    label,
    periods: periodsBetween(start, end),
    source: 'rule',
  };
}

function monthEnd(period) {
  const [year, month] = String(period).split('-').map(Number);
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function periodFromMessage(message, fallbackPeriod) {
  const direct = String(message || '').match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (direct) return direct[0];
  const parsed = parsePolishMonthYear(message);
  if (parsed) return parsed.period;
  const text = normalizeText(message);
  const months = [
    ['styczen', '01'],
    ['luty', '02'],
    ['marzec', '03'],
    ['kwiecien', '04'],
    ['maj', '05'],
    ['czerwiec', '06'],
    ['lipiec', '07'],
    ['sierpien', '08'],
    ['wrzesien', '09'],
    ['pazdziernik', '10'],
    ['listopad', '11'],
    ['grudzien', '12'],
  ];
  const year = (text.match(/\b(20\d{2})\b/) || [null, String(new Date().getFullYear())])[1];
  const hit = months.find(([name]) => text.includes(name));
  if (hit) return `${year}-${hit[1]}`;
  return fallbackPeriod;
}

function parsePeriodRange(message, fallbackPeriod, bounds = {}) {
  const text = normalizeText(message);
  const fallback = fallbackPeriod || todayLocalISO().slice(0, 7);
  const fallbackYear = Number(String(fallback).slice(0, 4));
  const explicitYear = String(message || '').match(/\b(20\d{2})\b/);
  if (includesAny(text, ['od poczatku roku', 'od stycznia'])) {
    const year = explicitYear ? Number(explicitYear[1]) : fallbackYear;
    const range = yearRange(year, fallback, text, 'year_to_date');
    return {
      ...range,
      label:
        year === fallbackYear
          ? `od początku ${year} r. do ${periodLabel(range.end)}`
          : `od początku ${year} r.`,
    };
  }
  if (
    includesAny(text, [
      'od poczatku',
      'od startu',
      'od poczatku danych',
      'caly okres',
      'wszystkie lata',
      'wszystkich danych',
    ])
  ) {
    const start = bounds.min || `${fallbackYear}-01`;
    const end = bounds.max || fallback;
    return {
      mode: 'all',
      start,
      end,
      label: 'od początku danych',
      periods: periodsBetween(start, end),
      source: 'rule',
    };
  }
  if (includesAny(text, ['ostatnie 6 miesiecy', 'ostatnich 6 miesiecy'])) {
    const start = shiftPeriod(fallback, -5);
    return {
      mode: 'rolling',
      start,
      end: fallback,
      label: `ostatnie 6 miesięcy (${periodLabel(start)} - ${periodLabel(fallback)})`,
      periods: periodsBetween(start, fallback),
      source: 'rule',
    };
  }
  if (includesAny(text, ['ostatnie 12 miesiecy', 'ostatnich 12 miesiecy'])) {
    const start = shiftPeriod(fallback, -11);
    return {
      mode: 'rolling',
      start,
      end: fallback,
      label: `ostatnie 12 miesięcy (${periodLabel(start)} - ${periodLabel(fallback)})`,
      periods: periodsBetween(start, fallback),
      source: 'rule',
    };
  }
  const directPeriod = String(message || '').match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (directPeriod) {
    const period = directPeriod[0];
    return {
      mode: 'period',
      period,
      start: period,
      end: period,
      label: periodLabel(period),
      periods: [period],
      source: 'rule',
    };
  }
  const monthPeriod = parsePolishMonthYear(message);
  if (monthPeriod) {
    const period = monthPeriod.period;
    return {
      mode: 'period',
      period,
      start: period,
      end: period,
      label: periodLabel(period),
      periods: [period],
      source: 'rule',
    };
  }
  if (
    explicitYear ||
    includesAny(text, [
      'w tym roku',
      'ten rok',
      'biezacy rok',
      'obecny rok',
      'aktualny rok',
      'w zeszlym roku',
      'zeszlym roku',
      'poprzedni rok',
      'poprzednim roku',
    ])
  ) {
    const year = explicitYear
      ? Number(explicitYear[1])
      : includesAny(text, ['w zeszlym roku', 'zeszlym roku', 'poprzedni rok', 'poprzednim roku'])
        ? fallbackYear - 1
        : fallbackYear;
    return yearRange(year, fallback, text, 'year');
  }
  if (includesAny(text, ['poprzedni miesiac', 'zeszly miesiac'])) {
    const period = shiftPeriod(fallback, -1);
    return {
      mode: 'period',
      period,
      start: period,
      end: period,
      label: periodLabel(period),
      periods: [period],
      source: 'rule',
    };
  }
  const period = periodFromMessage(message, fallback);
  return {
    mode: 'period',
    period,
    start: period,
    end: period,
    label: periodLabel(period),
    periods: [period],
    source: 'rule',
  };
}

function cleanEntityName(value) {
  return String(value || '')
    .replace(/[?!.:,;]+/g, ' ')
    .replace(/mar[zż][aęey]/gi, ' ')
    .replace(/zarobi[łl]e[msś]?|zarobile[ms]?/gi, ' ')
    .replace(/najwi[eę]ksz[aąey]?|nieruchomo[śs][cć]i?|kt[oó]ra|ktora/gi, ' ')
    .replace(
      /\b(czy|ile|ilu|jak|jaka|jaki|jakie|jest|liczysz|liczyc|liczy[cć]|podaj|mia[łl]em|sprawd[zź]|podsumuj|poka[zż]|status|dla|do|za|z|ze|na|w|przy)\b/gi,
      ' ',
    )
    .replace(
      /\b(ten|ta|to|tym|roku|rok|miesi[aą]cu|miesi[aą]c|poprzedni|zesz[łl]y|bie[zż][aą]cy|obecny|aktualny|od|pocz[aą]tku|danych|ca[łl]y|okres|ostatnie|ostatnich)\b/gi,
      ' ',
    )
    .replace(/\b(20\d{2}-\d{2}|20\d{2})\b/g, ' ')
    .replace(
      /\b(stycz[eńn]|styczniu|luty|lutym|marzec|marcu|kwiecien|kwiecie[nń]|kwietniu|maj|maju|czerwiec|czerwcu|lipiec|lipcu|sierpien|sierpie[nń]|sierpniu|wrzesien|wrzesie[nń]|wrzesniu|wrze[śs]niu|pazdziernik|pa[zź]dziernik|pa[zź]dzierniku|listopad|listopadzie|grudzien|grudzie[nń]|grudniu)\b/gi,
      ' ',
    )
    .replace(
      /\b(suma|sum[eę]|razem|dochod[oó]w?|przychod[oó]w?|wp[łl]yw\w*|wp[łl]at\w*|zysk|zarobi[łl]e[msś]?|zarobile[ms]?|netto|koszt[oó]w?|mar[zż]a|mar[zż][eęy]|zap[łl]aci[łl]a?|zap[łl]acili|zap[łl]acon\w*|op[łl]aci[łl]a?|wp[łl]aci[łl]a?|wp[łl]acili|p[łl]atno[śs][ćc]|p[łl]atno[śs]ci|najemc[oó]w|najemcy|najemca|najmu|brakuje|brakuj[aą]c\w*|podatek|podatku)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPropertySubject(message) {
  const raw = String(message || '').trim();
  const hit = raw.match(
    /\b(?:z|ze|na|przy|dla|w)\s+(.+?)(?:\s+\b(?:w|we|za|od)\b\s+(?:tym|zesz[łl]ym|poprzednim|20\d{2}|pocz[aą]tku)|[?.,;:]|$)/i,
  );
  const candidate = cleanEntityName(hit ? hit[1] : raw);
  return candidate || cleanEntityName(raw);
}

function extractTenantSubject(message) {
  const raw = String(message || '').trim();
  const action =
    /\b(?:zap[łl]aci[łl]a?|zap[łl]acili|op[łl]aci[łl]a?|wp[łl]aci[łl]a?|wp[łl]acili|zalega|winien|wisi)\b/i;
  const parts = raw.split(action);
  const before = cleanEntityName(parts[0] || '');
  const after = cleanEntityName(parts.slice(1).join(' ') || '');
  return before || after || cleanEntityName(raw);
}

module.exports = {
  cleanEntityName,
  comparableToken,
  extractPropertySubject,
  extractTenantSubject,
  includesAny,
  matchTokens,
  monthEnd,
  normalizeText,
  parsePeriodRange,
  periodFromMessage,
  periodsBetween,
  shiftPeriod,
  tokensOverlap,
};
