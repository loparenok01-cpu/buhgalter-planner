'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const config = require('./config');
const auth = require('./auth');
const clients = require('./clients');
const rules = require('./rules');
const tasks = require('./tasks');
const templates = require('./templates');
const payments = require('./payments');
const search = require('./search');
const checklists = require('./checklists');
const reference = require('./reference');
const backup = require('./backup');
const settings = require('./settings');
const calendar = require('./calendar');
const calendarSources = require('./calendar-sources');
const calendarUpdate = require('./calendar-update');
const reportingCheck = require('./reporting-check');
const recovery = require('./recovery');
const { createDateTools, isIsoDate } = require('./dates');
const { openDatabase, schemaVersion } = require('./db');

// Обычный запуск готовит базу к работе. Если файл базы повреждён или
// недоступен, сервер не завершается: приложение открывает экран
// восстановления — загрузить копию или начать с нуля (FR-51, AC-51).
let db = null;
let dbError = null;
let accountInfo = null;

function bootDatabase() {
  const database = openDatabase();

  // Записи старого вида разбиваются на платежи задач, затем пометки
  // «платёж внесён» пересчитываются. При каждом изменении реестра
  // пометки пересчитываются снова; при старте — на случай, если данные
  // менялись в обход приложения.
  payments.normalizeLegacyRecords(database);
  payments.syncTaskMarks(database);
  auth.cleanupSessions(database);

  // Единственная учётная запись заводится при первом запуске (FR-69).
  const info = auth.ensureAccount(database, {
    login: process.env.ASBUHG_LOGIN,
    password: process.env.ASBUHG_PASSWORD,
  });

  return { database, info };
}

try {
  const started = bootDatabase();
  db = started.database;
  accountInfo = started.info;
} catch (error) {
  dbError = error.message;
  process.stderr.write(`База данных недоступна: ${dbError}\n`);
  process.stderr.write('Приложение предложит восстановить копию или начать с нуля.\n');
}

// Закрывает рабочее соединение перед восстановлением: на Windows
// занятый файл базы нельзя переименовать (FR-51).
function closeCurrentDatabase() {
  if (!db) return;
  try {
    db.close();
  } catch (error) {
    // Соединение уже закрыто.
  }
  db = null;
}

// Ошибка чтения базы приходит из SQLite с кодом ERR_SQLITE_*.
function isDatabaseError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  return code.startsWith('ERR_SQLITE') || code.startsWith('SQLITE_')
    || /database disk image is malformed|file is not a database|database is locked/i.test(message);
}

function recoveryPayload(error) {
  return {
    error: 'База данных недоступна',
    detail: error || dbError || null,
    dbError: true,
    recover: true,
  };
}

const SESSION_COOKIE = 'asbuhg_session';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// Обычный запрос ограничен 64 КБ. Импорт копии — отдельный, большой
// предел: файл со всеми задачами и платежами заметно больше.
const BODY_LIMIT = 64 * 1024;
const IMPORT_LIMIT = 25 * 1024 * 1024;

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit = BODY_LIMIT) {
  const raw = (await readBody(req, limit)) || '{}';
  return JSON.parse(raw);
}

// Тело запроса импорта: принимается либо сам файл копии, либо
// объект { file: <копия> }. Ошибка разбора JSON превращается в понятное
// сообщение, а не в общую ошибку сервера (FR-55).
async function readImportFile(req) {
  let payload;
  try {
    payload = await readJson(req, IMPORT_LIMIT);
  } catch (error) {
    return {
      error: error.message === 'Слишком большой запрос'
        ? 'Файл копии слишком большой'
        : 'Файл не является корректным JSON',
    };
  }

  if (payload && typeof payload === 'object' && payload.file && typeof payload.file === 'object') {
    return { file: payload.file };
  }
  return { file: payload };
}

// Годы для загрузки с сайтов: от одного до пяти, каждый — четырьмя цифрами.
function normalizeYearList(value) {
  if (!Array.isArray(value)) return null;

  const years = [...new Set(value.map(Number))]
    .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100)
    .sort((a, b) => a - b);

  return years.length > 0 && years.length <= 5 ? years : null;
}

// Что изменится, если принять новый календарь: по годам и по задачам (FR-75).
function describeChanges(years) {
  const current = calendar.loadCalendar();
  const next = { version: 1, years: calendarUpdate.canonicalYears(years) };

  return {
    years: calendarUpdate.diffYears(current.years, years),
    tasks: calendarUpdate.planTaskShifts(db, next),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }

  return out;
}

function sessionCookie(token, maxAgeMs) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  return parts.join('; ');
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// Раздаёт статику из app/. Запросы с выходом за пределы каталога отклоняются.
function serveStatic(res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(config.appDir, `.${decoded === '/' ? '/index.html' : decoded}`);

  if (target !== config.appDir && !target.startsWith(config.appDir + path.sep)) {
    sendText(res, 403, 'Доступ запрещён');
    return;
  }

  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) {
      sendText(res, 404, 'Страница не найдена');
      return;
    }

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
}

