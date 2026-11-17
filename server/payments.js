'use strict';

const crypto = require('node:crypto');

const { isIsoDate } = require('./dates');
const tasks = require('./tasks');

// Реестр платежей (ТЗ, разделы 5.1 и 6.9, FR-57…FR-66).
//
// Суммы налогов живут только здесь: календарная задача суммы не хранит
// (FR-36). Запись реестра — это один платёж по клиенту на дату, разбитый
// на строки расшифровки по налогам. Итог считается из строк и отдельно
// не вводится (FR-60). Суммы вводит бухгалтер: приложение их не считает
// (FR-58), единственное исключение — деление квартальной суммы НДС на
// три доли (FR-66).

const SOURCES = ['notification', 'declaration', 'manual'];

const SOURCE_LABELS = {
  notification: 'уведомление',
  declaration: 'декларация',
  manual: 'вручную',
};

// Задачи-платежи, из которых открывается «Заполнить платежи».
// Ключ — префикс кода правила. Травматизм сюда не входит: по FR-64
// его запись создаётся вручную без привязки к задаче. Отчётные
// документы без уплаты (6-НДФЛ, персональные сведения, ЕФС-1,
// бухгалтерская отчётность) кнопки не имеют (FR-65).
const PAYMENT_RULES = {
  'vat-pay:': { taxKind: 'НДС', source: 'declaration' },
  'profit-advance:': { taxKind: 'Налог на прибыль', source: 'declaration' },
  'profit-extra:': { taxKind: 'Налог на прибыль', source: 'declaration' },
  'contrib-pay:': { taxKind: 'Страховые взносы', source: 'notification' },
  'ndfl-pay:': { taxKind: 'НДФЛ', source: 'notification' },
  'land-advance:': { taxKind: 'Земельный налог', source: 'notification' },
  'land-year:': { taxKind: 'Земельный налог', source: 'notification' },
  'property-advance:': { taxKind: 'Налог на имущество', source: 'notification' },
  'property-year:': { taxKind: 'Налог на имущество', source: 'notification' },
  'extra-usn:': { taxKind: 'УСН', source: 'declaration' },
  'extra-eshn:': { taxKind: 'ЕСХН', source: 'declaration' },
};

// Уведомления: строка расшифровки появляется на каждый налог из
// состава уведомления, источник — notification, дата сдачи — дата
// самой задачи (раздел 5.1).
function isNotificationTask(task) {
  return typeof task.ruleId === 'string' && task.ruleId.startsWith('notification:');
}

function paymentRuleFor(task) {
  if (typeof task.ruleId !== 'string') return null;
  for (const [prefix, rule] of Object.entries(PAYMENT_RULES)) {
    if (task.ruleId.startsWith(prefix)) return rule;
  }
  return null;
}

// Может ли по задаче появиться запись реестра (FR-57, FR-65).
function isEligible(task) {
  return isNotificationTask(task) || paymentRuleFor(task) !== null;
}

// Данные для деления НДС: «Уплата НДС за …, 1/3» → доля 1 из 3.
function vatInfo(task) {
  if (typeof task.ruleId !== 'string' || !task.ruleId.startsWith('vat-pay:')) return null;
  const share = Number(task.ruleId.split(':')[2]);
  return Number.isInteger(share) && share >= 1 && share <= 3 ? { share } : null;
}

function isVatTask(task) {
  return vatInfo(task) !== null;
}

// Даты всех трёх сроков уплаты квартала НДС — для подсказки в форме.
function vatDates(db, task) {
  const quarter = task.ruleId.split(':')[1];
  return [1, 2, 3].map((part) => {
    const row = db
      .prepare('SELECT date FROM tasks WHERE client_id = ? AND rule_id = ?')
      .get(task.clientId, `vat-pay:${quarter}:${part}`);
    return row ? row.date : null;
  });
}

// Деление суммы НДС на три доли (FR-66): деление на три, остаток
// добавляется к третьей доле. 10000 → 3333 / 3333 / 3334.
function vatShares(amount) {
  const base = Math.floor(amount / 3);
  return [base, base, amount - base * 2];
}

