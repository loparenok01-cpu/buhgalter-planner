'use strict';

const crypto = require('node:crypto');

// Вход и сессии (ТЗ, раздел 6.11).
// Единая учётная запись, пароль хранится только хешем (FR-69),
// сессия живёт до выхода или таймаута бездействия (FR-70).

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const TOKEN_LENGTH = 32;

// Пароль читабелен и удобен для диктовки: без похожих символов.
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length) {
  const size = length || 12;
  const bytes = crypto.randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

// Формат хранения: scrypt$N$r$p$соль$хеш — параметры лежат рядом с результатом,
// поэтому их можно будет изменить без потери старых паролей.
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// При первом запуске создаётся единственная учётная запись (FR-69).
// Пароль берётся из ASBUHG_PASSWORD или генерируется и печатается при запуске.
function ensureAccount(db, options) {
  const existing = db.prepare('SELECT id, login FROM accounts LIMIT 1').get();
  if (existing) return { account: existing, created: false };

  const settings = options || {};
  const login = settings.login || 'admin';
  const password = settings.password || generatePassword();

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, login, password_hash) VALUES (?, ?, ?)').run(
    id,
    login,
    hashPassword(password),
  );

  return {
    account: { id, login },
    created: true,
    password: settings.password ? null : password,
  };
}

// Смена пароля выполняется при настройке сервера, а не из интерфейса.
function setPassword(db, login, password) {
  const result = db
    .prepare('UPDATE accounts SET password_hash = ? WHERE login = ?')
    .run(hashPassword(password), login);

  if (result.changes === 0) return false;

  db.prepare('DELETE FROM sessions').run();
  return true;
}

function createSession(db, accountId, timeoutMs) {
  const token = crypto.randomBytes(TOKEN_LENGTH).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + timeoutMs);

  db.prepare(
    'INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, accountId, now.toISOString(), expires.toISOString());

  return token;
}

// Возвращает сессию и продлевает её: таймаут считается от последнего действия.
function getValidSession(db, token, timeoutMs) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.token, s.account_id, s.expires_at, a.login
         FROM sessions s
         JOIN accounts a ON a.id = s.account_id
        WHERE s.token = ?`,
    )
    .get(token);

  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const expires = new Date(Date.now() + timeoutMs).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(expires, token);

  return { token: row.token, accountId: row.account_id, login: row.login, expiresAt: expires };
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Протухшие сессии убираются при запуске сервера.
function cleanupSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

module.exports = {
  ensureAccount,
  setPassword,
  hashPassword,
  verifyPassword,
  createSession,
  getValidSession,
  destroySession,
  cleanupSessions,
};
