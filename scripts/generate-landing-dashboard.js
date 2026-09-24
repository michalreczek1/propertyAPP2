#!/usr/bin/env node
'use strict';

// Creates a real app screenshot from a fresh database containing only invented data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const Database = require('better-sqlite3');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propertyapp-landing-preview-'));
const dbFile = path.join(tempDir, 'synthetic.db');
const port = 8197;
const env = {
  ...process.env,
  DB_FILE: dbFile,
  UPLOADS_DIR: path.join(tempDir, 'uploads'),
  NODE_ENV: 'test',
  APP_AUTH_ENABLED: '0',
  APP_AUTH_USER: 'synthetic-admin',
  APP_AUTH_PASSWORD_HASH: 'synthetic-only',
  APP_SESSION_SECRET: 'synthetic-preview-secret-with-sufficient-length',
  PORT: String(port),
  HOST: '127.0.0.1',
};

function periodMonthsAgo(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function seedSyntheticData() {
  const db = new Database(dbFile);
  const properties = ['Kamienica Alfa', 'Apartamenty Beta'].map(
    (name) =>
      db.prepare('INSERT INTO properties(name, type) VALUES (?, ?)').run(name, 'mieszkanie').lastInsertRowid,
  );
  const units = [
    [0, 'A1', 1850, 350, true],
    [0, 'A2', 2100, 400, true],
    [0, 'A3', 1750, 320, true],
    [0, 'A4', 1900, 360, false],
    [1, 'B1', 2300, 450, true],
    [1, 'B2', 1950, 380, true],
    [1, 'B3', 2250, 420, true],
    [1, 'B4', 2050, 400, false],
  ].map(([propertyIndex, code, rent, media, rented]) => {
    const id = db
      .prepare(
        'INSERT INTO units(property_id, name, code, base_rent, base_media, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        properties[propertyIndex],
        `Lokal ${code}`,
        code,
        rent,
        media,
        rented ? 'rented' : 'vacant',
      ).lastInsertRowid;
    return { id, rent, media, rented };
  });
  const rented = units.filter((unit) => unit.rented);
  const tenants = rented.map(
    (unit, index) =>
      db
        .prepare('INSERT INTO tenants(name, current_unit_id, status) VALUES (?, ?, ?)')
        .run(`Najemca ${String.fromCharCode(65 + index)}`, unit.id, 'active').lastInsertRowid,
  );
  const insertPayment = db.prepare(`INSERT INTO payments
    (period, tenant_id, unit_id, due_day, due_date, paid_date, rent_amount, media_amount, total_paid, status)
    VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?, ?)`);
  const insertExpense = db.prepare(
    'INSERT INTO expenses(property_id, category, amount, date, description) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let monthOffset = 8; monthOffset >= 0; monthOffset--) {
      const period = periodMonthsAgo(monthOffset);
      rented.forEach((unit, index) => {
        const paid = monthOffset > 0 || index < 4;
        insertPayment.run(
          period,
          tenants[index],
          unit.id,
          `${period}-10`,
          paid ? `${period}-05` : null,
          unit.rent,
          unit.media,
          paid ? unit.rent + unit.media : 0,
          paid ? 'paid' : 'pending',
        );
      });
      insertExpense.run(properties[0], 'prad', 330, `${period}-12`, 'Prąd — dane przykładowe');
      insertExpense.run(properties[1], 'internet', 120, `${period}-12`, 'Internet — dane przykładowe');
      insertExpense.run(properties[1], 'czynsz', 620, `${period}-12`, 'Czynsz — dane przykładowe');
    }
  })();
  db.close();
}

async function main() {
  fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });
  const migrated = spawnSync(process.execPath, ['scripts/migrate.js'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (migrated.status !== 0) throw new Error(`Migration failed: ${migrated.stderr}`);
  seedSyntheticData();

  const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        if (ready) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('Preview server did not start');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/#dashboard`, { waitUntil: 'networkidle' });
    await page.locator('.kpi-hero .kh-val').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    const image = path.join(root, 'public', 'dashboard-preview.png');
    await page.screenshot({ path: image, animations: 'disabled' });
    console.log(`Synthetic dashboard screenshot: ${image}`);
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    const resolvedTemp = path.resolve(tempDir);
    if (!resolvedTemp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
      throw new Error('Refusing to remove a directory outside the system temporary directory');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