async function handleLogin(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (error) {
    sendJson(res, 400, { error: 'Некорректный запрос' });
    return;
  }

  const login = typeof payload.login === 'string' ? payload.login.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  const row = db.prepare('SELECT id, login, password_hash FROM accounts WHERE login = ?').get(login);
  // Неверный логин и неверный пароль дают одно и то же сообщение:
  // снаружи не должно быть понятно, какой логин существует.
  const ok = row && auth.verifyPassword(password, row.password_hash);

  if (!ok) {
    sendJson(res, 401, { error: 'Неверный логин или пароль' });
    return;
  }

  const token = auth.createSession(db, row.id, config.sessionTimeoutMs);
  res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTimeoutMs));
  sendJson(res, 200, { login: row.login });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  auth.destroySession(db, cookies[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', clearCookie());
  sendJson(res, 200, { ok: true });
}

function currentSession(req) {
  const cookies = parseCookies(req);
  return auth.getValidSession(db, cookies[SESSION_COOKIE], config.sessionTimeoutMs);
}

async function handleApi(req, res, pathname, query) {
  // Состояние восстановления доступно без входа: без базы входа ещё нет.
  if (pathname === '/api/recovery' && req.method === 'GET') {
    sendJson(res, 200, { needed: !db, error: dbError });
    return;
  }

  // Начать с нуля: пустая база и новая учётная запись (FR-51, AC-51).
  if (pathname === '/api/recovery/start' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: 'Некорректный запрос' });
      return;
    }

    let result;
    try {
      result = recovery.startEmpty(body, closeCurrentDatabase);
    } catch (error) {
      sendJson(res, 500, { error: `Не удалось создать базу: ${error.message}` });
      return;
    }

    if (result.errors) {
      sendJson(res, 400, { errors: result.errors });
      return;
    }

    db = result.db;
    dbError = null;
    sendJson(res, 200, {
      restored: 'empty',
      account: result.account,
      previous: result.previous,
    });
    return;
  }

  // Восстановить из копии JSON (FR-53, FR-54).
  if (pathname === '/api/recovery/restore' && req.method === 'POST') {
    let payload;
    try {
      payload = await readJson(req, IMPORT_LIMIT);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message === 'Слишком большой запрос'
          ? 'Файл копии слишком большой'
          : 'Файл не является корректным JSON',
      });
      return;
    }

    const file = payload && typeof payload.file === 'object' ? payload.file : payload;
    const credentials = {
      login: payload && payload.login,
      password: payload && payload.password,
    };

    let result;
    try {
      result = recovery.restoreFromFile(file, credentials, closeCurrentDatabase);
    } catch (error) {
      sendJson(res, 500, { error: `Не удалось восстановить копию: ${error.message}` });
      return;
    }

    if (result.errors) {
      sendJson(res, 400, { errors: result.errors });
      return;
    }

    db = result.db;
    dbError = null;
    sendJson(res, 200, {
      restored: 'file',
      account: result.account,
      counts: result.counts,
      previous: result.previous,
    });
    return;
  }

  // Дальше без базы работать не с чем: интерфейс покажет восстановление.
  if (!db) {
    sendJson(res, 503, recoveryPayload(null));
    return;
  }

  // Состояние сервера доступно без входа: это не данные приложения.
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      app: 'Планировщик бухгалтера',
      time: new Date().toISOString(),
      schemaVersion: schemaVersion(db),
    });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    await handleLogin(req, res);
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    await handleLogout(req, res);
    return;
  }

  const session = currentSession(req);

  if (!session) {
    sendJson(res, 401, { error: 'Требуется вход' });
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    sendJson(res, 200, { login: session.login, expiresAt: session.expiresAt });
    return;
  }

  // Календарь нерабочих дней с подсчётом рабочих дней и нормы (раздел 6.12).
  if (pathname === '/api/calendar' && req.method === 'GET') {
    const current = calendar.loadCalendar();
    const tools = createDateTools(current);
    const years = Object.keys(current.years || {})
      .sort()
      .map((year) => tools.yearStats(Number(year)));

    let sources = [];
    let sourceError = null;
    let deadlinesSource = null;
    try {
      sources = calendarSources.loadSources().map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
      }));
      deadlinesSource = calendarSources.loadDeadlinesSource();
    } catch (error) {
      sourceError = error.message;
    }

    sendJson(res, 200, {
      years,
      sources,
      deadlinesSource,
      sourceError,
      updates: calendarUpdate.listUpdates(db, 10),
    });
    return;
  }

  // Календарь отчётности для сверки сроков (FR-74): адрес можно вручную.
  if (pathname === '/api/calendar/deadlines-source' && req.method === 'GET') {
    try {
      sendJson(res, 200, { source: calendarSources.loadDeadlinesSource() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/calendar/deadlines-source' && req.method === 'PUT') {
    const body = await readJson(req);
    const result = calendarSources.saveDeadlinesSource(body && body.source);

    if (result.errors.length > 0) {
      sendJson(res, 400, { errors: result.errors });
      return;
    }

    sendJson(res, 200, { source: result.source });
    return;
  }

  // Сверка сроков отчётности с календарём источника (FR-74, AC-88).
  // Только чтение: правила раздела 8 не изменяются.
  if (pathname === '/api/calendar/deadlines-check' && req.method === 'POST') {
    const body = await readJson(req);

    let source;
    try {
      source = calendarSources.loadDeadlinesSource();
    } catch (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }

    const result = await reportingCheck.runCheck(
      source,
      calendar.loadCalendar(),
      undefined,
      { years: body && body.years },
    );

    sendJson(res, 200, result);
    return;
  }

  // Источники календаря: список задаётся конфигурацией и может быть
  // заменён вручную без изменения кода правил (FR-71).
  if (pathname === '/api/calendar/sources-config' && req.method === 'GET') {
    try {
      sendJson(res, 200, { sources: calendarSources.loadSources() });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/calendar/sources-config' && req.method === 'PUT') {
    const body = await readJson(req);
    const list = body && Array.isArray(body.sources) ? body.sources : [];
    const result = calendarSources.normalizeSourcesList(list);

    if (result.errors.length > 0) {
      sendJson(res, 400, { errors: result.errors });
      return;
    }

    const saved = calendarSources.saveSources(result.sources);
    if (saved.errors.length > 0) {
      sendJson(res, 400, { errors: saved.errors });
      return;
    }

    sendJson(res, 200, { sources: saved.sources });
    return;
  }

  // Шаблон файла календаря для заполнения вне программы (FR-76).
  if (pathname === '/api/calendar/template' && req.method === 'GET') {
    const body = fs.readFileSync(calendar.DEFAULT_TEMPLATE, 'utf8');

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="calendar-template.json"',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // Загрузка данных одного года у одного источника (FR-71, AC-85).
  if (pathname === '/api/calendar/fetch' && req.method === 'POST') {
    const body = await readJson(req);
    const years = normalizeYearList(body && body.years);

    if (!years) {
      sendJson(res, 400, { error: 'Укажите годы: от одного до пяти, каждый — четырьмя цифрами' });
      return;
    }

    let sources;
    try {
      sources = calendarSources.loadSources();
    } catch (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }

    const source = sources.find((item) => item.id === (body && body.sourceId));
    if (!source) {
      sendJson(res, 404, { error: 'Источник не найден' });
      return;
    }

    const results = [];
    for (const year of years) {
      // Результат по каждому источнику и году показывается отдельно:
      // неудача не обрывает обработку остальных.
      // eslint-disable-next-line no-await-in-loop
      const result = await calendarSources.fetchSourceYear(source, year);
      const errors = result.ok
        ? calendarUpdate.checkYears({ [String(year)]: result.block }, { allowMissingOnWeekends: true })
        : [];

      results.push({
        year,
        ok: result.ok && errors.length === 0,
        block: result.ok ? result.block : undefined,
        error: result.ok ? (errors.length > 0 ? errors.join('; ') : undefined) : result.error,
      });
    }

    sendJson(res, 200, { source: { id: source.id, title: source.title }, years, results });
    return;
  }

  // Сверка двух источников и применение календаря (FR-72, FR-75).
  if (pathname === '/api/calendar/sources' && req.method === 'POST') {
    const body = await readJson(req);
    const list = body && Array.isArray(body.sources) ? body.sources : [];

    if (list.length !== 2) {
      sendJson(res, 400, { error: 'Нужны данные двух источников' });
      return;
    }

    const errors = [];
    const prepared = list.map((entry, position) => {
      const label = `Источник ${position + 1}`;
      const blocks = entry && entry.blocks && typeof entry.blocks === 'object' ? entry.blocks : null;

      if (!blocks || Object.keys(blocks).length === 0) {
        errors.push(`${label}: нет данных за ни одного года`);
        return null;
      }

      errors.push(...calendarUpdate.checkYears(blocks, { allowMissingOnWeekends: true })
        .map((message) => `${label}: ${message}`));

      return {
        id: typeof entry.id === 'string' ? entry.id : `source-${position + 1}`,
        title: typeof entry.title === 'string' ? entry.title : label,
        blocks,
      };
    });

    const differences = prepared[0] && prepared[1]
      ? calendarUpdate.compareSourceYears(prepared[0].blocks, prepared[1].blocks)
      : [];

    const nextYears = {};
    if (differences.length === 0 && errors.length === 0) {
      for (const [yearKey, block] of Object.entries(prepared[0].blocks)) {
        nextYears[yearKey] = block;
      }
    }

    const valid = errors.length === 0 && differences.length === 0;
    const response = {
      mode: 'sources',
      valid,
      errors,
      sources: prepared.filter(Boolean).map((item) => ({
        id: item.id,
        title: item.title,
        years: Object.keys(item.blocks).sort(),
      })),
      differences,
      changes: valid ? describeChanges(nextYears) : null,
      applied: false,
      update: null,
    };

    if (!body.confirm || !valid) {
      sendJson(res, 200, response);
      return;
    }

    try {
      const result = calendarUpdate.applyCalendar(
        db,
        { version: 1, years: nextYears },
        {
          sourceA: prepared[0].title,
          sourceB: prepared[1].title,
          note: `Данные с сайтов за ${Object.keys(nextYears).sort().join(', ')}`,
        },
        { allowMissingOnWeekends: true },
      );

      response.applied = true;
      response.update = result.update;
      response.changes = describeChanges(nextYears);
      response.movedTasks = result.moves;
    } catch (error) {
      response.errors = [error.message];
      response.valid = false;
    }

    sendJson(res, 200, response);
    return;
  }

  // Загрузка файла календаря, заполненного по шаблону (FR-77, FR-78).
  if (pathname === '/api/calendar/file' && req.method === 'POST') {
    const body = await readJson(req);
    const file = body && body.file && typeof body.file === 'object' ? body.file : null;

    const errors = [];
    if (!file) {
      errors.push('Не передан файл календаря');
    } else if (file.version !== 1) {
      errors.push(`Неподдерживаемая версия файла: ${file.version}. Поддерживается версия 1`);
    }

    const years = file && calendar.stripServiceKeys(file).years;
    if (file && (!years || typeof years !== 'object' || Array.isArray(years))) {
      errors.push('Нет блока лет «years»');
    }

    if (errors.length === 0) {
      errors.push(...calendarUpdate.checkYears(years));
    }

    const valid = errors.length === 0;
    const response = {
      mode: 'file',
      valid,
      errors,
      name: typeof body.name === 'string' ? body.name.slice(0, 200) : '',
      changes: valid ? describeChanges(years) : null,
      applied: false,
      update: null,
    };

    if (!body.confirm || !valid) {
      sendJson(res, 200, response);
      return;
    }

    try {
      const result = calendarUpdate.applyCalendar(
        db,
        { version: 1, years },
        {
          sourceA: 'Файл календаря',
          sourceB: null,
          note: response.name ? `Загружен файл ${response.name}` : 'Загружен файл календаря',
        },
      );

      response.applied = true;
      response.update = result.update;
      response.changes = describeChanges(years);
      response.movedTasks = result.moves;
    } catch (error) {
      response.errors = [error.message];
      response.valid = false;
    }

    sendJson(res, 200, response);
    return;
  }

  // Готовые пункты «Дополнительно» (FR-15).
  if (pathname === '/api/flags/builtin' && req.method === 'GET') {
    sendJson(res, 200, { flags: clients.BUILTIN_FLAGS });
    return;
  }

  const parts = pathname.split('/').filter(Boolean);
  if (parts[1] === 'week') {
    handleWeek(req, res, parts, query);
    return;
  }
  if (parts[1] === 'tasks') {
    await handleTasks(req, res, parts);
    return;
  }
  if (parts[1] === 'templates') {
    await handleTemplates(req, res, parts);
    return;
  }
  if (parts[1] === 'payments') {
    await handlePayments(req, res, parts, query);
    return;
  }
  if (parts[1] === 'clients') {
    await handleClients(req, res, parts, query);
    return;
  }
  if (parts[1] === 'search') {
    await handleSearch(req, res, parts, query);
    return;
  }
  if (parts[1] === 'checklists') {
    await handleChecklists(req, res, parts);
    return;
  }
  if (parts[1] === 'reference' && parts.length === 2 && req.method === 'GET') {
    sendJson(res, 200, reference.buildReference(createDateTools(calendar.loadCalendar())));
    return;
  }

  // Настройки вида: выбранный режим и текущая неделя (FR-52).
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ui: settings.read(db) });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
      const ui = body && typeof body.ui === 'object' && body.ui !== null ? body.ui : body;
      const errors = settings.validate(ui);

      if (errors.length > 0) {
        sendJson(res, 400, { errors });
        return;
      }

      sendJson(res, 200, { ui: settings.write(db, ui) });
      return;
    }

    sendJson(res, 405, { error: 'Метод не поддерживается' });
    return;
  }

  // Экспорт всех данных в файл JSON (FR-53).
  if (pathname === '/api/export' && req.method === 'GET') {
    const file = backup.exportData(db);
    const body = JSON.stringify(file, null, 2);
    const name = `asbuhg-backup-${new Date().toISOString().slice(0, 10)}.json`;

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // Предпросмотр импорта: проверка файла и количество записей
  // в файле и в текущей базе (FR-54, FR-55).
  if (pathname === '/api/import/preview' && req.method === 'POST') {
    const parsed = await readImportFile(req);
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error, errors: [parsed.error] });
      return;
    }

    const errors = backup.validateFile(parsed.file);
    sendJson(res, 200, {
      valid: errors.length === 0,
      errors,
      file: backup.countData(parsed.file),
      current: backup.currentCounts(db),
    });
    return;
  }

  // Замена данных копией. Проверка повторяется на сервере: подтверждение
  // в интерфейсе не отменяет проверок (FR-54).
  if (pathname === '/api/import' && req.method === 'POST') {
    const parsed = await readImportFile(req);
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error, errors: [parsed.error] });
      return;
    }

    const errors = backup.validateFile(parsed.file);
    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    try {
      const counts = backup.importData(db, parsed.file);
      sendJson(res, 200, { imported: counts, ui: settings.read(db) });
    } catch (error) {
      sendJson(res, 500, { error: `Не удалось применить копию: ${error.message}` });
    }
    return;
  }

  sendJson(res, 404, { error: 'Операция не найдена' });
}

