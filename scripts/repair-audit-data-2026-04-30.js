#!/usr/bin/env node
'use strict';

/**
 * Jednorazowa, idempotentna korekta danych wykrytych przy porownaniu z Excelem:
 * - odtwarza prawdziwy 2023-01,
 * - dodaje 2024-01 jako "styczen jak grudzien 2023",
 * - poprawia podatek 2023-12 z rocznej tabelki,
 * - czyści omylkowa wplate P2/Alex 2025-09,
 * - zeruje automatyczne kary z 2025 r. i blokuje ich ponowne backfillowanie,
 * - przywraca nazwisko Ptyts zamiast Pyś.
 */

const db = require('../src/db');
const { dueDate } = require('../src/utils/period');

function paymentStatus(totalPaid, expectedTotal) {
  const paid = Number(totalPaid) || 0;
  const expected = Number(expectedTotal) || 0;
  if (paid <= 0) return 'pending';
  if (expected > 0 && paid < expected) return 'partial';
  return 'paid';
}

function adminOwnerId() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  return admin ? admin.id : null;
}

function unitByCode(code) {
  const row = db
    .prepare(
      `
    SELECT u.id, p.owner_user_id
    FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE u.code = ?
  `,
    )
    .get(code);
  if (!row) throw new Error(`Brak lokalu ${code}`);
  return row;
}

function ensureTenant(name, ownerUserId) {
  const existing = db
    .prepare('SELECT id FROM tenants WHERE LOWER(name) = LOWER(?) ORDER BY id LIMIT 1')
    .get(name);
  if (existing) return existing.id;
  const result = db
    .prepare(
      `
    INSERT INTO tenants (owner_user_id, name, status)
    VALUES (?, ?, 'inactive')
  `,
    )
    .run(ownerUserId, name);
  return result.lastInsertRowid;
}

const upsertPayment = db.prepare(`
  INSERT INTO payments (
    owner_user_id, period, tenant_id, unit_id, due_day, due_date, paid_date,
    rent_amount, media_amount, other_amount, late_fee_amount, late_fee_paid,
    late_fee_manual, total_paid, status, notes, source
  )
  VALUES (
    @owner_user_id, @period, @tenant_id, @unit_id, @due_day, @due_date, NULL,
    @rent_amount, @media_amount, 0, 0, 0,
    0, @total_paid, @status, @notes, 'excel'
  )
  ON CONFLICT(period, unit_id, tenant_id) WHERE unit_id IS NOT NULL AND tenant_id IS NOT NULL DO UPDATE SET
    owner_user_id = excluded.owner_user_id,
    due_day = excluded.due_day,
    due_date = excluded.due_date,
    paid_date = NULL,
    rent_amount = excluded.rent_amount,
    media_amount = excluded.media_amount,
    other_amount = 0,
    late_fee_amount = 0,
    late_fee_paid = 0,
    late_fee_manual = 0,
    total_paid = excluded.total_paid,
    status = excluded.status,
    notes = excluded.notes,
    source = 'excel'
`);

const upsertSummary = db.prepare(`
  INSERT INTO monthly_summary (
    period, czynsz_total, marek_total, dla_mnie, media_advance_total,
    media_paid, media_left, penalties, total, podatek, podatek_koscielna, podatek_suma
  )
  VALUES (
    @period, @czynsz_total, @marek_total, @dla_mnie, @media_advance_total,
    @media_paid, @media_left, @penalties, @total, @podatek, @podatek_koscielna, @podatek_suma
  )
  ON CONFLICT(period) DO UPDATE SET
    czynsz_total = excluded.czynsz_total,
    marek_total = excluded.marek_total,
    dla_mnie = excluded.dla_mnie,
    media_advance_total = excluded.media_advance_total,
    media_paid = excluded.media_paid,
    media_left = excluded.media_left,
    penalties = excluded.penalties,
    total = excluded.total,
    podatek = excluded.podatek,
    podatek_koscielna = excluded.podatek_koscielna,
    podatek_suma = excluded.podatek_suma
`);

function upsertHistoricalPeriod(period, rows, summary) {
  for (const row of rows) {
    const unit = unitByCode(row.code);
    const ownerUserId = unit.owner_user_id || adminOwnerId();
    const tenantId = ensureTenant(row.tenant, ownerUserId);
    upsertPayment.run({
      owner_user_id: ownerUserId,
      period,
      tenant_id: tenantId,
      unit_id: unit.id,
      due_day: row.due_day,
      due_date: dueDate(period, row.due_day),
      rent_amount: row.rent_amount,
      media_amount: row.media_amount,
      total_paid: row.total_paid,
      status: paymentStatus(row.total_paid, row.rent_amount + row.media_amount),
      notes: row.notes || null,
    });
  }
  upsertSummary.run({ period, ...summary });
}

