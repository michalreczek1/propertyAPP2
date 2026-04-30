#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');

const db = require('./db');
const { notFound, errorHandler } = require('./middleware/error');
const { authStatus, installAuth, requireAuth } = require('./middleware/auth');

// Lazy-load opcjonalnego pliku .env
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { startNotificationScheduler } = require('./services/notifications');

const PORT = +(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(morgan('tiny'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
installAuth(app);

// API
app.get('/health', (_req, res) => {
  const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  res.json({ ok: true, db: db.name, tables });
});

app.use('/api', requireAuth);
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/reports',    require('./routes/reports'));
app.use('/api/properties', require('./routes/properties'));
app.use('/api/units',      require('./routes/units'));
app.use('/api/tenants',    require('./routes/tenants'));
app.use('/api/contracts',  require('./routes/contracts'));
app.use('/api/payments',   require('./routes/payments'));
app.use('/api/expenses',   require('./routes/expenses'));
app.use('/api/tasks',      require('./routes/tasks'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/admin',      require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/import',     require('./routes/import'));
app.use('/api/export',     require('./routes/export'));

// Frontend (statyczne)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
function requirePageAuth(req, res, next) {
  const status = authStatus(req);
  if (!status.enabled || status.user) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${nextUrl}`);
}

app.use(requirePageAuth);
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(js|css)$/.test(filePath)) {
      // wersja w URL (?v=mtime) zmienia się przy każdym deploy → bezpieczny długi cache
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  },
}));

function serveIndex(_req, res) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  // wstrzyknij ?v=<mtime> do app.js i styles.css aby ominąć cache CF/przeglądarki przy kolejnych deploy
  for (const f of ['app.js', 'styles.css']) {
    try {
      const v = Math.floor(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
      const re = new RegExp(`(["'])\\/?${f.replace('.', '\\.')}(\\?[^"']*)?\\1`, 'g');
      html = html.replace(re, `$1/${f}?v=${v}$1`);
    } catch {}
  }
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.send(html);
}
app.get('/', serveIndex);

// SPA fallback (zostawia /api/* nieruszone)
app.get(/^\/(?!api\/|health$).*/, serveIndex);

// 404 dla API + handler błędów
app.use('/api', notFound);
app.use(errorHandler);

app.listen(PORT, HOST, () => {
  console.log(`▶ PropertyApp http://${HOST}:${PORT}`);
  console.log(`  DB: ${db.name}`);
  startNotificationScheduler();
});