// Код задачи, из которой взята дата сдачи для строки расшифровки.
// Уведомления объединяются и хранят код вида notification:ГГГГ-ММ-ДД,
// поэтому дата сдвига к ближайшему рабочему дню вычисляется здесь же,
// что и в генераторе.
function filingRuleId(task, tools) {
  const ruleId = task.ruleId;

  if (ruleId.startsWith('vat-pay:')) return `vat-decl:${ruleId.split(':')[1]}`;
  if (ruleId.startsWith('profit-extra:')) return `profit-decl:${ruleId.split(':')[1]}`;
  if (ruleId.startsWith('extra-usn:')) return `usn-decl:${ruleId.split(':')[1]}`;
  if (ruleId.startsWith('extra-eshn:')) return `eshn-decl:${ruleId.split(':')[1]}`;

  if (ruleId.startsWith('ndfl-pay:')) {
    const [, period, half] = ruleId.split(':');
    const [year, month] = period.split('-').map(Number);
    const date = half === '2'
      ? (month === 12 ? tools.lastWorkingDayOfYear(year) : shifted(nextMonthDate(year, month), tools))
      : shifted(makeDateSafe(year, month, 25), tools);
    return `notification:${date}`;
  }

  if (ruleId.startsWith('contrib-pay:')) {
    // Уведомления по взносам подаются за первые два месяца квартала
    // (раздел 8.3.1). За третий месяц уведомления нет — даты сдачи нет.
    const period = ruleId.split(':')[1];
    const due = CONTRIB_NOTIFICATION_DUE[period];
    return due ? `notification:${shifted(due, tools)}` : null;
  }

  if (ruleId.startsWith('land-') || ruleId.startsWith('property-')) {
    const suffix = ruleId.split(':')[1];
    const due = TAX_NOTIFICATION_DUE[suffix];
    return due ? `notification:${shifted(due, tools)}` : null;
  }

  // Ежемесячные авансы по прибыли считаются по декларации квартала,
  // после которой они уплачиваются (раздел 8.4).
  if (ruleId.startsWith('profit-advance:')) {
    const month = ruleId.split(':')[1];
    const group = PROFIT_ADVANCE_GROUPS.find((item) => item.months.includes(month));
    return group ? group.filing : null;
  }

  return null;
}

// Даты подачи уведомлений — те же, что в генераторе (rules.js).
const CONTRIB_NOTIFICATION_DUE = {
  '2026-10': '2026-11-25',
  '2026-11': '2026-12-25',
  '2027-01': '2027-02-25',
  '2027-02': '2027-03-25',
};

const TAX_NOTIFICATION_DUE = {
  '2026-Q3': '2026-10-25',
  '2026': '2027-02-25',
  '2027-Q1': '2027-04-25',
};

function nextMonthDate(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function makeDateSafe(year, month, day) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function shifted(iso, tools) {
  return tools.shiftToNextWorkingDay(iso);
}

// --- Записи реестра ---

function readLines(db, paymentId) {
  return db
    .prepare(
      `SELECT tax_kind, amount, source, filing_date
         FROM payment_lines WHERE payment_id = ? ORDER BY rowid`,
    )
    .all(paymentId)
    .map((row) => ({
      taxKind: row.tax_kind,
      amount: row.amount,
      source: row.source,
      filingDate: row.filing_date,
    }));
}

function toPayment(db, row) {
  const lines = readLines(db, row.id);
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name || undefined,
    paymentDate: row.payment_date,
    taskId: row.task_id,
    comment: row.comment,
    manual: row.manual === 1,
    lines,
    total: lines.reduce((sum, line) => sum + line.amount, 0),
  };
}

function get(db, id) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`,
    )
    .get(id);
  return row ? toPayment(db, row) : null;
}

function findByDate(db, clientId, paymentDate) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE p.client_id = ? AND p.payment_date = ?`,
    )
    .get(clientId, paymentDate);
  return row ? toPayment(db, row) : null;
}

