'use strict';

const crypto = require('crypto');
const db = require('../db');

function encryptionKey() {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('app_session_secret_required');
  return crypto.scryptSync(secret, 'propertyapp-user-secrets-v1', 32);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, tag, body] = String(value || '')
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function getUserSecret(userId, name) {
  if (!userId) return '';
  const row = db
    .prepare('SELECT ciphertext FROM user_secrets WHERE owner_user_id = ? AND name = ?')
    .get(userId, name);
  return row ? decrypt(row.ciphertext) : '';
}

function hasUserSecret(userId, name) {
  if (!userId) return false;
  return !!db.prepare('SELECT 1 FROM user_secrets WHERE owner_user_id = ? AND name = ?').get(userId, name);
}

function setUserSecret(userId, name, value) {
  db.prepare(
    `INSERT INTO user_secrets(owner_user_id, name, ciphertext) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = CURRENT_TIMESTAMP`,
  ).run(userId, name, encrypt(value));
}

function deleteUserSecret(userId, name) {
  db.prepare('DELETE FROM user_secrets WHERE owner_user_id = ? AND name = ?').run(userId, name);
}

module.exports = { getUserSecret, hasUserSecret, setUserSecret, deleteUserSecret };
