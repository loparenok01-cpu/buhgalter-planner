'use strict';

// Демонстрационные клиенты из раздела 13 ТЗ.
//
//   npm run demo        — добавить недостающих, уже добавленных не трогает
//   npm run demo:reset  — удалить демонстрационных и создать заново
//
// Свои клиенты команды не трогают: удаляются только записи с номерами ИНН
// из демонстрационного списка.

const clients = require('../server/clients');
const { openDatabase } = require('../server/db');

const DEMO = [
  {
    name: 'ООО СтройДом', inn: '7707081234', form: 'ООО', sno: 'ОСНО',
    vat: true, vatRate: 22, profitAdvances: 'monthly',
    hasEmployees: true, hasLandTax: true, hasPropertyTax: true, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ООО ПромТех', inn: '7802093344', form: 'ООО', sno: 'ОСНО',
    vat: true, vatRate: 22, profitAdvances: 'monthly',
    hasEmployees: true, hasLandTax: true, hasPropertyTax: false, hasTransportTax: true,
    extraFlags: [],
  },
  {
    name: 'ИП Смирнов А.В.', inn: '500100456789', form: 'ИП', sno: 'ОСНО',
    vat: true, vatRate: 22, profitAdvances: 'none',
    hasEmployees: false, hasLandTax: true, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ИП Ковалёв С.И.', inn: '500100456790', form: 'ИП', sno: 'УСН',
    vat: true, vatRate: 5, profitAdvances: 'none',
    hasEmployees: true, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ООО Торговый Дом', inn: '7712345678', form: 'ООО', sno: 'УСН',
    vat: false, vatRate: null, profitAdvances: 'quarterly',
    hasEmployees: false, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: ['Платит НДС'],
  },
  {
    name: 'ИП Романов П.А.', inn: '500100456791', form: 'ИП', sno: 'ЕСХН',
    vat: false, vatRate: null, profitAdvances: 'none',
    hasEmployees: false, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ИП Антонов В.С.', inn: '500100456792', form: 'ИП', sno: 'ПСН',
    vat: false, vatRate: null, profitAdvances: 'none',
    hasEmployees: true, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ИП Белова Е.М.', inn: '500100456793', form: 'ИП', sno: 'НПД',
    vat: false, vatRate: null, profitAdvances: 'none',
    hasEmployees: false, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
  {
    name: 'ООО Цифра Плюс', inn: '6312345678', form: 'ООО', sno: 'АУСН',
    vat: false, vatRate: null, profitAdvances: 'none',
    hasEmployees: false, hasLandTax: false, hasPropertyTax: false, hasTransportTax: false,
    extraFlags: [],
  },
];

const db = openDatabase();
const reset = process.argv.includes('--reset');

let removed = 0;
if (reset) {
  const remove = db.prepare('DELETE FROM clients WHERE inn = ?');
  for (const demo of DEMO) {
    removed += remove.run(demo.inn).changes;
  }
}

let added = 0;
let skipped = 0;

for (const demo of DEMO) {
  const exists = db.prepare('SELECT id FROM clients WHERE inn = ?').get(demo.inn);
  if (exists) {
    skipped += 1;
    continue;
  }

  const values = clients.normalize(demo);
  const errors = clients.validate(values);
  if (errors.length > 0) {
    process.stderr.write(`Клиент «${demo.name}» не прошёл проверку: ${errors.join('; ')}\n`);
    process.exit(1);
  }

  clients.create(db, values);
  added += 1;
}

db.close();

const parts = [`добавлено ${added}`, `пропущено ${skipped} (уже были)`];
if (reset) parts.unshift(`удалено ${removed}`);

process.stdout.write(`Демонстрационные клиенты: ${parts.join(', ')}.\n`);
