'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const USER_FIELDS = `
  id, username, display_name, role, active, last_login_at, created_at, updated_at
`;

const CreateUserSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  display_name: z.string().trim().max(120).optional().nullable(),
  role: z.enum(['admin', 'user']).default('user'),
  password: z.string().min(8).max(200),
  active: z.boolean().optional().default(true),
});

const UpdateUserSchema = z.object({
  display_name: z.string().trim().max(120).optional().nullable(),
  role: z.enum(['admin', 'user']).optional(),
  password: z.string().min(8).max(200).optional().nullable(),
  active: z.boolean().optional(),
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(200),
});

function activeAdminCount(exceptId = null) {
  const params = [];
  let where = "role = 'admin' AND active = 1";
  if (exceptId) {
    where += ' AND id != ?';
    params.push(exceptId);
  }
  return db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where}`).get(...params).c;
}

function userById(id) {
  return db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id);
}

function normalizeActive(value) {
  return value === undefined ? undefined : (value ? 1 : 0);
}

router.post('/change-password', async (req, res) => {
  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_password' });
  if (!req.user || !req.user.id) return res.status(400).json({ error: 'database_user_required' });
  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ? AND active = 1').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const ok = await bcrypt.compare(parsed.data.current_password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'invalid_current_password' });
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bcrypt.hashSync(parsed.data.new_password, 12), user.id);
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/users', (_req, res) => {
  const users = db.prepare(`
    SELECT ${USER_FIELDS},
      (SELECT COUNT(*) FROM properties p WHERE p.owner_user_id = users.id) AS properties_count
    FROM users
    ORDER BY active DESC, role = 'admin' DESC, username COLLATE NOCASE
  `).all();
  res.json(users);
});

router.post('/users', (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_user' });
  const b = parsed.data;
  const exists = db.prepare('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)').get(b.username);
  if (exists) return res.status(409).json({ error: 'username_exists' });
  const hash = bcrypt.hashSync(b.password, 12);
  const r = db.prepare(`
    INSERT INTO users(username, display_name, role, password_hash, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(b.username, b.display_name || b.username, b.role, hash, b.active ? 1 : 0);
  res.status(201).json(userById(r.lastInsertRowid));
});

router.put('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const current = userById(id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_user' });
  const b = parsed.data;
  const nextRole = b.role || current.role;
  const nextActive = normalizeActive(b.active);
  if (current.role === 'admin' && (nextRole !== 'admin' || nextActive === 0) && activeAdminCount(id) < 1) {
    return res.status(400).json({ error: 'last_admin_required' });
  }
  const fields = [];
  const params = [];
  for (const key of ['display_name', 'role']) {
    if (b[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(b[key] || (key === 'display_name' ? current.username : b[key]));
    }
  }
  if (nextActive !== undefined) {
    fields.push('active = ?');
    params.push(nextActive);
  }
  if (b.password) {
    fields.push('password_hash = ?');
    params.push(bcrypt.hashSync(b.password, 12));
  }
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
  res.json(userById(id));
});

module.exports = router;
