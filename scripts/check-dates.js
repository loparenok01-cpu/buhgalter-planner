'use strict';

// Проверка календаря и функций дат. Запуск: npm run dates
// Печатает сводку по календарю и сверяет контрольные даты из ТЗ.
// Расхождение помечается словом «РАСХОЖДЕНИЕ», при любом расхождении код выхода 1.

const { loadCalendar, validateCalendar, summarize } = require('../server/calendar');
const { createDateTools, weekdayIndex } = require('../server/dates');

const WEEKDAYS = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
];

function weekdayName(iso) {
  return WEEKDAYS[weekdayIndex(iso)];
}

function ru(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

const calendar = loadCalendar();
const errors = validateCalendar(calendar.years);
const dates = createDateTools(calendar);

function fmt(value) {
  return String(value).replace('.', ',');
}

console.log('Календарь нерабочих дней');
for (const year of summarize(calendar)) {
  console.log(
    `  ${year.year}: нерабочих дат ${year.holidays}, переносов на рабочий день ${year.workingSaturdays}, сокращённых предпраздничных ${year.shortDays}`,
  );
}

if (errors.length > 0) {
  console.log('\nОшибки в данных календаря:');
  for (const error of errors) console.log(`  - ${error}`);
}

console.log('\nКонтрольные даты из ТЗ');

const checks = [
  {
    name: '22.02.2027 — понедельник, нерабочий',
    expected: 'нерабочий',
    actual: dates.isWorkingDay('2027-02-22') ? 'рабочий' : 'нерабочий',
  },
  {
    name: '20.02.2027 — суббота, рабочая после переноса',
    expected: 'рабочий',
    actual: dates.isWorkingDay('2027-02-20') ? 'рабочий' : 'нерабочий',
  },
  {
    name: '26.10.2026 — рабочий день',
    expected: 'рабочий',
    actual: dates.isWorkingDay('2026-10-26') ? 'рабочий' : 'нерабочий',
  },
  {
    name: 'срок 25.10.2026 переносится на',
    expected: '26.10.2026',
    actual: ru(dates.shiftToNextWorkingDay('2026-10-25')),
  },
  {
    name: 'срок 25.04.2027 переносится на',
    expected: '26.04.2027',
    actual: ru(dates.shiftToNextWorkingDay('2027-04-25')),
  },
  {
    name: 'срок 31.03.2027 переносится на',
    expected: '31.03.2027',
    actual: ru(dates.shiftToNextWorkingDay('2027-03-31')),
  },
  {
    name: '31.12.2026 — нерабочий день',
    expected: 'нерабочий',
    actual: dates.isWorkingDay('2026-12-31') ? 'рабочий' : 'нерабочий',
  },
  {
    name: 'последний рабочий день 2026 года',
    expected: '30.12.2026',
    actual: ru(dates.lastWorkingDayOfYear(2026)),
  },
  {
    name: 'первый рабочий день января 2027',
    expected: '11.01.2027',
    actual: ru(dates.nthWorkingDayOfMonth(2027, 1, 1)),
  },
  {
    name: 'третий рабочий день января 2027',
    expected: '13.01.2027',
    actual: ru(dates.nthWorkingDayOfMonth(2027, 1, 3)),
  },
  {
    name: 'последний рабочий день октября 2026',
    expected: '30.10.2026',
    actual: ru(dates.lastWorkingDayOfMonth(2026, 10)),
  },
  {
    name: 'норма 2026 при 40-часовой неделе, часов',
    expected: '1972',
    actual: fmt(dates.yearStats(2026).totals.norm40),
  },
  {
    name: 'норма 2027 при 40-часовой неделе, часов',
    expected: '1972',
    actual: fmt(dates.yearStats(2027).totals.norm40),
  },
  {
    name: 'норма февраля 2027 при 40-часовой неделе, часов',
    expected: '151',
    actual: fmt(dates.yearStats(2027).months[1].norm40),
  },
];

let failed = 0;
for (const check of checks) {
  const ok = check.expected === check.actual;
  if (!ok) failed += 1;
  console.log(
    `  ${ok ? 'СОВПАДАЕТ   ' : 'РАСХОЖДЕНИЕ'}  ${check.name}: ожидание ${check.expected}, получено ${check.actual}`,
  );
}

console.log(`\nДополнительно: 22.02.2027 — ${weekdayName('2027-02-22')}, 20.02.2027 — ${weekdayName('2027-02-20')}`);

if (errors.length > 0 || failed > 0) {
  console.log(`Итог: расхождений ${failed}, ошибок в данных ${errors.length}`);
  process.exit(1);
}

console.log('Итог: все контрольные даты совпали');
