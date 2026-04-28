'use strict';
const db = require('../src/db');
const { dueDate } = require('../src/utils/period');

const SOURCE = '2026-01';
const TARGETS = ['2026-02', '2026-03', '2026-04'];

const src = db.prepare(`SELECT * FROM payments WHERE period = ?`).all(SOURCE);
console.log(`Źródło ${SOURCE}: ${src.length} płatności`);

const ins = db.prepare(`
  INSERT OR IGNORE INTO payments
    (period, tenant_id, unit_id, due_day, due_date,
     rent_amount, media_amount, other_amount, total_paid, status, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 'copied-from-' || ?)
`);

const tx = db.transaction(() => {
  for (const period of TARGETS) {
    let inserted = 0, skipped = 0;
    for (const r of src) {
      const res = ins.run(
        period, r.tenant_id, r.unit_id, r.due_day,
        dueDate(period, r.due_day || 31),
        r.rent_amount, r.media_amount, r.other_amount,
        SOURCE
      );
      if (res.changes) inserted++; else skipped++;
    }
    console.log(`  ${period}: dodano ${inserted}, pominięto ${skipped}`);
  }
});
tx();

console.log('\nStan po kopiowaniu:');
for (const row of db.prepare(`SELECT period, COUNT(*) c FROM payments WHERE period >= '2026-01' GROUP BY period ORDER BY period`).all()) {
  console.log(`  ${row.period}: ${row.c}`);
}