function findByTask(db, taskId) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE p.task_id = ?`,
    )
    .get(taskId);
  return row ? toPayment(db, row) : null;
}

// Реестр с фильтрами по дате и виду налога (FR-62) и итогами по дате
// и по клиенту (FR-63).
function list(db, filters = {}) {
  const conditions = ['1 = 1'];
  const params = [];

  if (filters.clientId) {
    conditions.push('p.client_id = ?');
    params.push(filters.clientId);
  }
  if (filters.from) {
    conditions.push('p.payment_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('p.payment_date <= ?');
    params.push(filters.to);
  }

  const rows = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.payment_date ASC, c.name ASC, p.id ASC`,
    )
    .all(...params);

  // Виды налогов для фильтра собираются по записям без учёта дат и
  // вида налога: иначе после сужения поиска часть видов пропадает.
  const taxScope = db
    .prepare(
      `SELECT p.id FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE ${filters.clientId ? 'p.client_id = ?' : '1 = 1'}`,
    )
    .all(...(filters.clientId ? [filters.clientId] : []));

  let payments = rows.map((row) => toPayment(db, row));

  // Фильтр по виду налога: остаются платежи, у которых такой налог
  // есть хотя бы в одной строке расшифровки.
  if (filters.taxKind) {
    payments = payments.filter((payment) =>
      payment.lines.some((line) => line.taxKind === filters.taxKind));
  }

  const taxKinds = [...new Set(
    taxScope.flatMap((row) => readLines(db, row.id).map((line) => line.taxKind)),
  )].sort((a, b) => a.localeCompare(b, 'ru'));

  const byDateMap = new Map();
  const byClientMap = new Map();
  let grand = 0;

  for (const payment of payments) {
    grand += payment.total;
    byDateMap.set(payment.paymentDate, (byDateMap.get(payment.paymentDate) || 0) + payment.total);

    const entry = byClientMap.get(payment.clientId) || { clientId: payment.clientId, name: payment.clientName, total: 0 };
    entry.total += payment.total;
    byClientMap.set(payment.clientId, entry);
  }

  return {
    payments,
    taxKinds,
    totals: {
      byDate: [...byDateMap.entries()]
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
      byClient: [...byClientMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      grand,
    },
  };
}

// --- Проверка ввода ---

function normalize(input) {
  const raw = input || {};

  return {
    clientId: typeof raw.clientId === 'string' ? raw.clientId.trim() : '',
    paymentDate: typeof raw.paymentDate === 'string' ? raw.paymentDate.trim() : '',
    taskId: typeof raw.taskId === 'string' ? raw.taskId.trim() : null,
    comment: typeof raw.comment === 'string' ? raw.comment.trim() : '',
    replace: raw.replace === true,
    lines: Array.isArray(raw.lines) ? raw.lines.map((line) => ({
      taxKind: typeof line.taxKind === 'string' ? line.taxKind.trim() : '',
      amount: line.amount,
      source: typeof line.source === 'string' ? line.source.trim() : '',
      filingDate: line.filingDate === null || line.filingDate === undefined
        ? null
        : (typeof line.filingDate === 'string' ? line.filingDate.trim() : line.filingDate),
    })) : [],
  };
}

function validate(values) {
  const errors = [];

  if (!values.clientId) errors.push('Укажите клиента');
  if (!isIsoDate(values.paymentDate)) {
    errors.push('Дата платежа должна быть в формате ГГГГ-ММ-ДД');
  }
  if (values.comment.length > 2000) errors.push('Комментарий длиннее 2000 символов');
  if (values.lines.length === 0) errors.push('Добавьте хотя бы одну строку расшифровки');

  for (const line of values.lines) {
    if (!line.taxKind) {
      errors.push('Укажите вид налога в каждой строке');
      break;
    }
    if (line.taxKind.length > 100) {
      errors.push('Название налога длиннее 100 символов');
      break;
    }
  }

  for (const line of values.lines) {
    if (!Number.isInteger(line.amount) || line.amount < 0) {
      errors.push('Сумма — целое число рублей не меньше нуля');
      break;
    }
  }

  for (const line of values.lines) {
    if (!SOURCES.includes(line.source)) {
      errors.push('Источник суммы: уведомление, декларация или вручную');
      break;
    }
    if (line.filingDate !== null && !isIsoDate(line.filingDate)) {
      errors.push('Дата сдачи должна быть в формате ГГГГ-ММ-ДД или быть пустой');
      break;
    }
  }

  return errors;
}

