'use strict';

// Правила сроков (ТЗ_MVP.md, раздел 8).
//
// Модуль ничего не записывает в базу: он получает карточку клиента и
// календарь, а возвращает список задач, которые нужно создать. Запись и
// защита от дублей — в tasks.js. Такое разделение позволяет сверять
// генератор с таблицей 8.5 отдельно от интерфейса.
//
// Горизонт генерации — 01.10.2026 … 30.04.2027 (FR-25). Все сроки
// переносятся на ближайший рабочий день по FR-47, включая фиксированные
// даты: если дата уже рабочая, перенос ничего не меняет.

const { makeDate } = require('./dates');

const HORIZON = { from: '2026-10-01', to: '2027-04-30' };

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTHS_ACCUSATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

// Кварталы отчётности и месяц, в котором наступает срок 25-го числа.
const QUARTERS = [
  { id: '2026-Q3', label: 'III квартал 2026', dueYear: 2026, dueMonth: 10 },
  { id: '2026-Q4', label: 'IV квартал 2026', dueYear: 2027, dueMonth: 1 },
  { id: '2027-Q1', label: 'I квартал 2027', dueYear: 2027, dueMonth: 4 },
];

// Месяцы, за которые в горизонте возникают уведомления и платежи по НДФЛ.
const NDFL_MONTHS = [
  { year: 2026, month: 9, lastDay: 30 },
  { year: 2026, month: 10, lastDay: 31 },
  { year: 2026, month: 11, lastDay: 30 },
  { year: 2026, month: 12, lastDay: 31 },
  { year: 2027, month: 1, lastDay: 31 },
  { year: 2027, month: 2, lastDay: 28 },
  { year: 2027, month: 3, lastDay: 31 },
  { year: 2027, month: 4, lastDay: 30 },
];

// Уведомления по страховым взносам: первый и второй месяцы квартала.
const CONTRIB_NOTIFICATIONS = [
  { id: '2026-10', year: 2026, month: 10, due: '2026-11-25' },
  { id: '2026-11', year: 2026, month: 11, due: '2026-12-25' },
  { id: '2027-01', year: 2027, month: 1, due: '2027-02-25' },
  { id: '2027-02', year: 2027, month: 2, due: '2027-03-25' },
];

// Платежи по страховым взносам: 28-е число месяца, следующего за отчётным.
const CONTRIB_PAYMENTS = [
  { id: '2026-09', year: 2026, month: 9, due: '2026-10-28' },
  { id: '2026-10', year: 2026, month: 10, due: '2026-11-28' },
  { id: '2026-11', year: 2026, month: 11, due: '2026-12-28' },
  { id: '2026-12', year: 2026, month: 12, due: '2027-01-28' },
  { id: '2027-01', year: 2027, month: 1, due: '2027-02-28' },
  { id: '2027-02', year: 2027, month: 2, due: '2027-03-28' },
  { id: '2027-03', year: 2027, month: 3, due: '2027-04-28' },
];

const KIND_ORDER = { declaration: 1, report: 2, notification: 3, payment: 4 };

function nextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function monthLabel(year, month) {
  return `${MONTHS_ACCUSATIVE[month - 1]} ${year}`;
}

