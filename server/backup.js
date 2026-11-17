'use strict';

// Экспорт и импорт данных (ТЗ, раздел 6.7, FR-53…FR-55).
//
// Файл копии — обычный JSON в форме раздела 5.1 ТЗ:
//   version, clients, tasks, payments, templates, checklists, ui.
// Учётная запись и сессии в копию не попадают (раздел 5.2): перенос
// данных не должен приносить чужой пароль и открытые входы.
//
// Импорт заменяет бизнес-данные целиком и выполняется одной
// транзакцией: при любой ошибке база остаётся в прежнем состоянии
// (FR-54). Перед заменой файл проверяется, а интерфейс показывает
// количество записей в файле и текущей базе (FR-54, FR-55).

const crypto = require('node:crypto');

const { isIsoDate } = require('./dates');
const clients = require('./clients');
const tasks = require('./tasks');
const templates = require('./templates');
const payments = require('./payments');
const checklists = require('./checklists');
const settings = require('./settings');

// Версия логической схемы и файла экспорта — 1 (ТЗ, раздел 5.2).
const VERSION = 1;

const TASK_ORIGINS = ['rule', 'template', 'manual'];

const SECTION_LABELS = {
  clients: 'клиенты',
  tasks: 'задачи',
  payments: 'платежи',
  templates: 'шаблоны',
  checklists: 'чек-листы',
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

// --- Экспорт ---

function exportData(db) {
  const clientRows = db
    .prepare('SELECT id FROM clients ORDER BY archived ASC, sort_order ASC, name ASC, id ASC')
    .all();

  const clientList = clientRows.map(({ id }) => {
    const client = clients.get(db, id);
    return {
      id: client.id,
      name: client.name,
      inn: client.inn,
      form: client.form,
      sno: client.sno,
      vat: client.vat,
      vatRate: client.vatRate,
      profitAdvances: client.profitAdvances,
      vatExempt: client.vatExempt,
      hasEmployees: client.hasEmployees,
      hasLandTax: client.hasLandTax,
      hasPropertyTax: client.hasPropertyTax,
      hasTransportTax: client.hasTransportTax,
      extraFlags: client.extraFlags,
      pinned: client.pinned,
      order: client.sortOrder,
      archived: client.archived,
    };
  });

  const taskRows = db
    .prepare('SELECT id FROM tasks ORDER BY date ASC, client_id ASC, title ASC, id ASC')
    .all();

  const taskList = taskRows.map(({ id }) => {
    const task = tasks.get(db, id);
    return {
      id: task.id,
      clientId: task.clientId,
      date: task.date,
      title: task.title,
      status: task.status,
      comment: task.comment,
      origin: task.origin,
      ruleId: task.ruleId,
      dependsOn: task.dependsOn,
      paymentFilled: task.paymentFilled,
      taxLines: task.taxLines.map((taxKind) => ({ taxKind })),
    };
  });

  const paymentRows = db
    .prepare('SELECT id FROM payments ORDER BY payment_date ASC, client_id ASC, id ASC')
    .all();

  const paymentList = paymentRows.map(({ id }) => {
    const payment = payments.get(db, id);
    return {
      id: payment.id,
      clientId: payment.clientId,
      paymentDate: payment.paymentDate,
      taskId: payment.taskId,
      comment: payment.comment,
      manual: payment.manual,
      lines: payment.lines.map((line) => ({
        taxKind: line.taxKind,
        amount: line.amount,
        source: line.source,
        filingDate: line.filingDate,
      })),
    };
  });

  return {
    app: 'Планировщик бухгалтера',
    version: VERSION,
    exportedAt: new Date().toISOString(),
    clients: clientList,
    tasks: taskList,
    payments: paymentList,
    templates: templates.list(db),
    checklists: checklists.list(db),
    ui: settings.read(db),
  };
}

// Количество записей в файле — для подтверждения замены (FR-54).
function countData(file) {
  const paymentList = arrayOf(file && file.payments);
  const checklistList = arrayOf(file && file.checklists);

  return {
    clients: arrayOf(file && file.clients).length,
    tasks: arrayOf(file && file.tasks).length,
    payments: paymentList.length,
    paymentLines: paymentList.reduce((sum, payment) => sum + arrayOf(payment && payment.lines).length, 0),
    templates: arrayOf(file && file.templates).length,
    checklists: checklistList.length,
    checklistItems: checklistList.reduce((sum, checklist) => sum + arrayOf(checklist && checklist.items).length, 0),
  };
}

// Количество записей в текущей базе — рядом с количеством в файле.
function currentCounts(db) {
  const one = (sql) => db.prepare(sql).get().count;

  return {
    clients: one('SELECT COUNT(*) AS count FROM clients'),
    tasks: one('SELECT COUNT(*) AS count FROM tasks'),
    payments: one('SELECT COUNT(*) AS count FROM payments'),
    paymentLines: one('SELECT COUNT(*) AS count FROM payment_lines'),
    templates: one('SELECT COUNT(*) AS count FROM templates'),
    checklists: one('SELECT COUNT(*) AS count FROM checklists'),
    checklistItems: one('SELECT COUNT(*) AS count FROM checklist_items'),
  };
}

// --- Проверка файла ---

function validateFile(file) {
  const errors = [];

  if (!isObject(file)) {
    errors.push('Файл не похож на копию «Планировщик бухгалтера»: ожидается объект JSON');
    return errors;
  }

  // Версия проверяется первой: файл чужого формата не разбираем дальше.
  if (file.version !== VERSION) {
    errors.push(
      file.version === undefined || file.version === null
        ? 'В файле нет версии формата — это не копия «Планировщик бухгалтера»'
        : `Неподдерживаемая версия файла: ${file.version}. Поддерживается версия ${VERSION}`,
    );
    return errors;
  }

  for (const section of Object.keys(SECTION_LABELS)) {
    if (!Array.isArray(file[section])) {
      errors.push(`Раздел «${SECTION_LABELS[section]}» отсутствует или не является списком`);
    }
  }

  if (errors.length > 0) return errors;

  errors.push(...validateClients(file.clients));
  errors.push(...validateClientReferences(file));

  const taskIndex = indexTasks(file.tasks, errors);
  errors.push(...validateTaskFields(file.tasks, taskIndex));
  errors.push(...validatePayments(file.payments, taskIndex));
  errors.push(...validateTemplates(file.templates));
  errors.push(...validateChecklists(file.checklists));

  if (file.ui !== undefined && file.ui !== null) {
    errors.push(...settings.validate(file.ui).map((message) => `Настройки вида: ${message}`));
  }

  return errors;
}

function validateClients(list) {
  const errors = [];
  const ids = new Set();

  list.forEach((raw, index) => {
    const label = `Клиент ${index + 1}${raw && isText(raw.name) ? ` («${raw.name.trim()}»)` : ''}`;

    if (!isObject(raw)) {
      errors.push(`${label}: запись не является объектом`);
      return;
    }
    if (!isText(raw.id)) {
      errors.push(`${label}: нет идентификатора`);
      return;
    }
    if (ids.has(raw.id)) {
      errors.push(`${label}: повторяется идентификатор`);
      return;
    }
    ids.add(raw.id);

    if (raw.order !== undefined && !Number.isInteger(raw.order)) {
      errors.push(`${label}: порядок должен быть целым числом`);
    }
    if (raw.pinned !== undefined && typeof raw.pinned !== 'boolean') {
      errors.push(`${label}: признак закрепления должен быть «true» или «false»`);
    }
    if (raw.archived !== undefined && typeof raw.archived !== 'boolean') {
      errors.push(`${label}: признак архива должен быть «true» или «false»`);
    }

    const values = clients.normalize(raw);
    for (const message of clients.validate(values)) {
      errors.push(`${label}: ${message}`);
    }
  });

  return errors;
}

// Первый проход по задачам: идентификаторы и связь с клиентом.
function indexTasks(list, errors) {
  const index = new Map();

  list.forEach((raw, position) => {
    const label = `Задача ${position + 1}`;

    if (!isObject(raw)) {
      errors.push(`${label}: запись не является объектом`);
      return;
    }
    if (!isText(raw.id)) {
      errors.push(`${label}: нет идентификатора`);
      return;
    }
    if (index.has(raw.id)) {
      errors.push(`${label}: повторяется идентификатор`);
      return;
    }

    index.set(raw.id, typeof raw.clientId === 'string' ? raw.clientId : null);
  });

  return index;
}

function validateTaskFields(list, taskIndex) {
  const errors = [];
  const ruleKeys = new Set();

  list.forEach((raw, position) => {
    const label = `Задача ${position + 1}${isText(raw && raw.title) ? ` («${raw.title.trim()}»)` : ''}`;

    if (!isObject(raw)) return;

    if (!isText(raw.clientId)) {
      errors.push(`${label}: не указан клиент`);
    }

    if (!isIsoDate(raw.date)) {
      errors.push(`${label}: дата должна быть в формате ГГГГ-ММ-ДД`);
    }
    if (!isText(raw.title)) {
      errors.push(`${label}: не указано название`);
    } else if (raw.title.length > 300) {
      errors.push(`${label}: название длиннее 300 символов`);
    }
    if (!tasks.STATUSES.includes(raw.status)) {
      errors.push(`${label}: неизвестный статус`);
    }
    if (typeof raw.comment !== 'string' || raw.comment.length > 2000) {
      errors.push(`${label}: комментарий должен быть текстом не длиннее 2000 символов`);
    }
    if (!TASK_ORIGINS.includes(raw.origin)) {
      errors.push(`${label}: происхождение задачи должно быть rule, template или manual`);
    }
    if (raw.ruleId !== null && raw.ruleId !== undefined && typeof raw.ruleId !== 'string') {
      errors.push(`${label}: код правила должен быть строкой или быть пустым`);
    }
    if (raw.dependsOn !== null && raw.dependsOn !== undefined) {
      if (typeof raw.dependsOn !== 'string') {
        errors.push(`${label}: связанная задача должна быть строкой или быть пустой`);
      } else if (!taskIndex.has(raw.dependsOn)) {
        errors.push(`${label}: связанная задача не найдена в файле`);
      }
    }
    if (raw.paymentFilled !== undefined && typeof raw.paymentFilled !== 'boolean') {
      errors.push(`${label}: признак внесённого платежа должен быть «true» или «false»`);
    }

    if (raw.taxLines !== undefined) {
      if (!Array.isArray(raw.taxLines)) {
        errors.push(`${label}: состав налогов должен быть списком`);
      } else {
        for (const line of raw.taxLines) {
          const taxKind = typeof line === 'string' ? line : (isObject(line) ? line.taxKind : '');
          if (!isText(taxKind)) {
            errors.push(`${label}: у налога в составе нет названия`);
            break;
          }
          if (taxKind.length > 100) {
            errors.push(`${label}: название налога длиннее 100 символов`);
            break;
          }
        }
      }
    }

    // Повтор правила у клиента на ту же дату запрещён уникальным индексом (FR-24).
    if (typeof raw.ruleId === 'string' && raw.ruleId !== '') {
      const key = `${raw.clientId}\u0000${raw.date}\u0000${raw.ruleId}`;
      if (ruleKeys.has(key)) {
        errors.push(`${label}: повторяется правило у клиента на эту дату`);
      } else {
        ruleKeys.add(key);
      }
    }
  });

  return errors;
}

function validatePayments(list, taskIndex) {
  const errors = [];
  const ids = new Set();

  list.forEach((raw, position) => {
    const label = `Платёж ${position + 1}`;

    if (!isObject(raw)) {
      errors.push(`${label}: запись не является объектом`);
      return;
    }
    if (!isText(raw.id)) {
      errors.push(`${label}: нет идентификатора`);
      return;
    }
    if (ids.has(raw.id)) {
      errors.push(`${label}: повторяется идентификатор`);
      return;
    }
    ids.add(raw.id);

    if (!isText(raw.clientId)) {
      errors.push(`${label}: не указан клиент`);
    }
    if (!isIsoDate(raw.paymentDate)) {
      errors.push(`${label}: дата платежа должна быть в формате ГГГГ-ММ-ДД`);
    }
    if (typeof raw.comment !== 'string' || raw.comment.length > 2000) {
      errors.push(`${label}: комментарий должен быть текстом не длиннее 2000 символов`);
    }
    if (raw.manual !== undefined && typeof raw.manual !== 'boolean') {
      errors.push(`${label}: признак ручной записи должен быть «true» или «false»`);
    }
    if (raw.taskId !== null && raw.taskId !== undefined) {
      if (typeof raw.taskId !== 'string') {
        errors.push(`${label}: задача должна быть строкой или быть пустой`);
      } else if (!taskIndex.has(raw.taskId)) {
        errors.push(`${label}: задача не найдена в файле`);
      } else if (taskIndex.get(raw.taskId) !== raw.clientId) {
        errors.push(`${label}: задача принадлежит другому клиенту`);
      }
    }

    if (!Array.isArray(raw.lines)) {
      errors.push(`${label}: строки расшифровки должны быть списком`);
      return;
    }

    for (const line of raw.lines) {
      if (!isObject(line)) {
        errors.push(`${label}: строка расшифровки не является объектом`);
        break;
      }
      if (!isText(line.taxKind)) {
        errors.push(`${label}: у строки расшифровки нет вида налога`);
        break;
      }
      if (line.taxKind.length > 100) {
        errors.push(`${label}: название налога длиннее 100 символов`);
        break;
      }
      if (!Number.isInteger(line.amount) || line.amount < 0) {
        errors.push(`${label}: сумма — целое число рублей не меньше нуля`);
        break;
      }
      if (!payments.SOURCES.includes(line.source)) {
        errors.push(`${label}: источник суммы — уведомление, декларация или вручную`);
        break;
      }
      if (line.filingDate !== null && line.filingDate !== undefined && !isIsoDate(line.filingDate)) {
        errors.push(`${label}: дата сдачи должна быть в формате ГГГГ-ММ-ДД или быть пустой`);
        break;
      }
    }
  });

  return errors;
}

function validateTemplates(list) {
  const errors = [];
  const ids = new Set();

  list.forEach((raw, position) => {
    const label = `Шаблон ${position + 1}`;

    if (!isObject(raw)) {
      errors.push(`${label}: запись не является объектом`);
      return;
    }
    if (!isText(raw.id)) {
      errors.push(`${label}: нет идентификатора`);
      return;
    }
    if (ids.has(raw.id)) {
      errors.push(`${label}: повторяется идентификатор`);
      return;
    }
    ids.add(raw.id);

    if (!isText(raw.title)) {
      errors.push(`${label}: не указано название`);
    } else if (raw.title.length > 200) {
      errors.push(`${label}: название длиннее 200 символов`);
    }
    if (raw.builtin !== undefined && typeof raw.builtin !== 'boolean') {
      errors.push(`${label}: признак встроенного шаблона должен быть «true» или «false»`);
    }
  });

  return errors;
}

function validateChecklists(list) {
  const errors = [];
  const checklistIds = new Set();
  const itemIds = new Set();

  list.forEach((raw, position) => {
    const label = `Чек-лист ${position + 1}${raw && isText(raw.title) ? ` («${raw.title.trim()}»)` : ''}`;

    if (!isObject(raw)) {
      errors.push(`${label}: запись не является объектом`);
      return;
    }
    if (!isText(raw.id)) {
      errors.push(`${label}: нет идентификатора`);
      return;
    }
    if (checklistIds.has(raw.id)) {
      errors.push(`${label}: повторяется идентификатор`);
      return;
    }
    checklistIds.add(raw.id);

    if (!Array.isArray(raw.items)) {
      errors.push(`${label}: пункты должны быть списком`);
      return;
    }

    const values = checklists.normalize(raw);
    for (const message of checklists.validate(values)) {
      errors.push(`${label}: ${message}`);
    }

    raw.items.forEach((item, itemPosition) => {
      if (!isObject(item)) {
        errors.push(`${label}: пункт ${itemPosition + 1} не является объектом`);
        return;
      }
      if (item.id === undefined || item.id === null) return;
      if (!isText(item.id)) {
        errors.push(`${label}: у пункта ${itemPosition + 1} пустой идентификатор`);
        return;
      }
      if (itemIds.has(item.id)) {
        errors.push(`${label}: повторяется идентификатор пункта`);
        return;
      }
      itemIds.add(item.id);
    });
  });

  return errors;
}

// Проверка ссылок клиентов задач и платежей после того, как список клиентов
// собран. validateFile вызывает её отдельно, чтобы сообщения были точными.
function validateClientReferences(file) {
  const errors = [];
  const clientIds = new Set(
    file.clients
      .filter((client) => isObject(client) && isText(client.id))
      .map((client) => client.id),
  );

  file.tasks.forEach((task, position) => {
    if (isObject(task) && isText(task.clientId) && !clientIds.has(task.clientId)) {
      const label = `Задача ${position + 1}${isText(task.title) ? ` («${task.title.trim()}»)` : ''}`;
      errors.push(`${label}: клиент не найден в файле`);
    }
  });

  file.payments.forEach((payment, position) => {
    if (isObject(payment) && isText(payment.clientId) && !clientIds.has(payment.clientId)) {
      errors.push(`Платёж ${position + 1}: клиент не найден в файле`);
    }
  });

  return errors;
}

// --- Импорт ---

function prepareChecklists(list) {
  return list.map((raw) => {
    const values = checklists.normalize(raw);

    return {
      id: raw.id,
      title: values.title,
      items: values.items.map((item, index) => {
        const source = Array.isArray(raw.items) ? raw.items[index] : null;
        const id = source && isText(source.id) ? source.id : crypto.randomUUID();
        return {
          id,
          text: item.text,
          date: item.date,
          period: item.period,
          periodPos: item.periodPos,
          periodDay: item.periodDay,
        };
      }),
    };
  });
}

function prepare(file) {
  return {
    clients: file.clients.map((raw) => ({
      id: raw.id,
      values: clients.normalize(raw),
      pinned: raw.pinned === true,
      order: Number.isInteger(raw.order) ? raw.order : 0,
      archived: raw.archived === true,
    })),
    tasks: file.tasks.map((raw) => ({
      id: raw.id,
      clientId: raw.clientId,
      date: raw.date,
      title: raw.title,
      status: raw.status,
      comment: raw.comment,
      origin: raw.origin,
      ruleId: raw.ruleId === undefined ? null : raw.ruleId,
      dependsOn: raw.dependsOn === undefined ? null : raw.dependsOn,
      paymentFilled: raw.paymentFilled === true,
      taxLines: arrayOf(raw.taxLines).map((line) => (typeof line === 'string' ? line : line.taxKind)),
    })),
    payments: file.payments.map((raw) => ({
      id: raw.id,
      clientId: raw.clientId,
      paymentDate: raw.paymentDate,
      taskId: raw.taskId === undefined ? null : raw.taskId,
      comment: raw.comment,
      lines: raw.lines.map((line) => ({
        taxKind: line.taxKind,
        amount: line.amount,
        source: line.source,
        filingDate: line.filingDate === undefined ? null : line.filingDate,
      })),
    })),
    templates: file.templates.map((raw) => ({
      id: raw.id,
      title: raw.title,
      builtin: raw.builtin === true,
    })),
    checklists: prepareChecklists(file.checklists),
    ui: file.ui || {},
  };
}

function deleteBusinessData(db) {
  // Дочерние таблицы удаляются раньше родительских, чтобы внешние ключи
  // не мешали. Учётная запись, сессии и журнал схемы не трогаются.
  db.exec(`
    DELETE FROM payment_lines;
    DELETE FROM payments;
    DELETE FROM task_tax_lines;
    DELETE FROM tasks;
    DELETE FROM client_flags;
    DELETE FROM clients;
    DELETE FROM checklist_items;
    DELETE FROM checklists;
    DELETE FROM templates;
    DELETE FROM app_settings;
  `);
}

function importData(db, file) {
  const data = prepare(file);

  db.exec('BEGIN IMMEDIATE');
  try {
    deleteBusinessData(db);

    const insertClient = db.prepare(
      `INSERT INTO clients (
         id, name, inn, form, sno, vat, vat_rate, profit_advances, vat_exempt,
         has_employees, has_land_tax, has_property_tax, has_transport_tax,
         pinned, sort_order, archived
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFlag = db.prepare(
      'INSERT OR IGNORE INTO client_flags (client_id, value) VALUES (?, ?)',
    );

    for (const client of data.clients) {
      const value = client.values;
      insertClient.run(
        client.id,
        value.name,
        value.inn,
        value.form,
        value.sno,
        value.vat ? 1 : 0,
        value.vatRate,
        value.profitAdvances,
        value.vatExempt ? 1 : 0,
        value.hasEmployees ? 1 : 0,
        value.hasLandTax ? 1 : 0,
        value.hasPropertyTax ? 1 : 0,
        value.hasTransportTax ? 1 : 0,
        client.pinned ? 1 : 0,
        client.order,
        client.archived ? 1 : 0,
      );

      for (const flag of value.extraFlags) insertFlag.run(client.id, flag);
    }

    const insertTemplate = db.prepare(
      'INSERT INTO templates (id, title, builtin) VALUES (?, ?, ?)',
    );
    for (const template of data.templates) {
      insertTemplate.run(template.id, template.title, template.builtin ? 1 : 0);
    }

    const insertChecklist = db.prepare('INSERT INTO checklists (id, title) VALUES (?, ?)');
    const insertItem = db.prepare(
      `INSERT INTO checklist_items (id, checklist_id, text, date, period, period_pos, period_day)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const checklist of data.checklists) {
      insertChecklist.run(checklist.id, checklist.title);
      for (const item of checklist.items) {
        insertItem.run(
          item.id,
          checklist.id,
          item.text,
          item.date,
          item.period,
          item.periodPos,
          item.periodDay,
        );
      }
    }

    // Задачи сначала без depends_on: связанная задача может идти позже
    // в файле, а внешний ключ проверяется сразу.
    const insertTask = db.prepare(
      `INSERT INTO tasks (
         id, client_id, date, title, status, comment, origin, rule_id, depends_on, payment_filled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const linkTask = db.prepare('UPDATE tasks SET depends_on = ? WHERE id = ?');
    const insertTaxLine = db.prepare(
      'INSERT OR IGNORE INTO task_tax_lines (task_id, tax_kind) VALUES (?, ?)',
    );

    for (const task of data.tasks) {
      insertTask.run(
        task.id,
        task.clientId,
        task.date,
        task.title,
        task.status,
        task.comment,
        task.origin,
        task.ruleId,
        task.paymentFilled ? 1 : 0,
      );
    }

    for (const task of data.tasks) {
      if (task.dependsOn) linkTask.run(task.dependsOn, task.id);
      for (const taxKind of task.taxLines) insertTaxLine.run(task.id, taxKind);
    }

    const insertPayment = db.prepare(
      `INSERT INTO payments (id, client_id, payment_date, task_id, comment, manual)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertLine = db.prepare(
      `INSERT INTO payment_lines (id, payment_id, tax_kind, amount, source, filing_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const payment of data.payments) {
      insertPayment.run(
        payment.id,
        payment.clientId,
        payment.paymentDate,
        payment.taskId,
        payment.comment,
        payment.taskId ? 0 : 1,
      );

      for (const line of payment.lines) {
        insertLine.run(
          crypto.randomUUID(),
          payment.id,
          line.taxKind,
          line.amount,
          line.source,
          line.filingDate,
        );
      }
    }

    settings.write(db, data.ui);

    // Пометки «платёж внесён» — производные от реестра, поэтому
    // пересчитываются, а не берутся из файла на веру.
    payments.syncTaskMarks(db);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return countData(file);
}

// Полная проверка и применение разом: используется в тестах и там,
// где подтверждение уже получено.
function importChecked(db, file) {
  const errors = validateFile(file);
  if (errors.length > 0) return { errors };
  return { counts: importData(db, file) };
}

module.exports = {
  VERSION,
  exportData,
  countData,
  currentCounts,
  validateFile,
  validateClientReferences,
  importData,
  importChecked,
};
