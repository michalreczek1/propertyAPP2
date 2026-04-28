#!/usr/bin/env node
'use strict';
/**
 * Backup bazy SQLite metodą online (better-sqlite3.backup()).
 * Cron-friendly: wypisuje 1 linię, exit code != 0 przy błędzie.
 *
 * Użycie:
 *   node scripts/backup.js                              # do data/backups/
 *   node scripts/backup.js /opt/propertyapp/data/backups
 *
 * Cron (codziennie o 03:00):
 *   0 3 * * *  cd /opt/propertyapp/app && /usr/bin/node scripts/backup.js >> /var/log/propertyapp-backup.log 2>&1
 *
 * Rotacja: trzymaj 14 najnowszych plików.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const KEEP_LAST = +(process.env.BACKUP_KEEP || 14);

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `property-${stamp}.db`);

  // better-sqlite3.backup() zwraca Promise — spójny snapshot bez przerywania zapisów
  await db.backup(file);

  const stat = fs.statSync(file);
  console.log(`[backup] ok ${file} (${(stat.size/1024).toFixed(1)} kB)`);

  // rotacja
  const files = fs.readdirSync(outDir)
    .filter(f => f.startsWith('property-') && f.endsWith('.db'))
    .map(f => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const toRemove = files.slice(KEEP_LAST);
  for (const { f } of toRemove) {
    try { fs.unlinkSync(path.join(outDir, f)); console.log(`[backup] usunięto stary: ${f}`); }
    catch (e) { console.error(`[backup] nie mogę usunąć ${f}: ${e.message}`); }
  }
}

main().catch(e => { console.error('[backup] BŁĄD:', e.message); process.exit(1); });
