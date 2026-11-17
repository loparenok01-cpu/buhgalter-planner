'use strict';

// Настройки вида (ТЗ, FR-52): выбранный режим «Активные / Архивные»
// и текущая неделя. Хранятся в app_settings на сервере, поэтому
// переживают перезагрузку страницы и смену браузера.
//
// В файле экспорта они занимают раздел "ui" (раздел 5.1 ТЗ).

const { isIsoDate } = require('./dates');

const WEEK_START_KEY = 'ui.weekStart';
const MODE_KEY = 'ui.mode';

function read(db) {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const values = new Map(rows.map((row) => [row.key, row.value]));

  const weekStart = values.get(WEEK_START_KEY);
  const mode = values.get(MODE_KEY);

  return {
    weekStart: isIsoDate(weekStart) ? weekStart : null,
    mode: mode === 'archive' ? 'archive' : 'active',
  };
}

function write(db, ui) {
  const source = ui || {};
  const mode = source.mode === 'archive' ? 'archive' : 'active';

  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(MODE_KEY, mode);

  if (isIsoDate(source.weekStart)) {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(WEEK_START_KEY, source.weekStart);
  } else {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(WEEK_START_KEY);
  }

  return read(db);
}

// Проверка настроек, пришедших в запросе или в файле копии.
function validate(ui) {
  const errors = [];

  if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) {
    errors.push('Настройки вида должны быть объектом');
    return errors;
  }

  if (ui.mode !== undefined && ui.mode !== null && !['active', 'archive'].includes(ui.mode)) {
    errors.push('Режим показа: «active» или «archive»');
  }

  if (ui.weekStart !== undefined && ui.weekStart !== null && !isIsoDate(ui.weekStart)) {
    errors.push('Начало недели должно быть в формате ГГГГ-ММ-ДД или быть пустым');
  }

  return errors;
}

module.exports = {
  read,
  write,
  validate,
};
