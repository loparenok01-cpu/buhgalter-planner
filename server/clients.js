'use strict';

const crypto = require('node:crypto');

// Клиенты (ТЗ, раздел 6.2).
// Карточка сохраняется только целиком и только заполненной (FR-21):
// черновиков в приложении нет.

const FORMS = ['ООО', 'ИП'];
const SNO_LIST = ['ОСНО', 'УСН', 'ЕСХН', 'ПСН', 'НПД', 'АУСН'];
const VAT_RATES = [0, 5, 7, 10, 22];
const PROFIT_ADVANCES = ['none', 'quarterly', 'monthly'];

// Системы, которые не являются плательщиками НДС (FR-56).
const NON_VAT_SNO = ['ПСН', 'АУСН', 'НПД'];

// Системы, на которых возможно освобождение от НДС (FR-56).
const VAT_EXEMPT_SNO = ['УСН', 'ЕСХН'];

// Готовые пункты «Дополнительно» (FR-15). Пользовательские пункты на подбор
// отчётности не влияют (FR-16) — это только пометки для бухгалтера.
const BUILTIN_FLAGS = [
  'Платит НДС',
  'Есть сотрудники',
  'Платит транспортный налог',
  'Ведётся в 1С',
];

function normalize(input) {
  const raw = input || {};

  return {
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    inn: typeof raw.inn === 'string' ? raw.inn.trim() : '',
    form: typeof raw.form === 'string' ? raw.form.trim() : '',
    sno: typeof raw.sno === 'string' ? raw.sno.trim() : '',
    vat: typeof raw.vat === 'boolean' ? raw.vat : null,
    vatRate: raw.vatRate === null || raw.vatRate === undefined ? null : Number(raw.vatRate),
    vatExempt: raw.vatExempt === true,
    profitAdvances: typeof raw.profitAdvances === 'string' ? raw.profitAdvances : 'none',
    hasEmployees: raw.hasEmployees === true,
    hasLandTax: raw.hasLandTax === true,
    hasPropertyTax: raw.hasPropertyTax === true,
    hasTransportTax: raw.hasTransportTax === true,
    extraFlags: Array.isArray(raw.extraFlags)
      ? [...new Set(raw.extraFlags.filter((flag) => typeof flag === 'string' && flag.trim() !== '').map((flag) => flag.trim()))]
      : [],
  };
}

// Проверка карточки. Возвращает список всех замечаний сразу (FR-21):
// пользователь должен увидеть всё незаполненное за один раз.
function validate(client) {
  const errors = [];
  const empty = [];

  if (!client.name) empty.push('Название');
  if (!client.form) empty.push('Форма клиента');
  if (!client.sno) empty.push('Система налогообложения');
  if (!client.inn) empty.push('ИНН');

  if (empty.length > 0) {
    errors.push(`Не заполнены обязательные поля: ${empty.join(', ')}`);
  }

  if (client.form && !FORMS.includes(client.form)) {
    errors.push('Форма клиента: только ИП или ООО');
  }

  if (client.sno && !SNO_LIST.includes(client.sno)) {
    errors.push('Система налогообложения: выберите значение из списка');
  }

  if (client.inn) {
    if (!/^\d+$/.test(client.inn)) {
      errors.push('ИНН принимает только цифры');
    } else if (client.form === 'ИП' || client.form === 'ООО') {
      const expected = client.form === 'ИП' ? 12 : 10;
      if (client.inn.length !== expected) {
        errors.push(`ИНН должен содержать ровно ${expected} цифр для ${client.form}`);
      }
    }
  }

  if (client.vat === null) {
    errors.push('Укажите признак «платит НДС» — «да» или «нет»');
  }

  if (client.vat === true && (client.vatRate === null || !VAT_RATES.includes(client.vatRate))) {
    errors.push('Укажите ставку НДС: 22, 10, 7, 5 или 0');
  }

  if (client.vat === false && client.vatRate !== null) {
    errors.push('Ставка НДС заполняется только при признаке «платит НДС» = «да»');
  }

  if (!PROFIT_ADVANCES.includes(client.profitAdvances)) {
    errors.push('Авансы по прибыли: выберите значение из списка');
  }

  // Согласованность параметров (FR-56).
  if (client.vat === true && NON_VAT_SNO.includes(client.sno)) {
    errors.push(
      `Система налогообложения ${client.sno} не является плательщиком НДС. Снимите признак «платит НДС»`,
    );
  }

  if (client.vatExempt) {
    if (!VAT_EXEMPT_SNO.includes(client.sno)) {
      errors.push('Освобождение от НДС доступно только на УСН и ЕСХН');
    }
    if (client.vat === true) {
      errors.push('При освобождении от НДС признак «платит НДС» должен быть выключен');
    }
  }

  return errors;
}