// Проверка даты — общая функция из dates.js (NFR-08).

function isoDays(from, to) {
  const days = [];
  const end = Date.parse(`${to}T00:00:00Z`);

  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += 86400000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }

  return days;
}

// Сетка недели: клиенты выбранного режима и их задачи за диапазон (FR-01…FR-05).
function handleWeek(req, res, parts, query) {
  if (req.method !== 'GET' || parts.length !== 2) {
    sendJson(res, 405, { error: 'Метод не поддерживается' });
    return;
  }

  const from = query.get('from');
  const to = query.get('to');
  const mode = query.get('mode') === 'archive' ? 'archive' : 'active';

  if (!isIsoDate(from) || !isIsoDate(to)) {
    sendJson(res, 400, { error: 'Даты недели должны быть в формате ГГГГ-ММ-ДД' });
    return;
  }
  if (from > to) {
    sendJson(res, 400, { error: 'Начало недели позже её конца' });
    return;
  }

  const days = isoDays(from, to);
  if (days.length > 31) {
    sendJson(res, 400, { error: 'Слишком длинный период: не больше 31 дня' });
    return;
  }

  // Строка поиска клиента (FR-06): фильтр по названию или ИНН.
  const rows = search.filterClients(clients.list(db, mode), query.get('search'));
  const ids = rows.map((client) => client.id);
  const taskList = tasks.listByRange(db, from, to, ids);

  const byClient = new Map(ids.map((id) => [id, []]));
  const dayCounts = {};
  for (const day of days) dayCounts[day] = 0;

  for (const task of taskList) {
    if (byClient.has(task.clientId)) byClient.get(task.clientId).push(task);
    if (dayCounts[task.date] !== undefined) dayCounts[task.date] += 1;
  }

  const activeClients = db
    .prepare('SELECT COUNT(*) AS count FROM clients WHERE archived = 0')
    .get().count;

  sendJson(res, 200, {
    from,
    to,
    mode,
    activeClients,
    clients: rows.map((client) => ({
      ...client,
      tasks: (byClient.get(client.id) || []).map((task) => ({
        ...task,
        paymentEligible: payments.isEligible(task),
      })),
    })),
    summary: tasks.summarize(taskList),
    dayCounts,
  });
}

