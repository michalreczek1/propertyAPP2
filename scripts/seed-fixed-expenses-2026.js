'use strict';

const db = require('../src/db');

const START = process.env.FIXED_EXPENSES_START || '2026-01';
const END = process.env.FIXED_EXPENSES_END || '2026-12';

const fixedExpenses = [
  {
    propertyLike: '%Chrobrego%',
    items: [
      { category: 'czynsz', amount: 1710, description: 'Czynsz administracyjny (stały)' },
      { category: 'internet', amount: 64, description: 'Internet (stały)' },
      { category: 'prad', amount: 150, description: 'Prąd (stały)' },
    ],
  },
  {
    propertyLike: '%Kościelna%',
    items: [
      { category: 'czynsz', amount: 695.54, description: 'Czynsz administracyjny (stały)' },
      { category: 'prad', amount: 120, description: 'Prąd (stały)' },
    ],
  },
];

function monthRange(start, end) {
  const months = [];
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

const findProperty = db.prepare('SELECT id, name FROM properties WHERE name LIKE ? LIMIT 1');
const deleteFixed = db.prepare(`
  DELETE FROM expenses
  WHERE date >= ? AND date <= ?
    AND description IN (
      'Staly koszt Chrobrego: czynsz',
      'Staly koszt Chrobrego: internet',
      'Staly koszt Chrobrego: prad',
      'Staly koszt Koscielna: czynsz',
      'Staly koszt Koscielna: prad',
      'Czynsz administracyjny (stały)',
      'Internet (stały)',
      'Prąd (stały)'
    )
`);
const deleteLegacy2026 = db.prepare(`
  DELETE FROM expenses
  WHERE date >= ? AND date <= ?
    AND (
      description LIKE 'Media (dostawcy)%'
      OR description LIKE 'Prowizja zarz%dcy%'
    )
`);
const insertExpense = db.prepare(`
  INSERT INTO expenses (property_id, unit_id, category, amount, date, description, document_path)
  VALUES (?, NULL, ?, ?, ?, ?, NULL)
`);

const months = monthRange(START, END);
const startDate = `${START}-01`;
const endDate = `${END}-31`;

let removedFixed = 0;
let removedLegacy = 0;
let inserted = 0;

const tx = db.transaction(() => {
  removedFixed = deleteFixed.run(startDate, endDate).changes;
  removedLegacy = deleteLegacy2026.run(startDate, endDate).changes;

  for (const group of fixedExpenses) {
    const property = findProperty.get(group.propertyLike);
    if (!property) throw new Error(`Property not found: ${group.propertyLike}`);

    for (const period of months) {
      const date = `${period}-01`;
      for (const item of group.items) {
        insertExpense.run(property.id, item.category, item.amount, date, item.description);
        inserted += 1;
      }
    }
  }
});

tx();

console.log(JSON.stringify({
  period_from: START,
  period_to: END,
  removed_fixed: removedFixed,
  removed_legacy_2026: removedLegacy,
  inserted,
}, null, 2));