function readFlags(db, clientId) {
  return db
    .prepare('SELECT value FROM client_flags WHERE client_id = ? ORDER BY value')
    .all(clientId)
    .map((row) => row.value);
}

function toClient(db, row) {
  return {
    id: row.id,
    name: row.name,
    inn: row.inn,
    form: row.form,
    sno: row.sno,
    vat: row.vat === 1,
    vatRate: row.vat_rate,
    vatExempt: row.vat_exempt === 1,
    profitAdvances: row.profit_advances,
    hasEmployees: row.has_employees === 1,
    hasLandTax: row.has_land_tax === 1,
    hasPropertyTax: row.has_property_tax === 1,
    hasTransportTax: row.has_transport_tax === 1,
    pinned: row.pinned === 1,
    sortOrder: row.sort_order,
    archived: row.archived === 1,
    extraFlags: readFlags(db, row.id),
  };
}

function writeFlags(db, clientId, flags) {
  db.prepare('DELETE FROM client_flags WHERE client_id = ?').run(clientId);
  const insert = db.prepare('INSERT INTO client_flags (client_id, value) VALUES (?, ?)');
  for (const flag of flags) insert.run(clientId, flag);
}

// Порядок показа: закреплённые сверху, дальше ручной порядок, потом по алфавиту (FR-17).
function list(db, mode) {
  const archived = mode === 'archive' ? 1 : 0;
  const rows = db
    .prepare(
      `SELECT * FROM clients
        WHERE archived = ?
        ORDER BY pinned DESC, sort_order ASC, name ASC`,
    )
    .all(archived);

  return rows.map((row) => toClient(db, row));
}

function get(db, id) {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return row ? toClient(db, row) : null;
}

function create(db, values) {
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO clients (
       id, name, inn, form, sno, vat, vat_rate, profit_advances, vat_exempt,
       has_employees, has_land_tax, has_property_tax, has_transport_tax,
       pinned, sort_order, archived
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
  ).run(
    id,
    values.name,
    values.inn,
    values.form,
    values.sno,
    values.vat ? 1 : 0,
    values.vatRate,
    values.profitAdvances,
    values.vatExempt ? 1 : 0,
    values.hasEmployees ? 1 : 0,
    values.hasLandTax ? 1 : 0,
    values.hasPropertyTax ? 1 : 0,
    values.hasTransportTax ? 1 : 0,
  );

  writeFlags(db, id, values.extraFlags);
  return get(db, id);
}

function update(db, id, values) {
  db.prepare(
    `UPDATE clients SET
       name = ?, inn = ?, form = ?, sno = ?, vat = ?, vat_rate = ?, profit_advances = ?,
       vat_exempt = ?, has_employees = ?, has_land_tax = ?, has_property_tax = ?,
       has_transport_tax = ?
     WHERE id = ?`,
  ).run(
    values.name,
    values.inn,
    values.form,
    values.sno,
    values.vat ? 1 : 0,
    values.vatRate,
    values.profitAdvances,
    values.vatExempt ? 1 : 0,
    values.hasEmployees ? 1 : 0,
    values.hasLandTax ? 1 : 0,
    values.hasPropertyTax ? 1 : 0,
    values.hasTransportTax ? 1 : 0,
    id,
  );

  writeFlags(db, id, values.extraFlags);
  return get(db, id);
}

// Архив и восстановление (FR-13). Данные и задачи клиента сохраняются (FR-14).
function setArchived(db, id, archived) {
  db.prepare('UPDATE clients SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return get(db, id);
}

// Закрепление и ручной порядок (FR-17).
function setPinned(db, id, pinned) {
  db.prepare('UPDATE clients SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  return get(db, id);
}

function setSortOrder(db, id, sortOrder) {
  db.prepare('UPDATE clients SET sort_order = ? WHERE id = ?').run(Number(sortOrder) || 0, id);
  return get(db, id);
}

module.exports = {
  FORMS,
  SNO_LIST,
  VAT_RATES,
  PROFIT_ADVANCES,
  BUILTIN_FLAGS,
  normalize,
  validate,
  list,
  get,
  create,
  update,
  setArchived,
  setPinned,
  setSortOrder,
};