// Сырые задачи до объединения уведомлений.
function buildRawTasks(client, tools) {
  const tasks = [];

  function add(task) {
    const date = tools.shiftToNextWorkingDay(task.date);
    if (date < HORIZON.from || date > HORIZON.to) return;
    tasks.push({ ...task, date });
  }

  function addQuarterlyDeclarations(prefix, title) {
    for (const quarter of QUARTERS) {
      add({
        key: `${prefix}:${quarter.id}`,
        kind: 'declaration',
        group: 'periodic',
        title: `${title} за ${quarter.label}`,
        date: makeDate(quarter.dueYear, quarter.dueMonth, 25),
      });
    }
  }

  function addNotification(task) {
    add({ ...task, kind: 'notification', taxLines: [task.taxKind] });
  }

  // --- 8.2 Квартальная и годовая отчётность ---

  if (client.vat && !client.vatExempt) {
    addQuarterlyDeclarations('vat-decl', 'Декларация по НДС');
  }

  if (client.hasEmployees) {
    addQuarterlyDeclarations('ndfl6-quarter', '6-НДФЛ');
    addQuarterlyDeclarations('rsv', 'РСВ');

    add({
      key: 'efs1-section2:2026',
      kind: 'declaration',
      group: 'periodic',
      title: 'ЕФС-1 раздел 2 за 2026',
      date: '2027-01-25',
    });

    add({
      key: 'efs1-1.2:2026',
      kind: 'declaration',
      group: 'periodic',
      title: 'ЕФС-1 подраздел 1.2 за 2026',
      date: '2027-01-25',
    });

    add({
      key: 'ndfl6-year:2026',
      kind: 'declaration',
      group: 'periodic',
      title: '6-НДФЛ за 2026',
      date: '2027-02-25',
    });
  }

  if (client.sno === 'ОСНО') {
    add({
      key: 'profit-decl:2026-9m',
      kind: 'declaration',
      group: 'periodic',
      title: 'Декларация по налогу на прибыль за 9 месяцев 2026',
      date: '2026-10-25',
    });

    add({
      key: 'profit-decl:2026',
      kind: 'declaration',
      group: 'periodic',
      title: 'Декларация по налогу на прибыль за 2026',
      date: '2027-03-25',
    });

    add({
      key: 'profit-decl:2027-Q1',
      kind: 'declaration',
      group: 'periodic',
      title: 'Декларация по налогу на прибыль за I квартал 2027',
      date: '2027-04-25',
    });
  }

  if (client.sno === 'УСН') {
    add({
      key: 'usn-decl:2026',
      kind: 'declaration',
      group: 'periodic',
      title: 'Декларация по УСН за 2026',
      date: client.form === 'ИП' ? '2027-04-25' : '2027-03-25',
    });
  }

  if (client.sno === 'ЕСХН') {
    add({
      key: 'eshn-decl:2026',
      kind: 'declaration',
      group: 'periodic',
      title: 'Декларация по ЕСХН за 2026',
      date: '2027-03-25',
    });
  }

  // 3-НДФЛ — годовая декларация ИП на общей системе. У ИП на УСН и
  // ЕСХН её заменяет собственная декларация, у ПСН и НПД деклараций нет
  // вовсе (раздел 8.2, абзац о годовой бухгалтерской отчётности).
  if (client.form === 'ИП' && client.sno === 'ОСНО') {
    add({
      key: 'ndfl3:2026',
      kind: 'declaration',
      group: 'periodic',
      title: '3-НДФЛ за 2026',
      date: '2027-04-30',
    });
  }

  if (client.form === 'ООО') {
    add({
      key: 'accounting:2026',
      kind: 'report',
      group: 'periodic',
      title: 'Бухгалтерская отчётность за 2026',
      date: '2027-03-31',
    });
  }

  // --- 8.2.1 Персональные сведения ---

  if (client.hasEmployees) {
    const personal = [
      { key: 'personal:2026-Q3', title: 'Персональные сведения за III квартал 2026', date: '2026-10-25', group: 'periodic' },
      { key: 'personal:2026-10', title: 'Персональные сведения за октябрь 2026', date: '2026-11-25', group: 'monthly' },
      { key: 'personal:2026-11', title: 'Персональные сведения за ноябрь 2026', date: '2026-12-25', group: 'monthly' },
      { key: 'personal:2026-Q4', title: 'Персональные сведения за IV квартал 2026', date: '2027-01-25', group: 'periodic' },
      { key: 'personal:2027-01', title: 'Персональные сведения за январь 2027', date: '2027-02-25', group: 'monthly' },
      { key: 'personal:2027-02', title: 'Персональные сведения за февраль 2027', date: '2027-03-25', group: 'monthly' },
      { key: 'personal:2027-Q1', title: 'Персональные сведения за I квартал 2027', date: '2027-04-25', group: 'periodic' },
    ];

    for (const item of personal) add({ ...item, kind: 'declaration' });
  }

  // --- 8.3 Уведомления по НДФЛ ---

  if (client.hasEmployees) {
    for (const period of NDFL_MONTHS) {
      const genitive = MONTHS_GENITIVE[period.month - 1];

      addNotification({
        key: `notif-ndfl:${period.year}-${String(period.month).padStart(2, '0')}-1`,
        group: 'monthly',
        title: 'Уведомление',
        taxKind: 'НДФЛ',
        label: `НДФЛ за 1–22 ${genitive} ${period.year}`,
        date: makeDate(period.year, period.month, 25),
      });

      const next = nextMonth(period.year, period.month);
      // По декабрю уведомление за 23–31 декабря подаётся в последний
      // рабочий день года, а не 3 января (раздел 8.3).
      const secondHalfDate = period.month === 12
        ? tools.lastWorkingDayOfYear(period.year)
        : makeDate(next.year, next.month, 3);

      addNotification({
        key: `notif-ndfl:${period.year}-${String(period.month).padStart(2, '0')}-2`,
        group: 'monthly',
        title: 'Уведомление',
        taxKind: 'НДФЛ',
        label: `НДФЛ за 23–${period.lastDay} ${genitive} ${period.year}`,
        date: secondHalfDate,
      });
    }
  }

  // --- 8.3.1 Уведомления по страховым взносам ---

  if (client.hasEmployees) {
    for (const period of CONTRIB_NOTIFICATIONS) {
      addNotification({
        key: `notif-contrib:${period.id}`,
        group: 'monthly',
        title: 'Уведомление',
        taxKind: 'Страховые взносы',
        label: `Страховые взносы за ${monthLabel(period.year, period.month)}`,
        date: period.due,
      });
    }
  }

  // --- 8.3.2 Уведомление по УСН и ЕСХН ---

  if (client.sno === 'УСН' || client.sno === 'ЕСХН') {
    addNotification({
      key: `notif-${client.sno === 'УСН' ? 'usn' : 'eshn'}:2026-9m`,
      group: 'periodic',
      title: 'Уведомление',
      taxKind: client.sno,
      label: `${client.sno} за 9 месяцев 2026`,
      date: '2026-10-25',
    });
  }

  // --- 8.3.3 Уведомления по земельному и имущественному налогам ---

  if (client.hasLandTax) {
    addNotification({
      key: 'notif-land:2026-Q3',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Земельный налог',
      label: 'Земельный налог за III квартал 2026',
      date: '2026-10-25',
    });
    addNotification({
      key: 'notif-land:2026',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Земельный налог',
      label: 'Земельный налог за 2026 год',
      date: '2027-02-25',
    });
    addNotification({
      key: 'notif-land:2027-Q1',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Земельный налог',
      label: 'Земельный налог за I квартал 2027',
      date: '2027-04-25',
    });
  }

  if (client.hasPropertyTax) {
    addNotification({
      key: 'notif-property:2026-Q3',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Налог на имущество',
      label: 'Налог на имущество за III квартал 2026',
      date: '2026-10-25',
    });
    addNotification({
      key: 'notif-property:2026',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Налог на имущество',
      label: 'Налог на имущество за 2026 год',
      date: '2027-02-25',
    });
    addNotification({
      key: 'notif-property:2027-Q1',
      group: 'periodic',
      title: 'Уведомление',
      taxKind: 'Налог на имущество',
      label: 'Налог на имущество за I квартал 2027',
      date: '2027-04-25',
    });
  }

  // --- 8.4 Платежи ---

  if (client.vat && !client.vatExempt) {
    const vatPayments = [
      { id: '2026-Q3', label: 'III квартал 2026', months: [[2026, 10], [2026, 11], [2026, 12]] },
      { id: '2026-Q4', label: 'IV квартал 2026', months: [[2027, 1], [2027, 2], [2027, 3]] },
    ];

    for (const group of vatPayments) {
      group.months.forEach(([year, month], index) => {
        add({
          key: `vat-pay:${group.id}:${index + 1}`,
          kind: 'payment',
          group: 'monthly',
          title: `Уплата НДС за ${group.label}, ${index + 1}/3`,
          date: makeDate(year, month, 28),
        });
      });
    }
  }

  if (client.profitAdvances === 'monthly') {
    const advances = [
      { key: 'profit-advance:2026-10', date: '2026-10-28' },
      { key: 'profit-advance:2026-11', date: '2026-11-28' },
      { key: 'profit-advance:2026-12', date: '2026-12-28' },
      { key: 'profit-advance:2027-01', date: '2027-01-28' },
      { key: 'profit-advance:2027-02', date: '2027-02-28' },
      { key: 'profit-advance:2027-04', date: '2027-04-28' },
    ];

    // На 29.03.2027 таблица 8.5 ТЗ учитывает одну задачу по прибыли —
    // годовую доплату за 2026 год. Отдельный аванс за март на эту же
    // дату не создаётся, иначе сверка даст 83 задачи вместо 82.
    // Месяц в названии не пишется: обозначение месяца у нас и у сайта
    // источника различается (месяц платежа против месяца, за который
    // платят), и это ложное расхождение в сверке сроков (FR-74).
    for (const advance of advances) {
      add({
        key: advance.key,
        kind: 'payment',
        group: 'monthly',
        title: 'Аванс по налогу на прибыль',
        date: advance.date,
      });
    }
  }

  if (client.profitAdvances !== 'none') {
    add({
      key: 'profit-extra:2026-9m',
      kind: 'payment',
      group: 'periodic',
      title: 'Доплата налога на прибыль за 9 месяцев 2026',
      date: '2026-10-28',
    });
    add({
      key: 'profit-extra:2026',
      kind: 'payment',
      group: 'periodic',
      title: 'Доплата налога на прибыль за 2026',
      date: '2027-03-28',
    });
    add({
      key: 'profit-extra:2027-Q1',
      kind: 'payment',
      group: 'periodic',
      title: 'Доплата налога на прибыль за I квартал 2027',
      date: '2027-04-28',
    });
  }

  if (client.hasEmployees) {
    // Взносы на травматизм — ежемесячно, не позднее 15-го числа месяца,
    // следующего за истёкшим. Платёж подписывается месяцем, за который
    // он вносится, — так же, как на сайте источника (FR-74). Запись
    // реестра по травматизму вносится вручную без привязки к задаче (FR-64).
    const injuryPayments = [
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
      { year: 2027, month: 3 },
      { year: 2027, month: 4 },
    ];

    for (const period of injuryPayments) {
      const covered = period.month === 1
        ? { year: period.year - 1, month: 12 }
        : { year: period.year, month: period.month - 1 };

      add({
        key: `injury:${period.year}-${String(period.month).padStart(2, '0')}`,
        kind: 'payment',
        group: 'monthly',
        title: `Взносы на травматизм за ${monthLabel(covered.year, covered.month)}`,
        date: makeDate(period.year, period.month, 15),
      });
    }

    for (const period of CONTRIB_PAYMENTS) {
      add({
        key: `contrib-pay:${period.id}`,
        kind: 'payment',
        group: 'monthly',
        title: `Уплата страховых взносов за ${monthLabel(period.year, period.month)}`,
        date: period.due,
      });
    }

    for (const period of NDFL_MONTHS) {
      const genitive = MONTHS_GENITIVE[period.month - 1];

      add({
        key: `ndfl-pay:${period.year}-${String(period.month).padStart(2, '0')}-1`,
        kind: 'payment',
        group: 'monthly',
        title: `Уплата НДФЛ за 1–22 ${genitive} ${period.year}`,
        date: makeDate(period.year, period.month, 28),
      });

      const next = nextMonth(period.year, period.month);
      const secondHalfDate = period.month === 12
        ? tools.lastWorkingDayOfYear(period.year)
        : makeDate(next.year, next.month, 5);

      add({
        key: `ndfl-pay:${period.year}-${String(period.month).padStart(2, '0')}-2`,
        kind: 'payment',
        group: 'monthly',
        title: `Уплата НДФЛ за 23–${period.lastDay} ${genitive} ${period.year}`,
        date: secondHalfDate,
      });
    }
  }

  if (client.hasLandTax) {
    add({
      key: 'land-advance:2026-Q3',
      kind: 'payment',
      group: 'periodic',
      title: 'Аванс по земельному налогу за III квартал 2026',
      date: '2026-10-30',
    });
    add({
      key: 'land-year:2026',
      kind: 'payment',
      group: 'periodic',
      title: 'Земельный налог за 2026',
      date: '2027-03-30',
    });
    add({
      key: 'land-advance:2027-Q1',
      kind: 'payment',
      group: 'periodic',
      title: 'Аванс по земельному налогу за I квартал 2027',
      date: '2027-04-30',
    });
  }

  if (client.hasPropertyTax) {
    add({
      key: 'property-advance:2026-Q3',
      kind: 'payment',
      group: 'periodic',
      title: 'Аванс по налогу на имущество за III квартал 2026',
      date: '2026-10-30',
    });
    add({
      key: 'property-year:2026',
      kind: 'payment',
      group: 'periodic',
      title: 'Налог на имущество за 2026',
      date: '2027-03-30',
    });
    add({
      key: 'property-advance:2027-Q1',
      kind: 'payment',
      group: 'periodic',
      title: 'Аванс по налогу на имущество за I квартал 2027',
      date: '2027-04-30',
    });
  }

  if (client.sno === 'УСН' || client.sno === 'ЕСХН') {
    add({
      key: `extra-${client.sno === 'УСН' ? 'usn' : 'eshn'}:2026`,
      kind: 'payment',
      group: 'periodic',
      title: `Доплата по ${client.sno} за 2026`,
      date: '2027-04-28',
    });
  }

  return tasks;
}

