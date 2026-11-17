'use strict';

// Источники производственного календаря (ТЗ, раздел 6.12, FR-71).
//
// Список источников задаётся конфигурацией: по умолчанию это Контур.Эстерн
// и ConsultantPlus. Заменить список можно без изменения кода правил —
// достаточно положить файл data/calendar-sources.json:
//
//   [
//     { "id": "kontur", "title": "Контур.Эстерн",
//       "url": "https://www.kontur-extern.ru/calendar/{year}" },
//     { "id": "consultant", "title": "ConsultantPlus",
//       "url": "https://www.consultant.ru/law/ref/calendar/proizvodstvennye/{year}/" }
//   ]
//
// В адресе {year} заменяется на запрашиваемый год. Сайты читаются только
// по кнопке «Обновить календарь» (FR-75): сам по себе модуль в сеть не ходит.

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { weekdayIndex } = require('./dates');

const SOURCES_FILE = path.join(config.dataDir, 'calendar-sources.json');

const DEFAULT_SOURCES = [
  {
    id: 'kontur',
    title: 'Контур.Эстерн',
    url: 'https://www.kontur-extern.ru/calendar/{year}',
  },
  {
    id: 'consultant',
    title: 'ConsultantPlus',
    url: 'https://www.consultant.ru/law/ref/calendar/proizvodstvennye/{year}/',
  },
];

const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MONTHS_RU = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

// --- Список источников ---

function normalizeSource(raw, position) {
  const label = `Источник ${position + 1}`;
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { errors: [`${label}: запись не является объектом`] };
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    errors.push(`${label}: нет идентификатора`);
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    errors.push(`${label}: нет названия`);
  }
  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    errors.push(`${label}: нет адреса`);
  } else if (!raw.url.includes('{year}')) {
    errors.push(`${label}: в адресе нет подстановки {year}`);
  }

  if (errors.length > 0) return { errors };

  return {
    source: {
      id: raw.id.trim(),
      title: raw.title.trim(),
      url: raw.url.trim(),
    },
    errors,
  };
}

// Проверка списка источников. Возвращает { sources, errors }.
function normalizeSourcesList(parsed) {
  const errors = [];

  if (!Array.isArray(parsed) || parsed.length < 2) {
    return { sources: [], errors: ['Источников должно быть не меньше двух'] };
  }
  if (parsed.length > 5) {
    return { sources: [], errors: ['Источников может быть не больше пяти'] };
  }

  const sources = [];
  const ids = new Set();

  parsed.forEach((raw, position) => {
    const result = normalizeSource(raw, position);
    errors.push(...result.errors);
    if (!result.source) return;

    if (ids.has(result.source.id)) {
      errors.push(`Источник ${position + 1}: повторяется идентификатор ${result.source.id}`);
      return;
    }
    ids.add(result.source.id);
    sources.push(result.source);
  });

  return { sources, errors };
}

