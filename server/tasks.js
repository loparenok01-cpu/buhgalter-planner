'use strict';

// Задачи в базе данных (ТЗ, разделы 5.2 и 6.3).
//
// Генератор (rules.js) только предлагает задачи. Здесь они записываются
// с защитой от дублей: уникальный индекс (client_id, date, rule_id)
// не даёт повторной генерации создать вторую такую же задачу (FR-24).

const crypto = require('node:crypto');

// Четыре статуса задачи (FR-32). Прогресс считает только «сделано»,
// «отправлено» показывается отдельным счётчиком (FR-33).
const STATUSES = ['todo', 'doing', 'done', 'sent'];

function readTaxLines(db, taskId) {
  return db
    .prepare('SELECT tax_kind FROM task_tax_lines WHERE task_id = ? ORDER BY rowid')
    .all(taskId)
    .map((row) => row.tax_kind);
}

function toTask(db, row) {
  return {
    id: row.id,
    clientId: row.client_id,
    date: row.date,
    title: row.title,
    status: row.status,
    comment: row.comment,
    origin: row.origin,
    ruleId: row.rule_id,
    dependsOn: row.depends_on,
    paymentFilled: row.payment_filled === 1,
    taxLines: readTaxLines(db, row.id),
  };
}

function listByClient(db, clientId, range = {}) {
  const conditions = ['client_id = ?'];
  const params = [clientId];

  if (range.from) {
    conditions.push('date >= ?');
    params.push(range.from);
  }
  if (range.to) {
    conditions.push('date <= ?');
    params.push(range.to);
  }

  const rows = db
    .prepare(
      `SELECT * FROM tasks
        WHERE ${conditions.join(' AND ')}
        ORDER BY date ASC, title ASC`,
    )
    .all(...params);

  return rows.map((row) => toTask(db, row));
}

// Задачи нескольких клиентов за диапазон дат — для сетки недели (FR-01…FR-05).
function listByRange(db, from, to, clientIds) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return [];

  const placeholders = clientIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM tasks
        WHERE date >= ? AND date <= ?
          AND client_id IN (${placeholders})
        ORDER BY date ASC, client_id ASC, title ASC`,
    )
    .all(from, to, ...clientIds);

  return rows.map((row) => toTask(db, row));
}

// Сводка недели: общее число задач, счётчики по статусам и прогресс.
// Прогресс = «сделано» / все задачи недели; «отправлено» в числитель
// не входит (FR-33).
function summarize(taskList) {
  const summary = { total: 0, todo: 0, doing: 0, done: 0, sent: 0, progress: 0 };

  for (const task of taskList) {
    summary.total += 1;
    if (Object.hasOwn(summary, task.status)) summary[task.status] += 1;
  }

  summary.progress = summary.total === 0
    ? 0
    : Math.round((summary.done / summary.total) * 100);

  return summary;
}

// Ручное создание задач из каталога шаблонов или произвольным названием
// (FR-27…FR-30). В отличие от генератора, защита от дублей здесь не нужна:
// бухгалтер сам решает, сколько задач создать в ячейке.
function createMany(db, clientId, date, items) {
  const insert = db.prepare(
    `INSERT INTO tasks (
       id, client_id, date, title, status, comment, origin, rule_id, depends_on, payment_filled
     ) VALUES (?, ?, ?, ?, 'todo', '', ?, NULL, NULL, 0)`,
  );

  const created = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      const id = crypto.randomUUID();
      // Чек-лист задаёт дату каждому пункту отдельно; каталог и ручная
      // задача передают одну дату на всю пачку.
      const itemDate = item.date || date;
      insert.run(id, clientId, itemDate, item.title, item.origin);
      created.push(get(db, id));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return created;
}

function update(db, id, patch) {
  const fields = [];
  const params = [];

  if (patch.status !== undefined) {
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.comment !== undefined) {
    fields.push('comment = ?');
    params.push(patch.comment);
  }

  if (fields.length === 0) return get(db, id);

  params.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return get(db, id);
}

function remove(db, id) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

function get(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? toTask(db, row) : null;
}

// Создаёт выбранные задачи. Повторный вызов не создаёт дублей:
// существующая задача находится по клиенту, дате и коду правила.
// Уведомление, созданное раньше, дополняется недостающими строками
// расшифровки, но его статус и комментарий не затираются.
function createFromItems(db, clientId, items) {
  const find = db.prepare(
    'SELECT id FROM tasks WHERE client_id = ? AND date = ? AND rule_id = ?',
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (
       id, client_id, date, title, status, comment, origin, rule_id, depends_on, payment_filled
     ) VALUES (?, ?, ?, ?, 'todo', '', 'rule', ?, NULL, 0)`,
  );
  const insertLine = db.prepare(
    'INSERT OR IGNORE INTO task_tax_lines (task_id, tax_kind) VALUES (?, ?)',
  );

  let created = 0;
  let existing = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      let taskId;
      const found = find.get(clientId, item.date, item.key);

      if (found) {
        taskId = found.id;
        existing += 1;
      } else {
        taskId = crypto.randomUUID();
        insertTask.run(taskId, clientId, item.date, item.title, item.key);
        created += 1;
      }

      for (const taxKind of item.taxLines || []) insertLine.run(taskId, taxKind);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { created, existing };
}

module.exports = {
  STATUSES,
  listByClient,
  listByRange,
  summarize,
  createMany,
  update,
  remove,
  get,
  createFromItems,
};
