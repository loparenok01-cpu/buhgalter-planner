'use strict';

// Сверка сроков отчётности с календарём бухгалтера источника (ТЗ, раздел 6.12,
// FR-74, AC-88).
//
// Сайт со сроками отчётности — например календарь бухгалтера Контур.Эстерн —
// содержит по дням формулировки: «Представление декларации по НДС за III
// квартал 2026 года», «Уплата 1/3 от суммы НДС…». Программа сверяет эти сроки
// с расчётными датами правил раздела 8 и показывает расхождения предупреждением.
// Правила при этом не изменяются: сверка только читает данные.

const reference = require('./reference');
const { createDateTools, isIsoDate } = require('./dates');
const { fetchText, sourceUrl } = require('./calendar-sources');

const MONTHS_NUM = {
  'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5,
  'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
};

const MONTHS_FULL = {
  'январь': 1, 'февраль': 2, 'март': 3, 'апрель': 4, 'май': 5, 'мая': 5,
  'июнь': 6, 'июль': 7, 'август': 8, 'сентябрь': 9, 'октябрь': 10,
  'ноябрь': 11, 'декабрь': 12,
};

const ROMAN = { 'i': 1, 'ii': 2, 'iii': 3, 'iv': 4 };
const WORD_NUMBERS = {
  'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4,
  'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9,
  'десять': 10, 'одиннадцать': 11, 'двенадцать': 12,
};

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Разбор страницы месяца источника ---

function monthNumber(text) {
  const clean = normalize(text).replace(/[^а-яa-z0-9 ]/g, ' ').trim();
  const first = clean.split(' ')[0] || '';

  for (const [name, number] of Object.entries(MONTHS_NUM)) {
    if (first.startsWith(name)) return number;
  }
  return 0;
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .trim();
}

// Страница месяца: статьи по датам, в каждой — события по налогам.
// Год в дате не указан, он берётся из запрошенного месяца.
function parseMonthPage(html, year, month) {
  const events = [];

  for (const article of String(html).split('<article').slice(1)) {
    const dayMatch = /date-block__day">\s*(\d{1,2})/.exec(article);
    const monthMatch = /date-block__month">\s*([^<]+)</.exec(article);
    if (!dayMatch || !monthMatch) continue;

    const eventMonth = monthNumber(monthMatch[1]);
    if (eventMonth === 0) continue;

    // Год выбирается ближайший к запрошенному месяцу: на странице месяца
    // могут встречаться даты соседних месяцев.
    const target = year * 12 + month;
    let best = year;
    for (const candidate of [year - 1, year, year + 1]) {
      const distance = Math.abs(candidate * 12 + eventMonth - target);
      if (distance < Math.abs(best * 12 + eventMonth - target)) best = candidate;
    }

    const date = `${best}-${String(eventMonth).padStart(2, '0')}-${String(Number(dayMatch[1])).padStart(2, '0')}`;
    if (!isIsoDate(date)) continue;

    let tax = '';
    const scan = /event-item__title">([\s\S]*?)<\/h2>|event-item__content">([\s\S]*?)<\/p>/g;
    let match = scan.exec(article);

    while (match) {
      if (match[1] !== undefined) {
        tax = stripTags(match[1]);
      } else {
        const text = stripTags(match[2]);
        if (text) events.push({ date, tax, text });
      }
      match = scan.exec(article);
    }
  }

  return events;
}