function loadSources() {
  if (!fs.existsSync(SOURCES_FILE)) {
    return DEFAULT_SOURCES.map((source) => ({ ...source }));
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Файл настроек источников ${SOURCES_FILE} не является корректным JSON`);
  }

  const result = normalizeSourcesList(parsed);
  if (result.errors.length > 0) {
    throw new Error(`Настройки источников не приняты: ${result.errors.join('; ')}`);
  }

  return result.sources;
}

// Сохранение списка источников (FR-71): файл конфигурации заменяет список
// по умолчанию, код правил при этом не меняется.
function saveSources(list) {
  const result = normalizeSourcesList(list);
  if (result.errors.length > 0) {
    return result;
  }

  fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
  fs.writeFileSync(SOURCES_FILE, `${JSON.stringify(result.sources, null, 2)}\n`, 'utf8');
  return result;
}

// --- Календарь отчётности для сверки сроков (FR-74) ---
//
// Отдельный источник: календарь бухгалтера со сроками отчётности.
// Адрес задаётся конфигурацией и правится вручную; в нём {year} заменяется
// на год, {month} — на номер месяца без ведущего нуля.

const DEADLINES_FILE = path.join(config.dataDir, 'deadlines-source.json');

const DEFAULT_DEADLINES_SOURCE = {
  title: 'Контур.Эстерн — календарь бухгалтера',
  url: 'https://www.kontur-extern.ru/calendar/{year}/{month}',
};

function normalizeDeadlinesSource(raw) {
  const errors = [];
  const value = raw || {};

  if (typeof value.title !== 'string' || value.title.trim() === '') {
    errors.push('У календаря отчётности нет названия');
  }
  if (typeof value.url !== 'string' || value.url.trim() === '') {
    errors.push('У календаря отчётности нет адреса');
  } else {
    if (!value.url.includes('{year}')) errors.push('В адресе календаря отчётности нет подстановки {year}');
    if (!value.url.includes('{month}')) errors.push('В адресе календаря отчётности нет подстановки {month}');
  }

  if (errors.length > 0) return { errors };

  return {
    source: { title: value.title.trim(), url: value.url.trim() },
    errors,
  };
}

function loadDeadlinesSource() {
  if (!fs.existsSync(DEADLINES_FILE)) return { ...DEFAULT_DEADLINES_SOURCE };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DEADLINES_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Файл настроек календаря отчётности ${DEADLINES_FILE} не является корректным JSON`);
  }

  const result = normalizeDeadlinesSource(parsed);
  if (result.errors.length > 0) {
    throw new Error(`Настройки календаря отчётности не приняты: ${result.errors.join('; ')}`);
  }

  return result.source;
}

function saveDeadlinesSource(raw) {
  const result = normalizeDeadlinesSource(raw);
  if (result.errors.length > 0) {
    return result;
  }

  fs.mkdirSync(path.dirname(DEADLINES_FILE), { recursive: true });
  fs.writeFileSync(DEADLINES_FILE, `${JSON.stringify(result.source, null, 2)}\n`, 'utf8');
  return result;
}

function sourceUrl(source, year) {
  return source.url.replace('{year}', String(year));
}

// --- Загрузка страницы ---
//
// Некоторые сайты встречают запрос проверкой и перенаправляют на тот же
// адрес, выдавая куки. Поэтому перенаправления обходятся вручную,
// а куки собираются и отправляются дальше (FR-71).

const MAX_REDIRECTS = 5;

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function collectCookies(jar, setCookieList) {
  for (const part of setCookieList || []) {
    const [pair] = String(part).split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function fetchOnce(url, jar, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        ...(jar.size > 0 ? { Cookie: cookieHeader(jar) } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('источник не ответил за 20 секунд');
    }
    throw new Error(`источник недоступен (${error.message})`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, fetchImpl = globalThis.fetch) {
  const jar = new Map();
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchOnce(current, jar, fetchImpl);
    collectCookies(jar, response.headers.getSetCookie ? response.headers.getSetCookie() : []);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`источник вернул код ${response.status} без адреса перенаправления`);
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`источник вернул код ${response.status}`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_PAGE_BYTES) {
      throw new Error('страница источника слишком большая');
    }

    return text;
  }

  throw new Error('источник перенаправляет по кругу');
}

// --- Разбор страницы источника ---
//
// На странице ищутся таблицы календаря: месяц в шапке и ячейки дней.
// Класс ячейки говорит о виде дня: holiday — нерабочий праздничный,
// weekend — обычный выходной, preholiday — сокращённый предпраздничный.
// Ячейка выходного дня без класса weekend — рабочая суббота.

function monthNumber(text) {
  const clean = String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9 ]/g, ' ')
    .trim();

  return MONTHS_RU.findIndex((name) => clean.startsWith(name.slice(0, 3))) + 1;
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .trim();
}

function classOf(attributes) {
  const match = /class\s*=\s*"([^"]*)"/i.exec(attributes || '');
  return match ? match[1].toLowerCase() : '';
}

