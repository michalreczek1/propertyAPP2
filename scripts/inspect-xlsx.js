#!/usr/bin/env node
'use strict';
/** Diagnostyka: wypisuje 30 wierszy spod nagłówka miesiąca ze wszystkich arkuszy. */
const path = require('path');
const XLSX = require('xlsx');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const PL = [
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
].map(normalize);

function findMonth(text) {
  if (!text) return null;
  const n = normalize(text);
  if (!/20\d{2}/.test(n)) return null;
  for (let i = 0; i < PL.length; i++) if (n.includes(PL[i])) return i;
  return null;
}

const file = process.argv[2] || path.join(__dirname, '..', 'ROZLICZENIA Z NAJEMCAMI.xlsx');
const wantSheet = process.argv[3]; // np. "2025"
const wantOccurrence = +(process.argv[4] || '0'); // który nagłówek miesiąca

const wb = XLSX.readFile(file);
for (const sn of wb.SheetNames) {
  if (wantSheet && sn !== wantSheet) continue;
  const m = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null, blankrows: true });
  console.log(`\n══════ ${sn} (${m.length} wierszy) ══════`);
  let occurrence = -1;
  for (let r = 0; r < m.length; r++) {
    const row = m[r] || [];
    let first = null;
    for (const c of row)
      if (c != null && String(c).trim() !== '') {
        first = c;
        break;
      }
    if (findMonth(first) != null) {
      occurrence++;
      if (wantOccurrence && occurrence !== wantOccurrence) continue;
      console.log(`\n— Sekcja w wierszu ${r}: "${first}" —`);
      const end = Math.min(r + 18, m.length);
      for (let rr = r; rr < end; rr++) {
        const cells = (m[rr] || [])
          .map((c, i) =>
            c == null ? '' : `${String.fromCharCode(65 + i)}=${JSON.stringify(c).slice(0, 28)}`,
          )
          .filter(Boolean)
          .join('  ');
        console.log(`  [${String(rr).padStart(3, '0')}] ${cells}`);
      }
      if (wantOccurrence) break;
    }
  }
}