// Задачи: создание из каталога или вручную, смена статуса и комментария, удаление
// (FR-27…FR-36).
async function handleTasks(req, res, parts) {
  const id = parts[2] || null;

  if (!id && parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    const client = clients.get(db, typeof body.clientId === 'string' ? body.clientId : '');

    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }
    if (!isIsoDate(body.date)) {
      sendJson(res, 400, { error: 'Дата задачи должна быть в формате ГГГГ-ММ-ДД' });
      return;
    }

    // Создание из каталога шаблонов (FR-29).
    if (Array.isArray(body.templateIds)) {
      const templateIds = [...new Set(body.templateIds.filter((item) => typeof item === 'string'))];

      if (templateIds.length === 0) {
        sendJson(res, 400, { error: 'Выберите хотя бы один шаблон' });
        return;
      }

      const selected = [];
      for (const templateId of templateIds) {
        const template = templates.get(db, templateId);
        if (!template) {
          sendJson(res, 400, { error: `Шаблон не найден: ${templateId}` });
          return;
        }
        selected.push(template);
      }

      const created = tasks.createMany(
        db,
        client.id,
        body.date,
        selected.map((template) => ({ title: template.title, origin: 'template' })),
      );

      sendJson(res, 201, { created: created.length, tasks: created });
      return;
    }

    // Ручная задача с произвольным названием (FR-30).
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendJson(res, 400, { error: 'Укажите название задачи или выберите шаблоны' });
      return;
    }
    if (title.length > 300) {
      sendJson(res, 400, { error: 'Название задачи длиннее 300 символов' });
      return;
    }

    const created = tasks.createMany(db, client.id, body.date, [{ title, origin: 'manual' }]);
    sendJson(res, 201, { created: created.length, tasks: created });
    return;
  }

  if (id && parts.length === 4 && parts[3] === 'payment' && req.method === 'GET') {
    const task = tasks.get(db, id);
    if (!task) {
      sendJson(res, 404, { error: 'Задача не найдена' });
      return;
    }
    if (!payments.isEligible(task)) {
      sendJson(res, 400, { error: 'По этой задаче уплаты не следует: запись реестра не создаётся' });
      return;
    }

    sendJson(res, 200, payments.formFor(db, task, createDateTools(calendar.loadCalendar())));
    return;
  }

  if (id && parts.length === 3 && req.method === 'PATCH') {
    const existing = tasks.get(db, id);
    if (!existing) {
      sendJson(res, 404, { error: 'Задача не найдена' });
      return;
    }

    const body = await readJson(req);
    const patch = {};

    if (body.status !== undefined) {
      if (!tasks.STATUSES.includes(body.status)) {
        sendJson(res, 400, { error: 'Неизвестный статус задачи' });
        return;
      }
      patch.status = body.status;
    }

    if (body.comment !== undefined) {
      if (typeof body.comment !== 'string') {
        sendJson(res, 400, { error: 'Комментарий должен быть текстом' });
        return;
      }
      if (body.comment.length > 2000) {
        sendJson(res, 400, { error: 'Комментарий длиннее 2000 символов' });
        return;
      }
      patch.comment = body.comment.trim();
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Нечего изменять' });
      return;
    }

    sendJson(res, 200, { task: tasks.update(db, id, patch) });
    return;
  }

  if (id && parts.length === 3 && req.method === 'DELETE') {
    if (!tasks.remove(db, id)) {
      sendJson(res, 404, { error: 'Задача не найдена' });
      return;
    }
    sendJson(res, 200, { deleted: true });
    return;
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
}