// Токены класса: «preholiday» не должен читаться как «holiday».
function classTokens(attributes) {
  return classOf(attributes).split(/\s+/).filter(Boolean);
}

function extractTables(html) {
  const tables = [];
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let match = tableRe.exec(html);

  while (match) {
    tables.push({ attributes: match[1], inner: match[2] });
    match = tableRe.exec(html);
  }

  return tables;
}

// Месяц календаря: заголовок с именем месяца и не меньше 28 ячеек дней.
function parseMonthTable(table, year) {
  const header = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(table.inner);
  const month = header ? monthNumber(stripTags(header[1])) : 0;
  if (month === 0) return null;

  const days = [];
  const cellRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let cell = cellRe.exec(table.inner);

  while (cell) {
    const text = stripTags(cell[2]).replace(/\*/g, ' ').trim();
    const dayMatch = /^(\d{1,2})$/.exec(text);

    if (dayMatch) {
      days.push({
        day: Number(dayMatch[1]),
        tokens: classTokens(cell[1]),
      });
    }

    cell = cellRe.exec(table.inner);
  }

  return days.length >= 28 ? { month, days } : null;
}

function parseYearPage(html, year) {
  const months = new Map();

  for (const table of extractTables(html)) {
    const parsed = parseMonthTable(table, year);
    if (parsed && !months.has(parsed.month)) months.set(parsed.month, parsed.days);
  }

  if (months.size === 0) {
    throw new Error('страница источника не распознана: не найдено ни одного месяца календаря');
  }
  if (months.size < 12) {
    const missing = [];
    for (let month = 1; month <= 12; month += 1) {
      if (!months.has(month)) missing.push(month);
    }
    throw new Error(`страница источника неполная: нет месяцев ${missing.join(', ')}`);
  }

  const holidays = new Set();
  const workingSaturdays = new Set();
  const shortDays = new Set();

  for (const [month, days] of months) {
    for (const entry of days) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(entry.day).padStart(2, '0')}`;
      const weekend = weekdayIndex(iso) >= 5;
      const isHoliday = entry.tokens.some((token) =>
        token === 'holiday' || token === 'праздничный' || token === 'нерабочий');
      const isWeekendCell = entry.tokens.some((token) =>
        token === 'weekend' || token === 'выходной');
      const isShort = entry.tokens.some((token) =>
        token === 'preholiday' || token === 'short' || token === 'сокращённый');

      if (isHoliday) {
        holidays.add(iso);
        if (isShort) shortDays.add(iso);
        continue;
      }
      if (isWeekendCell) continue;

      // Ячейка без отметки выходного: день рабочий.
      if (weekend) workingSaturdays.add(iso);
      if (isShort) shortDays.add(iso);
    }
  }

  return {
    year,
    block: {
      holidays: [...holidays].sort(),
      workingSaturdays: [...workingSaturdays].sort(),
      shortDays: [...shortDays].sort(),
    },
  };
}

// Загрузка данных одного года у одного источника.
// Ошибки не бросаются: результат по каждому источнику показывается отдельно
// (AC-85), поэтому неудача одного источника не обрывает обработку второго.
async function fetchSourceYear(source, year, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  try {
    const html = await fetchText(sourceUrl(source, year), fetchImpl);
    const parsed = parseYearPage(html, year);
    return {
      source: { id: source.id, title: source.title },
      year,
      ok: true,
      block: parsed.block,
    };
  } catch (error) {
    return {
      source: { id: source.id, title: source.title },
      year,
      ok: false,
      error: error.message,
    };
  }
}

module.exports = {
  SOURCES_FILE,
  DEFAULT_SOURCES,
  DEADLINES_FILE,
  DEFAULT_DEADLINES_SOURCE,
  normalizeSourcesList,
  loadSources,
  saveSources,
  normalizeDeadlinesSource,
  loadDeadlinesSource,
  saveDeadlinesSource,
  sourceUrl,
  fetchText,
  parseYearPage,
  fetchSourceYear,
};
