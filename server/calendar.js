'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { weekdayIndex, isIsoDate } = require('./dates');

// Календарь нерабочих дней (ТЗ, раздел 6.12).
// Хранится отдельным файлом данных (FR-49): добавление года не требует
// изменения кода правил. Служебные ключи с подчёркиванием игнорируются.

const DEFAULT_TEMPLATE = path.join(config.rootDir, 'resources', 'calendar-template.json');

// Обязательные праздники: без них файл считается ошибочным (FR-73).
const REQUIRED_HOLIDAYS = ['01-01', '02-23', '03-08', '05-09'];

function stripServiceKeys(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Проверка данных календаря. Возвращает список ошибок, пустой — значит всё верно.
// Параметр allowMissingOnWeekends разрешает не перечислять обязательный
// праздник, выпавший на обычный выходной: такой день и так нерабочий.
// Загрузка файла по шаблону проверяется строго (FR-73, FR-78).
function validateCalendar(years, options = {}) {
  const errors = [];
  const entries = Object.entries(years || {});

  if (entries.length === 0) {
    errors.push('Нет ни одного года: блок «years» пуст');
    return errors;
  }

  for (const [yearKey, block] of entries) {
    if (!/^\d{4}$/.test(yearKey)) {
      errors.push(`Год «${yearKey}» записан неверно: нужно четыре цифры`);
      continue;
    }

    const year = Number(yearKey);
    const holidays = (block && block.holidays) || [];
    const workingDaysOff = (block && block.workingSaturdays) || [];
    const short = (block && block.shortDays) || [];

    // Повтор внутри одного списка — ошибка. День может числиться в двух
    // списках, только если это рабочая суббота и она же сокращённая.
    for (const [name, list] of [
      ['нерабочих дней', holidays],
      ['рабочих суббот', workingDaysOff],
      ['сокращённых дней', short],
    ]) {
      const seen = new Set();
      for (const iso of list) {
        if (seen.has(iso)) errors.push(`${yearKey}: в списке ${name} дата ${iso} встречается дважды`);
        seen.add(iso);
      }
    }

    for (const iso of holidays) {
      if (workingDaysOff.includes(iso) || short.includes(iso)) {
        errors.push(`${yearKey}: дата ${iso} указана и как нерабочая, и как рабочая`);
      }
    }

    const all = [...holidays, ...workingDaysOff, ...short];

    for (const iso of all) {
      if (!isIsoDate(iso)) {
        errors.push(`${yearKey}: дата ${iso} записана не в формате ГГГГ-ММ-ДД`);
        continue;
      }
      if (Number(iso.slice(0, 4)) !== year) {
        errors.push(`${yearKey}: дата ${iso} выходит за пределы года`);
      }
    }

    for (const required of REQUIRED_HOLIDAYS) {
      const iso = `${year}-${required}`;
      if (holidays.includes(iso)) continue;

      const weekendTransfer = options.allowMissingOnWeekends
        && isIsoDate(iso)
        && weekdayIndex(iso) >= 5
        && !workingDaysOff.includes(iso);

      if (!weekendTransfer) {
        errors.push(`${yearKey}: нет обязательного праздника ${required}`);
      }
    }
  }

  return errors;
}

// Читает календарь из файла данных. Если файла нет — заполняет его из шаблона.
function loadCalendar() {
  if (!fs.existsSync(config.calendarFile)) {
    const template = stripServiceKeys(readJsonFile(DEFAULT_TEMPLATE));
    saveCalendar(template);
    return template;
  }

  return stripServiceKeys(readJsonFile(config.calendarFile));
}

function saveCalendar(calendar) {
  fs.mkdirSync(path.dirname(config.calendarFile), { recursive: true });
  fs.writeFileSync(config.calendarFile, `${JSON.stringify(calendar, null, 2)}\n`, 'utf8');
}

// Запись файла через временную копию: обрыв записи не должен
// оставить вместо календаря половину файла.
function saveCalendarAtomic(calendar) {
  fs.mkdirSync(path.dirname(config.calendarFile), { recursive: true });
  const temp = `${config.calendarFile}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(calendar, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, config.calendarFile);
}

// Нормализованный вид года. Обычные субботы и воскресенья нерабочи и без
// записи, поэтому в список нерабочих дней остаются только те дни, которые
// меняют поведение: будни, объявленные нерабочими, и обязательные праздники.
// Рабочими субботами остаются только дни выходного, объявленные рабочими.
// Так два источника, из которых один перечисляет все дни подряд, а второй —
// только переносы, сверяются без ложных расхождений.
function canonicalYearBlock(block, year) {
  const holidays = new Set();
  for (const iso of (block && block.holidays) || []) {
    if (weekdayIndex(iso) < 5 || REQUIRED_HOLIDAYS.includes(iso.slice(5))) holidays.add(iso);
  }

  const workingSaturdays = new Set();
  for (const iso of (block && block.workingSaturdays) || []) {
    if (weekdayIndex(iso) >= 5) workingSaturdays.add(iso);
  }

  // Обязательные праздники всегда нерабочие: они добавляются в нормализованный
  // вид, чтобы два источника сверялись без ложных расхождений из-за того, что
  // праздник выпал на обычный выходной и не перечислен явно.
  for (const required of REQUIRED_HOLIDAYS) {
    const iso = `${year}-${required}`;
    if (!workingSaturdays.has(iso)) holidays.add(iso);
  }

  const shortDays = new Set((block && block.shortDays) || []);

  return {
    holidays: [...holidays].sort(),
    workingSaturdays: [...workingSaturdays].sort(),
    shortDays: [...shortDays].sort(),
  };
}

function blocksEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readTemplate() {
  return stripServiceKeys(readJsonFile(DEFAULT_TEMPLATE));
}

// Краткая сводка: какие годы загружены и сколько в них дат.
function summarize(calendar) {
  const years = [];
  for (const [year, block] of Object.entries(calendar.years || {}).sort()) {
    years.push({
      year,
      holidays: (block.holidays || []).length,
      workingSaturdays: (block.workingSaturdays || []).length,
      shortDays: (block.shortDays || []).length,
    });
  }
  return years;
}

module.exports = {
  DEFAULT_TEMPLATE,
  REQUIRED_HOLIDAYS,
  stripServiceKeys,
  validateCalendar,
  canonicalYearBlock,
  blocksEqual,
  loadCalendar,
  saveCalendar,
  saveCalendarAtomic,
  readTemplate,
  summarize,
};