// --- Запись ---

function writeLines(db, paymentId, lines) {
  const insert = db.prepare(
    `INSERT INTO payment_lines (id, payment_id, tax_kind, amount, source, filing_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const line of lines) {
    insert.run(crypto.randomUUID(), paymentId, line.taxKind, line.amount, line.source, line.filingDate);
  }
}

// Пометка «платёж внесён в реестр» на задачах (FR-57).
//
// Запись реестра — платёж одной задачи (FR-64): запись, привязанная
// к задаче, отмечает именно её. Ручная запись без задачи (например,
// травматизм или транспортный налог) отмечает все задачи своего
// налога на дату платежа — срок уплаты у них общий. Пометки
// пересчитываются после каждого изменения реестра и при старте.
function taskKinds(task) {
  return isNotificationTask(task) ? task.taxLines : [paymentRuleFor(task).taxKind];
}

function syncTaskMarks(db) {
  db.prepare('UPDATE tasks SET payment_filled = 0').run();

  const payments = db.prepare('SELECT id, client_id, payment_date, task_id FROM payments').all();
  const mark = db.prepare('UPDATE tasks SET payment_filled = 1 WHERE id = ?');
  const onDate = db.prepare('SELECT * FROM tasks WHERE client_id = ? AND date = ?');

  for (const payment of payments) {
    if (payment.task_id) {
      mark.run(payment.task_id);
      continue;
    }

    const kinds = new Set(readLines(db, payment.id).map((line) => line.taxKind));
    for (const row of onDate.all(payment.client_id, payment.payment_date)) {
      const task = tasks.get(db, row.id);
      if (!isEligible(task)) continue;
      if (taskKinds(task).some((kind) => kinds.has(kind))) mark.run(task.id);
    }
  }
}

// Запись платежа без транзакции: создание или замена записи задачи.
// Запись реестра — это платёж одной задачи (FR-64), поэтому платежи
// разных задач одной даты живут разными записями. Транзакцию и
// пересчёт пометок организует вызывающая функция.
function upsert(db, values) {
  const target = conflictFor(db, values);
  let paymentId;

  if (target) {
    paymentId = target.id;
    db.prepare('DELETE FROM payment_lines WHERE payment_id = ?').run(paymentId);
    db.prepare(
      'UPDATE payments SET payment_date = ?, task_id = ?, comment = ?, manual = ? WHERE id = ?',
    ).run(values.paymentDate, values.taskId, values.comment, values.taskId ? 0 : 1, paymentId);
  } else {
    paymentId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO payments (id, client_id, payment_date, task_id, comment, manual)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(paymentId, values.clientId, values.paymentDate, values.taskId, values.comment, values.taskId ? 0 : 1);
  }

  writeLines(db, paymentId, values.lines);
  return { paymentId, replaced: Boolean(target) };
}

// Повторное заполнение: запись уже есть у этой задачи, а для ручных
// записей — на эту дату без привязки к задаче (FR-61).
function conflictFor(db, values) {
  if (values.taskId) return findByTask(db, values.taskId);
  return findManualByDate(db, values.clientId, values.paymentDate);
}

function findManualByDate(db, clientId, paymentDate) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE p.client_id = ? AND p.payment_date = ? AND p.task_id IS NULL`,
    )
    .get(clientId, paymentDate);
  return row ? toPayment(db, row) : null;
}

