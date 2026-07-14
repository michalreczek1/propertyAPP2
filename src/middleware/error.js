'use strict';
function notFound(req, res) {
  res.status(404).json({ error: 'not_found', path: req.path });
}

function errorHandler(err, req, res, _next) {
  // zod validation
  if (err && err.name === 'ZodError') {
    return res.status(400).json({ error: 'validation_error', issues: err.issues });
  }
  // SQLite constraint
  if (err && err.code && err.code.startsWith && err.code.startsWith('SQLITE_')) {
    return res.status(400).json({ error: 'db_error', code: err.code, message: err.message });
  }
  console.error('[error]', err);
  res
    .status(err.status || 500)
    .json({ error: err.code || 'internal_error', message: err.message || 'Internal Server Error' });
}

module.exports = { notFound, errorHandler };