function renamePysToPtyts(ownerUserId) {
  const pys = db.prepare("SELECT id FROM tenants WHERE name = 'Pyś' ORDER BY id LIMIT 1").get();
  if (!pys) return 0;
  const ptyts = db.prepare("SELECT id FROM tenants WHERE name = 'Ptyts' ORDER BY id LIMIT 1").get();
  if (!ptyts) {
    db.prepare(
      "UPDATE tenants SET name = 'Ptyts', owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?",
    ).run(ownerUserId, pys.id);
    return 1;
  }
  db.prepare('UPDATE payments SET tenant_id = ? WHERE tenant_id = ?').run(ptyts.id, pys.id);
  db.prepare('UPDATE contracts SET tenant_id = ? WHERE tenant_id = ?').run(ptyts.id, pys.id);
  db.prepare('UPDATE tasks SET tenant_id = ? WHERE tenant_id = ?').run(ptyts.id, pys.id);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(pys.id);
  return 1;
}

const rows202301 = [
  { code: 'P1', tenant: 'Sobolewski', due_day: 15, total_paid: 980, rent_amount: 780, media_amount: 200 },
  { code: 'P2', tenant: 'Guczalski', due_day: 31, total_paid: 950, rent_amount: 760, media_amount: 190 },
  { code: 'P3', tenant: 'Strójwąs', due_day: 31, total_paid: 880, rent_amount: 700, media_amount: 180 },
  { code: 'P4', tenant: 'Didenko', due_day: 31, total_paid: 873, rent_amount: 620, media_amount: 180 },
  { code: 'P5', tenant: 'Pazushko', due_day: 31, total_paid: 980, rent_amount: 790, media_amount: 190 },
  { code: 'P6', tenant: 'Jankowska', due_day: 31, total_paid: 980, rent_amount: 700, media_amount: 180 },
];

const summary202301 = {
  czynsz_total: 4350,
  marek_total: 609.0000000000001,
  dla_mnie: 4134,
  media_advance_total: 1120,
  media_paid: 1435,
  media_left: -315,
  penalties: 850,
  total: 6493,
  podatek: 369.75,
  podatek_koscielna: 140.25,
  podatek_suma: 510,
};

const rowsLike202312 = [
  { code: 'P1', tenant: 'Olejniczak', due_day: 15, total_paid: 850, rent_amount: 700, media_amount: 150 },
  { code: 'P2', tenant: 'Alex', due_day: 31, total_paid: 950, rent_amount: 760, media_amount: 190 },
  { code: 'P3', tenant: 'Strójwąs', due_day: 31, total_paid: 880, rent_amount: 700, media_amount: 180 },
  { code: 'P4', tenant: 'Brzeska', due_day: 31, total_paid: 850, rent_amount: 760, media_amount: 190 },
  { code: 'P5', tenant: 'Khuhajeva', due_day: 31, total_paid: 930, rent_amount: 740, media_amount: 190 },
  { code: 'P6', tenant: 'Krzyżaniak', due_day: 31, total_paid: 950, rent_amount: 770, media_amount: 180 },
];

const summaryLike202312 = {
  czynsz_total: 4430,
  marek_total: 500,
  dla_mnie: 3580,
  media_advance_total: 1080,
  media_paid: 1205,
  media_left: -125,
  penalties: 0,
  total: 5410,
  podatek: 376.55,
  podatek_koscielna: 182.75,
  podatek_suma: 559.3,
};

const tx = db.transaction(() => {
  const ownerUserId = adminOwnerId();
  upsertHistoricalPeriod('2023-01', rows202301, summary202301);
  upsertHistoricalPeriod('2024-01', rowsLike202312, summaryLike202312);
  upsertSummary.run({ period: '2023-12', ...summaryLike202312 });
  const renameCount = renamePysToPtyts(ownerUserId);

  const p2AlexReset = db
    .prepare(
      `
    UPDATE payments
    SET total_paid = 0,
        paid_date = NULL,
        status = 'pending',
        late_fee_amount = 0,
        late_fee_paid = 0,
        late_fee_manual = 1
    WHERE period = '2025-09'
      AND unit_id = (SELECT id FROM units WHERE code = 'P2')
  `,
    )
    .run().changes;

  const lateFeesCleared = db
    .prepare(
      `
    UPDATE payments
    SET late_fee_amount = 0,
        late_fee_paid = 0,
        late_fee_manual = 1
    WHERE period LIKE '2025-%'
      AND (COALESCE(late_fee_amount, 0) <> 0 OR COALESCE(late_fee_paid, 0) <> 0)
  `,
    )
    .run().changes;

  return { renameCount, p2AlexReset, lateFeesCleared };
});

const result = tx();
console.log('✓ Korekta danych zakonczona');
console.log(result);