// Каталог шаблонов (FR-27…FR-31).
async function handleTemplates(req, res, parts) {
  const id = parts[2] || null;

  if (!id && parts.length === 2 && req.method === 'GET') {
    sendJson(res, 200, { templates: templates.list(db) });
    return;
  }

  if (!id && parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title.trim() : '';

    if (!title) {
      sendJson(res, 400, { error: 'Укажите название шаблона' });
      return;
    }
    if (title.length > 200) {
      sendJson(res, 400, { error: 'Название шаблона длиннее 200 символов' });
      return;
    }
    if (templates.findByTitle(db, title)) {
      sendJson(res, 400, { error: 'Такой шаблон уже есть' });
      return;
    }

    sendJson(res, 201, { template: templates.create(db, title) });
    return;
  }

  if (id && parts.length === 3 && req.method === 'PATCH') {
    const existing = templates.get(db, id);
    if (!existing) {
      sendJson(res, 404, { error: 'Шаблон не найден' });
      return;
    }
    if (existing.builtin) {
      sendJson(res, 400, { error: 'Встроенный шаблон нельзя переименовать' });
      return;
    }

    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title.trim() : '';

    if (!title) {
      sendJson(res, 400, { error: 'Укажите название шаблона' });
      return;
    }
    if (title.length > 200) {
      sendJson(res, 400, { error: 'Название шаблона длиннее 200 символов' });
      return;
    }
    if (templates.findByTitle(db, title, id)) {
      sendJson(res, 400, { error: 'Такой шаблон уже есть' });
      return;
    }

    sendJson(res, 200, { template: templates.rename(db, id, title) });
    return;
  }

  if (id && parts.length === 3 && req.method === 'DELETE') {
    const existing = templates.get(db, id);
    if (!existing) {
      sendJson(res, 404, { error: 'Шаблон не найден' });
      return;
    }
    if (existing.builtin) {
      sendJson(res, 400, { error: 'Встроенный шаблон нельзя удалить' });
      return;
    }

    templates.remove(db, id);
    sendJson(res, 200, { deleted: true });
    return;
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
}

// Реестр платежей (разделы 5.1 и 6.9, FR-57…FR-66).
async function handlePayments(req, res, parts, query) {
  // Деление суммы НДС на три доли (FR-66): 10000 → 3333 / 3333 / 3334.
  if (parts.length === 3 && parts[2] === 'vat-shares' && req.method === 'POST') {
    const body = await readJson(req);
    const amount = body.amount;

    if (!Number.isInteger(amount) || amount < 0 || amount > 1e12) {
      sendJson(res, 400, { error: 'Сумма НДС — целое число рублей' });
      return;
    }

    sendJson(res, 200, { shares: payments.vatShares(amount) });
    return;
  }

  // Фиксация всех трёх долей НДС сразу: по записи реестра на каждый
  // из трёх сроков уплаты квартала (FR-66).
  if (parts.length === 3 && parts[2] === 'vat-installments' && req.method === 'POST') {
    const body = await readJson(req);
    const task = tasks.get(db, typeof body.taskId === 'string' ? body.taskId : '');

    if (!task) {
      sendJson(res, 404, { error: 'Задача не найдена' });
      return;
    }
    if (!payments.isVatTask(task)) {
      sendJson(res, 400, { error: 'Деление на доли доступно только для платежей НДС' });
      return;
    }
    if (!Number.isInteger(body.amount) || body.amount < 0 || body.amount > 1e12) {
      sendJson(res, 400, { error: 'Сумма НДС за квартал — целое число рублей' });
      return;
    }
    if (typeof body.comment !== 'string' || body.comment.length > 2000) {
      sendJson(res, 400, { error: 'Комментарий длиннее 2000 символов' });
      return;
    }
    if (body.filingDate !== null && body.filingDate !== undefined && !isIsoDate(body.filingDate)) {
      sendJson(res, 400, { error: 'Дата сдачи должна быть в формате ГГГГ-ММ-ДД или быть пустой' });
      return;
    }

    const result = payments.createVatInstallments(
      db,
      task,
      {
        amount: body.amount,
        comment: body.comment.trim(),
        filingDate: body.filingDate || null,
      },
      { replace: body.replace === true },
    );

    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    if (result.conflicts) {
      sendJson(res, 409, {
        error: 'По части сроков НДС записи уже есть. Повторное заполнение заменит их строки.',
        existing: result.conflicts,
      });
      return;
    }

    sendJson(res, 200, { shares: result.shares, payments: result.payments });
    return;
  }

  // Фиксация трёх ежемесячных авансов по прибыли: сумма месяца
  // повторяется на каждый срок (раздел 8.4).
  if (parts.length === 3 && parts[2] === 'profit-advances' && req.method === 'POST') {
    const body = await readJson(req);
    const task = tasks.get(db, typeof body.taskId === 'string' ? body.taskId : '');

    if (!task) {
      sendJson(res, 404, { error: 'Задача не найдена' });
      return;
    }
    if (!payments.isEligible(task)) {
      sendJson(res, 400, { error: 'По этой задаче уплаты не следует' });
      return;
    }
    if (!Number.isInteger(body.amount) || body.amount < 0 || body.amount > 1e12) {
      sendJson(res, 400, { error: 'Сумма аванса — целое число рублей' });
      return;
    }
    if (typeof body.comment !== 'string' || body.comment.length > 2000) {
      sendJson(res, 400, { error: 'Комментарий длиннее 2000 символов' });
      return;
    }
    if (body.filingDate !== null && body.filingDate !== undefined && !isIsoDate(body.filingDate)) {
      sendJson(res, 400, { error: 'Дата сдачи должна быть в формате ГГГГ-ММ-ДД или быть пустой' });
      return;
    }

    const result = payments.createProfitAdvances(
      db,
      task,
      {
        amount: body.amount,
        comment: body.comment.trim(),
        filingDate: body.filingDate || null,
      },
      { replace: body.replace === true },
    );

    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return;
    }
    if (result.conflicts) {
      sendJson(res, 409, {
        error: 'По части сроков авансов записи уже есть. Повторное заполнение заменит их строки.',
        existing: result.conflicts,
      });
      return;
    }

    sendJson(res, 200, { payments: result.payments });
    return;
  }

  const id = parts[2] || null;

  if (!id && parts.length === 2 && req.method === 'GET') {
    const filters = {};
    if (query.get('clientId')) filters.clientId = query.get('clientId');
    if (isIsoDate(query.get('from'))) filters.from = query.get('from');
    if (isIsoDate(query.get('to'))) filters.to = query.get('to');
    if (query.get('taxKind')) filters.taxKind = query.get('taxKind');

    sendJson(res, 200, payments.list(db, filters));
    return;
  }

  if (!id && parts.length === 2 && req.method === 'POST') {
    const values = payments.normalize(await readJson(req));
    const errors = payments.validate(values);

    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    const client = clients.get(db, values.clientId);
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }

    if (values.taskId) {
      const task = tasks.get(db, values.taskId);
      if (!task || task.clientId !== values.clientId) {
        sendJson(res, 400, { error: 'Задача не найдена у этого клиента' });
        return;
      }
    }

    const result = payments.create(db, values, { replace: values.replace });

    if (result.conflict) {
      sendJson(res, 409, {
        error: 'По клиенту на эту дату запись уже есть. Повторное заполнение заменит её строки.',
        existing: result.conflict,
      });
      return;
    }

    sendJson(res, result.replaced ? 200 : 201, {
      payment: result.payment,
      replaced: result.replaced,
    });
    return;
  }

  if (id && parts.length === 3 && req.method === 'DELETE') {
    if (!payments.remove(db, id)) {
      sendJson(res, 404, { error: 'Запись реестра не найдена' });
      return;
    }
    sendJson(res, 200, { deleted: true });
    return;
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
}

