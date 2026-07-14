#!/usr/bin/env node
'use strict';

// Playwright zawsze dostaje nową, odizolowaną bazę. Dzięki temu testy nie
// dotykają danych deweloperskich nawet wtedy, gdy test zostanie przerwany.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test-results', 'playwright-runtime');
const dbFile = path.join(testDir, 'property.db');
const uploadsDir = path.join(testDir, 'uploads');
fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const env = { ...process.env, DB_FILE: dbFile, UPLOADS_DIR: uploadsDir, NODE_ENV: 'test', PORT: process.env.PORT || '8090', HOST: '127.0.0.1' };
for (const script of ['scripts/migrate.js', 'scripts/seed.js']) {
  const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`${script} failed\n${result.stdout}\n${result.stderr}`);
    process.exit(result.status || 1);
  }
}
Object.assign(process.env, env);
require('../src/server');
