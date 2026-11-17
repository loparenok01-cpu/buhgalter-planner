'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');

// Открывает базу данных и применяет миграции.
// Внешние ключи включаются при каждом соединении (ТЗ, раздел 5.2), журнал — WAL.
function openDatabase() {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

  const db = new DatabaseSync(config.dbFile);

  // Если файл повреждён, открытие доходит до первой команды и падает.
  // Соединение при этом нужно закрыть: иначе на Windows файл остаётся
  // занятым и его нельзя отодвинуть в сторону при восстановлении (FR-51).
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');

    applyMigrations(db, config.migrationsDir);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch (closeError) {
      // Соединение уже могло быть закрыто.
    }
    throw error;
  }
}

function applyMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of files) {
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${name} не применилась: ${error.message}`);
    }
  }

  return db;
}

// Версия схемы — имя последней применённой миграции (NFR-11).
function schemaVersion(db) {
  const row = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get();
  return row ? row.version : null;
}

module.exports = { openDatabase, applyMigrations, schemaVersion };
