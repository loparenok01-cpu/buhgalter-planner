'use strict';

// Функции дат (ТЗ, раздел 6.6, FR-46…FR-48).
// Даты везде — строки ISO 8601 YYYY-MM-DD (NFR-08): так они правильно
// сортируются и сравниваются, а в интерфейсе показываются как DD-MM-YYYY.
//
// Рабочий день определяется по производственному календарю, а не по признаку
// «суббота/воскресенье» (FR-46): 22.02.2027 — понедельник, но нерабочий.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  return toIso(new Date(parseDate(iso).getTime() + days * MS_PER_DAY));
}

// 0 — понедельник, 6 — воскресенье.
function weekdayIndex(iso) {
  return (parseDate(iso).getUTCDay() + 6) % 7;
}

function isWeekend(iso) {
  return weekdayIndex(iso) >= 5;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function makeDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// Инструменты дат для одного календаря нерабочих дней.
function createDateTools(calendar) {
  const holidays = new Set();
  const workingDaysOff = new Set();
  const shortDays = new Set();

  for (const block of Object.values((calendar && calendar.years) || {})) {
    for (const iso of block.holidays || []) holidays.add(iso);
    for (const iso of block.workingSaturdays || []) workingDaysOff.add(iso);
    for (const iso of block.shortDays || []) shortDays.add(iso);
  }

  function isWorkingDay(iso) {
    if (workingDaysOff.has(iso)) return true;
    if (holidays.has(iso)) return false;
    return !isWeekend(iso);
  }

  // Сокращённый на час предпраздничный день (ст. 95 ТК РФ).
  function isShortDay(iso) {
    return shortDays.has(iso) && isWorkingDay(iso);
  }

  // Вид дня для показа в календаре.
  function dayKind(iso) {
    if (shortDays.has(iso) && isWorkingDay(iso)) return 'short';
    if (workingDaysOff.has(iso)) return 'workingSaturday';
    if (holidays.has(iso)) return 'holiday';
    if (isWeekend(iso)) return 'dayoff';
    return 'working';
  }

  // Сдвиг срока на ближайший следующий рабочий день (FR-47).
  function shiftToNextWorkingDay(iso) {
    let current = iso;
    for (let step = 0; step <= 400; step += 1) {
      if (isWorkingDay(current)) return current;
      current = addDays(current, 1);
    }
    throw new Error(`Не удалось сдвинуть дату ${iso}: календарь не покрывает период`);
  }

  // n-й рабочий день месяца, например третий (FR-48).
  function nthWorkingDayOfMonth(year, month, n) {
    const total = daysInMonth(year, month);
    let seen = 0;

    for (let day = 1; day <= total; day += 1) {
      const iso = makeDate(year, month, day);
      if (isWorkingDay(iso)) {
        seen += 1;
        if (seen === n) return iso;
      }
    }

    throw new Error(`В ${pad(month)}.${year} меньше ${n} рабочих дней`);
  }

  // Последний рабочий день месяца (FR-48).
  function lastWorkingDayOfMonth(year, month) {
    const total = daysInMonth(year, month);

    for (let day = total; day >= 1; day -= 1) {
      const iso = makeDate(year, month, day);
      if (isWorkingDay(iso)) return iso;
    }

    throw new Error(`В ${pad(month)}.${year} нет ни одного рабочего дня`);
  }

  function lastWorkingDayOfYear(year) {
    return lastWorkingDayOfMonth(year, 12);
  }

  // Норма рабочего времени при 40-часовой неделе: рабочие дни за вычетом часа
  // за каждый сокращённый предпраздничный день (ст. 95 ТК РФ).
  function norm40(workingDays, shortDayCount) {
    return round1(workingDays * 8 - shortDayCount);
  }

  function monthStats(year, month) {
    const total = daysInMonth(year, month);
    const days = [];
    let working = 0;
    let short = 0;

    for (let day = 1; day <= total; day += 1) {
      const iso = makeDate(year, month, day);
      const kind = dayKind(iso);
      days.push({ day, kind });

      if (kind === 'working' || kind === 'short' || kind === 'workingSaturday') working += 1;
      if (kind === 'short') short += 1;
    }

    return {
      month,
      days,
      total,
      working,
      off: total - working,
      short,
      norm40: norm40(working, short),
    };
  }

  function yearStats(year) {
    const months = [];
    let working = 0;
    let short = 0;
    let total = 0;

    for (let month = 1; month <= 12; month += 1) {
      const stats = monthStats(year, month);
      months.push(stats);
      working += stats.working;
      short += stats.short;
      total += stats.total;
    }

    return {
      year,
      months,
      totals: {
        total,
        working,
        off: total - working,
        short,
        norm40: norm40(working, short),
      },
    };
  }

  return {
    isWorkingDay,
    isShortDay,
    dayKind,
    shiftToNextWorkingDay,
    nthWorkingDayOfMonth,
    lastWorkingDayOfMonth,
    lastWorkingDayOfYear,
    monthStats,
    yearStats,
  };
}

// Проверка даты в формате хранения YYYY-MM-DD (NFR-08).
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

module.exports = {
  parseDate,
  toIso,
  addDays,
  weekdayIndex,
  isWeekend,
  daysInMonth,
  makeDate,
  isIsoDate,
  createDateTools,
};
