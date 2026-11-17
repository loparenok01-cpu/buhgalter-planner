'use strict';

const path = require('node:path');

// Корень проекта: server/ лежит на один уровень ниже.
const rootDir = path.join(__dirname, '..');

// Настройки переопределяются переменными окружения:
//   ASBUHG_HOST        — адрес, который слушает сервер (по умолчанию 127.0.0.1, NFR-12)
//   ASBUHG_PORT        — порт
//   ASBUHG_DATA_DIR    — каталог данных: база и календарь нерабочих дней
//   ASBUHG_SESSION_MIN — таймаут сессии в минутах (по умолчанию 480, FR-70)
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const dataDir = process.env.ASBUHG_DATA_DIR
  ? path.resolve(process.env.ASBUHG_DATA_DIR)
  : path.join(rootDir, 'data');

const config = {
  rootDir,
  appDir: path.join(rootDir, 'app'),
  dataDir,
  dbFile: path.join(dataDir, 'asbuhg.db'),
  calendarFile: path.join(dataDir, 'calendar.json'),
  migrationsDir: path.join(__dirname, 'migrations'),
  host: process.env.ASBUHG_HOST || '127.0.0.1',
  port: intFromEnv('ASBUHG_PORT', 3000),
  sessionTimeoutMs: intFromEnv('ASBUHG_SESSION_MIN', 480) * 60 * 1000,
};

module.exports = config;
