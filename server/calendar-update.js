'use strict';

// Обновление календаря нерабочих дней (ТЗ, раздел 6.12, FR-71…FR-79).
//
// Два способа обновления: данные с сайтов (FR-71…FR-75) и файл, заполненный
// по шаблону (FR-76…FR-78). Оба применяются только после проверки FR-73 и
// оставляют запись в журнале calendar_updates (FR-79). После применения
// пересчитываются даты задач, созданных по правилам (FR-75).

const crypto = require('node:crypto');

const calendar = require('./calendar');
const clients = require('./clients');
const rules = require('./rules');
const { createDateTools } = require('./dates');

const LIST_KINDS = [
  ['holidays', 'нерабочие дни'],
  ['workingSaturdays', 'рабочие субботы'],
  ['shortDays', 'сокращённые дни'],
];

// --- Проверка входных данных ---

function checkYears(years, options = {}) {
  const errors = [];

  if (!years || typeof years !== 'object' || Array.isArray(years)) {
    errors.push('Нет блока лет «years»');
    return errors;
  }

  const entries = Object.entries(years);
  if (entries.length === 0) {
    errors.push('Нет ни одного года: блок «years» пуст');
    return errors;
  }
  if (entries.length > 5) {
    errors.push('За один раз можно загрузить не больше пяти лет');
    return errors;
  }

  for (const [yearKey, block] of entries) {
    if (!/^\d{4}$/.test(yearKey)) {
      errors.push(`Год «${yearKey}» записан неверно: нужно четыре цифры`);
      continue;
    }
    const year = Number(yearKey);
    if (year < 2000 || year > 2100) {
      errors.push(`Год «${yearKey}» вне допустимого диапазона 2000…2100`);
    }
    for (const [field, name] of LIST_KINDS) {
      const list = block && block[field];
      if (list !== undefined && !Array.isArray(list)) {
        errors.push(`${yearKey}: поле «${name}» должно быть списком дат`);
      }
    }
  }

  errors.push(...calendar.validateCalendar(years, options));
  return [...new Set(errors)];
}

// Нормализованные данные лет: только дни, которые меняют поведение
// календаря (см. calendar.canonicalYearBlock).
function canonicalYears(years) {
  const out = {};
  for (const [yearKey, block] of Object.entries(years || {})) {
    out[yearKey] = calendar.canonicalYearBlock(block, Number(yearKey));
  }
  return out;
}

function checksumYears(years) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalYears(years)))
    .digest('hex');
}

// --- Сверка двух источников (FR-72) ---

function compareSourceYears(left, right) {
  const differences = [];
  const leftYears = canonicalYears(left);
  const rightYears = canonicalYears(right);
  const years = [...new Set([...Object.keys(leftYears), ...Object.keys(rightYears)])].sort();

  for (const year of years) {
    const a = leftYears[year];
    const b = rightYears[year];

    if (!a) {
      differences.push({ year, kind: 'year', date: null, left: false, right: true });
      continue;
    }
    if (!b) {
      differences.push({ year, kind: 'year', date: null, left: true, right: false });
      continue;
    }

    for (const [field] of LIST_KINDS) {
      const setA = new Set(a[field]);
      const setB = new Set(b[field]);

      for (const iso of [...setA].sort()) {
        if (!setB.has(iso)) {
          differences.push({ year, kind: field, date: iso, left: true, right: false });
        }
      }
      for (const iso of [...setB].sort()) {
        if (!setA.has(iso)) {
          differences.push({ year, kind: field, date: iso, left: false, right: true });
        }
      }
    }
  }

  return differences;
}

// --- Что изменится в текущем календаре ---

function diffYears(currentYears, nextYears) {
  const current = canonicalYears(currentYears);
  const next = canonicalYears(nextYears);
  const years = [...new Set([...Object.keys(current), ...Object.keys(next)])].sort();

  return years.map((year) => {
    const before = current[year];
    const after = next[year];
    const change = { year, status: 'same', added: {}, removed: {}, counts: {} };

    let changed = false;

    for (const [field] of LIST_KINDS) {
      const beforeSet = new Set(before ? before[field] : []);
      const afterSet = new Set(after ? after[field] : []);
      const added = [...afterSet].filter((iso) => !beforeSet.has(iso)).sort();
      const removed = [...beforeSet].filter((iso) => !afterSet.has(iso)).sort();

      change.added[field] = added;
      change.removed[field] = removed;
      change.counts[field] = afterSet.size;
      if (added.length > 0 || removed.length > 0) changed = true;
    }

    if (!before && after) change.status = 'new';
    else if (before && !after) change.status = 'removed';
    else if (changed) change.status = 'changed';

    return change;
  });
}

// --- Пересчёт дат задач по правилам (FR-75) ---
//
// Даты считаются заново для новых и прежних данных календаря, и задача
// находит свою новую дату по правилу, а не по дню. Задачи в статусах
// «сделано» и «отправлено», ручные задачи и задачи из шаблонов не двигаются.