// Клиенты (раздел 6.2).
async function handleClients(req, res, parts, query) {
  const id = parts[2] || null;
  const sub = parts[3] || null;
  const subsub = parts[4] || null;

  // Предпросмотр генерации отчётности (FR-19…FR-26).
  if (id && sub === 'report' && subsub === 'preview' && req.method === 'GET') {
    const client = clients.get(db, id);
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }

    const preview = rules.buildPreview(client, createDateTools(calendar.loadCalendar()));
    const existing = new Set(
      tasks.listByClient(db, id).map((task) => task.ruleId).filter(Boolean),
    );

    for (const group of preview.groups) {
      for (const item of group.items) item.existing = existing.has(item.key);
    }

    sendJson(res, 200, preview);
    return;
  }

  // Создание выбранных задач. Повторный вызов идемпотентен (FR-24).
  if (id && sub === 'report' && !subsub && req.method === 'POST') {
    const client = clients.get(db, id);
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }

    const body = await readJson(req);
    if (!Array.isArray(body.keys)) {
      sendJson(res, 400, { error: 'Передайте список выбранных задач' });
      return;
    }

    const keys = [...new Set(body.keys.filter((key) => typeof key === 'string'))];
    if (keys.length === 0) {
      sendJson(res, 400, { error: 'Выберите хотя бы одну задачу' });
      return;
    }

    const preview = rules.buildPreview(client, createDateTools(calendar.loadCalendar()));
    const byKey = new Map();
    for (const group of preview.groups) {
      for (const item of group.items) byKey.set(item.key, item);
    }

    const unknown = keys.filter((key) => !byKey.has(key));
    if (unknown.length > 0) {
      sendJson(res, 400, { error: `Неизвестные позиции: ${unknown.join(', ')}` });
      return;
    }

    const selected = keys.map((key) => byKey.get(key));
    const result = tasks.createFromItems(db, id, selected);
    sendJson(res, 200, { ...result, selected: selected.length });
    return;
  }

  // Список задач клиента — для проверки и будущей сетки недели.
  if (id && sub === 'tasks' && !subsub && req.method === 'GET') {
    const client = clients.get(db, id);
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }

    sendJson(res, 200, { tasks: tasks.listByClient(db, id) });
    return;
  }

  if (!id && req.method === 'GET') {
    sendJson(res, 200, { clients: clients.list(db, query.get('mode') || 'active') });
    return;
  }

  if (!id && req.method === 'POST') {
    const values = clients.normalize(await readJson(req));
    const errors = clients.validate(values);

    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    sendJson(res, 201, { client: clients.create(db, values) });
    return;
  }

  if (id && req.method === 'GET') {
    const client = clients.get(db, id);
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }
    sendJson(res, 200, { client });
    return;
  }

  if (id && req.method === 'PATCH') {
    const body = await readJson(req);
    const existing = clients.get(db, id);

    if (!existing) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }

    // Архив, закрепление и порядок меняются отдельно: они не трогают карточку.
    if (typeof body.archived === 'boolean') {
      sendJson(res, 200, { client: clients.setArchived(db, id, body.archived) });
      return;
    }
    if (typeof body.pinned === 'boolean') {
      sendJson(res, 200, { client: clients.setPinned(db, id, body.pinned) });
      return;
    }
    if (body.sortOrder !== undefined) {
      sendJson(res, 200, { client: clients.setSortOrder(db, id, body.sortOrder) });
      return;
    }

    const values = clients.normalize({ ...existing, ...body });
    const errors = clients.validate(values);

    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    sendJson(res, 200, { client: clients.update(db, id, values) });
    return;
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
}

