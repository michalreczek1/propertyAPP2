'use strict';

// Ładujemy konfigurację zanim którykolwiek moduł odczyta DB_FILE/UPLOADS_DIR.
// Zmienne przekazane przez systemd lub powłokę zawsze mają pierwszeństwo.
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'EACCES') return;
    throw err;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile('/etc/propertyapp/auth.env');
