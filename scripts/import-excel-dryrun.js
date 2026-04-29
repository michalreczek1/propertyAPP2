#!/usr/bin/env node
'use strict';
/**
 * DRY-RUN: parsuje xlsx i wypisuje co zaimportowałby do bazy,
 * BEZ żadnego zapisu (nie dotyka better-sqlite3, nie tworzy DB).
 *
 * Sens: zweryfikować poprawność parsera offsetów i nazw kolumn
 * na rzeczywistym pliku, zanim odpalimy `npm run import`.
 *
 * Użycie: node scripts/import-excel-dryrun.js [ścieżka.xlsx] [okres-filter np. 2025]
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// inline: te same funkcje co w utils/period.js (żeby nie ładować db.js)
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const PL_MONTHS = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
const PL_MONTHS_NORM = PL_MONTHS.map(normalize);

function parsePolishMonthYear(text) {
  if (!text) return null;
  const n = normalize(text);
  const ym = n.match(/(20\d{2})/);
  if (!ym) return null;
  const year = +ym[1];
  for (let i = 0; i < PL_MONTHS_NORM.length; i++) {
    if (n.includes(PL_MONTHS_NORM[i])) {
      return { year, month: i+1, period: `${year}-${String(i+1).padStart(2,'0')}` };
    }
  }
  return null;
}

const TENANT_ALIASES = {
  'pys':'Pyś','ptyts':'Pyś','gajali':'Gajali','gojali':'Gajali',
  'kluczynski':'Kluczyński','krzyzaniak':'Krzyżaniak',
  'lisiecki':'Lisiecki','liśiecki':'Lisiecki',
};
function canonName(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const firstPart = s.split('/')[0].trim();
  const key = normalize(firstPart);
  return TENANT_ALIASES[key] || firstPart;
}

function asNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g,'').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findCol(row, fragments) {
  if (!Array.isArray(fragments)) fragments = [fragments];
  for (let i = 0; i < row.length; i++) {
    const c = row[i]; if (c == null) continue;
    const n = normalize(c);
    for (const f of fragments) if (n.includes(f)) return i;
  }
  return -1;
}

function rowFirstNonEmpty(row) {
  for (const c of row) if (c != null && String(c).trim() !== '') return c;
  return null;
}

function sheetToMatrix(ws) {
  return XLSX.utils.sheet_to_json(ws, { header:1, defval:null, blankrows:true });
}

function importMonthSection(matrix, headerRowIdx, period) {
  let cols = null, tableRow = -1;
  for (let r = headerRowIdx; r < Math.min(headerRowIdx + 5, matrix.length); r++) {
    const row = matrix[r] || [];
    const idx = findCol(row, ['dane os']);
    if (idx >= 0) {
      tableRow = r;
      cols = {
        name: idx,
        due_day:  findCol(row, ['do kiedy']),
        total:    findCol(row, ['przelew','wplata','wpłata']),
        rent:     findCol(row, ['czynsz']),
        media:    findCol(row, ['zaliczki na media','zaliczki']),
        other:    findCol(row, ['inne oplaty','inne op']),
        contract: findCol(row, ['umowa do']),
      };
      break;
    }
  }
  if (!cols) return { ok:false, reason:'no_table_header' };
  const noCol = cols.name - 1;
  const tenants = [];
  let countedTenants = 0;
  for (let r = tableRow + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const noVal = noCol >= 0 ? row[noCol] : null;
    const nameVal = row[cols.name];
    const due  = asNumber(row[cols.due_day]);
    const total= asNumber(row[cols.total]);
    const rent = asNumber(row[cols.rent]);
    const media= asNumber(row[cols.media]);
    const isEmpty = (noVal==null && nameVal==null && total==null && rent==null);
    if (isEmpty) { if (countedTenants > 0) break; continue; }
    const roomNo = asNumber(noVal);
    const name = canonName(nameVal);
    if (!name || !roomNo) continue;
    if (roomNo > 10) break;
    countedTenants++;
    tenants.push({ roomNo, name, due, total, rent, media });
  }

  // sumaryczna
  let summary = null;
  let summaryRow = -1, hdr = null;
  for (let r = tableRow + 1; r < Math.min(tableRow + 25, matrix.length); r++) {
    const row = matrix[r] || [];
    const dlaMnieIdx = findCol(row, ['dla mnie']);
    const czynszIdx  = findCol(row, ['czynsz', 'przelewy']);
    if (dlaMnieIdx >= 0 && czynszIdx >= 0) {
      hdr = {
        czynsz: czynszIdx,
        marek: findCol(row, ['marek','a. wize','wize']),
        dla_mnie: dlaMnieIdx,
        media_adv: findCol(row, ['zaliczki']),
        media_paid: findCol(row, ['zaplacone media','zapłacone']),
        media_left: findCol(row, ['zostalo','zostało']),
        penalties: findCol(row, ['kary']),
        total: findCol(row, ['suma']),
      };
      summaryRow = r + 1;
      break;
    }
  }
  if (summaryRow > 0 && summaryRow < matrix.length) {
    const v = matrix[summaryRow] || [];
    summary = {
      czynsz_total: asNumber(v[hdr.czynsz]),
      marek_total:  asNumber(v[hdr.marek]),
      dla_mnie:     asNumber(v[hdr.dla_mnie]),
      media_adv:    asNumber(v[hdr.media_adv]),
      media_paid:   asNumber(v[hdr.media_paid]),
      media_left:   asNumber(v[hdr.media_left]),
      penalties:    asNumber(v[hdr.penalties]),
      total:        asNumber(v[hdr.total]),
      podatek: null, podatek_koscielna: null, podatek_suma: null,
    };
    for (let r = summaryRow; r < Math.min(summaryRow + 8, matrix.length); r++) {
      const row = matrix[r] || [];
      const first = String(rowFirstNonEmpty(row) || '').toLowerCase();
      let n = null;
      for (let c = 0; c < row.length; c++) {
        const x = asNumber(row[c]);
        if (x != null && String(row[c]).trim() !== first) { n = x; break; }
      }
      if (first.includes('podatek')) summary.podatek = n;
      else if (first.includes('koscielna') || first.includes('kościelna')) summary.podatek_koscielna = n;
      else if (first === 'suma' || first.startsWith('suma')) summary.podatek_suma = n;
    }
    if (summary.podatek_suma == null) {
      summary.podatek_suma = (summary.podatek || 0) + (summary.podatek_koscielna || 0) || null;
    }
  }
  return { ok:true, period, tenants, summary };
}

function run(filePath, filter, opts = {}) {
  const quiet = !!opts.quiet;
  const log = (...args) => { if (!quiet) console.log(...args); };
  if (!fs.existsSync(filePath)) throw new Error('Brak pliku: ' + filePath);
  const wb = XLSX.readFile(filePath);

  const stats = { sheets:0, periods:0, payments:0, summaries:0, missingHdr:0, partialPayments:0, unpaidPayments:0 };
  const allFindings = [];

  for (const sheetName of wb.SheetNames) {
    const matrix = sheetToMatrix(wb.Sheets[sheetName]);
    stats.sheets++;
    log(`\n══ Arkusz "${sheetName}" — ${matrix.length} wierszy`);

    for (let r = 0; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const first = rowFirstNonEmpty(row);
      if (!first || typeof first === 'number') continue;
      const parsed = parsePolishMonthYear(first);
      if (!parsed) continue;
      if (filter && !parsed.period.startsWith(filter)) continue;

      const result = importMonthSection(matrix, r, parsed.period);
      if (!result.ok) {
        stats.missingHdr++;
        log(`  ✗ ${parsed.period} (wiersz ${r}): ${result.reason}`);
        continue;
      }
      stats.periods++;
      stats.payments += result.tenants.length;
      stats.partialPayments += result.tenants.filter(t => (t.total || 0) > 0 && (t.total || 0) < ((t.rent || 0) + (t.media || 0))).length;
      stats.unpaidPayments += result.tenants.filter(t => !(t.total > 0)).length;
      if (result.summary) stats.summaries++;
      allFindings.push(result);

      log(`  • ${parsed.period}: ${result.tenants.length} najemców` +
        (result.summary ? `, summary OK (czynsz=${result.summary.czynsz_total}, dla_mnie=${result.summary.dla_mnie}, total=${result.summary.total}, podatek=${result.summary.podatek})` : ', BEZ summary'));
      for (const t of result.tenants) {
        log(`      P${t.roomNo}  ${t.name.padEnd(15)}  due=${t.due ?? '–'}  rent=${t.rent ?? 0}  media=${t.media ?? 0}  total=${t.total ?? 0}`);
      }
    }
  }

  log('\n══════ Podsumowanie DRY-RUN ══════');
  log(`  Arkuszy:          ${stats.sheets}`);
  log(`  Okresów:          ${stats.periods}`);
  log(`  Płatności (rzędy):${stats.payments}`);
  log(`  Sum miesięcznych: ${stats.summaries}`);
  log(`  Pominiętych (no_table_header): ${stats.missingHdr}`);

  // sanity: unikalne najemcy w pliku
  const namesSet = new Set();
  for (const f of allFindings) for (const t of f.tenants) namesSet.add(t.name);
  const names = [...namesSet].sort((a, b) => a.localeCompare(b, 'pl'));
  log(`  Unikalnych najemców: ${namesSet.size}`);
  log(`  Lista: ${names.join(', ')}`);
  return {
    ...stats,
    uniqueTenants: names.length,
    tenants: names,
    periods: allFindings.map(f => ({
      period: f.period,
      payments: f.tenants.length,
      partialPayments: f.tenants.filter(t => (t.total || 0) > 0 && (t.total || 0) < ((t.rent || 0) + (t.media || 0))).length,
      unpaidPayments: f.tenants.filter(t => !(t.total > 0)).length,
      hasSummary: !!f.summary,
      rentTotal: f.tenants.reduce((s, t) => s + (t.rent || 0), 0),
      mediaTotal: f.tenants.reduce((s, t) => s + (t.media || 0), 0),
      paidTotal: f.tenants.reduce((s, t) => s + (t.total || 0), 0),
    })),
  };
}

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'ROZLICZENIA Z NAJEMCAMI.xlsx');
  const filter = process.argv[3] || null;
  try { run(file, filter); }
  catch (e) { console.error('Błąd:', e.message); process.exit(1); }
}

module.exports = { run };