// Поиск задач по четырём режимам: название, клиент, дата, статус
// (FR-37…FR-41).
async function handleSearch(req, res, parts, query) {
  if (parts.length !== 3 || parts[2] !== 'tasks' || req.method !== 'GET') {
    sendJson(res, 405, { error: 'Метод не поддерживается' });
    return;
  }

  const filters = {
    q: query.get('q') || '',
    clientId: query.get('clientId') || '',
    from: null,
    to: null,
    status: query.get('status') || '',
  };

  for (const key of ['from', 'to']) {
    const value = query.get(key);
    if (!value) continue;
    if (!isIsoDate(value)) {
      sendJson(res, 400, { error: 'Дата фильтра должна быть в формате ГГГГ-ММ-ДД' });
      return;
    }
    filters[key] = value;
  }

  const errors = search.validateFilters(filters);
  if (errors.length > 0) {
    sendJson(res, 400, { errors });
    return;
  }

  sendJson(res, 200, search.findTasks(db, filters));
}

// Чек-листы: создание, изменение, удаление и применение к клиенту на период
// (FR-42).
async function handleChecklists(req, res, parts) {
  const id = parts[2] || null;
  const sub = parts[3] || null;

  if (!id && parts.length === 2 && req.method === 'GET') {
    sendJson(res, 200, { checklists: checklists.list(db) });
    return;
  }

  if (!id && parts.length === 2 && req.method === 'POST') {
    const values = checklists.normalize(await readJson(req));
    const errors = checklists.validate(values);

    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    sendJson(res, 201, { checklist: checklists.create(db, values) });
    return;
  }

  if (id && parts.length === 3 && req.method === 'PATCH') {
    const existing = checklists.get(db, id);
    if (!existing) {
      sendJson(res, 404, { error: 'Чек-лист не найден' });
      return;
    }

    const values = checklists.normalize(await readJson(req));
    const errors = checklists.validate(values);

    if (errors.length > 0) {
      sendJson(res, 400, { errors });
      return;
    }

    sendJson(res, 200, { checklist: checklists.update(db, id, values) });
    return;
  }

  if (id && parts.length === 3 && req.method === 'DELETE') {
    if (!checklists.remove(db, id)) {
      sendJson(res, 404, { error: 'Чек-лист не найден' });
      return;
    }
    sendJson(res, 200, { deleted: true });
    return;
  }

  if (id && sub === 'apply' && parts.length === 4 && req.method === 'POST') {
    const checklist = checklists.get(db, id);
    if (!checklist) {
      sendJson(res, 404, { error: 'Чек-лист не найден' });
      return;
    }

    const body = await readJson(req);
    const client = clients.get(db, typeof body.clientId === 'string' ? body.clientId : '');
    if (!client) {
      sendJson(res, 404, { error: 'Клиент не найден' });
      return;
    }
    if (!isIsoDate(body.from) || !isIsoDate(body.to)) {
      sendJson(res, 400, { error: 'Начало и конец периода должны быть в формате ГГГГ-ММ-ДД' });
      return;
    }
    if (body.from > body.to) {
      sendJson(res, 400, { error: 'Начало периода позже его конца' });
      return;
    }

    const result = checklists.apply(db, checklist, client.id, body.from, body.to);
    sendJson(res, 200, {
      created: result.created,
      skipped: result.skipped,
      tasks: result.tasks,
      client: { id: client.id, name: client.name, archived: client.archived },
    });
    return;
  }

  sendJson(res, 405, { error: 'Метод не поддерживается' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  const task = pathname === '/api' || pathname.startsWith('/api/')
    ? handleApi(req, res, pathname, url.searchParams)
    : Promise.resolve(serveStatic(res, pathname));

  Promise.resolve(task).catch((error) => {
    // Ошибка чтения базы не роняет сервер: интерфейс предлагает
    // восстановить копию или начать с нуля (FR-51, AC-51).
    if (isDatabaseError(error)) {
      dbError = error.message;
      sendJson(res, 503, recoveryPayload(error.message));
      return;
    }
    sendText(res, 500, `Ошибка сервера: ${error.message}`);
  });
});

server.listen(config.port, config.host, () => {
  const lines = [
    'Планировщик бухгалтера запущен.',
    `  Адрес:  http://${config.host}:${config.port}`,
    `  База:   ${config.dbFile}`,
  ];

  if (db) {
    lines.push(`  Схема:  ${schemaVersion(db)}`);
  } else {
    lines.push('  Схема:  база недоступна');
    lines.push('  Восстановление: откройте приложение в браузере.');
  }

  if (accountInfo && accountInfo.created) {
    lines.push('  Учётная запись создана при первом запуске:');
    lines.push(`    логин:  ${accountInfo.account.login}`);
    if (accountInfo.password) {
      lines.push(`    пароль: ${accountInfo.password}`);
      lines.push('    Запишите пароль: он показывается только один раз.');
    } else {
      lines.push('    пароль задан переменной окружения ASBUHG_PASSWORD.');
    }
  }

  lines.push('  Смена пароля: npm run password -- <новый пароль>');
  lines.push('  Остановить: Ctrl+C');
  process.stdout.write(`${lines.join('\n')}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      if (db) db.close();
      process.exit(0);
    });
  });
}