// Создаёт запись или заменяет существующую. Повторное заполнение
// требует подтверждения через replace (FR-61): без него возвращается
// конфликт, данные не меняются. На задачу — одна запись (FR-64).
function create(db, values, options = {}) {
  const conflict = conflictFor(db, values);
  if (conflict && !options.replace) {
    return { conflict };
  }

  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    result = upsert(db, values);
    syncTaskMarks(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { payment: get(db, result.paymentId), replaced: result.replaced };
}

// --- Фиксация платежей на несколько сроков (FR-66) ---

// Группы ежемесячных авансов по налогу на прибыль: три аванса,
// вытекающих из одной декларации квартала (раздел 8.4). Не все
// задачи группы попадают в горизонт генерации — фиксируются те,
// что есть в календаре.
const PROFIT_ADVANCE_GROUPS = [
  { months: ['2026-10', '2026-11', '2026-12'], filing: 'profit-decl:2026-9m' },
  { months: ['2027-01', '2027-02', '2027-03'], filing: 'profit-decl:2026' },
  { months: ['2027-04', '2027-05', '2027-06'], filing: 'profit-decl:2027-Q1' },
];

function profitGroupFor(task) {
  if (typeof task.ruleId !== 'string' || !task.ruleId.startsWith('profit-advance:')) return null;
  const month = task.ruleId.split(':')[1];
  return PROFIT_ADVANCE_GROUPS.find((group) => group.months.includes(month)) || null;
}

function profitAdvanceTasks(db, task) {
  const group = profitGroupFor(task);
  if (!group) return [];

  const found = [];
  for (const month of group.months) {
    const row = db
      .prepare('SELECT id FROM tasks WHERE client_id = ? AND rule_id = ?')
      .get(task.clientId, `profit-advance:${month}`);
    if (row) found.push(tasks.get(db, row.id));
  }
  return found;
}

// Общая часть фиксации: одна запись на задачу-срок с её суммой.
function fixInstallments(db, task, siblings, amounts, values, options = {}) {
  const conflicts = [];
  for (const sibling of siblings) {
    const conflict = conflictFor(db, {
      clientId: task.clientId,
      paymentDate: sibling.date,
      taskId: sibling.id,
    });
    if (conflict) conflicts.push(conflict);
  }

  if (conflicts.length > 0 && !options.replace) {
    return { conflicts };
  }

  const payments = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [index, sibling] of siblings.entries()) {
      const result = upsert(db, {
        clientId: task.clientId,
        paymentDate: sibling.date,
        taskId: sibling.id,
        comment: values.comment,
        lines: [{
          taxKind: values.taxKind,
          amount: amounts[index],
          source: values.source,
          filingDate: values.filingDate,
        }],
      });
      payments.push(get(db, result.paymentId));
    }
    syncTaskMarks(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { payments };
}

// Фиксация всех трёх долей НДС сразу (FR-66): по одной записи реестра
// на каждый из трёх сроков уплаты квартала, суммы — доли квартальной
// суммы. Так доли не приходится вводить заново при наступлении срока.
function createVatInstallments(db, task, values, options = {}) {
  const quarter = task.ruleId.split(':')[1];
  const siblings = [];

  for (let part = 1; part <= 3; part += 1) {
    const row = db
      .prepare('SELECT id FROM tasks WHERE client_id = ? AND rule_id = ?')
      .get(task.clientId, `vat-pay:${quarter}:${part}`);
    if (!row) return { error: 'Не найдены задачи всех трёх частей НДС за квартал' };
    siblings.push(tasks.get(db, row.id));
  }

  const shares = vatShares(values.amount);
  const result = fixInstallments(db, task, siblings, shares, {
    taxKind: 'НДС',
    source: 'declaration',
    filingDate: values.filingDate,
    comment: values.comment,
  }, options);

  return result.error || result.conflicts ? result : { shares, payments: result.payments };
}

// Фиксация трёх ежемесячных авансов по прибыли: сумма заполняется
// один раз и повторяется на каждый срок (раздел 8.4). Отличие от НДС:
// там квартальная сумма делится на три, здесь сумма месяца повторяется.
function createProfitAdvances(db, task, values, options = {}) {
  const siblings = profitAdvanceTasks(db, task);
  if (siblings.length === 0) {
    return { error: 'Не найдены задачи авансов по налогу на прибыль' };
  }

  const amounts = siblings.map(() => values.amount);
  const result = fixInstallments(db, task, siblings, amounts, {
    taxKind: 'Налог на прибыль',
    source: 'declaration',
    filingDate: values.filingDate,
    comment: values.comment,
  }, options);

  return result.error || result.conflicts ? result : { payments: result.payments };
}

function remove(db, id) {
  const payment = get(db, id);
  if (!payment) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    syncTaskMarks(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return true;
}

// Форма «Заполнить платежи» для задачи (FR-57…FR-59).
// Уведомление даёт строку на каждый налог состава, платёжная задача —
// одну строку. Дата сдачи берётся из связанной задачи-документа, суммы
// остаются пустыми: их вводит бухгалтер.
function defaultLinesFor(db, task, tools) {
  const lines = [];

  if (isNotificationTask(task)) {
    for (const taxKind of task.taxLines) {
      lines.push({ taxKind, amount: 0, source: 'notification', filingDate: task.date });
    }
    return lines;
  }

  const rule = paymentRuleFor(task);
  const filingRule = filingRuleId(task, tools);
  const filingTask = filingRule
    ? db.prepare('SELECT date FROM tasks WHERE client_id = ? AND rule_id = ?').get(task.clientId, filingRule)
    : null;

  lines.push({
    taxKind: rule.taxKind,
    amount: 0,
    source: rule.source,
    filingDate: filingTask ? filingTask.date : null,
  });
  return lines;
}

// Запись реестра — платёж одной задачи (FR-64): платежи разных задач
// одной даты уплаты остаются разными записями и не затирают друг друга.
function formFor(db, task, tools) {
  const existing = findByTask(db, task.id);
  const defaults = defaultLinesFor(db, task, tools);
  const group = profitGroupFor(task);

  return {
    task: { id: task.id, clientId: task.clientId, title: task.title, date: task.date },
    paymentDate: existing ? existing.paymentDate : task.date,
    comment: existing ? existing.comment : '',
    lines: existing ? existing.lines : defaults,
    existing: existing ? { id: existing.id, paymentDate: existing.paymentDate, taskId: existing.taskId } : null,
    vat: vatInfo(task) ? { ...vatInfo(task), dates: vatDates(db, task) } : null,
    profit: group ? { dates: profitAdvanceTasks(db, task).map((item) => item.date) } : null,
    sources: SOURCES.map((id) => ({ id, label: SOURCE_LABELS[id] })),
  };
}

// Нормализация записей, созданных до правила «одна запись — один
// платёж задачи»: запись со строками разных налогов разбивается на
// записи своих задач. Строки без подходящей задачи остаются в
// ручной записи без привязки. Выполняется при старте, повторный
// запуск ничего не меняет.
function normalizeLegacyRecords(db) {
  const rows = db.prepare('SELECT * FROM payments').all();

  for (const row of rows) {
    const record = toPayment(db, row);
    if (record.lines.length < 2) continue;

    // Строка достаётся задаче своего налога на эту дату; при
    // нескольких кандидатах — задаче, из которой запись создавалась,
    // иначе остаётся без привязки.
    const byTask = new Map();

    for (const line of record.lines) {
      let owner = null;
      const candidates = db
        .prepare('SELECT * FROM tasks WHERE client_id = ? AND date = ?')
        .all(record.clientId, record.paymentDate)
        .map((taskRow) => tasks.get(db, taskRow.id))
        .filter((task) => isEligible(task) && taskKinds(task).includes(line.taxKind));

      if (candidates.some((task) => task.id === record.taskId)) owner = record.taskId;
      else if (candidates.length === 1) owner = candidates[0].id;

      const key = owner || '';
      if (!byTask.has(key)) byTask.set(key, []);
      byTask.get(key).push(line);
    }

    if (byTask.size < 2) continue;

    db.prepare('DELETE FROM payments WHERE id = ?').run(record.id);

    for (const [owner, lines] of byTask) {
      const paymentId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO payments (id, client_id, payment_date, task_id, comment, manual)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(paymentId, record.clientId, record.paymentDate, owner || null, record.comment, owner ? 0 : 1);
      writeLines(db, paymentId, lines);
    }
  }
}

module.exports = {
  SOURCES,
  isEligible,
  isVatTask,
  vatShares,
  formFor,
  list,
  get,
  findByDate,
  findByTask,
  normalize,
  validate,
  create,
  createVatInstallments,
  createProfitAdvances,
  remove,
  syncTaskMarks,
  normalizeLegacyRecords,
};
