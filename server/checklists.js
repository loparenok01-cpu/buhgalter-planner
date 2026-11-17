'use strict';

// Чек-листы (ТЗ, раздел 6.5, FR-42).
//
// Чек-лист — это список названий задач с привязкой. Привязка бывает трёх
// видов:
//   • конкретная дата — задача встаёт на неё;
//   • период (неделя, месяц, квартал) — задача создаётся на каждый такой
//     период, попадающий в диапазон применения; дата задачи внутри периода
//     задаётся положением (period_pos): начало, середина, конец, число
//     месяца или день недели;
//   • без привязки — задача встаёт на начало периода применения.
//
// Варианты «число месяца» и «день недели» подразумевают свой шаг: «число
// месяца» работает с периодом «месяц», «день недели» — с периодом «неделя».
//
// Задача создаётся, только если её дата входит в период применения — одно
// правило для всех видов привязки. Поэтому «на квартал» месячный пункт
// даёт три задачи (на конец каждого месяца), а квартальный — одну.
//
// Применение к клиенту создаёт задачи с origin = 'manual': это не налоговые
// правила, повторная генерация их не трогает.

const crypto = require('node:crypto');

const { isIsoDate, addDays, weekdayIndex, daysInMonth, makeDate } = require('./dates');
const tasks = require('./tasks');

// Виды периодов и положения даты внутри периода.
const PERIODS = ['week', 'month', 'quarter'];
const POSITIONS = ['start', 'middle', 'end', 'dayOfMonth', 'weekday'];

function readItems(db, checklistId) {
  return db
    .prepare(
      `SELECT id, text, date, period, period_pos, period_day
         FROM checklist_items WHERE checklist_id = ? ORDER BY rowid`,
    )
    .all(checklistId)
    .map((row) => ({
      id: row.id,
      text: row.text,
      date: row.date,
      period: row.period,
      periodPos: row.period_pos,
      periodDay: row.period_day,
    }));
}

function toChecklist(db, row) {
  return {
    id: row.id,
    title: row.title,
    items: readItems(db, row.id),
  };
}

function list(db) {
  return db
    .prepare('SELECT id, title FROM checklists ORDER BY title COLLATE NOCASE ASC')
    .all()
    .map((row) => toChecklist(db, row));
}

function get(db, id) {
  const row = db.prepare('SELECT id, title FROM checklists WHERE id = ?').get(id);
  return row ? toChecklist(db, row) : null;
}

function normalize(input) {
  const raw = input || {};

  return {
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => {
        const value = item || {};
        const date = value.date === undefined || value.date === null || value.date === ''
          ? null
          : String(value.date);
        const period = value.period === undefined || value.period === null || value.period === ''
          ? null
          : String(value.period);
        const periodPos = value.periodPos === undefined || value.periodPos === null || value.periodPos === ''
          ? null
          : String(value.periodPos);
        // Число месяца или день недели — одно поле на оба варианта.
        const periodDay = value.periodDay === undefined || value.periodDay === null || value.periodDay === ''
          ? null
          : Number(value.periodDay);

        return {
          text: typeof value.text === 'string' ? value.text.trim() : '',
          date,
          period,
          periodPos,
          periodDay: Number.isInteger(periodDay) ? periodDay : null,
        };
      })
      : [],
  };
}

function validate(values) {
  const errors = [];

  if (!values.title) errors.push('Укажите название чек-листа');
  if (values.title.length > 200) errors.push('Название чек-листа длиннее 200 символов');
  if (values.items.length > 200) errors.push('В чек-листе больше 200 пунктов');

  values.items.forEach((item, index) => {
    const number = index + 1;
    if (!item.text) errors.push(`Пункт ${number}: укажите название задачи`);
    if (item.text.length > 300) errors.push(`Пункт ${number}: название длиннее 300 символов`);

    // Дата и период исключают друг друга: пункт привязан к одному.
    if (item.date !== null && item.period !== null) {
      errors.push(`Пункт ${number}: укажите либо дату, либо период, но не оба сразу`);
      return;
    }

    if (item.date !== null && !isIsoDate(item.date)) {
      errors.push(`Пункт ${number}: дата должна быть в формате ГГГГ-ММ-ДД или быть пустой`);
    }

    if (item.period !== null) {
      if (!PERIODS.includes(item.period)) {
        errors.push(`Пункт ${number}: период должен быть «неделя», «месяц» или «квартал»`);
      }
      if (!POSITIONS.includes(item.periodPos)) {
        errors.push(
          `Пункт ${number}: укажите положение даты в периоде — начало, середина, конец, число месяца или день недели`,
        );
      }

      if (item.periodPos === 'dayOfMonth') {
        if (item.period !== 'month') {
          errors.push(`Пункт ${number}: «число месяца» работает с периодом «месяц»`);
        }
        if (item.periodDay === null || item.periodDay < 1 || item.periodDay > 31) {
          errors.push(`Пункт ${number}: укажите число месяца от 1 до 31`);
        }
      } else if (item.periodPos === 'weekday') {
        if (item.period !== 'week') {
          errors.push(`Пункт ${number}: «день недели» работает с периодом «неделя»`);
        }
        if (item.periodDay === null || item.periodDay < 0 || item.periodDay > 6) {
          errors.push(`Пункт ${number}: укажите день недели от понедельника (0) до воскресенья (6)`);
        }
      }
    }
  });

  return errors;
}

