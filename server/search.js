'use strict';

// Поиск и фильтры (ТЗ, раздел 6.5, FR-06, FR-37…FR-41).
//
// Поиск по названию задачи выполняется в JavaScript: SQLite без расширений
// сравнивает регистр только у латиницы, а названия задач — русские.
// Остальные условия (клиент, дата, статус) сужаются запросом к базе.

const tasks = require('./tasks');

const MAX_RESULTS = 500;

// Фильтр строки поиска клиента на неделе (FR-06): название или ИНН.
function filterClients(list, query) {
  const needle = String(query || '').trim().toLocaleLowerCase('ru');
  if (!needle) return list;

  return list.filter(
    (client) =>
      client.name.toLocaleLowerCase('ru').includes(needle) ||
      String(client.inn).includes(needle),
  );
}

function findTasks(db, filters) {
  const where = [];
  const params = [];

  if (filters.clientId) {
    where.push('t.client_id = ?');
    params.push(filters.clientId);
  }
  if (filters.from) {
    where.push('t.date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('t.date <= ?');
    params.push(filters.to);
  }
  if (filters.status) {
    where.push('t.status = ?');
    params.push(filters.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT t.id, t.client_id, t.date, t.title, t.status, t.comment, t.origin,
              t.rule_id, t.depends_on, t.payment_filled,
              c.name AS client_name, c.archived AS client_archived
         FROM tasks t
         JOIN clients c ON c.id = t.client_id
         ${whereSql}
        ORDER BY t.date ASC, c.name COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC`,
    )
    .all(...params);

  const needle = String(filters.q || '').trim().toLocaleLowerCase('ru');
  const readLines = db.prepare(
    'SELECT tax_kind FROM task_tax_lines WHERE task_id = ? ORDER BY rowid',
  );

  const result = [];
  let matched = 0;

  for (const row of rows) {
    if (needle && !row.title.toLocaleLowerCase('ru').includes(needle)) continue;
    matched += 1;
    if (result.length >= MAX_RESULTS) continue;

    result.push({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      clientArchived: row.client_archived === 1,
      date: row.date,
      title: row.title,
      status: row.status,
      comment: row.comment,
      origin: row.origin,
      ruleId: row.rule_id,
      dependsOn: row.depends_on,
      paymentFilled: row.payment_filled === 1,
      taxLines: readLines.all(row.id).map((line) => line.tax_kind),
    });
  }

  return {
    tasks: result,
    total: matched,
    shown: result.length,
    truncated: matched > result.length,
  };
}

function validateFilters(filters) {
  const errors = [];
  if (filters.status && !tasks.STATUSES.includes(filters.status)) {
    errors.push('Неизвестный статус задачи');
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.push('Начало периода позже его конца');
  }
  return errors;
}

module.exports = {
  filterClients,
  findTasks,
  validateFilters,
};
