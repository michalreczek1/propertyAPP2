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
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const db = require('../src/db');

const KEEP_LAST = +(process.env.BACKUP_KEEP || 14);

function verifyBackup(file) {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma('integrity_check', { simple: true });
    const foreignKeys = copy.pragma('foreign_key_check');
    if (integrity !== 'ok') throw new Error(`integrity_check=${integrity}`);
    if (foreignKeys.length) throw new Error(`foreign_key_check=${foreignKeys.length}`);
  } finally {
    copy.close();
  }
}

function archiveRecoveryFiles(outDir, stamp) {
  if (process.env.BACKUP_INCLUDE_FILES !== '1') return null;
  const sources = [
    process.env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    process.env.BACKUP_CONFIG_FILE || '/etc/propertyapp/auth.env',
  ].filter(fs.existsSync);
  if (!sources.length) return null;
  const archive = path.join(outDir, `property-${stamp}-recovery-files.tar.gz`);
  execFileSync('tar', ['-czf', archive, '--absolute-names', ...sources], { stdio: 'pipe' });
  fs.chmodSync(archive, 0o600);
  return archive;
}

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `property-${stamp}.db`);

  // better-sqlite3.backup() zwraca Promise — spójny snapshot bez przerywania zapisów
  await db.backup(file);
  verifyBackup(file);
  fs.chmodSync(file, 0o600);
  const recoveryArchive = archiveRecoveryFiles(outDir, stamp);

  const stat = fs.statSync(file);
  console.log(
    `[backup] ok ${file} (${(stat.size / 1024).toFixed(1)} kB; restore verified)${recoveryArchive ? `; files=${recoveryArchive}` : ''}`,
  );

  // rotacja
  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('property-') && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const toRemove = files.slice(KEEP_LAST);
  for (const { f } of toRemove) {
    try {
      fs.unlinkSync(path.join(outDir, f));
      console.log(`[backup] usunięto stary: ${f}`);
    } catch (e) {
      console.error(`[backup] nie mogę usunąć ${f}: ${e.message}`);
    }
    try {
      fs.unlinkSync(path.join(outDir, f.replace(/\.db$/, '-recovery-files.tar.gz')));
    } catch {
      /* archive may not exist for older backups */
    }
  }
}

main().catch((e) => {
  console.error('[backup] BŁĄD:', e.message);
  process.exit(1);
});