// Загрузка сроков источника за перечень месяцев (строки ГГГГ-ММ).
// Ошибка одного месяца не обрывает обработку остальных: результат
// показывается по каждому месяцу.
async function collectSiteEvents(source, months, fetchImpl) {
  const events = [];
  const results = [];

  for (const monthKey of months) {
    const [year, month] = monthKey.split('-').map(Number);
    const url = sourceUrl(source, year).replace('{month}', String(month));
    // eslint-disable-next-line no-await-in-loop
    const result = await (async () => {
      try {
        const html = await fetchText(url, fetchImpl);
        return { ok: true, events: parseMonthPage(html, year, month) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    })();

    results.push({ year, month, ok: result.ok, error: result.error, count: result.events ? result.events.length : 0 });
    if (result.ok) events.push(...result.events);
  }

  return { events, results };
}

// --- Расчётные сроки правил раздела 8 ---

function collectAppDeadlines(tools, from, to) {
  const items = [];

  for (const task of reference.buildAllTasks(tools)) {
    if (from && task.date < from) continue;
    if (to && task.date > to) continue;

    items.push({
      date: task.date,
      kind: task.kind,
      text: task.label || task.title || '',
      title: task.title || '',
      taxKind: task.taxKind || '',
    });
  }

  return items;
}

// --- Классификация срока: налог, действие, период ---

function taxOf(text, fallback) {
  const value = normalize(text);
  const title = normalize(fallback);

  // \b в JavaScript не работает с кириллицей, поэтому слова сравниваются
  // без границ: подстрока «ндс» не встречается внутри других слов налогов.
  if (/травматизм/.test(value)) return 'Травматизм';
  if (/персонифиц/.test(value)) return 'Персонифицированные сведения';
  if (/ефс-1/.test(value)) return 'ЕФС-1';
  if (/3-ндфл|декларац\w* о доходах, полученных физическим/.test(value)) return '3-НДФЛ';
  if (/ндс/.test(value)) return 'НДС';
  if (/ндфл/.test(value)) return 'НДФЛ';
  if (/страхов\w* взнос/.test(value)) return 'Страховые взносы';
  if (/прибыл/.test(value)) return 'Налог на прибыль';
  if (/имуществ/.test(value)) return 'Налог на имущество';
  if (/земельн/.test(value)) return 'Земельный налог';
  if (/транспорт/.test(value)) return 'Транспортный налог';
  if (/бухгалтерск\w* отчетност/.test(value)) return 'Бухгалтерская отчётность';
  if (/усн/.test(value)) return 'УСН';
  if (/есхн/.test(value)) return 'ЕСХН';
  if (/торгов\w* сбор/.test(value)) return 'Торговый сбор';

  // Налог не назван в формулировке — берём заголовок события источника.
  if (/травматизм/.test(title)) return 'Травматизм';
  if (/персонифиц/.test(title)) return 'Персонифицированные сведения';
  if (/ефс-1/.test(title)) return 'ЕФС-1';
  if (/3-ндфл/.test(title)) return '3-НДФЛ';
  if (/ндс/.test(title)) return 'НДС';
  if (/ндфл/.test(title)) return 'НДФЛ';
  if (/страхов/.test(title)) return 'Страховые взносы';
  if (/прибыл/.test(title)) return 'Налог на прибыль';
  if (/имуществ/.test(title)) return 'Налог на имущество';
  if (/земельн/.test(title)) return 'Земельный налог';
  if (/транспорт/.test(title)) return 'Транспортный налог';
  if (/бухгалтерск/.test(title)) return 'Бухгалтерская отчётность';
  if (/усн/.test(title)) return 'УСН';
  if (/есхн/.test(title)) return 'ЕСХН';
  if (/торгов/.test(title)) return 'Торговый сбор';

  return stripTags(fallback || '') || 'Прочее';
}

function actionOf(text, kind) {
  if (kind === 'notification' || /уведомлени/.test(normalize(text))) return 'уведомление';
  if (kind === 'payment' || /уплат|перечислен/.test(normalize(text))) return 'уплата';
  return 'отчёт';
}

function monthFromWord(word) {
  const clean = normalize(word).replace(/[^а-яa-z-]/g, '');
  for (const [name, number] of Object.entries(MONTHS_FULL)) {
    if (clean.startsWith(name)) return number;
  }
  for (const [name, number] of Object.entries(MONTHS_NUM)) {
    if (clean.startsWith(name)) return number;
  }
  return 0;
}

// Период срока в сравнимом виде: квартал, N месяцев, месяц, год
// или половина месяца для НДФЛ (1–22 / 23–конец).
function periodOf(text) {
  const value = normalize(text);

  let match = /за период с (\d{2})\.(\d{2})\.(\d{4}) по/.exec(value);
  if (match) {
    return `${match[3]}-${match[2]}:${Number(match[1]) <= 22 ? 'A' : 'B'}`;
  }

  match = /за (\d{1,2})[–—-](\d{1,2}) ([а-я]+) (\d{4})/.exec(value);
  if (match) {
    const month = monthFromWord(match[3]);
    if (month > 0) return `${match[4]}-${String(month).padStart(2, '0')}:${Number(match[1]) <= 22 ? 'A' : 'B'}`;
  }

  match = /\b(i{1,3}v|[1-4])\s*квартал\w*\s+(\d{4})/.exec(value);
  if (match) {
    const quarter = ROMAN[match[1]] || Number(match[1]);
    return `${match[2]}-Q${quarter}`;
  }

  match = /(за|в) ((\d{1,2})|([а-я]+)) месяц\w*\s+(\d{4})/.exec(value);
  if (match) {
    const count = match[3] ? Number(match[3]) : (WORD_NUMBERS[match[4]] || 0);
    if (count > 0) return `${match[5]}-${count}m`;
  }

  match = /([а-я]+) (\d{4})/.exec(value);
  if (match) {
    const month = monthFromWord(match[1]);
    if (month > 0) return `${match[2]}-${String(month).padStart(2, '0')}`;
  }

  match = /за (\d{4}) год|за (\d{4})\b/.exec(value);
  if (match) return `${match[1] || match[2]}-Y`;

  return null;
}

function periodLabel(period) {
  if (!period) return 'период не распознан';
  const [head, half] = period.split(':');
  const year = head.slice(0, 4);

  if (head.endsWith('Y')) return `за ${year} год`;
  if (/Q\d$/.test(head)) return `${['', 'I', 'II', 'III', 'IV'][Number(head.slice(-1))]} квартал ${year}`;
  if (/-\d+m$/.test(head)) return `за ${head.split('-')[1].replace('m', '')} месяцев ${year}`;
  if (/^\d{4}-\d{2}$/.test(head)) {
    return half
      ? `за ${half === 'A' ? '1–22' : '23–конец'} ${Number(head.slice(5))}-го месяца ${year}`
      : `${Number(head.slice(5))}-й месяц ${year}`;
  }
  return period;
}

// --- Сравнение расчётных сроков и сроков источника ---

function groupBy(items, keyOf) {
  const groups = new Map();

  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;

    const existing = groups.get(key) || { key, tax: item.tax, action: item.action, period: item.period, dates: new Set(), texts: new Set() };
    existing.dates.add(item.date);
    if (item.text) existing.texts.add(item.text);
    groups.set(key, existing);
  }

  return groups;
}

function appItemKey(item) {
  const period = periodOf(`${item.text} ${item.title}`);
  if (!period) return null;
  return `${taxOf(`${item.text} ${item.title}`, item.taxKind || item.title)}|${actionOf(item.text, item.kind)}|${period}`;
}

function siteItemKey(item) {
  const period = periodOf(item.text);
  if (!period) return null;
  return `${taxOf(item.text, item.tax)}|${actionOf(item.text)}|${period}`;
}

function compareDeadlines(appItems, siteEvents) {
  const appGroups = groupBy(
    appItems.map((item) => ({ ...item, tax: taxOf(`${item.text} ${item.title}`, item.taxKind || item.title), action: actionOf(item.text, item.kind) })),
    appItemKey,
  );
  const siteGroups = groupBy(
    siteEvents.map((item) => ({ ...item, tax: taxOf(item.text, item.tax), action: actionOf(item.text) })),
    siteItemKey,
  );

  const rows = [];
  const appOnly = [];
  const siteOnly = [];

  for (const [key, app] of appGroups) {
    const site = siteGroups.get(key);
    const appDates = [...app.dates].sort();
    const tax = key.split('|')[0];
    const action = key.split('|')[1];
    const period = key.split('|')[2];

    if (!site) {
      appOnly.push({ tax, action, period, periodLabel: periodLabel(period), appDates, text: [...app.texts][0] || '' });
      continue;
    }

    const siteDates = [...site.dates].sort();
    const same = appDates.join(',') === siteDates.join(',');

    rows.push({
      tax,
      action,
      period,
      periodLabel: periodLabel(period),
      appDates,
      siteDates,
      status: same ? 'same' : 'diff',
      text: [...site.texts][0] || [...app.texts][0] || '',
    });
    siteGroups.delete(key);
  }

  for (const site of siteGroups.values()) {
    const [tax, action, period] = site.key.split('|');
    siteOnly.push({
      tax,
      action,
      period,
      periodLabel: periodLabel(period),
      siteDates: [...site.dates].sort(),
      text: [...site.texts][0] || '',
    });
  }

  rows.sort((a, b) => (a.appDates[0] < b.appDates[0] ? -1 : 1));
  appOnly.sort((a, b) => (a.appDates[0] < b.appDates[0] ? -1 : 1));
  siteOnly.sort((a, b) => (a.siteDates[0] < b.siteDates[0] ? -1 : 1));

  return {
    rows,
    appOnly,
    siteOnly,
    warnings: rows.filter((row) => row.status === 'diff'),
  };
}

// Полная сверка: сроки источника против расчётных дат правил.
//
// Пока сверяется только 2026 год: по договорённости остальные годы
// подключаются позже. Сайт запрашивается по месяцам, в которых есть
// расчётные сроки, — остальные месяцы сверять не с чем.

const CHECK_YEARS = [2026];

function normalizeCheckYears(value) {
  if (!Array.isArray(value)) return CHECK_YEARS;

  const years = [...new Set(value.map(Number))]
    .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100)
    .sort((a, b) => a - b);

  return years.length > 0 && years.length <= 5 ? years : CHECK_YEARS;
}

async function runCheck(source, calendar, fetchImpl, options = {}) {
  const years = normalizeCheckYears(options.years);
  const from = `${years[0]}-01-01`;
  const to = `${years[years.length - 1]}-12-31`;

  const tools = createDateTools(calendar);
  const appItems = collectAppDeadlines(tools, from, to);
  const months = [...new Set(appItems.map((item) => item.date.slice(0, 7)))].sort();

  const result = {
    years,
    horizon: { from, to },
    source: { title: source.title, url: source.url },
    months: [],
    events: [],
    rows: [],
    appOnly: [],
    siteOnly: [],
    warnings: [],
  };

  if (months.length === 0) {
    result.error = 'В выбранном периоде нет расчётных сроков для сверки';
    return result;
  }

  const collected = await collectSiteEvents(source, months, fetchImpl);
  const comparison = compareDeadlines(appItems, collected.events);

  return {
    ...result,
    months: collected.results,
    events: collected.events,
    ...comparison,
  };
}

module.exports = {
  parseMonthPage,
  collectSiteEvents,
  collectAppDeadlines,
  compareDeadlines,
  runCheck,
};
