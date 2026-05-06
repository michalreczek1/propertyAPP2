#!/usr/bin/env node
'use strict';
/**
 * Import "ROZLICZENIA Z NAJEMCAMI.xlsx" → SQLite.
 *
 * Strategia:
 *  - dla każdego arkusza-roku iterujemy wiersze,
 *  - rozpoznajemy nagłówek miesiąca po polskiej nazwie + roku,
 *  - bezpośrednio pod nim szukamy wiersza z 'dane os.' aby wyznaczyć offsety kolumn,
 *  - następne wiersze (pokój 1..6) to wpisy najemców → payments,
 *  - dolny blok ('Czynsz | Marek | Dla mnie | ...') → monthly_summary + 'Marek' jako osobny payment dla Królewskiej,
 *  - 'Podatek:' / 'kościelna' / 'suma' → monthly_summary.podatek*.
 *
 *  Idempotentny: payments.UNIQUE(period, unit_id, tenant_id) → re-import nadpisuje.
 *  monthly_summary.period jest PK → upsert.
 *
 *  Użycie: node scripts/import-excel.js [ścieżka.xlsx]
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('@e965/xlsx');
const db = require('../src/db');
const { parsePolishMonthYear, dueDate, normalize } = require('../src/utils/period');

// ── stałe mapowania ─────────────────────────────────
const TENANT_ALIASES = {
  // klucz znormalizowany → kanoniczna forma
  // (klucz to wynik normalize() — bez wielkich liter, ze ściągniętymi diakrytykami
  //  Unicode jak akcenty łączone, ale ł/ś/ż zostają jako same z siebie)
  'pys': 'Pyś',
  'gajali': 'Gajali',
  'gojali': 'Gajali',
  'kluczynski': 'Kluczyński',
  'krzyzaniak': 'Krzyżaniak',
  'lisiecki': 'Lisiecki',
  'liśiecki': 'Lisiecki',
};

const PALETTE = [
  '#e1f5ee/#085041','#e6f1fb/#0c447c','#faeeda/#633806','#eeedfe/#3c3489',
  '#fbeaf0/#72243e','#eaf3de/#27500a','#faece7/#712b13','#e8eaf0/#374151',
];

function canonName(raw) {
  if (!raw) return null;
  // odetnij białe znaki i wybierz pierwszy człon przed "/" — w komórkach typu
  // "Brzeska/kluczynski" oznacza zmianę najemcy w trakcie miesiąca; do payments
  // bierzemy tego, który był na początku okresu.
  const s = String(raw).trim();
  if (!s) return null;
  const firstPart = s.split('/')[0].trim();
  const key = normalize(firstPart);
  return TENANT_ALIASES[key] || firstPart;
}

function pickColor(idx) { return PALETTE[idx % PALETTE.length]; }

// ── helpers do XLSX ─────────────────────────────────
function sheetToMatrix(ws) {
  // Zwraca tablicę tablic z header:1, defval:null
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });
}

function asNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// znajdź indeks kolumny w wierszu którego nazwa po normalizacji zawiera dany fragment
function findCol(row, fragments) {
  if (!Array.isArray(fragments)) fragments = [fragments];
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c == null) continue;
    const n = normalize(c);
    for (const f of fragments) if (n.includes(f)) return i;
  }
  return -1;
}

function rowFirstNonEmpty(row) {
  for (const c of row) if (c != null && String(c).trim() !== '') return c;
  return null;
}

function looksLikeMonthHeader(value) {
  return !!parsePolishMonthYear(value);
}

function normalizeTaxValue(value) {
  const n = asNumber(value);
  if (n == null) return null;
  // Arkusze historyczne maja czasem wartosc groszowa bez separatora,
  // np. 48621 zamiast 486,21. Miesieczny podatek nie powinien miec
  // pieciocyfrowych wartosci, wiec chronimy import przed takim zapisem.
  return n > 10000 ? n / 100 : n;
}

// ── import sekcji miesięcznej ───────────────────────

// Mapuje najemcę po nazwisku do (tenant_id, unit_id).
// Jeśli najemcy nie ma — tworzy go i przypina do unit-u w danej property.
function ensureTenant(name, color) {
  const exist = db.prepare(`SELECT id FROM tenants WHERE LOWER(name) = LOWER(?)`).get(name);
  if (exist) return exist.id;
  const r = db.prepare(`
    INSERT INTO tenants (name, status, avatar_color)
    VALUES (?, 'active', ?)
  `).run(name, color);
  return r.lastInsertRowid;
}

function findUnit(propertyName, code) {
  return db.prepare(`
    SELECT u.id FROM units u JOIN properties p ON p.id = u.property_id
    WHERE p.name = ? AND u.code = ?
  `).get(propertyName, code);
}

// W aktualnej bazie pokoje P1..P6 sa w nieruchomosci "Os. B. Chrobrego 28/21".
function unitForRoomNo(roomNo) {
  const code = `P${roomNo}`;
  return findUnit('Os. B. Chrobrego 28/21', code);
}

function unitForMarek() { return findUnit('Kościelna 30/21', 'KR'); }

function paymentStatus(totalPaid, expectedTotal) {
  const paid = Number(totalPaid) || 0;
  const expected = Number(expectedTotal) || 0;
  if (paid <= 0) return 'pending';
  if (expected > 0 && paid < expected) return 'partial';
  return 'paid';
}

const upsertPayment = db.prepare(`
  INSERT INTO payments (period, tenant_id, unit_id, due_day, due_date, paid_date,
                        rent_amount, media_amount, other_amount, total_paid, status, notes, source)
  VALUES (@period, @tenant_id, @unit_id, @due_day, @due_date, @paid_date,
          @rent_amount, @media_amount, @other_amount, @total_paid, @status, @notes, 'excel')
  ON CONFLICT(period, unit_id, tenant_id) WHERE unit_id IS NOT NULL AND tenant_id IS NOT NULL DO UPDATE SET
    due_day     = excluded.due_day,
    due_date    = excluded.due_date,
    paid_date   = COALESCE(excluded.paid_date, payments.paid_date),
    rent_amount = excluded.rent_amount,
    media_amount= excluded.media_amount,
    other_amount= excluded.other_amount,
    total_paid  = excluded.total_paid,
    status      = excluded.status,
    notes       = excluded.notes,
    source      = 'excel'
`);

const upsertSummary = db.prepare(`
  INSERT INTO monthly_summary (period, czynsz_total, marek_total, dla_mnie,
                               media_advance_total, media_paid, media_left,
                               penalties, total, podatek, podatek_koscielna, podatek_suma)
  VALUES (@period, @czynsz_total, @marek_total, @dla_mnie,
          @media_advance_total, @media_paid, @media_left,
          @penalties, @total, @podatek, @podatek_koscielna, @podatek_suma)
  ON CONFLICT(period) DO UPDATE SET
    czynsz_total        = excluded.czynsz_total,
    marek_total         = excluded.marek_total,
    dla_mnie            = excluded.dla_mnie,
    media_advance_total = excluded.media_advance_total,
    media_paid          = excluded.media_paid,
    media_left          = excluded.media_left,
    penalties           = excluded.penalties,
    total               = excluded.total,
    podatek             = excluded.podatek,
    podatek_koscielna   = excluded.podatek_koscielna,
    podatek_suma        = excluded.podatek_suma
`);

function importMonthSection(matrix, headerRowIdx, period, log) {
  // headerRowIdx - wiersz z nazwą miesiąca (np. "kwiecień 2025")
  // UWAGA: w tym pliku nagłówek tabeli ('dane os.') jest CZĘSTO w tym samym
  // wierszu co nazwa miesiąca (np. "styczeń 2025  dane os.  Do kiedy wpłaca …"),
  // ale w starszych arkuszach (2020-2024) bywa też w wierszu+1 lub +2.
  // Stąd pętla zaczyna od headerRowIdx (nie +1).
  let cols = null;
  let tableRow = -1;
  for (let r = headerRowIdx; r < Math.min(headerRowIdx + 5, matrix.length); r++) {
    const row = matrix[r] || [];
    if (r > headerRowIdx && looksLikeMonthHeader(rowFirstNonEmpty(row))) break;
    const idx = findCol(row, ['dane os']);
    if (idx >= 0) {
      tableRow = r;
      cols = {
        no:        findCol(row, ['']),  // pierwsza kolumna; znajdziemy po negatywie
        name:      idx,
        due_day:   findCol(row, ['do kiedy']),
        total:     findCol(row, ['przelew', 'wplata', 'wpłata']),
        rent:      findCol(row, ['czynsz']),
        media:     findCol(row, ['zaliczki na media','zaliczki']),
        other:     findCol(row, ['inne oplaty','inne op']),
        contract:  findCol(row, ['umowa do']),
      };
      break;
    }
  }
  if (!cols) return { ok:false, reason: 'no_table_header' };

  // Numer pokoju jest w kolumnie *przed* "dane os."
  const noCol = cols.name - 1;

  // Iteruj wiersze najemców do napotkania pustego wiersza lub kolejnego nagłówka
  let inserted = 0;
  let countedTenants = 0;
  for (let r = tableRow + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const noVal = noCol >= 0 ? row[noCol] : null;
    const nameVal = row[cols.name];
    const due = asNumber(row[cols.due_day]);
    const total = asNumber(row[cols.total]);
    const rent = asNumber(row[cols.rent]);
    const media = asNumber(row[cols.media]);

    // koniec sekcji: pusty wiersz po przynajmniej jednym najemcy
    const isEmpty = (noVal == null && nameVal == null && total == null && rent == null);
    if (isEmpty) {
      if (countedTenants > 0) break;
      continue; // jeszcze nic nie znaleziono — szukaj dalej
    }

    // Jeśli nie ma numeru pokoju lub nie da się sparsować — pomiń
    const roomNo = asNumber(noVal);
    const name = canonName(nameVal);
    if (!name) continue;
    if (!roomNo) continue;
    if (roomNo > 10) break;  // bezpiecznik, weszliśmy w inny blok

    countedTenants++;

    const tenantId = ensureTenant(name, pickColor(roomNo - 1));
    const unit = unitForRoomNo(roomNo);
    if (!unit) {
      log(`  ! Brak unit-u dla pokoju ${roomNo} (najemca ${name}) — pomijam`);
      continue;
    }

    upsertPayment.run({
      period,
      tenant_id: tenantId,
      unit_id: unit.id,
      due_day: due,
      due_date: due ? dueDate(period, due) : null,
      paid_date: null,
      rent_amount: rent || 0,
      media_amount: media || 0,
      other_amount: 0,
      total_paid: total || 0,
      status: paymentStatus(total, (rent || 0) + (media || 0)),
      notes: null,
    });
    inserted++;

    // przypisz najemcę do tego lokalu jako bieżącego, jeśli niepusty
    db.prepare(`
      UPDATE tenants SET current_unit_id = ? WHERE id = ? AND (current_unit_id IS NULL OR current_unit_id != ?)
    `).run(unit.id, tenantId, unit.id);
  }

  // ── Sekcja sumaryczna ──
  // Stary format (2020-2022): "Przelewy | A. Wize | Dla mnie | …"
  // Nowy format (2023+):       "Czynsz   | Marek   | Dla mnie | …"
  let summaryRow = -1, summaryHdr = null;
  for (let r = tableRow + 1; r < Math.min(tableRow + 25, matrix.length); r++) {
    const row = matrix[r] || [];
    const dlaMnieIdx = findCol(row, ['dla mnie']);
    const czynszIdx = findCol(row, ['czynsz', 'przelewy']);
    if (dlaMnieIdx >= 0 && czynszIdx >= 0) {
      summaryHdr = {
        czynsz: czynszIdx,
        marek:  findCol(row, ['marek','a. wize','wize']),
        dla_mnie: dlaMnieIdx,
        media_adv: findCol(row, ['zaliczki']),
        media_paid: findCol(row, ['zaplacone media','zapłacone']),
        media_left: findCol(row, ['zostalo','zostało']),
        penalties: findCol(row, ['kary']),
        total: findCol(row, ['suma']),
      };
      summaryRow = r + 1; // wartości w kolejnym wierszu
      break;
    }
  }
  let summary = null;
  if (summaryRow > 0 && summaryRow < matrix.length) {
    const v = matrix[summaryRow] || [];
    summary = {
      period,
      czynsz_total: asNumber(v[summaryHdr.czynsz]),
      marek_total:  asNumber(v[summaryHdr.marek]),
      dla_mnie:     asNumber(v[summaryHdr.dla_mnie]),
      media_advance_total: asNumber(v[summaryHdr.media_adv]),
      media_paid:   asNumber(v[summaryHdr.media_paid]),
      media_left:   asNumber(v[summaryHdr.media_left]),
      penalties:    asNumber(v[summaryHdr.penalties]),
      total:        asNumber(v[summaryHdr.total]),
      podatek:      null,
      podatek_koscielna: null,
      podatek_suma: null,
    };

    // Marek/Kościelna jako osobny payment — kwota z sekcji sumarycznej
    const unitMarek = unitForMarek();
    if (unitMarek && summary.marek_total != null && summary.marek_total > 0) {
      const tMarek = ensureTenant('Marek', pickColor(0));
      upsertPayment.run({
        period,
        tenant_id: tMarek,
        unit_id: unitMarek.id,
        due_day: 31,
        due_date: dueDate(period, 31),
        paid_date: null,
        rent_amount: summary.marek_total,
        media_amount: 0,
        other_amount: 0,
        total_paid: summary.marek_total,
        status: 'paid',
        notes: 'Z sumarycznej sekcji Excela',
      });
      db.prepare(`UPDATE tenants SET current_unit_id = ? WHERE id = ?`).run(unitMarek.id, tMarek);
      inserted++;
    }

    // Podatek — wiersze "Podatek:" / "kościelna" / "suma"
    for (let r = summaryRow; r < Math.min(summaryRow + 8, matrix.length); r++) {
      const row = matrix[r] || [];
      const firstRaw = String(rowFirstNonEmpty(row) || '');
      const first = normalize(firstRaw);
      // znajdź pierwszą liczbę w wierszu (po pierwszym tekście)
      let n = null;
      for (let c = 0; c < row.length; c++) {
        const v = normalizeTaxValue(row[c]);
        if (v != null && normalize(row[c]) !== first) { n = v; break; }
      }
      if (first === 'podatek' || first === 'podatek:') summary.podatek = n;
      else if (first.includes('koscielna') || first.includes('kościelna')) summary.podatek_koscielna = n;
      else if (first === 'suma' || first.startsWith('suma')) summary.podatek_suma = n;
    }
    if (summary.podatek_suma == null) {
      summary.podatek_suma = (summary.podatek || 0) + (summary.podatek_koscielna || 0) || null;
    }

    upsertSummary.run(summary);
  }

  return { ok:true, inserted, summary, period };
}

// ── główna funkcja ──────────────────────────────────
function runImport(filePath, opts = {}) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  if (!opts.allowWrite && process.env.ENABLE_EXCEL_IMPORT !== '1') {
    throw new Error('Import XLSX zapisuje dane i jest domyślnie zablokowany. Ustaw ENABLE_EXCEL_IMPORT=1 tylko na czas kontrolowanego importu.');
  }
  if (!fs.existsSync(filePath)) throw new Error('Plik nie istnieje: ' + filePath);
  const wb = XLSX.readFile(filePath);

  // tabela aliasów (string→string) — jeśli zachodzi potrzeba
  const stats = { sheets: 0, periods: 0, payments: 0, summaries: 0 };

  const tx = db.transaction(() => {
    for (const sheetName of wb.SheetNames) {
      const matrix = sheetToMatrix(wb.Sheets[sheetName]);
      stats.sheets++;
      log(`\n— Arkusz "${sheetName}" (${matrix.length} wierszy)`);

      for (let r = 0; r < matrix.length; r++) {
        const row = matrix[r] || [];
        const first = rowFirstNonEmpty(row);
        if (!first || typeof first === 'number') continue;
        const parsed = parsePolishMonthYear(first);
        if (!parsed) continue;

        const result = importMonthSection(matrix, r, parsed.period, log);
        if (result.ok) {
          stats.periods++;
          stats.payments += result.inserted;
          if (result.summary) stats.summaries++;
          log(`  ✓ ${parsed.period}: ${result.inserted} płatności`);
        } else {
          log(`  ! ${parsed.period}: pominięty (${result.reason})`);
        }
      }
    }
  });

  tx();

  log('\n══ Podsumowanie importu ══');
  log(`  Arkuszy:         ${stats.sheets}`);
  log(`  Okresów:         ${stats.periods}`);
  log(`  Płatności:       ${stats.payments}`);
  log(`  Sum miesięcznych: ${stats.summaries}`);
  return stats;
}

module.exports = { runImport };

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', 'ROZLICZENIA Z NAJEMCAMI.xlsx');
  try { runImport(file); }
  catch (e) { console.error('Błąd importu:', e.message); process.exit(1); }
}
