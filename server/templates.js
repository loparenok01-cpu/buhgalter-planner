'use strict';

const crypto = require('node:crypto');

// Шаблоны задач (ТЗ, раздел 6.4, FR-27…FR-31).
//
// Встроенные шаблоны BT-01…BT-04 приходят из миграции, их нельзя
// переименовать или удалить. Пользовательские шаблоны создаёт сам
// бухгалтер: они только подставляют название задачи и на генерацию
// отчётности не влияют.

function toTemplate(row) {
  return {
    id: row.id,
    title: row.title,
    builtin: row.builtin === 1,
  };
}

function list(db) {
  const rows = db
    .prepare(
      `SELECT * FROM templates
        ORDER BY builtin DESC,
                 CASE WHEN builtin = 1 THEN id ELSE title END ASC`,
    )
    .all();

  return rows.map(toTemplate);
}

function get(db, id) {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  return row ? toTemplate(row) : null;
}

function findByTitle(db, title, excludeId = null) {
  const row = excludeId
    ? db.prepare('SELECT * FROM templates WHERE title = ? AND id <> ?').get(title, excludeId)
    : db.prepare('SELECT * FROM templates WHERE title = ?').get(title);
  return row ? toTemplate(row) : null;
}

function create(db, title) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO templates (id, title, builtin) VALUES (?, ?, 0)').run(id, title);
  return get(db, id);
}

function rename(db, id, title) {
  db.prepare('UPDATE templates SET title = ? WHERE id = ? AND builtin = 0').run(title, id);
  return get(db, id);
}

function remove(db, id) {
  const result = db.prepare('DELETE FROM templates WHERE id = ? AND builtin = 0').run(id);
  return result.changes > 0;
}

module.exports = {
  list,
  get,
  findByTitle,
  create,
  rename,
  remove,
};