const TAX_LINE_ORDER = ['НДФЛ', 'Страховые взносы', 'Земельный налог', 'Налог на имущество', 'УСН', 'ЕСХН'];

// Уведомления с одной датой объединяются в одну задачу, а налоги
// попадают в расшифровку (ТЗ, раздел 5.1). Уведомление и платёж с одной
// датой остаются разными задачами: у них разный тип.
function mergeNotifications(tasks) {
  const notifications = new Map();
  const result = [];

  for (const task of tasks) {
    if (task.kind !== 'notification') {
      result.push(task);
      continue;
    }

    const existing = notifications.get(task.date);
    if (!existing) {
      notifications.set(task.date, {
        key: `notification:${task.date}`,
        kind: 'notification',
        group: task.group,
        title: 'Уведомление',
        date: task.date,
        taxLines: [task.taxKind],
        components: [{ taxKind: task.taxKind, label: task.label }],
      });
      continue;
    }

    if (!existing.taxLines.includes(task.taxKind)) existing.taxLines.push(task.taxKind);
    if (task.group === 'periodic') existing.group = 'periodic';
    existing.components.push({ taxKind: task.taxKind, label: task.label });
  }

  for (const task of notifications.values()) {
    task.taxLines.sort((a, b) => TAX_LINE_ORDER.indexOf(a) - TAX_LINE_ORDER.indexOf(b));
    result.push(task);
  }

  return result;
}

function compareTasks(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.title.localeCompare(b.title, 'ru');
}

// Предпросмотр генерации для одного клиента (FR-19…FR-26).
function buildPreview(client, tools) {
  const tasks = mergeNotifications(buildRawTasks(client, tools)).sort(compareTasks);
  const groups = [
    {
      key: 'periodic',
      title: 'Квартальные и годовые',
      items: tasks.filter((task) => task.group === 'periodic'),
    },
    {
      key: 'monthly',
      title: 'Ежемесячные',
      items: tasks.filter((task) => task.group === 'monthly'),
    },
  ];

  const dates = [...new Set(tasks.map((task) => task.date))];

  return {
    client: { id: client.id, name: client.name },
    horizon: HORIZON,
    groups,
    totals: {
      all: tasks.length,
      periodic: groups[0].items.length,
      monthly: groups[1].items.length,
      dates: dates.length,
    },
  };
}

module.exports = {
  HORIZON,
  buildPreview,
  buildRawTasks,
  mergeNotifications,
};