function notificationSignature(item) {
  const parts = (item.components || [])
    .map((component) => `${component.taxKind}|${component.label}`)
    .sort();
  if (parts.length > 0) return parts.join('::');
  return (item.taxLines || []).slice().sort().join('|');
}

function previewByKey(preview) {
  const byKey = new Map();
  const bySignature = new Map();

  for (const group of preview.groups) {
    for (const item of group.items) {
      byKey.set(item.key, item);
      if (item.key.startsWith('notification:')) {
        bySignature.set(notificationSignature(item), item);
      }
    }
  }

  return { byKey, bySignature };
}

function planTaskShifts(db, nextCalendar) {
  const currentCalendar = calendar.loadCalendar();
  const oldTools = createDateTools(currentCalendar);
  const newTools = createDateTools(nextCalendar);

  const moves = [];
  const skipped = [];

  for (const client of db.prepare('SELECT id FROM clients ORDER BY name ASC').all()) {
    const clientValues = clients.get(db, client.id);
    if (!clientValues) continue;

    const oldPreview = previewByKey(rules.buildPreview(clientValues, oldTools));
    const newPreview = previewByKey(rules.buildPreview(clientValues, newTools));

    const rows = db
      .prepare("SELECT * FROM tasks WHERE client_id = ? AND origin = 'rule'")
      .all(client.id);

    for (const row of rows) {
      if (row.status === 'done' || row.status === 'sent') continue;

      const oldItem = oldPreview.byKey.get(row.rule_id);
      if (!oldItem) continue;

      const target = row.rule_id.startsWith('notification:')
        ? newPreview.bySignature.get(notificationSignature(oldItem))
        : newPreview.byKey.get(oldItem.key);

      if (!target || target.date === oldItem.date) continue;

      const clash = db
        .prepare('SELECT id FROM tasks WHERE client_id = ? AND date = ? AND rule_id = ?')
        .get(client.id, target.date, target.key);

      if (clash && clash.id !== row.id) {
        skipped.push({
          client: clientValues.name,
          title: row.title,
          from: row.date,
          to: target.date,
          reason: 'на новую дату уже есть задача с таким же правилом',
        });
        continue;
      }

      moves.push({
        taskId: row.id,
        client: clientValues.name,
        title: row.title,
        from: row.date,
        to: target.date,
        ruleId: target.key,
      });
    }
  }

  moves.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  skipped.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  return { moves, skipped };
}

// --- Журнал обновлений (FR-79) ---

function recordUpdate(db, meta) {
  const row = {
    id: crypto.randomUUID(),
    applied_at: new Date().toISOString(),
    source_a: meta.sourceA,
    source_b: meta.sourceB || '',
    years: JSON.stringify(meta.years),
    checksum: checksumYears(meta.years),
    status: 'applied',
    note: meta.note || '',
  };

  db
    .prepare(
      `INSERT INTO calendar_updates (id, applied_at, source_a, source_b, years, checksum, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.applied_at, row.source_a, row.source_b, row.years, row.checksum, row.status, row.note);

  return row;
}

function listUpdates(db, limit = 10) {
  return db
    .prepare('SELECT * FROM calendar_updates ORDER BY applied_at DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(limit) || 10, 100)))
    .map((row) => ({
      id: row.id,
      appliedAt: row.applied_at,
      sourceA: row.source_a,
      sourceB: row.source_b,
      years: JSON.parse(row.years),
      checksum: row.checksum,
      status: row.status,
      note: row.note,
    }));
}

// --- Применение нового календаря ---
//
// Порядок: проверка, план пересчёта задач, запись файла календаря,
// транзакция с задачами и журналом. При ошибке базы прежний файл
// календаря возвращается на место.

function applyCalendar(db, nextCalendar, meta, options = {}) {
  const errors = checkYears(nextCalendar.years, options);
  if (errors.length > 0) {
    throw new Error(`Календарь не принят: ${errors.join('; ')}`);
  }

  const normalized = {
    version: 1,
    years: canonicalYears(nextCalendar.years),
  };

  const plan = planTaskShifts(db, normalized);
  const previous = calendar.loadCalendar();

  calendar.saveCalendarAtomic(normalized);

  db.exec('BEGIN IMMEDIATE');
  try {
    const moveTask = db.prepare('UPDATE tasks SET date = ?, rule_id = ? WHERE id = ?');

    for (const move of plan.moves) {
      moveTask.run(move.to, move.ruleId, move.taskId);
    }

    const update = recordUpdate(db, {
      sourceA: meta.sourceA,
      sourceB: meta.sourceB || null,
      years: normalized.years,
      note: meta.note || '',
    });
    db.exec('COMMIT');

    return { update, moves: plan.moves, skipped: plan.skipped, years: normalized.years };
  } catch (error) {
    db.exec('ROLLBACK');
    calendar.saveCalendarAtomic(previous);
    throw error;
  }
}

module.exports = {
  LIST_KINDS,
  checkYears,
  canonicalYears,
  checksumYears,
  compareSourceYears,
  diffYears,
  planTaskShifts,
  recordUpdate,
  listUpdates,
  applyCalendar,
};