function writeItems(insert, checklistId, items) {
  for (const item of items) {
    // У пункта либо дата, либо период; нормализация это гарантирует.
    const period = item.period !== null ? item.period : null;
    const periodPos = item.period !== null ? item.periodPos : null;
    const periodDay = item.period !== null ? item.periodDay : null;
    insert.run(crypto.randomUUID(), checklistId, item.text, item.date, period, periodPos, periodDay);
  }
}

function create(db, values) {
  const id = crypto.randomUUID();
  const insert = db.prepare(
    `INSERT INTO checklist_items (id, checklist_id, text, date, period, period_pos, period_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO checklists (id, title) VALUES (?, ?)').run(id, values.title);
    writeItems(insert, id, values.items);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return get(db, id);
}

function update(db, id, values) {
  const insert = db.prepare(
    `INSERT INTO checklist_items (id, checklist_id, text, date, period, period_pos, period_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE checklists SET title = ? WHERE id = ?').run(values.title, id);
    db.prepare('DELETE FROM checklist_items WHERE checklist_id = ?').run(id);
    writeItems(insert, id, values.items);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return get(db, id);
}

function remove(db, id) {
  return db.prepare('DELETE FROM checklists WHERE id = ?').run(id).changes > 0;
}

// --- Периоды пунктов ---

// Границы периода, к которому привязан пункт. Недели идут с понедельника —
// как и сетка недели в приложении.
function periodBounds(kind, year, month, quarterIndex) {
  if (kind === 'week') {
    return null; // недели перечисляются от диапазона применения
  }
  if (kind === 'month') {
    return {
      start: makeDate(year, month, 1),
      end: makeDate(year, month, daysInMonth(year, month)),
    };
  }
  const firstMonth = quarterIndex * 3 + 1;
  const lastMonth = firstMonth + 2;
  return {
    start: makeDate(year, firstMonth, 1),
    end: makeDate(year, lastMonth, daysInMonth(year, lastMonth)),
  };
}

// Дата задачи внутри периода: начало, середина, конец, число месяца
// или день недели. Середина недели — среда, месяца — 15-е,
// квартала — 15-е среднего месяца.
function periodDate(kind, bounds, position, day) {
  if (position === 'start') return bounds.start;
  if (position === 'end') return bounds.end;

  const [year, month] = bounds.start.split('-').map(Number);

  if (position === 'middle') {
    if (kind === 'week') return addDays(bounds.start, 2);
    const middleMonth = kind === 'month' ? month : month + 1;
    return makeDate(year, middleMonth, 15);
  }

  // «Число месяца»: N-е число месяца периода. Если в месяце меньше дней
  // (например, 31-е в феврале), берётся последнее число месяца.
  if (position === 'dayOfMonth') {
    return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
  }

  // «День недели»: выбранный день недели внутри недели периода. Недели
  // начинаются с понедельника, день 0 — понедельник.
  return addDays(bounds.start, day);
}

// Все периоды вида kind, пересекающие диапазон from…to.
function periodsInRange(kind, from, to) {
  const periods = [];

  if (kind === 'week') {
    // Первая неделя — та, что содержит from (с понедельника).
    let weekStart = addDays(from, -weekdayIndex(from));
    while (weekStart <= to) {
      periods.push({ start: weekStart, end: addDays(weekStart, 6) });
      weekStart = addDays(weekStart, 7);
    }
    return periods;
  }

  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));

  if (kind === 'month') {
    while (makeDate(year, month, 1) <= to) {
      periods.push(periodBounds('month', year, month, 0));
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return periods;
  }

  // Кварталы: перечисляются от квартала, содержащего from, до квартала to.
  let quarter = Math.floor((month - 1) / 3);
  let bounds = periodBounds('quarter', year, 0, quarter);
  while (bounds.start <= to) {
    periods.push(bounds);
    quarter += 1;
    if (quarter > 3) {
      quarter = 0;
      year += 1;
    }
    bounds = periodBounds('quarter', year, 0, quarter);
  }
  return periods;
}

// Применение к клиенту на период (FR-42, AC-42).
function apply(db, checklist, clientId, from, to) {
  const selected = [];
  let skipped = 0;

  for (const item of checklist.items) {
    let dates = [];

    if (item.date !== null) {
      dates = [item.date];
    } else if (item.period !== null) {
      // Дата задачи — положение внутри каждого периода, попавшего
      // в диапазон применения.
      dates = periodsInRange(item.period, from, to)
        .map((bounds) => periodDate(item.period, bounds, item.periodPos, item.periodDay));
    } else {
      // Пункт без привязки — на начало периода применения.
      dates = [from];
    }

    // Единое правило: задача создаётся, только если её дата входит
    // в период применения.
    for (const date of dates) {
      if (date < from || date > to) {
        skipped += 1;
        continue;
      }
      selected.push({ title: item.text, date, origin: 'manual' });
    }
  }

  if (selected.length === 0) {
    return { created: 0, skipped, tasks: [] };
  }

  const created = tasks.createMany(db, clientId, from, selected);
  return { created: created.length, skipped, tasks: created };
}

module.exports = {
  list,
  get,
  normalize,
  validate,
  create,
  update,
  remove,
  apply,
};
